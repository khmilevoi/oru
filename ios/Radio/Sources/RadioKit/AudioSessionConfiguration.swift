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

    public static func of(_ profile: ModePolicy.Profile) -> AudioSessionConfiguration {
        switch profile {
        case .voice: return voice
        case .media: return media
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
    /// equality would re-apply forever. The two configurations always differ in
    /// `mode`, so mode equality alone already separates them; the superset test
    /// is there to catch an option somebody else cleared.
    public func matches(
        category: AVAudioSession.Category,
        mode: AVAudioSession.Mode,
        options: AVAudioSession.CategoryOptions
    ) -> Bool {
        category == self.category
            && mode == self.mode
            && options.isSuperset(of: self.options)
    }

    /// §5's on-demand speaker, and the wired-headphones fix.
    ///
    /// The rule is a pure function of the CURRENT OUTPUTS and nothing else:
    /// `.speaker` only when the outputs are solely `builtInReceiver`, `.none`
    /// whenever any other output is present. It deliberately does not consult
    /// `AudioRouteClassifier` — the old code decided the override from a
    /// collapsed classification, which is precisely how wired headphones came
    /// to be overridden to the loudspeaker.
    public static func speakerOverride(
        forOutputs outputs: [AudioPort]
    ) -> AVAudioSession.PortOverride {
        guard !outputs.isEmpty else { return .none }
        return outputs.allSatisfy { $0.type == .builtInReceiver } ? .speaker : .none
    }
}
