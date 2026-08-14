import Foundation
import os

/// Phase 0 lives here (spec section 15). No UI: the engine starts with the app,
/// the PushToTalk channel supplies a system talk button on the lock screen, and
/// every state change lands in the device log as one `[spike]` line.
public enum RadioSpike {

    private static let log = Logger(
        subsystem: RadioConfig.Logging.subsystem,
        category: "spike"
    )
    private static var isBootstrapped = false

    public static func bootstrap() {
        guard !isBootstrapped else { return }
        isBootstrapped = true

        let engine = RadioAssembly.shared.engine
        engine.addObserver("spike") { event in
            switch event {
            case let .stateChanged(state):
                log.notice(
                    """
                    [spike] state status=\(state.status.rawValue, privacy: .public) \
                    nearby=\(state.nearbyCount, privacy: .public) \
                    tx=\(state.transmitting, privacy: .public) \
                    rx=\(state.receiving, privacy: .public) \
                    button=\(state.pttButton.configured, privacy: .public)/\
                    \(state.pttButton.connected, privacy: .public)
                    """
                )
                if let pairing = state.pttPairing {
                    let candidates = pairing.candidates
                        .map { "\($0.deviceId) \($0.name) \($0.rssi)" }
                        .joined(separator: " | ")
                    log.notice(
                        """
                        [spike] pairing phase=\(pairing.phase.rawValue, privacy: .public) \
                        candidates=[\(candidates, privacy: .public)]
                        """
                    )
                }
            case let .error(error):
                log.error(
                    """
                    [spike] error code=\(error.code, privacy: .public) \
                    message=\(error.message, privacy: .public)
                    """
                )
            }
        }

        engine.startRadio()
        log.notice("[spike] radio started")
    }

    public static func startTransmit() {
        log.notice("[spike] startTransmit")
        RadioAssembly.shared.engine.startTransmit()
    }

    public static func stopTransmit() {
        log.notice("[spike] stopTransmit")
        RadioAssembly.shared.engine.stopTransmit()
    }

    /// The user's pick. Phase 0 has no UI, so either call this with a deviceId
    /// read from the `[spike] pairing` log line, or wait out
    /// `RadioConfig.Ptt.autoSelectFallback` and let the strongest signal win.
    public static func selectPttCandidate(_ deviceId: String) {
        log.notice("[spike] selectPttCandidate \(deviceId, privacy: .public)")
        RadioAssembly.shared.engine.selectPttCandidate(deviceId: deviceId)
    }

    public static func configurePtt() {
        log.notice("[spike] configurePtt: pick a candidate, then press the button twice")
        RadioAssembly.shared.engine.configurePtt { result in
            switch result {
            case let .success(configuration):
                log.notice(
                    "[spike] learned \(configuration.name, privacy: .public)"
                )
            case let .failure(error):
                log.error("[spike] pairing failed: \(error.message, privacy: .public)")
            }
        }
    }
}
