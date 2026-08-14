package com.oru.radio

import java.util.UUID
import java.util.concurrent.CopyOnWriteArrayList

/**
 * The radio itself (spec section 18: "the UI may die, JS may sleep, the RadioEngine must
 * keep working"). Every operation of spec section 6.3 lives here, and every mutation runs
 * on the injected scheduler's single thread. Fields are @Volatile for safe cross-thread
 * reads; writes need no synchronization (single-writer discipline).
 */
class RadioEngine(
    private val transport: Transport,
    private val audio: AudioIo,
    private val ptt: PttSource,
    private val scheduler: Scheduler,
    private val streamIds: () -> String = { UUID.randomUUID().toString() },
) : TransportListener, PttListener {

    private val listeners = CopyOnWriteArrayList<RadioEngineListener>()
    private val peers = LinkedHashSet<String>()
    private val incoming = LinkedHashSet<String>()

    @Volatile
    private var state = RadioState()
    private var running = false
    private var currentStreamId: String? = null
    private var currentSink: TransmissionSink? = null
    private var safetyCap: Cancellable? = null

    fun addListener(listener: RadioEngineListener) {
        listeners.add(listener)
        listener.onStateChanged(state)
    }

    fun removeListener(listener: RadioEngineListener) {
        listeners.remove(listener)
    }

    fun getState(): RadioState = state

    // --- spec section 6.3 operations ---------------------------------------------------

    fun startRadio() = scheduler.execute {
        if (running) return@execute
        running = true
        audio.setFailureListener { code, message -> scheduler.execute { fail(code, message) } }
        transport.start(this)
        ptt.start(this)
        update { it.copy(status = RadioStatus.READY, pttButton = ptt.snapshot()) }
    }

    fun stopRadio() = scheduler.execute {
        if (!running) return@execute
        stopTransmitNow()
        incoming.toList().forEach { audio.closePlayback(it) }
        incoming.clear()
        peers.clear()
        ptt.stop()
        transport.stop()
        audio.release()
        running = false
        update { RadioState() }
    }

    fun startTransmit() = scheduler.execute { startTransmitNow() }

    fun stopTransmit() = scheduler.execute { stopTransmitNow() }

    fun startPttPairing() = scheduler.execute { ptt.startPairing() }

    fun selectPttCandidate(deviceId: String) = scheduler.execute { ptt.selectCandidate(deviceId) }

    fun cancelPttPairing() = scheduler.execute { ptt.cancelPairing() }

    fun forgetPtt() = scheduler.execute {
        ptt.forget()
        update { it.copy(pttButton = ptt.snapshot()) }
    }

    // --- transport callbacks ------------------------------------------------------------

    override fun onPeerConnected(peerId: String) = scheduler.execute {
        if (peers.add(peerId)) update { it.copy(nearbyCount = peers.size) }
    }

    override fun onPeerDisconnected(peerId: String) = scheduler.execute {
        val hadPeer = peers.remove(peerId)
        val wasReceiving = incoming.remove(peerId)
        if (wasReceiving) audio.closePlayback(peerId)
        if (hadPeer || wasReceiving) {
            update { it.copy(nearbyCount = peers.size, receiving = incoming.isNotEmpty()) }
        }
    }

    override fun onIncomingAudioStarted(peerId: String, streamId: String) = scheduler.execute {
        if (incoming.add(peerId)) {
            audio.openPlayback(peerId)
            update { it.copy(receiving = true) }
        }
    }

    override fun onIncomingAudioFrame(peerId: String, frame: ByteArray) = scheduler.execute {
        if (peerId in incoming) audio.playFrame(peerId, frame)
    }

    override fun onIncomingAudioStopped(peerId: String, streamId: String) = scheduler.execute {
        if (incoming.remove(peerId)) {
            audio.closePlayback(peerId)
            update { it.copy(receiving = incoming.isNotEmpty()) }
        }
    }

    override fun onTransportFailure(code: String, message: String) = scheduler.execute {
        fail(code, message)
    }

    // --- ptt callbacks ------------------------------------------------------------------

    override fun onPttPressed() = scheduler.execute { startTransmitNow() }

    override fun onPttReleased() = scheduler.execute { stopTransmitNow() }

    override fun onPttButtonStateChanged(state: PttButtonState) = scheduler.execute {
        update { it.copy(pttButton = state) }
    }

    override fun onPttPairingChanged(pairing: PttPairingState?) = scheduler.execute {
        update { it.copy(pttPairing = pairing) }
    }

    override fun onPttPairingFailed(code: String, message: String) = scheduler.execute {
        update { it.copy(pttPairing = null) }
        // A pairing that fails leaves the radio itself perfectly healthy, so this is an
        // error event without the error status (spec section 13).
        reportError(code, message)
    }

    // --- internals ----------------------------------------------------------------------

    private fun startTransmitNow() {
        if (!running || state.status == RadioStatus.ERROR || currentStreamId != null) return

        val streamId = streamIds()
        val sink = transport.openTransmission(streamId)
        currentStreamId = streamId
        currentSink = sink
        audio.startCapture(sink)
        // Stuck-button protection (spec section 9.4): a hold never lasts past 120 s.
        safetyCap = scheduler.schedule(RadioConfig.MAX_TRANSMIT_MS) { stopTransmitNow() }
        update { it.copy(transmitting = true) }
    }

    private fun stopTransmitNow() {
        val streamId = currentStreamId ?: return
        safetyCap?.cancel()
        safetyCap = null
        audio.stopCapture()
        currentSink?.close()
        currentSink = null
        currentStreamId = null
        transport.closeTransmission(streamId)
        update { it.copy(transmitting = false) }
    }

    /** An error event on its own: something failed, the radio keeps working. */
    private fun reportError(code: String, message: String) {
        listeners.forEach { it.onError(code, message) }
    }

    /** Spec section 13: unrecoverable failures are an event *and* the error status. */
    private fun fail(code: String, message: String) {
        stopTransmitNow()
        update { it.copy(status = RadioStatus.ERROR) }
        reportError(code, message)
    }

    private fun update(transform: (RadioState) -> RadioState) {
        val next = transform(state)
        if (next == state) return
        state = next
        listeners.forEach { it.onStateChanged(next) }
    }
}
