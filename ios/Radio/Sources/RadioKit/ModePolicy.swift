import Foundation

/// §7 of docs/superpowers/specs/2026-08-18-seamless-headphone-audio-design.md: the
/// shared VOICE/MEDIA mode policy.
///
/// Pure and I/O-free. It takes events plus a caller-supplied monotonic timestamp and
/// returns the profile the platform should have applied, the actions it should perform
/// and the moment it must call `tick` again. It owns no timer, no queue and no audio
/// object: applying a profile, raising SCO, playing the tone and starting capture are
/// the platform's jobs (§5 iOS, §6 Android).
///
/// `android/app/src/main/java/com/oru/radio/ModePolicy.kt` is the line-for-line Kotlin
/// twin of this file, and both test files assert the same table (§10 "Shared"). A change
/// here without the same change there forks the contract; wave-2 platform work reports a
/// needed change instead of patching one side.
///
/// Time is absolute monotonic milliseconds, never a wall clock: a system time change
/// must not move a dwell deadline.
public final class ModePolicy {

    // MARK: - Vocabulary

    /// The profile the platform should have applied. §5 and §6 define what applying it
    /// means on each platform.
    public enum Profile: Equatable {
        case voice
        case media
    }

    /// The §8 `audioMode` setting. `auto` runs this policy; the other two pin it.
    public enum AudioMode: Equatable {
        case auto
        case voice
        case media
    }

    /// Which microphone capture should use for this transmission.
    public enum MicSource: Equatable {
        /// The microphone that belongs to the current route (the headset's, over a
        /// raised voice link).
        case routeDefault
        /// §7's fallback after a raise that timed out or failed: the phone's own mic.
        case phoneFallback
    }

    /// On iOS, `raiseVoiceLink`/`dropVoiceLink` and a `Decision.profile` change are the
    /// same `setCategory` session-configuration call: apply the profile diff first and
    /// treat the raise/drop as satisfied by it, rather than performing the work twice.
    public enum Action: Equatable {
        /// Bring the headset voice link up now — Android `setCommunicationDevice`/SCO,
        /// iOS the VOICE session configuration — and answer with `voiceLinkEstablished`
        /// or `voiceLinkFailed`. Exempt from the 10 s rate limit (§7).
        case raiseVoiceLink
        /// Undo a raise: clear the communication device / re-apply the MEDIA
        /// configuration, so the headset returns to A2DP and music resumes.
        case dropVoiceLink
        /// The talk-permit tone (D2). Always immediately followed by `startCapture`:
        /// press → tone → talk, in every mode.
        case playGrantTone
        case startCapture(MicSource)
    }

    public struct Decision: Equatable {
        /// The profile the platform should have applied after this event. Diff-only:
        /// the platform skips re-applying an unchanged profile.
        public let profile: Profile
        /// Side effects to perform, in order.
        public let actions: [Action]
        /// Absolute monotonic millisecond at which the platform must call `tick`, or
        /// nil when nothing is pending. Re-read after every call: nil obliges the caller
        /// to cancel any outstanding timer, not merely to skip scheduling a new one.
        public let nextWakeupMs: Int64?
    }

    /// §7's five constants. `ModePolicy.kt` carries the same five values.
    ///
    /// They live here rather than in `RadioConfig` because these two files are the one
    /// place the two platforms are guaranteed to agree; a value duplicated into two
    /// per-platform config files is a value that can drift.
    public enum Constants {
        /// VOICE → MEDIA once other audio has been playing this long.
        public static let otherAudioToMediaMs: Int64 = 2_000
        /// MEDIA → VOICE once other audio has been silent this long. Asymmetric on
        /// purpose: protect the user's music fast, never flap between tracks.
        public static let otherAudioToVoiceMs: Int64 = 30_000
        /// At most one policy-driven VOICE↔MEDIA switch per this window.
        public static let switchRateLimitMs: Int64 = 10_000
        /// How long a PTT-driven raise waits for the headset mic path before falling
        /// back to the phone mic for this transmission.
        public static let voiceLinkGrantTimeoutMs: Int64 = 4_000
        /// How long a raised link is held after PTT release, so the rest of the
        /// conversation is instant.
        public static let voiceLinkLingerMs: Int64 = 8_000
    }

