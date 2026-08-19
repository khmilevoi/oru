package com.oru.bridge

import com.oru.radio.AudioRoute
import com.oru.radio.ModePolicy
import com.oru.radio.PttBinding
import com.oru.radio.PttButtonState
import com.oru.radio.PttCandidate
import com.oru.radio.PttConfiguration
import com.oru.radio.PttPairingPhase
import com.oru.radio.PttPairingState
import com.oru.radio.RadioState
import com.oru.radio.RadioStatus
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class RadioBridgeCoreTest {

    private class RecordingOutput : RadioBridgeOutput {
        val states = mutableListOf<Map<String, Any?>>()
        val errors = mutableListOf<Pair<String, String>>()

        override fun emitState(state: Map<String, Any?>) {
            states.add(state)
        }

        override fun emitError(code: String, message: String) {
            errors.add(code to message)
        }

        fun last(): Map<String, Any?> = states.last()
    }

    private val bleConfiguration = PttConfiguration(
        name = "ORU-PTT-01",
        binding = PttBinding.Ble(
            deviceId = "AA:BB:CC:DD:EE:FF",
            serviceUuid = "0000fe59-0000-1000-8000-00805f9b34fb",
            characteristicUuid = "0000fe5a-0000-1000-8000-00805f9b34fb",
            pressedValue = "01",
            releasedValue = "00",
        ),
    )

    private fun core(
        output: RadioBridgeOutput,
        configuration: () -> PttConfiguration? = { null },
        audioMode: () -> ModePolicy.AudioMode = { ModePolicy.AudioMode.AUTO },
    ) = RadioBridgeCore(output, configuration, audioMode)

    @Suppress("UNCHECKED_CAST")
    private fun Map<String, Any?>.button(): Map<String, Any?> =
        this["pttButton"] as Map<String, Any?>

    @Test
    fun `reports off before the first start, with no button configured`() {
        val output = RecordingOutput()
        val snapshot = core(output).snapshot()

        assertEquals("off", snapshot["status"])
        assertEquals(0, snapshot["nearbyCount"])
        assertEquals(false, snapshot["transmitting"])
        assertEquals(false, snapshot["receiving"])
        assertFalse(snapshot.containsKey("pttPairing"))
        assertEquals(false, snapshot.button()["configured"])
        assertEquals(false, snapshot.button()["connected"])
        assertFalse(
            "an absent name must be absent, never null",
            snapshot.button().containsKey("name"),
        )
    }

    @Test
    fun `off preserves the stored button and forces it disconnected`() {
        val output = RecordingOutput()
        val snapshot = core(output, configuration = { bleConfiguration }).snapshot()

        assertEquals(true, snapshot.button()["configured"])
        assertEquals(false, snapshot.button()["connected"])
        assertEquals("ORU-PTT-01", snapshot.button()["name"])
    }

    @Test
    fun `start publishes starting before the engine has said anything`() {
        val output = RecordingOutput()
        val core = core(output, configuration = { bleConfiguration })

        core.start()

        assertEquals(1, output.states.size)
        assertEquals("starting", output.last()["status"])
        assertEquals(0, output.last()["nearbyCount"])
        assertEquals("ORU-PTT-01", output.last().button()["name"])
        assertEquals("starting", core.snapshot()["status"])
    }

    @Test
    fun `a running engine snapshot passes through, with nulls dropped`() {
        val output = RecordingOutput()
        val core = core(output)
        core.start()

        core.onEngineState(
            RadioState(
                status = RadioStatus.READY,
                nearbyCount = 2,
                receiving = true,
                pttButton = PttButtonState(configured = false, connected = false, name = null),
            ),
        )

        assertEquals("ready", output.last()["status"])
        assertEquals(2, output.last()["nearbyCount"])
        assertEquals(true, output.last()["receiving"])
        assertFalse(output.last().button().containsKey("name"))
    }

    @Test
    fun `pairing progress crosses intact`() {
        val output = RecordingOutput()
        val core = core(output)
        core.start()

        core.onEngineState(
            RadioState(
                status = RadioStatus.READY,
                pttPairing = PttPairingState(
                    phase = PttPairingPhase.SCANNING,
                    candidates = listOf(PttCandidate("AA:BB", "ORU-PTT-01", -42)),
                ),
            ),
        )

        @Suppress("UNCHECKED_CAST")
        val pairing = output.last()["pttPairing"] as Map<String, Any?>
        @Suppress("UNCHECKED_CAST")
        val candidates = pairing["candidates"] as List<Map<String, Any?>>
        assertEquals("scanning", pairing["phase"])
        assertEquals("AA:BB", candidates.single()["deviceId"])
        assertEquals(-42, candidates.single()["rssi"])
    }

    @Test
    fun `stop publishes off and masks the engine's own teardown snapshot`() {
        val output = RecordingOutput()
        val core = core(output, configuration = { bleConfiguration })
        core.start()
        core.onEngineState(RadioState(status = RadioStatus.READY, nearbyCount = 3))
        output.states.clear()

        core.stop()
        // RadioEngine.stopRadio() resets to RadioState(), i.e. status = STARTING,
        // and emits it. Without masking the screen would flash "starting" on
        // the way to off.
        core.onEngineState(RadioState())

        assertEquals(2, output.states.size)
        output.states.forEach { state ->
            assertEquals("off", state["status"])
            assertEquals(0, state["nearbyCount"])
        }
        assertEquals("ORU-PTT-01", output.last().button()["name"])
    }

    @Test
    fun `configurePtt resolves with the stored configuration once the session saves`() {
        val output = RecordingOutput()
        var stored: PttConfiguration? = null
        val core = core(output, configuration = { stored })
        core.start()

        var saved: Map<String, Any?>? = null
        var failure: Pair<String, String>? = null
        val armed = core.beginPairing(
            engineAvailable = true,
            onSaved = { saved = it },
            onFailed = { code, message -> failure = code to message },
        )
        assertTrue(armed)

        core.onEngineState(
            RadioState(pttPairing = PttPairingState(PttPairingPhase.SCANNING)),
        )
        assertNull(saved)

        stored = bleConfiguration
        core.onEngineState(
            RadioState(pttPairing = PttPairingState(PttPairingPhase.SAVED)),
        )

        assertNull(failure)
        assertEquals("ORU-PTT-01", saved!!["name"])
        @Suppress("UNCHECKED_CAST")
        val binding = saved!!["binding"] as Map<String, Any?>
        assertEquals("ble", binding["type"])
        assertEquals("AA:BB:CC:DD:EE:FF", binding["deviceId"])
        assertEquals("01", binding["pressedValue"])
        assertEquals("00", binding["releasedValue"])
        assertFalse("a ble binding carries no keyCode", binding.containsKey("keyCode"))
    }

    @Test
    fun `a hid configuration crosses as a flat keyCode binding`() {
        val output = RecordingOutput()
        val hid = PttConfiguration("Headset", PttBinding.Hid(keyCode = 79))
        val core = core(output, configuration = { hid })
        core.start()

        var saved: Map<String, Any?>? = null
        core.beginPairing(true, onSaved = { saved = it }, onFailed = { _, _ -> })
        core.onEngineState(RadioState(pttPairing = PttPairingState(PttPairingPhase.SCANNING)))
        core.onEngineState(RadioState(pttPairing = PttPairingState(PttPairingPhase.SAVED)))

        @Suppress("UNCHECKED_CAST")
        val binding = saved!!["binding"] as Map<String, Any?>
        assertEquals("hid", binding["type"])
        assertEquals(79, binding["keyCode"])
        assertFalse(binding.containsKey("deviceId"))
    }

    @Test
    fun `a leftover saved phase from an earlier session resolves nothing`() {
        val output = RecordingOutput()
        val core = core(output, configuration = { bleConfiguration })
        core.start()
        // PttManager leaves the previous session parked on `saved`.
        core.onEngineState(RadioState(pttPairing = PttPairingState(PttPairingPhase.SAVED)))

        var saved: Map<String, Any?>? = null
        core.beginPairing(true, onSaved = { saved = it }, onFailed = { _, _ -> })
        core.onEngineState(RadioState(pttPairing = PttPairingState(PttPairingPhase.SAVED)))

        assertNull("only this session's own saved snapshot may resolve it", saved)
    }

    @Test
    fun `a saved binding that cannot be read back fails instead of resolving`() {
        val output = RecordingOutput()
        // PttManager.onLearned saves before publishing SAVED, so a null here is
        // the store failing to read back what was just written -- not the normal
        // path. The promise must fail rather than hang or resolve with nothing.
        val core = core(output, configuration = { null })
        core.start()

        var saved: Map<String, Any?>? = null
        var failure: Pair<String, String>? = null
        core.beginPairing(
            engineAvailable = true,
            onSaved = { saved = it },
            onFailed = { code, message -> failure = code to message },
        )
        core.onEngineState(RadioState(pttPairing = PttPairingState(PttPairingPhase.SCANNING)))
        core.onEngineState(RadioState(pttPairing = PttPairingState(PttPairingPhase.SAVED)))

        assertNull("an unreadable binding must not resolve the promise", saved)
        assertEquals("pairing_unreadable", failure?.first)
    }

    @Test
    fun `an engine error is emitted and fails a pending pairing`() {
        val output = RecordingOutput()
        val core = core(output)
        core.start()

        var failure: Pair<String, String>? = null
        core.beginPairing(true, onSaved = {}, onFailed = { code, message -> failure = code to message })
        core.onEngineError("pairing_timeout", "No PTT button was paired in time")

        assertEquals("pairing_timeout" to "No PTT button was paired in time", output.errors.single())
        assertEquals("pairing_timeout" to "No PTT button was paired in time", failure)
    }

    @Test
    fun `pairing fails immediately when the radio is off`() {
        val output = RecordingOutput()
        val core = core(output)

        var failure: Pair<String, String>? = null
        val armed = core.beginPairing(
            engineAvailable = false,
            onSaved = {},
            onFailed = { code, message -> failure = code to message },
        )

        assertFalse(armed)
        assertEquals("radio_off", failure?.first)
    }

    @Test
    fun `a second session supersedes the first`() {
        val output = RecordingOutput()
        val core = core(output)
        core.start()

        var failure: Pair<String, String>? = null
        core.beginPairing(true, onSaved = {}, onFailed = { code, message -> failure = code to message })
        core.beginPairing(true, onSaved = {}, onFailed = { _, _ -> })

        assertEquals("pairing_superseded", failure?.first)
    }

    @Test
    fun `stopping the radio fails a pending pairing`() {
        val output = RecordingOutput()
        val core = core(output)
        core.start()

        var failure: Pair<String, String>? = null
        core.beginPairing(true, onSaved = {}, onFailed = { code, message -> failure = code to message })
        core.stop()

        assertEquals("pairing_cancelled", failure?.first)
    }

    @Test
    fun `startFailed reports the section 13 pair - an error event and the error status`() {
        val output = RecordingOutput()
        val core = core(output)
        core.start()

        core.startFailed("foreground_service_denied", "The radio may not run in the foreground")

        assertEquals("foreground_service_denied", output.errors.single().first)
        assertEquals("error", output.last()["status"])
        assertEquals("error", core.snapshot()["status"])
    }

    @Test
    fun `a restart the engine refuses reports its real state, not starting`() {
        val output = RecordingOutput()
        val core = core(output)
        core.start()
        core.onEngineState(RadioState(status = RadioStatus.ERROR))
        output.states.clear()

        // Section 13's restart action. Both engines no-op startRadio() while
        // already started and neither clears that flag on failure, so the
        // module re-reads the engine and feeds the truth back in.
        core.start()
        core.onEngineState(RadioState(status = RadioStatus.ERROR))

        assertEquals("error", output.last()["status"])
        assertEquals("error", core.snapshot()["status"])
    }

    @Test
    fun `adopting a service that outlived the app reports the live radio, not off`() {
        val output = RecordingOutput()
        val core = core(output, configuration = { bleConfiguration })

        core.adopt(RadioState(status = RadioStatus.READY, nearbyCount = 2))

        assertEquals("ready", output.last()["status"])
        assertEquals(2, output.last()["nearbyCount"])
        assertEquals("ready", core.snapshot()["status"])
    }

    @Test
    fun `an adopted radio can pair, because its engine is available`() {
        val output = RecordingOutput()
        val core = core(output, configuration = { bleConfiguration })
        core.adopt(RadioState(status = RadioStatus.READY))

        val armed = core.beginPairing(true, onSaved = {}, onFailed = { _, _ -> })

        assertTrue("an adopted radio is running, so pairing must arm", armed)
    }

    @Test
    fun `refresh re-publishes the current projection`() {
        val output = RecordingOutput()
        var stored: PttConfiguration? = bleConfiguration
        val core = core(output, configuration = { stored })

        stored = null
        core.refresh()

        assertEquals("off", output.last()["status"])
        assertEquals(false, output.last().button()["configured"])
    }

    @Test
    fun `detach fails a pending pairing rather than orphaning it`() {
        val output = RecordingOutput()
        val core = core(output)
        core.start()

        var failure: Pair<String, String>? = null
        core.beginPairing(true, onSaved = {}, onFailed = { code, message -> failure = code to message })
        core.detach()

        assertEquals("bridge_detached", failure?.first)
    }

    @Suppress("UNCHECKED_CAST")
    private fun Map<String, Any?>.route(): Map<String, Any?> =
        this["audioRoute"] as Map<String, Any?>

    @Test
    fun `a running engine's real route and pin cross the bridge`() {
        val output = RecordingOutput()
        val core = core(output)
        core.start()

        core.onEngineState(
            RadioState(
                status = RadioStatus.READY,
                audioRoute = AudioRoute(
                    AudioRoute.Kind.BLUETOOTH,
                    "Buds Pro",
                    ModePolicy.Profile.MEDIA,
                ),
                audioMode = ModePolicy.AudioMode.MEDIA,
            ),
        )

        assertEquals("bluetooth", output.last().route()["kind"])
        assertEquals("Buds Pro", output.last().route()["label"])
        assertEquals("media", output.last().route()["mode"])
        assertEquals("media", output.last()["audioMode"])
    }

    @Test
    fun `a route with no label omits the key, never sends null`() {
        val output = RecordingOutput()
        val core = core(output)
        core.start()

        core.onEngineState(RadioState(status = RadioStatus.READY))

        assertEquals("speaker", output.last().route()["kind"])
        assertEquals("voice", output.last().route()["mode"])
        assertFalse(output.last().route().containsKey("label"))
    }

    @Test
    fun `off, starting and error report the loudspeaker and the stored pin`() {
        val output = RecordingOutput()
        val stored = core(output, audioMode = { ModePolicy.AudioMode.VOICE })

        // Off: no engine to ask, so the honest answer is the loudspeaker and the pin as saved.
        assertEquals("speaker", stored.snapshot().route()["kind"])
        assertEquals("voice", stored.snapshot()["audioMode"])

        stored.start()
        assertEquals("speaker", output.last().route()["kind"])
        assertEquals("voice", output.last()["audioMode"])

        stored.startFailed("boom", "the service would not start")
        assertEquals("error", output.last()["status"])
        assertEquals("voice", output.last()["audioMode"])
    }
}
