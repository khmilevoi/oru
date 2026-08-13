package com.oru.radio

import org.junit.Assert.assertEquals
import org.junit.Test

class ReconnectBackoffTest {

    @Test
    fun `first delay is the initial delay`() {
        val backoff = ReconnectBackoff(initialDelayMs = 1_000, maxDelayMs = 30_000, multiplier = 2)

        assertEquals(1_000L, backoff.nextDelayMs())
    }

    @Test
    fun `delays double until they reach the cap and then stay there`() {
        val backoff = ReconnectBackoff(initialDelayMs = 1_000, maxDelayMs = 30_000, multiplier = 2)

        val delays = (1..8).map { backoff.nextDelayMs() }

        assertEquals(
            listOf(1_000L, 2_000L, 4_000L, 8_000L, 16_000L, 30_000L, 30_000L, 30_000L),
            delays,
        )
    }

    @Test
    fun `reset returns to the initial delay`() {
        val backoff = ReconnectBackoff(initialDelayMs = 1_000, maxDelayMs = 30_000, multiplier = 2)
        repeat(4) { backoff.nextDelayMs() }

        backoff.reset()

        assertEquals(1_000L, backoff.nextDelayMs())
    }

    @Test
    fun `the default constructor uses the radio config values`() {
        val backoff = ReconnectBackoff()

        assertEquals(RadioConfig.RECONNECT_INITIAL_DELAY_MS, backoff.nextDelayMs())
    }
}
