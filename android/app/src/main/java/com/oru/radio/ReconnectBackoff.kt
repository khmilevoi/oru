package com.oru.radio

/**
 * Exponential backoff for native reconnection (spec section 7): a lost peer is retried
 * with a growing delay, and a successful connection resets the sequence.
 */
class ReconnectBackoff(
    private val initialDelayMs: Long = RadioConfig.RECONNECT_INITIAL_DELAY_MS,
    private val maxDelayMs: Long = RadioConfig.RECONNECT_MAX_DELAY_MS,
    private val multiplier: Int = RadioConfig.RECONNECT_MULTIPLIER,
) {
    private var nextDelay: Long = initialDelayMs

    fun nextDelayMs(): Long {
        val delay = nextDelay
        nextDelay = minOf(nextDelay * multiplier, maxDelayMs)
        return delay
    }

    fun reset() {
        nextDelay = initialDelayMs
    }
}
