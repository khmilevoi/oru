package com.oru.radio

import java.util.UUID
import java.util.concurrent.CopyOnWriteArrayList

/**
 * The radio itself (spec section 18: "the UI may die, JS may sleep, the RadioEngine must
 * keep working"). Every operation of spec section 6.3 lives here, and every mutation runs
 * on the injected scheduler's single thread.
 *
 * Threading, precisely: [state] is the only `@Volatile` field, because [getState] is the
 * one thing any thread may call at any time (the bridge answers `getState()` from the JS
 * thread). Its single writer is the scheduler thread, so no synchronization is needed
 * around the write either. Every other field — [running], [currentStreamId], [currentSink],
 * [safetyCap] — and both collections, [peers] and [incoming], are *scheduler-confined*:
 * they are written and read only from inside a `scheduler.execute { }` block, and reading
 * any of them from another thread is not safe. [listeners] is a [CopyOnWriteArrayList]
 * because listeners are added and removed from the bridge thread while the scheduler thread
 * iterates it.
 */
class RadioEngine(
    private val transport: Transport,
    private val audio: AudioIo,
    private val ptt: PttSource,
    private val routing: AudioRouting,
    private val scheduler: Scheduler,
    private val streamIds: () -> String = { UUID.randomUUID().toString() },
) : TransportListener, PttListener, AudioRouteListener {

    private val listeners = CopyOnWriteArrayList<RadioEngineListener>()
    private val peers = LinkedHashSet<String>()
    private val incoming = LinkedHashSet<String>()

    @Volatile
    private var state = RadioState()
    private var running = false
    private var currentStreamId: String? = null
    private var currentSink: TransmissionSink? = null
    private var safetyCap: Cancellable? = null
    /** A press whose capture the section 7 policy has not granted yet. */
    private var transmitRequested = false

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
        routing.start(this)
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
        routing.stop()
        audio.release()
        running = false
        update { RadioState(audioMode = it.audioMode) }
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
        if (state.status == RadioStatus.ERROR) return@execute
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
        // A failed radio does not start playing again: fail() tore the receive path down
        // and nothing may build it back up (spec section 13 — the status is unrecoverable).
        if (state.status == RadioStatus.ERROR) return@execute
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

    /**
     * Section 7: a press asks the routing for permission, it does not take it. The transport
     * stream opens in [beginCapture], once the grant tone has played — so peers never receive
     * the 1–3 s of an SCO raise as dead air, and the UI never claims to be transmitting into
     * a microphone that is not live yet.
     */
    private fun startTransmitNow() {
        if (!running || state.status == RadioStatus.ERROR) return
        if (currentStreamId != null || transmitRequested) return
        transmitRequested = true
        routing.onPttPressed()
    }

    private fun beginCapture(mic: ModePolicy.MicSource) {
        if (!transmitRequested || currentStreamId != null) return
        if (!running || state.status == RadioStatus.ERROR) {
            transmitRequested = false
            return
        }
        val streamId = streamIds()
        val sink = transport.openTransmission(streamId)
        currentStreamId = streamId
        currentSink = sink
        audio.startCapture(sink)
        // Stuck-button protection (spec section 9.4) starts with the audio, not with the press:
        // a raise that takes 3 s must not eat 3 s of the 120 s budget.
        safetyCap = scheduler.schedule(RadioConfig.MAX_TRANSMIT_MS) { stopTransmitNow() }
        update { it.copy(transmitting = true) }
    }

    private fun stopTransmitNow() {
        val wasRequested = transmitRequested
        transmitRequested = false
        // Every press must be answered by exactly one release, including the presses that
        // never became a transmission — the policy has no watchdog on an unreleased one.
        if (wasRequested) routing.onPttReleased()
        val streamId = currentStreamId ?: return
        safetyCap?.cancel()
        safetyCap = null
        // The sink is closed *before* capture is stopped, not after: the capture thread can
        // be blocked writing a frame into a wedged peer's pipe, and closing the sink is what
        // makes that write fail immediately so the thread can exit, release its AudioRecord
        // and let the next press open a microphone at all. At worst one frame that was
        // already encoded is dropped.
        currentSink?.close()
        currentSink = null
        audio.stopCapture()
        currentStreamId = null
        transport.closeTransmission(streamId)
        update { it.copy(transmitting = false) }
    }

    // --- routing callbacks ----------------------------------------------------------------

    override fun onAudioRouteChanged(route: AudioRoute) = scheduler.execute {
        // Section 6 stream survival: the streams rebuild on the next frame with this
        // profile's attributes, and their error runs reset.
        audio.onRouteChanged(route.mode)
        update { it.copy(audioRoute = route) }
    }

    override fun onCaptureGranted(mic: ModePolicy.MicSource) = scheduler.execute {
        beginCapture(mic)
    }

    /** Section 8's pin. Persisted by the bridge; applied here. */
    fun setAudioMode(mode: ModePolicy.AudioMode) = scheduler.execute {
        routing.setAudioMode(mode)
        update { it.copy(audioMode = mode) }
    }

    /** An error event on its own: something failed, the radio keeps working. */
    private fun reportError(code: String, message: String) {
        listeners.forEach { it.onError(code, message) }
    }

    /**
     * An unrecoverable failure the host itself hit — the foreground service being refused,
     * a task that threw its way out of the scheduler — rather than one a port reported.
     * Deliberately not part of the P5 bridge surface (the bridge never calls it); it exists
     * so [RadioForegroundService] can use the one error path of spec section 13 instead of
     * inventing a second one that JS would never hear about.
     */
    internal fun failFromHost(code: String, message: String) = scheduler.execute {
        fail(code, message)
    }

    /** Spec section 13: unrecoverable failures are an event *and* the error status. */
    private fun fail(code: String, message: String) {
        stopTransmitNow()
        // Reception goes the same way transmission does. Leaving it up produced a state
        // that read status='error' together with receiving=true and nearbyCount=N, with
        // AudioTrack still playing and the playback thread still running: the radio would
        // report itself dead while it was audibly alive. This is exactly stopRadio()'s
        // receive teardown; the guards on onPeerConnected/onIncomingAudioStarted keep
        // anything from building it back up.
        incoming.toList().forEach { audio.closePlayback(it) }
        incoming.clear()
        peers.clear()
        update { it.copy(status = RadioStatus.ERROR, receiving = false, nearbyCount = 0) }
        reportError(code, message)
    }

    private fun update(transform: (RadioState) -> RadioState) {
        val next = transform(state)
        if (next == state) return
        val wasActive = state.receiving || state.transmitting
        state = next
        val isActive = next.receiving || next.transmitting
        // Section 7 queues mode switches for radio-idle; this is the edge it queues on.
        if (isActive != wasActive) routing.setRadioActive(isActive)
        listeners.forEach { it.onStateChanged(next) }
    }
}
