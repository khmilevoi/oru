package com.oru.radio

/**
 * Everything RadioEngine talks to. Each port has exactly one Android implementation and
 * one test double, which is why the engine itself never imports an Android class.
 */

fun interface Cancellable {
    fun cancel()
}

/** The engine's single thread. Every engine mutation is posted here. */
interface Scheduler {
    fun execute(action: () -> Unit)
    fun schedule(delayMs: Long, action: () -> Unit): Cancellable
}

/** One outgoing transmission: encoded Opus frames in, peers out. */
interface TransmissionSink {
    fun writeFrame(frame: ByteArray)
    fun close()
}

interface Transport {
    fun start(listener: TransportListener)
    fun stop()
    /** Announces tx-start to every peer and opens the audio stream(s). Never null. */
    fun openTransmission(streamId: String): TransmissionSink
    /** Closes the audio stream(s) and announces tx-stop. */
    fun closeTransmission(streamId: String)
}

/** Transport callbacks. They may arrive on any thread; the engine re-posts them. */
interface TransportListener {
    fun onPeerConnected(peerId: String)
    fun onPeerDisconnected(peerId: String)
    fun onIncomingAudioStarted(peerId: String, streamId: String)
    fun onIncomingAudioFrame(peerId: String, frame: ByteArray)
    fun onIncomingAudioStopped(peerId: String, streamId: String)
    /** Unrecoverable (spec section 13): the engine goes to status 'error'. */
    fun onTransportFailure(code: String, message: String)
}

interface AudioIo {
    /**
     * Reports an unrecoverable audio failure — a microphone that will not open, a codec
     * that will not initialize. The engine turns it into an error event and the error
     * status (spec section 13). May be called from an audio thread.
     */
    fun setFailureListener(listener: (code: String, message: String) -> Unit)
    fun startCapture(sink: TransmissionSink)
    fun stopCapture()
    fun openPlayback(peerId: String)
    fun playFrame(peerId: String, frame: ByteArray)
    fun closePlayback(peerId: String)
    fun release()
}

/**
 * Section 6's routing, as the engine drives it. One implementation
 * ([AudioRouteController]) and one test double.
 *
 * Every method returns immediately: the controller posts onto its own thread, so nothing
 * here ever blocks the engine's.
 */
interface AudioRouting {
    fun start(listener: AudioRouteListener)
    fun stop()

    /** Section 8's persisted setting. `AUTO` runs the section 7 policy; the others pin it. */
    fun setAudioMode(mode: ModePolicy.AudioMode)

    /** The radio is receiving or transmitting: section 7 queues switches for idle. */
    fun setRadioActive(active: Boolean)

    /** Section 7: press then tone then talk. Capture starts on [AudioRouteListener.onCaptureGranted]. */
    fun onPttPressed()

    fun onPttReleased()
}

/**
 * Section 6/7 callbacks out of the route controller. They arrive on the `audio-route`
 * thread; `RadioEngine` re-posts them onto its own scheduler exactly as it does transport
 * and PTT callbacks.
 */
interface AudioRouteListener {
    /** The route actually in force changed — publish it and rebuild the audio streams. */
    fun onAudioRouteChanged(route: AudioRoute)

    /**
     * Section 7: the talk-permit tone has played and capture may start now. [mic] is
     * `PHONE_FALLBACK` when the headset link never came up for this transmission.
     */
    fun onCaptureGranted(mic: ModePolicy.MicSource)
}

interface PttSource {
    fun start(listener: PttListener)
    fun stop()
    fun snapshot(): PttButtonState
    /** The amended configurePtt(): opens the pairing session and starts scanning. */
    fun startPairing()
    /** The amended selectPttCandidate(): the user picked one of the published candidates. */
    fun selectCandidate(deviceId: String)
    fun cancelPairing()
    fun forget()
}

interface PttListener {
    fun onPttPressed()
    fun onPttReleased()
    fun onPttButtonStateChanged(state: PttButtonState)
    /** Mirrored straight into RadioState.pttPairing; null ends the session. */
    fun onPttPairingChanged(pairing: PttPairingState?)
    /** Cancel, timeout or a BLE failure: an error event, never the error status (section 13). */
    fun onPttPairingFailed(code: String, message: String)
}

/**
 * The driver-to-manager half of the learning flow (spec section 9.3). This one is
 * internal: it never reaches the bridge, which sees only RadioState.pttPairing.
 */
interface PttLearningListener {
    fun onDeviceFound(deviceId: String, name: String?, rssi: Int)
    fun onLearned(configuration: PttConfiguration)
    fun onLearningFailed(code: String, message: String)
}

interface RadioEngineListener {
    fun onStateChanged(state: RadioState)
    fun onError(code: String, message: String)
}
