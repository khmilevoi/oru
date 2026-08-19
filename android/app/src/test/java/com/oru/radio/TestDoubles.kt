package com.oru.radio

/** Runs work inline and gives the test a virtual clock for the 120 s safety cap. */
class TestScheduler : Scheduler {

    private class Scheduled(val dueAtMs: Long, val action: () -> Unit) {
        var cancelled = false
    }

    private val scheduled = mutableListOf<Scheduled>()

    var nowMs: Long = 0L
        private set

    override fun execute(action: () -> Unit) = action()

    override fun schedule(delayMs: Long, action: () -> Unit): Cancellable {
        val item = Scheduled(nowMs + delayMs, action)
        scheduled.add(item)
        return Cancellable { item.cancelled = true }
    }

    fun advance(millis: Long) {
        nowMs += millis
        val due = scheduled.filter { !it.cancelled && it.dueAtMs <= nowMs }
        scheduled.removeAll(due)
        due.forEach { it.action() }
    }

    val pendingCount: Int get() = scheduled.count { !it.cancelled }
}

class FakeTransport : Transport {

    class FakeSink(val streamId: String) : TransmissionSink {
        val frames = mutableListOf<ByteArray>()
        var closed = false
        override fun writeFrame(frame: ByteArray) {
            frames.add(frame)
        }
        override fun close() {
            closed = true
        }
    }

    var listener: TransportListener? = null
    var started = false
    var stopped = false
    val openedStreams = mutableListOf<String>()
    val closedStreams = mutableListOf<String>()
    var lastSink: FakeSink? = null

    override fun start(listener: TransportListener) {
        this.listener = listener
        started = true
    }

    override fun stop() {
        stopped = true
        listener = null
    }

    override fun openTransmission(streamId: String): TransmissionSink {
        openedStreams.add(streamId)
        return FakeSink(streamId).also { lastSink = it }
    }

    override fun closeTransmission(streamId: String) {
        closedStreams.add(streamId)
    }
}

class FakeAudioIo : AudioIo {
    var capturing = false
    var captureSink: TransmissionSink? = null
    val openedPlayback = mutableListOf<String>()
    val closedPlayback = mutableListOf<String>()
    val playedFrames = mutableListOf<Pair<String, ByteArray>>()
    var released = false
    // Named differently from the interface method it captures: a property named
    // `failureListener` generates a synthetic `setFailureListener(...)` setter whose
    // erased JVM signature clashes with the explicit override below.
    var capturedFailureListener: ((String, String) -> Unit)? = null

    val routeChanges = mutableListOf<ModePolicy.Profile>()

    override fun setFailureListener(listener: (code: String, message: String) -> Unit) {
        capturedFailureListener = listener
    }

    override fun onRouteChanged(profile: ModePolicy.Profile) {
        routeChanges.add(profile)
    }

    override fun startCapture(sink: TransmissionSink) {
        capturing = true
        captureSink = sink
    }

    override fun stopCapture() {
        capturing = false
        captureSink = null
    }

    override fun openPlayback(peerId: String) {
        openedPlayback.add(peerId)
    }

    override fun playFrame(peerId: String, frame: ByteArray) {
        playedFrames.add(peerId to frame)
    }

    override fun closePlayback(peerId: String) {
        closedPlayback.add(peerId)
    }

    override fun release() {
        released = true
    }
}

class FakePttSource(private var state: PttButtonState = PttButtonState()) : PttSource {
    var listener: PttListener? = null
    var started = false
    var stopped = false
    var forgotten = false
    var pairingStarted = false
    var pairingCancelled = false
    var selectedDevice: String? = null

    override fun start(listener: PttListener) {
        this.listener = listener
        started = true
    }

    override fun stop() {
        stopped = true
        listener = null
    }

    override fun snapshot(): PttButtonState = state

    override fun startPairing() {
        pairingStarted = true
    }

    override fun selectCandidate(deviceId: String) {
        selectedDevice = deviceId
    }

    override fun cancelPairing() {
        pairingCancelled = true
    }

    override fun forget() {
        forgotten = true
        state = PttButtonState()
    }
}

class FakeAudioRouting : AudioRouting {
    var listener: AudioRouteListener? = null
    var started = false
    var stopped = false
    var pressCount = 0
    var releaseCount = 0
    val radioActive = mutableListOf<Boolean>()
    val audioModes = mutableListOf<ModePolicy.AudioMode>()

    /**
     * Answers a press with an immediate grant, the way any route with a live mic does. Set to
     * false to hold the press in the raise, which is the section 7 path a Bluetooth Classic
     * headset on the MEDIA profile takes.
     */
    var autoGrant = true

    override fun start(listener: AudioRouteListener) {
        this.listener = listener
        started = true
    }

    override fun stop() {
        stopped = true
    }

    override fun setAudioMode(mode: ModePolicy.AudioMode) {
        audioModes.add(mode)
    }

    override fun setRadioActive(active: Boolean) {
        radioActive.add(active)
    }

    override fun onPttPressed() {
        pressCount++
        if (autoGrant) grant()
    }

    override fun onPttReleased() {
        releaseCount++
    }

    fun grant(mic: ModePolicy.MicSource = ModePolicy.MicSource.ROUTE_DEFAULT) {
        listener?.onCaptureGranted(mic)
    }

    fun publish(route: AudioRoute) {
        listener?.onAudioRouteChanged(route)
    }
}

class RecordingListener : RadioEngineListener {
    val states = mutableListOf<RadioState>()
    val errors = mutableListOf<Pair<String, String>>()

    override fun onStateChanged(state: RadioState) {
        states.add(state)
    }

    override fun onError(code: String, message: String) {
        errors.add(code to message)
    }

    val last: RadioState get() = states.last()
}
