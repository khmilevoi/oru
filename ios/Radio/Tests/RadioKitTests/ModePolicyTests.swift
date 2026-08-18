import XCTest
@testable import RadioKit

/// §7 of docs/superpowers/specs/2026-08-18-seamless-headphone-audio-design.md,
/// as a transition table.
///
/// §10 "Shared": `android/app/src/test/java/com/oru/radio/ModePolicyTest.kt` asserts
/// the same rows, with the same names, in the same order. The two files are kept
/// honest mechanically — from the repository root:
///
///     diff <(grep -o 'assertRow("[^"]*"' ios/Radio/Tests/RadioKitTests/ModePolicyTests.swift) \
///          <(grep -o 'assertRow("[^"]*"' android/app/src/test/java/com/oru/radio/ModePolicyTest.kt)
///
/// must print nothing. A row added on one side only is a forked contract, not a test.
final class ModePolicyTests: XCTestCase {

    // MARK: - Table harness

    /// One input to the policy. Mirrors `Input` in ModePolicyTest.kt.
    private enum Input {
        case otherAudio(Bool)
        case radioActive(Bool)
        case routeRequiresVoiceLink(Bool)
        case audioMode(ModePolicy.AudioMode)
        case pttPressed
        case pttReleased
        case voiceLinkEstablished
        case voiceLinkFailed
        case tick
    }

    /// What a step expects of `Decision.nextWakeupMs`. `unchecked` is for steps whose
    /// pending timers a later task changes; `noTimer` asserts nil.
    private enum Wakeup {
        case unchecked
        case noTimer
        case at(Int64)
    }

    private struct Step {
        let atMs: Int64
        let input: Input
        let profile: ModePolicy.Profile
        let actions: [ModePolicy.Action]
        let wakeup: Wakeup

        init(
            _ atMs: Int64,
            _ input: Input,
            _ profile: ModePolicy.Profile,
            _ actions: [ModePolicy.Action] = [],
            _ wakeup: Wakeup = .unchecked
        ) {
            self.atMs = atMs
            self.input = input
            self.profile = profile
            self.actions = actions
            self.wakeup = wakeup
        }
    }

    /// Runs one table row against a fresh policy.
    private func assertRow(
        _ name: String,
        _ steps: [Step],
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        let policy = ModePolicy()
        for (index, step) in steps.enumerated() {
            let decision = feed(policy, step)
            XCTAssertEqual(
                decision.profile, step.profile,
                "\(name) step \(index) profile", file: file, line: line
            )
            XCTAssertEqual(
                decision.actions, step.actions,
                "\(name) step \(index) actions", file: file, line: line
            )
            switch step.wakeup {
            case .unchecked:
                break
            case .noTimer:
                XCTAssertNil(
                    decision.nextWakeupMs,
                    "\(name) step \(index) wakeup", file: file, line: line
                )
            case .at(let ms):
                let expected: Int64? = ms
                XCTAssertEqual(
                    decision.nextWakeupMs, expected,
                    "\(name) step \(index) wakeup", file: file, line: line
                )
            }
        }
    }

    private func feed(_ policy: ModePolicy, _ step: Step) -> ModePolicy.Decision {
        switch step.input {
        case .otherAudio(let active):
            return policy.setOtherAudioActive(active, nowMs: step.atMs)
        case .radioActive(let active):
            return policy.setRadioActive(active, nowMs: step.atMs)
        case .routeRequiresVoiceLink(let requires):
            return policy.setRouteRequiresVoiceLink(requires, nowMs: step.atMs)
        case .audioMode(let mode):
            return policy.setAudioMode(mode, nowMs: step.atMs)
        case .pttPressed:
            return policy.pttPressed(nowMs: step.atMs)
        case .pttReleased:
            return policy.pttReleased(nowMs: step.atMs)
        case .voiceLinkEstablished:
            return policy.voiceLinkEstablished(nowMs: step.atMs)
        case .voiceLinkFailed:
            return policy.voiceLinkFailed(nowMs: step.atMs)
        case .tick:
            return policy.tick(nowMs: step.atMs)
        }
    }

    // MARK: - Constants

