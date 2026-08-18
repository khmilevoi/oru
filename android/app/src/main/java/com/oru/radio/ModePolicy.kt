package com.oru.radio

/**
 * Section 7 of docs/superpowers/specs/2026-08-18-seamless-headphone-audio-design.md: the
 * shared VOICE/MEDIA mode policy.
 *
 * Pure and I/O-free. It takes events plus a caller-supplied monotonic timestamp and
 * returns the profile the platform should have applied, the actions it should perform and
 * the moment it must call [tick] again. It owns no timer, no handler and no audio object:
 * applying a profile, raising SCO, playing the tone and starting capture are the
 * platform's jobs (section 5 iOS, section 6 Android).
 *
 * `ios/Radio/Sources/RadioKit/ModePolicy.swift` is the line-for-line Swift twin of this
 * file, and both test files assert the same table (section 10 "Shared"). A change here
 * without the same change there forks the contract; wave-2 platform work reports a needed
 * change instead of patching one side.
 *
 * Time is absolute monotonic milliseconds — the platform's elapsed-realtime clock, never a
 * wall clock: a system time change must not move a dwell deadline.
 */
class ModePolicy {

    // region Vocabulary

    /**
     * The profile the platform should have applied. Sections 5 and 6 define what applying
     * it means on each platform.
     */
    enum class Profile { VOICE, MEDIA }

    /** The section 8 `audioMode` setting. AUTO runs this policy; the other two pin it. */
    enum class AudioMode { AUTO, VOICE, MEDIA }

    /** Which microphone capture should use for this transmission. */
    enum class MicSource {
        /** The microphone of the current route (the headset's, over a raised link). */
        ROUTE_DEFAULT,

        /** Section 7's fallback after a raise that timed out or failed: the phone mic. */
        PHONE_FALLBACK,
    }

    sealed interface Action {
        /**
         * Bring the headset voice link up now — `setCommunicationDevice`/SCO on Android,
         * the VOICE session configuration on iOS — and answer with
         * [voiceLinkEstablished] or [voiceLinkFailed]. Exempt from the 10 s rate limit.
         */
        data object RaiseVoiceLink : Action

        /**
         * Undo a raise: clear the communication device / re-apply the MEDIA
         * configuration, so the headset returns to A2DP and music resumes.
         */
        data object DropVoiceLink : Action

        /**
         * The talk-permit tone (decision D2). Always immediately followed by
         * [StartCapture]: press then tone then talk, in every mode.
         */
        data object PlayGrantTone : Action

        data class StartCapture(val mic: MicSource) : Action
    }

    data class Decision(
        /**
         * The profile the platform should have applied after this event. Diff-only: the
         * platform skips re-applying an unchanged profile.
         */
        val profile: Profile,
        /** Side effects to perform, in order. */
        val actions: List<Action>,
        /**
         * Absolute monotonic millisecond at which the platform must call [tick], or null
         * when nothing is pending. Re-read after every call.
         */
        val nextWakeupMs: Long?,
    )

    /**
     * Section 7's five constants. ModePolicy.swift carries the same five values.
     *
     * They live here rather than in [RadioConfig] because these two files are the one
     * place the two platforms are guaranteed to agree; a value duplicated into two
     * per-platform config files is a value that can drift.
     */
    object Constants {
        /** VOICE to MEDIA once other audio has been playing this long. */
        const val OTHER_AUDIO_TO_MEDIA_MS = 2_000L

        /**
         * MEDIA to VOICE once other audio has been silent this long. Asymmetric on
         * purpose: protect the user's music fast, never flap between tracks.
         */
        const val OTHER_AUDIO_TO_VOICE_MS = 30_000L

        /** At most one policy-driven VOICE/MEDIA switch per this window. */
        const val SWITCH_RATE_LIMIT_MS = 10_000L

        /**
         * How long a PTT-driven raise waits for the headset mic path before falling back
         * to the phone mic for this transmission.
         */
        const val VOICE_LINK_GRANT_TIMEOUT_MS = 4_000L

        /**
         * How long a raised link is held after PTT release, so the rest of the
         * conversation is instant.
         */
        const val VOICE_LINK_LINGER_MS = 15_000L
    }

    // endregion

    // region State

    /** Where the PTT half of section 7 stands. Task 5 adds the linger states. */
    private sealed interface PttState {
        data object Idle : PttState

        /** A raise was requested; [deadlineMs] is when the 4 s grant timeout fires. */
        data class AwaitingLink(val deadlineMs: Long) : PttState

        /**
         * Capture is running. [linkRaised] is false when this transmission fell back to
         * the phone mic, which is why it has nothing to linger on afterwards.
         */
        data class Talking(val linkRaised: Boolean) : PttState
    }

    private var audioMode: AudioMode = AudioMode.AUTO
    private var routeRequiresVoiceLink = false
    private var radioActive = false
    private var otherAudioActive = false

    /** When the current value of [otherAudioActive] began. Null until the first change. */
    private var otherAudioSinceMs: Long? = null

