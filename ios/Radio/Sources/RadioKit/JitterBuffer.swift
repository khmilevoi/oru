import Foundation

/// A 2-3 frame cushion per incoming transmission (spec section 8). The Nearby
/// STREAM is ordered and reliable, so this absorbs bursty delivery only — it
/// never reorders.
///
/// Not thread-safe by design: it is owned by the audio queue.
public final class JitterBuffer {
    private var frames: [Data] = []
    private let targetFrames: Int
    private let maxFrames: Int

    public private(set) var isPrimed = false
    public private(set) var droppedFrames = 0

    public init(
        targetFrames: Int = RadioConfig.Audio.jitterTargetFrames,
        maxFrames: Int = RadioConfig.Audio.jitterMaxFrames
    ) {
        self.targetFrames = targetFrames
        self.maxFrames = maxFrames
    }

    public var count: Int { frames.count }

    public func push(_ frame: Data) {
        frames.append(frame)
        while frames.count > maxFrames {
            frames.removeFirst()
            droppedFrames += 1
        }
        if frames.count >= targetFrames {
            isPrimed = true
        }
    }

    /// Returns nil until the cushion has filled; an underrun re-primes.
    public func pop() -> Data? {
        guard isPrimed else { return nil }
        guard !frames.isEmpty else {
            isPrimed = false
            return nil
        }
        return frames.removeFirst()
    }

    public func reset() {
        frames.removeAll(keepingCapacity: true)
        isPrimed = false
        droppedFrames = 0
    }
}
