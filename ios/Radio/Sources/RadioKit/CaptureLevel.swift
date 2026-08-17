import AVFoundation
import Foundation

/// Transmit-path software makeup gain (hardware finding 2026-08-17: audio
/// captured on the iPhone arrives quiet on the Android side even with the
/// receiver's volume maxed, while the reverse direction is fine). Pure
/// function so tests cover it without audio hardware.
enum CaptureGain {

    /// Multiplies 16-bit little-endian mono PCM in place by `gain`, hard-
    /// clamping to the Int16 range. `gain == 1.0` is a bit-exact no-op, so
    /// flipping `RadioConfig.Audio.captureGain` back to 1.0 restores the
    /// pre-gain transmit path unchanged.
    static func apply(_ gain: Float, to pcm: inout Data) {
        guard gain != 1.0 else { return }
        pcm.withUnsafeMutableBytes { raw in
            let samples = raw.bindMemory(to: Int16.self)
            for i in samples.indices {
                let scaled = Float(samples[i]) * gain
                let clamped = min(max(scaled, Float(Int16.min)), Float(Int16.max))
                samples[i] = Int16(clamped.rounded())
            }
        }
    }
}

/// Peak/RMS capture metering for heartbeat.log — the evidence trail for the
/// quiet-transmit investigation. Cheap by design: one arithmetic pass per
/// buffer, string formatting only on the sampled flush.
struct LevelMeter {

    private let label: String
    private let interval: TimeInterval
    private var peak: Double = 0
    private var sumSquares: Double = 0
    private var sampleCount = 0
    private var lastFlush: Date?

    init(label: String, interval: TimeInterval) {
        self.label = label
        self.interval = interval
    }

    /// Accumulates one buffer; returns a formatted heartbeat line once per
    /// `interval` (measured from the first buffer consumed), else nil.
    mutating func consume(_ buffer: AVAudioPCMBuffer, now: Date = Date()) -> String? {
        guard let measured = Self.measure(buffer) else { return nil }
        peak = max(peak, measured.peak)
        sumSquares += measured.sumSquares
        sampleCount += measured.samples

        guard let last = lastFlush else {
            lastFlush = now
            return nil
        }
        guard now.timeIntervalSince(last) >= interval, sampleCount > 0 else {
            return nil
        }
        let rms = (sumSquares / Double(sampleCount)).squareRoot()
        let line = String(
            format: "%@ level peak=%.1f rms=%.1f",
            label, Self.dbfs(peak), Self.dbfs(rms)
        )
        peak = 0
        sumSquares = 0
        sampleCount = 0
        lastFlush = now
        return line
    }

    /// dBFS of a linear amplitude in 0...1; silence floors at -120.
    static func dbfs(_ amplitude: Double) -> Double {
        guard amplitude > 0 else { return -120 }
        return max(-120, 20 * log10(amplitude))
    }

    /// Peak and sum-of-squares of channel 0, normalized to full scale.
    /// Handles the two layouts this engine ever sees: the input node's native
    /// Float32 buffers and `OpusFormat.pcm`'s Int16 buffers.
    static func measure(
        _ buffer: AVAudioPCMBuffer
    ) -> (peak: Double, sumSquares: Double, samples: Int)? {
        let count = Int(buffer.frameLength)
        guard count > 0 else { return nil }

        var peak = 0.0
        var sumSquares = 0.0
        if let channels = buffer.floatChannelData {
            let channel = channels[0]
            for i in 0..<count {
                let sample = Double(channel[i])
                peak = max(peak, abs(sample))
                sumSquares += sample * sample
            }
        } else if let channels = buffer.int16ChannelData {
            let channel = channels[0]
            for i in 0..<count {
                let sample = Double(channel[i]) / 32_768.0
                peak = max(peak, abs(sample))
                sumSquares += sample * sample
            }
        } else {
            return nil
        }
        return (peak, sumSquares, count)
    }
}