    /** What the automatic policy wants. The other-audio dwell moves it; pins ignore it. */
    private var desiredAutoProfile: Profile = Profile.VOICE

    /** What the platform has been told to apply. */
    private var appliedProfile: Profile = Profile.VOICE

    /**
     * When the last policy-driven switch was applied, for the 10 s rate limit. The PTT
     * raise/drop of section 7 neither consults nor stamps it.
     */
    private var lastSwitchMs: Long? = null

    private var pttState: PttState = PttState.Idle

    // endregion

    // region Inputs

    fun setAudioMode(mode: AudioMode, nowMs: Long): Decision = step(nowMs) {
        audioMode = mode
        emptyList()
    }

    /**
     * Raw, undebounced: the 2 s / 30 s dwell of section 7 lives in this class, not in the
     * detector, so both platforms debounce identically.
     */
    fun setOtherAudioActive(active: Boolean, nowMs: Long): Decision = step(nowMs) {
        if (active != otherAudioActive) {
            otherAudioActive = active
            otherAudioSinceMs = nowMs
        }
        emptyList()
    }

    /**
     * The radio is receiving or transmitting. Fed by the engine, not derived from the
     * button: a transmission also ends on the 120 s safety cap.
     */
    fun setRadioActive(active: Boolean, nowMs: Long): Decision = step(nowMs) {
        radioActive = active
        emptyList()
    }

    /**
     * True when reaching the accessory's microphone would need a BT-Classic voice link
     * raised. False for speaker, wired, USB and anything else with no profile conflict —
     * section 7's "the policy is inert there".
     */
    fun setRouteRequiresVoiceLink(requires: Boolean, nowMs: Long): Decision = step(nowMs) {
        routeRequiresVoiceLink = requires
        emptyList()
    }

    fun pttPressed(nowMs: Long): Decision = step(nowMs) { press(nowMs) }

    fun pttReleased(nowMs: Long): Decision = step(nowMs) { release(nowMs) }

    /** The headset mic path is confirmed (SCO connected / the comm device applied). */
    fun voiceLinkEstablished(nowMs: Long): Decision = step(nowMs) {
        if (pttState !is PttState.AwaitingLink) {
            emptyList()
        } else {
            pttState = PttState.Talking(linkRaised = true)
            listOf(Action.PlayGrantTone, Action.StartCapture(MicSource.ROUTE_DEFAULT))
        }
    }

    /**
     * The raise failed outright (`setCommunicationDevice` returned false, an SCO error).
     * Same answer as the 4 s timeout, without waiting for it.
     */
    fun voiceLinkFailed(nowMs: Long): Decision = step(nowMs) {
        if (pttState !is PttState.AwaitingLink) emptyList() else abandonRaise()
    }

    /** Called when the previous decision's [Decision.nextWakeupMs] says to. */
    fun tick(nowMs: Long): Decision = step(nowMs) { emptyList() }

    // endregion

    // region Core

    /**
     * Every input runs the same pipeline: age the timers that do not produce actions,
     * apply the input, then let the profile catch up with what the policy wants.
     */
    private fun step(nowMs: Long, input: () -> List<Action>): Decision {
        updateDwell(nowMs)
        val actions = input() + settleLink(nowMs)
        applyBaseIfAllowed(nowMs)
        return Decision(
            profile = requestedProfile(),
            actions = actions,
            nextWakeupMs = nextWakeupMs(nowMs),
        )
    }

    /**
     * The profile the policy wants, before any gate: a pin wins outright, and AUTO holds
     * VOICE on routes with no profile conflict.
     */
    private fun baseProfile(): Profile = when (audioMode) {
        AudioMode.VOICE -> Profile.VOICE
        AudioMode.MEDIA -> Profile.MEDIA
        AudioMode.AUTO -> if (routeRequiresVoiceLink) desiredAutoProfile else Profile.VOICE
    }

    /** True while this policy is holding a headset voice link up on the platform. */
    private fun holdsVoiceLink(): Boolean = when (val state = pttState) {
        is PttState.Idle -> false
        is PttState.Talking -> state.linkRaised
        is PttState.AwaitingLink -> true
    }

    private fun requestedProfile(): Profile =
        if (holdsVoiceLink()) Profile.VOICE else appliedProfile

    /**
     * Section 7: "press then tone then talk", in every mode. The tone is immediate
     * wherever the mic is already live — in VOICE, and on any route with no profile
     * conflict — and waits for the raise otherwise.
     */
    private fun press(nowMs: Long): List<Action> = when (pttState) {
        is PttState.AwaitingLink, is PttState.Talking -> emptyList()
        is PttState.Idle ->
            if (appliedProfile == Profile.VOICE || !routeRequiresVoiceLink) {
                pttState = PttState.Talking(linkRaised = false)
                listOf(Action.PlayGrantTone, Action.StartCapture(MicSource.ROUTE_DEFAULT))
            } else {
                pttState = PttState.AwaitingLink(
                    deadlineMs = nowMs + Constants.VOICE_LINK_GRANT_TIMEOUT_MS,
                )
                listOf(Action.RaiseVoiceLink)
            }
    }

