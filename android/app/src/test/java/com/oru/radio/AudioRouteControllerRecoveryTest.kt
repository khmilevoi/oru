package com.oru.radio

import android.media.AudioManager
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * Section 6 "Device selection and recovery", against a platform that lies: a selection it
 * accepts and never builds, a link it drops out from under us, a selection it silently
 * replaces. Section 10's "SCO timeout + bounded retries + counter resets".
 */
class AudioRouteControllerRecoveryTest {

    private lateinit var facade: FakeAudioManagerFacade
    private lateinit var scheduler: TestScheduler
    private lateinit var logger: RecordingRouteLogger
    private lateinit var listener: RecordingRouteListener
    private lateinit var controller: AudioRouteController

    @Before
    fun setUp() {
        facade = FakeAudioManagerFacade()
        facade.devices.addAll(listOf(TestDevices.speaker, TestDevices.phoneMic))
        facade.hfpAddresses = listOf(TestDevices.BT_ADDRESS)
        scheduler = TestScheduler()
        logger = RecordingRouteLogger()
        listener = RecordingRouteListener()
        controller = AudioRouteController(
            facade = facade,
            scheduler = scheduler,
            clock = { scheduler.nowMs },
            policy = ModePolicy(),
            logger = logger,
        )
        controller.start(listener)
        facade.connect(TestDevices.btMic, TestDevices.btMedia)
        scheduler.advance(AudioRouteController.DEVICE_ADD_DEBOUNCE_MS)
    }

    private fun establish() = facade.voiceLink(VoiceLinkState.CONNECTED)

    @Test
    fun `an establishment timeout re-checks ground truth before failing the headset`() {
        // The listener event went missing but the link really is up: keep it. Section 6,
        // "ground truth is re-checked via isAudioConnected before declaring timeout".
        facade.voiceLinkConnected = true

        scheduler.advance(AudioRouteController.ESTABLISH_TIMEOUT_MS)

        assertEquals(AudioRoute.Kind.BLUETOOTH, listener.last.kind)
        assertEquals(AudioManager.MODE_IN_COMMUNICATION, facade.mode)
        // One selection, not a retry: nothing failed.
        assertEquals(1, facade.communicationDeviceSelections.size)
    }

    @Test
    fun `an establishment timeout with no link spends an attempt`() {
        facade.voiceLinkConnected = false

        scheduler.advance(AudioRouteController.ESTABLISH_TIMEOUT_MS)

        assertEquals(2, facade.communicationDeviceSelections.size)
        assertTrue(facade.voiceLinkStops > 0)
    }

    @Test
    fun `two timeouts demote the headset onto the output-only row`() {
        facade.voiceLinkConnected = false

        scheduler.advance(AudioRouteController.ESTABLISH_TIMEOUT_MS)
        scheduler.advance(AudioRouteController.ESTABLISH_TIMEOUT_MS)

        assertEquals(
            AudioRouteController.MAX_ESTABLISH_ATTEMPTS,
            facade.communicationDeviceSelections.size,
        )
        // Playback still reaches the buds over A2DP, with the phone mic.
        assertEquals(AudioManager.MODE_NORMAL, facade.mode)
        assertEquals(AudioRoute.Kind.BLUETOOTH, listener.last.kind)
    }

    @Test
    fun `an sco error spends an attempt immediately`() {
        facade.voiceLink(VoiceLinkState.ERROR)

        assertEquals(2, facade.communicationDeviceSelections.size)
    }

    @Test
    fun `sco theft resets the budget and re-establishes`() {
        establish()
        assertEquals(AudioRoute.Kind.BLUETOOTH, listener.last.kind)
        val selectionsBefore = facade.communicationDeviceSelections.size

        // Signal's wasAudioStateInterrupted: the link went away without us asking.
        facade.voiceLink(VoiceLinkState.DISCONNECTED)

        assertEquals(selectionsBefore + 1, facade.communicationDeviceSelections.size)
        assertTrue(
            logger.lines.any { it.contains("voice link stolen") },
        )
    }

    @Test
    fun `sco theft after two failures still gets a fresh budget`() {
        establish()
        facade.voiceLink(VoiceLinkState.DISCONNECTED)
        facade.voiceLinkConnected = false

        // Section 6: "the counter resets ... on detected SCO theft", so the two attempts
        // that follow are a fresh episode rather than the tail of the old one.
        scheduler.advance(AudioRouteController.ESTABLISH_TIMEOUT_MS)
        scheduler.advance(AudioRouteController.ESTABLISH_TIMEOUT_MS)

        assertEquals(AudioManager.MODE_NORMAL, facade.mode)
    }

    @Test
    fun `the platform clearing our selection is re-asserted`() {
        establish()
        val selectionsBefore = facade.communicationDeviceSelections.size

        facade.platformCommunicationDevice(null)

        assertEquals(selectionsBefore + 1, facade.communicationDeviceSelections.size)
    }

    @Test
    fun `a platform that keeps clearing our selection is given up on`() {
        establish()

        repeat(AudioRouteController.MAX_COMMUNICATION_DEVICE_REASSERTS + 1) {
            facade.platformCommunicationDevice(null)
            facade.voiceLink(VoiceLinkState.CONNECTED)
        }

        // Bounded: the buds end up on the output-only row instead of an applyAudioMode loop.
        assertEquals(AudioManager.MODE_NORMAL, facade.mode)
        assertEquals(AudioRoute.Kind.BLUETOOTH, listener.last.kind)
    }

    @Test
    fun `a further clear inside the cap is re-asserted again`() {
        establish()
        facade.platformCommunicationDevice(null)
        facade.voiceLink(VoiceLinkState.CONNECTED)
        val selectionsAfterFirst = facade.communicationDeviceSelections.size

        // Re-asserts accumulate across an episode rather than being forgiven by a
        // confirmation, but every clear inside the cap still produces a fresh re-selection.
        facade.platformCommunicationDevice(null)

        assertEquals(selectionsAfterFirst + 1, facade.communicationDeviceSelections.size)
    }
}
