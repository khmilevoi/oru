import Foundation

/// The PTT button half of `RadioState` (spec section 6.1).
public struct PttButtonState: Equatable {
    public var configured: Bool
    public var connected: Bool
    public var name: String?

    public init(configured: Bool = false, connected: Bool = false, name: String? = nil) {
        self.configured = configured
        self.connected = connected
        self.name = name
    }

    public var asDictionary: [String: Any] {
        var dictionary: [String: Any] = [
            "configured": configured,
            "connected": connected
        ]
        if let name {
            dictionary["name"] = name
        }
        return dictionary
    }
}

/// One device seen during a pairing scan (amended spec section 6.1).
public struct PttCandidate: Equatable {
    public let deviceId: String
    public let name: String
    public let rssi: Int

    public init(deviceId: String, name: String, rssi: Int) {
        self.deviceId = deviceId
        self.name = name
        self.rssi = rssi
    }

    public var asDictionary: [String: Any] {
        ["deviceId": deviceId, "name": name, "rssi": rssi]
    }
}

/// A pairing session in progress. Present in `RadioState` only while one is
/// running, so the four main-screen states never see it.
public struct PttPairingState: Equatable {
    public enum Phase: String {
        case scanning
        case learning
        case saved
    }

    public var phase: Phase
    public var candidates: [PttCandidate]

    public init(phase: Phase, candidates: [PttCandidate] = []) {
        self.phase = phase
        self.candidates = candidates
    }

    public var asDictionary: [String: Any] {
        [
            "phase": phase.rawValue,
            "candidates": candidates.map(\.asDictionary)
        ]
    }
}

/// The snapshot the engine hands to the bridge; shape is the amended spec
/// section 6.1 verbatim.
public struct RadioState: Equatable {
    public enum Status: String {
        case starting
        case ready
        case error
    }

    public var status: Status
    public var nearbyCount: Int
    public var transmitting: Bool
    public var receiving: Bool
    public var pttButton: PttButtonState
    public var pttPairing: PttPairingState?

    public init(
        status: Status = .starting,
        nearbyCount: Int = 0,
        transmitting: Bool = false,
        receiving: Bool = false,
        pttButton: PttButtonState = PttButtonState(),
        pttPairing: PttPairingState? = nil
    ) {
        self.status = status
        self.nearbyCount = nearbyCount
        self.transmitting = transmitting
        self.receiving = receiving
        self.pttButton = pttButton
        self.pttPairing = pttPairing
    }

    public var asDictionary: [String: Any] {
        var dictionary: [String: Any] = [
            "status": status.rawValue,
            "nearbyCount": nearbyCount,
            "transmitting": transmitting,
            "receiving": receiving,
            "pttButton": pttButton.asDictionary
        ]
        if let pttPairing {
            dictionary["pttPairing"] = pttPairing.asDictionary
        }
        return dictionary
    }
}

/// Engine failures (spec section 13). Recoverable conditions are state, not errors.
public struct RadioError: Error, Equatable {
    public let code: String
    public let message: String

    public init(code: String, message: String) {
        self.code = code
        self.message = message
    }

    public static func startFailed(_ message: String) -> RadioError {
        RadioError(code: "start_failed", message: message)
    }

    public static func transportFailed(_ message: String) -> RadioError {
        RadioError(code: "transport_failed", message: message)
    }

    public static func audioFailed(_ message: String) -> RadioError {
        RadioError(code: "audio_failed", message: message)
    }

    public static func backgroundFailed(_ message: String) -> RadioError {
        RadioError(code: "background_failed", message: message)
    }

    public static func pttFailed(_ message: String) -> RadioError {
        RadioError(code: "ptt_failed", message: message)
    }

    public static func pairingFailed(_ message: String) -> RadioError {
        RadioError(code: "pairing_failed", message: message)
    }
}

/// What observers receive (spec section 6.1 `RadioNativeEvent`).
public enum RadioEvent {
    case stateChanged(RadioState)
    case error(RadioError)
}
