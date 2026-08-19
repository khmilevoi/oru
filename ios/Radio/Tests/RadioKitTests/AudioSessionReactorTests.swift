import AVFoundation
import XCTest
@testable import RadioKit

/// §10 (iOS): "the (event, state) → actions reaction table". Every row of §5's
/// observer behaviour, asserted without an AVAudioSession in sight.
final class AudioSessionReactorTests: XCTestCase {

    private let inactive = AudioSessionStatus(isActive: false, profile: .voice)
    private let active = AudioSessionStatus(isActive: true, profile: .voice)
    private let activeMedia = AudioSessionStatus(isActive: true, profile: .media)

    private func react(
        _ event: AudioSessionEvent,
        _ status: AudioSessionStatus
    ) -> AudioSessionReaction {
        AudioSessionReactor.react(to: event, from: status)
    }

    // MARK: - Activation

    func testActivationRequestedConfiguresThenActivatesAndClaimsNothingYet() {
        let reaction = react(.activationRequested, inactive)
        XCTAssertEqual(reaction.actions, [.applyConfiguration(.voice), .activate])
        XCTAssertFalse(reaction.status.isActive)
    }

    func testActivationRequestedCarriesTheProfileAlreadyInForce() {
        let reaction = react(.activationRequested, AudioSessionStatus(isActive: false, profile: .media))
        XCTAssertEqual(reaction.actions.first, .applyConfiguration(.media))
    }

    func testActivationSuccessIsTheOnePlaceTheSessionComesUp() {
        let reaction = react(.activationSucceeded, inactive)
        XCTAssertTrue(reaction.status.isActive)
        XCTAssertEqual(
            reaction.actions,
            [.maximizeInputGain, .syncSpeakerOverride, .publishRoute, .sampleOtherAudio]
        )
    }

    func testActivationSuccessNeverRebuildsTheEngine() {
        // The first activation of a run happens BEFORE `audio.startPlayback()`
        // — `RadioEngine.startRadioLocked` calls `background.activate()` first
        // — so a rebuild here would restart a freshly started engine for
        // nothing. The three recovery rows carry it instead.
        XCTAssertFalse(react(.activationSucceeded, inactive).actions.contains(.rebuildEngine))
    }

    func testActivationFailureLeavesTheSessionInactiveAndDoesNothing() {
        let reaction = react(.activationFailed, active)
        XCTAssertFalse(reaction.status.isActive)
        XCTAssertEqual(reaction.actions, [])
    }

    func testDeactivationResetsTheProfileSoTheNextStartBeginsInVoice() {
        // §9's first row: no external device, no music → VOICE.
        let reaction = react(.deactivationRequested, activeMedia)
        XCTAssertEqual(reaction.status, AudioSessionStatus(isActive: false, profile: .voice))
        XCTAssertEqual(reaction.actions, [.deactivate])
    }

    // MARK: - Profile switches (§7's output, §5's mechanism)

    func testAProfileAlreadyInForceIsNotReapplied() {
        // §5: "applied whole (diff-only: skip if already applied)".
        let reaction = react(.profileRequested(.voice), active)
        XCTAssertEqual(reaction.actions, [])
        XCTAssertEqual(reaction.status, active)
    }

    func testAProfileChangeAppliesTheOtherConfigurationAndRepublishes() {
        let reaction = react(.profileRequested(.media), active)
        XCTAssertEqual(reaction.status, AudioSessionStatus(isActive: true, profile: .media))
        XCTAssertEqual(
            reaction.actions,
            [.applyConfiguration(.media), .syncSpeakerOverride, .publishRoute]
        )
    }

    func testAProfileChangeIsRememberedEvenWhileTheSessionIsInactive() {
        // A raise requested during an interruption must survive it: the
        // recovery re-applies `status.profile`.
        let reaction = react(.profileRequested(.media), inactive)
        XCTAssertEqual(reaction.status.profile, .media)
    }