    func testConstantsAreTheSpecValues() {
        XCTAssertEqual(ModePolicy.Constants.otherAudioToMediaMs, 2_000)
        XCTAssertEqual(ModePolicy.Constants.otherAudioToVoiceMs, 30_000)
        XCTAssertEqual(ModePolicy.Constants.switchRateLimitMs, 10_000)
        XCTAssertEqual(ModePolicy.Constants.voiceLinkGrantTimeoutMs, 4_000)
        XCTAssertEqual(ModePolicy.Constants.voiceLinkLingerMs, 15_000)
    }

    // MARK: - Defaults and the audioMode pin

    func testFreshPolicyRequestsVoice() {
        assertRow("a fresh policy with no other audio and no external route requests VOICE", [
            Step(0, .tick, .voice, [], .noTimer),
        ])
    }

    func testAudioModeMediaPinsMedia() {
        assertRow("audioMode media pins MEDIA", [
            Step(0, .audioMode(.media), .media, [], .noTimer),
            Step(1_000, .tick, .media, [], .noTimer),
        ])
    }

    func testAudioModeVoicePinsVoice() {
        assertRow("audioMode voice pins VOICE while other audio plays", [
            Step(0, .routeRequiresVoiceLink(true), .voice),
            Step(0, .audioMode(.voice), .voice),
            Step(0, .otherAudio(true), .voice),
            Step(10_000, .tick, .voice, [], .noTimer),
        ])
    }

    func testClearingThePinHandsTheProfileBack() {
        // The second switch is at 10 000 ms, not 1 000: from Task 3 on, the 10 s rate
        // limit would otherwise defer it, and this row is about the pin, not the limit.
        assertRow("clearing the pin hands the profile back to the policy", [
            Step(0, .audioMode(.media), .media, [], .noTimer),
            Step(10_000, .audioMode(.auto), .voice, [], .noTimer),
        ])
    }

    // MARK: - Other-audio hysteresis

    func testTwoSecondsOfOtherAudioSwitchToMedia() {
        assertRow("two seconds of other audio switch VOICE to MEDIA", [
            Step(0, .routeRequiresVoiceLink(true), .voice, [], .noTimer),
            Step(1_000, .otherAudio(true), .voice, [], .at(3_000)),
            Step(3_000, .tick, .media, [], .noTimer),
        ])
    }

    func testShortOtherAudioDoesNotSwitch() {
        assertRow("other audio shorter than two seconds does not switch", [
            Step(0, .routeRequiresVoiceLink(true), .voice, [], .noTimer),
            Step(0, .otherAudio(true), .voice, [], .at(2_000)),
            Step(1_999, .tick, .voice, [], .at(2_000)),
            Step(1_999, .otherAudio(false), .voice, [], .noTimer),
            Step(60_000, .tick, .voice, [], .noTimer),
        ])
    }

    func testAGapRestartsTheDwell() {
        assertRow("a gap in other audio restarts the two second dwell", [
            Step(0, .routeRequiresVoiceLink(true), .voice, [], .noTimer),
            Step(0, .otherAudio(true), .voice, [], .at(2_000)),
            Step(1_500, .otherAudio(false), .voice, [], .noTimer),
            Step(1_600, .otherAudio(true), .voice, [], .at(3_600)),
            Step(3_500, .tick, .voice, [], .at(3_600)),
            Step(3_600, .tick, .media, [], .noTimer),
        ])
    }

    func testThirtySecondsOfSilenceSwitchBack() {
        assertRow("thirty seconds of silence switch MEDIA back to VOICE", [
            Step(0, .routeRequiresVoiceLink(true), .voice, [], .noTimer),
            Step(0, .otherAudio(true), .voice, [], .at(2_000)),
            Step(2_000, .tick, .media, [], .noTimer),
            Step(2_000, .otherAudio(false), .media, [], .at(32_000)),
            Step(31_999, .tick, .media, [], .at(32_000)),
            Step(32_000, .tick, .voice, [], .noTimer),
        ])
    }

    func testShortSilenceKeepsMedia() {
        assertRow("silence shorter than thirty seconds keeps MEDIA", [
            Step(0, .routeRequiresVoiceLink(true), .voice, [], .noTimer),
            Step(0, .otherAudio(true), .voice, [], .at(2_000)),
            Step(2_000, .tick, .media, [], .noTimer),
            Step(2_000, .otherAudio(false), .media, [], .at(32_000)),
            Step(31_999, .tick, .media, [], .at(32_000)),
        ])
    }

