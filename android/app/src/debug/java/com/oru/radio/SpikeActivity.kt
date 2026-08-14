package com.oru.radio

import android.app.Activity
import android.os.Bundle
import android.util.Log
import android.view.KeyEvent

/**
 * Phase 0 (spec section 15) without React Native. This is an Activity rather than a
 * receiver because Android refuses to start a microphone foreground service from the
 * background: launching a visible component is what makes the start legal. It finishes
 * immediately afterwards, and the service keeps running.
 *
 *   adb shell am start -n com.oru/com.oru.radio.SpikeActivity --es cmd start
 *
 * The "keys" command instead keeps the window open and logs every key code it receives,
 * which is how a HID button's key code is discovered.
 */
/**
 * Prints every state change and every error to logcat for the duration of the spike. With
 * the amended contract this is also the pairing UI: scan candidates and the pairing phase
 * arrive as ordinary state changes.
 */
object SpikeLogger : RadioEngineListener {

    override fun onStateChanged(state: RadioState) {
        Log.i("OruRadio", "spike: state=${state.toMap()}")
    }

    override fun onError(code: String, message: String) {
        Log.w("OruRadio", "spike: error $code $message")
    }
}

class SpikeActivity : Activity() {

    private companion object {
        const val TAG = "OruRadio"
    }

    private var capturingKeys = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        when (intent?.getStringExtra("cmd")) {
            "stop" -> {
                RadioController.stop(this)
                Log.i(TAG, "spike: radio stopped")
                finish()
            }
            "keys" -> {
                capturingKeys = true
                Log.i(TAG, "spike: capturing key codes; press the button, then press back")
            }
            else -> {
                RadioController.addListener(SpikeLogger)
                RadioController.start(this)
                Log.i(TAG, "spike: radio starting")
                finish()
            }
        }
    }

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        if (capturingKeys) {
            Log.i(TAG, "spike: keyCode=${event.keyCode} action=${event.action}")
        }
        return if (HidKeyEventBus.dispatch(event.keyCode, event.action)) {
            true
        } else {
            super.dispatchKeyEvent(event)
        }
    }
}
