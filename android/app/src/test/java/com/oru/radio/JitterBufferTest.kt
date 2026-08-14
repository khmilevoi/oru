package com.oru.radio

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class JitterBufferTest {

    private fun frame(value: Int) = byteArrayOf(value.toByte())

    @Test
    fun `playback waits for the target of three frames`() {
        val buffer = JitterBuffer()

        buffer.push(frame(1))
        assertNull(buffer.pop())
        buffer.push(frame(2))
        assertNull(buffer.pop())
        buffer.push(frame(3))

        assertArrayEquals(frame(1), buffer.pop())
    }

    @Test
    fun `frames come out in order`() {
        val buffer = JitterBuffer()
        (1..3).forEach { buffer.push(frame(it)) }

        assertArrayEquals(frame(1), buffer.pop())
        assertArrayEquals(frame(2), buffer.pop())
        assertArrayEquals(frame(3), buffer.pop())
        assertNull(buffer.pop())
    }

    @Test
    fun `after an underrun playback resumes at the minimum of two frames`() {
        val buffer = JitterBuffer()
        (1..3).forEach { buffer.push(frame(it)) }
        repeat(3) { buffer.pop() }
        assertNull(buffer.pop())

        buffer.push(frame(4))
        assertNull(buffer.pop())

        buffer.push(frame(5))
        assertArrayEquals(frame(4), buffer.pop())
    }

    @Test
    fun `a buffer past its capacity drops the oldest frames`() {
        val buffer = JitterBuffer(targetFrames = 2, resumeFrames = 2, capacityFrames = 3)
        (1..5).forEach { buffer.push(frame(it)) }

        assertEquals(3, buffer.size)
        assertArrayEquals(frame(3), buffer.pop())
    }
}
