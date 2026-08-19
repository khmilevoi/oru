import Foundation

/// D2's talk-permit tone, as 16-bit little-endian mono PCM at the radio's own
/// sample rate — the format `OpusFormat.pcm` describes and every player node in
/// `AudioEngine` is connected with.
///
/// Synthesised rather than shipped as an asset: `Package.swift` deliberately
/// declares no `resources:`, and a sine with an envelope has fewer moving parts
/// than a bundle lookup that can fail at runtime. Pure, so the shape is a unit
/// test rather than a listening test.
public enum GrantTone {

    /// How long the rise and the fall take. A hard start or stop on a 1 kHz
    /// sine is an audible click on every headset, and the click is louder than
    /// the tone.
    private static let fadeSeconds = 0.005

    public static func pcm(
        sampleRate: Double = RadioConfig.Audio.sampleRate,
        durationMs: Int = RadioConfig.Audio.grantToneDurationMs,
        frequency: Double = RadioConfig.Audio.grantToneFrequency,
        amplitude: Double = RadioConfig.Audio.grantToneAmplitude
    ) -> Data {
        let frames = Int(sampleRate * Double(durationMs) / 1_000)
        guard frames > 0, sampleRate > 0 else { return Data() }

        let fade = max(1, Int(sampleRate * fadeSeconds))
        let peak = Double(Int16.max)
        var samples = [Int16]()
        samples.reserveCapacity(frames)

        for index in 0..<frames {
            let phase = 2 * Double.pi * frequency * Double(index) / sampleRate
            var envelope = 1.0
            if index < fade {
                envelope = Double(index) / Double(fade)
            }
            let remaining = frames - 1 - index
            if remaining < fade {
                envelope = min(envelope, Double(remaining) / Double(fade))
            }
            let value = sin(phase) * amplitude * envelope * peak
            samples.append(Int16(max(-peak, min(peak, value.rounded()))))
        }

        return samples.withUnsafeBufferPointer { Data(buffer: $0) }
    }
}
