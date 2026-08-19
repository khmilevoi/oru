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
        observeNotifications()
        HeartbeatLogger.shared.onTick = { [weak self] in
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
        NotificationCenter.default.removeObserver(self)
        isObserving = false
        HeartbeatLogger.shared.onTick = nil
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
        for action in reaction.actions {
            perform(action)
        }
    }

    /// Caller is on `queue`.
    private func perform(_ action: AudioSessionAction) {
        let session = AVAudioSession.sharedInstance()
        switch action {
        case let .applyConfiguration(profile):
            applyConfigurationLocked(AudioSessionConfiguration.of(profile), on: session)
        case .activate:
            activateLocked(retriesLeft: RadioConfig.Session.activationRetryLimit)
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
    /// Never blocks the queue — the radio's own work runs on it.
    private func activateLocked(retriesLeft: Int) {
        do {
            try AVAudioSession.sharedInstance().setActive(true)
            handleLocked(.activationSucceeded)
        } catch let error as NSError
            where error.code == AVAudioSession.ErrorCode.isBusy.rawValue && retriesLeft > 0 {
            HeartbeatLogger.shared.record(
                "session busy, retrying activation (\(retriesLeft) left)"
            )
            queue.asyncAfter(deadline: .now() + RadioConfig.Session.activationRetryDelay) {
                [weak self] in
                self?.activateLocked(retriesLeft: retriesLeft - 1)
            }
        } catch {
            // Expected while backgrounded: iOS refuses activation from there.
            // Wanted visible in the log, not swallowed.
            HeartbeatLogger.shared.record("session activation FAILED: \(error)")
            handleLocked(.activationFailed)
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
        center.addObserver(
            self, selector: #selector(handleMediaServicesReset(_:)),
            name: AVAudioSession.mediaServicesWereResetNotification, object: session
        )
        center.addObserver(
            self, selector: #selector(handleSilenceSecondaryAudioHint(_:)),
            name: AVAudioSession.silenceSecondaryAudioHintNotification, object: session
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
        queue.async { [weak self] in
            self?.handleLocked(.routeChanged(reason: reason))
        }
    }

    @objc private func handleEngineConfigurationChange(_ notification: Notification) {
        // §5: a route change that alters the hardware sample rate (built-in
        // 48 kHz ↔ HFP 8/16 kHz) stops AVAudioEngine silently, and the
        // keep-alive tap dies with it — which is how a headset connecting while
        // the phone is locked used to suspend the whole radio.
        HeartbeatLogger.shared.record("engine configuration changed")
        queue.async { [weak self] in
            self?.handleLocked(.engineConfigurationChanged)
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
            queue.async { [weak self] in self?.handleLocked(.interruptionBegan) }
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
            queue.async { [weak self] in self?.handleLocked(.interruptionEnded) }
        @unknown default:
            break
        }
    }

    @objc private func handleMediaServicesReset(_ notification: Notification) {
        HeartbeatLogger.shared.record("media services were reset")
        queue.async { [weak self] in self?.handleLocked(.mediaServicesWereReset) }
    }

    @objc private func handleSilenceSecondaryAudioHint(_ notification: Notification) {
        queue.async { [weak self] in self?.handleLocked(.silenceSecondaryAudioHint) }
    }

    #if canImport(UIKit)
    @objc private func handleAppDidBecomeActive(_ notification: Notification) {
        queue.async { [weak self] in self?.handleLocked(.appDidBecomeActive) }
    }
    #endif
}
