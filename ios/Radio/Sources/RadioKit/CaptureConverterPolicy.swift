import AVFoundation
import Foundation

/// §5: "the capture converter is rebuilt whenever the input format changes
/// (detected via the engine configuration change or a format mismatch in the
/// tap); a mid-transmission change re-routes with a short glitch instead of
/// raising `audioFailed`."
///
/// This is that predicate. It compares only what an `AVAudioConverter` is
/// actually built from — sample rate, channel count, sample format — because
/// `AVAudioFormat`'s own equality also compares layout and interleaving, and a
/// hardware format that reports the same audio differently is not a reason to
/// throw the converter away mid-transmission.
public enum CaptureConverterPolicy {

    public static func needsRebuild(
        converterInput: AVAudioFormat?,
        incoming: AVAudioFormat
    ) -> Bool {
        guard let converterInput else { return true }
        return converterInput.sampleRate != incoming.sampleRate
            || converterInput.channelCount != incoming.channelCount
            || converterInput.commonFormat != incoming.commonFormat
    }
}
