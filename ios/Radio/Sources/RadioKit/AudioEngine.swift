import AVFoundation
import Foundation
import os

/// One incoming transmission being played back.
private final class PeerPlayback {
    let player = AVAudioPlayerNode()
    let jitter = JitterBuffer()
    let decoder: OpusDecoding

    // Receive-path instrumentation (heartbeat.log): totals are cheap Int
    // increments per frame; a line is only formatted on sampled events.
    var decodedFrames = 0
    var decodeFailures = 0
    var scheduledBuffers = 0

    init(decoder: OpusDecoding) {
        self.decoder = decoder
    }
}

/// Microphone in, speaker out (spec section 8). Everything happens on `queue`
/// except the capture tap, which hops onto it.
public final class AudioEngine: AudioIO {

    public weak var delegate: AudioIODelegate?

    private let queue: DispatchQueue
    private let makeEncoder: () throws -> OpusEncoding
    private let makeDecoder: () throws -> OpusDecoding
    private let engine = AVAudioEngine()
    private let log = Logger(
        subsystem: RadioConfig.Logging.subsystem,
        category: "audio"
    )

    private var playbacks: [String: PeerPlayback] = [:]
    private var encoder: OpusEncoding?
    private var converter: AVAudioConverter?
    private var captureResidue = Data()
    private var txMeter = LevelMeter(
        label: "tx",
        interval: RadioConfig.Audio.txMeterSeconds
    )
    private var isCapturing = false
    private var isKeepAliveTapInstalled = false

    private var frameByteCount: Int {
        RadioConfig.Audio.samplesPerFrame * MemoryLayout<Int16>.size
    }

    public init(
        queue: DispatchQueue,
        makeEncoder: @escaping () throws -> OpusEncoding = { try LibopusEncoder() },
        makeDecoder: @escaping () throws -> OpusDecoding = { try LibopusDecoder() }
    ) {
        self.queue = queue
        self.makeEncoder = makeEncoder
        self.makeDecoder = makeDecoder
    }

    // MARK: - Session

    public func startPlayback() throws {
        let session = AVAudioSession.sharedInstance()
        // Deliberately no setCategory here. `AlwaysHotBackgroundManager` owns
        // the session and has already run the two-phase profile detection
        // (`background.activate()` precedes `audio.startPlayback()` in
        // RadioEngine.startRadioLocked()) — only that detection sequence may
        // touch setCategory, and an extra call from here mid-session is the
        // documented route-collapse trigger.
        awaitRecordPermissionIfUndetermined(session)
        try prepareEngineOnMainThread(session)
        // The engine must run — and the microphone must keep delivering
        // buffers — the whole time, not just during a transmission, or iOS
        // suspends the app once the screen locks. That continuity is what
        // earns background execution under the `audio` UIBackgroundMode.
        try queue.sync { try installKeepAliveTapLocked() }
        HeartbeatLogger.shared.isEngineRunning = { [weak self] in
            self?.engine.isRunning ?? false
        }
        log.info("audio session configured")
    }

    /// Category, permission and (in local-test builds) activation all being
    /// correct still wasn't enough on real hardware: `engine.prepare()`
    /// crashed identically (`inputNode != nullptr || outputNode != nullptr`)
    /// every time it ran on `AudioEngine`'s own background queue. Forcing it
    /// onto the main thread -- the norm in every Apple sample and most
    /// real-world reports of this exact assertion -- is the one variable
    /// changed here.
    private func prepareEngineOnMainThread(_ session: AVAudioSession) throws {
        var activationError: Error?
        DispatchQueue.main.sync {
            #if DEBUG
            // Belt and braces for local-test builds only: re-assert the
            // session `AlwaysHotBackgroundManager` already activated, now that
            // category and permission are both settled. Never do this outside
            // DEBUG -- activating before the category is set leaves the engine
            // with no real input/output route once the category *does* switch,
            // and re-activating mid-session collapses a resolved Bluetooth
            // route.
            do {
                try session.setActive(true)
            } catch {
                activationError = error
            }
            #endif
            // AVAudioEngine creates its I/O nodes lazily, on first property
            // access -- `AVAudioEngine()` itself leaves the graph empty.
            // `prepare()`/`start()` both assert that at least one I/O node
            // exists ("inputNode != nullptr || outputNode != nullptr") before
            // doing anything else, session state notwithstanding. Every other
            // entry point into this engine (`beginIncoming`, `startCapture`)
            // touches a node before ever calling `start()` and has never hit
            // this; `startPlayback()` was the one path that called into
            // `prepare()` without touching a node first. Building the graph
            // here, now that category and permission are both settled, fixes
            // that.
            _ = engine.inputNode
            _ = engine.mainMixerNode // also creates and connects outputNode
            engine.prepare()
        }
        if let activationError { throw activationError }
    }

