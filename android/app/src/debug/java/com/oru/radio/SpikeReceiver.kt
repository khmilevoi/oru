package com.oru.radio

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

/**
 * The rest of the Phase 0 controls. Safe to send while the screen is locked, because by
 * then the foreground service is already running:
 *
 *   adb shell am broadcast -n com.oru/com.oru.radio.SpikeReceiver --es cmd ptt-down
 */
class SpikeReceiver : BroadcastReceiver() {

    private companion object {
        const val TAG = "OruRadio"
    }

    override fun onReceive(context: Context, intent: Intent) {
        val engine = RadioController.engine()
        if (engine == null) {
            Log.w(TAG, "spike: the radio is not running - start it with SpikeActivity first")
            return
        }

        when (val command = intent.getStringExtra("cmd")) {
            "ptt-down" -> engine.startTransmit()
            "ptt-up" -> engine.stopTransmit()
            "state" -> Log.i(TAG, "spike: state=${engine.getState().toMap()}")
            "stop" -> RadioController.stop(context)
            // Pairing progress and the candidate list are part of the state now (contract
            // amendment of 2026-08-14), so SpikeLogger prints them without any callback
            // of its own; `state` dumps the same snapshot on demand.
            "ptt-scan" -> engine.startPttPairing()
            "ptt-pick" -> intent.getStringExtra("device")?.let { engine.selectPttCandidate(it) }
                ?: Log.w(TAG, "spike: ptt-pick needs --es device <address>")
            "ptt-cancel" -> engine.cancelPttPairing()
            "ptt-forget" -> engine.forgetPtt()
            else -> Log.w(TAG, "spike: unknown command $command")
        }
    }
}
