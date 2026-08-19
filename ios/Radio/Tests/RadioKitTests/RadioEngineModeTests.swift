import XCTest
@testable import RadioKit

/// §7 as the engine performs it (§10 iOS: the (event, state) → actions story,
/// through the ports' fakes). The transition table itself is P1's
/// `ModePolicyTests`; this asserts that the engine feeds it the right inputs
/// and performs the right outputs.
final class RadioEngineModeTests: XCTestCase {

    private var transport: FakeTransport!
    private var audio: FakeAudio!
    private var ptt: FakePtt!
    private var background: FakeBackground!
    private var clock: ManualClock!
    private var queue: DispatchQueue!
    private var engine: RadioEngine!

    override func setUp() {
        super.setUp()
        transport = FakeTransport()
        audio = FakeAudio()
        ptt = FakePtt()
        background = FakeBackground()
        clock = ManualClock()
        queue = DispatchQueue(label: "radio.engine.mode.tests")
        engine = RadioEngine(
            transport: transport,
            audio: audio,
            ptt: ptt,
            background: background,
            clock: clock,
            queue: queue
        )
        engine.startRadio()
        flush()
    }

    private func flush() {
        queue.sync {}
    }

    /// Advance the injected monotonic clock and fire the soonest timer — the
    /// policy's wakeup, never the 120 s safety cap that is armed alongside it.
    private func advance(to nowMs: Int64) {
        clock.nowMs = nowMs
        clock.fireEarliest()
        flush()
    }

    private let a2dp = AudioRouteSnapshot(
        kind: .bluetooth, label: "AirPods Pro",
        requiresVoiceLink: true, providesVoiceLink: false
    )
    private let hfp = AudioRouteSnapshot(
        kind: .bluetooth, label: "AirPods Pro",
        requiresVoiceLink: true, providesVoiceLink: true
    )
    private let wired = AudioRouteSnapshot(
        kind: .wired, label: nil, requiresVoiceLink: false, providesVoiceLink: false
    )
    private let speaker = AudioRouteSnapshot(
        kind: .speaker, label: nil, requiresVoiceLink: false, providesVoiceLink: false
    )

    /// §9 row 3: headset connected, the user starts music → MEDIA.
    private func reachMedia() {
        background.publishRoute(a2dp)
        flush()
        background.publishOtherAudio(true)
        flush()
        advance(to: ModePolicy.Constants.otherAudioToMediaMs)
        XCTAssertEqual(background.appliedProfiles, [.media])
    }

    // MARK: - Mode switching (§7's hysteresis, §9 rows 3 and 6)

    func testMusicForTwoSecondsMovesTheHeadsetToMedia() {
        reachMedia()
    }

    func testMusicBelowTheDwellChangesNothing() {
        background.publishRoute(a2dp)
        flush()
        background.publishOtherAudio(true)
        flush()

        clock.nowMs = ModePolicy.Constants.otherAudioToMediaMs - 1
        clock.fireEarliest()
        flush()

        XCTAssertEqual(background.appliedProfiles, [])
    }

    func testMusicStoppingComesBackToVoiceAfterThirtySeconds() {
        // §9 row 6: "after 30 s silence, back to VOICE (SCO held, instant PTT)".
        reachMedia()
        background.publishOtherAudio(false)
        flush()

        let silentAt = ModePolicy.Constants.otherAudioToMediaMs
        advance(to: silentAt + ModePolicy.Constants.otherAudioToVoiceMs)

        XCTAssertEqual(background.appliedProfiles, [.media, .voice])
    }

    func testAModeSwitchQueuesUntilTheRadioIsIdle() {
        // §7: "switches never run during receive or transmit (they queue for
        // idle)". §9 row 4: incoming voice during music causes no switch.
        background.publishRoute(a2dp)
        flush()
        transport.delegate?.transport(transport, didStartIncomingAudio: "peer-a")
        flush()
        background.publishOtherAudio(true)
        flush()
        advance(to: ModePolicy.Constants.otherAudioToMediaMs)

        XCTAssertEqual(background.appliedProfiles, [], "no switch while receiving")

        transport.delegate?.transport(transport, didStopIncomingAudio: "peer-a")
        flush()

        XCTAssertEqual(background.appliedProfiles, [.media])
    }

    func testTheAutomaticPolicyIsInertOnARouteWithNoProfileConflict() {
        // §7: "non-BT-Classic routes have no profile conflict: the policy is
        // inert there". Wired headphones plus music must not drop the session
        // into MEDIA.
        background.publishRoute(wired)
        flush()
        background.publishOtherAudio(true)
        flush()
        advance(to: ModePolicy.Constants.otherAudioToMediaMs)

        XCTAssertEqual(background.appliedProfiles, [])
    }

    // MARK: - PTT (§7's "press → tone → talk", D2)

