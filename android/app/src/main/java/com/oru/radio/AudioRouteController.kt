package com.oru.radio

/**
 * Section 6's routing state machine, extracted from `RadioForegroundService`.
 *
 * Threading: every public method and every platform callback posts onto [scheduler], which
 * in production wraps the dedicated `HandlerThread("audio-route")`. Nothing here is
 * synchronized because nothing here runs on two threads.
 *
 * Every event funnels into one idempotent [reevaluate]: rebuild the device list, pick by
 * priority, apply only if changed, notify only if changed. [reevaluate] is re-entrant-safe —
 * applying a decision can call straight back into it (the fake platform, and a real
 * `OnModeChangedListener`, both do) — so a nested call sets a flag and the outermost loop
 * runs again instead of recursing.
 *
 * [clock] is absolute monotonic milliseconds (`SystemClock.elapsedRealtime` in production),
 * shared with [ModePolicy] so a dwell deadline and a route timer never disagree.
 */
class AudioRouteController(
    private val facade: AudioManagerFacade,
    private val scheduler: Scheduler,
    private val clock: () -> Long,
    private val policy: ModePolicy,
    private val logger: RouteLogger,
) : AudioFacadeListener {

    companion object {
        /** Section 6: device lists flap during Bluetooth profile negotiation. */
        const val DEVICE_ADD_DEBOUNCE_MS = 500L

        /**
         * How long after `ACTION_AUDIO_BECOMING_NOISY` the enumeration is distrusted. The
         * removal callback normally lands within milliseconds; this keeps the fast path to
         * the loudspeaker from being undone by a device list that has not caught up.
         */
        const val NOISY_GUARD_MS = 750L

        /** Section 6: at most two establishment attempts per device per episode. */
        const val MAX_ESTABLISH_ATTEMPTS = 2

        /** Backstop on establishment; ground truth is re-checked before it fails a device. */
        const val ESTABLISH_TIMEOUT_MS = 6_000L

        /** Backstop for the mode change, for stacks that never fire the mode listener. */
        const val MODE_SETTLE_TIMEOUT_MS = 500L
    }

    private var started = false
    private var listener: AudioRouteListener? = null

    /** Last enumeration, watch-filtered. */
    private var devices: List<RouteDevice> = emptyList()

    /** Last route handed to the engine; the "notify only if changed" half of reevaluate. */
    private var published: AudioRoute? = null

    /** The profile the policy currently wants. Task 6 lets the policy move it. */
    private var profile: ModePolicy.Profile = ModePolicy.Profile.VOICE

    private var debounce: Cancellable? = null
    private var noisyUntilMs = 0L

    /** When the device event that is still working its way to audio happened (§10). */
    private var deviceEventAtMs: Long? = null

    private var reevaluating = false
    private var reevaluateAgain = false

    // --- lifecycle -------------------------------------------------------------------------

    fun start(listener: AudioRouteListener) = post {
        if (started) return@post
        started = true
        this.listener = listener
        logger.log("route: start t=${clock()}ms")
        facade.start(this)
        reevaluate()
    }

    fun stop() = post {
        if (!started) return@post
        started = false
        debounce?.cancel()
        debounce = null
        facade.stop()
        listener = null
        published = null
        logger.log("route: stop t=${clock()}ms")
    }

    /**
     * Runs one evaluation from outside. Production never needs it — every real trigger is a
     * platform callback — but a test that changes the world without an event does.
     */
    fun reevaluateNow() = post { reevaluate() }

    // --- platform callbacks ------------------------------------------------------------------

    override fun onDevicesChanged(added: List<RouteDevice>, removed: List<RouteDevice>) = post {
        if (!started) return@post
        if (added.isNotEmpty() || removed.isNotEmpty()) {
            deviceEventAtMs = clock()
            // A device event always ends the noisy guard: the enumeration is trustworthy again.
            noisyUntilMs = 0L
            logger.log(
                "route: devices t=${clock()}ms added=${added.map { it.productName }} " +
                    "removed=${removed.map { it.productName }}",
            )
        }
        onDeviceEvent(added, removed)
        if (removed.isNotEmpty() || added.isEmpty()) {
            // A disconnect is dead air until it is handled, and an empty pair is the HFP
            // proxy arriving, which needs no settling either.
            debounce?.cancel()
            debounce = null
            reevaluate()
        } else {
            debounce?.cancel()
            debounce = scheduler.schedule(DEVICE_ADD_DEBOUNCE_MS) {
                debounce = null
                reevaluate()
            }
        }
    }

    override fun onBecomingNoisy() = post {
        if (!started) return@post
        noisyUntilMs = clock() + NOISY_GUARD_MS
        deviceEventAtMs = clock()
        logger.log("route: becoming noisy t=${clock()}ms")
        debounce?.cancel()
        debounce = null
        reevaluate()
    }

    override fun onCommunicationDeviceChanged(device: RouteDevice?) = post {
        if (!started) return@post
        logger.log("route: platform communication device t=${clock()}ms -> ${device?.productName}")
        reevaluate()
    }

    override fun onModeChanged(mode: Int) = post {
        if (!started) return@post
        logger.log("route: platform mode t=${clock()}ms -> $mode")
        reevaluate()
    }

    override fun onVoiceLinkStateChanged(state: VoiceLinkState) = post {
        if (!started) return@post
        logger.log("route: voice link t=${clock()}ms -> $state")
        reevaluate()
    }

    override fun onOtherAudioActiveChanged(active: Boolean) = post {
        if (!started) return@post
        logger.log("route: other audio t=${clock()}ms -> $active")
        reevaluate()
    }

    // --- the funnel ---------------------------------------------------------------------------

    /**
     * Hook for the per-episode attempt bookkeeping of section 6. Task 4 fills it; keeping the
     * call site here means the device-event path never grows a second branch.
     */
    private fun onDeviceEvent(added: List<RouteDevice>, removed: List<RouteDevice>) = Unit

    private fun reevaluate() {
        if (reevaluating) {
            reevaluateAgain = true
            return
        }
        reevaluating = true
        try {
            do {
                reevaluateAgain = false
                evaluateOnce()
            } while (reevaluateAgain)
        } finally {
            reevaluating = false
        }
    }

    private fun evaluateOnce() {
        if (!started) return
        devices = facade.devices().filterNot(RoutePicker::isWatch)
        publish(routeInForce())
    }

    /**
     * What the user is actually hearing on. With no communication device selected, playback
     * follows the system's default route, which is the highest-priority external sink.
     */
    private fun routeInForce(): AudioRoute {
        val output = if (noisyGuardActive()) null else RoutePicker.outputDevice(devices)
        return AudioRoute(
            kind = RoutePicker.kindOf(output),
            label = RoutePicker.labelOf(output),
            mode = profile,
        )
    }

    private fun noisyGuardActive(): Boolean = clock() < noisyUntilMs

    private fun publish(route: AudioRoute) {
        if (route == published) return
        published = route
        val since = deviceEventAtMs?.let { clock() - it } ?: -1L
        // Section 10 instrumentation: device event -> audio on the new route, timestamped, so
        // switch latency is read off logcat instead of guessed.
        logger.log(
            "route: applied t=${clock()}ms kind=${route.kind} label=${route.label ?: "-"} " +
                "profile=${route.mode} sinceDeviceEventMs=$since",
        )
        deviceEventAtMs = null
        listener?.onAudioRouteChanged(route)
    }

    private fun post(action: () -> Unit) {
        scheduler.execute(action)
    }
}
