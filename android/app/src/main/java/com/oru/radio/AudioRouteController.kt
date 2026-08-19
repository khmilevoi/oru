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
) : AudioRouting, AudioFacadeListener {

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

        /**
         * How many times, within one device episode, a platform-cleared or
         * platform-replaced communication device is re-asserted before it is demoted
         * directly. Keeps an OEM stack that keeps rerouting from turning into an endless
         * re-selection loop.
         */
        const val MAX_COMMUNICATION_DEVICE_REASSERTS = 3
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

    private var policyWakeup: Cancellable? = null

    /** Last value handed to the policy, so an unchanged route is not re-announced. */
    private var routeRequiresVoiceLink = false

    /**
     * Set inside [onDeviceEvent] when a raise's target disappears mid-establishment, and
     * consumed at the end of [onDevicesChanged]'s handler: [ModePolicy] must be told the
     * raise failed rather than be left to wait out its own 4 s grant timeout. Deferred past
     * [onDeviceEvent] because [reevaluate] there is not yet done rebuilding the device list.
     */
    private var pendingLinkLoss = false

    /**
     * Platform interference — a cleared or replaced communication device — seen within the
     * current device episode. Per-episode, not per-confirmation: [onDeviceEvent] resets it,
     * alongside [demoted] and [attempts], when a connect or disconnect starts a new episode.
     * A confirmed selection along the way does not reset it, so interference that recurs
     * across several confirmed cycles still reaches [MAX_COMMUNICATION_DEVICE_REASSERTS].
     */
    private var reassertCount = 0

    /** Section 6's per-episode attempt counters, keyed by [RouteDevice.key]. */
    private val attempts = mutableMapOf<String, Int>()

    /** Devices whose budget ran out. Cleared by the next device event, never permanent. */
    private val demoted = mutableSetOf<String>()

    private var modeBackstop: Cancellable? = null
    private var modeSettleDeadlineMs: Long? = null

    /**
     * The mode handed to [AudioManagerFacade.setMode] that has not yet landed, or null when
     * no request is in flight.
     *
     * Deviation from the plan's literal snippet (see task-3-brief.md "A known conflict"):
     * the brief's [applyProfile] as written re-issues `setMode` on every re-entrant pass
     * once the backstop has cleared the deadline, because [modeSettleDeadlineMs] alone
     * cannot distinguish "this wanted mode was already requested and is still pending"
     * from "a new wanted mode showed up". Tracking the last *requested* mode separately
     * closes that gap: a wanted mode that has already been requested and has not landed
     * is not requested again, while a genuinely new wanted mode still is.
     *
     * Only ever set while a request is actually pending (see [applyProfile]): a mode that
     * lands synchronously leaves this field alone, so it does not go on claiming a request
     * is in flight once none is. [stop] resets it alongside the rest of the session state,
     * so a stale value never survives into the next `start()`.
     */
    private var modeRequested: Int? = null

    private var debounce: Cancellable? = null
    private var noisyUntilMs = 0L

    /** When the device event that is still working its way to audio happened (§10). */
    private var deviceEventAtMs: Long? = null

    private var reevaluating = false
    private var reevaluateAgain = false

    private var focusHeld = false
    private var pttHeld = false
    private var radioActive = false

    // --- lifecycle -------------------------------------------------------------------------

    override fun start(listener: AudioRouteListener) = post {
        if (started) return@post
        started = true
        this.listener = listener
        logger.log("route: start t=${clock()}ms")
        facade.start(this)
        reevaluate()
    }

    override fun stop() = post {
        if (!started) return@post
        started = false
        debounce?.cancel()
        debounce = null
        cancelEstablishTimeout()
        clearModeBackstop()
        policyWakeup?.cancel()
        policyWakeup = null
        if (applied != null || establishing != null) {
            facade.stopVoiceLink()
            facade.clearCommunicationDevice()
        }
        applied = null
        establishing = null
        attempts.clear()
        demoted.clear()
        reassertCount = 0
        modeRequested = null
        facade.setMode(AudioManager.MODE_NORMAL)
        pttHeld = false
        radioActive = false
        updateFocus()
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

    // --- policy inputs -----------------------------------------------------------------------

    override fun setAudioMode(mode: ModePolicy.AudioMode) = post {
        logger.log("route: audio mode t=${clock()}ms -> $mode")
        apply(policy.setAudioMode(mode, clock()))
    }

    override fun setRadioActive(active: Boolean) = post {
        radioActive = active
        updateFocus()
        apply(policy.setRadioActive(active, clock()))
    }

    override fun onPttPressed() = post {
        logger.log("route: ptt pressed t=${clock()}ms profile=$profile")
        pttHeld = true
        // Before the policy: the raise and the grant tone are part of the burst, and a tone
        // nobody can hear over music is not a talk permit.
        updateFocus()
        apply(policy.pttPressed(clock()))
    }

    override fun onPttReleased() = post {
        logger.log("route: ptt released t=${clock()}ms")
        pttHeld = false
        apply(policy.pttReleased(clock()))
        // After the policy: the release may still start capture-adjacent work, and the burst
        // is only over once the radio is idle too.
        updateFocus()
    }

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
        if (pendingLinkLoss) {
            pendingLinkLoss = false
            apply(policy.voiceLinkFailed(clock()))
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
        if (target != null && device?.id == target.id) {
            // A Bluetooth Classic selection is confirmed by the SCO link, not by the
            // selection echo: this is exactly the state the 2026-08-17 total-silence session
            // was stuck in — confirmed selection, no link.
            if (!RoutePicker.requiresVoiceLink(target)) markEstablished(target)
            reevaluate()
            return@post
        }
        val inForce = applied
        // Deviation from the plan's literal snippet (recorded in the task report's "Left, and
        // why"): a bare `device?.id != inForce.id` also fires on the synchronous echo of the
        // controller's *own* selection of a genuinely new candidate while the old one is still
        // applied — `facade.setCommunicationDevice()` echoes before `routeCommunicationTo`
        // gets to assign `establishing`, so `inForce` is still the previous device at that
        // instant. That collided with the existing (Task 3) "audio keeps flowing on the
        // previous route while the new link establishes" test: a self-triggered switch away
        // from `inForce` was misread as the platform taking `inForce` away from us. Requiring
        // `inForce` to still be the candidate the controller currently wants tells that
        // self-triggered echo apart from the platform genuinely overriding a device we still
        // want.
        //
        // In production `addOnCommunicationDeviceChangedListener` is asynchronous, so the echo
        // for the controller's own switch arrives only after `routeCommunicationTo` has already
        // assigned `establishing` — by then it is caught by the earlier
        // `device?.id == target.id` confirmation branch above, before this guard is ever
        // reached. This guard is therefore inert on real hardware: it exists solely to exclude
        // the fake's synchronous self-triggered echo in tests, and never weakens genuine
        // interference detection.
        val stillWanted = inForce != null && inForce.id == pickCandidate()?.id
        if (inForce != null && device?.id != inForce.id && stillWanted) {
            if (reassertCount < MAX_COMMUNICATION_DEVICE_REASSERTS) {
                reassertCount++
                logger.log(
                    "route: platform ${if (device == null) "cleared" else "replaced"} our " +
                        "selection t=${clock()}ms; re-asserting " +
                        "($reassertCount/$MAX_COMMUNICATION_DEVICE_REASSERTS)",
                )
                applied = null
            } else {
                reassertCount = 0
                demote(inForce, "the platform kept taking the route away")
            }
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
            VoiceLinkState.DISCONNECTED -> {
                val inForce = applied
                if (target == null && inForce != null && RoutePicker.requiresVoiceLink(inForce)) {
                    // Signal's wasAudioStateInterrupted: someone else took the link. That is
                    // not our failure, so the attempt budget is refreshed rather than spent.
                    logger.log("route: voice link stolen t=${clock()}ms ${inForce.productName}")
                    attempts.remove(inForce.key)
                    demoted.remove(inForce.key)
                    applied = null
                }
            }
            VoiceLinkState.CONNECTING -> Unit
        }
        reevaluate()
    }

    override fun onOtherAudioActiveChanged(active: Boolean) = post {
        if (!started) return@post
        logger.log("route: other audio t=${clock()}ms -> $active")
        // Raw and undebounced on purpose: the 2 s / 30 s dwell lives in the shared policy so
        // both platforms debounce identically.
        apply(policy.setOtherAudioActive(active, clock()))
    }

    /**
     * Decision D6: one transient `AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK` per voice burst, so the
     * system ducks and restores other apps around it (API 26+). This replaces the session-long
     * `AUDIOFOCUS_GAIN`, which killed background music for the whole session.
     *
     * A refused request still flips [focusHeld]: the abandon is then a no-op on the facade,
     * and request and abandon stay exactly paired, which is what keeps a refusal from turning
     * into a request on every subsequent event.
     */
    private fun updateFocus() {
        val wanted = radioActive || pttHeld
        if (wanted == focusHeld) return
        focusHeld = wanted
        if (wanted) {
            val granted = facade.requestTransientDuckFocus()
            logger.log("route: focus requested t=${clock()}ms granted=$granted")
        } else {
            facade.abandonFocus()
            logger.log("route: focus abandoned t=${clock()}ms")
        }
    }

    // --- the decision funnel ------------------------------------------------------------------

    /**
     * The one place a [ModePolicy.Decision] reaches the platform.
     *
     * The profile is applied *before* the actions, so an action that assumes the new profile
     * — the grant tone on the media path, capture over a link the raise just brought up —
     * sees it in force. `RaiseVoiceLink` and `DropVoiceLink` need no separate handling: the
     * policy already reports VOICE as the requested profile while it holds a link, so
     * [reevaluate] raises and drops it as an ordinary profile apply.
     */
    private fun apply(decision: ModePolicy.Decision) {
        if (decision.profile != profile) {
            logger.log("route: profile t=${clock()}ms $profile -> ${decision.profile}")
            profile = decision.profile
        }
        scheduleWakeup(decision.nextWakeupMs)
        reevaluate()
        decision.actions.forEach(::perform)
    }

    private fun perform(action: ModePolicy.Action) {
        when (action) {
            // Satisfied by the profile apply above.
            ModePolicy.Action.RaiseVoiceLink, ModePolicy.Action.DropVoiceLink -> Unit
            ModePolicy.Action.PlayGrantTone -> {
                logger.log("route: grant tone t=${clock()}ms profile=$profile")
                facade.playGrantTone(profile)
            }
            is ModePolicy.Action.StartCapture -> {
                logger.log("route: capture granted t=${clock()}ms mic=${action.mic}")
                listener?.onCaptureGranted(action.mic)
            }
        }
    }

    /**
     * The policy owns no timer; this is the one it asks for. Re-read after every decision:
     * a null obliges the caller to cancel the outstanding timer, not merely to skip a new one.
     */
    private fun scheduleWakeup(atMs: Long?) {
        policyWakeup?.cancel()
        policyWakeup = null
        val at = atMs ?: return
        policyWakeup = scheduler.schedule((at - clock()).coerceAtLeast(0L)) {
            policyWakeup = null
            if (started) apply(policy.tick(clock()))
        }
    }

    // --- the funnel ---------------------------------------------------------------------------

    /**
     * Section 6: "a failure demotes the device only until the next device event, never
     * permanently; the counter resets on fresh connection".
     */
    private fun onDeviceEvent(added: List<RouteDevice>, removed: List<RouteDevice>) {
        if (added.isEmpty() && removed.isEmpty()) return
        demoted.clear()
        reassertCount = 0
        (added + removed).forEach { attempts.remove(it.key) }
        removed.forEach { device ->
            if (applied?.id == device.id) applied = null
            if (establishing?.id == device.id) {
                cancelEstablishTimeout()
                establishing = null
                pendingLinkLoss = true
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
        val requires = RoutePicker.requiresVoiceLink(voiceCandidate())
        if (requires != routeRequiresVoiceLink) {
            routeRequiresVoiceLink = requires
            // apply() re-enters reevaluate, so this pass is stale; the loop runs again.
            apply(policy.setRouteRequiresVoiceLink(requires, clock()))
            return
        }
        applyProfile(pickCandidate())
        publish(routeInForce())
    }

    /**
     * The best input-capable external available, regardless of the current profile. The
     * policy needs this one — "would reaching the accessory's mic need a BT-Classic link?" is
     * a question about the hardware, not about the profile, and answering it from the MEDIA
     * candidate (always null) would make the policy flap straight back to VOICE.
     */
    private fun voiceCandidate(): RouteDevice? {
        if (noisyGuardActive()) return null
        return RoutePicker.inputCandidates(devices, facade.connectedHfpAddresses())
            .firstOrNull { it.key !in demoted }
    }

    /** What this profile should actually select. MEDIA selects nothing: the headset stays on A2DP. */
    private fun pickCandidate(): RouteDevice? =
        if (profile == ModePolicy.Profile.MEDIA) null else voiceCandidate()

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
     * It is set only once the mode did *not* land synchronously — a mode that lands right
     * inside this call leaves no request in flight, so [modeRequested] must be left alone
     * (see the field's doc comment for what marking it "in flight" there would break).
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
                if (facade.mode() != wanted) {
                    modeRequested = wanted
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
        // Reported unconditionally: the policy ignores an outcome it is not waiting for, so
        // the controller needs no "was this raise mine?" bookkeeping.
        apply(policy.voiceLinkEstablished(clock()))
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
        if (count >= MAX_ESTABLISH_ATTEMPTS) demote(device, reason)
        // apply() re-enters reevaluate(). Called from inside reevaluate()'s own loop (the
        // routeCommunicationTo path, when setCommunicationDevice is refused), that sets
        // reevaluateAgain instead of recursing, which is what re-drives the retry (or, once
        // demoted, the fallback) without a bare `reevaluateAgain = true` here. Called from
        // onEstablishTimeout's raw scheduler.schedule callback, reevaluating is false there, so
        // this reevaluate() runs a fresh pass instead -- harmless, since onEstablishTimeout
        // already calls reevaluate() again immediately after this returns.
        apply(policy.voiceLinkFailed(clock()))
    }

    /**
     * Tears the device out of whatever state it was in and demotes it directly: the shared
     * tail of a spent establish-attempt budget ([failEstablishment], once [count] reaches
     * [MAX_ESTABLISH_ATTEMPTS]) and of the platform simply refusing to keep our confirmed
     * selection ([onCommunicationDeviceChanged]'s give-up branch, which is never mid
     * establishment and so has nothing for [failEstablishment] itself to fail). Demotion still
     * lasts only until the next device event — [onDeviceEvent] clears [demoted] — so §11's "no
     * blacklist" holds either way.
     */
    private fun demote(device: RouteDevice, reason: String) {
        if (establishing?.id == device.id) {
            cancelEstablishTimeout()
            establishing = null
        }
        if (applied?.id == device.id) applied = null
        facade.stopVoiceLink()
        demoted.add(device.key)
        attempts.remove(device.key)
        logger.log(
            "route: demoted t=${clock()}ms ${device.productName} until the next device event: $reason",
        )
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

    /**
     * Section 6: `setCommunicationDevice` returning true only means the request was
     * accepted, not that the route was built. Before the headset spends an attempt, the
     * Bluetooth stack is asked directly whether SCO audio is connected — the listener event
     * is the thing that goes missing on OEM stacks, not the link.
     */
    private fun onEstablishTimeout(device: RouteDevice) {
        if (!started || establishing?.id != device.id) return
        if (facade.isVoiceLinkConnected(device)) {
            logger.log("route: establish timeout t=${clock()}ms but the link is up; keeping it")
            markEstablished(device)
            reevaluate()
            return
        }
        failEstablishment(device, "not confirmed within ${ESTABLISH_TIMEOUT_MS}ms")
        reevaluate()
    }

    private fun post(action: () -> Unit) {
        scheduler.execute(action)
    }
}