    /// `engine.prepare()` needs a resolved microphone route and crashes hard
    /// (`inputNode != nullptr || outputNode != nullptr`) if permission is still
    /// `.undetermined` -- the state of every fresh install, since proper
    /// ahead-of-time onboarding is P7's job and doesn't exist yet. Blocks only
    /// on that one first launch, waiting for the system prompt the app has
    /// never triggered before; every launch after the user answers it returns
    /// immediately.
    private func awaitRecordPermissionIfUndetermined(_ session: AVAudioSession) {
        guard session.recordPermission == .undetermined else { return }
        let semaphore = DispatchSemaphore(value: 0)
        session.requestRecordPermission { _ in semaphore.signal() }
        semaphore.wait()
    }

    public func stopPlayback() {
        queue.sync {
            for (peerId, _) in playbacks {
                tearDownPlaybackLocked(peerId: peerId)
            }
            playbacks.removeAll()
            removeKeepAliveTapLocked()
            if engine.isRunning {
                engine.stop()
            }
        }
    }

    /// The AVAudioEngine can only run while the session is active, and the
    /// system activates it around the moment audio actually starts — so it is
    /// started lazily rather than at `startRadio`.
    private func ensureEngineRunningLocked() throws {
        guard !engine.isRunning else { return }
        try engine.start()
    }

    // MARK: - Playback

    public func beginIncoming(peerId: String) {
        queue.async { [self] in
            guard playbacks[peerId] == nil else { return }
            do {
                let playback = PeerPlayback(decoder: try makeDecoder())
                let wasRunning = engine.isRunning
                engine.attach(playback.player)
                engine.connect(
                    playback.player,
                    to: engine.mainMixerNode,
                    format: OpusFormat.pcm
                )
                playbacks[peerId] = playback
                // Always-hot silence suspect: the keep-alive tap starts the
                // engine at startRadio, so this player is attached to an engine
                // that is already rendering. A dynamically attached chain
                // joining a running engine has been observed to stay silent on
                // device; a stop/start rebuilds the graph with the player in
                // it. Taps survive the restart, and when the engine was not
                // yet running (`wasRunning == false`) nothing is disturbed.
                if wasRunning {
                    engine.stop()
                }
                try ensureEngineRunningLocked()
                HeartbeatLogger.shared.record(
                    "rx playback open peer=\(peerId) restarted=\(wasRunning) "
                        + "engine=\(engine.isRunning)"
                )
                log.info("playback opened for \(peerId, privacy: .public)")
            } catch {
                // Undo the half-built playback, or the guard above would refuse
                // this peer for good — the session is often not active yet when
                // the first frame lands, and the next attempt has to be allowed.
                if let playback = playbacks.removeValue(forKey: peerId) {
                    engine.detach(playback.player)
                }
                HeartbeatLogger.shared.record(
                    "rx playback FAILED peer=\(peerId): \(error)"
                )
                delegate?.audioIO(self, didFail: .audioFailed("playback: \(error)"))
            }
        }
    }

    public func enqueue(frame: Data, from peerId: String) {
        queue.async { [self] in
            guard let playback = playbacks[peerId] else { return }
            playback.jitter.push(frame)
            // A no-op once running: it is the recovery path for a start that
            // failed earlier because the session was not active yet.
            try? ensureEngineRunningLocked()
            drainLocked(playback, peerId: peerId)
        }
    }

