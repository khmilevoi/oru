package com.oru.radio

/**
 * Every tunable number of the radio, in one place (spec section 8): field tests retune
 * values here and no logic anywhere else changes.
 */
object RadioConfig {

    /** Bumped whenever the wire protocol changes; peers with another version are ignored. */
    const val PROTOCOL_VERSION = 1

    /** Shared Nearby Connections service id. iOS must advertise exactly this string. */
    const val SERVICE_ID = "com.oru.radio"

    const val SAMPLE_RATE_HZ = 16_000
    const val CHANNEL_COUNT = 1
    const val FRAME_MS = 20
    const val BITRATE_BPS = 24_000

    /** 16 kHz * 20 ms = 320 samples per mono frame (640 bytes of PCM 16). */
    const val FRAME_SAMPLES = SAMPLE_RATE_HZ / 1_000 * FRAME_MS

    /** Upper bound for one encoded 20 ms Opus packet, well above 24 kbps (60 bytes). */
    const val MAX_ENCODED_FRAME_BYTES = 400

    /** Playback starts once this many frames are buffered (3 frames = 60 ms). */
    const val JITTER_TARGET_FRAMES = 3

    /** After an underrun, playback resumes at this many frames (2 frames = 40 ms). */
    const val JITTER_MIN_FRAMES = 2

    /** Hard ceiling on buffered frames; the oldest are dropped past it. */
    const val JITTER_CAPACITY_FRAMES = 25

    /**
     * Capture and playback hardware buffer size, in 20 ms frames (4 frames = ~80 ms at
     * the current constants). Directly sets capture/playback latency: bigger absorbs more
     * OS audio-thread scheduling jitter, smaller lowers latency.
     */
    const val AUDIO_BUFFER_FRAMES = 4

    /**
     * After this many consecutive `AudioRecord.read`/`AudioTrack.write` errors, capture or
     * playback gives up and reports an unrecoverable failure (spec section 13) instead of
     * spinning a max-priority thread against dead hardware.
     */
    const val AUDIO_MAX_CONSECUTIVE_IO_ERRORS = 20

    /** Stuck-button protection: a held transmission stops itself after 120 s. */
    const val MAX_TRANSMIT_MS = 120_000L

    /**
     * A pairing session that neither saves a binding nor is cancelled gives up after this
     * long and reports the timeout as an error event (contract amendment of 2026-08-14).
     */
    const val PAIRING_TIMEOUT_MS = 60_000L

    /**
     * How long a freshly connected endpoint has to send its `hello` before the transport
     * gives up on it, disconnects and lets discovery start over. A peer counts as connected
     * only once its `hello` is seen (spec section 7), so without this bound one lost BYTES
     * payload — or one peer that never sends a `hello` at all — parks that endpoint for the
     * lifetime of the process: no retry, no error, `nearbyCount` stuck at 0 and nothing in
     * the log. Generous compared with the handshake itself, which is one payload each way.
     */
    const val HELLO_TIMEOUT_MS = 10_000L

    const val RECONNECT_INITIAL_DELAY_MS = 1_000L
    const val RECONNECT_MAX_DELAY_MS = 30_000L
    const val RECONNECT_MULTIPLIER = 2
}
