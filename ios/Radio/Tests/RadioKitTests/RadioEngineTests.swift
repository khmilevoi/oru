import XCTest
@testable import RadioKit

final class RadioEngineTests: XCTestCase {

    private var transport: FakeTransport!
    private var audio: FakeAudio!
    private var ptt: FakePtt!
    private var background: FakeBackground!
    private var clock: ManualClock!
    private var queue: DispatchQueue!
    private var engine: RadioEngine!

    override func setUp() {
        super.setUp()
        transport = FakeTransport()
        audio = FakeAudio()
        ptt = FakePtt()
        background = FakeBackground()
        clock = ManualClock()
        queue = DispatchQueue(label: "radio.engine.tests")
        engine = RadioEngine(
            transport: transport,
            audio: audio,
            ptt: ptt,
            background: background,
            clock: clock,
            queue: queue
        )
    }

    /// The engine is asynchronous by design; drain its queue before asserting.
    private func flush() {
        queue.sync {}
    }

    private func currentState() -> RadioState {
        var captured = RadioState()
        let done = expectation(description: "state")
        engine.getState { state in
            captured = state
            done.fulfill()
        }
        wait(for: [done], timeout: 1)
        return captured
    }

    func testStartRadioBringsUpEveryPortAndReportsReady() {
        engine.startRadio()
        flush()

        XCTAssertTrue(transport.isStarted)
        XCTAssertTrue(audio.isPlaying)
        XCTAssertTrue(background.isActive)
        XCTAssertTrue(ptt.isStarted)
        XCTAssertEqual(currentState().status, .ready)
    }

    func testStartFailureIsFatal() {
        transport.startError = RadioError.transportFailed("no wifi")
        engine.startRadio()
        flush()

        XCTAssertEqual(currentState().status, .error)
    }

    func testPressAsksPushToTalkAndDoesNotOpenTheMicrophoneYet() {
        engine.startRadio()
        flush()

        ptt.delegate?.pttSourceDidPress(ptt)
        flush()

        XCTAssertEqual(background.transmitRequests, 1)
        XCTAssertFalse(audio.isCapturing)
        XCTAssertFalse(currentState().transmitting)
    }

    func testAudioSessionActivationStartsTheTransmission() {
        engine.startRadio()
        flush()
        ptt.delegate?.pttSourceDidPress(ptt)
        flush()

        background.grantAudioSession()
        flush()

        XCTAssertTrue(audio.isCapturing)
        XCTAssertEqual(transport.openedStreamIds.count, 1)
        XCTAssertTrue(currentState().transmitting)

        guard case let .txStart(streamId) = transport.sentControl.last else {
            return XCTFail("expected a tx-start control message")
        }
        XCTAssertEqual(streamId, transport.openedStreamIds[0])
    }

    func testReleaseStopsEverythingAndAnnouncesTxStop() {
        engine.startRadio()
        flush()
        ptt.delegate?.pttSourceDidPress(ptt)
        flush()
        background.grantAudioSession()
        flush()

        ptt.delegate?.pttSourceDidRelease(ptt)
        flush()

        XCTAssertFalse(audio.isCapturing)
        XCTAssertEqual(transport.endedStreams, 1)
        XCTAssertEqual(background.transmitStops, 1)
        XCTAssertFalse(currentState().transmitting)

        guard case .txStop = transport.sentControl.last else {
            return XCTFail("expected a tx-stop control message")
        }
    }

    func testEncodedFramesReachTheStreamOnlyWhileTransmitting() {
        engine.startRadio()
        flush()
        audio.delegate?.audioIO(audio, didEncodeFrame: Data([9]))
        flush()

        ptt.delegate?.pttSourceDidPress(ptt)
        flush()
        background.grantAudioSession()
        flush()
        audio.delegate?.audioIO(audio, didEncodeFrame: Data([1, 2]))
        flush()

        XCTAssertEqual(transport.sink.frames, [Data([1, 2])])
    }

