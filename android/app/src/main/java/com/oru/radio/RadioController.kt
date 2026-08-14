package com.oru.radio

import android.content.Context
import android.content.Intent

/**
 * The one process-wide handle on the radio. The React Native Activity may be destroyed and
 * recreated at will (spec section 10.1); the service and the engine outlive it, and
 * whatever wants engine events registers here instead of holding the engine itself.
 *
 * Threading: this object is touched from the JS bridge thread ([addListener],
 * [removeListener], [start], [stop]), the service's main thread ([attach], [detach]) and
 * read from anywhere via [engine]. [engine] is `@Volatile` for a lock-free read of the
 * latest reference. Every mutation of [listeners] -- buffering a listener before the
 * service attaches, and handing it to the engine once it does -- runs inside [lock], so
 * [addListener] can never race [attach]: a listener is added to the buffer and (if an
 * engine is already attached) registered on it as one atomic step, and [attach] registers
 * every already-buffered listener as another atomic step. That mutual exclusion is what
 * guarantees a listener added while the service is starting is registered on the engine
 * exactly once -- never lost, never delivered twice.
 */
object RadioController {

    private val lock = Any()

    /** Guarded by [lock]. Insertion order does not matter; membership must be exact. */
    private val listeners = LinkedHashSet<RadioEngineListener>()

    @Volatile
    private var engine: RadioEngine? = null

    fun engine(): RadioEngine? = engine

    fun start(context: Context) {
        val intent = Intent(context.applicationContext, RadioForegroundService::class.java)
            .setAction(RadioForegroundService.ACTION_START)
        context.applicationContext.startForegroundService(intent)
    }

    /**
     * Asks the service to stop through `ACTION_STOP` rather than calling `stopService`
     * directly: `ACTION_STOP` is the branch that lets the service drop its foreground state
     * and release the engine cleanly before it stops itself.
     */
    fun stop(context: Context) {
        val intent = Intent(context.applicationContext, RadioForegroundService::class.java)
            .setAction(RadioForegroundService.ACTION_STOP)
        context.applicationContext.startForegroundService(intent)
    }

    fun addListener(listener: RadioEngineListener) {
        synchronized(lock) {
            if (listeners.add(listener)) {
                engine?.addListener(listener)
            }
        }
    }

    fun removeListener(listener: RadioEngineListener) {
        synchronized(lock) {
            listeners.remove(listener)
            engine?.removeListener(listener)
        }
    }

    internal fun attach(engine: RadioEngine) {
        synchronized(lock) {
            this.engine = engine
            listeners.forEach(engine::addListener)
        }
    }

    internal fun detach() {
        synchronized(lock) {
            engine?.let { current -> listeners.forEach(current::removeListener) }
            engine = null
        }
    }
}
