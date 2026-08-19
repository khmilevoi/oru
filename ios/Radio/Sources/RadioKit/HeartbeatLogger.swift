import AVFoundation
import Foundation
import os
#if canImport(UIKit)
import UIKit
#endif

/// Always-hot instrumentation. Every `RadioConfig.Background.heartbeatSeconds`
/// this appends one line to Documents/heartbeat.log — a file, not just os_log,
/// so the record survives a relaunch and can be pulled off the device after a
/// 30-60 minute locked-screen run to prove the process stayed alive and the
/// microphone kept delivering samples the whole time. Started and stopped by
/// `AlwaysHotBackgroundManager`.
public final class HeartbeatLogger {

    public static let shared = HeartbeatLogger()

    /// Maintained by `AlwaysHotBackgroundManager`: AVAudioSession has no public
    /// "is active" getter, so the manager records what it last did (activated,
    /// interrupted, reactivated, deactivated) and the heartbeat reports that.
    public var sessionActive = false

    /// Installed by `AudioEngine` so the heartbeat can report whether the
    /// AVAudioEngine is actually running.
    public var isEngineRunning: (() -> Bool)?

    /// §5: other audio is sampled "on the existing heartbeat tick". Installed
    /// by `AlwaysHotBackgroundManager` while the session is active, cleared when
    /// it is not. Called on the main queue, like every other timer callback
    /// here; the manager hops onto its own queue.
    public var onTick: (() -> Void)?

    private let log = Logger(
        subsystem: RadioConfig.Logging.subsystem,
        category: "heartbeat"
    )
    private let lock = NSLock()
    private var lastInputBufferAt: Date?
    private var timer: DispatchSourceTimer?
    private let formatter = ISO8601DateFormatter()

    private var fileURL: URL {
        FileManager.default
            .urls(for: .documentDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("heartbeat.log")
    }

    /// Called from the audio input tap on every buffer. Only a timestamp store:
    /// the tap thread must never touch files or os_log.
    public func noteInputBuffer() {
        lock.lock()
        lastInputBufferAt = Date()
        lock.unlock()
    }

    /// All timer state lives on the main queue — also the one place
    /// `UIApplication.applicationState` may legally be read from.
    public func start() {
        DispatchQueue.main.async {
            guard self.timer == nil else { return }
            let timer = DispatchSource.makeTimerSource(queue: .main)
            timer.schedule(
                deadline: .now(),
                repeating: RadioConfig.Background.heartbeatSeconds
            )
            timer.setEventHandler { self.tick() }
            timer.resume()
            self.timer = timer
            self.record("heartbeat started")
        }
    }

    public func stop() {
        DispatchQueue.main.async {
            guard self.timer != nil else { return }
            self.timer?.cancel()
            self.timer = nil
            self.record("heartbeat stopped")
        }
    }

    /// One immediate out-of-band line (interruptions, reactivation failures).
    /// Safe from any thread.
    public func record(_ event: String) {
        DispatchQueue.main.async {
            let line = "\(self.formatter.string(from: Date())) event=\(event)"
            self.append(line)
            self.log.notice("[heartbeat] \(line, privacy: .public)")
        }
    }

    private func tick() {
        #if canImport(UIKit)
        let appState: String
        switch UIApplication.shared.applicationState {
        case .active: appState = "foreground"
        case .inactive: appState = "inactive"
        case .background: appState = "background"
        @unknown default: appState = "unknown"
        }
        #else
        let appState = "unknown"
        #endif

        lock.lock()
        let lastInput = lastInputBufferAt
        lock.unlock()
        let inputAge = lastInput.map { String(format: "%.1f", -$0.timeIntervalSinceNow) }
            ?? "never"

        let line = """
            \(formatter.string(from: Date())) app=\(appState) \
            session=\(sessionActive) \
            engine=\(isEngineRunning?() ?? false) \
            lastInputAge=\(inputAge)s
            """
        append(line)
        log.notice("[heartbeat] \(line, privacy: .public)")
        onTick?()
    }

    private func append(_ line: String) {
        guard let data = (line + "\n").data(using: .utf8) else { return }
        let url = fileURL
        guard FileManager.default.fileExists(atPath: url.path) else {
            try? data.write(to: url)
            return
        }
        guard let handle = try? FileHandle(forWritingTo: url) else { return }
        defer { try? handle.close() }
        _ = try? handle.seekToEnd()
        try? handle.write(contentsOf: data)
    }
}
