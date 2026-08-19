package com.oru.bridge

import com.oru.radio.PttBinding
import com.oru.radio.PttConfiguration
import com.oru.radio.PttPairingPhase
import com.oru.radio.RadioState

/**
 * Everything the Turbo Module hands back to JavaScript. An interface, so
 * [RadioBridgeCore] never sees a React Native type and runs under plain JVM
 * unit tests.
 */
interface RadioBridgeOutput {
    fun emitState(state: Map<String, Any?>)
    fun emitError(code: String, message: String)
}

/**
 * Spec section 8, as a compile-keeping stub.
 *
 * The Codegen spec now publishes `audioRoute` and `audioMode`, and JavaScript
 * types both as required, so every projection must carry them or the screens
 * read `undefined` through a type that promises otherwise. P4 replaces this
 * constant with the real `AudioRouteController` output and the real
 * SharedPreferences-backed setting; until then the bridge reports the honest
 * pre-routing truth -- loudspeaker, voice profile, no pin -- and stores nothing.
 *
 * `label` is deliberately absent rather than null: section 8 makes it optional
 * and only a Bluetooth route has one, the same rule `pttButton.name` follows.
 */
private val PLACEHOLDER_AUDIO_ROUTE: Map<String, Any?> = mapOf(
    "kind" to "speaker",
    "mode" to "voice",
)

private const val PLACEHOLDER_AUDIO_MODE = "auto"

/**
 * The whole of the Android bridge's logic, with no Android and no React Native
 * in it.
 *
 * Spec section 6.1: `status: 'off'` is the state the radio is in *before*
 * `start()` and *after* `stop()`. Neither engine has an `off` status of its own
 * — Kotlin's `RadioStatus` is STARTING/READY/ERROR and `stopRadio()` resets to
 * `RadioState()`, i.e. back to `starting` — so mapping the stopped engine onto
 * `'off'` is the bridge's job, and this is where it happens. The shape is
 * `radio.native.mock.ts`'s `toOffState()` field for field, because section 15
 * Stage 3 accepts the real binding by the merged Stage 2 screens behaving
 * exactly as they did against the mock.
 *
 * Threading: [onEngineState] and [onEngineError] arrive on the engine's
 * scheduler thread while [start], [stop], [snapshot], [beginPairing],
 * [refresh], [startFailed] and [detach] are called from the JS thread, so every
 * public method is `@Synchronized` on this instance. The output callbacks run
 * inside that lock on purpose: they only hand a finished map to React Native
 * and never call back into this class, so there is no re-entrancy to deadlock
 * on, and emissions stay in the order the state changed.
 */
