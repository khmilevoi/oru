package com.oru.radio

import java.io.InputStream
import java.io.OutputStream

/**
 * The audio STREAM payload's framing (spec section 7 leaves it to the implementation):
 * every Opus packet is preceded by its length as two big-endian bytes. iOS writes and
 * reads exactly this; see the cross-plan contract in the plan document.
 */
object AudioFraming {

    const val HEADER_BYTES = 2

    fun writeFrame(out: OutputStream, frame: ByteArray) {
        require(frame.isNotEmpty() && frame.size <= 0xFFFF) {
            "frame size out of range: ${frame.size}"
        }
        out.write((frame.size ushr 8) and 0xFF)
        out.write(frame.size and 0xFF)
        out.write(frame)
        out.flush()
    }

    /**
     * Reads one frame, or returns null at end of stream and on any malformed header.
     * A null means "this stream is over" — the caller closes it.
     */
    fun readFrame(
        input: InputStream,
        maxFrameBytes: Int = RadioConfig.MAX_ENCODED_FRAME_BYTES,
    ): ByteArray? {
        val header = ByteArray(HEADER_BYTES)
        if (!readFully(input, header)) return null

        val length = ((header[0].toInt() and 0xFF) shl 8) or (header[1].toInt() and 0xFF)
        if (length < 1 || length > maxFrameBytes) return null

        val frame = ByteArray(length)
        return if (readFully(input, frame)) frame else null
    }

    private fun readFully(input: InputStream, buffer: ByteArray): Boolean {
        var offset = 0
        while (offset < buffer.size) {
            val read = input.read(buffer, offset, buffer.size - offset)
            if (read < 0) return false
            offset += read
        }
        return true
    }
}
