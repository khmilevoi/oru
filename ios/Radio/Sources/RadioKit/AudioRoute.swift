import AVFoundation
import Foundation

/// One port of the current route, reduced to the two things every §5 decision
/// needs. `AVAudioSessionPortDescription` has no public initialiser, so nothing
/// pure can be tested against it: every decision in this file is a function of
/// `[AudioPort]` instead, and `AudioPort.ports(from:)` is the whole impure
/// boundary between AVFoundation and the decisions.
public struct AudioPort: Equatable {
    public let type: AVAudioSession.Port
    public let name: String

    public init(type: AVAudioSession.Port, name: String = "") {
        self.type = type
        self.name = name
    }

    public static func ports(from descriptions: [AVAudioSessionPortDescription]) -> [AudioPort] {
        descriptions.map { AudioPort(type: $0.portType, name: $0.portName) }
    }
}

/// §8's `audioRoute`, as RadioKit's own value. `mode` is the *effective*
/// profile the engine is running, never the user's `audioMode` pin — `auto` is
/// not a profile.
public struct AudioRoute: Equatable {

    public enum Kind: String {
        case speaker
        case wired
        case bluetooth
        case usb
    }

    public enum Mode: String {
        case voice
        case media
    }

    public var kind: Kind
    public var label: String?
    public var mode: Mode

    public init(kind: Kind = .speaker, label: String? = nil, mode: Mode = .voice) {
        self.kind = kind
        self.label = label
        self.mode = mode
    }

    /// `label` is omitted rather than `NSNull` when absent — §8 makes it
    /// optional, and this is the rule `pttButton.name` already follows.
    public var asDictionary: [String: Any] {
        var dictionary: [String: Any] = ["kind": kind.rawValue, "mode": mode.rawValue]
        if let label {
            dictionary["label"] = label
        }
        return dictionary
    }
}

extension AudioRoute.Mode {
    /// The mapping lives here and not on `ModePolicy.Profile`: `ModePolicy` is
    /// merged P1 and this plan never edits it.
    public init(_ profile: ModePolicy.Profile) {
        switch profile {
        case .voice: self = .voice
        case .media: self = .media
        }
    }
}

/// What the session reports up to the engine on every route change: §8's two
/// display fields plus the two §7 predicates. One value, one delegate call, no
/// chance of the four drifting apart.
public struct AudioRouteSnapshot: Equatable {
    public let kind: AudioRoute.Kind
    public let label: String?
    /// §7's `setRouteRequiresVoiceLink`: reaching this accessory's microphone
    /// would need a BT-Classic voice link raised.
    public let requiresVoiceLink: Bool
    /// The headset microphone is live on this route right now — §7's "the
    /// headset mic path is confirmed", which is what releases the grant tone.
    public let providesVoiceLink: Bool

    public init(
        kind: AudioRoute.Kind,
        label: String?,
        requiresVoiceLink: Bool,
        providesVoiceLink: Bool
    ) {
        self.kind = kind
        self.label = label
        self.requiresVoiceLink = requiresVoiceLink
        self.providesVoiceLink = providesVoiceLink
    }
}

/// §5's route decisions. Every one is a pure function of port types and names.
///
/// This deliberately does NOT decide the speaker override — that lives in
/// `AudioSessionConfiguration` and asks a different question ("are the outputs
/// solely the receiver?"). Keeping the two apart is the wired-headphones fix:
/// the override never consults a classification, which is exactly how wired
/// headphones came to be speaker-stomped.
public enum AudioRouteClassifier {

    /// §4: BT Classic cannot carry HFP and A2DP at once, so every one of these
    /// needs a voice link raised to reach its microphone. `.carAudio` is here
    /// because a car kit is a hands-free accessory (see the plan's reading 4);
    /// `.bluetoothLE` is here because §12 defers the LE fast path, and the
    /// conservative path is correct, only not optimal.
    static let bluetoothTypes: Set<AVAudioSession.Port> = [
        .bluetoothA2DP, .bluetoothHFP, .bluetoothLE, .carAudio
    ]
    static let usbTypes: Set<AVAudioSession.Port> = [.usbAudio]
    static let wiredTypes: Set<AVAudioSession.Port> = [.headphones, .lineOut]

    /// Priority: bluetooth > usb > wired > speaker. A route carrying two
    /// outputs (which happens while Bluetooth negotiates) must report the
    /// accessory, not the fallback.
    public static func kind(forOutputs outputs: [AudioPort]) -> AudioRoute.Kind {
        if outputs.contains(where: { bluetoothTypes.contains($0.type) }) { return .bluetooth }
        if outputs.contains(where: { usbTypes.contains($0.type) }) { return .usb }
        if outputs.contains(where: { wiredTypes.contains($0.type) }) { return .wired }
        return .speaker
    }

    /// §8: the accessory's own name, for Bluetooth routes only, absent rather
    /// than empty.
    public static func label(forOutputs outputs: [AudioPort]) -> String? {
        guard let port = outputs.first(where: { bluetoothTypes.contains($0.type) }) else {
            return nil
        }
        let name = port.name.trimmingCharacters(in: .whitespacesAndNewlines)
        return name.isEmpty ? nil : name
    }

    /// §7's predicate, defined as exactly "the route is a Bluetooth one" so the
    /// two can never disagree.
    public static func requiresVoiceLink(outputs: [AudioPort]) -> Bool {
        kind(forOutputs: outputs) == .bluetooth
    }

    /// HFP is the only path to a BT-Classic headset microphone (§4), so an HFP
    /// input is the proof the mic path is live.
    public static func providesVoiceLink(inputs: [AudioPort]) -> Bool {
        inputs.contains { $0.type == .bluetoothHFP }
    }

    public static func snapshot(outputs: [AudioPort], inputs: [AudioPort]) -> AudioRouteSnapshot {
        AudioRouteSnapshot(
            kind: kind(forOutputs: outputs),
            label: label(forOutputs: outputs),
            requiresVoiceLink: requiresVoiceLink(outputs: outputs),
            providesVoiceLink: providesVoiceLink(inputs: inputs)
        )
    }
}

/// Compact, human-readable route strings for heartbeat.log and the spike panel.
/// Moved here unchanged when the old two-phase-detection file was deleted
/// (§11: "the route formatter stays").
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
