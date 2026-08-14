import XCTest
@testable import RadioKit

final class JitterBufferTests: XCTestCase {

    private func frame(_ byte: UInt8) -> Data {
        Data([byte])
    }

    func testStaysSilentUntilPrimed() {
        let buffer = JitterBuffer(targetFrames: 3, maxFrames: 10)

        buffer.push(frame(1))
        XCTAssertNil(buffer.pop())
        buffer.push(frame(2))
        XCTAssertNil(buffer.pop())
        buffer.push(frame(3))

        XCTAssertTrue(buffer.isPrimed)
        XCTAssertEqual(buffer.pop(), frame(1))
    }

    func testDeliversInOrder() {
        let buffer = JitterBuffer(targetFrames: 2, maxFrames: 10)
        buffer.push(frame(1))
        buffer.push(frame(2))
        buffer.push(frame(3))

        XCTAssertEqual(buffer.pop(), frame(1))
        XCTAssertEqual(buffer.pop(), frame(2))
        XCTAssertEqual(buffer.pop(), frame(3))
    }

    func testDropsOldestBeyondTheBacklogLimit() {
        let buffer = JitterBuffer(targetFrames: 2, maxFrames: 3)
        for byte in UInt8(1)...UInt8(5) {
            buffer.push(frame(byte))
        }

        XCTAssertEqual(buffer.count, 3)
        XCTAssertEqual(buffer.droppedFrames, 2)
        XCTAssertEqual(buffer.pop(), frame(3))
    }

    func testUnderrunRePrimes() {
        let buffer = JitterBuffer(targetFrames: 2, maxFrames: 10)
        buffer.push(frame(1))
        buffer.push(frame(2))
        _ = buffer.pop()
        _ = buffer.pop()

        XCTAssertNil(buffer.pop())
        XCTAssertFalse(buffer.isPrimed)

        buffer.push(frame(3))
        XCTAssertNil(buffer.pop())
        buffer.push(frame(4))
        XCTAssertEqual(buffer.pop(), frame(3))
    }

    func testResetClearsEverything() {
        let buffer = JitterBuffer(targetFrames: 1, maxFrames: 2)
        buffer.push(frame(1))
        buffer.reset()

        XCTAssertEqual(buffer.count, 0)
        XCTAssertFalse(buffer.isPrimed)
        XCTAssertNil(buffer.pop())
    }

    func testDefaultsComeFromConfig() {
        let buffer = JitterBuffer()
        for byte in 0..<UInt8(RadioConfig.Audio.jitterTargetFrames) {
            XCTAssertNil(buffer.pop())
            buffer.push(frame(byte))
        }
        XCTAssertTrue(buffer.isPrimed)
    }
}