    func testSafetyCapStopsTransmissionAfter120Seconds() {
        engine.startRadio()
        flush()
        ptt.delegate?.pttSourceDidPress(ptt)
        flush()
        background.grantAudioSession()
        flush()

        XCTAssertEqual(clock.scheduledDelays, [120])

        clock.fireAll()
        flush()

        XCTAssertFalse(currentState().transmitting)
        XCTAssertFalse(audio.isCapturing)
    }

    func testPeerCountAndIncomingAudioAreMirroredInState() {
        engine.startRadio()
        flush()

        transport.delegate?.transport(transport, peerCountDidChange: 2)
        transport.delegate?.transport(transport, didStartIncomingAudio: "peer-a")
        flush()

        XCTAssertEqual(currentState().nearbyCount, 2)
        XCTAssertTrue(currentState().receiving)
        XCTAssertEqual(background.receivingFlags, [true])

        transport.delegate?.transport(
            transport,
            didReceiveAudioFrame: Data([4]),
            from: "peer-a"
        )
        transport.delegate?.transport(transport, didStopIncomingAudio: "peer-a")
        flush()

        XCTAssertEqual(audio.enqueued.count, 1)
        XCTAssertFalse(currentState().receiving)
        XCTAssertEqual(background.receivingFlags, [true, false])
    }

    func testTwoTransmittersKeepReceivingUntilBothStop() {
        engine.startRadio()
        flush()

        transport.delegate?.transport(transport, didStartIncomingAudio: "a")
        transport.delegate?.transport(transport, didStartIncomingAudio: "b")
        transport.delegate?.transport(transport, didStopIncomingAudio: "a")
        flush()

        XCTAssertTrue(currentState().receiving)

        transport.delegate?.transport(transport, didStopIncomingAudio: "b")
        flush()

        XCTAssertFalse(currentState().receiving)
    }

    func testPairingSessionIsMirroredIntoStateAndClearedWhenItEnds() {
        engine.startRadio()
        flush()

        var snapshots: [PttPairingState?] = []
        engine.addObserver("pairing") { event in
            if case let .stateChanged(state) = event {
                snapshots.append(state.pttPairing)
            }
        }
        flush()

        var resolved: PttConfiguration?
        engine.configurePtt { result in
            if case let .success(configuration) = result {
                resolved = configuration
            }
        }
        flush()

        engine.selectPttCandidate(deviceId: "device-1")
        flush()
        XCTAssertEqual(ptt.selectedDeviceIds, ["device-1"])

        let configuration = PttConfiguration(
            name: "PTT-1",
            binding: .ble(
                deviceId: "device-1",
                serviceUuid: "1812",
                characteristicUuid: "2A4D",
                pressedValue: "01",
                releasedValue: "00"
            )
        )
        ptt.finishLearning(.success(configuration))
        flush()

        XCTAssertEqual(resolved, configuration)
        XCTAssertEqual(
            snapshots.compactMap { $0?.phase },
            [.scanning, .learning, .saved]
        )
        XCTAssertNil(currentState().pttPairing)
        XCTAssertEqual(currentState().pttButton.name, "PTT-1")
    }

    func testFailedPairingClearsTheSessionAndReportsAnError() {
        engine.startRadio()
        flush()

        var errors: [RadioError] = []
        engine.addObserver("errors") { event in
            if case let .error(error) = event {
                errors.append(error)
            }
        }
        engine.configurePtt { _ in }
        flush()

        ptt.finishLearning(.failure(.pairingFailed("nothing was pressed")))
        flush()

        XCTAssertNil(currentState().pttPairing)
        XCTAssertEqual(errors.map(\.code), ["pairing_failed"])
        XCTAssertEqual(currentState().status, .ready)
    }

    func testObserversReceiveTheCurrentStateImmediately() {
        var events: [RadioEvent] = []
        engine.addObserver("test") { events.append($0) }
        flush()

        XCTAssertEqual(events.count, 1)
        engine.removeObserver("test")
        engine.startRadio()
        flush()

        XCTAssertEqual(events.count, 1)
    }
}
