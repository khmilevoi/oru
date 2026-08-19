import Foundation

/// When a return to MEDIA owes the other apps a resume signal — §9 row 5's
/// "music paused by SCO, resumes after linger".
///
/// The bug this exists for is the iOS twin of the Android one: raising the
/// voice link pauses whatever was playing, and on iOS nothing ever tells that
/// app it may play again. Other apps learn that from the system, when the
/// session that interrupted them deactivates with `.notifyOthersOnDeactivation`
/// — and the always-hot session (spec section 10.2) never deactivates. So the
/// return to MEDIA has to put the session down and straight back up on purpose.
///
/// That deactivation is not free: it stops the audio I/O the always-hot radio
/// is built on. This is the gate that keeps it to the one moment where the cost
/// is nothing and the benefit is the user's music — pure, so the moment is
/// asserted in tests rather than discovered on a device.
public enum ResumeNudgePolicy {

    /// - Parameters:
    ///   - previous: the profile in force before this decision.
    ///   - next: the profile the §7 policy asked for.
    ///   - otherAudioWasActive: whether another app was playing when the raise
    ///     took the session to VOICE. Latched then, not sampled now: while the
    ///     link is up the app it paused reports no audio at all, so sampling
    ///     here would answer "nothing to resume" every single time.
    ///   - startsCapture: this same decision opens the microphone — §7's 4 s
    ///     grant timeout restores MEDIA and starts capture on the phone mic in
    ///     one step, and a deactivation under a transmission that is about to
    ///     open is exactly the wrong moment.
    ///   - pttHeld: the button is still down, so a raise may be back at once.
    ///   - transmitting: capture is running.
    ///   - receiving: an incoming burst is playing.
    public static func isWarranted(
        from previous: ModePolicy.Profile,
        to next: ModePolicy.Profile,
        otherAudioWasActive: Bool,
        startsCapture: Bool,
        pttHeld: Bool,
        transmitting: Bool,
        receiving: Bool
    ) -> Bool {
        guard previous == .voice, next == .media else { return false }
        // Nothing was playing: the deactivation would be a glitch for nobody.
        guard otherAudioWasActive else { return false }
        return !startsCapture && !pttHeld && !transmitting && !receiving
    }
}
