#if DEBUG
import Foundation
import Network
import os

/// Phase 0, debug builds only: the iOS twin of the Android spike's
/// `SpikeReceiver` adb broadcasts (docs/phase0-android-spike-hooks.md §2-4).
/// iOS has no adb, so this listens for UDP datagrams from a Mac on the same
/// Wi-Fi — one text command per datagram, one short text reply to the sender.
/// The listening address is logged (and heartbeat-recorded) at startup as
/// `spike: command server on <ip>:47999`.
///
/// From the Mac:
///
///     echo -n "ptt-down" | nc -u -w1 <iphone-ip> 47999
///     echo -n "ptt-up" | nc -u -w1 <iphone-ip> 47999
///     echo -n "state" | nc -u -w1 <iphone-ip> 47999
///     echo -n "ptt-scan" | nc -u -w1 <iphone-ip> 47999
///     echo -n "ptt-pick 12345678-ABCD-..." | nc -u -w1 <iphone-ip> 47999
///     echo -n "ptt-forget" | nc -u -w1 <iphone-ip> 47999
///
/// `ptt-cancel` is accepted but answers `err unsupported`: unlike Android, the
/// iOS pairing stack has no cancel hook — an abandoned session times out after
/// `RadioConfig.Ptt.learningTimeout` on its own.
public final class SpikeCommandServer {

    public static let shared = SpikeCommandServer()

    private let log = Logger(
        subsystem: RadioConfig.Logging.subsystem,
        category: "spike"
    )
    private let queue = DispatchQueue(label: "com.oru.radio.spike.commands")
    private var listener: NWListener?

    public func start() {
        queue.async { self.startOnQueue() }
    }

    private func startOnQueue() {
        guard listener == nil else { return }
        do {
            let listener = try NWListener(
                using: .udp,
                on: NWEndpoint.Port(rawValue: RadioConfig.Spike.commandPort)!
            )
            listener.stateUpdateHandler = { [weak self] state in
                self?.listenerStateChanged(state)
            }
            listener.newConnectionHandler = { [weak self] connection in
                self?.accept(connection)
            }
            listener.start(queue: queue)
            self.listener = listener
        } catch {
            log.error(
                "[spike] command server failed to start: \(String(describing: error), privacy: .public)"
            )
        }
    }

    private func listenerStateChanged(_ state: NWListener.State) {
        switch state {
        case .ready:
            let ip = Self.wifiIPv4() ?? "unknown-ip"
            let line = "command server on \(ip):\(RadioConfig.Spike.commandPort)"
            log.notice("[spike] \(line, privacy: .public)")
            HeartbeatLogger.shared.record("spike: \(line)")
        case let .failed(error):
            let line = "command server failed: \(error)"
            log.error("[spike] \(line, privacy: .public)")
            HeartbeatLogger.shared.record("spike: \(line)")
        default:
            break
        }
    }

    // MARK: - Datagrams

    /// UDP "connections" are per-remote-endpoint; each carries this peer's
    /// datagrams, one command each, answered on the same connection.
    private func accept(_ connection: NWConnection) {
        connection.start(queue: queue)
        receiveNext(on: connection)
    }

    private func receiveNext(on connection: NWConnection) {
        connection.receiveMessage { [weak self] data, _, _, error in
            guard let self else { return }
            guard error == nil else {
                connection.cancel()
                return
            }
            if let data, let text = String(data: data, encoding: .utf8) {
                let command = text.trimmingCharacters(in: .whitespacesAndNewlines)
                self.handle(command) { response in
                    connection.send(
                        content: Data((response + "\n").utf8),
                        completion: .contentProcessed { _ in }
                    )
                }
            }
            self.receiveNext(on: connection)
        }
    }

    // MARK: - Commands

    /// The Android spike's vocabulary (docs/phase0-android-spike-hooks.md).
    /// `reply` may be called from any queue; `NWConnection.send` is fine with
    /// that. The spike hooks are invoked from the main queue — the same place
    /// `AppDelegate` drives `RadioSpike` from; the engine's entry points hop
    /// onto their own queue internally.
    private func handle(_ command: String, reply: @escaping (String) -> Void) {
        log.notice("[spike] command \(command, privacy: .public)")
        HeartbeatLogger.shared.record("spike command \(command)")

        let parts = command.split(separator: " ", maxSplits: 1).map(String.init)
        switch parts.first ?? "" {
        case "ptt-down":
            DispatchQueue.main.async { RadioSpike.startTransmit() }
            reply("ok")
        case "ptt-up":
            DispatchQueue.main.async { RadioSpike.stopTransmit() }
            reply("ok")
        case "ptt-scan":
            DispatchQueue.main.async { RadioSpike.configurePtt() }
            reply("ok")
        case "ptt-pick":
            guard parts.count == 2 else {
                reply("err usage: ptt-pick <deviceId>")
                return
            }
            let deviceId = parts[1]
            DispatchQueue.main.async { RadioSpike.selectPttCandidate(deviceId) }
            reply("ok")
        case "ptt-forget":
            DispatchQueue.main.async { RadioSpike.forgetPtt() }
            reply("ok")
        case "ptt-cancel":
            // No cancel hook exists on iOS (engine, PttManager, driver); an
            // abandoned session times out via RadioConfig.Ptt.learningTimeout.
            reply(
                "err unsupported: no cancel hook; pairing times out after "
                    + "\(Int(RadioConfig.Ptt.learningTimeout))s"
            )
        case "state":
            RadioAssembly.shared.engine.getState { state in
                reply(Self.describe(state))
            }
        default:
            reply("err unknown")
        }
    }

    /// The same snapshot `RadioSpike`'s observer logs, one line.
    private static func describe(_ state: RadioState) -> String {
        var line = """
            status=\(state.status.rawValue) \
            nearby=\(state.nearbyCount) \
            tx=\(state.transmitting) \
            rx=\(state.receiving) \
            button=\(state.pttButton.configured)/\(state.pttButton.connected) \
            route=\(state.audioRoute.kind.rawValue)/\(state.audioRoute.mode.rawValue) \
            audioMode=\(state.audioMode.rawValue)
            """
        if let pairing = state.pttPairing {
            let candidates = pairing.candidates
                .map { "\($0.deviceId) \($0.name) \($0.rssi)" }
                .joined(separator: " | ")
            line += " pairing=\(pairing.phase.rawValue) candidates=[\(candidates)]"
        }
        return line
    }

    // MARK: - Wi-Fi address

    /// The en0 IPv4, so the startup log can tell the Mac where to aim `nc`.
    private static func wifiIPv4() -> String? {
        var ifaddrList: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&ifaddrList) == 0, let first = ifaddrList else { return nil }
        defer { freeifaddrs(ifaddrList) }

        for pointer in sequence(first: first, next: { $0.pointee.ifa_next }) {
            let interface = pointer.pointee
            guard
                let addr = interface.ifa_addr,
                addr.pointee.sa_family == UInt8(AF_INET),
                String(cString: interface.ifa_name) == "en0"
            else { continue }

            var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            let resolved = getnameinfo(
                addr,
                socklen_t(addr.pointee.sa_len),
                &host,
                socklen_t(host.count),
                nil,
                0,
                NI_NUMERICHOST
            )
            if resolved == 0 {
                return String(cString: host)
            }
        }
        return nil
    }
}
#endif
