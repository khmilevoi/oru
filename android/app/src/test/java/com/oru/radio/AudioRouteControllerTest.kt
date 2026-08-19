package com.oru.radio

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * Section 6 device handling and section 10's "connect/disconnect/reconnect, debounce, noisy,
 * watch filter" list. The controller runs on the injected scheduler, which here is inline and
 * carries the virtual clock the policy and the timers share.
 */
class AudioRouteControllerTest {

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
    }

    private fun settle() = scheduler.advance(AudioRouteController.DEVICE_ADD_DEBOUNCE_MS)

    @Test
    fun `starting publishes the built-in route and registers with the platform`() {
        assertTrue(facade.started)
        assertEquals(AudioRoute.Kind.SPEAKER, listener.last.kind)
        assertEquals(null, listener.last.label)
        assertEquals(ModePolicy.Profile.VOICE, listener.last.mode)
    }

    @Test
    fun `a bluetooth headset connecting takes the route once the list settles`() {
        facade.connect(TestDevices.btMic, TestDevices.btMedia)

        // §6: added devices are debounced ~500 ms, because the list flaps while Bluetooth
        // negotiates profiles. Nothing is published before the window closes.
        assertEquals(1, listener.routes.size)

        settle()

        assertEquals(AudioRoute.Kind.BLUETOOTH, listener.last.kind)
        assertEquals("Buds Pro", listener.last.label)
    }

    @Test
    fun `a removed device is handled immediately, with no debounce`() {
        facade.connect(TestDevices.btMic, TestDevices.btMedia)
        settle()

        facade.disconnect(TestDevices.btMic, TestDevices.btMedia)

        // Missing a transmission is worse than hearing it out loud (D3): no waiting.
        assertEquals(AudioRoute.Kind.SPEAKER, listener.last.kind)
    }

    @Test
    fun `reconnecting takes the route again`() {
        facade.connect(TestDevices.btMic, TestDevices.btMedia)
        settle()
        facade.disconnect(TestDevices.btMic, TestDevices.btMedia)
        facade.connect(TestDevices.btMic, TestDevices.btMedia)
        settle()

        assertEquals(AudioRoute.Kind.BLUETOOTH, listener.last.kind)
    }

    @Test
    fun `a burst of additions publishes once`() {
        facade.connect(TestDevices.btMedia)
        scheduler.advance(200)
        facade.connect(TestDevices.btMic)
        scheduler.advance(200)
        assertEquals(1, listener.routes.size)

        settle()

        assertEquals(2, listener.routes.size)
        assertEquals(AudioRoute.Kind.BLUETOOTH, listener.last.kind)
    }

    @Test
    fun `becoming noisy falls back to the loudspeaker before the removal arrives`() {
        facade.connect(TestDevices.wiredHeadphones)
        settle()
        assertEquals(AudioRoute.Kind.WIRED, listener.last.kind)

        // The jack was pulled; the device list has not caught up yet.
        facade.becomingNoisy()

        assertEquals(AudioRoute.Kind.SPEAKER, listener.last.kind)
    }

    @Test
    fun `the noisy guard expires so a device that really is still there comes back`() {
        facade.connect(TestDevices.wiredHeadphones)
        settle()
        facade.becomingNoisy()
        assertEquals(AudioRoute.Kind.SPEAKER, listener.last.kind)

        scheduler.advance(AudioRouteController.NOISY_GUARD_MS)
        controller.reevaluateNow()

        assertEquals(AudioRoute.Kind.WIRED, listener.last.kind)
    }

    @Test
    fun `a watch is never routed to`() {
        facade.connect(TestDevices.watch)
        settle()

        assertEquals(AudioRoute.Kind.SPEAKER, listener.last.kind)
    }

    @Test
    fun `an evaluation that changes nothing publishes nothing`() {
        val before = listener.routes.size

        controller.reevaluateNow()
        controller.reevaluateNow()

        assertEquals(before, listener.routes.size)
    }

    @Test
    fun `an applied route logs the latency since the device event that caused it`() {
        facade.connect(TestDevices.btMic, TestDevices.btMedia)
        scheduler.advance(AudioRouteController.DEVICE_ADD_DEBOUNCE_MS)

        val applied = logger.lines.last { it.startsWith("route: applied") }

        // §10: switch latency is measured, not guessed.
        assertTrue(applied, applied.contains("sinceDeviceEventMs=500"))
        assertTrue(applied, applied.contains("kind=BLUETOOTH"))
    }

    @Test
    fun `the applied route is labelled with the headset, not the phone's own duplicate`() {
        // 2026-08-19 hardware session: connecting the OPENEAR headset made ColorOS enumerate
        // `CPH2747` entries of its own, and once one of them was selected as the communication
        // device the indicator showed the phone's name instead of the headset's.
        facade.localNames = listOf("CPH2747")
        val duplicate = TestDevices.btMic.copy(
            id = 30,
            address = "00:00:00:00:00:00",
            productName = "CPH2747",
        )
        val headset = TestDevices.btMedia.copy(
            id = 31,
            address = "11:22:33:44:55:66",
            productName = "OPENEAR Bone G1",
        )

        facade.connect(duplicate, headset)
        settle()
        facade.voiceLink(VoiceLinkState.CONNECTED)

        assertEquals(AudioRoute.Kind.BLUETOOTH, listener.last.kind)
        assertEquals("OPENEAR Bone G1", listener.last.label)
    }

    @Test
    fun `stopping releases the platform`() {
        controller.stop()

        assertTrue(facade.stopped)
    }
}
