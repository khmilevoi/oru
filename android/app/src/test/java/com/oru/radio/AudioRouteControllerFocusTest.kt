package com.oru.radio

import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test

/**
 * Decision D6 and section 10's "focus request/abandon pairing": Android ducks other apps for
 * real, with one transient MAY_DUCK request per voice burst.
 */
class AudioRouteControllerFocusTest {

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

    /** A Bluetooth Classic headset on the route, link up, still on the VOICE profile. */
    private fun withHeadset() {
        facade.connect(TestDevices.btMic, TestDevices.btMedia)
        scheduler.advance(AudioRouteController.DEVICE_ADD_DEBOUNCE_MS)
        facade.voiceLink(VoiceLinkState.CONNECTED)
    }

    /** §9 row 5's world: the same headset, on the MEDIA profile, with music playing. */
    private fun withHeadsetOnMedia() {
        withHeadset()
        facade.otherAudio(true)
        scheduler.advance(ModePolicy.Constants.OTHER_AUDIO_TO_MEDIA_MS)
    }

    @Test
    fun `a session holds no focus while nothing is happening`() {
        // The session-long AUDIOFOCUS_GAIN is gone: music plays untouched while the radio idles.
        assertEquals(0, facade.focusRequests)
        assertEquals(0, facade.focusAbandons)
    }

    @Test
    fun `focus is requested at the start of a burst and abandoned at its end`() {
        controller.setRadioActive(true)
        assertEquals(1, facade.focusRequests)
        assertEquals(0, facade.focusAbandons)

        controller.setRadioActive(false)
        assertEquals(1, facade.focusRequests)
        assertEquals(1, facade.focusAbandons)
    }

    @Test
    fun `a press holds focus across the raise and the whole transmission`() {
        controller.onPttPressed()
        assertEquals(1, facade.focusRequests)

        controller.setRadioActive(true)
        controller.setRadioActive(false)
        controller.onPttReleased()

        assertEquals(1, facade.focusRequests)
        assertEquals(1, facade.focusAbandons)
    }

    @Test
    fun `a press during reception does not double-request`() {
        controller.setRadioActive(true)
        controller.onPttPressed()
        controller.onPttReleased()

        assertEquals(1, facade.focusRequests)
        assertEquals(0, facade.focusAbandons)

        controller.setRadioActive(false)
        assertEquals(1, facade.focusAbandons)
    }

    @Test
    fun `a refused request is still abandoned exactly once`() {
        facade.focusGranted = false

        controller.setRadioActive(true)
        controller.setRadioActive(false)

        assertEquals(1, facade.focusRequests)
        assertEquals(1, facade.focusAbandons)
    }

    @Test
    fun `stopping abandons a burst that was still open`() {
        controller.setRadioActive(true)

        controller.stop()

        assertEquals(1, facade.focusAbandons)
    }

    @Test
    fun `a raise out of media holds the focus until the linger hands the headset back`() {
        // 2026-08-19 hardware session (OPPO CPH2747 + Spotify): the abandon *is* the player's
        // auto-resume trigger, and the 15 s linger still has SCO up, so a resume at release
        // lands on the suppressed A2DP path and the music dies silently. §9 row 5 wants it
        // back after the linger, so the abandon waits for the profile to return to MEDIA.
        withHeadsetOnMedia()

        controller.onPttPressed()
        facade.voiceLink(VoiceLinkState.CONNECTED)
        assertEquals(1, facade.focusRequests)

        controller.onPttReleased()

        assertEquals(ModePolicy.Profile.VOICE, listener.last.mode)
        assertEquals(0, facade.focusAbandons)

        scheduler.advance(ModePolicy.Constants.VOICE_LINK_LINGER_MS)

        assertEquals(ModePolicy.Profile.MEDIA, listener.last.mode)
        assertEquals(1, facade.focusAbandons)
        // Still exactly one request for the whole episode: deferred, never re-requested.
        assertEquals(1, facade.focusRequests)
    }

    @Test
    fun `a second press inside the linger reuses the held focus and pairs once`() {
        withHeadsetOnMedia()
        controller.onPttPressed()
        facade.voiceLink(VoiceLinkState.CONNECTED)
        controller.onPttReleased()

        scheduler.advance(ModePolicy.Constants.VOICE_LINK_LINGER_MS - 1)
        controller.onPttPressed()
        controller.onPttReleased()

        assertEquals(1, facade.focusRequests)
        assertEquals(0, facade.focusAbandons)

        scheduler.advance(ModePolicy.Constants.VOICE_LINK_LINGER_MS)

        assertEquals(1, facade.focusRequests)
        assertEquals(1, facade.focusAbandons)
    }

    @Test
    fun `a burst on the voice profile keeps the per-burst pairing exactly as it was`() {
        // Nothing is lingering out of MEDIA here, so the release abandons as before.
        withHeadset()

        controller.onPttPressed()
        controller.onPttReleased()

        assertEquals(1, facade.focusRequests)
        assertEquals(1, facade.focusAbandons)
    }

    @Test
    fun `stopping inside the linger abandons the deferred focus`() {
        withHeadsetOnMedia()
        controller.onPttPressed()
        facade.voiceLink(VoiceLinkState.CONNECTED)
        controller.onPttReleased()

        controller.stop()

        assertEquals(1, facade.focusAbandons)
    }
}
