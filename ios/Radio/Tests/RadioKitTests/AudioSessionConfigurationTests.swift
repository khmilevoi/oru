import AVFoundation
import XCTest
@testable import RadioKit

/// §5's session-configuration table, its diff-only rule, and the speaker
/// override — the three decisions that replaced the two-phase detection
/// state machine (§11).
final class AudioSessionConfigurationTests: XCTestCase {

    private func port(_ type: AVAudioSession.Port) -> AudioPort {
        AudioPort(type: type)
    }

    // MARK: - The table, verbatim from §5

    func testTheVoiceConfigurationIsPlayAndRecordVoiceChatAllowBluetoothMixWithOthers() {
        XCTAssertEqual(AudioSessionConfiguration.voice.category, .playAndRecord)
        XCTAssertEqual(AudioSessionConfiguration.voice.mode, .voiceChat)
        XCTAssertEqual(AudioSessionConfiguration.voice.options, [.allowBluetooth, .mixWithOthers])
    }

    func testTheMediaConfigurationIsPlayAndRecordDefaultAllowBluetoothA2dpMixWithOthers() {
        XCTAssertEqual(AudioSessionConfiguration.media.category, .playAndRecord)
        XCTAssertEqual(AudioSessionConfiguration.media.mode, .default)
        XCTAssertEqual(AudioSessionConfiguration.media.options, [.allowBluetoothA2DP, .mixWithOthers])
    }

    func testMixWithOthersIsMandatoryInBothProfiles() {
        // §5: it is what lets another app start playing at all — without it a
        // non-mixable player would interrupt and kill the radio session, and
        // MEDIA-mode demand could never be detected.
        XCTAssertTrue(AudioSessionConfiguration.voice.options.contains(.mixWithOthers))
        XCTAssertTrue(AudioSessionConfiguration.media.options.contains(.mixWithOthers))
    }

    func testDefaultToSpeakerIsInNeitherProfile() {
        // The hardware-confirmed iOS 17/18 route-collapse regression: the
        // speaker is an on-demand override, never a category option.
        XCTAssertFalse(AudioSessionConfiguration.voice.options.contains(.defaultToSpeaker))
        XCTAssertFalse(AudioSessionConfiguration.media.options.contains(.defaultToSpeaker))
    }

    func testTheMediaProfileNeverUsesVoiceChat() {
        // §4: `.voiceChat` implicitly enables `.allowBluetooth` (HFP), which
        // would defeat the entire point of the MEDIA profile.
        XCTAssertNotEqual(AudioSessionConfiguration.media.mode, .voiceChat)
    }

    func testEachPolicyProfileMapsToItsConfiguration() {
        XCTAssertEqual(AudioSessionConfiguration.of(.voice), AudioSessionConfiguration.voice)
        XCTAssertEqual(AudioSessionConfiguration.of(.media), AudioSessionConfiguration.media)
    }

    func testLogNamesAreTheStableGrepVocabulary() {
        XCTAssertEqual(AudioSessionConfiguration.voice.logName, "voice")
        XCTAssertEqual(AudioSessionConfiguration.media.logName, "media")
        XCTAssertEqual(AudioSessionConfiguration.mediaDucking.logName, "media+duck")
    }

    // MARK: - Ducking (§5 MEDIA, per incoming burst)

    func testTheDuckingMediaConfigurationIsMediaPlusDuckOthers() {
        // The whole point: an incoming burst must be audible over the user's
        // music, and MEDIA otherwise mixes at full volume.
        XCTAssertEqual(AudioSessionConfiguration.mediaDucking.category, .playAndRecord)
        XCTAssertEqual(AudioSessionConfiguration.mediaDucking.mode, .default)
        XCTAssertEqual(
            AudioSessionConfiguration.mediaDucking.options,
            [.allowBluetoothA2DP, .mixWithOthers, .duckOthers]
        )
    }

    func testDuckingIsNeverStaticOnTheSessionItself() {
        // The session is always hot, so a `.duckOthers` baked into the MEDIA
        // configuration would duck the user's music for the whole run.
        XCTAssertFalse(AudioSessionConfiguration.media.options.contains(.duckOthers))
        XCTAssertFalse(AudioSessionConfiguration.voice.options.contains(.duckOthers))
    }

    func testTheMediaProfileDucksOnlyWhileABurstIsPlaying() {
        XCTAssertEqual(
            AudioSessionConfiguration.of(.media, ducking: true),
            AudioSessionConfiguration.mediaDucking
        )
        XCTAssertEqual(
            AudioSessionConfiguration.of(.media, ducking: false),
            AudioSessionConfiguration.media
        )
    }

    func testTheVoiceProfileHasNothingToDuck() {
        // On VOICE the headset is on HFP: the music app is already out of the
        // way, and `.duckOthers` there would only be a second mechanism.
        XCTAssertEqual(
            AudioSessionConfiguration.of(.voice, ducking: true),
            AudioSessionConfiguration.voice
        )
    }

    func testTheDuckingConfigurationCountsAsAppliedOnceItIsInForce() {
        XCTAssertTrue(
            AudioSessionConfiguration.mediaDucking.matches(
                category: .playAndRecord, mode: .default,
                options: [.allowBluetoothA2DP, .mixWithOthers, .duckOthers]
            )
        )
    }

    func testALeftoverDuckMeansTheConfigurationMustBeApplied() {
        // The un-duck is the one apply the superset test would otherwise skip:
        // the ducking options are a superset of MEDIA's, so nothing but an
        // explicit "this option must be absent" rule can end a duck.
        XCTAssertFalse(
            AudioSessionConfiguration.media.matches(
                category: .playAndRecord, mode: .default,
                options: [.allowBluetoothA2DP, .mixWithOthers, .duckOthers]
            )
        )
    }

