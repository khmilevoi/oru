package com.oru.radio

import android.media.AudioManager

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

    /** The communication device actually in force, or null for the built-in route. */
    private var applied: RouteDevice? = null

    /** A voice link the platform accepted but has not yet confirmed. */
    private var establishing: RouteDevice? = null

    /** Section 6's per-episode attempt counters, keyed by [RouteDevice.key]. */
    private val attempts = mutableMapOf<String, Int>()

    /** Devices whose budget ran out. Cleared by the next device event, never permanent. */
    private val demoted = mutableSetOf<String>()

    private var modeBackstop: Cancellable? = null
    private var modeSettleDeadlineMs: Long? = null

    /**
     * The mode last handed to [AudioManagerFacade.setMode] while it had not yet landed.
     *
     * Deviation from the plan's literal snippet (see task-3-brief.md "A known conflict"):
     * the brief's [applyProfile] as written re-issues `setMode` on every re-entrant pass
     * once the backstop has cleared the deadline, because [modeSettleDeadlineMs] alone
     * cannot distinguish "this wanted mode was already requested and is still pending"
     * from "a new wanted mode showed up". Tracking the last *requested* mode separately
     * closes that gap: a wanted mode that has already been requested and has not landed
     * is not requested again, while a genuinely new wanted mode still is.
     */
    private var modeRequested: Int? = null

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
        cancelEstablishTimeout()
        clearModeBackstop()
        if (applied != null || establishing != null) {
            facade.stopVoiceLink()
            facade.clearCommunicationDevice()
        }
        applied = null
        establishing = null
        attempts.clear()
        demoted.clear()
        facade.setMode(AudioManager.MODE_NORMAL)
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
        val target = establishing
        if (target != null && device?.id == target.id && !RoutePicker.requiresVoiceLink(target)) {
            markEstablished(target)
        }
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
        val target = establishing
        when (state) {
            VoiceLinkState.CONNECTED -> if (target != null) markEstablished(target)
            VoiceLinkState.ERROR -> if (target != null) failEstablishment(target, "SCO error")
            VoiceLinkState.CONNECTING, VoiceLinkState.DISCONNECTED -> Unit
        }
        reevaluate()
    }

    override fun onOtherAudioActiveChanged(active: Boolean) = post {
        if (!started) return@post
        logger.log("route: other audio t=${clock()}ms -> $active")
        reevaluate()
    }

    // --- the funnel ---------------------------------------------------------------------------

    /**
     * Section 6: "a failure demotes the device only until the next device event, never
     * permanently; the counter resets on fresh connection".
     */
    private fun onDeviceEvent(added: List<RouteDevice>, removed: List<RouteDevice>) {
        if (added.isEmpty() && removed.isEmpty()) return
        demoted.clear()
        (added + removed).forEach { attempts.remove(it.key) }
        removed.forEach { device ->
            if (applied?.id == device.id) applied = null
            if (establishing?.id == device.id) {
                cancelEstablishTimeout()
                establishing = null
            }
        }
    }

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
        val candidate = pickCandidate()
        applyProfile(candidate)
        publish(routeInForce())
    }

    /**
     * The input-capable external the radio should run through, or null for the phone mic.
     * MEDIA has none by definition (§6: "none — headset stays on A2DP").
     */
    private fun pickCandidate(): RouteDevice? {
        if (noisyGuardActive()) return null
        if (profile == ModePolicy.Profile.MEDIA) return null
        return RoutePicker.inputCandidates(devices, facade.connectedHfpAddresses())
            .firstOrNull { it.key !in demoted }
    }

    /**
     * Section 11's three-row policy table, kept whole: a selected headset mic runs in
     * communication mode; an external that can only play keeps the platform in normal mode so
     * A2DP/LE is not dropped from the route; nothing external is communication mode on the
     * loudspeaker. MEDIA is normal mode regardless (§6 profile table).
     */
    private fun wantedMode(candidate: RouteDevice?): Int = when {
        profile == ModePolicy.Profile.MEDIA -> AudioManager.MODE_NORMAL
        candidate != null -> AudioManager.MODE_IN_COMMUNICATION
        RoutePicker.outputDevice(devices) != null -> AudioManager.MODE_NORMAL
        else -> AudioManager.MODE_IN_COMMUNICATION
    }

    /**
     * Sets the mode, then the communication device. The order matters: selecting a device
     * while the mode has not landed is a known way to lose the headset from the route, since
     * the selection is cleared on mode change.
     *
     * Section 6 replaces the old 3 x 100 ms polling with `OnModeChangedListener`, which
     * re-enters this method through [reevaluate]. [MODE_SETTLE_TIMEOUT_MS] is the single
     * backstop for stacks that never fire it; after it, routing proceeds anyway. Audio is
     * flowing on the previous route the whole time, so the wait is inaudible.
     *
     * [modeRequested] (not just [modeSettleDeadlineMs]) is what tells a wanted mode that was
     * already requested and has not landed apart from a genuinely new wanted mode: see the
     * `modeRequested` doc comment by the field for why the deadline alone cannot do this.
     *
     * [modeRequested] is cleared as soon as the wanted mode is observed already in force
     * ([facade.mode] == wanted): the plan's original snippet re-requested `setMode` on every
     * pass and so would always notice a platform that silently reverts the mode later; that
     * tracking must not lose it, so a landed mode does not stay "already requested" forever.
     * It is deliberately not cleared in [clearModeBackstop] — that runs on the re-entrant pass
     * inside the same [reevaluate] loop that just handled this mode, and clearing it there
     * lets that pass call `setMode` a second time, re-breaking the backstop test.
     */
    private fun applyProfile(candidate: RouteDevice?) {
        val wanted = wantedMode(candidate)
        if (facade.mode() != wanted) {
            if (modeRequested != wanted) {
                facade.setMode(wanted)
                modeRequested = wanted
                if (facade.mode() != wanted) {
                    modeSettleDeadlineMs = clock() + MODE_SETTLE_TIMEOUT_MS
                    modeBackstop = scheduler.schedule(MODE_SETTLE_TIMEOUT_MS) {
                        modeBackstop = null
                        reevaluate()
                    }
                    logger.log("route: awaiting mode t=${clock()}ms wanted=$wanted")
                    return
                }
            } else {
                val deadline = modeSettleDeadlineMs
                if (deadline != null && clock() < deadline) {
                    return
                }
                logger.log("route: mode never landed t=${clock()}ms; routing anyway")
            }
        } else {
            modeRequested = null
        }
        clearModeBackstop()
        routeCommunicationTo(candidate)
    }

    private fun clearModeBackstop() {
        modeBackstop?.cancel()
        modeBackstop = null
        modeSettleDeadlineMs = null
    }

    /**
     * Makes [candidate] the communication device, idempotently.
     *
     * [applied] is deliberately left untouched while a new link establishes: section 6 keeps
     * audio flowing on the previous route until the new one is actually connected, which is
     * what removes the ~6.3 s of dead air.
     */
    private fun routeCommunicationTo(candidate: RouteDevice?) {
        if (candidate == null) {
            if (establishing != null || applied != null) {
                cancelEstablishTimeout()
                establishing = null
                applied = null
                facade.stopVoiceLink()
                facade.clearCommunicationDevice()
                logger.log("route: released the communication device t=${clock()}ms")
            }
            return
        }
        if (applied?.id == candidate.id && establishing == null) return
        if (establishing?.id == candidate.id) return
        if (establishing != null) {
            // A different target won while this one was still negotiating.
            cancelEstablishTimeout()
            establishing = null
            facade.stopVoiceLink()
        }
        val accepted = facade.setCommunicationDevice(candidate)
        logger.log(
            "route: select t=${clock()}ms ${candidate.productName} accepted=$accepted",
        )
        if (!accepted) {
            failEstablishment(candidate, "setCommunicationDevice refused it")
            return
        }
        if (RoutePicker.requiresVoiceLink(candidate)) {
            // Complementary paths: where the audio framework owns SCO the legacy call is a
            // no-op, and where the Bluetooth stack still owns it, it is the only thing that
            // raises the link (the 2026-08-17 total-silence failure).
            facade.startVoiceLink(candidate)
            establishing = candidate
            armEstablishTimeout(candidate)
        } else {
            markEstablished(candidate)
        }
    }

    private fun markEstablished(device: RouteDevice) {
        cancelEstablishTimeout()
        establishing = null
        applied = device
        attempts.remove(device.key)
        logger.log("route: established t=${clock()}ms ${device.productName}")
    }

    /**
     * Section 6's bounded retries, which replace the old `failedHeadsetKeys` blacklist: at
     * most [MAX_ESTABLISH_ATTEMPTS] per episode, and the demotion lasts only until the next
     * device event. Demoting drops the policy onto the output-only row — playback over the
     * headset's media route with the phone mic — instead of leaving audio on the earpiece.
     */
    private fun failEstablishment(device: RouteDevice, reason: String) {
        cancelEstablishTimeout()
        if (establishing?.id == device.id) establishing = null
        if (applied?.id == device.id) applied = null
        facade.stopVoiceLink()
        val count = (attempts[device.key] ?: 0) + 1
        attempts[device.key] = count
        logger.log(
            "route: establishment failed t=${clock()}ms ${device.productName} " +
                "attempt=$count/$MAX_ESTABLISH_ATTEMPTS reason=$reason",
        )
        if (count >= MAX_ESTABLISH_ATTEMPTS) {
            demoted.add(device.key)
            attempts.remove(device.key)
            logger.log("route: demoted t=${clock()}ms ${device.productName} until the next device event")
        }
        reevaluateAgain = true
    }

    private fun routeInForce(): AudioRoute {
        val output = applied
            ?: if (noisyGuardActive()) null else RoutePicker.outputDevice(devices)
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

    // --- establishment timeout --------------------------------------------------------------

    private var establishTimeout: Cancellable? = null

    private fun armEstablishTimeout(device: RouteDevice) {
        cancelEstablishTimeout()
        establishTimeout = scheduler.schedule(ESTABLISH_TIMEOUT_MS) {
            establishTimeout = null
            onEstablishTimeout(device)
        }
    }

    private fun cancelEstablishTimeout() {
        establishTimeout?.cancel()
        establishTimeout = null
    }

    private fun onEstablishTimeout(device: RouteDevice) {
        if (!started || establishing?.id != device.id) return
        failEstablishment(device, "not confirmed within ${ESTABLISH_TIMEOUT_MS}ms")
        reevaluate()
    }

    private fun post(action: () -> Unit) {
        scheduler.execute(action)
    }
}
