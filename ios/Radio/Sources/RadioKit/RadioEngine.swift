import Foundation
import os

/// The radio itself (spec section 6.3). Owns all realtime state, runs entirely
/// without React Native, and reports outward through observers.
///
/// Every mutation happens on `queue`; public entry points hop onto it, delegate
/// callbacks from the ports hop onto it, and observers are notified from it.
public final class RadioEngine {

    private let queue: DispatchQueue
    private let transport: RadioTransport
    private let audio: AudioIO
    private let ptt: PttSource
    private let background: BackgroundSession
    private let clock: RadioClock
    private let log = Logger(
        subsystem: RadioConfig.Logging.subsystem,
        category: "engine"
    )

    private var state = RadioState()
    private var isStarted = false
    private var isAwaitingAudioSession = false
    private var currentStreamId: String?
    private var sink: AudioStreamSink?
    private var safetyCap: RadioCancellable?
    private var receivingPeers: Set<String> = []
    /// Receive-path instrumentation (heartbeat.log): per-peer frame totals,
    /// sampled every 50 frames so no line is formatted per frame.
    private var rxFrameCounts: [String: Int] = [:]
    private var observers: [String: (RadioEvent) -> Void] = [:]

    public init(
        transport: RadioTransport,
        audio: AudioIO,
        ptt: PttSource,
        background: BackgroundSession,
        clock: RadioClock,
        queue: DispatchQueue
    ) {
        self.transport = transport
        self.audio = audio
        self.ptt = ptt
        self.background = background
        self.clock = clock
        self.queue = queue

        transport.delegate = self
        audio.delegate = self
        ptt.delegate = self
        background.delegate = self
    }

    // MARK: - Observation

    public func addObserver(_ id: String, _ handler: @escaping (RadioEvent) -> Void) {
        queue.async {
            self.observers[id] = handler
            handler(.stateChanged(self.state))
        }
    }

    public func removeObserver(_ id: String) {
        queue.async { self.observers.removeValue(forKey: id) }
    }

    public func getState(completion: @escaping (RadioState) -> Void) {
        queue.async { completion(self.state) }
    }

    // MARK: - startRadio / stopRadio

    public func startRadio() {
        queue.async { self.startRadioLocked() }
    }

    public func stopRadio() {
        queue.async { self.stopRadioLocked() }
    }

    private func startRadioLocked() {
        guard !isStarted else { return }
        isStarted = true
        state.status = .starting
        state.pttButton = ptt.buttonState
        emitStateLocked()

        ptt.start()
        background.activate()

        do {
            try audio.startPlayback()
            try transport.start()
        } catch {
            failLocked(.startFailed(String(describing: error)), fatal: true)
            return
        }

        state.status = .ready
        state.nearbyCount = transport.connectedPeerCount
        emitStateLocked()
        log.info("radio started")
    }

    private func stopRadioLocked() {
        guard isStarted else { return }
        stopTransmitLocked()
        transport.stop()
        audio.stopPlayback()
        background.deactivate()
        ptt.stop()

        receivingPeers.removeAll()
        rxFrameCounts.removeAll()
        isStarted = false
        state = RadioState(status: .starting, pttButton: ptt.buttonState)
        emitStateLocked()
        log.info("radio stopped")
    }

    // MARK: - startTransmit / stopTransmit

    public func startTransmit() {
        queue.async { self.startTransmitLocked() }
    }

    public func stopTransmit() {
        queue.async { self.stopTransmitLocked() }
    }

    private func startTransmitLocked() {
        guard isStarted, state.status != .error else { return }
        guard !state.transmitting, !isAwaitingAudioSession else { return }

        isAwaitingAudioSession = true
        armSafetyCapLocked()
        background.requestBeginTransmitting()
        log.info("transmit requested")
    }

