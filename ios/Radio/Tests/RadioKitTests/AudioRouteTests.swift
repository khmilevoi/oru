import AVFoundation
import XCTest
@testable import RadioKit

/// §5 and §8's route decisions, all pure over port types and names.
/// `AVAudioSessionPortDescription` has no public initialiser, which is why
/// every decision here is a function of `[AudioPort]`.
final class AudioRouteTests: XCTestCase {

    private func port(_ type: AVAudioSession.Port, _ name: String = "") -> AudioPort {
        AudioPort(type: type, name: name)
    }

    // MARK: - kind

    func testSpeakerOnlyOutputsAreTheSpeakerKind() {
        XCTAssertEqual(AudioRouteClassifier.kind(forOutputs: [port(.builtInSpeaker)]), .speaker)
        XCTAssertEqual(AudioRouteClassifier.kind(forOutputs: [port(.builtInReceiver)]), .speaker)
        XCTAssertEqual(AudioRouteClassifier.kind(forOutputs: []), .speaker)
    }

    func testWiredHeadphonesAreTheWiredKind() {
        XCTAssertEqual(AudioRouteClassifier.kind(forOutputs: [port(.headphones)]), .wired)
        XCTAssertEqual(AudioRouteClassifier.kind(forOutputs: [port(.lineOut)]), .wired)
    }

    func testUsbAudioIsTheUsbKind() {
        XCTAssertEqual(AudioRouteClassifier.kind(forOutputs: [port(.usbAudio)]), .usb)
    }

    func testEveryBluetoothPortTypeIsTheBluetoothKind() {
        for type in [AVAudioSession.Port.bluetoothA2DP, .bluetoothHFP, .bluetoothLE, .carAudio] {
            XCTAssertEqual(
                AudioRouteClassifier.kind(forOutputs: [port(type)]), .bluetooth,
                "\(type.rawValue) must classify as bluetooth"
            )
        }
    }

    func testBluetoothWinsOverEveryOtherKindInAMixedRoute() {
        // Priority exists so a transient route carrying two outputs never
        // reports the accessory the user is not listening through.
        XCTAssertEqual(
            AudioRouteClassifier.kind(forOutputs: [port(.builtInSpeaker), port(.headphones), port(.bluetoothA2DP)]),
            .bluetooth
        )
        XCTAssertEqual(
            AudioRouteClassifier.kind(forOutputs: [port(.builtInSpeaker), port(.headphones), port(.usbAudio)]),
            .usb
        )
    }

    func testAirPlayAndHdmiFallBackToSpeaker() {
        // §8's union has four kinds and neither of these is one of them; the
        // radio has no special handling for them either.
        XCTAssertEqual(AudioRouteClassifier.kind(forOutputs: [port(.airPlay)]), .speaker)
        XCTAssertEqual(AudioRouteClassifier.kind(forOutputs: [port(.HDMI)]), .speaker)
    }

    // MARK: - label

    func testOnlyBluetoothRoutesCarryALabel() {
        XCTAssertEqual(AudioRouteClassifier.label(forOutputs: [port(.bluetoothA2DP, "AirPods Pro")]), "AirPods Pro")
        XCTAssertNil(AudioRouteClassifier.label(forOutputs: [port(.headphones, "Headphones")]))
        XCTAssertNil(AudioRouteClassifier.label(forOutputs: [port(.usbAudio, "USB-C Dock")]))
        XCTAssertNil(AudioRouteClassifier.label(forOutputs: [port(.builtInSpeaker, "Speaker")]))
    }

    func testAnEmptyBluetoothNameIsAbsentRatherThanEmpty() {
        // §8: "absent rather than empty when a Bluetooth device reports no name".
        XCTAssertNil(AudioRouteClassifier.label(forOutputs: [port(.bluetoothHFP, "")]))
        XCTAssertNil(AudioRouteClassifier.label(forOutputs: [port(.bluetoothHFP, "   ")]))
    }

    // MARK: - voice link predicates

