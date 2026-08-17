import AVFoundation
import XCTest
@testable import RadioKit

/// Pure-logic coverage of the two-phase profile detection (detection must
/// precede narrowing — iOS only lists Bluetooth ports once the category
/// options allow them, so phase 1 samples `availableInputs` under the
/// permissive category and phase 2 samples `currentRoute.outputs` after
/// activating under A2DP). AVAudioSession itself is deliberately untested —
/// only the decisions over port types and the option sets each phase applies.
final class AudioSessionProfileTests: XCTestCase {

    // MARK: - Phase 1: permissive detection

    func testPhase1HFPInputDecidesHFPOutright() {
        XCTAssertEqual(
            AudioSessionProfile.afterPermissiveDetection(
                availableInputs: [.builtInMic, .bluetoothHFP]
            ),
            .bluetoothHFP
        )
    }

    func testPhase1HFPAloneIsEnough() {
        XCTAssertEqual(
            AudioSessionProfile.afterPermissiveDetection(
                availableInputs: [.bluetoothHFP]
            ),
            .bluetoothHFP
        )
    }

    func testPhase1NoHFPInputDefersToPhase2() {
        XCTAssertNil(
            AudioSessionProfile.afterPermissiveDetection(
                availableInputs: [.builtInMic]
            )
        )
    }

    func testPhase1EmptyInputsDeferToPhase2() {
        XCTAssertNil(
            AudioSessionProfile.afterPermissiveDetection(availableInputs: [])
        )
    }

    func testPhase1WiredHeadsetMicIsNotBluetooth() {
        XCTAssertNil(
            AudioSessionProfile.afterPermissiveDetection(
                availableInputs: [.builtInMic, .headsetMic]
            )
        )
    }

    // MARK: - Phase 2: post-A2DP-activation route

    func testPhase2A2DPOutputKeepsA2DPProfile() {
        XCTAssertEqual(
            AudioSessionProfile.afterA2DPActivation(
                currentOutputs: [.bluetoothA2DP]
            ),
            .bluetoothA2DP
        )
    }

    func testPhase2BluetoothLEOutputCountsAsA2DPProfile() {
        XCTAssertEqual(
            AudioSessionProfile.afterA2DPActivation(
                currentOutputs: [.bluetoothLE]
            ),
            .bluetoothA2DP
        )
    }

    func testPhase2StrayHFPOutputIsStillNeverSpeakerStomped() {
        // Defensive: phase 1 should have caught HFP, but if the route landed
        // there anyway the headset must keep the audio, not the speaker.
        XCTAssertEqual(
            AudioSessionProfile.afterA2DPActivation(
                currentOutputs: [.bluetoothHFP]
            ),
            .bluetoothA2DP
        )
    }

    func testPhase2SpeakerOutputMeansBuiltIn() {
        XCTAssertEqual(
            AudioSessionProfile.afterA2DPActivation(
                currentOutputs: [.builtInSpeaker]
            ),
            .builtIn
        )
    }

    func testPhase2ReceiverOutputMeansBuiltIn() {
        XCTAssertEqual(
            AudioSessionProfile.afterA2DPActivation(
                currentOutputs: [.builtInReceiver]
            ),
            .builtIn
        )
    }

    func testPhase2WiredHeadphonesMeanBuiltInProfile() {
        // Wired routes need no Bluetooth routing and no speaker override
        // fight — they resolve under the A2DP-allowed option set untouched.
        XCTAssertEqual(
            AudioSessionProfile.afterA2DPActivation(
                currentOutputs: [.headphones]
            ),
            .builtIn
        )
    }

    func testPhase2EmptyOutputsMeanBuiltIn() {
        XCTAssertEqual(
            AudioSessionProfile.afterA2DPActivation(currentOutputs: []),
            .builtIn
        )
    }

    // MARK: - Mid-session device changes (the re-detection sequence)

    func testHeadsetAppearingMidSessionIsCaughtByRerunningPhase1() {
        // The original hardware bug: session starts with no headset, the
        // profile lands on builtIn. An HFP headset then connects. Only
        // because re-detection runs phase 1 under the permissive category
        // again does the headset become visible and win.
        XCTAssertNil(
            AudioSessionProfile.afterPermissiveDetection(
                availableInputs: [.builtInMic]
            )
        )
        XCTAssertEqual(
            AudioSessionProfile.afterA2DPActivation(
                currentOutputs: [.builtInSpeaker]
            ),
            .builtIn
        )
        // ...headset connects, routeChange(.newDeviceAvailable) re-runs
        // detection; phase 1 now sees the HFP input:
        XCTAssertEqual(
            AudioSessionProfile.afterPermissiveDetection(
                availableInputs: [.builtInMic, .bluetoothHFP]
            ),
            .bluetoothHFP
        )
    }

