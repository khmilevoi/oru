import AVFoundation
import XCTest
@testable import RadioKit

/// D2's talk-permit tone. Synthesised rather than shipped as an asset: the
/// RadioKit package deliberately has no `resources:` (see Package.swift), and a
/// sine with an envelope is fewer moving parts than a bundle lookup.
final class GrantToneTests: XCTestCase {

    func testTheToneIsExactlyAsLongAsItIsConfiguredToBe() {
        let pcm = GrantTone.pcm(sampleRate: 16_000, durationMs: 120)
        // 16 000 Hz * 0.120 s = 1 920 frames of Int16.
        XCTAssertEqual(pcm.count, 1_920 * MemoryLayout<Int16>.size)
    }

    func testTheDefaultToneUsesTheRadioSampleRateAndConfiguredDuration() {
        let frames = Int(
            RadioConfig.Audio.sampleRate * Double(RadioConfig.Audio.grantToneDurationMs) / 1_000
        )
        XCTAssertEqual(GrantTone.pcm().count, frames * MemoryLayout<Int16>.size)
    }

    func testTheToneStartsAndEndsAtSilenceSoItDoesNotClick() {
        let samples = Self.samples(GrantTone.pcm(sampleRate: 16_000, durationMs: 120))
        XCTAssertEqual(samples.first, 0)
        XCTAssertEqual(samples.last, 0)
    }

    func testTheToneIsAudibleInTheMiddle() {
        let samples = Self.samples(GrantTone.pcm(sampleRate: 16_000, durationMs: 120))
        let peak = samples.map { abs(Int($0)) }.max() ?? 0
        XCTAssertGreaterThan(peak, Int(Double(Int16.max) * 0.2))
    }

    func testTheToneNeverClips() {
        let samples = Self.samples(
            GrantTone.pcm(sampleRate: 16_000, durationMs: 120, amplitude: 1.0)
        )
        XCTAssertLessThanOrEqual(samples.map { abs(Int($0)) }.max() ?? 0, Int(Int16.max))
    }

    func testTheToneIsDeterministic() {
        XCTAssertEqual(
            GrantTone.pcm(sampleRate: 16_000, durationMs: 40),
            GrantTone.pcm(sampleRate: 16_000, durationMs: 40)
        )
    }

    func testAZeroLengthToneIsEmptyRatherThanACrash() {
        XCTAssertTrue(GrantTone.pcm(sampleRate: 16_000, durationMs: 0).isEmpty)
    }

    func testTheToneFitsTheEnginesOnlyPcmFormat() {
        // The tone is scheduled on a player node connected with OpusFormat.pcm,
        // so it must be convertible by the same helper the decoder uses.
        XCTAssertNotNil(OpusFormat.buffer(from: GrantTone.pcm()))
    }

    private static func samples(_ data: Data) -> [Int16] {
        data.withUnsafeBytes { Array($0.bindMemory(to: Int16.self)) }
    }
}
