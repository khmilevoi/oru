import AVFoundation
import Foundation

/// §5's two static session configurations, applied whole and diff-only.
///
/// This replaces the two-phase HFP/A2DP detection state machine (§11). That
/// machine existed because the old design had to *discover* which Bluetooth
/// profile to narrow to; this design never narrows. It states the two option
/// sets up front and lets iOS route — "iOS routing is last-in wins and
/// automatic once category options are right" (§4). There is nothing left to
/// detect, so there is no detection.
public struct AudioSessionConfiguration: Equatable {

    public let category: AVAudioSession.Category
    public let mode: AVAudioSession.Mode
    public let options: AVAudioSession.CategoryOptions
    /// Stable short name for heartbeat.log grepping.
    public let logName: String

    /// The BT headset's microphone is ready: HFP both directions, system-picked.
    public static let voice = AudioSessionConfiguration(
        category: .playAndRecord,
        mode: .voiceChat,
        options: [.allowBluetooth, .mixWithOthers],
        logName: "voice"
    )

    /// The headset stays on A2DP: high-quality playback out, built-in mic in.
    /// `.voiceChat` is deliberately absent — §4: it implicitly enables
    /// `.allowBluetooth` (HFP), which is exactly what this profile must not do.
    public static let media = AudioSessionConfiguration(
        category: .playAndRecord,
        mode: .default,
        options: [.allowBluetoothA2DP, .mixWithOthers],
        logName: "media"
    )

    /// MEDIA for as long as an incoming burst is playing.
    ///
    /// MEDIA mixes, which is what lets the user's music keep playing at full
    /// quality — and also what makes a radio burst arriving over it hard to
    /// hear. `.duckOthers` turns the music down for the burst and the system
    /// turns it back up when the option goes away again.
    ///
    /// It is a second configuration rather than an option on `media` because
    /// this session is always hot: a static `.duckOthers` would duck the user's
    /// music for the entire run, not for the burst.
    public static let mediaDucking = AudioSessionConfiguration(
        category: .playAndRecord,
        mode: .default,
        options: [.allowBluetoothA2DP, .mixWithOthers, .duckOthers],
        logName: "media+duck"
    )

    /// Options this file switches on and off at runtime. `matches` has to
    /// demand their ABSENCE as explicitly as it demands the rest's presence:
    /// the ducking options are a superset of MEDIA's, so a superset test alone
    /// would report a leftover duck as "already applied" and no un-duck would
    /// ever reach the session.
    private static let dynamicOptions: AVAudioSession.CategoryOptions = [.duckOthers]

    /// `ducking` only means anything on MEDIA: on VOICE the headset is already
    /// on HFP and the other app is out of the way by construction.
    public static func of(
        _ profile: ModePolicy.Profile,
        ducking: Bool = false
    ) -> AudioSessionConfiguration {
        switch profile {
        case .voice: return voice
        case .media: return ducking ? mediaDucking : media
        }
    }

    /// §5's "diff-only: skip if already applied", and the replacement for the
    /// deleted `isApplyingProfile` recursion guard.
    ///
    /// Every handler is re-posted onto the engine queue now, so a flag set
    /// around a `setCategory` call would already be clear by the time the
    /// notification it caused is processed — the flag would be a lie. This
    /// comparison breaks the loop instead: after our own apply, the live
    /// configuration satisfies the target, so the `.categoryChange` it emits
    /// re-applies nothing.
    ///
    /// Options are compared with a superset test, not equality: iOS adds
    /// implied options (`.voiceChat` implies `.allowBluetooth`) and demanding
    /// equality would re-apply forever. The two profiles always differ in
    /// `mode`, so mode equality alone already separates them; the superset test
    /// is there to catch an option somebody else cleared.
    ///
    /// The exception is `dynamicOptions`: the ones this file itself adds and
    /// removes at runtime. MEDIA and MEDIA+duck share a category and a mode and
    /// differ only by `.duckOthers`, so the superset test alone would call a
    /// still-ducking session "already MEDIA" and the duck would never end.
    public func matches(
        category: AVAudioSession.Category,
        mode: AVAudioSession.Mode,
        options: AVAudioSession.CategoryOptions
    ) -> Bool {
        category == self.category
            && mode == self.mode
            && options.isSuperset(of: self.options)
            && options.isDisjoint(with: Self.dynamicOptions.subtracting(self.options))
    }

    /// §5's on-demand speaker, and the wired-headphones fix.
    ///
    /// The rule is a pure function of the CURRENT OUTPUTS and nothing else:
    /// `.speaker` when the outputs are solely built-in — `builtInReceiver` or
    /// `builtInSpeaker` — `.none` whenever any external output is present, or
    /// the route is empty. It deliberately does not consult
    /// `AudioRouteClassifier` — the old code decided the override from a
    /// collapsed classification, which is precisely how wired headphones came
    /// to be overridden to the loudspeaker.
    ///
    /// `builtInSpeaker` counts as built-in, not just `builtInReceiver`, because
    /// applying this very answer via `overrideOutputAudioPort(.speaker)` moves
    /// `currentRoute.outputs` from `[builtInReceiver]` to `[builtInSpeaker]`.
    /// This function is re-evaluated against that consequence on every
    /// `.categoryChange` and app-foreground reaction, so if `builtInSpeaker`
    /// answered `.none` the override would oscillate on every re-evaluation:
    /// applied, then immediately cleared. Treating it as built-in makes the
    /// answer idempotent — the override, once in force for an all-built-in
    /// route, stays in force.
    public static func speakerOverride(
        forOutputs outputs: [AudioPort]
    ) -> AVAudioSession.PortOverride {
        guard !outputs.isEmpty else { return .none }
        return outputs.allSatisfy { $0.type == .builtInReceiver || $0.type == .builtInSpeaker }
            ? .speaker
            : .none
    }
}
