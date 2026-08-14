package com.oru.radio

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class PttManagerTest {

    private class FakeStore(var stored: PttConfiguration? = null) : PttBindingStore {
        var cleared = false
        override fun load(): PttConfiguration? = stored
        override fun save(configuration: PttConfiguration) {
            stored = configuration
        }
        override fun clear() {
            stored = null
            cleared = true
        }
    }

    private class FakeDriver(val binding: PttBinding) : PttDriver {
        var started = false
        var stopped = false
        override fun start() {
            started = true
        }
        override fun stop() {
            stopped = true
        }
    }

    private class FakeFactory : PttDriverFactory {
        val created = mutableListOf<FakeDriver>()
        var driverListener: PttDriverListener? = null
        var learningListener: PttLearningListener? = null
        var selectedDevice: String? = null
        var learningCancelled = 0

        override fun create(binding: PttBinding, listener: PttDriverListener): PttDriver {
            driverListener = listener
            return FakeDriver(binding).also { created.add(it) }
        }

        override fun startLearning(listener: PttLearningListener) {
            learningListener = listener
        }

        override fun selectCandidate(deviceId: String) {
            selectedDevice = deviceId
        }

        override fun cancelLearning() {
            learningCancelled++
        }
    }

    private class RecordingPttListener : PttListener {
        var presses = 0
        var releases = 0
        val states = mutableListOf<PttButtonState>()
        val pairings = mutableListOf<PttPairingState?>()
        val failures = mutableListOf<Pair<String, String>>()

        override fun onPttPressed() {
            presses++
        }
        override fun onPttReleased() {
            releases++
        }
        override fun onPttButtonStateChanged(state: PttButtonState) {
            states.add(state)
        }
        override fun onPttPairingChanged(pairing: PttPairingState?) {
            pairings.add(pairing)
        }
        override fun onPttPairingFailed(code: String, message: String) {
            failures.add(code to message)
        }

        val lastPairing: PttPairingState? get() = pairings.last()
    }

    private val bleConfiguration = PttConfiguration(
        name = "PTT-Button",
        binding = PttBinding.Ble(
            deviceId = "AA:BB:CC:DD:EE:FF",
            serviceUuid = "0000ffe0-0000-1000-8000-00805f9b34fb",
            characteristicUuid = "0000ffe1-0000-1000-8000-00805f9b34fb",
            pressedValue = "01",
            releasedValue = "00",
        ),
    )

    private lateinit var store: FakeStore
    private lateinit var factory: FakeFactory
    private lateinit var listener: RecordingPttListener
    private lateinit var scheduler: TestScheduler
    private lateinit var manager: PttManager

    @Before
    fun setUp() {
        store = FakeStore()
        factory = FakeFactory()
        listener = RecordingPttListener()
        scheduler = TestScheduler()
        manager = PttManager(store, factory, scheduler)
    }

    @Test
    fun `with nothing stored the button is simply not configured`() {
        manager.start(listener)

        assertEquals(PttButtonState(false, false, null), manager.snapshot())
        assertTrue(factory.created.isEmpty())
    }

    @Test
    fun `a stored binding is reconnected automatically on start`() {
        store.stored = bleConfiguration

        manager.start(listener)

        assertEquals(1, factory.created.size)
        assertEquals(bleConfiguration.binding, factory.created.single().binding)
        assertTrue(factory.created.single().started)
        assertEquals(PttButtonState(true, false, "PTT-Button"), manager.snapshot())
    }

    @Test
    fun `driver connection is state, not an error`() {
        store.stored = bleConfiguration
        manager.start(listener)

        factory.driverListener!!.onConnectionChanged(true)

        assertEquals(PttButtonState(true, true, "PTT-Button"), manager.snapshot())
        assertEquals(PttButtonState(true, true, "PTT-Button"), listener.states.last())
    }

    @Test
    fun `presses and releases reach the engine`() {
        store.stored = bleConfiguration
        manager.start(listener)

        factory.driverListener!!.onPressed()
        factory.driverListener!!.onReleased()

        assertEquals(1, listener.presses)
        assertEquals(1, listener.releases)
    }

    @Test
    fun `pairing opens with the scanning phase and no candidates`() {
        manager.start(listener)

        manager.startPairing()

        assertEquals(PttPairingState(PttPairingPhase.SCANNING, emptyList()), listener.lastPairing)
    }

    @Test
    fun `found devices become candidates, strongest signal first`() {
        manager.start(listener)
        manager.startPairing()

        factory.learningListener!!.onDeviceFound("11:22:33:44:55:66", null, -80)
        factory.learningListener!!.onDeviceFound("AA:BB:CC:DD:EE:FF", "PTT-Button", -54)

        assertEquals(
            listOf(
                // A nameless device is published under its own address: the contract's
                // candidate name is not optional.
                PttCandidate("AA:BB:CC:DD:EE:FF", "PTT-Button", -54),
                PttCandidate("11:22:33:44:55:66", "11:22:33:44:55:66", -80),
            ),
            listener.lastPairing!!.candidates,
        )
        assertEquals(PttPairingPhase.SCANNING, listener.lastPairing!!.phase)
    }

    @Test
    fun `the same device found twice is one candidate`() {
        manager.start(listener)
        manager.startPairing()

        factory.learningListener!!.onDeviceFound("AA:BB:CC:DD:EE:FF", "PTT-Button", -70)
        factory.learningListener!!.onDeviceFound("AA:BB:CC:DD:EE:FF", "PTT-Button", -54)

        assertEquals(
            listOf(PttCandidate("AA:BB:CC:DD:EE:FF", "PTT-Button", -54)),
            listener.lastPairing!!.candidates,
        )
    }

    @Test
    fun `selecting a candidate moves the session to learning and reaches the driver`() {
        manager.start(listener)
        manager.startPairing()

        manager.selectCandidate("AA:BB:CC:DD:EE:FF")

        assertEquals("AA:BB:CC:DD:EE:FF", factory.selectedDevice)
        assertEquals(PttPairingPhase.LEARNING, listener.lastPairing!!.phase)
    }

    @Test
    fun `selecting a candidate outside a session does nothing`() {
        manager.start(listener)

        manager.selectCandidate("AA:BB:CC:DD:EE:FF")

        assertNull(factory.selectedDevice)
    }

    @Test
    fun `a learned binding is saved, attached, and published as the saved phase`() {
        manager.start(listener)
        manager.startPairing()
        manager.selectCandidate("AA:BB:CC:DD:EE:FF")

        factory.learningListener!!.onLearned(bleConfiguration)

        assertEquals(bleConfiguration, store.stored)
        assertEquals(1, factory.created.size)
        assertTrue(factory.created.single().started)
        assertEquals(PttButtonState(true, false, "PTT-Button"), manager.snapshot())
        assertEquals(PttPairingPhase.SAVED, listener.lastPairing!!.phase)
    }

    @Test
    fun `a failed learning attempt clears the session and reports the failure`() {
        manager.start(listener)
        manager.startPairing()

        factory.learningListener!!.onLearningFailed("scan_failed", "no adapter")

        assertNull(store.stored)
        assertTrue(factory.created.isEmpty())
        assertNull(listener.lastPairing)
        assertEquals(listOf("scan_failed" to "no adapter"), listener.failures)
    }

    @Test
    fun `an unanswered pairing session times out`() {
        manager.start(listener)
        manager.startPairing()

        scheduler.advance(RadioConfig.PAIRING_TIMEOUT_MS)

        assertNull(listener.lastPairing)
        assertEquals(
            listOf("pairing_timeout" to "No PTT button was paired in time"),
            listener.failures,
        )
    }

    @Test
    fun `a saved session does not time out afterwards`() {
        manager.start(listener)
        manager.startPairing()
        factory.learningListener!!.onLearned(bleConfiguration)

        scheduler.advance(RadioConfig.PAIRING_TIMEOUT_MS * 2)

        assertEquals(PttPairingPhase.SAVED, listener.lastPairing!!.phase)
        assertTrue(listener.failures.isEmpty())
    }

    @Test
    fun `cancelling ends the session without reporting a failure`() {
        manager.start(listener)
        manager.startPairing()

        manager.cancelPairing()

        assertNull(listener.lastPairing)
        assertTrue(listener.failures.isEmpty())
        assertEquals(1, factory.learningCancelled)
    }

    @Test
    fun `forgetting stops the driver, clears storage and resets the state`() {
        store.stored = bleConfiguration
        manager.start(listener)

        manager.forget()

        assertTrue(factory.created.single().stopped)
        assertTrue(store.cleared)
        assertEquals(PttButtonState(false, false, null), manager.snapshot())
        assertEquals(PttButtonState(false, false, null), listener.states.last())
    }

    @Test
    fun `stopping releases the driver`() {
        store.stored = bleConfiguration
        manager.start(listener)

        manager.stop()

        assertTrue(factory.created.single().stopped)
        assertFalse(manager.snapshot().connected)
    }

    @Test
    fun `driver selection follows the binding`() {
        assertEquals(PttDriverKind.BLE, PttDriverSelection.kindFor(bleConfiguration.binding))
        // KEYCODE_MEDIA_PLAY_PAUSE (85) and KEYCODE_HEADSETHOOK (79) arrive through a
        // MediaSession, which is the only way to hear them in the background.
        assertEquals(PttDriverKind.MEDIA_BUTTON, PttDriverSelection.kindFor(PttBinding.Hid(85)))
        assertEquals(PttDriverKind.MEDIA_BUTTON, PttDriverSelection.kindFor(PttBinding.Hid(79)))
        assertEquals(PttDriverKind.HID, PttDriverSelection.kindFor(PttBinding.Hid(66)))
    }
}
