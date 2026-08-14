package com.oru.radio

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class PttLearningStateMachineTest {

    private val service = "0000ffe0-0000-1000-8000-00805f9b34fb"
    private val characteristic = "0000ffe1-0000-1000-8000-00805f9b34fb"

    private fun machine(name: String? = "PTT-Button") =
        PttLearningStateMachine(deviceId = "AA:BB:CC:DD:EE:FF", deviceName = name)

    @Test
    fun `the first notification only records the pressed value`() {
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
}
