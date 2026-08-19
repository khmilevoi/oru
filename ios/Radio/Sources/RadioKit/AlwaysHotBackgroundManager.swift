import AVFoundation
import Foundation
import os
#if canImport(UIKit)
import UIKit
#endif

/// The iOS background architecture (spec section 10.2), and the only
/// `BackgroundSession` there is. The app activates a `.playAndRecord` session
/// itself in the foreground and keeps the microphone pulling samples
/// continuously (see `AudioEngine`'s keep-alive tap), which counts as
/// background audio under the `audio` UIBackgroundMode — so the process legally
/// keeps running while locked, no entitlement required.
///
/// Since the 2026-08-18 seamless-headphone-audio design (§5) this class holds no
/// decisions at all. Six notifications arrive on whatever thread the system
/// chose; each is re-posted onto the engine queue, turned into an
/// `AudioSessionEvent`, and answered by `AudioSessionReactor.react` with the
/// next status and a list of actions. This class performs those actions and
/// nothing else. That is what closes the data race on `isActive`/`currentProfile`
/// the previous version had: the status is one value, mutated on one queue.
public final class AlwaysHotBackgroundManager: NSObject, BackgroundSession {

    public weak var delegate: BackgroundSessionDelegate?

    /// The `RadioEngine` queue. Every notification handler hops onto it before
    /// touching anything; every `BackgroundSession` method is already called on
    /// it, so none of them may dispatch back onto it synchronously.
    private let queue: DispatchQueue
    private var status = AudioSessionStatus()
    /// Diff state for the two upward channels. `nil` means "never reported", so
    /// the first sample always goes up.
    private var lastRouteSnapshot: AudioRouteSnapshot?
    private var lastOtherAudioActive: Bool?
    private var isObserving = false
    /// Bumped by `activate()` and `deactivate()`. Every deferred continuation —
    /// the activation retry's `asyncAfter` and each notification handler's
    /// `queue.async` hop — captures the generation in force when it was
    /// created and checks it again once it actually runs, so a retry armed (or
    /// a notification already in flight) before a `deactivate()` cannot land on
    /// a radio the user has since stopped, and a stale `.appDidBecomeActive`
    /// from before an `activate()` cannot double-run recovery.
    private var generation = 0
    private let log = Logger(
        subsystem: RadioConfig.Logging.subsystem,
        category: "background"
    )

    public init(queue: DispatchQueue) {
        self.queue = queue
        super.init()
    }

    // MARK: - BackgroundSession

    public func activate() {
        generation += 1
        observeNotifications()
        HeartbeatLogger.shared.setOnTick { [weak self] in
            self?.queue.async { self?.sampleOtherAudioLocked() }
        }
        HeartbeatLogger.shared.start()
        handleLocked(.activationRequested)
        log.info("always-hot audio session activating")
        // The port's activation callback. Harmless at this point (nothing is
        // awaiting the session yet), delivered because the contract says the
        // engine learns about activation from here and nowhere else.
        delegate?.backgroundSessionDidActivateAudio(self)
    }

    public func deactivate() {
        generation += 1
        NotificationCenter.default.removeObserver(self)
        isObserving = false
        HeartbeatLogger.shared.setOnTick(nil)
        HeartbeatLogger.shared.sessionActive = false
        HeartbeatLogger.shared.stop()
        lastRouteSnapshot = nil
        lastOtherAudioActive = nil
        handleLocked(.deactivationRequested)
        delegate?.backgroundSessionDidDeactivateAudio(self)
    }

    public func requestBeginTransmitting() {
        guard status.isActive else {
            delegate?.backgroundSession(
                self,
                didFail: .backgroundFailed("always-hot session not active")
            )
            return
        }
        // The session is already hot — acknowledge immediately rather than
        // waiting for an activation that will never come. RadioEngine's
        // beginTransmitLocked() takes it from here.
        delegate?.backgroundSessionDidActivateAudio(self)
    }

    public func stopTransmitting() {
        // Nothing to release: the session stays hot between transmissions —
        // that continuity is the whole architecture. RadioEngine has already
        // stopped capture itself by the time it calls this.
    }

    public func setReceiving(_ receiving: Bool) {
        // The port exists so an implementation can activate the session for
        // playback; here it is always active, so there is nothing to do.
    }

    public func applyProfile(_ profile: ModePolicy.Profile) {
        handleLocked(.profileRequested(profile))
    }

    // MARK: - The table

