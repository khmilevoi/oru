import XCTest
@testable import RadioKit

final class AudioFramingTests: XCTestCase {

    func testFramePrefixesBigEndianLength() {
        let framed = AudioFraming.frame(Data([0xAA, 0xBB, 0xCC]))
        XCTAssertEqual(Array(framed), [0x00, 0x03, 0xAA, 0xBB, 0xCC])
    }

    func testParserReturnsWholeFramesOnly() {
        let parser = AudioFrameParser()
        let framed = AudioFraming.frame(Data([1, 2, 3, 4]))

        XCTAssertEqual(parser.append(framed.prefix(3)), [])
        XCTAssertEqual(parser.append(framed.suffix(from: 3)), [Data([1, 2, 3, 4])])
    }

    func testParserSplitsSeveralFramesFromOneRead() {
        let parser = AudioFrameParser()
        var chunk = AudioFraming.frame(Data([1]))
        chunk.append(AudioFraming.frame(Data([2, 2])))

        XCTAssertEqual(parser.append(chunk), [Data([1]), Data([2, 2])])
    }

    func testOversizedLengthMarksDesync() {
        let parser = AudioFrameParser()
        _ = parser.append(Data([0xFF, 0xFF, 0x00]))

        XCTAssertTrue(parser.isDesynchronised)
        XCTAssertEqual(parser.append(AudioFraming.frame(Data([1]))), [])
    }

    func testResetClearsDesync() {
        let parser = AudioFrameParser()
        _ = parser.append(Data([0xFF, 0xFF]))
        parser.reset()

        XCTAssertFalse(parser.isDesynchronised)
        XCTAssertEqual(parser.append(AudioFraming.frame(Data([7]))), [Data([7])])
    }
}
