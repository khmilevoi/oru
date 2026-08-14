package com.oru.radio

import android.content.Context
import android.os.ParcelFileDescriptor
import android.util.Log
import com.google.android.gms.nearby.Nearby
import com.google.android.gms.nearby.connection.AdvertisingOptions
import com.google.android.gms.nearby.connection.ConnectionInfo
import com.google.android.gms.nearby.connection.ConnectionLifecycleCallback
import com.google.android.gms.nearby.connection.ConnectionResolution
import com.google.android.gms.nearby.connection.ConnectionsClient
import com.google.android.gms.nearby.connection.ConnectionsStatusCodes
import com.google.android.gms.nearby.connection.DiscoveredEndpointInfo
import com.google.android.gms.nearby.connection.DiscoveryOptions
import com.google.android.gms.nearby.connection.EndpointDiscoveryCallback
import com.google.android.gms.nearby.connection.Payload
import com.google.android.gms.nearby.connection.PayloadCallback
import com.google.android.gms.nearby.connection.PayloadTransferUpdate
import com.google.android.gms.nearby.connection.Strategy
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.util.concurrent.ConcurrentHashMap

/**
 * Which peers are currently sending us audio, and under which stream id. Split out of
 * [NearbyManager] because it is the one piece of the receive path that is pure Kotlin and
 * therefore testable on the JVM, and because the rule it encodes is subtle enough to need a
 * test: a reader thread that finishes may only end *its own* transmission.
 *
 * Ending unconditionally lost a whole transmission. `tx-stop`(S1) arrives over the reliable
 * BYTES channel and ends S1 while reader thread T1 is still draining its pipe (the STREAM
 * flush after a pipe close takes tens to hundreds of milliseconds); the user taps again and
 * S2 opens; T1 then reaches EOF and removed whatever was mapped for that peer — S2 — while
 * reporting S1 as stopped. `RadioEngine` dropped the peer from `incoming` and silently
 * discarded every frame of the second transmission. An ordinary quick double tap.
 *
 * [Entry] identity, not the stream id, is what makes a transmission unique: a peer that
 * sends two streams without announcing either falls back to the same id for both, and
 * value equality would confuse them exactly as the original bug did.
 */
internal class IncomingStreams {

    /** One incoming transmission. Compared by identity — see the class doc. */
    class Entry(val streamId: String)

    private val active = ConcurrentHashMap<String, Entry>()

    /** Records a new incoming transmission, replacing whatever this peer had before. */
    fun open(peerId: String, streamId: String): Entry =
        Entry(streamId).also { active[peerId] = it }

    /** Ends whatever this peer is sending, or returns null if it was sending nothing. */
    fun end(peerId: String): Entry? = active.remove(peerId)

    /** Ends [entry] only while it is still this peer's current transmission. */
    fun endIfCurrent(peerId: String, entry: Entry): Boolean = active.remove(peerId, entry)

    fun clear() = active.clear()
}

/**
 * The transport of spec section 7: P2P_CLUSTER, advertising and discovering at the same
 * time under one shared service id, accepting every connection, gating peers on `hello`,
 * and reconnecting natively with backoff. Nothing here knows about JavaScript.
 *
 * A peer counts as connected only after its `hello` has been seen, so `nearbyCount` never
 * includes a device that is about to be dropped for a version mismatch.
 */