    func testPressOnAWiredRouteTonesAndCapturesImmediately() {
        background.publishRoute(wired)
        flush()

        ptt.delegate?.pttSourceDidPress(ptt)
        flush()

        XCTAssertEqual(audio.grantTones, 1)
        XCTAssertEqual(background.transmitRequests, 1)
        XCTAssertEqual(background.appliedProfiles, [], "already in VOICE, nothing to apply")

        background.grantAudioSession()
        flush()
        XCTAssertTrue(audio.isCapturing)
    }

    func testPressInMediaRaisesTheLinkAndWaitsForTheHeadsetMic() {
        // §9 row 5 / D2: SCO raised → grant tone → headset mic.
        reachMedia()

        ptt.delegate?.pttSourceDidPress(ptt)
        flush()

        XCTAssertEqual(background.appliedProfiles, [.media, .voice], "the raise IS the apply")
        XCTAssertEqual(audio.grantTones, 0, "no tone until the mic path is confirmed")
        XCTAssertEqual(background.transmitRequests, 0)

        background.publishRoute(hfp)
        flush()

        XCTAssertEqual(audio.grantTones, 1)
        XCTAssertEqual(background.transmitRequests, 1)

        background.grantAudioSession()
        flush()
        XCTAssertTrue(audio.isCapturing)
    }

    func testARaiseThatTimesOutTonesAndFallsBackToThePhoneMic() {
        // §7: "Timeout 4 s → grant tone + phone-mic fallback for this
        // transmission." The MEDIA configuration is restored BEFORE the tone,
        // so capture starts on the phone mic — D2 rejects a mid-transmission
        // mic swap.
        reachMedia()
        let pressedAt = ModePolicy.Constants.otherAudioToMediaMs
        ptt.delegate?.pttSourceDidPress(ptt)
        flush()

        advance(to: pressedAt + ModePolicy.Constants.voiceLinkGrantTimeoutMs)

        XCTAssertEqual(background.appliedProfiles, [.media, .voice, .media])
        XCTAssertEqual(audio.grantTones, 1)
        XCTAssertEqual(background.transmitRequests, 1)
    }

    func testTheRouteVanishingDuringARaiseFailsItWithoutWaitingOutTheTimeout() {
        reachMedia()

        ptt.delegate?.pttSourceDidPress(ptt)
        flush()
        background.publishRoute(speaker)
        flush()

        XCTAssertEqual(audio.grantTones, 1, "no four-second wait for a device that left")
        XCTAssertEqual(background.transmitRequests, 1)
    }

    func testTheRaisedLinkLingersAndTheNextPressIsInstant() {
        // §7: "After PTT release, hold the raised link for a 15 s linger;
        // further presses inside the window are instant."
        reachMedia()
        ptt.delegate?.pttSourceDidPress(ptt)
        flush()
        background.publishRoute(hfp)
        flush()
        background.grantAudioSession()
        flush()

        let releasedAt = ModePolicy.Constants.otherAudioToMediaMs
        clock.nowMs = releasedAt
        ptt.delegate?.pttSourceDidRelease(ptt)
        flush()

        XCTAssertEqual(
            background.appliedProfiles, [.media, .voice],
            "the link is held, not dropped"
        )

        clock.nowMs = releasedAt + 1_000
        ptt.delegate?.pttSourceDidPress(ptt)
        flush()

        XCTAssertEqual(audio.grantTones, 2, "instant inside the linger window")
        XCTAssertEqual(background.transmitRequests, 2)
    }

    func testLingerExpiryDropsTheLinkSoMusicResumes() {
        reachMedia()
        ptt.delegate?.pttSourceDidPress(ptt)
        flush()
        background.publishRoute(hfp)
        flush()
        background.grantAudioSession()
        flush()

        let releasedAt = ModePolicy.Constants.otherAudioToMediaMs
        clock.nowMs = releasedAt
        ptt.delegate?.pttSourceDidRelease(ptt)
        flush()

        advance(to: releasedAt + ModePolicy.Constants.voiceLinkLingerMs)

        XCTAssertEqual(background.appliedProfiles, [.media, .voice, .media])
    }

    func testReleasingBeforeTheLinkArrivesNeverTonesAndNeverCaptures() {
        reachMedia()
        ptt.delegate?.pttSourceDidPress(ptt)
        flush()
        ptt.delegate?.pttSourceDidRelease(ptt)
        flush()

        XCTAssertEqual(audio.grantTones, 0)
        XCTAssertEqual(background.transmitRequests, 0)
        XCTAssertFalse(audio.isCapturing)
        XCTAssertEqual(background.appliedProfiles, [.media, .voice, .media])
    }

    // MARK: - Lifetime

    func testStoppingTheRadioForgetsEveryPolicyDeadline() {
        reachMedia()
        engine.stopRadio()
        flush()
        background.publishOtherAudio(false)
        flush()

        let before = background.appliedProfiles
        advance(to: 1_000_000)
        XCTAssertEqual(background.appliedProfiles, before)
    }
}
