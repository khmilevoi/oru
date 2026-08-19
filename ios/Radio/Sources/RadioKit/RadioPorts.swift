import Foundation

// MARK: - Transport

/// One live outgoing transmission. Frames are already Opus-encoded and framed by
/// the transport implementation.
public protocol AudioStreamSink: AnyObject {
    func write(frame: Data)
    func close()
}

/// Everything the engine needs from Nearby Connections, and nothing more.
public protocol RadioTransport: AnyObject {
    var delegate: RadioTransportDelegate? { get set }
    var connectedPeerCount: Int { get }

    func start() throws
    func stop()
    func broadcastControl(_ message: ControlMessage)
    func beginAudioStream(streamId: String) -> AudioStreamSink?
    func endAudioStream()
}

public protocol RadioTransportDelegate: AnyObject {
    func transport(_ transport: RadioTransport, peerCountDidChange count: Int)
    func transport(_ transport: RadioTransport, didStartIncomingAudio peerId: String)
    func transport(
        _ transport: RadioTransport,
        didReceiveAudioFrame frame: Data,
        from peerId: String
    )
    func transport(_ transport: RadioTransport, didStopIncomingAudio peerId: String)
    func transport(_ transport: RadioTransport, didFail error: RadioError)
}

// MARK: - Audio

public protocol AudioIO: AnyObject {
    var delegate: AudioIODelegate? { get set }

    func startPlayback() throws
    func stopPlayback()
    func startCapture() throws
    func stopCapture()
    func beginIncoming(peerId: String)
    func enqueue(frame: Data, from peerId: String)
    func endIncoming(peerId: String)

    /// §5's `AVAudioEngineConfigurationChange` rebuild: stop, disconnect the
    /// nodes, re-query every format from the hardware, reconnect, restart,
    /// reinstall the tap that was on the input. Formats are never cached across
    /// it. `recreate` additionally throws the `AVAudioEngine` itself away and
    /// builds a new one — Apple QA1749's answer to `mediaServicesWereReset`.
    ///
    /// Returns immediately: the work happens on the implementation's own queue,
    /// so no call chain from the engine queue can block on it. A failure is
    /// logged and never raised — §2 goal 3: a route change must not become
    /// `status: 'error'`.
    func rebuildEngine(recreate: Bool)

    /// D2's talk-permit tone. Scheduled, not awaited: §7 gates transmission on
    /// the tone being granted, not on its decay.
    func playGrantTone()
}

public protocol AudioIODelegate: AnyObject {
    /// One Opus packet ready to go out on the wire.
    func audioIO(_ audio: AudioIO, didEncodeFrame frame: Data)
    func audioIO(_ audio: AudioIO, didFail error: RadioError)
}

// MARK: - PTT

public protocol PttSource: AnyObject {
    var delegate: PttSourceDelegate? { get set }
    var buttonState: PttButtonState { get }

    func start()
    func stop()
    /// Opens a pairing session; resolves once the binding is saved.
    func beginLearning(completion: @escaping (Result<PttConfiguration, RadioError>) -> Void)
    /// The user's pick from the published candidates.
    func selectCandidate(deviceId: String)
    func forget()
}

public protocol PttSourceDelegate: AnyObject {
    func pttSourceDidPress(_ source: PttSource)
    func pttSourceDidRelease(_ source: PttSource)
    func pttSource(_ source: PttSource, buttonStateDidChange state: PttButtonState)
    /// nil ends the session and removes `pttPairing` from `RadioState`.
    func pttSource(_ source: PttSource, pairingStateDidChange state: PttPairingState?)
}

// MARK: - Background

public protocol BackgroundSession: AnyObject {
    var delegate: BackgroundSessionDelegate? { get set }

    func activate()
    func deactivate()
    func requestBeginTransmitting()
    func stopTransmitting()
    func setReceiving(_ receiving: Bool)

    /// §5/§7: apply one of the two static session configurations, whole and
    /// diff-only. The merged §7 policy is the only thing that asks. On iOS a
    /// voice-link raise and a mode switch are the same call, which is why there
    /// is one method and not three.
    ///
    /// Called from the engine queue, like every other method here, and must
    /// never dispatch synchronously back onto it.
    func applyProfile(_ profile: ModePolicy.Profile)
}

public protocol BackgroundSessionDelegate: AnyObject {
    /// The audio session is active; the microphone may start now.
    func backgroundSessionDidActivateAudio(_ session: BackgroundSession)
    func backgroundSessionDidDeactivateAudio(_ session: BackgroundSession)
    /// Transmission was started somewhere outside the app. Nothing raises this
    /// under the always-hot architecture (spec section 10.2) — it survives for
    /// a future system-level talk control.
    func backgroundSessionDidRequestTransmitStart(_ session: BackgroundSession)
    func backgroundSessionDidRequestTransmitStop(_ session: BackgroundSession)
    func backgroundSession(_ session: BackgroundSession, didFail error: RadioError)

    /// §8's `audioRoute` and §7's two route predicates, in one value. Delivered
    /// on the engine queue, diff-only: an unchanged route is not republished.
    func backgroundSession(
        _ session: BackgroundSession,
        routeDidChange snapshot: AudioRouteSnapshot
    )
    /// §5's other-audio detection (`isOtherAudioPlaying` on the heartbeat tick
    /// and on every route change, `silenceSecondaryAudioHint` as an edge).
    /// Diff-only, raw and undebounced: the 2 s / 30 s dwell belongs to
    /// `ModePolicy`, so both platforms debounce identically.
    func backgroundSession(
        _ session: BackgroundSession,
        otherAudioActiveDidChange active: Bool
    )
    /// §5: the audio graph must be rebuilt. `recreate` means the
    /// `AVAudioEngine` itself is dead (media services reset) and a new one is
    /// needed. The session observes this; `AudioIO` owns the graph.
    func backgroundSession(
        _ session: BackgroundSession,
        didRequestEngineRebuild recreate: Bool
    )
}

// MARK: - Clock

public protocol RadioCancellable: AnyObject {
    func cancel()
}

/// Injected so the 120 s safety cap is testable without waiting 120 s.
public protocol RadioClock: AnyObject {
    func schedule(after seconds: TimeInterval, _ block: @escaping () -> Void) -> RadioCancellable
}

public final class DispatchRadioClock: RadioClock {
    private let queue: DispatchQueue

    public init(queue: DispatchQueue) {
        self.queue = queue
    }

    public func schedule(
        after seconds: TimeInterval,
        _ block: @escaping () -> Void
    ) -> RadioCancellable {
        let item = DispatchWorkItem(block: block)
        queue.asyncAfter(deadline: .now() + seconds, execute: item)
        return Token(item: item)
    }

    private final class Token: RadioCancellable {
        private let item: DispatchWorkItem

        init(item: DispatchWorkItem) {
            self.item = item
        }

        func cancel() {
            item.cancel()
        }
    }
}
