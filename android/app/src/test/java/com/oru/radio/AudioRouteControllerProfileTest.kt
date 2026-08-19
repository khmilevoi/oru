package com.oru.radio

import android.media.AudioManager
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * Section 6 "Profiles" and the first half of "Device selection and recovery": what the
 * controller asks of the platform, in what order, and what audio is on while it waits.
 */
class AudioRouteControllerProfileTest {

    private lateinit var facade: FakeAudioManagerFacade
    private lateinit var scheduler: TestScheduler
    private lateinit var listener: RecordingRouteListener
    private lateinit var controller: AudioRouteController

    @Before
    fun setUp() {
        facade = FakeAudioManagerFacade()
        facade.devices.addAll(listOf(TestDevices.speaker, TestDevices.phoneMic))
        facade.hfpAddresses = listOf(TestDevices.BT_ADDRESS)
        scheduler = TestScheduler()
        listener = RecordingRouteListener()
        controller = AudioRouteController(
            facade = facade,
            scheduler = scheduler,
            clock = { scheduler.nowMs },
            policy = ModePolicy(),
            logger = RecordingRouteLogger(),
        )
        controller.start(listener)
    }

    private fun settle() = scheduler.advance(AudioRouteController.DEVICE_ADD_DEBOUNCE_MS)

    private fun connectBluetooth() {
        facade.connect(TestDevices.btMic, TestDevices.btMedia)
        settle()
    }

    @Test
    fun `nothing external is communication mode on the loudspeaker`() {
        assertEquals(listOf(AudioManager.MODE_IN_COMMUNICATION), facade.modeSets)
        assertTrue(facade.communicationDeviceSelections.isEmpty())
        assertEquals(AudioRoute.Kind.SPEAKER, listener.last.kind)
    }

    @Test
    fun `an output-only external keeps the platform in normal mode`() {
        // Section 11 keeps the three-row table: MODE_IN_COMMUNICATION would drop A2DP/LE from
        // the route and land playback on the loudspeaker, which is the opposite of the goal.
        facade.connect(TestDevices.wiredHeadphones)
        settle()

        assertEquals(AudioManager.MODE_NORMAL, facade.mode)
        assertTrue(facade.communicationDeviceSelections.isEmpty())
        assertEquals(AudioRoute.Kind.WIRED, listener.last.kind)
    }

    @Test
    fun `voice selects the headset once the platform mode has landed`() {
        connectBluetooth()

        assertEquals(AudioManager.MODE_IN_COMMUNICATION, facade.mode)
        assertEquals(listOf(TestDevices.btMic), facade.communicationDeviceSelections)
        // A Bluetooth Classic target always gets the legacy establishment alongside the
        // selection: on scoManagedByAudio=false stacks it is the only thing that raises SCO.
        assertEquals(listOf(TestDevices.btMic), facade.voiceLinkStarts)
    }

    @Test
    fun `the mode is set before the communication device`() {
        // setUp() leaves the loudspeaker row in MODE_IN_COMMUNICATION, and the headset row
        // wants the same value — so a bare connect asks for no transition at all. An
        // output-only external first puts the platform on the three-row table's second row,
        // MODE_NORMAL, which makes the headset's mic a real mode change to wait for.
        facade.connect(TestDevices.wiredHeadphones)
        settle()
        facade.modeSets.clear()
        facade.modeFollowsSet = false

        connectBluetooth()

        // The mode never landed, so nothing was selected yet, and the mode was asked for
        // exactly once -- section 6 replaces the 3 x 100 ms polling with the listener.
        assertEquals(listOf(AudioManager.MODE_IN_COMMUNICATION), facade.modeSets)
        assertTrue(facade.communicationDeviceSelections.isEmpty())
    }

    @Test
    fun `a stack that never confirms the mode is routed anyway after the backstop`() {
        facade.connect(TestDevices.wiredHeadphones)
        settle()
        facade.modeSets.clear()
        facade.modeFollowsSet = false
        connectBluetooth()

        scheduler.advance(AudioRouteController.MODE_SETTLE_TIMEOUT_MS)

        assertEquals(listOf(TestDevices.btMic), facade.communicationDeviceSelections)
        assertEquals(listOf(AudioManager.MODE_IN_COMMUNICATION), facade.modeSets)
    }

    @Test
    fun `audio keeps flowing on the previous route while the new link establishes`() {
        facade.connect(TestDevices.wiredHeadset)
        settle()
        assertEquals(AudioRoute.Kind.WIRED, listener.last.kind)
        val publishedBefore = listener.routes.size

        connectBluetooth()

        // Section 6: "audio keeps flowing on the previous route while SCO / comm-device
        // establishment is in flight". The wired headset is still the communication device
        // and nothing was cleared, so there is no dead air.
        assertEquals(0, facade.communicationDeviceClears)
        assertEquals(publishedBefore, listener.routes.size)

        facade.voiceLink(VoiceLinkState.CONNECTED)

        assertEquals(AudioRoute.Kind.BLUETOOTH, listener.last.kind)
        assertEquals("Buds Pro", listener.last.label)
    }

    @Test
    fun `a wired headset is in force as soon as the platform accepts it`() {
        // Wired, USB and LE Audio have no link to negotiate (section 7: the policy is inert
        // there), so the selection is the route.
        facade.connect(TestDevices.wiredHeadset)
        settle()

        assertEquals(listOf(TestDevices.wiredHeadset), facade.communicationDeviceSelections)
        assertTrue(facade.voiceLinkStarts.isEmpty())
        assertEquals(AudioRoute.Kind.WIRED, listener.last.kind)
    }

    @Test
    fun `a rejected selection is retried once and then demoted to the output-only row`() {
        facade.acceptsCommunicationDevice = false

        connectBluetooth()

        // Section 6: max two attempts per episode; the second failure demotes the device
        // until the next device event -- it is never blacklisted for the session.
        assertEquals(
            AudioRouteController.MAX_ESTABLISH_ATTEMPTS,
            facade.communicationDeviceSelections.size,
        )
        // Playback still reaches the headset over its media route, with the phone mic.
        assertEquals(AudioManager.MODE_NORMAL, facade.mode)
        assertEquals(AudioRoute.Kind.BLUETOOTH, listener.last.kind)
    }

    @Test
    fun `a device event refreshes the retry budget`() {
        facade.acceptsCommunicationDevice = false
        connectBluetooth()
        val exhausted = facade.communicationDeviceSelections.size

        // Any device event lifts the demotion; a fresh connection also zeroes the counter.
        facade.acceptsCommunicationDevice = true
        facade.disconnect(TestDevices.btMic, TestDevices.btMedia)
        facade.connect(TestDevices.btMic, TestDevices.btMedia)
        settle()

        assertEquals(exhausted + 1, facade.communicationDeviceSelections.size)
        assertEquals(TestDevices.btMic, facade.communicationDevice)
    }
}