    func testHeadsetDisappearingMidSessionFallsBackThroughBothPhases() {
        // HFP session; the headset disconnects. Re-detection: phase 1 no
        // longer sees an HFP input, phase 2 activates under A2DP and finds
        // only the speaker — built-in, speaker override applied.
        XCTAssertEqual(
            AudioSessionProfile.afterPermissiveDetection(
                availableInputs: [.builtInMic, .bluetoothHFP]
            ),
            .bluetoothHFP
        )
        // ...headset disconnects, routeChange(.oldDeviceUnavailable):
        XCTAssertNil(
            AudioSessionProfile.afterPermissiveDetection(
                availableInputs: [.builtInMic]
            )
        )
        let fallback = AudioSessionProfile.afterA2DPActivation(
            currentOutputs: [.builtInSpeaker]
        )
        XCTAssertEqual(fallback, .builtIn)
        XCTAssertTrue(fallback.wantsSpeakerOverride)
    }

    func testA2DPHeadphonesAppearingMidSessionWinPhase2AndClearTheOverride() {
        // builtIn session (speaker override active); A2DP-only headphones
        // connect. Phase 1 still finds no HFP input; phase 2's activation
        // routes to the headphones — and the override must be cleared, not
        // left stomping them.
        XCTAssertNil(
            AudioSessionProfile.afterPermissiveDetection(
                availableInputs: [.builtInMic]
            )
        )
        let profile = AudioSessionProfile.afterA2DPActivation(
            currentOutputs: [.bluetoothA2DP]
        )
        XCTAssertEqual(profile, .bluetoothA2DP)
        XCTAssertFalse(profile.wantsSpeakerOverride)
    }

    // MARK: - Option sets

    func testPermissiveDetectionOptionsAllowBluetoothHFP() {
        XCTAssertEqual(
            AudioSessionProfile.permissiveDetectionOptions, [.allowBluetooth]
        )
    }

    func testHFPKeepsThePermissiveOptionsSoPhase1NeedsNoSecondSetCategory() {
        XCTAssertEqual(
            AudioSessionProfile.bluetoothHFP.categoryOptions,
            AudioSessionProfile.permissiveDetectionOptions
        )
    }

    func testA2DPAndBuiltInShareTheNarrowedOptionSet() {
        // builtIn is reached WITHOUT a third setCategory — phase 2 narrows to
        // A2DP, activates, and only then learns no Bluetooth output exists.
        XCTAssertEqual(
            AudioSessionProfile.bluetoothA2DP.categoryOptions,
            [.allowBluetoothA2DP]
        )
        XCTAssertEqual(
            AudioSessionProfile.builtIn.categoryOptions, [.allowBluetoothA2DP]
        )
    }

    func testDefaultToSpeakerIsNeverInAnyOptionSet() {
        let all: [AudioSessionProfile] = [.bluetoothHFP, .bluetoothA2DP, .builtIn]
        for profile in all {
            XCTAssertFalse(
                profile.categoryOptions.contains(.defaultToSpeaker),
                "\(profile) must not carry .defaultToSpeaker"
            )
        }
        XCTAssertFalse(
            AudioSessionProfile.permissiveDetectionOptions
                .contains(.defaultToSpeaker)
        )
    }

    func testOnlyBuiltInWantsTheSpeakerOverride() {
        XCTAssertFalse(AudioSessionProfile.bluetoothHFP.wantsSpeakerOverride)
        XCTAssertFalse(AudioSessionProfile.bluetoothA2DP.wantsSpeakerOverride)
        XCTAssertTrue(AudioSessionProfile.builtIn.wantsSpeakerOverride)
    }

    // MARK: - Heartbeat vocabulary

    func testLogNamesAreTheStableGrepVocabulary() {
        XCTAssertEqual(AudioSessionProfile.bluetoothHFP.logName, "hfp")
        XCTAssertEqual(AudioSessionProfile.bluetoothA2DP.logName, "a2dp")
        XCTAssertEqual(AudioSessionProfile.builtIn.logName, "builtIn")
    }
}