    /// Caller is on `queue`.
    private func handleLocked(_ event: AudioSessionEvent) {
        let reaction = AudioSessionReactor.react(to: event, from: status)
        status = reaction.status
        HeartbeatLogger.shared.sessionActive = status.isActive
        performLocked(reaction.actions)
    }

    /// Performs actions in the order the table listed them. `.activate` is the
    /// one action that may not resolve inline: when the session is busy the
    /// activation is retried later, and everything after it in the list has to
    /// wait for that outcome — the table puts the recovery rebuild after
    /// `.activate` precisely because an engine cannot start against a session
    /// that is not active yet. Caller is on `queue`.
    private func performLocked(_ actions: [AudioSessionAction]) {
        for (index, action) in actions.enumerated() {
            guard case .activate = action else {
                perform(action)
                continue
            }
            activateLocked(
                retriesLeft: RadioConfig.Session.activationRetryLimit,
                then: Array(actions.dropFirst(index + 1))
            )
            return
        }
    }

    /// Caller is on `queue`.
    private func perform(_ action: AudioSessionAction) {
        let session = AVAudioSession.sharedInstance()
        switch action {
        case let .applyConfiguration(profile):
            applyConfigurationLocked(AudioSessionConfiguration.of(profile), on: session)
        case .activate:
            // Unreachable: `performLocked` intercepts `.activate` itself so it
            // can carry the rest of the list across a retry. Kept in the
            // switch (no `default:`) so a new table action stays a compile
            // error here.
            assertionFailure("`.activate` must be handled by performLocked, not perform")
        case .deactivate:
            do {
                try session.setActive(false, options: .notifyOthersOnDeactivation)
            } catch {
                log.error("deactivation failed: \(error, privacy: .public)")
            }
        case .maximizeInputGain:
            maximizeInputGain(session)
        case .syncSpeakerOverride:
            syncSpeakerOverrideLocked(on: session)
        case .publishRoute:
            publishRouteLocked(on: session)
        case .sampleOtherAudio:
            sampleOtherAudioLocked()
        case .rebuildEngine:
            delegate?.backgroundSession(self, didRequestEngineRebuild: false)
        case .recreateEngine:
            delegate?.backgroundSession(self, didRequestEngineRebuild: true)
        }
    }

    // MARK: - Actions

    /// §5's "applied whole (diff-only: skip if already applied)". The diff is
    /// also the recursion guard the old `isApplyingProfile` flag used to be:
    /// our own `setCategory` emits a `.categoryChange`, whose row re-applies
    /// the current configuration — and finds it already in force, so it stops.
    private func applyConfigurationLocked(
        _ configuration: AudioSessionConfiguration,
        on session: AVAudioSession
    ) {
        guard
            !configuration.matches(
                category: session.category,
                mode: session.mode,
                options: session.categoryOptions
            )
        else {
            return
        }
        do {
            try session.setCategory(
                configuration.category,
                mode: configuration.mode,
                options: configuration.options
            )
            HeartbeatLogger.shared.record("session config \(configuration.logName)")
        } catch {
            // Never fatal: the session keeps whatever it had, and the next
            // route change or recovery tries again.
            HeartbeatLogger.shared.record(
                "session config \(configuration.logName) FAILED: \(error)"
            )
        }
    }

    /// §5's `setActive` with retry on `.isBusy` (0.5 s × 3, Signal's pattern).
    /// Never blocks the queue — the radio's own work runs on it. `tail` is the
    /// remainder of the reaction's action list that follows this `.activate`
    /// in the table — see `performLocked`. Caller is on `queue`.
    private func activateLocked(retriesLeft: Int, then tail: [AudioSessionAction]) {
        do {
            try AVAudioSession.sharedInstance().setActive(true)
            handleLocked(.activationSucceeded)
            performLocked(tail)
        } catch let error as NSError
            where error.code == AVAudioSession.ErrorCode.isBusy.rawValue && retriesLeft > 0 {
            HeartbeatLogger.shared.record(
                "session busy, retrying activation (\(retriesLeft) left)"
            )
            let expectedGeneration = generation
            queue.asyncAfter(deadline: .now() + RadioConfig.Session.activationRetryDelay) {
                [weak self] in
                guard let self, self.generation == expectedGeneration else { return }
                self.activateLocked(retriesLeft: retriesLeft - 1, then: tail)
            }
        } catch {
            // Expected while backgrounded: iOS refuses activation from there.
            // Wanted visible in the log, not swallowed. §2 goal 3: the rebuild
            // fails too, loudly, and the next recovery retries — so the tail
            // still runs here, inline, rather than being dropped.
            HeartbeatLogger.shared.record("session activation FAILED: \(error)")
            handleLocked(.activationFailed)
            performLocked(tail)
        }
    }

