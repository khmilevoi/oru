package com.oru.radio

import android.os.Handler
import android.os.HandlerThread

/**
 * The engine's thread in production. Nearby, BLE and audio callbacks arrive on whatever
 * thread the platform picks; everything is funnelled here.
 */
class HandlerScheduler(name: String = "oru-radio") : Scheduler {

    private val thread = HandlerThread(name).apply { start() }
    private val handler = Handler(thread.looper)

    override fun execute(action: () -> Unit) {
        handler.post { action() }
    }

    override fun schedule(delayMs: Long, action: () -> Unit): Cancellable {
        val runnable = Runnable { action() }
        handler.postDelayed(runnable, delayMs)
        return Cancellable { handler.removeCallbacks(runnable) }
    }

    fun shutdown() {
        handler.removeCallbacksAndMessages(null)
        thread.quitSafely()
    }
}
