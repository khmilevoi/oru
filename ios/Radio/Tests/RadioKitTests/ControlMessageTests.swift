import XCTest
@testable import RadioKit

final class ControlMessageTests: XCTestCase {

    func testHelloEncodesTheSpecShape() throws {
        let data = ControlMessage.hello(version: 1).encoded()
        let json = try XCTUnwrap(
            try JSONSerialization.jsonObject(with: data) as? [String: Any]
        )
        XCTAssertEqual(json["type"] as? String, "hello")
        XCTAssertEqual(json["version"] as? Int, 1)
    }

    func testTransmitMessagesEncodeTheSpecShape() throws {
        let start = ControlMessage.txStart(streamId: "abc").encoded()
        let startJson = try XCTUnwrap(
            try JSONSerialization.jsonObject(with: start) as? [String: Any]
        )
        XCTAssertEqual(startJson["type"] as? String, "tx-start")
        XCTAssertEqual(startJson["streamId"] as? String, "abc")

        let stop = ControlMessage.txStop(streamId: "abc").encoded()
        let stopJson = try XCTUnwrap(
            try JSONSerialization.jsonObject(with: stop) as? [String: Any]
        )
        XCTAssertEqual(stopJson["type"] as? String, "tx-stop")
    }

    func testRoundTrip() {
        let messages: [ControlMessage] = [
            .hello(version: 1),
            .txStart(streamId: "s-1"),
            .txStop(streamId: "s-1")
        ]
        for message in messages {
            XCTAssertEqual(ControlMessage.decode(message.encoded()), message)
        }
    }

    func testDecodesAndroidsWireBytes() {
        let android = Data(#"{"type":"tx-start","streamId":"S1"}"#.utf8)
        XCTAssertEqual(ControlMessage.decode(android), .txStart(streamId: "S1"))
    }

    func testRejectsGarbageAndUnknownTypes() {
        XCTAssertNil(ControlMessage.decode(Data("not json".utf8)))
        XCTAssertNil(ControlMessage.decode(Data(#"{"type":"nope"}"#.utf8)))
        XCTAssertNil(ControlMessage.decode(Data(#"{"type":"hello"}"#.utf8)))
        XCTAssertNil(ControlMessage.decode(Data()))
    }
}
