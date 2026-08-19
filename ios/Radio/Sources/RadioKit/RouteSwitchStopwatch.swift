import Foundation

/// §10's switch-latency measurement, as a value: a device event arms it, the
/// first audio buffer after that disarms it and answers with the one line the
/// closeout reads.
///
/// A struct with no I/O because the two ends live in two different threads of
/// two different files — the notification handler and the audio tap — and the
/// only safe way to share them is one small piece of state under
/// `HeartbeatLogger`'s existing lock.
public struct RouteSwitchStopwatch {

    private struct Pending {
        let reason: String
        let atMs: Int64
    }

    private var pending: Pending?

    public init() {}

    /// A device appeared or disappeared. A second mark before any audio
    /// replaces the first: device lists flap during Bluetooth negotiation, and
    /// the latency that matters is from the last event to audio.
    public mutating func markRouteChange(reason: String, atMs: Int64) {
        pending = Pending(reason: reason, atMs: atMs)
    }

    /// Called on every buffer, so it must be cheap and must answer at most once
    /// per switch — a tap delivers ~50 buffers a second.
    public mutating func noteAudio(atMs: Int64) -> String? {
        guard let pending else { return nil }
        self.pending = nil
        return "route switch reason=\(pending.reason) "
            + "latencyMs=\(max(0, atMs - pending.atMs))"
    }
}
