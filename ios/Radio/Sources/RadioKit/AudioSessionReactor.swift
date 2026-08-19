import AVFoundation
import Foundation

/// Everything §5 asks an observer to notice.
///
/// `activationSucceeded` / `activationFailed` are not notifications: they are
/// how the manager reports the outcome of the `activate` action back into the
/// table, so recovery has exactly one definition instead of one per entry point.
public enum AudioSessionEvent: Equatable {
    case activationRequested
    case activationSucceeded
    case activationFailed
    case deactivationRequested
    /// The merged §7 policy asked for a profile (`RadioEngine` → `applyProfile`).
    case profileRequested(ModePolicy.Profile)
    case routeChanged(reason: AVAudioSession.RouteChangeReason)
    case engineConfigurationChanged
    case interruptionBegan
    case interruptionEnded
    case appDidBecomeActive
    case mediaServicesWereReset
    case silenceSecondaryAudioHint
}

/// The manager's whole mutable state, as a value.
///
/// It exists as a value so §5's "closes the current data race on
/// `isActive`/`currentProfile`" is structural rather than a promise: the two
/// fields are only ever replaced wholesale, by the pure function below, on the
/// engine queue.
public struct AudioSessionStatus: Equatable {
    /// What the manager last *did* — AVAudioSession has no public "is active"
    /// getter, which is the same reason `HeartbeatLogger.sessionActive` exists.
    public var isActive: Bool
    /// The configuration in force. §5's mode switches are a re-apply of the
    /// other one.
    public var profile: ModePolicy.Profile

    public init(isActive: Bool = false, profile: ModePolicy.Profile = .voice) {
        self.isActive = isActive
        self.profile = profile
    }
}

/// The side effects the manager performs against AVAudioSession, the engine and
/// its delegate. Naming them instead of performing them inline is what makes
/// §10's "(event, state) → actions reaction table" a unit test.
public enum AudioSessionAction: Equatable {
    /// `setCategory` with one of the two static configurations, diff-only.
    case applyConfiguration(ModePolicy.Profile)
    /// `setActive(true)`, retrying on `.isBusy`; answers with
    /// `activationSucceeded` or `activationFailed`.
    case activate
    case deactivate
    case maximizeInputGain
    /// `overrideOutputAudioPort` from the current outputs.
    case syncSpeakerOverride
    /// Classify the current route and hand it to the delegate, diff-only.
    case publishRoute
    /// Read `isOtherAudioPlaying` and hand it to the delegate, diff-only.
    case sampleOtherAudio
    case rebuildEngine
    case recreateEngine
}

public struct AudioSessionReaction: Equatable {
    public let status: AudioSessionStatus
    public let actions: [AudioSessionAction]

    public init(status: AudioSessionStatus, actions: [AudioSessionAction]) {
        self.status = status
        self.actions = actions
    }
}

/// §5's observers, as one pure function. `AlwaysHotBackgroundManager` is its
/// only caller and does nothing but perform what it returns.
public enum AudioSessionReactor {

    public static func react(
        to event: AudioSessionEvent,
        from status: AudioSessionStatus
    ) -> AudioSessionReaction {
        var next = status

        switch event {
        case .activationRequested:
            return AudioSessionReaction(
                status: next,
                actions: [.applyConfiguration(next.profile), .activate]
            )

        case .activationSucceeded:
            next.isActive = true
            // The one place "the session came up" is defined, whichever entry
            // point got here. Deliberately no rebuild: the first activation of
            // a run happens before `audio.startPlayback()`, and the three
            // recovery rows carry the rebuild themselves.
            return AudioSessionReaction(
                status: next,
                actions: [
                    .maximizeInputGain, .syncSpeakerOverride,
                    .publishRoute, .sampleOtherAudio
                ]
            )

        case .activationFailed:
            // Expected while backgrounded: iOS refuses activation from there.
            // The next foreground or interruption end retries.
            next.isActive = false
            return AudioSessionReaction(status: next, actions: [])

        case .deactivationRequested:
            next.isActive = false
            // §9's first row is the state a stopped radio starts from again.
            next.profile = .voice
            return AudioSessionReaction(status: next, actions: [.deactivate])

        case let .profileRequested(profile):
            guard profile != next.profile else {
                return AudioSessionReaction(status: next, actions: [])
            }
            next.profile = profile
            // No rebuild here: the `setCategory` emits
            // AVAudioEngineConfigurationChange when the hardware format moves,
            // and that notification owns the rebuild (§5, "ride the same
            // rebuild path").
            return AudioSessionReaction(
                status: next,
                actions: [.applyConfiguration(profile), .syncSpeakerOverride, .publishRoute]
            )

        case let .routeChanged(reason):
            guard next.isActive else {
                return AudioSessionReaction(status: next, actions: [])
            }
            switch reason {
            case .newDeviceAvailable, .oldDeviceUnavailable:
                return AudioSessionReaction(
                    status: next,
                    actions: [.syncSpeakerOverride, .publishRoute, .sampleOtherAudio]
                )
            case .categoryChange:
                // Someone else changed the category out from under us.
                return AudioSessionReaction(
                    status: next,
                    actions: [
                        .applyConfiguration(next.profile), .syncSpeakerOverride, .publishRoute
                    ]
                )
            case .override:
                // The echo of our own overrideOutputAudioPort: log only (§5).
                return AudioSessionReaction(status: next, actions: [])
            default:
                // wakeFromSleep, routeConfigurationChange, noSuitableRoute,
                // unknown: these can move the effective route without a device
                // event, and publication is a pure read plus a diff.
                return AudioSessionReaction(status: next, actions: [.publishRoute])
            }

        case .engineConfigurationChanged:
            guard next.isActive else {
                return AudioSessionReaction(status: next, actions: [])
            }
            return AudioSessionReaction(status: next, actions: [.rebuildEngine, .publishRoute])

        case .interruptionBegan:
            next.isActive = false
            return AudioSessionReaction(status: next, actions: [])

        case .interruptionEnded:
            // `shouldResume` is deliberately not consulted: it is advice about
            // resuming playback, and the always-hot session is this app's
            // lifeline. It is logged by the manager, not obeyed.
            //
            // The rebuild follows the activation, never precedes it: an engine
            // cannot start against a session that is not active yet. If the
            // activation failed (backgrounded), the rebuild fails too and is
            // logged — §2 goal 3 — and the next recovery retries.
            return AudioSessionReaction(
                status: next,
                actions: [.applyConfiguration(next.profile), .activate, .rebuildEngine]
            )

        case .appDidBecomeActive:
            guard next.isActive else {
                // §5: `.ended` is not guaranteed, so foregrounding runs the
                // same recovery.
                return AudioSessionReaction(
                    status: next,
                    actions: [.applyConfiguration(next.profile), .activate, .rebuildEngine]
                )
            }
            // A live session only needs a refresh; a setActive and an engine
            // rebuild on every app switch would glitch audio for nothing.
            return AudioSessionReaction(
                status: next,
                actions: [.syncSpeakerOverride, .publishRoute, .sampleOtherAudio]
            )

        case .mediaServicesWereReset:
            // Apple QA1749: every audio object is dead. Rebuild the session
            // first, then throw the engine away and build a new one on top.
            next.isActive = false
            return AudioSessionReaction(
                status: next,
                actions: [.applyConfiguration(next.profile), .activate, .recreateEngine]
            )

        case .silenceSecondaryAudioHint:
            guard next.isActive else {
                return AudioSessionReaction(status: next, actions: [])
            }
            return AudioSessionReaction(status: next, actions: [.sampleOtherAudio])
        }
    }
}
