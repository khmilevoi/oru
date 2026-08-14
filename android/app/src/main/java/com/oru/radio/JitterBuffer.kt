package com.oru.radio

/**
 * The 2-3 frame (40-60 ms) receive buffer of spec section 8. Frames are pushed by the
 * engine thread and pulled by the playback thread, so every method is synchronized; the
 * logic itself is plain and has no Android dependency.
 */
class JitterBuffer(
    private val targetFrames: Int = RadioConfig.JITTER_TARGET_FRAMES,
    private val resumeFrames: Int = RadioConfig.JITTER_MIN_FRAMES,
    private val capacityFrames: Int = RadioConfig.JITTER_CAPACITY_FRAMES,
) {
    private val frames = ArrayDeque<ByteArray>()

    /** True while waiting for enough frames to start (or restart) playback. */
    private var filling = true

    /** False until the first frame has ever been played, which picks the fill threshold. */
    private var started = false

    val size: Int
        @Synchronized get() = frames.size

    @Synchronized
    fun push(frame: ByteArray) {
        if (frames.size >= capacityFrames) frames.removeFirst()
        frames.addLast(frame)
    }

    /** The next frame, or null while filling — the caller plays silence for that slot. */
    @Synchronized
    fun pop(): ByteArray? {
        if (filling) {
            if (frames.size < if (started) resumeFrames else targetFrames) return null
            filling = false
        }
        val frame = frames.removeFirstOrNull()
        if (frame == null) {
            filling = true
            return null
        }
        started = true
        return frame
    }
}
