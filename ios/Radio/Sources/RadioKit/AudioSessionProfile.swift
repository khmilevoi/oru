import AVFoundation
import Foundation

/// One Bluetooth/speaker profile per session (route-collapse fix, 2026-08-17;
/// two-phase detection fix, same day).
///
/// The previous configuration passed `.allowBluetooth`, `.allowBluetoothA2DP`
/// and `.defaultToSpeaker` together — three conflicting routing signals with
/// documented iOS 17/18 regressions where the route collapses to the speaker
/// mid-session, made worse by the always-hot mic (an active input path means a
/// BT mic requires HFP; A2DP is output-only). The recipe instead: pick exactly
/// ONE profile from what is actually connected, and use
/// `overrideOutputAudioPort(.speaker)` on demand instead of
/// `.defaultToSpeaker`.
///
/// DETECTION MUST PRECEDE NARROWING. iOS only lists Bluetooth ports in
/// `availableInputs` / `currentRoute` when the CURRENT category options allow
/// them, so inspecting the session before configuring it permissively is a
/// chicken-and-egg bug (confirmed on hardware: a connected headset stayed
/// invisible forever and the profile collapsed to `builtIn`). The selection is
/// therefore a two-step state machine, each step pure over port types so it is
/// unit-testable without AVAudioSession; `AlwaysHotBackgroundManager` owns
/// running it against the live session:
///
/// 1. Set the category permissively (`permissiveDetectionOptions`, which makes
///    HFP inputs appear), then feed `availableInputs` to
///    `afterPermissiveDetection` — an HFP input decides `.bluetoothHFP`
///    outright.
/// 2. Otherwise reconfigure with `[.allowBluetoothA2DP]`, activate (A2DP
///    headphones are routed to automatically on activation), and feed
///    `currentRoute.outputs` to `afterA2DPActivation` — Bluetooth output means
///    `.bluetoothA2DP`, anything else means `.builtIn` plus the speaker
///    override.
public enum AudioSessionProfile: Equatable {

    /// A Bluetooth HFP input exists: HFP both ways, pinned via
    /// `setPreferredInput` for the session.
    case bluetoothHFP

    /// No HFP input, but a Bluetooth output is routed: A2DP out, built-in mic.
    case bluetoothA2DP

    /// No Bluetooth anywhere: built-in route, speaker forced after activation.
    case builtIn

    /// Phase-1 category options: `.allowBluetooth` is what makes HFP inputs
    /// visible in `availableInputs` at all. Every detection pass starts here.
    public static let permissiveDetectionOptions: AVAudioSession.CategoryOptions =
        [.allowBluetooth]

    /// The option set the session ends up under once the profile is decided.
    /// `.defaultToSpeaker` is deliberately absent from every case. `.builtIn`
    /// keeps `[.allowBluetoothA2DP]` because it is reached WITHOUT a third
    /// `setCategory` — phase 2 narrows to A2DP, activates, and only then
    /// learns no Bluetooth output exists; the speaker override does the rest.
    public var categoryOptions: AVAudioSession.CategoryOptions {
        switch self {
        case .bluetoothHFP: return [.allowBluetooth]
        case .bluetoothA2DP, .builtIn: return [.allowBluetoothA2DP]
        }
    }

    /// Whether `overrideOutputAudioPort(.speaker)` must follow activation —
    /// the on-demand replacement for `.defaultToSpeaker`. Bluetooth profiles
    /// instead clear any prior override with `.none`.
    public var wantsSpeakerOverride: Bool {
        self == .builtIn
    }

    /// Stable short name for heartbeat.log grepping.
    public var logName: String {
        switch self {
        case .bluetoothHFP: return "hfp"
        case .bluetoothA2DP: return "a2dp"
        case .builtIn: return "builtIn"
        }
    }

    /// Phase 1. `availableInputs` MUST have been sampled while the category
    /// carried `permissiveDetectionOptions` — under narrower options iOS hides
    /// HFP inputs and this can only ever answer `nil`. An HFP input decides
    /// the whole detection; `nil` means "proceed to phase 2".
    public static func afterPermissiveDetection(
        availableInputs: [AVAudioSession.Port]
    ) -> AudioSessionProfile? {
        availableInputs.contains(.bluetoothHFP) ? .bluetoothHFP : nil
    }

    /// Phase 2. `currentOutputs` MUST have been sampled after activating under
    /// `[.allowBluetoothA2DP]` — activation is what routes to A2DP headphones,
    /// so an earlier sample would miss them. Any Bluetooth output keeps the
    /// A2DP profile; otherwise built-in (with the speaker override).
    /// `.bluetoothHFP` in the list is defensive: phase 1 should have caught
    /// it, but a headset landing there must still never be speaker-stomped.
    public static func afterA2DPActivation(
        currentOutputs: [AVAudioSession.Port]
    ) -> AudioSessionProfile {
        let bluetoothOutputs: [AVAudioSession.Port] = [
            .bluetoothA2DP, .bluetoothLE, .bluetoothHFP,
        ]
        if currentOutputs.contains(where: bluetoothOutputs.contains) {
            return .bluetoothA2DP
        }
        return .builtIn
    }
}

/// Compact, human-readable route strings for heartbeat.log and the spike panel.
public enum AudioRouteFormatter {

    /// "→ AirPods (HFP) / ← AirPods (HFP)" or "→ Speaker / ← iPhone mic".
    public static func compact(_ route: AVAudioSessionRouteDescription) -> String {
        let outs = route.outputs.map(label(for:)).joined(separator: "+")
        let ins = route.inputs.map(label(for:)).joined(separator: "+")
        return "→ \(outs.isEmpty ? "none" : outs) / ← \(ins.isEmpty ? "none" : ins)"
    }

    /// "in=MicrophoneBuiltIn out=Speaker" — port-type raw values, the stable
    /// vocabulary for grepping heartbeat.log.
    public static func portTypes(_ ports: [AVAudioSessionPortDescription]) -> String {
        ports.isEmpty ? "none" : ports.map(\.portType.rawValue).joined(separator: ",")
    }

    public static func name(of reason: AVAudioSession.RouteChangeReason) -> String {
        switch reason {
        case .unknown: return "unknown"
        case .newDeviceAvailable: return "newDeviceAvailable"
        case .oldDeviceUnavailable: return "oldDeviceUnavailable"
        case .categoryChange: return "categoryChange"
        case .override: return "override"
        case .wakeFromSleep: return "wakeFromSleep"
        case .noSuitableRouteForCategory: return "noSuitableRouteForCategory"
        case .routeConfigurationChange: return "routeConfigurationChange"
        @unknown default: return "reason(\(reason.rawValue))"
        }
    }

    private static func label(for port: AVAudioSessionPortDescription) -> String {
        switch port.portType {
        case .bluetoothHFP: return "\(port.portName) (HFP)"
        case .bluetoothA2DP: return "\(port.portName) (A2DP)"
        case .bluetoothLE: return "\(port.portName) (LE)"
        case .builtInSpeaker: return "Speaker"
        case .builtInReceiver: return "Receiver"
        case .builtInMic: return "iPhone mic"
        default: return port.portName
        }
    }
}
