import AVFoundation
import Foundation

/// Whether the input node's format may be handed to `installTap`.
///
/// `AVAudioNode.installTap` does not report a bad format as a Swift error: it
/// raises an ObjC `NSException` ("Failed to create tap due to format mismatch",
/// -10868), which no `do`/`catch` in this package can catch and which therefore
/// aborts the process — the 2026-08-19 device crash, one route change after a
/// Bluetooth headset appeared. The mismatch has to be caught BEFORE the call,
/// and this is where. Everything it rejects becomes a `RadioError` the rebuild
/// path already handles: logged, no delegate failure, retried on the next route
/// change, interruption end or foreground.
///
/// It is a pure predicate over two numbers so it can be tested without a device
/// — the crash itself is only reachable on real hardware.
public enum InputFormatPolicy {

    /// `sessionSampleRate` is `AVAudioSession.sharedInstance().sampleRate`: the
    /// rate the hardware is actually running at right now.
    public static func validate(
        _ format: AVAudioFormat,
        sessionSampleRate: Double
    ) throws {
        try validate(
            sampleRate: format.sampleRate,
            channelCount: format.channelCount,
            sessionSampleRate: sessionSampleRate
        )
    }

    public static func validate(
        sampleRate: Double,
        channelCount: AVAudioChannelCount,
        sessionSampleRate: Double
    ) throws {
        guard sampleRate > 0, channelCount > 0 else {
            throw RadioError.audioFailed("no usable microphone format")
        }
        // The stale-route case. An AVAudioEngine that has already resolved its
        // input node keeps reporting the DEAD route's format after the hardware
        // moves — `rebuildEngine(recreate: true)` is what fixes that, and this
        // is the second line of defence for every path that still reuses an
        // engine. A `sessionSampleRate` of 0 means "no route resolved yet", not
        // a mismatch: refusing then would leave the radio with no keep-alive tap
        // and no background execution over a comparison against nothing.
        guard sessionSampleRate <= 0 || sampleRate == sessionSampleRate else {
            throw RadioError.audioFailed(
                "stale microphone format: node \(Int(sampleRate)) Hz, "
                    + "session \(Int(sessionSampleRate)) Hz"
            )
        }
    }
}