    func testOnlyBluetoothRoutesRequireAVoiceLink() {
        XCTAssertTrue(AudioRouteClassifier.requiresVoiceLink(outputs: [port(.bluetoothA2DP)]))
        XCTAssertTrue(AudioRouteClassifier.requiresVoiceLink(outputs: [port(.bluetoothLE)]))
        XCTAssertFalse(AudioRouteClassifier.requiresVoiceLink(outputs: [port(.headphones)]))
        XCTAssertFalse(AudioRouteClassifier.requiresVoiceLink(outputs: [port(.usbAudio)]))
        XCTAssertFalse(AudioRouteClassifier.requiresVoiceLink(outputs: [port(.builtInSpeaker)]))
        XCTAssertFalse(AudioRouteClassifier.requiresVoiceLink(outputs: []))
    }

    func testAnHfpInputIsWhatProvesTheHeadsetMicIsLive() {
        XCTAssertTrue(AudioRouteClassifier.providesVoiceLink(inputs: [port(.bluetoothHFP)]))
        XCTAssertTrue(AudioRouteClassifier.providesVoiceLink(inputs: [port(.builtInMic), port(.bluetoothHFP)]))
        XCTAssertFalse(AudioRouteClassifier.providesVoiceLink(inputs: [port(.builtInMic)]))
        XCTAssertFalse(AudioRouteClassifier.providesVoiceLink(inputs: [port(.headsetMic)]))
        XCTAssertFalse(AudioRouteClassifier.providesVoiceLink(inputs: []))
    }

    // MARK: - snapshot

    func testTheA2dpSnapshotIsAHeadsetWhoseMicIsNotLiveYet() {
        let snapshot = AudioRouteClassifier.snapshot(
            outputs: [port(.bluetoothA2DP, "AirPods Pro")],
            inputs: [port(.builtInMic, "iPhone Microphone")]
        )
        XCTAssertEqual(
            snapshot,
            AudioRouteSnapshot(
                kind: .bluetooth, label: "AirPods Pro",
                requiresVoiceLink: true, providesVoiceLink: false
            )
        )
    }

    func testTheHfpSnapshotIsAHeadsetWhoseMicIsLive() {
        let snapshot = AudioRouteClassifier.snapshot(
            outputs: [port(.bluetoothHFP, "AirPods Pro")],
            inputs: [port(.bluetoothHFP, "AirPods Pro")]
        )
        XCTAssertEqual(
            snapshot,
            AudioRouteSnapshot(
                kind: .bluetooth, label: "AirPods Pro",
                requiresVoiceLink: true, providesVoiceLink: true
            )
        )
    }

    func testTheWiredSnapshotNeverAsksForAVoiceLink() {
        let snapshot = AudioRouteClassifier.snapshot(
            outputs: [port(.headphones, "Headphones")],
            inputs: [port(.builtInMic, "iPhone Microphone")]
        )
        XCTAssertEqual(
            snapshot,
            AudioRouteSnapshot(
                kind: .wired, label: nil,
                requiresVoiceLink: false, providesVoiceLink: false
            )
        )
    }

    // MARK: - the §8 value

    func testTheRouteDictionaryOmitsAnAbsentLabel() {
        let route = AudioRoute(kind: .speaker, label: nil, mode: .voice)
        XCTAssertEqual(route.asDictionary["kind"] as? String, "speaker")
        XCTAssertEqual(route.asDictionary["mode"] as? String, "voice")
        XCTAssertNil(route.asDictionary["label"])
    }

    func testTheRouteDictionaryCarriesTheLabelWhenThereIsOne() {
        let route = AudioRoute(kind: .bluetooth, label: "AirPods Pro", mode: .media)
        XCTAssertEqual(route.asDictionary["kind"] as? String, "bluetooth")
        XCTAssertEqual(route.asDictionary["label"] as? String, "AirPods Pro")
        XCTAssertEqual(route.asDictionary["mode"] as? String, "media")
    }

    func testTheModeMirrorsThePolicyProfile() {
        XCTAssertEqual(AudioRoute.Mode(ModePolicy.Profile.voice), .voice)
        XCTAssertEqual(AudioRoute.Mode(ModePolicy.Profile.media), .media)
    }
}
