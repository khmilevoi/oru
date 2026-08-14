package com.oru.radio

import android.os.Handler
import android.os.HandlerThread
import android.util.Log

/**
 * The engine's thread in production. Nearby, BLE and audio callbacks arrive on whatever
 * thread the platform picks; everything is funnelled here.
 *
 * Every task runs inside [guard]. This is the single thread every public engine operation
 * and every re-posted platform callback runs on, and a `Runnable` that throws unwinds
 * `Looper.loop()` and reaches `KillApplicationHandler`: the process dies, taking the radio,
 * the foreground service and any chance of an `error` event with it. One bad task must cost
 * that task and nothing more.
 *
 * Nothing is swallowed: every escaped throwable is logged at error level, and the first one
 * is also reported through [setUncaughtHandler] — which [RadioForegroundService] wires to
 * the engine's own unrecoverable-failure path, so the radio ends up in `status: 'error'`
 * with an `error` event instead of just vanishing. Only the first is reported, because by
 * then the radio is already failed and a report raised from a failure path that is itself
 * failing is how a report/fail livelock starts.
 */
class HandlerScheduler(name: String = "oru-radio") : Scheduler {

    private companion object {
        const val TAG = "OruRadio"
    }

    private val thread = HandlerThread(name).apply { start() }
    private val handler = Handler(thread.looper)

    /** Set from the service's main thread, read on [thread]. */
    @Volatile
    private var onUncaught: ((Throwable) -> Unit)? = null

    /** Touched only from [thread], inside [guard]. */
    private var reported = false

    /**
     * Where an otherwise-fatal throwable goes. Called on the scheduler thread, once.
     */
    fun setUncaughtHandler(handler: (Throwable) -> Unit) {
        onUncaught = handler
    }

    override fun execute(action: () -> Unit) {
        handler.post { guard(action) }
    }

    override fun schedule(delayMs: Long, action: () -> Unit): Cancellable {
        val runnable = Runnable { guard(action) }
        handler.postDelayed(runnable, delayMs)
        return Cancellable { handler.removeCallbacks(runnable) }
    }

    fun shutdown() {
        handler.removeCallbacksAndMessages(null)
        thread.quitSafely()
    }

    private fun guard(action: () -> Unit) {
        try {
            action()
        } catch (error: Throwable) {
            Log.e(TAG, "an engine task failed", error)
            if (reported) return
            reported = true
            val listener = onUncaught ?: return
            // A handler that throws in turn must not re-enter this catch block.
            try {
                listener(error)
            } catch (secondary: Throwable) {
                Log.e(TAG, "the uncaught-task handler failed too", secondary)
            }
        }
    }
}