    public func endIncoming(peerId: String) {
        queue.async { [self] in
            tearDownPlaybackLocked(peerId: peerId)
            playbacks.removeValue(forKey: peerId)
        }
    }

    /// Releases one frame per call, matching the one push per call from
    /// `enqueue`, so the jitter buffer keeps a steady cushion (spec section 8)
    /// instead of being drained to empty on every burst.
    private func drainLocked(_ playback: PeerPlayback, peerId: String) {
        guard let packet = playback.jitter.pop() else { return }
        do {
            let pcm = try playback.decoder.decode(packet)
            playback.decodedFrames += 1
            guard let buffer = OpusFormat.buffer(from: pcm) else { return }
            playback.player.scheduleBuffer(buffer, completionHandler: nil)
            if !playback.player.isPlaying {
                playback.player.play()
            }
            playback.scheduledBuffers += 1
            if playback.scheduledBuffers == 1 || playback.scheduledBuffers % 50 == 0 {
                HeartbeatLogger.shared.record(
                    "rx scheduled peer=\(peerId) n=\(playback.scheduledBuffers) "
                        + "playing=\(playback.player.isPlaying) "
                        + "engine=\(engine.isRunning)"
                )
            }
        } catch {
            // A bad packet from one peer is recoverable, not an engine
            // failure (spec section 13): drop this frame and keep playing.
            playback.decodeFailures += 1
            if playback.decodeFailures == 1 {
                HeartbeatLogger.shared.record(
                    "rx decode FAILED peer=\(peerId): \(error)"
                )
            }
            log.error(
                "decode failed for \(peerId, privacy: .public): \(error, privacy: .public)"
            )
        }
    }

    private func tearDownPlaybackLocked(peerId: String) {
        guard let playback = playbacks[peerId] else { return }
        playback.player.stop()
        engine.detach(playback.player)
        playback.jitter.reset()
        HeartbeatLogger.shared.record(
            "rx playback close peer=\(peerId) decoded=\(playback.decodedFrames) "
                + "decodeFailed=\(playback.decodeFailures) "
                + "scheduled=\(playback.scheduledBuffers)"
        )
        log.info("playback closed for \(peerId, privacy: .public)")
    }
}

// MARK: - Capture

extension AudioEngine {

    public func startCapture() throws {
        try queue.sync {
            guard !isCapturing else { return }

            let input = engine.inputNode
            let inputFormat = input.outputFormat(forBus: 0)
            guard
                inputFormat.sampleRate > 0,
                let converter = AVAudioConverter(from: inputFormat, to: OpusFormat.pcm)
            else {
                throw RadioError.audioFailed("no usable microphone format")
            }

            self.converter = converter
            encoder = try makeEncoder()
            captureResidue.removeAll(keepingCapacity: true)
            txMeter = LevelMeter(
                label: "tx",
                interval: RadioConfig.Audio.txMeterSeconds
            )
            // Quiet-transmit investigation: `.voiceChat` puts voice processing
            // on the SESSION, but a plain inputNode tap only gets the node's
            // AGC when `setVoiceProcessingEnabled(true)` is called — which this
            // engine never does. Record the actual state as hardware evidence;
            // deliberately not changed here (it alters latency/behavior).
            HeartbeatLogger.shared.record(
                "tx capture start rate=\(Int(inputFormat.sampleRate)) "
                    + "voiceProcessing=\(input.isVoiceProcessingEnabled) "
                    + "gain=\(RadioConfig.Audio.captureGain)"
            )

            // AVAudioEngine allows one tap per bus: the always-hot keep-alive
            // tap yields to the real capture tap for the transmission.
            removeKeepAliveTapLocked()
            input.installTap(onBus: 0, bufferSize: 1_024, format: inputFormat) {
                [weak self] buffer, _ in
                guard let self else { return }
                HeartbeatLogger.shared.noteInputBuffer()
                self.queue.async { self.handleCaptureLocked(buffer) }
            }

            try ensureEngineRunningLocked()
            isCapturing = true
            log.info("capture started at \(inputFormat.sampleRate, privacy: .public) Hz")
        }
    }