    /// Called once the system has handed us an active audio session.
    private func beginTransmitLocked() {
        guard isAwaitingAudioSession, !state.transmitting else { return }
        isAwaitingAudioSession = false

        let streamId = UUID().uuidString
        currentStreamId = streamId
        transport.broadcastControl(.txStart(streamId: streamId))
        sink = transport.beginAudioStream(streamId: streamId)

        do {
            try audio.startCapture()
        } catch {
            sink?.close()
            sink = nil
            transport.endAudioStream()
            transport.broadcastControl(.txStop(streamId: streamId))
            currentStreamId = nil
            background.stopTransmitting()
            cancelSafetyCapLocked()
            failLocked(.audioFailed(String(describing: error)), fatal: false)
            return
        }

        state.transmitting = true
        emitStateLocked()
        log.info("transmitting \(streamId, privacy: .public)")
    }

    private func stopTransmitLocked() {
        cancelSafetyCapLocked()
        guard state.transmitting || isAwaitingAudioSession else { return }

        isAwaitingAudioSession = false
        if state.transmitting {
            audio.stopCapture()
        }
        sink?.close()
        sink = nil
        transport.endAudioStream()

        if let streamId = currentStreamId {
            transport.broadcastControl(.txStop(streamId: streamId))
            currentStreamId = nil
        }
        background.stopTransmitting()

        if state.transmitting {
            state.transmitting = false
            emitStateLocked()
        }
        log.info("transmit stopped")
    }

    private func armSafetyCapLocked() {
        cancelSafetyCapLocked()
        safetyCap = clock.schedule(after: RadioConfig.Transmit.safetyCapSeconds) {
            [weak self] in
            guard let self else { return }
            self.queue.async {
                self.log.info("safety cap reached, stopping transmission")
                self.stopTransmitLocked()
            }
        }
    }

    private func cancelSafetyCapLocked() {
        safetyCap?.cancel()
        safetyCap = nil
    }

    // MARK: - PTT configuration

    /// Opens the native pairing session (amended spec section 6.1). Progress is
    /// published as `state.pttPairing`; this resolves once the binding is saved.
    public func configurePtt(
        completion: @escaping (Result<PttConfiguration, RadioError>) -> Void
    ) {
        queue.async {
            self.ptt.beginLearning { result in
                self.queue.async {
                    if case .success = result {
                        self.state.pttButton = self.ptt.buttonState
                    }
                    // The session is over either way. `.saved` was already
                    // delivered in its own snapshot by the PTT source, so this
                    // is one emission, not two.
                    self.state.pttPairing = nil
                    self.emitStateLocked()

                    completion(result)
                    if case let .failure(error) = result {
                        self.failLocked(error, fatal: false)
                    }
                }
            }
        }
    }

    /// The user's pick from `state.pttPairing.candidates`.
    public func selectPttCandidate(deviceId: String) {
        queue.async { self.ptt.selectCandidate(deviceId: deviceId) }
    }

    public func forgetPtt() {
        queue.async {
            self.ptt.forget()
            self.state.pttButton = self.ptt.buttonState
            self.emitStateLocked()
        }
    }

    // MARK: - Emission

    private func emitStateLocked() {
        notifyLocked(.stateChanged(state))
    }

    private func failLocked(_ error: RadioError, fatal: Bool) {
        log.error("\(error.code, privacy: .public): \(error.message, privacy: .public)")
        if fatal {
            state.status = .error
            emitStateLocked()
        }
        notifyLocked(.error(error))
    }

    private func notifyLocked(_ event: RadioEvent) {
        for handler in observers.values {
            handler(event)
        }
    }
}

// MARK: - RadioTransportDelegate

extension RadioEngine: RadioTransportDelegate {

    public func transport(_ transport: RadioTransport, peerCountDidChange count: Int) {
        queue.async {
            guard self.state.nearbyCount != count else { return }
            self.state.nearbyCount = count
            self.emitStateLocked()
        }
    }

