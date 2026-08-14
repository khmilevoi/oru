package com.oru.radio

import org.junit.Assert.assertArrayEquals
import org.junit.Test

class AudioMixerTest {

    @Test
    fun `no sources means silence`() {
        val out = shortArrayOf(7, 7, 7)

        AudioMixer.mix(emptyList(), out)

        assertArrayEquals(shortArrayOf(0, 0, 0), out)
    }

    @Test
    fun `a single source passes through unchanged`() {
        val out = ShortArray(3)

        AudioMixer.mix(listOf(shortArrayOf(1, -2, 3)), out)

        assertArrayEquals(shortArrayOf(1, -2, 3), out)
    }

    @Test
    fun `concurrent transmitters are summed`() {
        val out = ShortArray(3)

        AudioMixer.mix(listOf(shortArrayOf(100, -100, 0), shortArrayOf(50, -50, 25)), out)

        assertArrayEquals(shortArrayOf(150, -150, 25), out)
    }

    @Test
    fun `the sum saturates instead of wrapping around`() {
        val out = ShortArray(2)

        AudioMixer.mix(
            listOf(
                shortArrayOf(Short.MAX_VALUE, Short.MIN_VALUE),
                shortArrayOf(Short.MAX_VALUE, Short.MIN_VALUE),
            ),
            out,
        )

        assertArrayEquals(shortArrayOf(Short.MAX_VALUE, Short.MIN_VALUE), out)
    }

    @Test
    fun `a shorter source is treated as silence past its end`() {
        val out = ShortArray(3)

        AudioMixer.mix(listOf(shortArrayOf(5, 5), shortArrayOf(1, 1, 1)), out)

        assertArrayEquals(shortArrayOf(6, 6, 1), out)
    }
}
