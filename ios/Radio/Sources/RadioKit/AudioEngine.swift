import AVFoundation
import Foundation
import os

/// One incoming transmission being played back.
private final class PeerPlayback {
    let player = AVAudioPlayerNode()
    let jitter = JitterBuffer()
    let decoder: OpusDecoding

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
    private var isCapturing = false

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
        // Category only. PushToTalk activates the session, here and in the
        // background; activating it from the app is what kills locked playback.
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(
            .playAndRecord,
            mode: .voiceChat,
            options: [.allowBluetooth, .allowBluetoothA2DP, .defaultToSpeaker]
        )
        engine.prepare()
        log.info("audio session configured")
    }

    public func stopPlayback() {
        queue.sync {
            for (peerId, _) in playbacks {
                tearDownPlaybackLocked(peerId: peerId)
            }
            playbacks.removeAll()
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
                engine.attach(playback.player)
                engine.connect(
                    playback.player,
                    to: engine.mainMixerNode,
                    format: OpusFormat.pcm
                )
                playbacks[peerId] = playback
                try ensureEngineRunningLocked()
                log.info("playback opened for \(peerId, privacy: .public)")
            } catch {
                delegate?.audioIO(self, didFail: .audioFailed("playback: \(error)"))
            }
        }
    }

    public func enqueue(frame: Data, from peerId: String) {
        queue.async { [self] in
            guard let playback = playbacks[peerId] else { return }
            playback.jitter.push(frame)
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
            guard let buffer = OpusFormat.buffer(from: pcm) else { return }
            playback.player.scheduleBuffer(buffer, completionHandler: nil)
            if !playback.player.isPlaying {
                playback.player.play()
            }
        } catch {
            // A bad packet from one peer is recoverable, not an engine
            // failure (spec section 13): drop this frame and keep playing.
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

            input.installTap(onBus: 0, bufferSize: 1_024, format: inputFormat) {
                [weak self] buffer, _ in
                guard let self else { return }
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
            log.info("capture stopped")
        }
    }

    private func handleCaptureLocked(_ buffer: AVAudioPCMBuffer) {
        guard isCapturing, let converter, let encoder else { return }

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

        captureResidue.append(OpusFormat.data(from: converted))
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
