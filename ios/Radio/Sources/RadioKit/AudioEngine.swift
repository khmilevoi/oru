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
    /// `var`, not `let`: `mediaServicesWereReset` requires disposing every
    /// audio object and building new ones (QA1749). A node cannot move between
    /// engines, so `tonePlayer` is replaced with it.
    private var engine = AVAudioEngine()
    private var tonePlayer = AVAudioPlayerNode()
    private var isTonePlayerAttached = false
    /// True between `startPlayback()` and `stopPlayback()`. A rebuild request
    /// that arrives before the first `startPlayback()` must do nothing: the
    /// record permission may still be undetermined, and starting the engine
    /// then is the documented `inputNode != nullptr` crash.
    private var isPlaybackStarted = false
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
        queue.sync { isPlaybackStarted = true }
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
            isPlaybackStarted = false
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
            // §5: "beginIncoming no longer stop/starts the engine per
            // transmission; engine restarts happen only on configuration change
            // or interruption recovery." The stop/start was a workaround for a
            // graph that was never rebuilt when the hardware format moved —
            // `rebuildEngine` is that rebuild, and attaching a player node to a
            // running engine is a supported dynamic graph change.
            do {
                let playback = PeerPlayback(decoder: try makeDecoder())
                engine.attach(playback.player)
                engine.connect(
                    playback.player,
                    to: engine.mainMixerNode,
                    format: OpusFormat.pcm
                )
                playbacks[peerId] = playback
                try ensureEngineRunningLocked()
                HeartbeatLogger.shared.record(
                    "rx playback open peer=\(peerId) engine=\(engine.isRunning)"
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
            encoder = try makeEncoder()
            txMeter = LevelMeter(
                label: "tx",
                interval: RadioConfig.Audio.txMeterSeconds
            )
            // AVAudioEngine allows one tap per bus: the always-hot keep-alive
            // tap yields to the real capture tap for the transmission.
            removeKeepAliveTapLocked()
            try installCaptureTapLocked()
            try ensureEngineRunningLocked()
            isCapturing = true
        }
    }

    /// Installs the capture tap at the format the hardware reports RIGHT NOW and
    /// builds the converter from it. Called at `startCapture` and again after
    /// every engine rebuild — §5's "formats are never cached across a rebuild"
    /// is enforced by there being no other place a capture format is read.
    private func installCaptureTapLocked() throws {
        let input = engine.inputNode
        let inputFormat = input.outputFormat(forBus: 0)
        // Throws rather than letting `installTap` raise an uncatchable ObjC
        // exception on a format the node cached from a route that is gone.
        try InputFormatPolicy.validate(
            inputFormat,
            sessionSampleRate: AVAudioSession.sharedInstance().sampleRate
        )
        try rebuildConverterLocked(for: inputFormat)
        // Quiet-transmit investigation: `.voiceChat` puts voice processing on
        // the SESSION, but a plain inputNode tap only gets the node's AGC when
        // `setVoiceProcessingEnabled(true)` is called — which this engine never
        // does. Record the actual state as hardware evidence.
        HeartbeatLogger.shared.record(
            "tx capture start rate=\(Int(inputFormat.sampleRate)) "
                + "voiceProcessing=\(input.isVoiceProcessingEnabled) "
                + "gain=\(RadioConfig.Audio.captureGain)"
        )
        input.installTap(onBus: 0, bufferSize: 1_024, format: inputFormat) {
            [weak self] buffer, _ in
            guard let self else { return }
            HeartbeatLogger.shared.noteInputBuffer()
            self.queue.async { self.handleCaptureLocked(buffer) }
        }
        log.info("capture started at \(inputFormat.sampleRate, privacy: .public) Hz")
    }

    private func rebuildConverterLocked(for format: AVAudioFormat) throws {
        guard let converter = AVAudioConverter(from: format, to: OpusFormat.pcm) else {
            throw RadioError.audioFailed("no usable microphone format")
        }
        self.converter = converter
        // The residue belongs to the old rate; keeping it would splice two
        // sample rates into one Opus frame.
        captureResidue.removeAll(keepingCapacity: true)
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
        guard isCapturing, let encoder else { return }

        // §5: a mid-transmission route change re-routes with a short glitch
        // instead of raising `audioFailed`. The tap keeps its old format after
        // a hardware change until it is reinstalled, so the buffer is the
        // authority on what is actually arriving.
        if CaptureConverterPolicy.needsRebuild(
            converterInput: converter?.inputFormat, incoming: buffer.format
        ) {
            HeartbeatLogger.shared.record(
                "tx converter rebuild rate=\(Int(buffer.format.sampleRate))"
            )
            do {
                try rebuildConverterLocked(for: buffer.format)
            } catch {
                HeartbeatLogger.shared.record("tx converter rebuild FAILED: \(error)")
                return
            }
        }
        guard let converter else { return }

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
            // Never `audioFailed` (§2 goal 3): the format moved under us. Drop
            // this buffer, rebuild from what actually arrived, and carry on —
            // the next buffer transmits.
            HeartbeatLogger.shared.record("tx resample failed, rebuilding: \(conversionError)")
            do {
                try rebuildConverterLocked(for: buffer.format)
            } catch {
                HeartbeatLogger.shared.record("tx converter rebuild FAILED: \(error)")
            }
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
        // The 2026-08-19 crash site. Throws rather than letting `installTap`
        // raise an uncatchable ObjC exception on a format the node cached from
        // a route that is gone; the rebuild path logs it and the next route
        // event retries.
        try InputFormatPolicy.validate(
            inputFormat,
            sessionSampleRate: AVAudioSession.sharedInstance().sampleRate
        )

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

// MARK: - Rebuild and grant tone (§5, D2)

extension AudioEngine {

    /// §5's engine rebuild. Ordered the way AVAudioEngine requires it: taps
    /// come off before anything is disconnected (a tap left on a node that is
    /// about to be disconnected is a documented crash), the graph is torn down,
    /// the I/O nodes are re-materialized, everything is reconnected, the tap
    /// goes back on at the format the input node reports NOW, and only then does
    /// the engine start.
    ///
    /// Only `recreate: true` genuinely re-queries the hardware. Touching
    /// `engine.inputNode` below CREATES the node on a fresh engine but does not
    /// re-resolve it on an engine that already has one: after a route change
    /// that engine's input node goes on reporting the dead route's format, and
    /// installing a tap at it raises an ObjC exception Swift cannot catch
    /// ("Failed to create tap due to format mismatch", -10868), which aborts the
    /// process — the 2026-08-19 crash. That is why the configuration-change row
    /// of the reaction table asks for `.recreateEngine`, and why
    /// `InputFormatPolicy` refuses a stale format on every path that still
    /// reuses an engine.
    ///
    /// `prepare()` is not called and no main-queue hop is needed: the documented
    /// `inputNode != nullptr || outputNode != nullptr` assertion fires when
    /// `prepare()`/`start()` run against an EMPTY graph, and both I/O nodes are
    /// touched above before `start()`.
    public func rebuildEngine(recreate: Bool) {
        queue.async { [self] in
            guard isPlaybackStarted else { return }
            let wasCapturing = isCapturing
            HeartbeatLogger.shared.record(
                "engine rebuild begin recreate=\(recreate) capturing=\(wasCapturing)"
            )

            if wasCapturing {
                engine.inputNode.removeTap(onBus: 0)
            }
            removeKeepAliveTapLocked()
            if engine.isRunning {
                engine.stop()
            }
            for playback in playbacks.values {
                engine.disconnectNodeOutput(playback.player)
            }
            if isTonePlayerAttached {
                engine.disconnectNodeOutput(tonePlayer)
            }

            if recreate {
                // QA1749: after a media-services reset every audio object is
                // dead, including the engine and its nodes.
                for playback in playbacks.values {
                    engine.detach(playback.player)
                }
                if isTonePlayerAttached {
                    engine.detach(tonePlayer)
                    isTonePlayerAttached = false
                }
                engine = AVAudioEngine()
                tonePlayer = AVAudioPlayerNode()
                converter = nil
                for playback in playbacks.values {
                    engine.attach(playback.player)
                }
            }

            _ = engine.inputNode
            _ = engine.mainMixerNode
            for playback in playbacks.values {
                engine.connect(
                    playback.player,
                    to: engine.mainMixerNode,
                    format: OpusFormat.pcm
                )
            }
            if isTonePlayerAttached {
                engine.connect(tonePlayer, to: engine.mainMixerNode, format: OpusFormat.pcm)
            }

            do {
                if wasCapturing {
                    try installCaptureTapLocked()
                } else {
                    try installKeepAliveTapLocked()
                }
                try ensureEngineRunningLocked()
            } catch {
                // §2 goal 3: a route change never kills the radio. The next
                // configuration change, route change or interruption recovery
                // retries; nothing is raised to the delegate.
                HeartbeatLogger.shared.record("engine rebuild FAILED: \(error)")
                return
            }
            // Players that were mid-transmission lost their scheduled buffers
            // with the stop. `drainLocked` calls `play()` when it schedules the
            // next one, so playback resumes on the next frame off the wire.
            HeartbeatLogger.shared.record("engine rebuild done running=\(engine.isRunning)")
        }
    }

    /// D2's talk-permit tone, on its own player node so it never disturbs a
    /// peer's playback chain.
    public func playGrantTone() {
        queue.async { [self] in
            // Same guard `rebuildEngine` carries: before the first
            // `startPlayback()` the record permission may still be
            // undetermined, and starting the engine then is the documented
            // `inputNode != nullptr` crash.
            guard isPlaybackStarted else { return }
            guard let buffer = OpusFormat.buffer(from: GrantTone.pcm()) else { return }
            if !isTonePlayerAttached {
                engine.attach(tonePlayer)
                engine.connect(tonePlayer, to: engine.mainMixerNode, format: OpusFormat.pcm)
                isTonePlayerAttached = true
            }
            do {
                try ensureEngineRunningLocked()
            } catch {
                HeartbeatLogger.shared.record("grant tone SKIPPED: \(error)")
                return
            }
            tonePlayer.scheduleBuffer(buffer, completionHandler: nil)
            if !tonePlayer.isPlaying {
                tonePlayer.play()
            }
            HeartbeatLogger.shared.record("grant tone")
        }
    }
}
