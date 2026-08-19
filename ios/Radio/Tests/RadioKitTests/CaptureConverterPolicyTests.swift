import AVFoundation
import XCTest
@testable import RadioKit

/// §5: "the capture converter is rebuilt whenever the input format changes".
/// This is that "whenever", as a pure predicate — the built-in mic runs at
/// 48 kHz and an HFP headset at 8 or 16 kHz, so a route change mid-transmission
/// moves the format under a converter that was built once per transmission.
final class CaptureConverterPolicyTests: XCTestCase {

    private func format(_ sampleRate: Double, channels: AVAudioChannelCount = 1) -> AVAudioFormat {
        AVAudioFormat(
            commonFormat: .pcmFormatFloat32,
            sampleRate: sampleRate,
            channels: channels,
            interleaved: false
        )!
    }

    func testNoConverterAlwaysNeedsABuild() {
        XCTAssertTrue(
            CaptureConverterPolicy.needsRebuild(converterInput: nil, incoming: format(48_000))
        )
    }

    func testTheSameFormatNeedsNothing() {
        XCTAssertFalse(
            CaptureConverterPolicy.needsRebuild(
                converterInput: format(48_000), incoming: format(48_000)
            )
        )
    }

    func testTheBuiltInMicDroppingToHfpNeedsARebuild() {
        // 48 kHz built-in → 16 kHz mSBC: the exact transition that used to
        // raise `audioFailed` mid-transmission.
        XCTAssertTrue(
            CaptureConverterPolicy.needsRebuild(
                converterInput: format(48_000), incoming: format(16_000)
            )
        )
    }

    func testHfpComingBackUpToTheBuiltInMicNeedsARebuild() {
        XCTAssertTrue(
            CaptureConverterPolicy.needsRebuild(
                converterInput: format(8_000), incoming: format(48_000)
            )
        )
    }

    func testAChannelCountChangeNeedsARebuild() {
        XCTAssertTrue(
            CaptureConverterPolicy.needsRebuild(
                converterInput: format(48_000, channels: 1),
                incoming: format(48_000, channels: 2)
            )
        )
    }

    func testASampleFormatChangeNeedsARebuild() {
        let int16 = AVAudioFormat(
            commonFormat: .pcmFormatInt16, sampleRate: 48_000, channels: 1, interleaved: true
        )!
        XCTAssertTrue(
            CaptureConverterPolicy.needsRebuild(converterInput: format(48_000), incoming: int16)
        )
    }
}
