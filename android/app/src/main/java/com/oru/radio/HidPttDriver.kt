package com.oru.radio

import android.view.KeyEvent
import java.util.concurrent.CopyOnWriteArrayList

/**
 * Key events do not reach a process without a focused window, which is why spec section
 * 9.1 calls HID a foreground-only fallback on Android. Whoever has a window (the spike
 * activity, later the RN activity) forwards its key events here.
 *
 * [drivers] is a [CopyOnWriteArrayList] because [dispatch] runs on whatever thread owns the
 * key events (typically the UI thread), while [register]/[unregister] run on the engine's
 * scheduler thread as drivers start and stop — a plain list would not be safe across those.
 */
object HidKeyEventBus {

    private val drivers = CopyOnWriteArrayList<HidPttDriver>()

    fun register(driver: HidPttDriver) {
        drivers.addIfAbsent(driver)
    }

    fun unregister(driver: HidPttDriver) {
        drivers.remove(driver)
    }

    /** Returns true when a driver consumed the event. */
    fun dispatch(keyCode: Int, action: Int): Boolean =
        drivers.fold(false) { consumed, driver -> driver.handleKeyEvent(keyCode, action) || consumed }
}

/**
 * Threading: [start]/[stop] run on the engine's single scheduler thread; [handleKeyEvent]
 * runs on whatever thread calls [HidKeyEventBus.dispatch] (the UI thread, in practice) —
 * a different thread, so [pressed] is `@Volatile`.
 */
class HidPttDriver(
    private val keyCode: Int,
    private val listener: PttDriverListener,
) : PttDriver {

    @Volatile
    private var pressed = false

    override fun start() {
        HidKeyEventBus.register(this)
        // A HID binding has no link state of its own: the driver is either listening or
        // it is not. "Connected" here means "listening".
        listener.onConnectionChanged(true)
    }

    override fun stop() {
        HidKeyEventBus.unregister(this)
        pressed = false
        listener.onConnectionChanged(false)
    }

    fun handleKeyEvent(keyCode: Int, action: Int): Boolean {
        if (keyCode != this.keyCode) return false
        when (action) {
            KeyEvent.ACTION_DOWN -> if (!pressed) {
                pressed = true
                listener.onPressed()
            }
            KeyEvent.ACTION_UP -> if (pressed) {
                pressed = false
                listener.onReleased()
            }
        }
        return true
    }
}
