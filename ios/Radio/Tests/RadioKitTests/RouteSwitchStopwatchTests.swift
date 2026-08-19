import XCTest
@testable import RadioKit

/// §10's instrumentation: "heartbeat/logcat lines carry timestamps for
/// device-event → audio-on-new-route so switch latency is measured, not
/// guessed". One line per switch, emitted by the first audio buffer that
/// arrives after the device event.
final class RouteSwitchStopwatchTests: XCTestCase {

    func testAudioWithNoPendingSwitchSaysNothing() {
        var stopwatch = RouteSwitchStopwatch()
        XCTAssertNil(stopwatch.noteAudio(atMs: 1_000))
    }

    func testTheFirstBufferAfterADeviceEventReportsTheLatency() {
        var stopwatch = RouteSwitchStopwatch()
        stopwatch.markRouteChange(reason: "newDeviceAvailable", atMs: 1_000)
        XCTAssertEqual(
            stopwatch.noteAudio(atMs: 1_812),
            "route switch reason=newDeviceAvailable latencyMs=812"
        )
    }

    func testOnlyTheFirstBufferReports() {
        // A tap delivers 50 buffers a second; a line per buffer would drown
        // heartbeat.log and the number would stop meaning anything.
        var stopwatch = RouteSwitchStopwatch()
        stopwatch.markRouteChange(reason: "oldDeviceUnavailable", atMs: 0)
        XCTAssertNotNil(stopwatch.noteAudio(atMs: 100))
        XCTAssertNil(stopwatch.noteAudio(atMs: 120))
        XCTAssertNil(stopwatch.noteAudio(atMs: 140))
    }

    func testASecondDeviceEventArmsTheStopwatchAgain() {
        var stopwatch = RouteSwitchStopwatch()
        stopwatch.markRouteChange(reason: "newDeviceAvailable", atMs: 0)
        _ = stopwatch.noteAudio(atMs: 500)
        stopwatch.markRouteChange(reason: "oldDeviceUnavailable", atMs: 10_000)
        XCTAssertEqual(
            stopwatch.noteAudio(atMs: 10_240),
            "route switch reason=oldDeviceUnavailable latencyMs=240"
        )
    }

    func testASecondDeviceEventBeforeAnyAudioRestartsTheMeasurement() {
        // Device lists flap during Bluetooth negotiation. The latency that
        // matters is from the LAST event to audio.
        var stopwatch = RouteSwitchStopwatch()
        stopwatch.markRouteChange(reason: "newDeviceAvailable", atMs: 0)
        stopwatch.markRouteChange(reason: "newDeviceAvailable", atMs: 300)
        XCTAssertEqual(
            stopwatch.noteAudio(atMs: 800),
            "route switch reason=newDeviceAvailable latencyMs=500"
        )
    }

    func testAnOutOfOrderTimestampNeverReportsANegativeLatency() {
        var stopwatch = RouteSwitchStopwatch()
        stopwatch.markRouteChange(reason: "newDeviceAvailable", atMs: 1_000)
        XCTAssertEqual(
            stopwatch.noteAudio(atMs: 900),
            "route switch reason=newDeviceAvailable latencyMs=0"
        )
    }
}