    /// §5's on-demand speaker, and the wired-headphones fix: `.speaker` only
    /// when the outputs are solely the built-in receiver, `.none` the moment any
    /// external output is present. A pure function of the current outputs —
    /// never of a classification. Failure is logged, not fatal: audio still
    /// flows out of the receiver.
    private func syncSpeakerOverrideLocked(on session: AVAudioSession) {
        let override = AudioSessionConfiguration.speakerOverride(
            forOutputs: AudioPort.ports(from: session.currentRoute.outputs)
        )
        do {
            try session.overrideOutputAudioPort(override)
        } catch {
            HeartbeatLogger.shared.record("speaker override FAILED: \(error)")
        }
    }

    /// §8's route, classified and handed upward, diff-only.
    private func publishRouteLocked(on session: AVAudioSession) {
        let route = session.currentRoute
        let snapshot = AudioRouteClassifier.snapshot(
            outputs: AudioPort.ports(from: route.outputs),
            inputs: AudioPort.ports(from: route.inputs)
        )
        guard snapshot != lastRouteSnapshot else { return }
        lastRouteSnapshot = snapshot
        HeartbeatLogger.shared.record(
            "route kind=\(snapshot.kind.rawValue) "
                + "label=\(snapshot.label ?? "-") "
                + "voiceLink=\(snapshot.requiresVoiceLink ? "required" : "no")"
                + "/\(snapshot.providesVoiceLink ? "live" : "no") "
                + "in=\(AudioRouteFormatter.portTypes(route.inputs)) "
                + "out=\(AudioRouteFormatter.portTypes(route.outputs))"
        )
        delegate?.backgroundSession(self, routeDidChange: snapshot)
    }

    /// §5's other-audio detection. Our own playback is not "other audio" — the
    /// API already excludes the querying session — so this is exactly D1's
    /// "whether another app is playing audio".
    private func sampleOtherAudioLocked() {
        guard status.isActive else { return }
        let active = AVAudioSession.sharedInstance().isOtherAudioPlaying
        guard active != lastOtherAudioActive else { return }
        lastOtherAudioActive = active
        HeartbeatLogger.shared.record("other audio active=\(active)")
        delegate?.backgroundSession(self, otherAudioActiveDidChange: active)
    }

    /// Quiet-transmit investigation (2026-08-17): iPhone→Android audio is
    /// quiet, so the first lever is the session's own input gain, when the
    /// current route exposes one (the built-in mic on recent iPhones usually
    /// does not — the answer lands in heartbeat.log either way). Runs after
    /// activation because the gain belongs to the resolved input route.
    private func maximizeInputGain(_ session: AVAudioSession) {
        let before = session.inputGain
        guard session.isInputGainSettable else {
            HeartbeatLogger.shared.record(
                String(format: "input gain not settable, value=%.2f", before)
            )
            return
        }
        guard before < 1.0 else {
            HeartbeatLogger.shared.record(
                String(format: "input gain already %.2f", before)
            )
            return
        }
        do {
            try session.setInputGain(1.0)
            HeartbeatLogger.shared.record(
                String(
                    format: "input gain raised %.2f -> %.2f",
                    before, session.inputGain
                )
            )
        } catch {
            HeartbeatLogger.shared.record("input gain set FAILED: \(error)")
        }
    }

    // MARK: - Observers (§5)

    /// Six registrations for §5's four observers plus its two named triggers.
    /// Every one of them does the same two things: turn the notification into an
    /// event, and hop onto the engine queue. No handler reads or writes manager
    /// state on the thread the system delivered it on.
    private func observeNotifications() {
        guard !isObserving else { return }
        isObserving = true
        let center = NotificationCenter.default
        let session = AVAudioSession.sharedInstance()

        center.addObserver(
            self, selector: #selector(handleRouteChange(_:)),
            name: AVAudioSession.routeChangeNotification, object: session
        )
        center.addObserver(
            self, selector: #selector(handleInterruption(_:)),
            name: AVAudioSession.interruptionNotification, object: session
        )
        // `object: nil` on purpose: whether these two are actually posted with
        // the shared session as their object is only provable on a device, and
        // a missed `mediaServicesWereReset` is a permanently dead radio that
        // needs an app restart. `object: nil` can at worst deliver an extra
        // event, and both handlers only post onto the settled table, which is
        // idempotent — the asymmetry decides it.
        center.addObserver(
            self, selector: #selector(handleMediaServicesReset(_:)),
            name: AVAudioSession.mediaServicesWereResetNotification, object: nil
        )
        center.addObserver(
            self, selector: #selector(handleSilenceSecondaryAudioHint(_:)),
            name: AVAudioSession.silenceSecondaryAudioHintNotification, object: nil
        )
        // `object: nil` on purpose: the notification carries the AVAudioEngine
        // that changed, and `AudioIO` replaces that object outright after a
        // media-services reset. An observer registered against one instance
        // would go deaf exactly when it matters most. There is one engine in
        // this process.
        center.addObserver(
            self, selector: #selector(handleEngineConfigurationChange(_:)),
            name: .AVAudioEngineConfigurationChange, object: nil
        )
        #if canImport(UIKit)
        center.addObserver(
            self, selector: #selector(handleAppDidBecomeActive(_:)),
            name: UIApplication.didBecomeActiveNotification, object: nil
        )
        #endif
    }

