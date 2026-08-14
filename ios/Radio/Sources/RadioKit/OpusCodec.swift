import AVFoundation
import Foundation
import Opus

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

public final class LibopusEncoder: OpusEncoding {
    private let encoder: Opus.Encoder

    public init() throws {
        encoder = try Opus.Encoder(format: OpusFormat.pcm, application: .voip)
        encoder.bitrate = .bitrate(RadioConfig.Audio.bitrate)
    }

    public func encode(_ pcm: Data) throws -> Data {
        guard let buffer = OpusFormat.buffer(from: pcm) else {
            throw RadioError.audioFailed("bad pcm frame of \(pcm.count) bytes")
        }
        var packet = Data(count: RadioConfig.Audio.maxEncodedFrameBytes)
        let written = try encoder.encode(buffer, to: &packet)
        return Data(packet.prefix(written))
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
        try decoder.decode(packet, to: buffer)
        return OpusFormat.data(from: buffer)
    }
}
