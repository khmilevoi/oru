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
        /// nil when nothing is pending. Re-read after every call.
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
        public static let voiceLinkLingerMs: Int64 = 15_000
    }

    // MARK: - State

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
    public func setRouteRequiresVoiceLink(_ requires: Bool, nowMs: Int64) -> Decision {
        step(nowMs) {
            self.routeRequiresVoiceLink = requires
            return []
        }
    }

    public func pttPressed(nowMs: Int64) -> Decision {
        step(nowMs) { [] }
    }

    public func pttReleased(nowMs: Int64) -> Decision {
        step(nowMs) { [] }
    }

    public func voiceLinkEstablished(nowMs: Int64) -> Decision {
        step(nowMs) { [] }
    }

    public func voiceLinkFailed(nowMs: Int64) -> Decision {
        step(nowMs) { [] }
    }

    /// Called when the previous decision's `nextWakeupMs` says to.
    public func tick(nowMs: Int64) -> Decision {
        step(nowMs) { [] }
    }

    // MARK: - Core

    /// Every input runs the same pipeline: age the timers that do not produce actions,
    /// apply the input, then let the profile catch up with what the policy wants.
    private func step(_ nowMs: Int64, _ input: () -> [Action]) -> Decision {
        let actions = input()
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

    private var requestedProfile: Profile {
        appliedProfile
    }

    private func applyBaseIfAllowed(_ nowMs: Int64) {
        let base = baseProfile
        guard base != appliedProfile else { return }
        appliedProfile = base
    }

    private func nextWakeupMs(_ nowMs: Int64) -> Int64? {
        nil
    }
}