    func testAMissingDuckMeansTheDuckingConfigurationMustBeApplied() {
        XCTAssertFalse(
            AudioSessionConfiguration.mediaDucking.matches(
                category: .playAndRecord, mode: .default,
                options: [.allowBluetoothA2DP, .mixWithOthers]
            )
        )
    }

    // MARK: - Diff-only

    func testAConfigurationAlreadyInForceIsNotReapplied() {
        XCTAssertTrue(
            AudioSessionConfiguration.voice.matches(
                category: .playAndRecord, mode: .voiceChat,
                options: [.allowBluetooth, .mixWithOthers]
            )
        )
    }

    func testImpliedExtraOptionsStillCountAsApplied() {
        // `.voiceChat` implies `.allowBluetooth`, and iOS reports options we
        // never asked for. Demanding equality would re-apply the category on
        // every single `.categoryChange`, forever.
        XCTAssertTrue(
            AudioSessionConfiguration.voice.matches(
                category: .playAndRecord, mode: .voiceChat,
                options: [.allowBluetooth, .allowBluetoothA2DP, .mixWithOthers]
            )
        )
    }

    func testAMissingOptionMeansTheConfigurationMustBeApplied() {
        XCTAssertFalse(
            AudioSessionConfiguration.voice.matches(
                category: .playAndRecord, mode: .voiceChat, options: [.allowBluetooth]
            )
        )
    }

    func testTheOtherProfilesModeNeverCountsAsApplied() {
        // This is what makes a VOICE ↔ MEDIA switch actually happen: the two
        // configurations always differ in `mode`.
        XCTAssertFalse(
            AudioSessionConfiguration.media.matches(
                category: .playAndRecord, mode: .voiceChat,
                options: [.allowBluetooth, .allowBluetoothA2DP, .mixWithOthers]
            )
        )
        XCTAssertFalse(
            AudioSessionConfiguration.voice.matches(
                category: .playAndRecord, mode: .default,
                options: [.allowBluetooth, .allowBluetoothA2DP, .mixWithOthers]
            )
        )
    }

    func testAForeignCategoryMeansTheConfigurationMustBeApplied() {
        XCTAssertFalse(
            AudioSessionConfiguration.voice.matches(
                category: .playback, mode: .voiceChat,
                options: [.allowBluetooth, .mixWithOthers]
            )
        )
    }

    // MARK: - The speaker override (the wired-headphones fix)

    func testOnlyAReceiverOnlyRouteIsOverriddenToTheSpeaker() {
        XCTAssertEqual(
            AudioSessionConfiguration.speakerOverride(forOutputs: [port(.builtInReceiver)]),
            .speaker
        )
    }

    func testWiredHeadphonesKeepTheAudioTheyUsedToLose() {
        // The bug this whole plan exists for: wired headphones were classified
        // `.builtIn` and then force-overridden to the loudspeaker.
        XCTAssertEqual(
            AudioSessionConfiguration.speakerOverride(forOutputs: [port(.headphones)]),
            AVAudioSession.PortOverride.none
        )
    }

    func testEveryExternalOutputClearsTheOverride() {
        for type in [
            AVAudioSession.Port.headphones, .bluetoothHFP, .bluetoothA2DP,
            .bluetoothLE, .usbAudio, .carAudio, .airPlay, .HDMI, .lineOut
        ] {
            XCTAssertEqual(
                AudioSessionConfiguration.speakerOverride(forOutputs: [port(type)]),
                AVAudioSession.PortOverride.none,
                "\(type.rawValue) is external and must never be speaker-stomped"
            )
        }
    }

    func testAnExternalOutputAlongsideTheReceiverStillClearsTheOverride() {
        XCTAssertEqual(
            AudioSessionConfiguration.speakerOverride(
                forOutputs: [port(.builtInReceiver), port(.bluetoothA2DP)]
            ),
            AVAudioSession.PortOverride.none
        )
    }

    func testTheSpeakerOverrideIsIdempotentOnceApplied() {
        // `overrideOutputAudioPort(.speaker)` moves `currentRoute.outputs` from
        // `[builtInReceiver]` to `[builtInSpeaker]`. If `builtInSpeaker`
        // answered `.none` here, every re-evaluation after the override took
        // effect would immediately clear it again.
        XCTAssertEqual(
            AudioSessionConfiguration.speakerOverride(forOutputs: [port(.builtInSpeaker)]),
            .speaker
        )
    }

    func testReEvaluatingAfterTheOverrideTakesEffectStaysAtSpeaker() {
        // Feed the function its own consequence: the answer for a
        // receiver-only route, applied, produces a speaker-only route: assert
        // that re-evaluating against that route answers `.speaker` again
        // rather than oscillating back to `.none`.
        let firstAnswer = AudioSessionConfiguration.speakerOverride(
            forOutputs: [port(.builtInReceiver)]
        )
        XCTAssertEqual(firstAnswer, .speaker)

        let routeAfterApplyingTheOverride = [port(.builtInSpeaker)]
        XCTAssertEqual(
            AudioSessionConfiguration.speakerOverride(forOutputs: routeAfterApplyingTheOverride),
            .speaker
        )
    }

    func testASpeakerAlongsideAnExternalOutputStillClearsTheOverride() {
        XCTAssertEqual(
            AudioSessionConfiguration.speakerOverride(
                forOutputs: [port(.builtInSpeaker), port(.headphones)]
            ),
            AVAudioSession.PortOverride.none
        )
    }

    func testAnEmptyRouteNeedsNoOverride() {
        XCTAssertEqual(
            AudioSessionConfiguration.speakerOverride(forOutputs: []),
            AVAudioSession.PortOverride.none
        )
    }
}
