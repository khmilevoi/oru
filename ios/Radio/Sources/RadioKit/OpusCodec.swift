import AVFoundation
import Copus
import Foundation
import Opus
import OpusShim

/// Embedded libopus, wrapped behind two one-method protocols (spec section 8:
/// platform codecs are not used). This file and `Package.swift` are the entire
/// surface the Opus dependency touches.
public protocol OpusEncoding: AnyObject {
    /// 16-bit little-endian mono PCM in, one Opus packet out.
    func encode(_ pcm: Data) throws -> Data
}

public protocol OpusDecoding: AnyObject {
    /// One Opus packet in, 16-bit little-endian mono PCM out.
    func decode(_ packet: Data) throws -> Data
}

/// The single PCM format the whole engine speaks.
public enum OpusFormat {
    public static let pcm = AVAudioFormat(
        commonFormat: .pcmFormatInt16,
        sampleRate: RadioConfig.Audio.sampleRate,
        channels: AVAudioChannelCount(RadioConfig.Audio.channelCount),
        interleaved: true
    )!

    public static func buffer(from pcmBytes: Data) -> AVAudioPCMBuffer? {
        let frames = AVAudioFrameCount(pcmBytes.count / 2)
        guard
            frames > 0,
            let buffer = AVAudioPCMBuffer(pcmFormat: pcm, frameCapacity: frames),
            let channel = buffer.int16ChannelData
        else {
            return nil
        }
        buffer.frameLength = frames
        pcmBytes.withUnsafeBytes { raw in
            guard let base = raw.bindMemory(to: Int16.self).baseAddress else { return }
            channel[0].update(from: base, count: Int(frames))
        }
        return buffer
    }

    public static func data(from buffer: AVAudioPCMBuffer) -> Data {
        guard let channel = buffer.int16ChannelData else { return Data() }
        return Data(
            bytes: channel[0],
            count: Int(buffer.frameLength) * MemoryLayout<Int16>.size
        )
    }
}

/// Talks to the vendored libopus C library directly through `Copus` rather than
/// through the `Opus.Encoder` convenience wrapper: that wrapper has no bitrate
/// control in any released version, but the real C API (`opus_encoder_ctl`,
/// `OPUS_SET_BITRATE`) is intact in the same dependency.
public final class LibopusEncoder: OpusEncoding {
    private let encoder: OpaquePointer

    public init() throws {
        var error: Int32 = OPUS_OK
        guard
            let encoder = opus_encoder_create(
                Int32(RadioConfig.Audio.sampleRate),
                Int32(RadioConfig.Audio.channelCount),
                OPUS_APPLICATION_VOIP,
                &error
            ),
            error == OPUS_OK
        else {
            throw RadioError.audioFailed("opus_encoder_create failed (\(error))")
        }
        self.encoder = encoder

        let ctlResult = oru_opus_encoder_set_bitrate(encoder, RadioConfig.Audio.bitrate)
        guard ctlResult == OPUS_OK else {
            throw RadioError.audioFailed("opus_encoder_ctl(OPUS_SET_BITRATE) failed (\(ctlResult))")
        }
    }

    deinit {
        opus_encoder_destroy(encoder)
    }

    public func encode(_ pcm: Data) throws -> Data {
        guard pcm.count > 0, pcm.count % 2 == 0 else {
            throw RadioError.audioFailed("bad pcm frame of \(pcm.count) bytes")
        }
        let frameSize = Int32(pcm.count / 2)
        var packet = Data(count: RadioConfig.Audio.maxEncodedFrameBytes)
        let written: Int32 = try pcm.withUnsafeBytes { rawPcm in
            let samples = rawPcm.bindMemory(to: Int16.self)
            return try packet.withUnsafeMutableBytes { rawPacket in
                guard
                    let samplesBase = samples.baseAddress,
                    let packetBase = rawPacket.bindMemory(to: UInt8.self).baseAddress
                else {
                    throw RadioError.audioFailed("could not address the pcm/packet buffers")
                }
                let result = opus_encode(
                    encoder,
                    samplesBase,
                    frameSize,
                    packetBase,
                    Int32(RadioConfig.Audio.maxEncodedFrameBytes)
                )
                guard result >= 0 else {
                    throw RadioError.audioFailed("opus_encode failed (\(result))")
                }
                return result
            }
        }
        return Data(packet.prefix(Int(written)))
    }
}

public final class LibopusDecoder: OpusDecoding {
    private let decoder: Opus.Decoder

    public init() throws {
        decoder = try Opus.Decoder(format: OpusFormat.pcm)
    }

    public func decode(_ packet: Data) throws -> Data {
        guard
            let buffer = AVAudioPCMBuffer(
                pcmFormat: OpusFormat.pcm,
                frameCapacity: AVAudioFrameCount(RadioConfig.Audio.samplesPerFrame)
            )
        else {
            throw RadioError.audioFailed("could not allocate a decode buffer")
        }
        try packet.withUnsafeBytes { raw in
            try decoder.decode(raw.bindMemory(to: UInt8.self), to: buffer)
        }
        return OpusFormat.data(from: buffer)
    }
}
