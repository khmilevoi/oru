import AVFoundation
import XCTest
@testable import RadioKit

/// The second layer of the 2026-08-19 tap-format crash fix. `installTap` raises
/// an ObjC exception — not a Swift error — when the format handed to it does not
/// match what the input node is actually delivering, and an ObjC exception
/// aborts the process. So the mismatch has to be detected BEFORE the call, as
/// this predicate, and turned into a `RadioError` the rebuild path already
/// catches and retries on the next route event.
final class InputFormatPolicyTests: XCTestCase {

    private func format(
        _ sampleRate: Double,
        channels: AVAudioChannelCount = 1
    ) -> AVAudioFormat {
        AVAudioFormat(
            commonFormat: .pcmFormatFloat32,
            sampleRate: sampleRate,
            channels: channels,
            interleaved: false
        )!
    }

    private func rejection(
        _ block: @autoclosure () throws -> Void,
        file: StaticString = #filePath,
        line: UInt = #line
    ) -> RadioError? {
        var captured: RadioError?
        XCTAssertThrowsError(try block(), file: file, line: line) { error in
            captured = error as? RadioError
        }
        return captured
    }

    func testTheFormatTheSessionIsRunningAtIsUsable() {
        XCTAssertNoThrow(
            try InputFormatPolicy.validate(format(48_000), sessionSampleRate: 48_000)
        )
    }

    func testASilentInputNodeIsRejected() {
        // A node with no resolved route reports 0 Hz / 0 channels, which no
        // `AVAudioFormat` initializer will build — hence the scalar entry point.
        let error = rejection(
            try InputFormatPolicy.validate(
                sampleRate: 0, channelCount: 0, sessionSampleRate: 48_000
            )
        )
        XCTAssertEqual(error?.code, "audio_failed")
    }

    func testAChannellessFormatIsRejectedEvenAtAPlausibleRate() {
        // The shape the crashing device actually reported: a rate survives the
        // route teardown, the channel count does not.
        XCTAssertNotNil(
            rejection(
                try InputFormatPolicy.validate(
                    sampleRate: 48_000, channelCount: 0, sessionSampleRate: 48_000
                )
            )
        )
    }

    func testTheDeadRoutesFormatIsRejected() {
        // Built-in mic (48 kHz) still cached on the node, HFP headset (16 kHz)
        // already in force on the session: the exact -10868 abort.
        let error = rejection(
            try InputFormatPolicy.validate(format(48_000), sessionSampleRate: 16_000)
        )
        XCTAssertEqual(error?.code, "audio_failed")
        XCTAssertTrue(
            error?.message.contains("48000") == true && error?.message.contains("16000") == true,
            "the message must name both rates: \(error?.message ?? "-")"
        )
    }

    func testTheOtherStaleDirectionIsRejectedToo() {
        // Headset walks out of range: the node is stuck on 16 kHz while the
        // session has already fallen back to the 48 kHz built-in mic.
        XCTAssertNotNil(
            rejection(try InputFormatPolicy.validate(format(16_000), sessionSampleRate: 48_000))
        )
    }

    func testAnUnknownSessionRateIsNotTreatedAsAMismatch() {
        // `AVAudioSession.sampleRate` reads 0 when no route is resolved yet.
        // Refusing then would leave the radio with no keep-alive tap — and no
        // background execution — over a comparison against nothing.
        XCTAssertNoThrow(
            try InputFormatPolicy.validate(format(48_000), sessionSampleRate: 0)
        )
    }
}
