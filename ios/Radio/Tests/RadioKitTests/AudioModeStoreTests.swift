import XCTest
@testable import RadioKit

/// §8's persisted setting, on the `PttBindingStore` pattern (spec section 9.2's
/// precedent): the native side owns the storage, JavaScript mirrors it.
final class AudioModeStoreTests: XCTestCase {

    private var defaults: UserDefaults!
    private var suiteName: String!

    override func setUp() {
        super.setUp()
        suiteName = "audio.mode.tests.\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suiteName)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suiteName)
        defaults = nil
        super.tearDown()
    }

    func testTheDefaultIsAuto() {
        // §8: "New persisted setting `audioMode` … (default `auto`)".
        XCTAssertEqual(AudioModeStore(defaults: defaults).load(), .auto)
    }

    func testASavedSettingSurvivesAFreshStore() {
        AudioModeStore(defaults: defaults).save(.media)
        XCTAssertEqual(AudioModeStore(defaults: defaults).load(), .media)
    }

    func testEverySettingRoundTrips() {
        let store = AudioModeStore(defaults: defaults)
        for setting in [AudioModeSetting.auto, .voice, .media] {
            store.save(setting)
            XCTAssertEqual(store.load(), setting)
        }
    }

    func testGarbageInTheDefaultsReadsAsAuto() {
        defaults.set("loudspeaker", forKey: RadioConfig.Session.audioModeDefaultsKey)
        XCTAssertEqual(AudioModeStore(defaults: defaults).load(), .auto)
    }

    func testTheStoredValueIsTheContractString() {
        // The same three strings `specs/NativeRadio.ts` publishes, so a value
        // read out of the defaults is directly the wire value.
        AudioModeStore(defaults: defaults).save(.voice)
        XCTAssertEqual(
            defaults.string(forKey: RadioConfig.Session.audioModeDefaultsKey), "voice"
        )
    }

    func testEachSettingMapsToItsPolicyMode() {
        XCTAssertEqual(AudioModeSetting.auto.policyMode, .auto)
        XCTAssertEqual(AudioModeSetting.voice.policyMode, .voice)
        XCTAssertEqual(AudioModeSetting.media.policyMode, .media)
    }
}
