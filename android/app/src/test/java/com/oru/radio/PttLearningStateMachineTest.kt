package com.oru.radio

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

class PttLearningStateMachineTest {

    private val service = "0000ffe0-0000-1000-8000-00805f9b34fb"
    private val characteristic = "0000ffe1-0000-1000-8000-00805f9b34fb"

    private fun machine(name: String? = "PTT-Button") =
        PttLearningStateMachine(deviceId = "AA:BB:CC:DD:EE:FF", deviceName = name)

    @Test
    fun `the first notification only records a candidate value`() {
        assertNull(machine().onNotification(service, characteristic, "01"))
    }

    @Test
    fun `a second, different value on the same characteristic completes the binding`() {
        val subject = machine()
        subject.onNotification(service, characteristic, "01")

        val learned = subject.onNotification(service, characteristic, "00")

        assertEquals(
            PttConfiguration(
                name = "PTT-Button",
                binding = PttBinding.Ble(
                    deviceId = "AA:BB:CC:DD:EE:FF",
                    serviceUuid = service,
                    characteristicUuid = characteristic,
                    pressedValue = "01",
                    releasedValue = "00",
                ),
            ),
            learned,
        )
    }

    @Test
    fun `an idle notification arriving first still learns the nonzero value as the press`() {
        // Telink-style buttons (PTT-Z01) push their current idle state, all-zero
        // bytes, the moment the CCCD subscription lands — before any press. Arrival
        // order alone would latch that "00" as pressedValue and invert the binding.
        val subject = machine()
        subject.onNotification(service, characteristic, "00")

        val learned = subject.onNotification(service, characteristic, "01")!!.binding as PttBinding.Ble

        assertEquals("01", learned.pressedValue)
        assertEquals("00", learned.releasedValue)
    }

    @Test
    fun `a multi-byte all-zero first value is also treated as the release`() {
        val subject = machine()
        subject.onNotification(service, characteristic, "0000")

        val learned = subject.onNotification(service, characteristic, "01ff")!!.binding as PttBinding.Ble

        assertEquals("01ff", learned.pressedValue)
        assertEquals("0000", learned.releasedValue)
    }

    @Test
    fun `two nonzero values keep their order of appearance`() {
        // Some buttons signal press and release with two distinct nonzero codes;
        // with no zero value to anchor on, first-seen is still the press.
        val subject = machine()
        subject.onNotification(service, characteristic, "02")

        val learned = subject.onNotification(service, characteristic, "01")!!.binding as PttBinding.Ble

        assertEquals("02", learned.pressedValue)
        assertEquals("01", learned.releasedValue)
    }

    @Test
    fun `two all-zero values of different widths keep their order of appearance`() {
        val subject = machine()
        subject.onNotification(service, characteristic, "00")

        val learned = subject.onNotification(service, characteristic, "0000")!!.binding as PttBinding.Ble

        assertEquals("00", learned.pressedValue)
        assertEquals("0000", learned.releasedValue)
    }

    @Test
    fun `repeating the pressed value is not a release`() {
        val subject = machine()
        subject.onNotification(service, characteristic, "01")

        assertNull(subject.onNotification(service, characteristic, "01"))
    }

    @Test
    fun `notifications from another characteristic are ignored once one is chosen`() {
        val subject = machine()
        subject.onNotification(service, characteristic, "01")

        assertNull(subject.onNotification(service, "0000ffe2-0000-1000-8000-00805f9b34fb", "00"))
    }

    @Test
    fun `empty notifications are ignored`() {
        val subject = machine()

        assertNull(subject.onNotification(service, characteristic, ""))
        assertNull(subject.onNotification(service, characteristic, "01"))
        assertEquals(
            "01",
            (subject.onNotification(service, characteristic, "02")!!.binding as PttBinding.Ble)
                .pressedValue,
        )
    }

    @Test
    fun `a nameless device falls back to its address`() {
        val subject = machine(name = null)
        subject.onNotification(service, characteristic, "01")

        assertEquals("AA:BB:CC:DD:EE:FF", subject.onNotification(service, characteristic, "00")!!.name)
    }

    @Test
    fun `reset starts the capture over`() {
        val subject = machine()
        subject.onNotification(service, characteristic, "01")

        subject.reset()

        assertNull(subject.onNotification(service, characteristic, "00"))
    }

    @Test
    fun `a completed capture never emits a second configuration`() {
        val subject = machine()
        subject.onNotification(service, characteristic, "01")
        assertNotNull(subject.onNotification(service, characteristic, "00"))

        // The GATT stack delivers notifications on a binder *pool*, so a second
        // notification can be in flight on another thread while the first one is still
        // completing the capture. Exactly one binding may ever come out of one machine:
        // two would save one configuration and hand a different one to the driver.
        assertNull(subject.onNotification(service, characteristic, "01"))
        assertNull(subject.onNotification(service, characteristic, "00"))
        assertNull(subject.onNotification(service, characteristic, "02"))
    }

    @Test
    fun `reset re-arms a machine that already completed`() {
        val subject = machine()
        subject.onNotification(service, characteristic, "01")
        assertNotNull(subject.onNotification(service, characteristic, "00"))

        subject.reset()
        subject.onNotification(service, characteristic, "01")

        assertNotNull(subject.onNotification(service, characteristic, "00"))
    }
}
