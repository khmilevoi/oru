import Foundation

/// A Nearby STREAM payload is an ordered byte stream, so Opus packets need their own
/// boundaries: `UInt16` big-endian length, then that many bytes. Both engines frame
/// identically; see the cross-platform wire contract in the plan.
public enum AudioFraming {
    public static let maxFrameBytes = RadioConfig.Audio.maxEncodedFrameBytes

    public static func frame(_ payload: Data) -> Data {
        var framed = Data(capacity: payload.count + 2)
        let length = UInt16(clamping: payload.count).bigEndian
        withUnsafeBytes(of: length) { framed.append(contentsOf: $0) }
        framed.append(payload)
        return framed
    }
}

/// Accumulates bytes read from an incoming stream and hands back whole Opus packets.
public final class AudioFrameParser {
    private var buffer = Data()
    public private(set) var isDesynchronised = false

    public init() {}

    public func append(_ bytes: Data) -> [Data] {
        guard !isDesynchronised else { return [] }
        buffer.append(bytes)

        var frames: [Data] = []
        while buffer.count >= 2 {
            let high = Int(buffer[buffer.startIndex])
            let low = Int(buffer[buffer.startIndex + 1])
            let length = (high << 8) | low

            if length < 1 || length > AudioFraming.maxFrameBytes {
                isDesynchronised = true
                buffer.removeAll(keepingCapacity: false)
                return frames
            }
            guard buffer.count >= length + 2 else { break }

            let start = buffer.startIndex + 2
            frames.append(Data(buffer[start..<(start + length)]))
            buffer.removeSubrange(buffer.startIndex..<(start + length))
        }
        return frames
    }

    public func reset() {
        buffer.removeAll(keepingCapacity: false)
        isDesynchronised = false
    }
}