class RadioBridgeCore(
    private val output: RadioBridgeOutput,
    private val storedConfiguration: () -> PttConfiguration?,
) {

    private class PairingRequest(
        val onSaved: (Map<String, Any?>) -> Unit,
        val onFailed: (String, String) -> Unit,
    ) {
        /**
         * `PttManager` parks a finished session on `saved` until the next
         * `startPairing()`, so a *stale* `saved` snapshot is observable at the
         * moment a new session is armed. Only a `saved` that follows this
         * session's own `scanning`/`learning` snapshot may resolve it.
         */
        var sawOwnSession = false
    }

    private var running = false
    private var lastEngineState: RadioState? = null
    private var failed = false
    private var pairing: PairingRequest? = null

    // --- what JavaScript reads -----------------------------------------------------------

    @Synchronized
    fun snapshot(): Map<String, Any?> = project()

    // --- what JavaScript drives ----------------------------------------------------------

    /**
     * Publishes `starting` *before* the promise resolves and before the service
     * has been asked to start, per the implementation note in
     * `specs/NativeRadio.ts`: `radio.model.ts` never writes its mirror from a
     * call's return value.
     */
    @Synchronized
    fun start() {
        running = true
        failed = false
        lastEngineState = null
        output.emitState(project())
    }

    /**
     * Adopts an engine that is already running when this bridge attaches.
     *
     * `RadioForegroundService` is START_STICKY and outlives the React context,
     * so a fresh JavaScript context can attach to a radio that is already on.
     * Without this the projection answers `off` -- with `nearbyCount: 0`, and a
     * `configurePtt()` that rejects `radio_off` -- for a radio whose own
     * notification says it is running.
     */
    @Synchronized
    fun adopt(state: RadioState) {
        running = true
        failed = false
        lastEngineState = state
        output.emitState(project())
    }

    /** Spec section 13: an unrecoverable failure is an error event *and* the error status. */
    @Synchronized
    fun startFailed(code: String, message: String) {
        failed = true
        output.emitError(code, message)
        output.emitState(project())
        failPairing(code, message)
    }

    @Synchronized
    fun stop() {
        running = false
        failed = false
        lastEngineState = null
        failPairing("pairing_cancelled", "Pairing cancelled: the radio stopped")
        output.emitState(project())
    }

    /** Re-publish after something outside the engine changed — a cleared binding store. */
    @Synchronized
    fun refresh() {
        output.emitState(project())
    }

    /**
     * Arms `configurePtt()`. Returns true when the caller should now ask the
     * engine to start pairing; false when the request already failed, which is
     * the case whenever there is no engine to pair with — on Android the PTT
     * drivers live inside the foreground service, so a stopped radio cannot
     * scan. `radio.native.mock.ts` pairs in any power state; that difference is
     * documented in `docs/stage3-bridge-acceptance.md` and is a rejection the
     * merged pairing screen already renders.
     */
    @Synchronized
    fun beginPairing(
        engineAvailable: Boolean,
        onSaved: (Map<String, Any?>) -> Unit,
        onFailed: (String, String) -> Unit,
    ): Boolean {
        failPairing("pairing_superseded", "A new pairing session replaced this one")

        if (!running || !engineAvailable) {
            onFailed("radio_off", "The radio must be on to pair a PTT button")
            return false
        }

        pairing = PairingRequest(onSaved, onFailed)
        return true
    }

    @Synchronized
    fun detach() {
        failPairing("bridge_detached", "The radio bridge was torn down")
    }

    // --- what the engine reports ---------------------------------------------------------

    @Synchronized
    fun onEngineState(state: RadioState) {
        lastEngineState = state
        output.emitState(project())

        val request = pairing ?: return
        when (state.pttPairing?.phase) {
            PttPairingPhase.SCANNING, PttPairingPhase.LEARNING -> request.sawOwnSession = true
            PttPairingPhase.SAVED -> if (request.sawOwnSession) resolvePairing(request)
            null -> Unit
        }
    }

    @Synchronized
    fun onEngineError(code: String, message: String) {
        output.emitError(code, message)
        // A pairing session cannot outlive the radio that hosts it, and the
        // error event is the only failure channel the contract has (section 13).
        failPairing(code, message)
    }

    // --- projection -----------------------------------------------------------------------

    private fun project(): Map<String, Any?> {
        val state = lastEngineState
        val projected = when {
            failed -> offState() + ("status" to "error")
            !running -> offState()
            state == null -> offState() + ("status" to "starting")
            else -> withoutNulls(state.toMap())
        }

        // Added here, after `withoutNulls`, rather than inside `offState()` and
        // `RadioState.toMap()`: `toMap()` lives in `com.oru.radio`, which this
        // plan does not own, and one place is one place to delete when P4
        // publishes the real route.
        return projected +
            ("audioRoute" to PLACEHOLDER_AUDIO_ROUTE) +
            ("audioMode" to PLACEHOLDER_AUDIO_MODE)
    }

    /**
     * The mock's `toOffState()` + `preservedButton()`, field for field: the
     * button survives a power cycle (section 9.2 stores it natively) but is
     * never reported connected while nothing is running.
     */
    private fun offState(): Map<String, Any?> {
        val configuration = storedConfiguration()
        val button = buildMap<String, Any?> {
            put("configured", configuration != null)
            put("connected", false)
            configuration?.let { put("name", it.name) }
        }

        return mapOf(
            "status" to "off",
            "nearbyCount" to 0,
            "transmitting" to false,
            "receiving" to false,
            "pttButton" to button,
        )
    }

    /**
     * `RadioState.toMap()` writes `"name" to pttButton.name` unconditionally, so
     * an unconfigured button crosses as `name: null`. The section 6.1 contract
     * has optional fields, not nullable ones — `name?: string` — and iOS's
     * `asDictionary` omits the key. Dropping nulls here is what makes the two
     * platforms produce the same JavaScript value.
     */
    private fun withoutNulls(value: Map<String, Any?>): Map<String, Any?> =
        value.mapNotNull { (key, entry) -> normalize(entry)?.let { key to it } }.toMap()

    @Suppress("UNCHECKED_CAST")
    private fun normalize(entry: Any?): Any? = when (entry) {
        null -> null
        is Map<*, *> -> withoutNulls(entry as Map<String, Any?>)
        is List<*> -> entry.mapNotNull(::normalize)
        else -> entry
    }

    // --- pairing --------------------------------------------------------------------------

    private fun resolvePairing(request: PairingRequest) {
        val configuration = storedConfiguration()
        if (configuration == null) {
            failPairing(
                "pairing_unreadable",
                "The PTT binding was saved but could not be read back",
            )
            return
        }

        pairing = null
        request.onSaved(configurationMap(configuration))
    }

    private fun failPairing(code: String, message: String) {
        val request = pairing ?: return
        pairing = null
        request.onFailed(code, message)
    }

    /** The flat, Codegen-expressible `NativePttBinding` of `specs/NativeRadio.ts`. */
    private fun configurationMap(configuration: PttConfiguration): Map<String, Any?> = mapOf(
        "name" to configuration.name,
        "binding" to when (val binding = configuration.binding) {
            is PttBinding.Ble -> mapOf(
                "type" to "ble",
                "deviceId" to binding.deviceId,
                "serviceUuid" to binding.serviceUuid,
                "characteristicUuid" to binding.characteristicUuid,
                "pressedValue" to binding.pressedValue,
                "releasedValue" to binding.releasedValue,
            )
            is PttBinding.Hid -> mapOf(
                "type" to "hid",
                "keyCode" to binding.keyCode,
            )
        },
    )
}
