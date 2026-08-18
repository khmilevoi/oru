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

    // MARK: - PTT, the grant tone and the raise

    func testPttInVoiceIsImmediate() {
        assertRow("PTT in VOICE plays the grant tone and starts capture at once", [
            Step(0, .pttPressed, .voice, [.playGrantTone, .startCapture(.routeDefault)], .noTimer),
            Step(500, .radioActive(true), .voice, [], .noTimer),
            Step(3_000, .pttReleased, .voice, [], .noTimer),
        ])
    }

    func testPttOnAnInertRouteIsImmediate() {
        assertRow("PTT on a route with no voice link is immediate even in MEDIA", [
            Step(0, .audioMode(.media), .media, [], .noTimer),
            Step(1_000, .pttPressed, .media, [.playGrantTone, .startCapture(.routeDefault)], .noTimer),
            Step(3_000, .pttReleased, .media, [], .noTimer),
        ])
    }

    func testPttInMediaRaisesTheLink() {
        assertRow("PTT in MEDIA on a voice link route raises the link and waits", [
            Step(0, .routeRequiresVoiceLink(true), .voice, [], .noTimer),
            Step(0, .otherAudio(true), .voice, [], .at(2_000)),
            Step(2_000, .tick, .media, [], .noTimer),
            Step(3_000, .pttPressed, .voice, [.raiseVoiceLink], .at(7_000)),
            Step(4_000, .tick, .voice, [], .at(7_000)),
        ])
    }

    func testTheToneFollowsTheEstablishedLink() {
        assertRow("the grant tone follows the established link and capture uses the route mic", [
            Step(0, .routeRequiresVoiceLink(true), .voice, [], .noTimer),
            Step(0, .otherAudio(true), .voice, [], .at(2_000)),
            Step(2_000, .tick, .media, [], .noTimer),
            Step(3_000, .pttPressed, .voice, [.raiseVoiceLink], .at(7_000)),
            Step(3_500, .voiceLinkEstablished, .voice,
                 [.playGrantTone, .startCapture(.routeDefault)], .noTimer),
        ])
    }

    func testALinkThatNeverComesUpTimesOut() {
        assertRow("a link that never comes up times out after four seconds into the phone mic", [
            Step(0, .routeRequiresVoiceLink(true), .voice, [], .noTimer),
            Step(0, .otherAudio(true), .voice, [], .at(2_000)),
            Step(2_000, .tick, .media, [], .noTimer),
            Step(3_000, .pttPressed, .voice, [.raiseVoiceLink], .at(7_000)),
            Step(6_999, .tick, .voice, [], .at(7_000)),
            Step(7_000, .tick, .media,
                 [.dropVoiceLink, .playGrantTone, .startCapture(.phoneFallback)], .noTimer),
            Step(10_000, .pttReleased, .media, [], .noTimer),
        ])
    }

    func testAnImmediateFailureFallsBackAtOnce() {
        assertRow("an immediate link failure falls back to the phone mic without waiting", [
            Step(0, .routeRequiresVoiceLink(true), .voice, [], .noTimer),
            Step(0, .otherAudio(true), .voice, [], .at(2_000)),
            Step(2_000, .tick, .media, [], .noTimer),
            Step(3_000, .pttPressed, .voice, [.raiseVoiceLink], .at(7_000)),
            Step(3_100, .voiceLinkFailed, .media,
                 [.dropVoiceLink, .playGrantTone, .startCapture(.phoneFallback)], .noTimer),
        ])
    }

    func testReleasingBeforeTheLinkCancelsIt() {
        // The tone means "you may talk" and the user already let go, so there is none.
        assertRow("releasing before the link comes up abandons the raise with no tone", [
            Step(0, .routeRequiresVoiceLink(true), .voice, [], .noTimer),
            Step(0, .otherAudio(true), .voice, [], .at(2_000)),
            Step(2_000, .tick, .media, [], .noTimer),
            Step(3_000, .pttPressed, .voice, [.raiseVoiceLink], .at(7_000)),
            Step(3_500, .pttReleased, .media, [.dropVoiceLink], .noTimer),
            Step(7_000, .tick, .media, [], .noTimer),
        ])
    }

    func testASecondPressWhileRaisingIsIgnored() {
        assertRow("a second press while the link is being raised is ignored", [
            Step(0, .routeRequiresVoiceLink(true), .voice, [], .noTimer),
            Step(0, .otherAudio(true), .voice, [], .at(2_000)),
            Step(2_000, .tick, .media, [], .noTimer),
            Step(3_000, .pttPressed, .voice, [.raiseVoiceLink], .at(7_000)),
            Step(3_100, .pttPressed, .voice, [], .at(7_000)),
        ])
    }

    // MARK: - The linger and the drop

    func testTheRaisedLinkLingers() {
        assertRow("the raised link lingers fifteen seconds after release", [
            Step(0, .routeRequiresVoiceLink(true), .voice, [], .noTimer),
            Step(0, .otherAudio(true), .voice, [], .at(2_000)),
            Step(2_000, .tick, .media, [], .noTimer),
            Step(3_000, .pttPressed, .voice, [.raiseVoiceLink], .at(7_000)),
            Step(3_500, .voiceLinkEstablished, .voice,
                 [.playGrantTone, .startCapture(.routeDefault)], .noTimer),
            Step(5_000, .pttReleased, .voice, [], .at(20_000)),
            Step(19_999, .tick, .voice, [], .at(20_000)),
        ])
    }

    func testAPressInsideTheLingerIsInstant() {
        assertRow("a press inside the linger window is instant", [
            Step(0, .routeRequiresVoiceLink(true), .voice, [], .noTimer),
            Step(0, .otherAudio(true), .voice, [], .at(2_000)),
            Step(2_000, .tick, .media, [], .noTimer),
            Step(3_000, .pttPressed, .voice, [.raiseVoiceLink], .at(7_000)),
            Step(3_500, .voiceLinkEstablished, .voice,
                 [.playGrantTone, .startCapture(.routeDefault)], .noTimer),
            Step(5_000, .pttReleased, .voice, [], .at(20_000)),
            Step(10_000, .pttPressed, .voice,
                 [.playGrantTone, .startCapture(.routeDefault)], .noTimer),
        ])
    }

    func testTheLingerRestartsOnEveryRelease() {
        assertRow("the linger restarts on every release", [
            Step(0, .routeRequiresVoiceLink(true), .voice, [], .noTimer),
            Step(0, .otherAudio(true), .voice, [], .at(2_000)),
            Step(2_000, .tick, .media, [], .noTimer),
            Step(3_000, .pttPressed, .voice, [.raiseVoiceLink], .at(7_000)),
            Step(3_500, .voiceLinkEstablished, .voice,
                 [.playGrantTone, .startCapture(.routeDefault)], .noTimer),
            Step(5_000, .pttReleased, .voice, [], .at(20_000)),
            Step(10_000, .pttPressed, .voice,
                 [.playGrantTone, .startCapture(.routeDefault)], .noTimer),
            Step(12_000, .pttReleased, .voice, [], .at(27_000)),
        ])
    }

    func testTheLinkDropsWhenTheLingerExpires() {
        assertRow("the link drops when the linger expires and MEDIA returns", [
            Step(0, .routeRequiresVoiceLink(true), .voice, [], .noTimer),
            Step(0, .otherAudio(true), .voice, [], .at(2_000)),
            Step(2_000, .tick, .media, [], .noTimer),
            Step(3_000, .pttPressed, .voice, [.raiseVoiceLink], .at(7_000)),
            Step(3_500, .voiceLinkEstablished, .voice,
                 [.playGrantTone, .startCapture(.routeDefault)], .noTimer),
            Step(5_000, .pttReleased, .voice, [], .at(20_000)),
            Step(20_000, .tick, .media, [.dropVoiceLink], .noTimer),
        ])
    }

    func testAFallbackTransmissionDoesNotLinger() {
        assertRow("a phone mic fallback transmission does not linger", [
            Step(0, .routeRequiresVoiceLink(true), .voice, [], .noTimer),
            Step(0, .otherAudio(true), .voice, [], .at(2_000)),
            Step(2_000, .tick, .media, [], .noTimer),
            Step(3_000, .pttPressed, .voice, [.raiseVoiceLink], .at(7_000)),
            Step(7_000, .tick, .media,
                 [.dropVoiceLink, .playGrantTone, .startCapture(.phoneFallback)], .noTimer),
            Step(10_000, .pttReleased, .media, [], .noTimer),
            Step(40_000, .tick, .media, [], .noTimer),
        ])
    }

    func testTheDropWaitsForIdle() {
        // §7 exempts the raise/drop from the 10 s rate limit by name, not from the
        // "switches never run during receive or transmit" rule in the same bullet.
        assertRow("the linger drop waits for the radio to go idle", [
            Step(0, .routeRequiresVoiceLink(true), .voice, [], .noTimer),
            Step(0, .otherAudio(true), .voice, [], .at(2_000)),
            Step(2_000, .tick, .media, [], .noTimer),
            Step(3_000, .pttPressed, .voice, [.raiseVoiceLink], .at(7_000)),
            Step(3_500, .voiceLinkEstablished, .voice,
                 [.playGrantTone, .startCapture(.routeDefault)], .noTimer),
            Step(5_000, .pttReleased, .voice, [], .at(20_000)),
            Step(10_000, .radioActive(true), .voice, [], .at(20_000)),
            Step(20_000, .tick, .voice, [], .noTimer),
            Step(25_000, .radioActive(false), .media, [.dropVoiceLink], .noTimer),
        ])
    }

    func testTheRaiseIsExemptFromTheRateLimit() {
        // The raise happens 500 ms after a policy switch and is not deferred; the drop
        // does not stamp the limit either, which the last step proves — a policy switch
        // 100 ms after the drop is applied at once.
        assertRow("the raise is exempt from the rate limit and the drop does not consume it", [
            Step(0, .routeRequiresVoiceLink(true), .voice, [], .noTimer),
            Step(0, .otherAudio(true), .voice, [], .at(2_000)),
            Step(2_000, .tick, .media, [], .noTimer),
            Step(2_500, .pttPressed, .voice, [.raiseVoiceLink], .at(6_500)),
            Step(2_600, .voiceLinkEstablished, .voice,
                 [.playGrantTone, .startCapture(.routeDefault)], .noTimer),
            Step(2_700, .pttReleased, .voice, [], .at(17_700)),
            Step(17_700, .tick, .media, [.dropVoiceLink], .noTimer),
            Step(17_800, .audioMode(.voice), .voice, [], .noTimer),
        ])
    }

    func testTheLinkIsKeptWhenThePolicyWantsVoice() {
        assertRow("the link is kept when the policy wants VOICE by the time the linger expires", [
            Step(0, .routeRequiresVoiceLink(true), .voice, [], .noTimer),
            Step(0, .otherAudio(true), .voice, [], .at(2_000)),
            Step(2_000, .tick, .media, [], .noTimer),
            Step(3_000, .pttPressed, .voice, [.raiseVoiceLink], .at(7_000)),
            Step(3_100, .voiceLinkEstablished, .voice,
                 [.playGrantTone, .startCapture(.routeDefault)], .noTimer),
            Step(3_200, .otherAudio(false), .voice, [], .at(33_200)),
            Step(4_000, .pttReleased, .voice, [], .at(19_000)),
            Step(18_000, .pttPressed, .voice,
                 [.playGrantTone, .startCapture(.routeDefault)], .at(33_200)),
            Step(19_000, .pttReleased, .voice, [], .at(33_200)),
            Step(33_200, .tick, .voice, [], .at(34_000)),
            Step(34_000, .tick, .voice, [], .noTimer),
        ])
    }

    func testPttRaisesInsideAPinnedMediaMode() {
        assertRow("PTT raises the link inside a pinned media mode", [
            Step(0, .routeRequiresVoiceLink(true), .voice, [], .noTimer),
            Step(0, .audioMode(.media), .media, [], .noTimer),
            Step(1_000, .pttPressed, .voice, [.raiseVoiceLink], .at(5_000)),
            Step(1_500, .voiceLinkEstablished, .voice,
                 [.playGrantTone, .startCapture(.routeDefault)], .noTimer),
            Step(2_000, .pttReleased, .voice, [], .at(17_000)),
            Step(17_000, .tick, .media, [.dropVoiceLink], .noTimer),
        ])
    }

    // MARK: - §9 behaviour contract, as compositions

    func testSection9MusicThenPttThenMusicStops() {
        // §9 rows: "BT headset connects, no music"; "user starts music"; "incoming voice
        // during music"; "PTT press during music"; "music stops".
        assertRow("section 9 headset connects then music starts then PTT then music stops", [
            Step(0, .routeRequiresVoiceLink(true), .voice, [], .noTimer),
            Step(5_000, .otherAudio(true), .voice, [], .at(7_000)),
            Step(7_000, .tick, .media, [], .noTimer),
            Step(10_000, .radioActive(true), .media, [], .noTimer),
            Step(13_000, .radioActive(false), .media, [], .noTimer),
            Step(20_000, .pttPressed, .voice, [.raiseVoiceLink], .at(24_000)),
            Step(21_500, .voiceLinkEstablished, .voice,
                 [.playGrantTone, .startCapture(.routeDefault)], .noTimer),
            Step(21_500, .radioActive(true), .voice, [], .noTimer),
            Step(25_000, .pttReleased, .voice, [], .at(40_000)),
            Step(25_000, .radioActive(false), .voice, [], .at(40_000)),
            Step(40_000, .tick, .media, [.dropVoiceLink], .noTimer),
            Step(45_000, .otherAudio(false), .media, [], .at(75_000)),
            Step(75_000, .tick, .voice, [], .noTimer),
        ])
    }

    func testSection9HeadsetDiesDuringTheLinger() {
        // §9 row: "Headset battery dies / walks out of range → immediate loudspeaker +
        // phone mic; no error state". The link is not dropped on the way out: with no
        // headset there is no profile conflict, so VOICE is where the policy belongs.
        assertRow("section 9 the headset dies during the linger", [
            Step(0, .routeRequiresVoiceLink(true), .voice, [], .noTimer),
            Step(0, .otherAudio(true), .voice, [], .at(2_000)),
            Step(2_000, .tick, .media, [], .noTimer),
            Step(3_000, .pttPressed, .voice, [.raiseVoiceLink], .at(7_000)),
            Step(3_500, .voiceLinkEstablished, .voice,
                 [.playGrantTone, .startCapture(.routeDefault)], .noTimer),
            Step(5_000, .pttReleased, .voice, [], .at(20_000)),
            Step(8_000, .routeRequiresVoiceLink(false), .voice, [], .at(20_000)),
            Step(20_000, .tick, .voice, [], .noTimer),
        ])
    }

    func testSection9IncomingVoiceDuringMusicNeverSwitches() {
        // §9 row: "Incoming voice during music → voice plays into the A2DP stream; no
        // profile switch".
        assertRow("section 9 incoming voice during other audio never switches the profile", [
            Step(0, .routeRequiresVoiceLink(true), .voice, [], .noTimer),
            Step(0, .otherAudio(true), .voice, [], .at(2_000)),
            Step(2_000, .tick, .media, [], .noTimer),
            Step(3_000, .radioActive(true), .media, [], .noTimer),
            Step(9_000, .radioActive(false), .media, [], .noTimer),
            Step(9_000, .tick, .media, [], .noTimer),
        ])
    }
}