    public func stopCapture() {
        queue.sync {
            guard isCapturing else { return }
            engine.inputNode.removeTap(onBus: 0)
            isCapturing = false
            encoder = nil
            converter = nil
            captureResidue.removeAll(keepingCapacity: true)
            // Hand the input node back to the keep-alive tap so the mic never
            // stops pulling between transmissions.
            try? installKeepAliveTapLocked()
            log.info("capture stopped")
        }
    }

    private func handleCaptureLocked(_ buffer: AVAudioPCMBuffer) {
        guard isCapturing, let converter, let encoder else { return }

        // Metered pre-conversion and pre-gain: this is the level at the mic,
        // the number that tells us whether the capture itself is quiet.
        if let line = txMeter.consume(buffer) {
            HeartbeatLogger.shared.record(line)
        }

        let ratio = OpusFormat.pcm.sampleRate / buffer.format.sampleRate
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 1_024
        guard
            let converted = AVAudioPCMBuffer(
                pcmFormat: OpusFormat.pcm,
                frameCapacity: capacity
            )
        else {
            return
        }

        var consumed = false
        var conversionError: NSError?
        converter.convert(to: converted, error: &conversionError) { _, status in
            if consumed {
                status.pointee = .noDataNow
                return nil
            }
            consumed = true
            status.pointee = .haveData
            return buffer
        }
        if let conversionError {
            delegate?.audioIO(self, didFail: .audioFailed("resample: \(conversionError)"))
            return
        }

        // Transmit-only makeup gain, applied after the resample so it works on
        // the same 16 kHz Int16 stream the encoder sees. The receive path is
        // untouched; captureGain = 1.0 restores today's behavior bit-exactly.
        var pcm = OpusFormat.data(from: converted)
        CaptureGain.apply(RadioConfig.Audio.captureGain, to: &pcm)
        captureResidue.append(pcm)
        while captureResidue.count >= frameByteCount {
            let frame = Data(captureResidue.prefix(frameByteCount))
            captureResidue.removeFirst(frameByteCount)
            do {
                let packet = try encoder.encode(frame)
                guard !packet.isEmpty else { continue }
                delegate?.audioIO(self, didEncodeFrame: packet)
            } catch {
                delegate?.audioIO(self, didFail: .audioFailed("encode: \(error)"))
                return
            }
        }
    }
}

// MARK: - Always-hot keep-alive (spec section 10.2)

extension AudioEngine {

    /// Keeps the microphone pulling buffers while nobody is transmitting. The
    /// samples are discarded — the tap exists so continuous recording counts
    /// as background audio (the `audio` UIBackgroundMode) and the process
    /// stays alive while locked. Each buffer stamps the heartbeat, which is
    /// how a locked-screen run is shown to have survived.
    private func installKeepAliveTapLocked() throws {
        guard !isKeepAliveTapInstalled, !isCapturing else { return }

        let input = engine.inputNode
        let inputFormat = input.outputFormat(forBus: 0)
        guard inputFormat.sampleRate > 0 else {
            throw RadioError.audioFailed("no usable microphone format")
        }

        // Idle-floor metering for the quiet-transmit investigation. The var is
        // captured by reference; tap callbacks arrive serially, so no lock.
        var idleMeter = LevelMeter(
            label: "idle",
            interval: RadioConfig.Audio.idleMeterSeconds
        )
        input.installTap(onBus: 0, bufferSize: 1_024, format: inputFormat) { buffer, _ in
            HeartbeatLogger.shared.noteInputBuffer()
            if let line = idleMeter.consume(buffer) {
                HeartbeatLogger.shared.record(line)
            }
        }
        isKeepAliveTapInstalled = true
        try ensureEngineRunningLocked()
        log.info("always-hot keep-alive tap installed")
    }

    private func removeKeepAliveTapLocked() {
        guard isKeepAliveTapInstalled else { return }
        engine.inputNode.removeTap(onBus: 0)
        isKeepAliveTapInstalled = false
        log.info("always-hot keep-alive tap removed")
    }
}
