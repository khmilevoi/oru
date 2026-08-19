package com.oru.radio

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Section 6 "Streams survive route changes", as the bookkeeping the two audio loops share.
 * The loops themselves own real AudioRecord/AudioTrack objects and cannot run on the JVM;
 * every decision they make is here instead.
 */
class AudioStreamGuardTest {

    @Test
    fun `the first generation always builds`() {
        assertTrue(AudioStreamGuard().needsRebuild(0))
    }

    @Test
    fun `an unchanged generation is not rebuilt`() {
        val guard = AudioStreamGuard()
        guard.needsRebuild(0)

        assertFalse(guard.needsRebuild(0))
        assertFalse(guard.needsRebuild(0))
    }

    @Test
    fun `a new generation rebuilds`() {
        val guard = AudioStreamGuard()
        guard.needsRebuild(0)

        assertTrue(guard.needsRebuild(1))
    }

    @Test
    fun `the fatal threshold is reached only on a stable route`() {
        val guard = AudioStreamGuard(maxConsecutiveErrors = 3)
        guard.needsRebuild(0)

        assertFalse(guard.onError())
        assertFalse(guard.onError())
        assertTrue(guard.onError())
    }

    @Test
    fun `a route change clears the error run`() {
        val guard = AudioStreamGuard(maxConsecutiveErrors = 3)
        guard.needsRebuild(0)
        guard.onError()
        guard.onError()

        // Section 6: "the consecutive-error counter resets on route transitions, and the fatal
        // threshold applies only while the route is stable" -- a switch must never kill the radio.
        guard.needsRebuild(1)

        assertFalse(guard.onError())
        assertFalse(guard.onError())
        assertTrue(guard.onError())
    }

    @Test
    fun `a good read clears the error run`() {
        val guard = AudioStreamGuard(maxConsecutiveErrors = 2)
        guard.needsRebuild(0)
        guard.onError()
        guard.onSuccess()

        assertFalse(guard.onError())
    }
}