    @objc private func handleRouteChange(_ notification: Notification) {
        let reasonRaw = notification.userInfo?[AVAudioSessionRouteChangeReasonKey]
            as? UInt ?? 0
        let reason = AVAudioSession.RouteChangeReason(rawValue: reasonRaw) ?? .unknown
        let route = AVAudioSession.sharedInstance().currentRoute
        HeartbeatLogger.shared.record(
            "route: reason=\(AudioRouteFormatter.name(of: reason)) "
                + "in=\(AudioRouteFormatter.portTypes(route.inputs)) "
                + "out=\(AudioRouteFormatter.portTypes(route.outputs))"
        )
        let expectedGeneration = generation
        queue.async { [weak self] in
            guard let self, self.generation == expectedGeneration else { return }
            self.handleLocked(.routeChanged(reason: reason))
        }
    }

    @objc private func handleEngineConfigurationChange(_ notification: Notification) {
        // §5: a route change that alters the hardware sample rate (built-in
        // 48 kHz ↔ HFP 8/16 kHz) stops AVAudioEngine silently, and the
        // keep-alive tap dies with it — which is how a headset connecting while
        // the phone is locked used to suspend the whole radio.
        HeartbeatLogger.shared.record("engine configuration changed")
        let expectedGeneration = generation
        queue.async { [weak self] in
            guard let self, self.generation == expectedGeneration else { return }
            self.handleLocked(.engineConfigurationChanged)
        }
    }

    @objc private func handleInterruption(_ notification: Notification) {
        guard
            let raw = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
            let type = AVAudioSession.InterruptionType(rawValue: raw)
        else { return }

        switch type {
        case .began:
            HeartbeatLogger.shared.record("interruption began")
            let expectedGeneration = generation
            queue.async { [weak self] in
                guard let self, self.generation == expectedGeneration else { return }
                self.handleLocked(.interruptionBegan)
            }
        case .ended:
            let optionsRaw = notification.userInfo?[AVAudioSessionInterruptionOptionKey]
                as? UInt ?? 0
            let options = AVAudioSession.InterruptionOptions(rawValue: optionsRaw)
            // `shouldResume` is logged, not obeyed: it is advice about resuming
            // playback, and this session is the app's lifeline. §5 recovers on
            // `.ended` and, because `.ended` is not guaranteed at all, on
            // foregrounding too.
            HeartbeatLogger.shared.record(
                "interruption ended, shouldResume=\(options.contains(.shouldResume))"
            )
            let expectedGeneration = generation
            queue.async { [weak self] in
                guard let self, self.generation == expectedGeneration else { return }
                self.handleLocked(.interruptionEnded)
            }
        @unknown default:
            break
        }
    }

    @objc private func handleMediaServicesReset(_ notification: Notification) {
        HeartbeatLogger.shared.record("media services were reset")
        let expectedGeneration = generation
        queue.async { [weak self] in
            guard let self, self.generation == expectedGeneration else { return }
            self.handleLocked(.mediaServicesWereReset)
        }
    }

    @objc private func handleSilenceSecondaryAudioHint(_ notification: Notification) {
        let expectedGeneration = generation
        queue.async { [weak self] in
            guard let self, self.generation == expectedGeneration else { return }
            self.handleLocked(.silenceSecondaryAudioHint)
        }
    }

    #if canImport(UIKit)
    @objc private func handleAppDidBecomeActive(_ notification: Notification) {
        let expectedGeneration = generation
        queue.async { [weak self] in
            guard let self, self.generation == expectedGeneration else { return }
            self.handleLocked(.appDidBecomeActive)
        }
    }
    #endif
}
