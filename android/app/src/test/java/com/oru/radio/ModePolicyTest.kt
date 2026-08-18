package com.oru.radio

import com.oru.radio.ModePolicy.Action
import com.oru.radio.ModePolicy.AudioMode
import com.oru.radio.ModePolicy.MicSource
import com.oru.radio.ModePolicy.Profile
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * Section 7 of docs/superpowers/specs/2026-08-18-seamless-headphone-audio-design.md,
 * as a transition table.
 *
 * Section 10 "Shared": `ios/Radio/Tests/RadioKitTests/ModePolicyTests.swift` asserts the
 * same rows, with the same names, in the same order. The two files are kept honest
 * mechanically — from the repository root:
 *
 *     diff <(grep -o 'assertRow("[^"]*"' ios/Radio/Tests/RadioKitTests/ModePolicyTests.swift) \
 *          <(grep -o 'assertRow("[^"]*"' android/app/src/test/java/com/oru/radio/ModePolicyTest.kt)
 *
 * must print nothing. A row added on one side only is a forked contract, not a test.
 */
class ModePolicyTest {

    // region Table harness

    /** One input to the policy. Mirrors `Input` in ModePolicyTests.swift. */
    private sealed interface Input {
        data class OtherAudio(val active: Boolean) : Input
        data class RadioActive(val active: Boolean) : Input
        data class RouteRequiresVoiceLink(val requires: Boolean) : Input
        data class SetAudioMode(val mode: AudioMode) : Input
        data object PttPressed : Input
        data object PttReleased : Input
        data object VoiceLinkEstablished : Input
        data object VoiceLinkFailed : Input
        data object Tick : Input
    }

    /**
     * What a step expects of `Decision.nextWakeupMs`. `Unchecked` is for steps whose
     * pending timers a later task changes; `NoTimer` asserts null.
     */
    private sealed interface Wakeup {
        data object Unchecked : Wakeup
        data object NoTimer : Wakeup
        data class At(val ms: Long) : Wakeup
    }

    private data class Step(
        val atMs: Long,
        val input: Input,
        val profile: Profile,
        val actions: List<Action> = emptyList(),
        val wakeup: Wakeup = Wakeup.Unchecked,
    )

    /** Runs one table row against a fresh policy. */
    private fun assertRow(name: String, steps: List<Step>) {
        val policy = ModePolicy()
        steps.forEachIndexed { index, step ->
            val decision = feed(policy, step)
            assertEquals("$name step $index profile", step.profile, decision.profile)
            assertEquals("$name step $index actions", step.actions, decision.actions)
            when (val wakeup = step.wakeup) {
                is Wakeup.Unchecked -> Unit
                is Wakeup.NoTimer ->
                    assertNull("$name step $index wakeup", decision.nextWakeupMs)
                is Wakeup.At -> {
                    // Typed as Long? so JUnit picks assertEquals(String, Object, Object)
                    // instead of the primitive overload, which would unbox a null.
                    val expected: Long? = wakeup.ms
                    assertEquals("$name step $index wakeup", expected, decision.nextWakeupMs)
                }
            }
        }
    }

    private fun feed(policy: ModePolicy, step: Step): ModePolicy.Decision =
        when (val input = step.input) {
            is Input.OtherAudio -> policy.setOtherAudioActive(input.active, step.atMs)
            is Input.RadioActive -> policy.setRadioActive(input.active, step.atMs)
            is Input.RouteRequiresVoiceLink ->
                policy.setRouteRequiresVoiceLink(input.requires, step.atMs)
            is Input.SetAudioMode -> policy.setAudioMode(input.mode, step.atMs)
            is Input.PttPressed -> policy.pttPressed(step.atMs)
            is Input.PttReleased -> policy.pttReleased(step.atMs)
            is Input.VoiceLinkEstablished -> policy.voiceLinkEstablished(step.atMs)
            is Input.VoiceLinkFailed -> policy.voiceLinkFailed(step.atMs)
            is Input.Tick -> policy.tick(step.atMs)
        }

    // endregion

    // region Constants

    @Test
    fun `constants are the spec values`() {
        assertEquals(2_000L, ModePolicy.Constants.OTHER_AUDIO_TO_MEDIA_MS)
        assertEquals(30_000L, ModePolicy.Constants.OTHER_AUDIO_TO_VOICE_MS)
        assertEquals(10_000L, ModePolicy.Constants.SWITCH_RATE_LIMIT_MS)
        assertEquals(4_000L, ModePolicy.Constants.VOICE_LINK_GRANT_TIMEOUT_MS)
        assertEquals(15_000L, ModePolicy.Constants.VOICE_LINK_LINGER_MS)
    }

    // endregion

    // region Defaults and the audioMode pin

    @Test
    fun `a fresh policy with no other audio and no external route requests VOICE`() {
        assertRow("a fresh policy with no other audio and no external route requests VOICE", listOf(
            Step(0L, Input.Tick, Profile.VOICE, emptyList(), Wakeup.NoTimer),
        ))
    }

    @Test
    fun `audioMode media pins MEDIA`() {
        assertRow("audioMode media pins MEDIA", listOf(
            Step(0L, Input.SetAudioMode(AudioMode.MEDIA), Profile.MEDIA, emptyList(), Wakeup.NoTimer),
            Step(1_000L, Input.Tick, Profile.MEDIA, emptyList(), Wakeup.NoTimer),
        ))
    }

    @Test
    fun `audioMode voice pins VOICE while other audio plays`() {
        assertRow("audioMode voice pins VOICE while other audio plays", listOf(
            Step(0L, Input.RouteRequiresVoiceLink(true), Profile.VOICE),
            Step(0L, Input.SetAudioMode(AudioMode.VOICE), Profile.VOICE),
            Step(0L, Input.OtherAudio(true), Profile.VOICE),
            Step(10_000L, Input.Tick, Profile.VOICE, emptyList(), Wakeup.NoTimer),
        ))
    }

    @Test
    fun `clearing the pin hands the profile back to the policy`() {
        // The second switch is at 10 000 ms, not 1 000: from Task 3 on, the 10 s rate
        // limit would otherwise defer it, and this row is about the pin, not the limit.
        assertRow("clearing the pin hands the profile back to the policy", listOf(
            Step(0L, Input.SetAudioMode(AudioMode.MEDIA), Profile.MEDIA, emptyList(), Wakeup.NoTimer),
            Step(10_000L, Input.SetAudioMode(AudioMode.AUTO), Profile.VOICE, emptyList(), Wakeup.NoTimer),
        ))
    }

    // endregion
}