    // MARK: - State

    /// Where the PTT half of §7 stands.
    private enum PttState {
        case idle
        /// A raise was requested; `deadlineMs` is when §7's 4 s grant timeout fires.
        case awaitingLink(deadlineMs: Int64)
        /// Capture is running. `linkRaised` is false when this transmission fell back to
        /// the phone mic, which is why it has nothing to linger on afterwards.
        case talking(linkRaised: Bool)
        /// Released with the link up: held until `untilMs` so the rest of the
        /// conversation is instant.
        case lingering(untilMs: Int64)
        /// The linger expired while the radio was busy; the link is held until idle.
        case dropPending
    }

    private var audioMode: AudioMode = .auto
    private var routeRequiresVoiceLink = false
    private var radioActive = false
    private var otherAudioActive = false
    /// When the current value of `otherAudioActive` began. nil until the first change.
    private var otherAudioSinceMs: Int64?
    /// What the automatic policy wants. The other-audio dwell moves it; the pins ignore it.
    private var desiredAutoProfile: Profile = .voice
    /// What the platform has been told to apply.
    private var appliedProfile: Profile = .voice

    /// When the last policy-driven switch was applied, for the 10 s rate limit. The
    /// PTT raise/drop of §7 neither consults nor stamps it.
    private var lastSwitchMs: Int64?

    private var pttState: PttState = .idle

    public init() {}

    // MARK: - Inputs

    public func setAudioMode(_ mode: AudioMode, nowMs: Int64) -> Decision {
        step(nowMs) {
            self.audioMode = mode
            return []
        }
    }

    /// Raw, undebounced: the 2 s / 30 s dwell of §7 lives in this class, not in the
    /// detector, so both platforms debounce identically.
    public func setOtherAudioActive(_ active: Bool, nowMs: Int64) -> Decision {
        step(nowMs) {
            guard active != self.otherAudioActive else { return [] }
            self.otherAudioActive = active
            self.otherAudioSinceMs = nowMs
            return []
        }
    }

    /// The radio is receiving or transmitting. Fed by the engine, not derived from the
    /// button: a transmission also ends on the 120 s safety cap.
    public func setRadioActive(_ active: Bool, nowMs: Int64) -> Decision {
        step(nowMs) {
            self.radioActive = active
            return []
        }
    }

    /// True when reaching the accessory's microphone would need a BT-Classic voice link
    /// raised. False for speaker, wired, USB and anything else with no profile conflict
    /// — §7's "the policy is inert there".
    ///
    /// If a raise is in flight when the route it targeted disappears, the caller must
    /// report `voiceLinkFailed` — otherwise the policy will wait out the full 4 s grant
    /// timeout before falling back to the phone mic.
    public func setRouteRequiresVoiceLink(_ requires: Bool, nowMs: Int64) -> Decision {
        step(nowMs) {
            self.routeRequiresVoiceLink = requires
            return []
        }
    }

    /// Every `pttPressed` must be answered by exactly one `pttReleased` — the policy has
    /// no watchdog on an unreleased press. A dropped release (a BLE, HID or media-button
    /// PTT driver disconnecting mid-press) wedges the policy for the rest of the session:
    /// no mode switch ever applies again and a raised link is never dropped.
    public func pttPressed(nowMs: Int64) -> Decision {
        step(nowMs) { self.press(nowMs) }
    }

    public func pttReleased(nowMs: Int64) -> Decision {
        step(nowMs) { self.release(nowMs) }
    }

    /// The headset mic path is confirmed (SCO connected / the comm device applied).
    public func voiceLinkEstablished(nowMs: Int64) -> Decision {
        step(nowMs) {
            guard case .awaitingLink = self.pttState else { return [] }
            self.pttState = .talking(linkRaised: true)
            return [.playGrantTone, .startCapture(.routeDefault)]
        }
    }

