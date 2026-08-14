package com.oru.radio

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ControlMessageCodecTest {

    private fun json(message: ControlMessage) =
        JSONObject(String(ControlMessageCodec.encode(message), Charsets.UTF_8))

    @Test
    fun `hello encodes the spec shape`() {
        val encoded = json(ControlMessage.Hello(1))

        assertEquals("hello", encoded.getString("type"))
        assertEquals(1, encoded.getInt("version"))
    }

    @Test
    fun `tx-start encodes the spec shape`() {
        val encoded = json(ControlMessage.TxStart("stream-1"))

        assertEquals("tx-start", encoded.getString("type"))
        assertEquals("stream-1", encoded.getString("streamId"))
    }

    @Test
    fun `tx-stop encodes the spec shape`() {
        val encoded = json(ControlMessage.TxStop("stream-1"))

        assertEquals("tx-stop", encoded.getString("type"))
        assertEquals("stream-1", encoded.getString("streamId"))
    }

    @Test
    fun `every message round-trips`() {
        val messages = listOf(
            ControlMessage.Hello(RadioConfig.PROTOCOL_VERSION),
            ControlMessage.TxStart("2b1f0c8e-0000-4000-8000-000000000001"),
            ControlMessage.TxStop("2b1f0c8e-0000-4000-8000-000000000001"),
        )

        messages.forEach { message ->
            assertEquals(message, ControlMessageCodec.decode(ControlMessageCodec.encode(message)))
        }
    }

    @Test
    fun `a foreign protocol version decodes - the gate is the engine's job, not the codec's`() {
        val decoded = ControlMessageCodec.decode("""{"type":"hello","version":7}""".toByteArray())

        assertEquals(ControlMessage.Hello(7), decoded)
    }

    @Test
    fun `unparseable payloads decode to null instead of throwing`() {
        val garbage = listOf(
            "",
            "not json",
            "{}",
            """{"type":"nope"}""",
            """{"type":"hello"}""",
            """{"type":"hello","version":"one"}""",
            """{"type":"tx-start"}""",
            """{"type":"tx-start","streamId":""}""",
        )

        garbage.forEach { raw ->
            assertNull("expected null for: $raw", ControlMessageCodec.decode(raw.toByteArray()))
        }
    }
}