    func testAProfileChangeNeverRebuildsTheEngineItself() {
        // §5: mode switches "ride the same rebuild path" — the setCategory
        // emits AVAudioEngineConfigurationChange when the hardware format
        // moves, and that notification is what rebuilds. Doing it here as well
        // would rebuild twice on every switch.
        let reaction = react(.profileRequested(.media), active)
        XCTAssertFalse(reaction.actions.contains(.rebuildEngine))
    }

    // MARK: - Route changes

    func testADeviceAppearingRecomputesTheOverridePublishesAndSamplesOtherAudio() {
        let reaction = react(.routeChanged(reason: .newDeviceAvailable), active)
        XCTAssertEqual(
            reaction.actions, [.syncSpeakerOverride, .publishRoute, .sampleOtherAudio]
        )
        XCTAssertEqual(reaction.status, active)
    }

    func testADeviceDisappearingDoesExactlyTheSame() {
        // §9: "headset battery dies / walks out of range → immediate
        // loudspeaker + phone mic; no error state." The override recomputation
        // is the whole fallback.
        XCTAssertEqual(
            react(.routeChanged(reason: .oldDeviceUnavailable), active).actions,
            [.syncSpeakerOverride, .publishRoute, .sampleOtherAudio]
        )
    }

    func testAForeignCategoryChangeReappliesOurConfiguration() {
        // §5: "someone else changed it".
        let reaction = react(.routeChanged(reason: .categoryChange), activeMedia)
        XCTAssertEqual(
            reaction.actions,
            [.applyConfiguration(.media), .syncSpeakerOverride, .publishRoute]
        )
    }

    func testOurOwnOverrideEchoDoesNothing() {
        // §5: "`.override` → log only". Reacting would loop: syncSpeakerOverride
        // is what emits this reason in the first place.
        XCTAssertEqual(react(.routeChanged(reason: .override), active).actions, [])
    }

    func testEveryOtherReasonRepublishesWithoutTouchingTheSession() {
        for reason in [
            AVAudioSession.RouteChangeReason.unknown, .wakeFromSleep,
            .noSuitableRouteForCategory, .routeConfigurationChange
        ] {
            XCTAssertEqual(
                react(.routeChanged(reason: reason), active).actions, [.publishRoute],
                "\(reason.rawValue) may change the effective route without a device event"
            )
        }
    }

    func testRouteChangesAreIgnoredWhileTheSessionIsNotActive() {
        for reason in [
            AVAudioSession.RouteChangeReason.newDeviceAvailable, .oldDeviceUnavailable,
            .categoryChange, .routeConfigurationChange
        ] {
            XCTAssertEqual(react(.routeChanged(reason: reason), inactive).actions, [])
        }
    }

    // MARK: - Engine configuration

    func testAnEngineConfigurationChangeRebuildsAndRepublishes() {
        // §5: the one thing nothing observed before. A route change that alters
        // the hardware sample rate stops AVAudioEngine silently, and the
        // keep-alive tap dies with it — which suspends the whole radio.
        XCTAssertEqual(
            react(.engineConfigurationChanged, active).actions, [.rebuildEngine, .publishRoute]
        )
    }

    func testAnEngineConfigurationChangeIsIgnoredWhileInactive() {
        XCTAssertEqual(react(.engineConfigurationChanged, inactive).actions, [])
    }

    // MARK: - Interruptions and recovery

    func testAnInterruptionMarksTheSessionInactiveAndDoesNothingElse() {
        let reaction = react(.interruptionBegan, activeMedia)
        XCTAssertFalse(reaction.status.isActive)
        XCTAssertEqual(reaction.status.profile, .media)
        XCTAssertEqual(reaction.actions, [])
    }

    func testInterruptionEndReappliesTheProfileReactivatesAndRebuilds() {
        // §5: "`.ended` → re-apply profile config, `setActive(true)` with retry
        // on `isBusy`, rebuild/restart the engine, recompute route." The
        // recompute rides on `activationSucceeded`.
        let reaction = react(.interruptionEnded, AudioSessionStatus(isActive: false, profile: .media))
        XCTAssertEqual(
            reaction.actions, [.applyConfiguration(.media), .activate, .rebuildEngine]
        )
        XCTAssertFalse(reaction.status.isActive)
    }

