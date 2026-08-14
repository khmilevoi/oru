import XCTest
@testable import RadioKit

final class PttBindingTests: XCTestCase {

    private let bleBinding = PttBinding.ble(
        deviceId: "1D6F4B0A-0000-4000-8000-000000000001",
        serviceUuid: "1812",
        characteristicUuid: "2A4D",
        pressedValue: "01",
        releasedValue: "00"
    )

    private func makeDefaults() throws -> UserDefaults {
        let name = "radio.tests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: name))
        defaults.removePersistentDomain(forName: name)
        return defaults
    }

    func testBleBindingKeepsTheSpecFieldNames() {
        let dictionary = bleBinding.asDictionary
        XCTAssertEqual(dictionary["type"] as? String, "ble")
        XCTAssertEqual(dictionary["serviceUuid"] as? String, "1812")
        XCTAssertEqual(dictionary["characteristicUuid"] as? String, "2A4D")
        XCTAssertEqual(dictionary["pressedValue"] as? String, "01")
        XCTAssertEqual(dictionary["releasedValue"] as? String, "00")
    }

    func testBindingRoundTripsThroughItsDictionary() {
        XCTAssertEqual(PttBinding.from(dictionary: bleBinding.asDictionary), bleBinding)

        let hid = PttBinding.hid(keyCode: 85)
        XCTAssertEqual(PttBinding.from(dictionary: hid.asDictionary), hid)
    }

    func testMalformedBindingsAreRejected() {
        XCTAssertNil(PttBinding.from(dictionary: [:]))
        XCTAssertNil(PttBinding.from(dictionary: ["type": "ble"]))
        XCTAssertNil(PttBinding.from(dictionary: ["type": "carrier-pigeon"]))
        XCTAssertNil(PttBinding.from(dictionary: ["type": "hid", "keyCode": "85"]))
    }

    func testStoreSurvivesARestart() throws {
        let defaults = try makeDefaults()
        let configuration = PttConfiguration(name: "PTT-1", binding: bleBinding)

        PttBindingStore(defaults: defaults).save(configuration)
        let reloaded = PttBindingStore(defaults: defaults).load()

        XCTAssertEqual(reloaded, configuration)
    }

    func testClearForgetsTheButton() throws {
        let defaults = try makeDefaults()
        let store = PttBindingStore(defaults: defaults)
        store.save(PttConfiguration(name: "PTT-1", binding: bleBinding))
        store.clear()

        XCTAssertNil(store.load())
    }

    func testHexHelpersRoundTrip() {
        XCTAssertEqual(PttHex.string(from: Data([0x00, 0x0F, 0xA1])), "000fa1")
        XCTAssertEqual(PttHex.data(from: "000FA1"), Data([0x00, 0x0F, 0xA1]))
        XCTAssertNil(PttHex.data(from: "abc"))
        XCTAssertNil(PttHex.data(from: "zz"))
    }
}