    /// The raise failed outright (`setCommunicationDevice` returned false, an SCO error).
    /// Same answer as the 4 s timeout, without waiting for it.
    public func voiceLinkFailed(nowMs: Int64) -> Decision {
        step(nowMs) {
            guard case .awaitingLink = self.pttState else { return [] }
            return self.abandonRaise()
        }
    }

    /// Called when the previous decision's `nextWakeupMs` says to.
    public func tick(nowMs: Int64) -> Decision {
        step(nowMs) { [] }
    }

    // MARK: - Core

    /// Every input runs the same pipeline: age the timers that do not produce actions,
    /// apply the input, then let the profile catch up with what the policy wants.
    private func step(_ nowMs: Int64, _ input: () -> [Action]) -> Decision {
        updateDwell(nowMs)
        var actions = input()
        actions += settleLink(nowMs)
        applyBaseIfAllowed(nowMs)
        return Decision(
            profile: requestedProfile,
            actions: actions,
            nextWakeupMs: nextWakeupMs(nowMs)
        )
    }

    /// The profile the policy wants, before any gate: a pin wins outright, and `auto`
    /// holds VOICE on routes with no profile conflict.
    private var baseProfile: Profile {
        switch audioMode {
        case .voice:
            return .voice
        case .media:
            return .media
        case .auto:
            return routeRequiresVoiceLink ? desiredAutoProfile : .voice
        }
    }

    /// True while this policy is holding a headset voice link up on the platform.
    private var holdsVoiceLink: Bool {
        switch pttState {
        case .idle:
            return false
        case .talking(let linkRaised):
            return linkRaised
        case .awaitingLink, .lingering, .dropPending:
            return true
        }
    }

    private var requestedProfile: Profile {
        holdsVoiceLink ? .voice : appliedProfile
    }

    /// §7: "press → tone → talk", in every mode. The tone is immediate wherever the mic
    /// is already live — in VOICE, on any route with no profile conflict, and inside the
    /// linger window where the link is still up — and waits for the raise otherwise.
    private func press(_ nowMs: Int64) -> [Action] {
        switch pttState {
        case .lingering, .dropPending:
            pttState = .talking(linkRaised: true)
            return [.playGrantTone, .startCapture(.routeDefault)]
        case .awaitingLink, .talking:
            return []
        case .idle:
            if appliedProfile == .voice || !routeRequiresVoiceLink {
                pttState = .talking(linkRaised: false)
                return [.playGrantTone, .startCapture(.routeDefault)]
            }
            pttState = .awaitingLink(
                deadlineMs: nowMs + Constants.voiceLinkGrantTimeoutMs
            )
            return [.raiseVoiceLink]
        }
    }

    private func release(_ nowMs: Int64) -> [Action] {
        switch pttState {
        case .talking(let linkRaised):
            pttState = linkRaised
                ? .lingering(untilMs: nowMs + Constants.voiceLinkLingerMs)
                : .idle
            return []
        case .awaitingLink:
            // Released before the mic ever went live: no tone, nothing to capture.
            return abandonRaise(startCapture: false)
        case .idle, .lingering, .dropPending:
            return []
        }
    }

    /// Gives up a raise that timed out or failed (§7's 4 s timeout, D2's SCO failure).
    /// The pending raise is undone *before* the tone, so capture starts with the base
    /// profile already restored — D2 rejects swapping the mic mid-transmission, so a link
    /// that arrives late is not used for this transmission. Restoring the base profile
    /// here is part of the raise/drop mechanism and so is exempt from the rate limit: it
    /// neither consults nor stamps `lastSwitchMs`.
    ///
    /// When the base profile is already VOICE this emits `startCapture(.phoneFallback)`
    /// with no accompanying `dropVoiceLink` — there is nothing to undo on the platform's
    /// session, since the link never came up. That `startCapture` still implies the
    /// pending raise is void: the platform must treat it as cancelled even though no
    /// `dropVoiceLink` accompanies it.
    private func abandonRaise(startCapture: Bool = true) -> [Action] {
        pttState = startCapture ? .talking(linkRaised: false) : .idle
        let base = baseProfile
        appliedProfile = base
        var actions: [Action] = base == .voice ? [] : [.dropVoiceLink]
        if startCapture {
            actions.append(.playGrantTone)
            actions.append(.startCapture(.phoneFallback))
        }
        return actions
    }

