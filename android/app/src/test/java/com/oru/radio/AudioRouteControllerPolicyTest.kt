package com.oru.radio

import android.media.AudioManager
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * Section 7, executed. `ModePolicyTest` already asserts the transition table itself; this
 * file asserts that the Android side does what a decision says — the mode it sets, the
 * device it selects or releases, the tone it plays and the capture it grants.
 */
class AudioRouteControllerPolicyTest {

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
        facade.connect(TestDevices.btMic, TestDevices.btMedia)
        scheduler.advance(AudioRouteController.DEVICE_ADD_DEBOUNCE_MS)
        facade.voiceLink(VoiceLinkState.CONNECTED)
    }

    private fun toMedia() {
        facade.otherAudio(true)
        scheduler.advance(ModePolicy.Constants.OTHER_AUDIO_TO_MEDIA_MS)
    }

    @Test
    fun `the headset starts on the voice profile with the link held`() {
        assertEquals(AudioManager.MODE_IN_COMMUNICATION, facade.mode)
        assertEquals(ModePolicy.Profile.VOICE, listener.last.mode)
        assertEquals(AudioRoute.Kind.BLUETOOTH, listener.last.kind)
    }

    @Test
    fun `two seconds of other audio drops the link and hands the headset back to a2dp`() {
        toMedia()

        assertEquals(ModePolicy.Profile.MEDIA, listener.last.mode)
        assertEquals(AudioManager.MODE_NORMAL, facade.mode)
        assertTrue(facade.communicationDeviceClears > 0)
        assertTrue(facade.voiceLinkStops > 0)
        // Playback still goes to the buds, now over A2DP at full quality.
        assertEquals(AudioRoute.Kind.BLUETOOTH, listener.last.kind)
    }

    @Test
    fun `thirty seconds of silence raises the link again`() {
        toMedia()
        val selectionsBefore = facade.communicationDeviceSelections.size

        facade.otherAudio(false)
        scheduler.advance(ModePolicy.Constants.OTHER_AUDIO_TO_VOICE_MS)

        assertEquals(selectionsBefore + 1, facade.communicationDeviceSelections.size)
        assertEquals(AudioManager.MODE_IN_COMMUNICATION, facade.mode)
    }

    @Test
    fun `a switch queues for idle while the radio is busy`() {
        controller.setRadioActive(true)

        toMedia()

        // Section 7: "switches never run during receive or transmit (they queue for idle)".
        assertEquals(ModePolicy.Profile.VOICE, listener.last.mode)

        controller.setRadioActive(false)

        assertEquals(ModePolicy.Profile.MEDIA, listener.last.mode)
    }

    @Test
    fun `pinning voice ignores other audio entirely`() {
        controller.setAudioMode(ModePolicy.AudioMode.VOICE)

        toMedia()

        assertEquals(ModePolicy.Profile.VOICE, listener.last.mode)
        assertEquals(AudioManager.MODE_IN_COMMUNICATION, facade.mode)
    }

    @Test
    fun `pinning media leaves the headset on a2dp with no music playing`() {
        controller.setAudioMode(ModePolicy.AudioMode.MEDIA)

        assertEquals(ModePolicy.Profile.MEDIA, listener.last.mode)
        assertEquals(AudioManager.MODE_NORMAL, facade.mode)
    }

    @Test
    fun `a press in media raises the link, tones and grants capture`() {
        toMedia()
        facade.grantTones.clear()

        controller.onPttPressed()

        // The raise is in flight: no tone yet, no capture yet -- press, then tone, then talk.
        assertTrue(facade.grantTones.isEmpty())
        assertTrue(listener.grants.isEmpty())
        assertEquals(TestDevices.btMic, facade.communicationDeviceSelections.last())

        facade.voiceLink(VoiceLinkState.CONNECTED)

        assertEquals(listOf(ModePolicy.Profile.VOICE), facade.grantTones)
        assertEquals(listOf(ModePolicy.MicSource.ROUTE_DEFAULT), listener.grants)
    }

    @Test
    fun `a raise that times out tones on the media path and falls back to the phone mic`() {
        toMedia()
        facade.grantTones.clear()

        controller.onPttPressed()
        scheduler.advance(ModePolicy.Constants.VOICE_LINK_GRANT_TIMEOUT_MS)

        assertEquals(listOf(ModePolicy.MicSource.PHONE_FALLBACK), listener.grants)
        assertEquals(listOf(ModePolicy.Profile.MEDIA), facade.grantTones)
        assertEquals(AudioManager.MODE_NORMAL, facade.mode)
    }

    @Test
    fun `a raise the platform refuses falls back without waiting for the timeout`() {
        toMedia()
        facade.acceptsCommunicationDevice = false

        controller.onPttPressed()

        assertEquals(listOf(ModePolicy.MicSource.PHONE_FALLBACK), listener.grants)
    }

    @Test
    fun `a press on the voice profile tones immediately`() {
        controller.onPttPressed()

        assertEquals(listOf(ModePolicy.Profile.VOICE), facade.grantTones)
        assertEquals(listOf(ModePolicy.MicSource.ROUTE_DEFAULT), listener.grants)
    }

    @Test
    fun `the linger holds the link and a second press inside it is instant`() {
        toMedia()
        controller.onPttPressed()
        facade.voiceLink(VoiceLinkState.CONNECTED)
        controller.onPttReleased()
        facade.grantTones.clear()
        val selections = facade.communicationDeviceSelections.size

        scheduler.advance(ModePolicy.Constants.VOICE_LINK_LINGER_MS - 1)
        controller.onPttPressed()

        // Still up: no new selection, and the tone is immediate.
        assertEquals(selections, facade.communicationDeviceSelections.size)
        assertEquals(listOf(ModePolicy.Profile.VOICE), facade.grantTones)
    }

    @Test
    fun `the linger expiring drops the link and music resumes`() {
        toMedia()
        controller.onPttPressed()
        facade.voiceLink(VoiceLinkState.CONNECTED)
        controller.onPttReleased()
        val clearsBefore = facade.communicationDeviceClears

        scheduler.advance(ModePolicy.Constants.VOICE_LINK_LINGER_MS)

        assertEquals(ModePolicy.Profile.MEDIA, listener.last.mode)
        assertTrue(facade.communicationDeviceClears > clearsBefore)
    }

    @Test
    fun `a headset that disappears mid-raise fails the raise instead of waiting it out`() {
        toMedia()
        controller.onPttPressed()

        facade.disconnect(TestDevices.btMic, TestDevices.btMedia)

        assertEquals(listOf(ModePolicy.MicSource.PHONE_FALLBACK), listener.grants)
    }
}
