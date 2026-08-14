package com.oru.radio

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class PttBindingCodecTest {

    private val ble = PttConfiguration(
        name = "PTT-Button",
        binding = PttBinding.Ble(
            deviceId = "AA:BB:CC:DD:EE:FF",
            serviceUuid = "0000ffe0-0000-1000-8000-00805f9b34fb",
            characteristicUuid = "0000ffe1-0000-1000-8000-00805f9b34fb",
            pressedValue = "01",
            releasedValue = "00",
        ),
    )

    private val hid = PttConfiguration(name = "Keyboard", binding = PttBinding.Hid(keyCode = 85))

    @Test
    fun `a ble configuration round-trips`() {
        assertEquals(ble, PttBindingCodec.decode(PttBindingCodec.encode(ble)))
    }

    @Test
    fun `a hid configuration round-trips`() {
        assertEquals(hid, PttBindingCodec.decode(PttBindingCodec.encode(hid)))
    }

    @Test
    fun `unusable stored values decode to null instead of throwing`() {
        val garbage = listOf(
            null,
            "",
            "not json",
            "{}",
            """{"name":"x"}""",
            """{"name":"x","binding":{"type":"ble"}}""",
            """{"name":"x","binding":{"type":"hid"}}""",
            """{"name":"x","binding":{"type":"other","keyCode":1}}""",
        )

        garbage.forEach { raw -> assertNull("expected null for: $raw", PttBindingCodec.decode(raw)) }
    }

    @Test
    fun `hex uses uppercase with no separators`() {
        assertEquals("00", PttBindingCodec.toHex(byteArrayOf(0)))
        assertEquals("01FF0A", PttBindingCodec.toHex(byteArrayOf(1, -1, 10)))
        assertEquals("", PttBindingCodec.toHex(ByteArray(0)))
    }

    @Test
    fun `hex parses back to the same bytes and rejects nonsense`() {
        assertArrayEquals(byteArrayOf(1, -1, 10), PttBindingCodec.fromHex("01FF0A"))
        assertArrayEquals(byteArrayOf(1, -1, 10), PttBindingCodec.fromHex("01ff0a"))
        assertNull(PttBindingCodec.fromHex("0"))
        assertNull(PttBindingCodec.fromHex("zz"))
    }
}
