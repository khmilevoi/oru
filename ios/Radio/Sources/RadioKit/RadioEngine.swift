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
    /// §7, merged from P1 and never edited here. Replaced wholesale on
    /// `stopRadio` — it holds dwell and PTT state that must not survive a power
    /// cycle, and P1's file owns its own reset semantics (there are none).
    private var policy = ModePolicy()
    /// The policy's `nextWakeupMs`, as one cancellable timer. nil obliges us to
    /// cancel, not merely to skip arming.
    private var policyTimer: RadioCancellable?
    /// What was last handed to `background.applyProfile`. §5 applies diff-only.
    private var appliedProfile: ModePolicy.Profile = .voice
    /// A press is outstanding. Distinct from `state.transmitting`, because §7
    /// puts a raise (up to 4 s) between the press and the microphone.
    private var isPttHeld = false
    /// A `raiseVoiceLink` is in flight and a route change must answer it.
    private var isAwaitingVoiceLink = false
    /// §5's other-audio detection, as last reported by the session.
    private var otherAudioActive = false
    /// What `otherAudioActive` was when the profile last left MEDIA for VOICE.
    /// Latched there because a raise pauses the other app, which then reports
    /// no audio at all — see `ResumeNudgePolicy`.
    private var otherAudioActiveBeforeVoice = false
    /// §8's persisted setting. `RadioAssembly` supplies the production store;
    /// tests inject one against a private `UserDefaults` suite.
    private let audioModeStore: AudioModeStore

    public init(
        transport: RadioTransport,
        audio: AudioIO,
        ptt: PttSource,
        background: BackgroundSession,
        clock: RadioClock,
        queue: DispatchQueue,
        audioModeStore: AudioModeStore = AudioModeStore()
    ) {
        self.transport = transport
        self.audio = audio
        self.ptt = ptt
        self.background = background
        self.clock = clock
        self.queue = queue
        self.audioModeStore = audioModeStore

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
        // The route and the other-audio state arrive from the session's own
        // publication (they are delivered on this queue, after this returns).
        state.audioMode = audioModeStore.load()
        performLocked(policy.setAudioMode(state.audioMode.policyMode, nowMs: clock.nowMs))
        performLocked(policy.setRadioActive(false, nowMs: clock.nowMs))

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
        policyTimer?.cancel()
        policyTimer = nil
        policy = ModePolicy()
        appliedProfile = .voice
        isPttHeld = false
        isAwaitingVoiceLink = false
        otherAudioActive = false
        otherAudioActiveBeforeVoice = false
        state = RadioState(
            status: .starting,
            pttButton: ptt.buttonState,
            audioMode: audioModeStore.load()
        )
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
        guard !state.transmitting, !isAwaitingAudioSession, !isPttHeld else { return }

        isPttHeld = true
        // Armed at the press, not at the microphone: §7 puts a raise of up to
        // 4 s in between, and a stuck button during a raise is still stuck.
        armSafetyCapLocked()
        performLocked(policy.pttPressed(nowMs: clock.nowMs))
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
        syncRadioActiveLocked()
        log.info("transmitting \(streamId, privacy: .public)")
    }

    private func stopTransmitLocked() {
        cancelSafetyCapLocked()
        if isPttHeld {
            isPttHeld = false
            isAwaitingVoiceLink = false
            performLocked(policy.pttReleased(nowMs: clock.nowMs))
        }
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
        syncRadioActiveLocked()
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

    /// §8's setting. Stores it natively and applies it — `specs/NativeRadio.ts`
    /// requires both, and requires the state emission the callers read.
    public func setAudioMode(_ setting: AudioModeSetting) {
        queue.async {
            self.audioModeStore.save(setting)
            self.state.audioMode = setting
            self.emitStateLocked()
            self.performLocked(
                self.policy.setAudioMode(setting.policyMode, nowMs: self.clock.nowMs)
            )
        }
    }

    // MARK: - Mode policy (§7)

    /// One decision, performed. `ModePolicy.swift` states the iOS rule this
    /// follows: on iOS `raiseVoiceLink`/`dropVoiceLink` and a `Decision.profile`
    /// change are the same `setCategory` call, so the profile diff is applied
    /// first and the raise/drop is treated as satisfied by it.
    private func performLocked(_ decision: ModePolicy.Decision) {
        if decision.profile != appliedProfile {
            let previousProfile = appliedProfile
            appliedProfile = decision.profile
            background.applyProfile(decision.profile)
            // §8's `mode` is the *effective* profile, so it moves with the
            // apply and not with the user's pin.
            state.audioRoute.mode = AudioRoute.Mode(decision.profile)
            emitStateLocked()
            settleOtherAudioResumeLocked(
                from: previousProfile, to: decision.profile, actions: decision.actions
            )
        }

        for action in decision.actions {
            switch action {
            case .raiseVoiceLink:
                // The session work is the profile apply above; all that is left
                // is to remember that a route change owes us an answer.
                isAwaitingVoiceLink = true
            case .dropVoiceLink:
                isAwaitingVoiceLink = false
            case .playGrantTone:
                audio.playGrantTone()
            case let .startCapture(source):
                isAwaitingVoiceLink = false
                // §5 has no second microphone mechanism and wants none: the
                // applied configuration decides which mic the input node
                // resolves to, and the policy restored the base configuration
                // before emitting this. The source is recorded as evidence.
                // An exhaustive switch, not a `source == .routeDefault ? :`
                // ternary: `MicSource` is merged, read-only P1 vocabulary, so
                // a third case added there must fail this file to compile
                // rather than silently fall into "phone".
                let micLabel: String
                switch source {
                case .routeDefault:
                    micLabel = "route"
                case .phoneFallback:
                    micLabel = "phone"
                }
                HeartbeatLogger.shared.record("tx mic=\(micLabel)")
                isAwaitingAudioSession = true
                background.requestBeginTransmitting()
            }
        }

        scheduleTickLocked(decision.nextWakeupMs)
    }

    /// §9 row 5's second half. The raise pauses the user's music; nothing on
    /// iOS resumes it, because the always-hot session never deactivates and a
    /// deactivation is the only resume signal there is. So the return to MEDIA
    /// asks the session for one — but only at the one moment where it costs
    /// nothing, which is what `ResumeNudgePolicy` decides.
    ///
    /// Runs right after the profile apply, so the nudge lands on a session that
    /// is already back on the MEDIA configuration.
    private func settleOtherAudioResumeLocked(
        from previousProfile: ModePolicy.Profile,
        to nextProfile: ModePolicy.Profile,
        actions: [ModePolicy.Action]
    ) {
        guard previousProfile == .voice else {
            // Leaving MEDIA: latch what the raise is about to interrupt. While
            // the link is up the paused app reports no other audio at all, so
            // this is the last moment the truth is observable.
            otherAudioActiveBeforeVoice = otherAudioActive
            return
        }
        let startsCapture = actions.contains {
            if case .startCapture = $0 { return true }
            return false
        }
        guard
            ResumeNudgePolicy.isWarranted(
                from: previousProfile,
                to: nextProfile,
                otherAudioWasActive: otherAudioActiveBeforeVoice,
                startsCapture: startsCapture,
                pttHeld: isPttHeld,
                transmitting: state.transmitting,
                receiving: state.receiving
            )
        else {
            return
        }
        // One nudge per raise: the latch is the permission, and it is spent.
        otherAudioActiveBeforeVoice = false
        background.nudgeOtherAudioResume()
    }

    private func scheduleTickLocked(_ nextWakeupMs: Int64?) {
        policyTimer?.cancel()
        policyTimer = nil
        guard let nextWakeupMs else { return }
        let delay = max(0, Double(nextWakeupMs - clock.nowMs) / 1_000)
        policyTimer = clock.schedule(after: delay) { [weak self] in
            guard let self else { return }
            self.queue.async {
                self.performLocked(self.policy.tick(nowMs: self.clock.nowMs))
            }
        }
    }

    /// §7's radio-idle gate. Fed from the engine's own truth rather than from
    /// the button: a transmission also ends on the 120 s safety cap.
    private func syncRadioActiveLocked() {
        performLocked(
            policy.setRadioActive(state.transmitting || state.receiving, nowMs: clock.nowMs)
        )
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
            self.syncRadioActiveLocked()
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
            self.syncRadioActiveLocked()
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

    /// §8's route, fed to the §7 policy. Task 6 publishes it into `RadioState`.
    public func backgroundSession(
        _ session: BackgroundSession,
        routeDidChange snapshot: AudioRouteSnapshot
    ) {
        queue.async {
            if self.state.audioRoute.kind != snapshot.kind
                || self.state.audioRoute.label != snapshot.label {
                self.state.audioRoute.kind = snapshot.kind
                self.state.audioRoute.label = snapshot.label
                self.emitStateLocked()
            }
            self.performLocked(
                self.policy.setRouteRequiresVoiceLink(
                    snapshot.requiresVoiceLink, nowMs: self.clock.nowMs
                )
            )
            guard self.isAwaitingVoiceLink else { return }
            if snapshot.providesVoiceLink {
                // §7: the tone waits for the headset mic path to be confirmed.
                self.performLocked(self.policy.voiceLinkEstablished(nowMs: self.clock.nowMs))
            } else if !snapshot.requiresVoiceLink {
                // The accessory the raise targeted is gone. `ModePolicy`
                // requires this to be reported, or it waits out the whole 4 s.
                self.performLocked(self.policy.voiceLinkFailed(nowMs: self.clock.nowMs))
            }
        }
    }

    public func backgroundSession(
        _ session: BackgroundSession,
        otherAudioActiveDidChange active: Bool
    ) {
        queue.async {
            self.otherAudioActive = active
            self.performLocked(self.policy.setOtherAudioActive(active, nowMs: self.clock.nowMs))
        }
    }

    /// §5's rebuild travels session → engine → audio: the session is what
    /// observes the notification, `AudioIO` is what owns the graph.
    public func backgroundSession(
        _ session: BackgroundSession,
        didRequestEngineRebuild recreate: Bool
    ) {
        queue.async { self.audio.rebuildEngine(recreate: recreate) }
    }
}