    /// Fires the PTT deadlines that have come due. Runs after the input, so an input that
    /// resolves a deadline (a link arriving at 4.1 s, a release, a press inside the
    /// linger) wins over it.
    private func settleLink(_ nowMs: Int64) -> [Action] {
        switch pttState {
        case .awaitingLink(let deadlineMs) where nowMs >= deadlineMs:
            return abandonRaise()
        case .lingering(let untilMs) where nowMs >= untilMs:
            pttState = .dropPending
            return settleDrop()
        case .dropPending:
            return settleDrop()
        default:
            return []
        }
    }

    /// Lets the raised link go. §7 exempts the raise/drop from the 10 s rate limit by
    /// name — so this neither consults nor stamps `lastSwitchMs` — but not from the
    /// "switches never run during receive or transmit" rule in the same bullet, so an
    /// expired linger holds the link rather than glitching an incoming transmission.
    /// No `dropVoiceLink` when the policy wants VOICE by now: the link stays up as the
    /// profile, not as a leftover.
    private func settleDrop() -> [Action] {
        guard !radioActive else { return [] }
        pttState = .idle
        let base = baseProfile
        appliedProfile = base
        return base == .voice ? [] : [.dropVoiceLink]
    }

    /// §7's two gates on a VOICE↔MEDIA switch: it never runs during receive or transmit
    /// (it queues for idle), and at most one runs per `switchRateLimitMs`. A pin change
    /// is a switch like any other — applying one mid-transmission would break the same
    /// audio a policy switch would.
    private func applyBaseIfAllowed(_ nowMs: Int64) {
        // While a press is in flight the profile belongs to the PTT machine; a policy
        // switch would fight it.
        guard case .idle = pttState else { return }
        let base = baseProfile
        guard base != appliedProfile, !radioActive else { return }
        if let last = lastSwitchMs, nowMs - last < Constants.switchRateLimitMs { return }
        appliedProfile = base
        lastSwitchMs = nowMs
    }

    /// §7's asymmetric hysteresis. The dwell latches what the automatic policy *wants*;
    /// the gates below decide when the applied profile catches up ("switch at the next
    /// radio-idle moment"). It keeps running on routes with no voice link, so a headset
    /// connecting into already-playing music does not restart the 2 s.
    private func updateDwell(_ nowMs: Int64) {
        guard let since = otherAudioSinceMs else { return }
        if otherAudioActive {
            if nowMs - since >= Constants.otherAudioToMediaMs {
                desiredAutoProfile = .media
            }
        } else if nowMs - since >= Constants.otherAudioToVoiceMs {
            desiredAutoProfile = .voice
        }
    }

    /// The earliest moment at which a `tick` could change something. `updateDwell` has
    /// already run, so a dwell deadline is only reported while it is still in the future.
    private func nextWakeupMs(_ nowMs: Int64) -> Int64? {
        var deadlines: [Int64] = []
        if let since = otherAudioSinceMs {
            if otherAudioActive, desiredAutoProfile != .media {
                deadlines.append(since + Constants.otherAudioToMediaMs)
            }
            if !otherAudioActive, desiredAutoProfile != .voice {
                deadlines.append(since + Constants.otherAudioToVoiceMs)
            }
        }
        switch pttState {
        case .awaitingLink(let deadlineMs):
            deadlines.append(deadlineMs)
        case .lingering(let untilMs):
            deadlines.append(untilMs)
        case .idle, .talking, .dropPending:
            // `dropPending` waits on the radio going idle, which is an input.
            break
        }
        // A switch the rate limit is holding back will need a tick when the window
        // closes. One the *radio* is holding back does not: the radio going idle is an
        // input, and it runs the gate itself.
        if case .idle = pttState, baseProfile != appliedProfile, !radioActive,
           let last = lastSwitchMs, nowMs - last < Constants.switchRateLimitMs {
            deadlines.append(last + Constants.switchRateLimitMs)
        }
        return deadlines.min()
    }
}
