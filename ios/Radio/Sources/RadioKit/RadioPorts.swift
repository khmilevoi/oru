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

// MARK: - Background (PushToTalk)

public protocol BackgroundSession: AnyObject {
    var delegate: BackgroundSessionDelegate? { get set }

    func activate()
    func deactivate()
    func requestBeginTransmitting()
    func stopTransmitting()
    func setReceiving(_ receiving: Bool)
}

public protocol BackgroundSessionDelegate: AnyObject {
    /// The system activated the audio session; the microphone may start now.
    func backgroundSessionDidActivateAudio(_ session: BackgroundSession)
    func backgroundSessionDidDeactivateAudio(_ session: BackgroundSession)
    /// Transmission was started somewhere outside the app (the system PTT UI).
    func backgroundSessionDidRequestTransmitStart(_ session: BackgroundSession)
    func backgroundSessionDidRequestTransmitStop(_ session: BackgroundSession)
    func backgroundSession(_ session: BackgroundSession, didFail error: RadioError)
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
