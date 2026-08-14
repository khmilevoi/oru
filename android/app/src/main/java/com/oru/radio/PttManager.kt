package com.oru.radio

/** One physical button, already bound. Drivers know nothing about radio state. */
interface PttDriver {
    fun start()
    fun stop()
}

interface PttDriverListener {
    fun onPressed()
    fun onReleased()
    fun onConnectionChanged(connected: Boolean)
}

interface PttDriverFactory {
    /** Null when this device cannot drive the binding (no Bluetooth adapter, say). */
    fun create(binding: PttBinding, listener: PttDriverListener): PttDriver?
    fun startLearning(listener: PttLearningListener)
    fun selectCandidate(deviceId: String)
    fun cancelLearning()
}

enum class PttDriverKind { BLE, MEDIA_BUTTON, HID }

/**
 * Spec section 9.1's driver preference, as a pure rule so it can be tested without a
 * Bluetooth stack. GATT is preferred and is the only background-capable path on both
 * OSes. A HID binding on a media key can be heard in the background through a
 * MediaSession; any other key code only arrives while a window has focus.
 */
object PttDriverSelection {

    // android.view.KeyEvent constants, spelled out so this file stays framework-free.
    private const val KEYCODE_HEADSETHOOK = 79
    private const val KEYCODE_MEDIA_PLAY = 126
    private const val KEYCODE_MEDIA_STOP = 86
    private const val KEYCODE_MEDIA_NEXT = 87
    private const val KEYCODE_MEDIA_PREVIOUS = 88
    private const val KEYCODE_MEDIA_PLAY_PAUSE = 85

    private val MEDIA_KEYS = setOf(
        KEYCODE_HEADSETHOOK,
        KEYCODE_MEDIA_PLAY,
        KEYCODE_MEDIA_STOP,
        KEYCODE_MEDIA_NEXT,
        KEYCODE_MEDIA_PREVIOUS,
        KEYCODE_MEDIA_PLAY_PAUSE,
    )

    fun kindFor(binding: PttBinding): PttDriverKind = when (binding) {
        is PttBinding.Ble -> PttDriverKind.BLE
        is PttBinding.Hid ->
            if (binding.keyCode in MEDIA_KEYS) PttDriverKind.MEDIA_BUTTON else PttDriverKind.HID
    }
}

/**
 * Owns the one configured button: reconnects to it on start (spec section 9.2), runs the
 * pairing session (section 9.3), and turns driver events into engine events (section 9.4).
 * Button connection is state, never an error (section 13).
 *
 * Pairing follows the contract amendment of 2026-08-14: one session, three phases, and the
 * whole of its progress published as a snapshot the engine copies into
 * `RadioState.pttPairing`. There is no second event and no callback argument, so the bridge
 * has nothing extra to marshal. The `saved` phase stays visible until the caller cancels
 * (that is what dismisses the pairing UI's final screen); a failure clears it at once.
 *
 * Threading: [PttDriverListener] and [PttLearningListener] callbacks arrive on whatever
 * thread the platform's BLE/media stack picks — [HandlerScheduler]'s own contract is that
 * "Nearby, BLE and audio callbacks arrive on whatever thread the platform picks; everything
 * is funnelled here." Every one of those callbacks below is re-posted onto [scheduler]
 * before it touches a field. The [PttSource]-facing methods need no such wrapping: their
 * only caller, `RadioEngine`, already invokes them from inside its own `scheduler.execute`,
 * i.e. on the very same thread. That gives every field of this class single-writer
 * discipline — exactly one thread ever mutates them — so none needs `@Volatile`.
 */