    public func transport(
        _ transport: RadioTransport,
        didStartIncomingAudio peerId: String
    ) {
        queue.async {
            HeartbeatLogger.shared.record("rx start peer=\(peerId)")
            let wasSilent = self.receivingPeers.isEmpty
            self.receivingPeers.insert(peerId)
            // AVAudioEngine only runs while the audio session is active, so
            // the background session is told before playback opens. Under the
            // always-hot architecture the session is already active and this
            // is a no-op; the ordering is kept because the port's contract,
            // not this implementation, is what the engine may rely on.
            if wasSilent {
                self.background.setReceiving(true)
            }
            self.audio.beginIncoming(peerId: peerId)
            guard !self.state.receiving else { return }
            self.state.receiving = true
            self.emitStateLocked()
        }
    }

    public func transport(
        _ transport: RadioTransport,
        didReceiveAudioFrame frame: Data,
        from peerId: String
    ) {
        queue.async {
            guard self.receivingPeers.contains(peerId) else { return }
            let count = (self.rxFrameCounts[peerId] ?? 0) + 1
            self.rxFrameCounts[peerId] = count
            if count == 1 || count % 50 == 0 {
                HeartbeatLogger.shared.record(
                    "rx frames peer=\(peerId) n=\(count) bytes=\(frame.count)"
                )
            }
            self.audio.enqueue(frame: frame, from: peerId)
        }
    }

    public func transport(
        _ transport: RadioTransport,
        didStopIncomingAudio peerId: String
    ) {
        queue.async {
            guard self.receivingPeers.remove(peerId) != nil else { return }
            HeartbeatLogger.shared.record(
                "rx stop peer=\(peerId) "
                    + "frames=\(self.rxFrameCounts.removeValue(forKey: peerId) ?? 0)"
            )
            self.audio.endIncoming(peerId: peerId)
            guard self.receivingPeers.isEmpty else { return }
            self.background.setReceiving(false)
            self.state.receiving = false
            self.emitStateLocked()
        }
    }

    public func transport(_ transport: RadioTransport, didFail error: RadioError) {
        queue.async { self.failLocked(error, fatal: true) }
    }
}

// MARK: - AudioIODelegate

extension RadioEngine: AudioIODelegate {

    public func audioIO(_ audio: AudioIO, didEncodeFrame frame: Data) {
        queue.async {
            guard self.state.transmitting else { return }
            self.sink?.write(frame: frame)
        }
    }

    public func audioIO(_ audio: AudioIO, didFail error: RadioError) {
        queue.async {
            self.stopTransmitLocked()
            self.failLocked(error, fatal: false)
        }
    }
}

// MARK: - PttSourceDelegate

extension RadioEngine: PttSourceDelegate {

    public func pttSourceDidPress(_ source: PttSource) {
        startTransmit()
    }

    public func pttSourceDidRelease(_ source: PttSource) {
        stopTransmit()
    }

    public func pttSource(_ source: PttSource, buttonStateDidChange state: PttButtonState) {
        queue.async {
            guard self.state.pttButton != state else { return }
            self.state.pttButton = state
            self.emitStateLocked()
        }
    }

    public func pttSource(_ source: PttSource, pairingStateDidChange state: PttPairingState?) {
        queue.async {
            guard self.state.pttPairing != state else { return }
            self.state.pttPairing = state
            self.emitStateLocked()
        }
    }
}

// MARK: - BackgroundSessionDelegate

extension RadioEngine: BackgroundSessionDelegate {

    public func backgroundSessionDidActivateAudio(_ session: BackgroundSession) {
        queue.async { self.beginTransmitLocked() }
    }

    public func backgroundSessionDidDeactivateAudio(_ session: BackgroundSession) {
        queue.async { self.stopTransmitLocked() }
    }

    public func backgroundSessionDidRequestTransmitStart(_ session: BackgroundSession) {
        startTransmit()
    }

    public func backgroundSessionDidRequestTransmitStop(_ session: BackgroundSession) {
        stopTransmit()
    }

    public func backgroundSession(
        _ session: BackgroundSession,
        didFail error: RadioError
    ) {
        queue.async { self.failLocked(error, fatal: false) }
    }
}
