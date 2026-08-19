package com.oru.bridge

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.oru.radio.RadioController
import com.oru.radio.RadioEngineListener
import com.oru.radio.RadioState
import com.oru.radio.SharedPreferencesAudioModeStore
import com.oru.radio.SharedPreferencesPttBindingStore
import com.oru.radio.audioModeFromWire
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Spec section 6.1, on Android. Everything with a decision in it lives in
 * [RadioBridgeCore]; this class marshals maps, resolves promises and owns the
 * engine listener's lifetime.
 *
 * The listener is registered on the first call from JavaScript rather than in
 * `initialize()`: the generated `emitOnStateChanged` writes through
 * `mEventEmitterCallback`, which the TurboModule infrastructure installs when
 * the JS side first materialises this module. `RadioController.addListener`
 * replays the current engine state to a listener the instant it is registered,
 * so attaching before that callback exists would emit into nothing at best.
 * Every entry point calls [attach] first, and by then JavaScript has the module.
 */
class NativeRadioModule(private val reactContext: ReactApplicationContext) :
    NativeRadioSpec(reactContext) {

    private val store = SharedPreferencesPttBindingStore(reactContext)
    private val audioModeStore = SharedPreferencesAudioModeStore(reactContext)
    private val appLocaleStore = SharedPreferencesAppLocaleStore(reactContext)

    private val core = RadioBridgeCore(
        output = object : RadioBridgeOutput {
            override fun emitState(state: Map<String, Any?>) = publishState(state)
            override fun emitError(code: String, message: String) = publishError(code, message)
        },
        storedConfiguration = { store.load() },
        storedAudioMode = { audioModeStore.load() },
    )

    // The two generated emitters are `protected` on NativeRadioSpec, so they are
    // called from the class body itself rather than from inside the anonymous
    // object above.
    private fun publishState(state: Map<String, Any?>) {
        emitOnStateChanged(Arguments.makeNativeMap(state))
    }

    private fun publishError(code: String, message: String) {
        emitOnError(Arguments.makeNativeMap(mapOf("code" to code, "message" to message)))
    }

    private val engineListener = object : RadioEngineListener {
        override fun onStateChanged(state: RadioState) = core.onEngineState(state)
        override fun onError(code: String, message: String) = core.onEngineError(code, message)
    }

    private val attached = AtomicBoolean(false)

    private fun attach() {
        if (attached.compareAndSet(false, true)) {
            RadioController.addListener(engineListener)
            // START_STICKY: the service can outlive this React context, so the
            // radio may already be on the first time JavaScript reaches us.
            RadioController.engine()?.let { core.adopt(it.getState()) }
        }
    }

    override fun invalidate() {
        if (attached.compareAndSet(true, false)) {
            RadioController.removeListener(engineListener)
        }
        core.detach()
        super.invalidate()
    }

    // --- section 6.1 -----------------------------------------------------------------------

    override fun start(promise: Promise) {
        attach()
        core.start()
        try {
            RadioController.start(reactContext)
        } catch (error: Exception) {
            // startForegroundService() throws when the app may not start one --
            // section 13's unrecoverable failure, reported as the error event
            // *and* the error status rather than as a rejected promise, so the
            // merged error screen and its restart action see it the same way
            // they see an engine failure.
            core.startFailed("start_failed", error.message ?: error.javaClass.simpleName)
        }
        // The engine no-ops startRadio() while already started and does not
        // clear that flag on failure, so a section 13 restart can leave it
        // exactly where it was. Re-read it rather than leaving JavaScript on
        // the `starting` we optimistically published. Null on a cold start --
        // the service is not up yet -- and the buffered listener replay covers
        // that case instead.
        RadioController.engine()?.let { core.onEngineState(it.getState()) }
        promise.resolve(null)
    }

    override fun stop(promise: Promise) {
        attach()
        // Before the service is touched: stopRadio() emits a `starting` snapshot
        // on its way down and core.stop() is what masks it into `off`.
        core.stop()
        try {
            RadioController.stop(reactContext)
        } catch (error: Exception) {
            // Same exposure as start(): this also goes through
            // startForegroundService. The radio is already `off` as far as
            // JavaScript is concerned, so report the failure and leave it there.
            core.onEngineError("stop_failed", error.message ?: error.javaClass.simpleName)
        }
        promise.resolve(null)
    }

    override fun pressPtt(promise: Promise) {
        attach()
        RadioController.engine()?.startTransmit()
        promise.resolve(null)
    }

    override fun releasePtt(promise: Promise) {
        attach()
        RadioController.engine()?.stopTransmit()
        promise.resolve(null)
    }

    override fun getState(promise: Promise) {
        attach()
        promise.resolve(Arguments.makeNativeMap(core.snapshot()))
    }

    override fun configurePtt(promise: Promise) {
        attach()
        val engine = RadioController.engine()
        val armed = core.beginPairing(
            engineAvailable = engine != null,
            onSaved = { configuration -> promise.resolve(Arguments.makeNativeMap(configuration)) },
            onFailed = { code, message -> promise.reject(code, message) },
        )
        if (armed) engine?.startPttPairing()
    }

    override fun selectPttCandidate(deviceId: String, promise: Promise) {
        attach()
        RadioController.engine()?.selectPttCandidate(deviceId)
        promise.resolve(null)
    }

    override fun forgetPtt(promise: Promise) {
        attach()
        val engine = RadioController.engine()
        if (engine == null) {
            // No service, no PttManager: clearing the binding store is the same
            // operation PttManager.forget() performs, and without it "forget"
            // would be a silent no-op with the radio powered down.
            store.clear()
            core.refresh()
        } else {
            engine.forgetPtt()
        }
        promise.resolve(null)
    }

    /**
     * Spec section 8. Stores the pin natively (the `PttBindingStore` pattern) and applies it.
     *
     * `radio.native.ts` narrows the string on the way in, but an unknown value still degrades
     * to `auto` rather than throwing across the bridge.
     *
     * With the radio off there is no engine to apply it to, so the store write plus a
     * re-publish is the whole operation — the same shape `forgetPtt` uses. With the radio on,
     * the engine publishes the new pin through `onStateChanged` as it applies it; a pin set to
     * the value it already had changes no state and therefore emits nothing, which is correct:
     * the JavaScript mirror already holds that value.
     */
    override fun setAudioMode(mode: String, promise: Promise) {
        attach()
        val parsed = audioModeFromWire(mode)
        audioModeStore.save(parsed)
        val engine = RadioController.engine()
        if (engine == null) core.refresh() else engine.setAudioMode(parsed)
        promise.resolve(null)
    }

    /**
     * Amended spec §12.2 (2026-08-19): the in-app language override. A plain store, unlike
     * `setAudioMode` above — there is no engine to apply it to and no `onStateChanged` echo;
     * JavaScript owns activating the catalog. Null means no override: follow the system locale.
     */
    override fun getAppLocale(promise: Promise) {
        attach()
        promise.resolve(appLocaleStore.load())
    }

    override fun setAppLocale(locale: String, promise: Promise) {
        attach()
        appLocaleStore.save(locale)
        promise.resolve(null)
    }
}
