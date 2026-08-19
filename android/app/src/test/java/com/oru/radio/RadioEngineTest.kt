package com.oru.radio

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class RadioEngineTest {

    private lateinit var transport: FakeTransport
    private lateinit var audio: FakeAudioIo
    private lateinit var ptt: FakePttSource
    private lateinit var routing: FakeAudioRouting
    private lateinit var scheduler: TestScheduler
    private lateinit var listener: RecordingListener
    private lateinit var engine: RadioEngine

    @Before
    fun setUp() {
        transport = FakeTransport()
        audio = FakeAudioIo()
        ptt = FakePttSource()
        routing = FakeAudioRouting()
        scheduler = TestScheduler()
        listener = RecordingListener()
        engine = RadioEngine(transport, audio, ptt, routing, scheduler, streamIds = { "stream-1" })
        engine.addListener(listener)
    }

    @Test
    fun `a new engine is starting and empty`() {
        assertEquals(RadioStatus.STARTING, engine.getState().status)
        assertEquals(0, engine.getState().nearbyCount)
        assertEquals(RadioState(), listener.states.first())
    }

    @Test
    fun `startRadio starts the transport and the button, then reports ready`() {
        engine.startRadio()

        assertTrue(transport.started)
        assertTrue(ptt.started)
        assertEquals(RadioStatus.READY, engine.getState().status)
    }

    @Test
    fun `startRadio is idempotent`() {
        engine.startRadio()
        transport.started = false

        engine.startRadio()

        assertFalse(transport.started)
    }

    @Test
    fun `peers are counted once each and removed on disconnect`() {
        engine.startRadio()

        engine.onPeerConnected("a")
        engine.onPeerConnected("a")
        engine.onPeerConnected("b")
        assertEquals(2, engine.getState().nearbyCount)

        engine.onPeerDisconnected("a")
        assertEquals(1, engine.getState().nearbyCount)
    }

    @Test
    fun `startTransmit opens a stream, starts capture and reports transmitting`() {
        engine.startRadio()

        engine.startTransmit()

        assertEquals(listOf("stream-1"), transport.openedStreams)
        assertTrue(audio.capturing)
        assertEquals(transport.lastSink, audio.captureSink)
        assertTrue(engine.getState().transmitting)
    }

    @Test
    fun `a second startTransmit while transmitting does nothing`() {
        engine.startRadio()
        engine.startTransmit()

        engine.startTransmit()

        assertEquals(1, transport.openedStreams.size)
    }

    @Test
    fun `stopTransmit stops capture, closes the sink and announces tx-stop`() {
        engine.startRadio()
        engine.startTransmit()
        val sink = transport.lastSink!!

        engine.stopTransmit()

        assertFalse(audio.capturing)
        assertTrue(sink.closed)
        assertEquals(listOf("stream-1"), transport.closedStreams)
        assertFalse(engine.getState().transmitting)
    }

    @Test
    fun `stopTransmit without a transmission is a no-op`() {
        engine.startRadio()

        engine.stopTransmit()

        assertTrue(transport.closedStreams.isEmpty())
    }

    @Test
    fun `a held transmission stops itself after the 120 second safety cap`() {
        engine.startRadio()
        engine.startTransmit()

        scheduler.advance(RadioConfig.MAX_TRANSMIT_MS - 1)
        assertTrue(engine.getState().transmitting)

        scheduler.advance(1)
        assertFalse(engine.getState().transmitting)
        assertEquals(listOf("stream-1"), transport.closedStreams)
    }

    @Test
    fun `releasing before the cap cancels it`() {
        engine.startRadio()
        engine.startTransmit()
        engine.stopTransmit()

        scheduler.advance(RadioConfig.MAX_TRANSMIT_MS * 2)

        assertEquals(1, transport.closedStreams.size)
        assertEquals(0, scheduler.pendingCount)
    }

    @Test
    fun `the button drives the same path as the screen`() {
        engine.startRadio()

        ptt.listener!!.onPttPressed()
        assertTrue(engine.getState().transmitting)

        ptt.listener!!.onPttReleased()
        assertFalse(engine.getState().transmitting)
    }

    @Test
    fun `incoming audio opens playback and reports receiving`() {
        engine.startRadio()

        engine.onIncomingAudioStarted("a", "s1")
        assertTrue(engine.getState().receiving)
        assertEquals(listOf("a"), audio.openedPlayback)

        engine.onIncomingAudioFrame("a", byteArrayOf(9))
        assertEquals(1, audio.playedFrames.size)

        engine.onIncomingAudioStopped("a", "s1")
        assertFalse(engine.getState().receiving)
        assertEquals(listOf("a"), audio.closedPlayback)
    }

    @Test
    fun `receiving stays true while any peer is still transmitting`() {
        engine.startRadio()
        engine.onIncomingAudioStarted("a", "s1")
        engine.onIncomingAudioStarted("b", "s2")

        engine.onIncomingAudioStopped("a", "s1")

        assertTrue(engine.getState().receiving)
    }

    @Test
    fun `a peer that disappears mid-transmission stops its playback`() {
        engine.startRadio()
        engine.onIncomingAudioStarted("a", "s1")

        engine.onPeerDisconnected("a")

        assertFalse(engine.getState().receiving)
        assertEquals(listOf("a"), audio.closedPlayback)
    }

    @Test
    fun `frames from a peer that is not transmitting are dropped`() {
        engine.startRadio()

        engine.onIncomingAudioFrame("ghost", byteArrayOf(1))

        assertTrue(audio.playedFrames.isEmpty())
    }

    @Test
    fun `an unrecoverable transport failure is an error event and an error status`() {
        engine.startRadio()
        engine.startTransmit()

        engine.onTransportFailure("advertising_failed", "boom")

        assertEquals(RadioStatus.ERROR, engine.getState().status)
        assertEquals(listOf("advertising_failed" to "boom"), listener.errors)
        assertFalse(engine.getState().transmitting)
    }

    @Test
    fun `an unrecoverable audio failure is reported the same way`() {
        engine.startRadio()

        audio.capturedFailureListener!!("microphone_unavailable", "AudioRecord did not initialize")

        assertEquals(RadioStatus.ERROR, engine.getState().status)
        assertEquals(
            listOf("microphone_unavailable" to "AudioRecord did not initialize"),
            listener.errors,
        )
    }

    @Test
    fun `an unrecoverable failure tears the receive path down too`() {
        engine.startRadio()
        engine.onPeerConnected("a")
        engine.onIncomingAudioStarted("a", "s1")
        engine.startTransmit()

        engine.onTransportFailure("advertising_failed", "boom")

        // A radio that reports status=error while it is still playing audio and still
        // counting peers is lying about being dead, and its playback thread keeps running.
        assertEquals(RadioStatus.ERROR, engine.getState().status)
        assertFalse(engine.getState().transmitting)
        assertFalse(engine.getState().receiving)
        assertEquals(0, engine.getState().nearbyCount)
        assertEquals(listOf("a"), audio.closedPlayback)
    }

    @Test
    fun `nothing re-enters the receive path once the radio has failed`() {
        engine.startRadio()
        engine.onTransportFailure("advertising_failed", "boom")

        engine.onPeerConnected("b")
        engine.onIncomingAudioStarted("b", "s2")
        engine.onIncomingAudioFrame("b", byteArrayOf(1))

        assertEquals(0, engine.getState().nearbyCount)
        assertFalse(engine.getState().receiving)
        assertTrue(audio.openedPlayback.isEmpty())
        assertTrue(audio.playedFrames.isEmpty())
    }

    @Test
    fun `transmission is refused while in the error status`() {
        engine.startRadio()
        engine.onTransportFailure("advertising_failed", "boom")

        engine.startTransmit()

        assertTrue(transport.openedStreams.isEmpty())
    }

    @Test
    fun `the button state is mirrored into the radio state`() {
        engine.startRadio()

        ptt.listener!!.onPttButtonStateChanged(PttButtonState(true, true, "PTT-Button"))

        assertEquals(PttButtonState(true, true, "PTT-Button"), engine.getState().pttButton)
    }

    @Test
    fun `stopRadio tears everything down and resets the state`() {
        engine.startRadio()
        engine.onPeerConnected("a")
        engine.onIncomingAudioStarted("a", "s1")
        engine.startTransmit()

        engine.stopRadio()

        assertTrue(transport.stopped)
        assertTrue(ptt.stopped)
        assertTrue(audio.released)
        assertEquals(RadioState(), engine.getState())
    }

    @Test
    fun `pairing and forgetting are delegated to the ptt source`() {
        engine.startRadio()

        engine.startPttPairing()
        assertTrue(ptt.pairingStarted)

        engine.selectPttCandidate("AA:BB:CC:DD:EE:FF")
        assertEquals("AA:BB:CC:DD:EE:FF", ptt.selectedDevice)

        engine.cancelPttPairing()
        assertTrue(ptt.pairingCancelled)

        engine.forgetPtt()
        assertTrue(ptt.forgotten)
    }

    @Test
    fun `pairing progress rides on the state, not on a second event`() {
        engine.startRadio()
        assertNull(engine.getState().pttPairing)

        val scanning = PttPairingState(
            phase = PttPairingPhase.SCANNING,
            candidates = listOf(PttCandidate("AA:BB:CC:DD:EE:FF", "PTT-Button", -54)),
        )
        ptt.listener!!.onPttPairingChanged(scanning)

        assertEquals(scanning, engine.getState().pttPairing)
        assertEquals(scanning, listener.last.pttPairing)
    }

    @Test
    fun `a failed pairing is an error event but leaves the radio ready`() {
        engine.startRadio()
        ptt.listener!!.onPttPairingChanged(PttPairingState(PttPairingPhase.SCANNING))

        ptt.listener!!.onPttPairingFailed("pairing_timeout", "No PTT button was paired in time")

        assertNull(engine.getState().pttPairing)
        assertEquals(RadioStatus.READY, engine.getState().status)
        assertEquals(
            listOf("pairing_timeout" to "No PTT button was paired in time"),
            listener.errors,
        )
    }

    @Test
    fun `a listener only hears about real changes`() {
        engine.startRadio()
        val before = listener.states.size

        engine.onPeerDisconnected("nobody")

        assertEquals(before, listener.states.size)
    }

    @Test
    fun `a press waits for the capture grant before opening a stream`() {
        engine.startRadio()
        routing.autoGrant = false

        engine.startTransmit()

        // Section 7: press, then tone, then talk. Peers never hear the 1-3 s of an SCO raise.
        assertEquals(1, routing.pressCount)
        assertTrue(transport.openedStreams.isEmpty())
        assertFalse(listener.last.transmitting)

        routing.grant()

        assertEquals(listOf("stream-1"), transport.openedStreams)
        assertTrue(audio.capturing)
        assertTrue(listener.last.transmitting)
    }

    @Test
    fun `a release before the grant never opens a stream`() {
        engine.startRadio()
        routing.autoGrant = false
        engine.startTransmit()

        engine.stopTransmit()
        routing.grant()

        assertEquals(1, routing.releaseCount)
        assertTrue(transport.openedStreams.isEmpty())
        assertFalse(listener.last.transmitting)
    }

    @Test
    fun `radio activity is reported to the routing`() {
        engine.startRadio()

        engine.onIncomingAudioStarted("peer-1", "s")
        engine.onIncomingAudioStopped("peer-1", "s")

        // Section 7 queues mode switches for idle, so the policy needs both edges and no
        // duplicates in between.
        assertEquals(listOf(true, false), routing.radioActive)
    }

    @Test
    fun `a published route lands in the state and rebuilds the streams`() {
        engine.startRadio()
        val route = AudioRoute(AudioRoute.Kind.BLUETOOTH, "Buds Pro", ModePolicy.Profile.MEDIA)

        routing.publish(route)

        assertEquals(route, listener.last.audioRoute)
        assertEquals(listOf(ModePolicy.Profile.MEDIA), audio.routeChanges)
    }

    @Test
    fun `the audio mode pin is forwarded and published`() {
        engine.startRadio()

        engine.setAudioMode(ModePolicy.AudioMode.MEDIA)

        assertEquals(listOf(ModePolicy.AudioMode.MEDIA), routing.audioModes)
        assertEquals(ModePolicy.AudioMode.MEDIA, listener.last.audioMode)
    }

    @Test
    fun `stopping the radio keeps the pin and releases the routing`() {
        engine.startRadio()
        engine.setAudioMode(ModePolicy.AudioMode.VOICE)

        engine.stopRadio()

        assertTrue(routing.stopped)
        assertEquals(ModePolicy.AudioMode.VOICE, listener.last.audioMode)
    }
}
