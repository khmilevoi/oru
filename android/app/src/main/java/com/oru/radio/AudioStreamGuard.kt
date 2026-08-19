package com.oru.radio

/**
 * Section 6 "Streams survive route changes", as pure bookkeeping shared by the capture and
 * playback loops.
 *
 * A route or profile change bumps a generation counter in [AudioEngine]; each loop compares it
 * once per iteration and rebuilds its `AudioRecord`/`AudioTrack` when it moved (their
 * attributes differ per profile anyway). Rebuilding also clears the consecutive-error run, so
 * the fatal threshold of spec section 13 can only be reached while the route is stable — a
 * route change mid-stream can no longer escalate to `microphone_read_failed` /
 * `speaker_write_failed` and kill the radio.
 *
 * One instance per loop; both are confined to their own thread.
 */
class AudioStreamGuard(
    private val maxConsecutiveErrors: Int = RadioConfig.AUDIO_MAX_CONSECUTIVE_IO_ERRORS,
) {

    private var builtGeneration: Int? = null
    private var consecutiveErrors = 0

    /**
     * True when the stream must be built for [generation] — including the very first time.
     * Clears the error run, because the errors belonged to the route that just went away.
     */
    fun needsRebuild(generation: Int): Boolean {
        if (generation == builtGeneration) return false
        builtGeneration = generation
        consecutiveErrors = 0
        return true
    }

    /** True once the run has reached the fatal threshold on this generation. */
    fun onError(): Boolean {
        consecutiveErrors++
        return consecutiveErrors >= maxConsecutiveErrors
    }

    fun onSuccess() {
        consecutiveErrors = 0
    }
}