class NearbyManager(
    context: Context,
    private val endpointName: String,
    private val scheduler: Scheduler,
) : Transport {

    private companion object {
        const val TAG = "OruRadio"
    }

    private val client: ConnectionsClient = Nearby.getConnectionsClient(context.applicationContext)

    private val handshaked = ConcurrentHashMap.newKeySet<String>()
    private val awaitingHello = ConcurrentHashMap.newKeySet<String>()
    private val ignored = ConcurrentHashMap.newKeySet<String>()
    private val backoffs = ConcurrentHashMap<String, ReconnectBackoff>()
    private val reconnectTimers = ConcurrentHashMap<String, Cancellable>()
    private val helloTimers = ConcurrentHashMap<String, Cancellable>()
    private val announcedStreamIds = ConcurrentHashMap<String, String>()
    private val incoming = IncomingStreams()

    @Volatile private var listener: TransportListener? = null
    @Volatile private var running = false
    @Volatile private var transmission: PeerFanout? = null

    override fun start(listener: TransportListener) {
        this.listener = listener
        running = true

        client.startAdvertising(
            endpointName,
            RadioConfig.SERVICE_ID,
            connectionLifecycle,
            AdvertisingOptions.Builder().setStrategy(Strategy.P2P_CLUSTER).build(),
        ).addOnFailureListener { error ->
            listener.onTransportFailure("advertising_failed", error.message ?: "startAdvertising failed")
        }

        client.startDiscovery(
            RadioConfig.SERVICE_ID,
            discoveryCallback,
            DiscoveryOptions.Builder().setStrategy(Strategy.P2P_CLUSTER).build(),
        ).addOnFailureListener { error ->
            listener.onTransportFailure("discovery_failed", error.message ?: "startDiscovery failed")
        }
    }

    override fun stop() {
        running = false
        transmission?.close()
        transmission = null
        client.stopAdvertising()
        client.stopDiscovery()
        client.stopAllEndpoints()
        reconnectTimers.values.forEach { it.cancel() }
        reconnectTimers.clear()
        helloTimers.values.forEach { it.cancel() }
        helloTimers.clear()
        handshaked.clear()
        awaitingHello.clear()
        ignored.clear()
        backoffs.clear()
        announcedStreamIds.clear()
        incoming.clear()
        listener = null
    }

    override fun openTransmission(streamId: String): TransmissionSink {
        val peers = handshaked.toList()
        peers.forEach { send(it, ControlMessage.TxStart(streamId)) }
        return PeerFanout(streamId, peers).also { transmission = it }
    }

    override fun closeTransmission(streamId: String) {
        transmission?.close()
        transmission = null
        handshaked.forEach { send(it, ControlMessage.TxStop(streamId)) }
    }

    // --- outgoing audio -------------------------------------------------------------------

    /**
     * One pipe per peer for the duration of one transmission. Nearby reads the read end;
     * the audio engine writes length-prefixed Opus frames into the write end. A peer whose
     * pipe breaks simply drops out of the fanout — that is a recoverable condition, not an
     * error (spec section 13).
     */
    private inner class PeerFanout(val streamId: String, peers: List<String>) : TransmissionSink {

        private val writers = ConcurrentHashMap<String, OutputStream>()

        init {
            peers.forEach { peerId ->
                try {
                    val pipe = ParcelFileDescriptor.createPipe()
                    client.sendPayload(peerId, Payload.fromStream(pipe[0]))
                    writers[peerId] = ParcelFileDescriptor.AutoCloseOutputStream(pipe[1])
                } catch (error: IOException) {
                    Log.w(TAG, "could not open an audio stream to $peerId", error)
                }
            }
        }

        override fun writeFrame(frame: ByteArray) {
            val iterator = writers.entries.iterator()
            while (iterator.hasNext()) {
                val entry = iterator.next()
                try {
                    AudioFraming.writeFrame(entry.value, frame)
                } catch (error: IOException) {
                    runCatching { entry.value.close() }
                    iterator.remove()
                }
            }
        }

        override fun close() {
            writers.values.forEach { runCatching { it.close() } }
            writers.clear()
        }

        /**
         * A peer that disconnects (or is ignored for a version mismatch) mid-transmission
         * must not keep its pipe open until the next `writeFrame()` happens to throw.
         */
        fun removePeer(peerId: String) {
            writers.remove(peerId)?.let { runCatching { it.close() } }
        }
    }

    // --- connection lifecycle -------------------------------------------------------------

    private val discoveryCallback = object : EndpointDiscoveryCallback() {
        override fun onEndpointFound(endpointId: String, info: DiscoveredEndpointInfo) {
            if (info.serviceId != RadioConfig.SERVICE_ID) return
            if (endpointId in ignored || endpointId in handshaked || endpointId in awaitingHello) return
            requestConnection(endpointId)
        }

        override fun onEndpointLost(endpointId: String) {
            // Discovery keeps running; the endpoint reappears on its own when it is back.
        }
    }

    private val connectionLifecycle = object : ConnectionLifecycleCallback() {
        override fun onConnectionInitiated(endpointId: String, info: ConnectionInfo) {
            // Spec section 7: connections are accepted automatically, there is no peer UI.
            client.acceptConnection(endpointId, payloadCallback)
        }

        override fun onConnectionResult(endpointId: String, resolution: ConnectionResolution) {
            if (resolution.status.statusCode == ConnectionsStatusCodes.STATUS_OK) {
                backoffs.remove(endpointId)
                awaitHello(endpointId)
                send(endpointId, ControlMessage.Hello(RadioConfig.PROTOCOL_VERSION))
            } else {
                scheduleReconnect(endpointId)
            }
        }

        override fun onDisconnected(endpointId: String) {
            awaitingHello.remove(endpointId)
            cancelHelloTimeout(endpointId)
            cancelReconnect(endpointId)
            transmission?.removePeer(endpointId)
            incoming.end(endpointId)?.let { stream ->
                listener?.onIncomingAudioStopped(endpointId, stream.streamId)
            }
            if (handshaked.remove(endpointId)) listener?.onPeerDisconnected(endpointId)
        }
    }

    /**
     * A connected endpoint owes us a `hello` (spec section 7), and until it arrives the
     * endpoint counts for nothing: it is not in [handshaked], so it is not a peer, and
     * [discoveryCallback] skips it, so it is never reconnected either. A `hello` that never
     * comes — a lost BYTES payload, a peer of another build, a peer still under
     * construction — used to park the endpoint there forever: `nearbyCount` stayed 0, no
     * error was raised, nothing was logged, and only restarting the service recovered it.
     * Phase 0 is Android to iPhone, so that was the most likely way scenarios A to D would
     * fail with no diagnostic at all.
     *
     * The bound is a timer per endpoint, the same shape [reconnectTimers] already uses:
     * replaced rather than stacked, cancelled when the `hello` arrives, when the endpoint
     * disconnects, and in [stop].
     */
    private fun awaitHello(endpointId: String) {
        awaitingHello.add(endpointId)
        helloTimers.remove(endpointId)?.cancel()
        helloTimers[endpointId] = scheduler.schedule(RadioConfig.HELLO_TIMEOUT_MS) {
            helloTimers.remove(endpointId)
            if (!awaitingHello.remove(endpointId)) return@schedule
            Log.w(TAG, "no hello from $endpointId in ${RadioConfig.HELLO_TIMEOUT_MS} ms; dropping it")
            // Dropped, not ignored: the endpoint is free to be rediscovered and reconnected
            // right away, which is what turns a wedged handshake into a retry instead of a
            // dead radio.
            runCatching { client.disconnectFromEndpoint(endpointId) }
        }
    }

    private fun cancelHelloTimeout(endpointId: String) {
        helloTimers.remove(endpointId)?.cancel()
    }

    private fun requestConnection(endpointId: String) {
        client.requestConnection(endpointName, endpointId, connectionLifecycle)
            .addOnFailureListener { error ->
                val code = (error as? com.google.android.gms.common.api.ApiException)?.statusCode
                if (code == ConnectionsStatusCodes.STATUS_ALREADY_CONNECTED_TO_ENDPOINT) return@addOnFailureListener
                scheduleReconnect(endpointId)
            }
    }

    /** Spec section 7: reconnection is fully native, with backoff. */
    private fun scheduleReconnect(endpointId: String) {
        if (!running || endpointId in ignored) return
        // A stale timer from an earlier stop()->start() cycle must never fire against
        // the new session, so any previously pending timer for this endpoint is
        // replaced, not stacked.
        reconnectTimers.remove(endpointId)?.cancel()
        val delay = backoffs.getOrPut(endpointId) { ReconnectBackoff() }.nextDelayMs()
        reconnectTimers[endpointId] = scheduler.schedule(delay) {
            reconnectTimers.remove(endpointId)
            if (running && endpointId !in handshaked && endpointId !in ignored) {
                requestConnection(endpointId)
            }
        }
    }

    private fun cancelReconnect(endpointId: String) {
        reconnectTimers.remove(endpointId)?.cancel()
    }

    // --- payloads --------------------------------------------------------------------------

    private val payloadCallback = object : PayloadCallback() {
        override fun onPayloadReceived(endpointId: String, payload: Payload) {
            when (payload.type) {
                Payload.Type.BYTES -> payload.asBytes()?.let { handleControl(endpointId, it) }
                Payload.Type.STREAM -> {
                    // A peer counts as connected only after its hello has been seen
                    // (class doc); a STREAM from anyone else is dropped, not decoded.
                    if (endpointId in handshaked) {
                        payload.asStream()?.asInputStream()?.let { startReader(endpointId, it) }
                    } else {
                        client.cancelPayload(payload.id)
                    }
                }
                else -> Unit
            }
        }

        override fun onPayloadTransferUpdate(endpointId: String, update: PayloadTransferUpdate) {
            // Frame delivery is driven by the stream reader; nothing to do here.
        }
    }

    private fun handleControl(peerId: String, bytes: ByteArray) {
        when (val message = ControlMessageCodec.decode(bytes)) {
            is ControlMessage.Hello -> {
                cancelHelloTimeout(peerId)
                if (message.version != RadioConfig.PROTOCOL_VERSION) {
                    // Spec section 7: disconnect gracefully and ignore this peer.
                    ignored.add(peerId)
                    awaitingHello.remove(peerId)
                    handshaked.remove(peerId)
                    cancelReconnect(peerId)
                    transmission?.removePeer(peerId)
                    client.disconnectFromEndpoint(peerId)
                } else {
                    awaitingHello.remove(peerId)
                    cancelReconnect(peerId)
                    if (handshaked.add(peerId)) listener?.onPeerConnected(peerId)
                }
            }
            is ControlMessage.TxStart -> if (peerId in handshaked) {
                announcedStreamIds[peerId] = message.streamId
            }
            is ControlMessage.TxStop -> if (peerId in handshaked) {
                incoming.end(peerId)?.let { stream ->
                    listener?.onIncomingAudioStopped(peerId, stream.streamId)
                }
            }
            null -> Log.w(TAG, "ignoring an unparseable control payload from $peerId")
        }
    }

    /**
     * One thread per incoming transmission. The stream itself is the authoritative
     * boundary: `tx-start` only supplies the stream id, and whichever of `tx-stop` and the
     * end of the stream lands first ends the transmission (the engine is idempotent).
     */
    private fun startReader(peerId: String, input: InputStream) {
        val streamId = announcedStreamIds.remove(peerId) ?: "unknown"
        val stream = incoming.open(peerId, streamId)
        listener?.onIncomingAudioStarted(peerId, streamId)

        Thread({
            try {
                while (true) {
                    val frame = AudioFraming.readFrame(input) ?: break
                    listener?.onIncomingAudioFrame(peerId, frame)
                }
            } catch (error: IOException) {
                Log.w(TAG, "audio stream from $peerId ended", error)
            } finally {
                runCatching { input.close() }
                // Only this reader's own transmission, and only while it is still the
                // current one: this thread routinely outlives its `tx-stop` by the length
                // of a STREAM flush, and by then the peer may already have started the
                // next transmission. See IncomingStreams.
                if (incoming.endIfCurrent(peerId, stream)) {
                    listener?.onIncomingAudioStopped(peerId, stream.streamId)
                }
            }
        }, "oru-rx-$peerId").start()
    }

    private fun send(peerId: String, message: ControlMessage) {
        client.sendPayload(peerId, Payload.fromBytes(ControlMessageCodec.encode(message)))
    }
}