    func testOtherAudioRestartingKeepsMedia() {
        assertRow("other audio restarting inside the silence window keeps MEDIA", [
            Step(0, .routeRequiresVoiceLink(true), .voice, [], .noTimer),
            Step(0, .otherAudio(true), .voice, [], .at(2_000)),
            Step(2_000, .tick, .media, [], .noTimer),
            Step(2_000, .otherAudio(false), .media, [], .at(32_000)),
            Step(20_000, .otherAudio(true), .media, [], .noTimer),
            Step(60_000, .tick, .media, [], .noTimer),
        ])
    }

    func testInertRouteKeepsVoice() {
        // §7: "Non-BT-Classic routes have no profile conflict: the policy is inert
        // there." Holding VOICE costs nothing without a conflict and keeps PTT instant.
        assertRow("a route with no voice link keeps VOICE while other audio plays", [
            Step(0, .otherAudio(true), .voice, [], .at(2_000)),
            Step(2_000, .tick, .voice, [], .noTimer),
            Step(3_000, .tick, .voice, [], .noTimer),
        ])
    }

    func testHeadsetConnectingIntoMusicSwitchesAtOnce() {
        // The dwell kept running while the route was inert, so the 2 s is already
        // served when the headset arrives.
        assertRow("a headset connecting while other audio already plays switches to MEDIA at once", [
            Step(0, .otherAudio(true), .voice, [], .at(2_000)),
            Step(2_000, .tick, .voice, [], .noTimer),
            Step(5_000, .routeRequiresVoiceLink(true), .media, [], .noTimer),
        ])
    }

    // MARK: - Radio-idle queuing and the rate limit

    func testASwitchWaitsWhileTheRadioIsBusy() {
        // No timer is reported while the radio is busy: the switch is waiting on an
        // input (the radio going idle), not on a clock.
        assertRow("a switch waits while the radio is busy and applies when it goes idle", [
            Step(0, .routeRequiresVoiceLink(true), .voice, [], .noTimer),
            Step(0, .radioActive(true), .voice, [], .noTimer),
            Step(0, .otherAudio(true), .voice, [], .at(2_000)),
            Step(2_000, .tick, .voice, [], .noTimer),
            Step(5_000, .radioActive(false), .media, [], .noTimer),
        ])
    }

    func testASecondSwitchWaitsForTheRateLimit() {
        assertRow("a second switch inside ten seconds waits for the rate limit", [
            Step(0, .routeRequiresVoiceLink(true), .voice, [], .noTimer),
            Step(0, .otherAudio(true), .voice, [], .at(2_000)),
            Step(2_000, .tick, .media, [], .noTimer),
            Step(3_000, .audioMode(.voice), .media, [], .at(12_000)),
            Step(11_999, .tick, .media, [], .at(12_000)),
            Step(12_000, .tick, .voice, [], .noTimer),
        ])
    }

    func testASwitchAfterTheWindowIsNotDelayed() {
        assertRow("a switch more than ten seconds after the previous one is not delayed", [
            Step(0, .routeRequiresVoiceLink(true), .voice, [], .noTimer),
            Step(0, .otherAudio(true), .voice, [], .at(2_000)),
            Step(2_000, .tick, .media, [], .noTimer),
            Step(12_000, .audioMode(.voice), .voice, [], .noTimer),
        ])
    }

    func testAPinnedModeChangeWaitsForIdle() {
        assertRow("a pinned mode change also waits for the radio to go idle", [
            Step(0, .radioActive(true), .voice, [], .noTimer),
            Step(0, .audioMode(.media), .voice, [], .noTimer),
            Step(1_000, .radioActive(false), .media, [], .noTimer),
        ])
    }

    func testAQueuedSwitchWaitsForBoth() {
        assertRow("a queued switch waits for both the rate limit and the radio", [
            Step(0, .routeRequiresVoiceLink(true), .voice, [], .noTimer),
            Step(0, .otherAudio(true), .voice, [], .at(2_000)),
            Step(2_000, .tick, .media, [], .noTimer),
            Step(3_000, .audioMode(.voice), .media, [], .at(12_000)),
            Step(4_000, .radioActive(true), .media, [], .noTimer),
            Step(20_000, .tick, .media, [], .noTimer),
            Step(21_000, .radioActive(false), .voice, [], .noTimer),
        ])
    }
}
