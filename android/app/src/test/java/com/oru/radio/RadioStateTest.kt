package com.oru.radio

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RadioStateTest {

    @Test
    fun `the default state is the section 6-1 starting state`() {
        val map = RadioState().toMap()

        assertEquals("starting", map["status"])
        assertEquals(0, map["nearbyCount"])
        assertEquals(false, map["transmitting"])
        assertEquals(false, map["receiving"])
        assertEquals(
            mapOf("configured" to false, "connected" to false, "name" to null),
            map["pttButton"],
        )
    }

    @Test
    fun `pttPairing is absent, not null, when no pairing session is running`() {
        assertFalse(RadioState().toMap().containsKey("pttPairing"))
    }

    @Test
    fun `a running pairing session serializes phase and candidates`() {
        val state = RadioState(
            status = RadioStatus.READY,
            pttPairing = PttPairingState(
                phase = PttPairingPhase.SCANNING,
                candidates = listOf(
                    PttCandidate("AA:BB:CC:DD:EE:FF", "PTT-Button", -54),
                    PttCandidate("11:22:33:44:55:66", "11:22:33:44:55:66", -80),
                ),
            ),
        )

        val map = state.toMap()

        assertTrue(map.containsKey("pttPairing"))
        assertEquals(
            mapOf(
                "phase" to "scanning",
                "candidates" to listOf(
                    mapOf("deviceId" to "AA:BB:CC:DD:EE:FF", "name" to "PTT-Button", "rssi" to -54),
                    mapOf(
                        "deviceId" to "11:22:33:44:55:66",
                        "name" to "11:22:33:44:55:66",
                        "rssi" to -80,
                    ),
                ),
            ),
            map["pttPairing"],
        )
    }

    @Test
    fun `every pairing phase has the contract's wire name`() {
        assertEquals(
            listOf("scanning", "learning", "saved"),
            PttPairingPhase.entries.map { it.wire },
        )
    }
}