    private fun release(nowMs: Long): List<Action> = when (pttState) {
        is PttState.Talking -> {
            pttState = PttState.Idle
            emptyList()
        }
        // Released before the mic ever went live: no tone, nothing to capture.
        is PttState.AwaitingLink -> abandonRaise(startCapture = false)
        is PttState.Idle -> emptyList()
    }

    /**
     * Gives up a raise that timed out or failed (section 7's 4 s timeout, D2's SCO
     * failure). The pending raise is undone *before* the tone, so capture starts with the
     * base profile already restored — D2 rejects swapping the mic mid-transmission, so a
     * link that arrives late is not used for this transmission. Restoring the base profile
     * here is part of the raise/drop mechanism and so is exempt from the rate limit: it
     * neither consults nor stamps [lastSwitchMs].
     */
    private fun abandonRaise(startCapture: Boolean = true): List<Action> {
        pttState = if (startCapture) PttState.Talking(linkRaised = false) else PttState.Idle
        val base = baseProfile()
        appliedProfile = base
        val actions = mutableListOf<Action>()
        if (base != Profile.VOICE) actions.add(Action.DropVoiceLink)
        if (startCapture) {
            actions.add(Action.PlayGrantTone)
            actions.add(Action.StartCapture(MicSource.PHONE_FALLBACK))
        }
        return actions
    }

    /**
     * Fires the PTT deadlines that have come due. Runs after the input, so an input that
     * resolves a deadline (a link arriving at 4.1 s, a release) wins over it.
     */
    private fun settleLink(nowMs: Long): List<Action> = when (val state = pttState) {
        is PttState.AwaitingLink ->
            if (nowMs >= state.deadlineMs) abandonRaise() else emptyList()
        is PttState.Idle, is PttState.Talking -> emptyList()
    }

    /**
     * Section 7's two gates on a VOICE/MEDIA switch: it never runs during receive or
     * transmit (it queues for idle), and at most one runs per [Constants.SWITCH_RATE_LIMIT_MS].
     * A pin change is a switch like any other — applying one mid-transmission would break
     * the same audio a policy switch would.
     */
    private fun applyBaseIfAllowed(nowMs: Long) {
        // While a press is in flight the profile belongs to the PTT machine; a policy
        // switch would fight it.
        if (pttState !is PttState.Idle) return
        val base = baseProfile()
        if (base == appliedProfile || radioActive) return
        val last = lastSwitchMs
        if (last != null && nowMs - last < Constants.SWITCH_RATE_LIMIT_MS) return
        appliedProfile = base
        lastSwitchMs = nowMs
    }

    /**
     * Section 7's asymmetric hysteresis. The dwell latches what the automatic policy
     * *wants*; the gates below decide when the applied profile catches up ("switch at the
     * next radio-idle moment"). It keeps running on routes with no voice link, so a
     * headset connecting into already-playing music does not restart the 2 s.
     */
    private fun updateDwell(nowMs: Long) {
        val since = otherAudioSinceMs ?: return
        if (otherAudioActive) {
            if (nowMs - since >= Constants.OTHER_AUDIO_TO_MEDIA_MS) {
                desiredAutoProfile = Profile.MEDIA
            }
        } else if (nowMs - since >= Constants.OTHER_AUDIO_TO_VOICE_MS) {
            desiredAutoProfile = Profile.VOICE
        }
    }

    /**
     * The earliest moment at which a [tick] could change something. [updateDwell] has
     * already run, so a dwell deadline is only reported while it is still in the future.
     */
    private fun nextWakeupMs(nowMs: Long): Long? {
        val deadlines = mutableListOf<Long>()
        val since = otherAudioSinceMs
        if (since != null) {
            if (otherAudioActive && desiredAutoProfile != Profile.MEDIA) {
                deadlines.add(since + Constants.OTHER_AUDIO_TO_MEDIA_MS)
            }
            if (!otherAudioActive && desiredAutoProfile != Profile.VOICE) {
                deadlines.add(since + Constants.OTHER_AUDIO_TO_VOICE_MS)
            }
        }
        val state = pttState
        if (state is PttState.AwaitingLink) deadlines.add(state.deadlineMs)
        // A switch the rate limit is holding back will need a tick when the window
        // closes. One the *radio* is holding back does not: the radio going idle is an
        // input, and it runs the gate itself.
        val last = lastSwitchMs
        if (pttState is PttState.Idle && baseProfile() != appliedProfile && !radioActive &&
            last != null && nowMs - last < Constants.SWITCH_RATE_LIMIT_MS
        ) {
            deadlines.add(last + Constants.SWITCH_RATE_LIMIT_MS)
        }
        return deadlines.minOrNull()
    }

    // endregion
}
