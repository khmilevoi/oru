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
    /// The profile the latest detection pass decided; diagnostic — device
    /// add/remove always re-runs the full two-phase detection, because whether
    /// a new device is HFP can only be learned under the permissive category.
    private var currentProfile: AudioSessionProfile?
    /// Recursion guard: our own setCategory/setPreferredInput calls emit route
    /// change notifications; while this is set they must not trigger another
    /// re-apply.
    private var isApplyingProfile = false
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
            // route once the category does switch (the exact crash documented
            // in AudioEngine.prepareEngineOnMainThread). The detection flow
            // owns activation itself, because phase 2 of the profile decision
            // can only be read AFTER activating; AudioEngine's startPlayback()
            // deliberately skips its own setCategory in this mode.
            try detectAndApplyProfile(on: session)
        } catch {
            delegate?.backgroundSession(
                self,
                didFail: .backgroundFailed("always-hot activation: \(error)")
            )
            return
        }

        isActive = true
        maximizeInputGain(session)
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
        currentProfile = nil
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

    // MARK: - Session profile (two-phase detection fix, 2026-08-17)

    /// Runs the two-step state machine from `AudioSessionProfile` against the
    /// live session — DETECTION BEFORE NARROWING, because iOS only exposes
    /// Bluetooth ports in `availableInputs`/`currentRoute` when the current
    /// category options allow them (the first single-shot version read them
    /// under narrow options and a connected headset stayed invisible forever).
    /// Ends with the session ACTIVE under the decided profile, the speaker
    /// override synced, and the decision in heartbeat.log.
    private func detectAndApplyProfile(on session: AVAudioSession) throws {
        isApplyingProfile = true
        defer { isApplyingProfile = false }

        // Phase 1: permissive category so HFP inputs become visible at all.
        try session.setCategory(
            .playAndRecord,
            mode: .voiceChat,
            options: AudioSessionProfile.permissiveDetectionOptions
        )
        let inputs = session.availableInputs ?? []
        if let profile = AudioSessionProfile.afterPermissiveDetection(
            availableInputs: inputs.map(\.portType)
        ) {
            // HFP found: the permissive options already equal the HFP
            // profile's options, so no second setCategory — pin the input so
            // the route survives iOS's mid-session second-guessing, activate.
            if let hfp = inputs.first(where: { $0.portType == .bluetoothHFP }) {
                try session.setPreferredInput(hfp)
            }
            try session.setActive(true)
            finishProfile(profile, on: session)
            return
        }

        // Phase 2: no HFP input exists — narrow to A2DP and activate; with
        // A2DP allowed and headphones connected, activation routes to them
        // automatically, so only the post-activation route tells built-in
        // from A2DP.
        try session.setPreferredInput(nil)
        try session.setCategory(
            .playAndRecord,
            mode: .voiceChat,
            options: AudioSessionProfile.bluetoothA2DP.categoryOptions
        )
        try session.setActive(true)
        let profile = AudioSessionProfile.afterA2DPActivation(
            currentOutputs: session.currentRoute.outputs.map(\.portType)
        )
        finishProfile(profile, on: session)
    }

    /// Shared tail of both phases: record the profile, sync the speaker
    /// override, and log the decision with the resolved route so the next
    /// hardware run is attributable.
    private func finishProfile(
        _ profile: AudioSessionProfile,
        on session: AVAudioSession
    ) {
        currentProfile = profile
        syncSpeakerOverride(for: profile, on: session)
        let route = session.currentRoute
        HeartbeatLogger.shared.record(
            "session profile \(profile.logName) "
                + "inputs=\(AudioRouteFormatter.portTypes(route.inputs)) "
                + "outputs=\(AudioRouteFormatter.portTypes(route.outputs))"
        )
    }

    /// The on-demand replacement for `.defaultToSpeaker`: `.speaker` for the
    /// built-in profile, and — just as important — `.none` for the Bluetooth
    /// profiles, so a re-detection that lands on BT clears a speaker override
    /// left by an earlier built-in pass instead of stomping the headset.
    /// Failure is logged, not fatal: audio still flows out of the receiver.
    private func syncSpeakerOverride(
        for profile: AudioSessionProfile,
        on session: AVAudioSession
    ) {
        do {
            try session.overrideOutputAudioPort(
                profile.wantsSpeakerOverride ? .speaker : .none
            )
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

    /// Every change lands in heartbeat.log. Only a device appearing or
    /// disappearing re-runs the DETECTION SEQUENCE — a deliberate exception
    /// to "never re-setCategory mid-session". There is no cheap "would the
    /// profile change?" pre-check: knowing whether the new device is HFP
    /// requires the permissive phase-1 category first (a headset connecting
    /// mid-session is invisible until then — the original hardware bug), so
    /// the whole two-phase flow runs again. `.override` and `.categoryChange`
    /// never re-apply: those are the echoes of our own calls, and reacting to
    /// them would loop; `isApplyingProfile` additionally guards against
    /// re-entry from the notifications our own detection emits.
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
        guard isActive, !isApplyingProfile else { return }

        do {
            try detectAndApplyProfile(on: session)
        } catch {
            HeartbeatLogger.shared.record("route profile re-detect FAILED: \(error)")
        }
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
