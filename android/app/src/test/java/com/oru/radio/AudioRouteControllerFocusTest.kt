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
    private lateinit var controller: AudioRouteController

    @Before
    fun setUp() {
        facade = FakeAudioManagerFacade()
        facade.devices.addAll(listOf(TestDevices.speaker, TestDevices.phoneMic))
        scheduler = TestScheduler()
        controller = AudioRouteController(
            facade = facade,
            scheduler = scheduler,
            clock = { scheduler.nowMs },
            policy = ModePolicy(),
            logger = RecordingRouteLogger(),
        )
        controller.start(RecordingRouteListener())
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
}