    func testTheRebuildComesAfterTheActivationOnEveryRecoveryRow() {
        // An engine cannot start against a session that is not active yet.
        for event in [
            AudioSessionEvent.interruptionEnded, .appDidBecomeActive, .mediaServicesWereReset
        ] {
            let actions = react(event, inactive).actions
            guard
                let activateIndex = actions.firstIndex(of: .activate),
                let rebuildIndex = actions.firstIndex(where: {
                    $0 == .rebuildEngine || $0 == .recreateEngine
                })
            else {
                return XCTFail("\(event) must both activate and rebuild")
            }
            XCTAssertLessThan(activateIndex, rebuildIndex, "\(event)")
        }
    }

    func testForegroundingAfterAMissedInterruptionEndRunsTheSameRecovery() {
        // §5: "Because `.ended` is not guaranteed, app-foreground also runs the
        // same recovery."
        XCTAssertEqual(
            react(.appDidBecomeActive, inactive).actions,
            react(.interruptionEnded, inactive).actions
        )
    }

    func testForegroundingALiveSessionOnlyRefreshes() {
        // Running setActive and an engine rebuild on every app switch would
        // glitch audio for nothing.
        let reaction = react(.appDidBecomeActive, active)
        XCTAssertEqual(
            reaction.actions, [.syncSpeakerOverride, .publishRoute, .sampleOtherAudio]
        )
        XCTAssertTrue(reaction.status.isActive)
    }

    func testAMediaServicesResetRebuildsTheSessionThenThrowsTheEngineAway() {
        // Apple QA1749: dispose every audio object and rebuild from scratch.
        let reaction = react(.mediaServicesWereReset, activeMedia)
        XCTAssertFalse(reaction.status.isActive)
        XCTAssertEqual(reaction.status.profile, .media)
        XCTAssertEqual(
            reaction.actions, [.applyConfiguration(.media), .activate, .recreateEngine]
        )
    }

    // MARK: - Other audio

    func testTheSilenceHintIsAnEdgeTriggerToResample() {
        // §5: `silenceSecondaryAudioHintNotification` observed as an immediate
        // edge trigger. The hint says "look again", `isOtherAudioPlaying` says
        // what is true.
        XCTAssertEqual(react(.silenceSecondaryAudioHint, active).actions, [.sampleOtherAudio])
        XCTAssertEqual(react(.silenceSecondaryAudioHint, inactive).actions, [])
    }

    // MARK: - Invariants across the whole table

    func testNothingEverMutatesTheSessionWhileItIsInactiveExceptOnPurpose() {
        // The only inactive-status rows that touch the session are the three
        // deliberate recovery entry points and deactivation itself.
        let events: [AudioSessionEvent] = [
            .routeChanged(reason: .newDeviceAvailable),
            .routeChanged(reason: .categoryChange),
            .engineConfigurationChanged,
            .silenceSecondaryAudioHint,
            .interruptionBegan,
            .activationFailed
        ]
        for event in events {
            XCTAssertEqual(react(event, inactive).actions, [], "\(event) must be inert")
        }
    }

    func testTheProfileIsOnlyEverChangedByAProfileRequestOrByDeactivation() {
        let events: [AudioSessionEvent] = [
            .activationRequested, .activationSucceeded, .activationFailed,
            .routeChanged(reason: .newDeviceAvailable), .routeChanged(reason: .categoryChange),
            .engineConfigurationChanged, .interruptionBegan, .interruptionEnded,
            .appDidBecomeActive, .mediaServicesWereReset, .silenceSecondaryAudioHint
        ]
        for event in events {
            XCTAssertEqual(
                react(event, activeMedia).status.profile, .media,
                "\(event) must not move the profile"
            )
        }
    }
}