class PttManager(
    private val store: PttBindingStore,
    private val drivers: PttDriverFactory,
    private val scheduler: Scheduler,
) : PttSource, PttDriverListener {

    private var listener: PttListener? = null
    private var driver: PttDriver? = null
    private var configuration: PttConfiguration? = null
    private var connected = false

    private val candidates = LinkedHashMap<String, PttCandidate>()
    private var pairing: PttPairingState? = null
    private var pairingTimeout: Cancellable? = null

    /**
     * Bumped whenever a session's identity changes: [startPairing] opening a new one and
     * [endPairing] closing the current one both advance it. [PairingSession] captures the
     * value at construction and every one of its callbacks re-checks it before touching any
     * state (fix round 1, Finding 1). A bare `pairing == null` check cannot tell "no
     * session" apart from "a newer session already replaced this one"; comparing against
     * the live generation can, because a callback from an old session that raced with
     * [cancelPairing]/the timeout/a fresh [startPairing] always carries a stale value.
     */
    private var pairingGeneration = 0

    override fun start(listener: PttListener) {
        this.listener = listener
        configuration = store.load()
        attach()
    }

    override fun stop() {
        cancelPairing()
        driver?.stop()
        driver = null
        connected = false
        listener = null
    }

    override fun snapshot(): PttButtonState = PttButtonState(
        configured = configuration != null,
        connected = connected,
        name = configuration?.name,
    )

    // --- pairing session (the amended configurePtt / selectPttCandidate) ----------------

    override fun startPairing() {
        cancelPairing()
        candidates.clear()
        pairingGeneration++
        pairingTimeout = scheduler.schedule(RadioConfig.PAIRING_TIMEOUT_MS) {
            failPairing("pairing_timeout", "No PTT button was paired in time")
        }
        publishPairing(PttPairingPhase.SCANNING)
        drivers.startLearning(PairingSession(pairingGeneration))
    }

    override fun selectCandidate(deviceId: String) {
        if (pairing == null) return
        if (deviceId !in candidates) {
            // The pick is the user's, but the string is not: it comes from JS through the
            // bridge, or from `ptt-pick --es device <address>` in the Phase 0 runbook, and
            // anything may be in it. Only an address this session actually published may
            // reach the BLE stack, where a malformed one used to reach
            // BluetoothAdapter.getRemoteDevice and take the process down with it. Reported
            // rather than ignored: a selection that can never succeed must say so.
            failPairing("unknown_device", deviceId)
            return
        }
        publishPairing(PttPairingPhase.LEARNING)
        drivers.selectCandidate(deviceId)
    }

    override fun cancelPairing() {
        if (pairing == null) return
        endPairing()
        listener?.onPttPairingChanged(null)
    }

    // --- learning callbacks from the driver factory --------------------------------------
    // These may arrive on any thread (a BLE scan/GATT callback); re-post onto the
    // scheduler before touching state, same discipline as the driver callbacks below. They
    // are registered per session (see PairingSession below) rather than implemented
    // directly on PttManager, so each one can tell whether the session it belongs to is
    // still the live one before it mutates anything.

    /**
     * One learning attempt's identity, registered as the [PttLearningListener] Task 9's
     * drivers report to for the lifetime of a single [startPairing] session. Every callback
     * re-checks [generation] against the live [pairingGeneration] before touching state, so
     * a callback still in flight when [cancelPairing]/the timeout/a newer session already
     * ended this one is recognised as stale and dropped instead of saving a binding, wiring
     * up a driver, or republishing a phase nobody asked for.
     */
    private inner class PairingSession(private val generation: Int) : PttLearningListener {

        override fun onDeviceFound(deviceId: String, name: String?, rssi: Int) = scheduler.execute {
            if (generation != pairingGeneration) return@execute
            if (pairing?.phase != PttPairingPhase.SCANNING) return@execute
            candidates[deviceId] = PttCandidate(deviceId, name ?: deviceId, rssi)
            publishPairing(PttPairingPhase.SCANNING)
        }

        override fun onLearned(configuration: PttConfiguration) = scheduler.execute {
            if (generation != pairingGeneration) return@execute
            pairingTimeout?.cancel()
            pairingTimeout = null
            store.save(configuration)
            this@PttManager.configuration = configuration
            connected = false
            attach()
            publishPairing(PttPairingPhase.SAVED)
        }

        override fun onLearningFailed(code: String, message: String) = scheduler.execute {
            if (generation != pairingGeneration) return@execute
            failPairing(code, message)
        }
    }

    private fun failPairing(code: String, message: String) {
        endPairing()
        listener?.onPttPairingChanged(null)
        listener?.onPttPairingFailed(code, message)
    }

    private fun endPairing() {
        pairingTimeout?.cancel()
        pairingTimeout = null
        drivers.cancelLearning()
        candidates.clear()
        pairing = null
        // Bumped here too, not just in startPairing(): ending a session with nothing new
        // started yet must still invalidate any of its callbacks still in flight, or a
        // bare generation match would only catch "replaced by a newer session", not "the
        // session I belong to already ended" (fix round 1, Finding 1).
        pairingGeneration++
    }

    private fun publishPairing(phase: PttPairingPhase) {
        // Strongest signal first. The pick itself is always the user's: an automatic
        // strongest-signal pick would be a safety net only, and this plan does not add one.
        pairing = PttPairingState(phase, candidates.values.sortedByDescending { it.rssi })
        listener?.onPttPairingChanged(pairing)
    }

    override fun forget() {
        cancelPairing()
        driver?.stop()
        driver = null
        configuration = null
        connected = false
        store.clear()
        publish()
    }

    // --- driver events -----------------------------------------------------------------
    // May arrive on any thread (a BLE GATT callback, a MediaSession callback); funnelled
    // through the scheduler before touching state.

    override fun onPressed() = scheduler.execute { listener?.onPttPressed() }

    override fun onReleased() = scheduler.execute { listener?.onPttReleased() }

    override fun onConnectionChanged(connected: Boolean) = scheduler.execute {
        this.connected = connected
        publish()
    }

    private fun attach() {
        driver?.stop()
        driver = configuration?.let { drivers.create(it.binding, this) }
        driver?.start()
        publish()
    }

    private fun publish() {
        listener?.onPttButtonStateChanged(snapshot())
    }
}
