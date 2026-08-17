import XCTest
@testable import RadioKit

final class CaptureLevelTests: XCTestCase {

    private func pcm(_ samples: [Int16]) -> Data {
        samples.withUnsafeBufferPointer { Data(buffer: $0) }
    }

    private func samples(_ data: Data) -> [Int16] {
        data.withUnsafeBytes { Array($0.bindMemory(to: Int16.self)) }
    }

    // MARK: - CaptureGain

    func testUnityGainIsBitExactNoOp() {
        var data = pcm([0, 1, -1, 12_345, Int16.max, Int16.min])
        let original = data
        CaptureGain.apply(1.0, to: &data)
        XCTAssertEqual(data, original)
    }

    func testGainDoublesSampleValues() {
        var data = pcm([0, 100, -250, 16_000])
        CaptureGain.apply(2.0, to: &data)
        XCTAssertEqual(samples(data), [0, 200, -500, 32_000])
    }

    func testGainClampsToInt16Range() {
        var data = pcm([Int16.max, Int16.min, 20_000, -20_000])
        CaptureGain.apply(2.0, to: &data)
        XCTAssertEqual(samples(data), [Int16.max, Int16.min, Int16.max, Int16.min])
    }

    func testFractionalGainRounds() {
        var data = pcm([100, -100, 3])
        CaptureGain.apply(0.5, to: &data)
        XCTAssertEqual(samples(data), [50, -50, 2])
    }

    // MARK: - LevelMeter

    func testDbfsAnchors() {
        XCTAssertEqual(LevelMeter.dbfs(1.0), 0.0, accuracy: 0.001)
        XCTAssertEqual(LevelMeter.dbfs(0.5), -6.02, accuracy: 0.01)
        XCTAssertEqual(LevelMeter.dbfs(0.0), -120)
    }

    func testMeterFlushesOnceIntervalElapses() throws {
        var meter = LevelMeter(label: "tx", interval: 2)
        let buffer = try XCTUnwrap(
            OpusFormat.buffer(from: pcm(Array(repeating: 16_384, count: 320)))
        )
        let start = Date()

        // First buffer opens the window; nothing before the interval elapses.
        XCTAssertNil(meter.consume(buffer, now: start))
        XCTAssertNil(meter.consume(buffer, now: start.addingTimeInterval(1.0)))

        // 16 384 / 32 768 = 0.5 everywhere: peak == rms == -6.0 dBFS.
        XCTAssertEqual(
            meter.consume(buffer, now: start.addingTimeInterval(2.5)),
            "tx level peak=-6.0 rms=-6.0"
        )

        // The window resets: the next flush needs another full interval.
        XCTAssertNil(meter.consume(buffer, now: start.addingTimeInterval(3.0)))
    }
}
