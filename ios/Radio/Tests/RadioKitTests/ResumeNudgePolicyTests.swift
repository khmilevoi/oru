import XCTest
@testable import RadioKit

/// §9 row 5's second half — "music … resumes after linger" — as a pure
/// decision, so the one thing that can silence a user's music for good is
/// asserted here rather than discovered on a device.
final class ResumeNudgePolicyTests: XCTestCase {

    /// The warranted case, with every gate open. Each test closes exactly one.
    private func isWarranted(
        from previous: ModePolicy.Profile = .voice,
        to next: ModePolicy.Profile = .media,
        otherAudioWasActive: Bool = true,
        startsCapture: Bool = false,
        pttHeld: Bool = false,
        transmitting: Bool = false,
        receiving: Bool = false
    ) -> Bool {
        ResumeNudgePolicy.isWarranted(
            from: previous,
            to: next,
            otherAudioWasActive: otherAudioWasActive,
            startsCapture: startsCapture,
            pttHeld: pttHeld,
            transmitting: transmitting,
            receiving: receiving
        )
    }

    func testTheLingerReturningToMediaOwesTheMusicAppAResumeSignal() {
        // The bug: the always-hot session never deactivates, so nothing ever
        // tells the paused music app it may play again.
        XCTAssertTrue(isWarranted())
    }

    func testOnlyTheVoiceToMediaReturnQualifies() {
        XCTAssertFalse(isWarranted(from: .media, to: .voice), "the raise itself")
        XCTAssertFalse(isWarranted(from: .media, to: .media))
        XCTAssertFalse(isWarranted(from: .voice, to: .voice))
    }

    func testNothingIsNudgedWhenNothingWasPlaying() {
        // Deactivating the session is not free: it is only worth a glitch when
        // there is a paused app on the other end of it.
        XCTAssertFalse(isWarranted(otherAudioWasActive: false))
    }

    func testTheGrantTimeoutFallbackIsNeverNudged() {
        // §7's 4 s timeout restores MEDIA and starts capture on the phone mic
        // in the same decision: deactivating the session under a transmission
        // that is about to open is exactly the wrong moment.
        XCTAssertFalse(isWarranted(startsCapture: true))
    }

    func testAHeldButtonIsNeverNudged() {
        XCTAssertFalse(isWarranted(pttHeld: true))
    }

    func testALiveRadioIsNeverNudged() {
        XCTAssertFalse(isWarranted(transmitting: true))
        XCTAssertFalse(isWarranted(receiving: true))
    }
}
