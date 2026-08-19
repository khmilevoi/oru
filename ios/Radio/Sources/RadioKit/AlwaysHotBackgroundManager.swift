import AVFoundation
import Foundation
import os

/// The iOS background architecture (spec section 10.2), and the only
/// `BackgroundSession` there is. The app activates a `.playAndRecord` session
/// itself in the foreground and keeps the microphone pulling samples
/// continuously (see `AudioEngine`'s keep-alive tap), which counts as
/// background audio under the `audio` UIBackgroundMode — so the process legally
/// keeps running while locked, no entitlement required.
///
/// It started as Spike Test #1, the alternative to the system PushToTalk
/// framework; on 2026-08-18 it became the architecture and PushToTalk was
/// deleted, because `com.apple.developer.push-to-talk` requires a paid Apple
/// Developer account and on-device runs confirmed this path works.
public final class AlwaysHotBackgroundManager: NSObject, BackgroundSession {

    public weak var delegate: BackgroundSessionDelegate?

    private var isActive = false
    /// The configuration currently in force. §5's mode switches are a re-apply
    /// of the other one; the merged §7 policy is what asks for a change (wired
    /// in Task 5). Until then activation applies VOICE and nothing changes it.
    private var appliedProfile: ModePolicy.Profile = .voice
    private let log = Logger(
        subsystem: RadioConfig.Logging.subsystem,
        category: "background"
    )

    public override init() {
        super.init()
    }

    // MARK: - BackgroundSession

    public func activate() {
        let session = AVAudioSession.sharedInstance()
        do {
            // Category first, then active — activating under the platform
            // default category leaves AVAudioEngine with no real input/output
            // route once the category does switch (the crash documented in
            // AudioEngine.prepareEngineOnMainThread). There is no detection
            // phase any more (§11): the configuration is stated, not discovered.
            try apply(AudioSessionConfiguration.of(appliedProfile), to: session)
            try session.setActive(true)
        } catch {
            delegate?.backgroundSession(
                self,
                didFail: .backgroundFailed("always-hot activation: \(error)")
            )
            return
        }

        isActive = true
        maximizeInputGain(session)
        syncSpeakerOverride(on: session)
        observeInterruptions()
        observeRouteChanges()
        HeartbeatLogger.shared.sessionActive = true
        HeartbeatLogger.shared.start()
        log.info("always-hot audio session active")
        // The port's activation callback. Harmless at this point (nothing is
        // awaiting the session yet), delivered because the contract says the
        // engine learns about activation from here and nowhere else.
        delegate?.backgroundSessionDidActivateAudio(self)
    }

    public func deactivate() {
        NotificationCenter.default.removeObserver(self)
        HeartbeatLogger.shared.sessionActive = false
        HeartbeatLogger.shared.stop()
        isActive = false
        appliedProfile = .voice
        do {
            try AVAudioSession.sharedInstance().setActive(
                false,
                options: .notifyOthersOnDeactivation
            )
        } catch {
            log.error("deactivation failed: \(error, privacy: .public)")
        }
        delegate?.backgroundSessionDidDeactivateAudio(self)
    }

    public func requestBeginTransmitting() {
        guard isActive else {
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

    // MARK: - Session configuration (§5)

    /// §5's "applied whole (diff-only: skip if already applied)". The diff is
    /// what replaced the `isApplyingProfile` recursion guard: our own
    /// `setCategory` emits a `.categoryChange`, and re-applying on that would
    /// loop — but after the apply the live configuration already satisfies the
    /// target, so nothing is applied a second time.
    private func apply(
        _ configuration: AudioSessionConfiguration,
        to session: AVAudioSession
    ) throws {
        guard
            !configuration.matches(
                category: session.category,
                mode: session.mode,
                options: session.categoryOptions
            )
        else {
            return
        }
        try session.setCategory(
            configuration.category,
            mode: configuration.mode,
            options: configuration.options
        )
        HeartbeatLogger.shared.record("session config \(configuration.logName)")
    }

    /// §5's on-demand speaker: `.speaker` only when the outputs are solely the
    /// built-in receiver, `.none` the moment any external output is present.
    /// Failure is logged, not fatal — audio still flows out of the receiver.
    private func syncSpeakerOverride(on session: AVAudioSession) {
        let route = session.currentRoute
        let override = AudioSessionConfiguration.speakerOverride(
            forOutputs: AudioPort.ports(from: route.outputs)
        )
        do {
            try session.overrideOutputAudioPort(override)
        } catch {
            HeartbeatLogger.shared.record("speaker override FAILED: \(error)")
        }
    }

    // MARK: - Route changes

    private func observeRouteChanges() {
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleRouteChange(_:)),
            name: AVAudioSession.routeChangeNotification,
            object: AVAudioSession.sharedInstance()
        )
    }

    /// Every change lands in heartbeat.log; a device appearing or disappearing
    /// recomputes the speaker override, which is all the routing §5 asks for on
    /// iOS — "iOS routing is last-in wins and automatic once category options
    /// are right" (§4), so nothing here chases devices. Publishing the route,
    /// feeding the §7 policy and re-applying our configuration on a foreign
    /// `.categoryChange` arrive with the reaction table (Task 4).
    @objc private func handleRouteChange(_ notification: Notification) {
        let session = AVAudioSession.sharedInstance()
        let route = session.currentRoute
        let reasonRaw = notification.userInfo?[AVAudioSessionRouteChangeReasonKey]
            as? UInt ?? 0
        let reason = AVAudioSession.RouteChangeReason(rawValue: reasonRaw) ?? .unknown
        HeartbeatLogger.shared.record(
            "route: reason=\(AudioRouteFormatter.name(of: reason)) "
                + "in=\(AudioRouteFormatter.portTypes(route.inputs)) "
                + "out=\(AudioRouteFormatter.portTypes(route.outputs))"
        )

        guard reason == .oldDeviceUnavailable || reason == .newDeviceAvailable else {
            return
        }
        guard isActive else { return }
        syncSpeakerOverride(on: session)
    }

    // MARK: - Interruptions

    /// The session is ours, not the system's, so a phone call or Siri can
    /// snatch it away, and every occurrence must land in heartbeat.log:
    /// reactivation failing while backgrounded is the failure mode this
    /// architecture has to be watched for.
    private func observeInterruptions() {
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleInterruption(_:)),
            name: AVAudioSession.interruptionNotification,
            object: AVAudioSession.sharedInstance()
        )
    }

    @objc private func handleInterruption(_ notification: Notification) {
        guard
            let raw = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
            let type = AVAudioSession.InterruptionType(rawValue: raw)
        else { return }

        switch type {
        case .began:
            HeartbeatLogger.shared.sessionActive = false
            HeartbeatLogger.shared.record("interruption began")
        case .ended:
            let optionsRaw = notification.userInfo?[AVAudioSessionInterruptionOptionKey]
                as? UInt ?? 0
            let options = AVAudioSession.InterruptionOptions(rawValue: optionsRaw)
            guard options.contains(.shouldResume) else {
                HeartbeatLogger.shared.record("interruption ended, no shouldResume")
                return
            }
            do {
                try AVAudioSession.sharedInstance().setActive(true)
                HeartbeatLogger.shared.sessionActive = true
                HeartbeatLogger.shared.record("interruption ended, reactivated")
            } catch {
                // Expected while backgrounded: iOS refuses activation from the
                // background. Wanted visible in the log, not swallowed.
                HeartbeatLogger.shared.record(
                    "interruption ended, reactivation FAILED: \(error)"
                )
            }
        @unknown default:
            break
        }
    }
}
