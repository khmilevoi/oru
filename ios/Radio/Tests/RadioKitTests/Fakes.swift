import Foundation
@testable import RadioKit

final class FakeSink: AudioStreamSink {
    private(set) var frames: [Data] = []
    private(set) var isClosed = false

    func write(frame: Data) {
        frames.append(frame)
    }

    func close() {
        isClosed = true
    }
}

final class FakeTransport: RadioTransport {
    weak var delegate: RadioTransportDelegate?
    var connectedPeerCount = 0

    var startError: Error?
    private(set) var isStarted = false
    private(set) var sentControl: [ControlMessage] = []
    private(set) var openedStreamIds: [String] = []
    private(set) var endedStreams = 0
    private(set) var sink = FakeSink()

    func start() throws {
        if let startError { throw startError }
        isStarted = true
    }

    func stop() {
        isStarted = false
    }

    func broadcastControl(_ message: ControlMessage) {
        sentControl.append(message)
    }

    func beginAudioStream(streamId: String) -> AudioStreamSink? {
        openedStreamIds.append(streamId)
        sink = FakeSink()
        return sink
    }

    func endAudioStream() {
        endedStreams += 1
    }
}

final class FakeAudio: AudioIO {
    weak var delegate: AudioIODelegate?

    var captureError: Error?
    private(set) var isCapturing = false
    private(set) var isPlaying = false
    private(set) var incoming: [String] = []
    private(set) var enqueued: [(String, Data)] = []

    func startPlayback() throws {
        isPlaying = true
    }

    func stopPlayback() {
        isPlaying = false
    }

    func startCapture() throws {
        if let captureError { throw captureError }
        isCapturing = true
    }

    func stopCapture() {
        isCapturing = false
    }

    func beginIncoming(peerId: String) {
        incoming.append(peerId)
    }

    func enqueue(frame: Data, from peerId: String) {
        enqueued.append((peerId, frame))
    }

    func endIncoming(peerId: String) {
        incoming.removeAll { $0 == peerId }
    }

    /// One entry per rebuild request, `true` when the whole AVAudioEngine was
    /// to be thrown away.
    private(set) var rebuilds: [Bool] = []
    private(set) var grantTones = 0

    func rebuildEngine(recreate: Bool) {
        rebuilds.append(recreate)
    }

    func playGrantTone() {
        grantTones += 1
    }
}

final class FakePtt: PttSource {
    weak var delegate: PttSourceDelegate?
    var buttonState = PttButtonState()
    private(set) var isStarted = false
    private(set) var didForget = false
    private(set) var selectedDeviceIds: [String] = []
    private var learningCompletion: ((Result<PttConfiguration, RadioError>) -> Void)?

    func start() {
        isStarted = true
    }

    func stop() {
        isStarted = false
    }

    func beginLearning(completion: @escaping (Result<PttConfiguration, RadioError>) -> Void) {
        learningCompletion = completion
        delegate?.pttSource(self, pairingStateDidChange: PttPairingState(phase: .scanning))
    }

    func selectCandidate(deviceId: String) {
        selectedDeviceIds.append(deviceId)
        delegate?.pttSource(self, pairingStateDidChange: PttPairingState(phase: .learning))
    }

    func forget() {
        didForget = true
        buttonState = PttButtonState()
    }

    /// Stands in for the button being learned and the binding saved.
    func finishLearning(_ result: Result<PttConfiguration, RadioError>) {
        if case let .success(configuration) = result {
            buttonState = PttButtonState(
                configured: true,
                connected: true,
                name: configuration.name
            )
            delegate?.pttSource(self, pairingStateDidChange: PttPairingState(phase: .saved))
        }
        let completion = learningCompletion
        learningCompletion = nil
        completion?(result)
    }
}

final class FakeBackground: BackgroundSession {
    weak var delegate: BackgroundSessionDelegate?
    private(set) var isActive = false
    private(set) var transmitRequests = 0
    private(set) var transmitStops = 0
    private(set) var receivingFlags: [Bool] = []

    func activate() {
        isActive = true
    }

    func deactivate() {
        isActive = false
    }

    func requestBeginTransmitting() {
        transmitRequests += 1
    }

    func stopTransmitting() {
        transmitStops += 1
    }

    func setReceiving(_ receiving: Bool) {
        receivingFlags.append(receiving)
    }

    /// Stands in for the system handing us an active audio session.
    func grantAudioSession() {
        delegate?.backgroundSessionDidActivateAudio(self)
    }
}

final class ManualClock: RadioClock {
    private var pending: [(id: Int, seconds: TimeInterval, block: () -> Void)] = []
    private var nextId = 0
    private(set) var scheduledDelays: [TimeInterval] = []

    func schedule(
        after seconds: TimeInterval,
        _ block: @escaping () -> Void
    ) -> RadioCancellable {
        nextId += 1
        let id = nextId
        scheduledDelays.append(seconds)
        pending.append((id, seconds, block))
        return Token(clock: self, id: id)
    }

    func fireAll() {
        let due = pending
        pending.removeAll()
        for entry in due {
            entry.block()
        }
    }

    fileprivate func cancel(id: Int) {
        pending.removeAll { $0.id == id }
    }

    private final class Token: RadioCancellable {
        private weak var clock: ManualClock?
        private let id: Int

        init(clock: ManualClock, id: Int) {
            self.clock = clock
            self.id = id
        }

        func cancel() {
            clock?.cancel(id: id)
        }
    }
}
