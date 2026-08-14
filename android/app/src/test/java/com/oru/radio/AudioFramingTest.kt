package com.oru.radio

import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Test

class AudioFramingTest {

    @Test
    fun `frames round-trip in order`() {
        val first = byteArrayOf(1, 2, 3)
        val second = ByteArray(300) { (it % 251).toByte() }
        val buffer = ByteArrayOutputStream()

        AudioFraming.writeFrame(buffer, first)
        AudioFraming.writeFrame(buffer, second)

        val input = ByteArrayInputStream(buffer.toByteArray())
        assertArrayEquals(first, AudioFraming.readFrame(input))
        assertArrayEquals(second, AudioFraming.readFrame(input))
        assertNull(AudioFraming.readFrame(input))
    }

    @Test
    fun `the header is two bytes, big endian`() {
        val buffer = ByteArrayOutputStream()

        AudioFraming.writeFrame(buffer, ByteArray(258) { 7 })

        val bytes = buffer.toByteArray()
        assertArrayEquals(byteArrayOf(0x01, 0x02), bytes.copyOfRange(0, 2))
    }

    @Test
    fun `a truncated header yields null`() {
        assertNull(AudioFraming.readFrame(ByteArrayInputStream(byteArrayOf(0x00))))
    }

    @Test
    fun `a truncated body yields null`() {
        val truncated = byteArrayOf(0x00, 0x05, 1, 2)

        assertNull(AudioFraming.readFrame(ByteArrayInputStream(truncated)))
    }

    @Test
    fun `a zero length frame yields null`() {
        assertNull(AudioFraming.readFrame(ByteArrayInputStream(byteArrayOf(0x00, 0x00))))
    }

    @Test
    fun `a length above the maximum yields null instead of allocating`() {
        val oversized = byteArrayOf(0xFF.toByte(), 0xFF.toByte(), 1, 2, 3)

        assertNull(AudioFraming.readFrame(ByteArrayInputStream(oversized), maxFrameBytes = 400))
    }

    @Test
    fun `writing an empty frame is a programming error`() {
        assertThrows(IllegalArgumentException::class.java) {
            AudioFraming.writeFrame(ByteArrayOutputStream(), ByteArray(0))
        }
    }
}
