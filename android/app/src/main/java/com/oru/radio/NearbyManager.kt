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
    private val announcedStreamIds = ConcurrentHashMap<String, String>()
    private val activeIncoming = ConcurrentHashMap<String, String>()

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
        handshaked.clear()
        awaitingHello.clear()
        ignored.clear()
        backoffs.clear()
        announcedStreamIds.clear()
        activeIncoming.clear()
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
                awaitingHello.add(endpointId)
                send(endpointId, ControlMessage.Hello(RadioConfig.PROTOCOL_VERSION))
            } else {
                scheduleReconnect(endpointId)
            }
        }

        override fun onDisconnected(endpointId: String) {
            awaitingHello.remove(endpointId)
            activeIncoming.remove(endpointId)?.let { streamId ->
                listener?.onIncomingAudioStopped(endpointId, streamId)
            }
            if (handshaked.remove(endpointId)) listener?.onPeerDisconnected(endpointId)
        }
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
        val delay = backoffs.getOrPut(endpointId) { ReconnectBackoff() }.nextDelayMs()
        scheduler.schedule(delay) {
            if (running && endpointId !in handshaked && endpointId !in ignored) {
                requestConnection(endpointId)
            }
        }
    }

    // --- payloads --------------------------------------------------------------------------

    private val payloadCallback = object : PayloadCallback() {
        override fun onPayloadReceived(endpointId: String, payload: Payload) {
            when (payload.type) {
                Payload.Type.BYTES -> payload.asBytes()?.let { handleControl(endpointId, it) }
                Payload.Type.STREAM -> payload.asStream()?.asInputStream()
                    ?.let { startReader(endpointId, it) }
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
                if (message.version != RadioConfig.PROTOCOL_VERSION) {
                    // Spec section 7: disconnect gracefully and ignore this peer.
                    ignored.add(peerId)
                    awaitingHello.remove(peerId)
                    handshaked.remove(peerId)
                    client.disconnectFromEndpoint(peerId)
                } else {
                    awaitingHello.remove(peerId)
                    if (handshaked.add(peerId)) listener?.onPeerConnected(peerId)
                }
            }
            is ControlMessage.TxStart -> announcedStreamIds[peerId] = message.streamId
            is ControlMessage.TxStop -> activeIncoming.remove(peerId)?.let { streamId ->
                listener?.onIncomingAudioStopped(peerId, streamId)
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
        activeIncoming[peerId] = streamId
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
                activeIncoming.remove(peerId)?.let { listener?.onIncomingAudioStopped(peerId, it) }
            }
        }, "oru-rx-$peerId").start()
    }

    private fun send(peerId: String, message: ControlMessage) {
        client.sendPayload(peerId, Payload.fromBytes(ControlMessageCodec.encode(message)))
    }
}
