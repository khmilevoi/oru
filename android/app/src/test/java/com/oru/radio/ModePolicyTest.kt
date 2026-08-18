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

    // region Other-audio hysteresis

    @Test
    fun `two seconds of other audio switch VOICE to MEDIA`() {
        assertRow("two seconds of other audio switch VOICE to MEDIA", listOf(
            Step(0L, Input.RouteRequiresVoiceLink(true), Profile.VOICE, emptyList(), Wakeup.NoTimer),
            Step(1_000L, Input.OtherAudio(true), Profile.VOICE, emptyList(), Wakeup.At(3_000L)),
            Step(3_000L, Input.Tick, Profile.MEDIA, emptyList(), Wakeup.NoTimer),
        ))
    }

    @Test
    fun `other audio shorter than two seconds does not switch`() {
        assertRow("other audio shorter than two seconds does not switch", listOf(
            Step(0L, Input.RouteRequiresVoiceLink(true), Profile.VOICE, emptyList(), Wakeup.NoTimer),
            Step(0L, Input.OtherAudio(true), Profile.VOICE, emptyList(), Wakeup.At(2_000L)),
            Step(1_999L, Input.Tick, Profile.VOICE, emptyList(), Wakeup.At(2_000L)),
            Step(1_999L, Input.OtherAudio(false), Profile.VOICE, emptyList(), Wakeup.NoTimer),
            Step(60_000L, Input.Tick, Profile.VOICE, emptyList(), Wakeup.NoTimer),
        ))
    }

    @Test
    fun `a gap in other audio restarts the two second dwell`() {
        assertRow("a gap in other audio restarts the two second dwell", listOf(
            Step(0L, Input.RouteRequiresVoiceLink(true), Profile.VOICE, emptyList(), Wakeup.NoTimer),
            Step(0L, Input.OtherAudio(true), Profile.VOICE, emptyList(), Wakeup.At(2_000L)),
            Step(1_500L, Input.OtherAudio(false), Profile.VOICE, emptyList(), Wakeup.NoTimer),
            Step(1_600L, Input.OtherAudio(true), Profile.VOICE, emptyList(), Wakeup.At(3_600L)),
            Step(3_500L, Input.Tick, Profile.VOICE, emptyList(), Wakeup.At(3_600L)),
            Step(3_600L, Input.Tick, Profile.MEDIA, emptyList(), Wakeup.NoTimer),
        ))
    }

    @Test
    fun `thirty seconds of silence switch MEDIA back to VOICE`() {
        assertRow("thirty seconds of silence switch MEDIA back to VOICE", listOf(
            Step(0L, Input.RouteRequiresVoiceLink(true), Profile.VOICE, emptyList(), Wakeup.NoTimer),
            Step(0L, Input.OtherAudio(true), Profile.VOICE, emptyList(), Wakeup.At(2_000L)),
            Step(2_000L, Input.Tick, Profile.MEDIA, emptyList(), Wakeup.NoTimer),
            Step(2_000L, Input.OtherAudio(false), Profile.MEDIA, emptyList(), Wakeup.At(32_000L)),
            Step(31_999L, Input.Tick, Profile.MEDIA, emptyList(), Wakeup.At(32_000L)),
            Step(32_000L, Input.Tick, Profile.VOICE, emptyList(), Wakeup.NoTimer),
        ))
    }

    @Test
    fun `silence shorter than thirty seconds keeps MEDIA`() {
        assertRow("silence shorter than thirty seconds keeps MEDIA", listOf(
            Step(0L, Input.RouteRequiresVoiceLink(true), Profile.VOICE, emptyList(), Wakeup.NoTimer),
            Step(0L, Input.OtherAudio(true), Profile.VOICE, emptyList(), Wakeup.At(2_000L)),
            Step(2_000L, Input.Tick, Profile.MEDIA, emptyList(), Wakeup.NoTimer),
            Step(2_000L, Input.OtherAudio(false), Profile.MEDIA, emptyList(), Wakeup.At(32_000L)),
            Step(31_999L, Input.Tick, Profile.MEDIA, emptyList(), Wakeup.At(32_000L)),
        ))
    }

    @Test
    fun `other audio restarting inside the silence window keeps MEDIA`() {
        assertRow("other audio restarting inside the silence window keeps MEDIA", listOf(
            Step(0L, Input.RouteRequiresVoiceLink(true), Profile.VOICE, emptyList(), Wakeup.NoTimer),
            Step(0L, Input.OtherAudio(true), Profile.VOICE, emptyList(), Wakeup.At(2_000L)),
            Step(2_000L, Input.Tick, Profile.MEDIA, emptyList(), Wakeup.NoTimer),
            Step(2_000L, Input.OtherAudio(false), Profile.MEDIA, emptyList(), Wakeup.At(32_000L)),
            Step(20_000L, Input.OtherAudio(true), Profile.MEDIA, emptyList(), Wakeup.NoTimer),
            Step(60_000L, Input.Tick, Profile.MEDIA, emptyList(), Wakeup.NoTimer),
        ))
    }

    @Test
    fun `a route with no voice link keeps VOICE while other audio plays`() {
        // Section 7: "Non-BT-Classic routes have no profile conflict: the policy is inert
        // there." Holding VOICE costs nothing without a conflict and keeps PTT instant.
        assertRow("a route with no voice link keeps VOICE while other audio plays", listOf(
            Step(0L, Input.OtherAudio(true), Profile.VOICE, emptyList(), Wakeup.At(2_000L)),
            Step(2_000L, Input.Tick, Profile.VOICE, emptyList(), Wakeup.NoTimer),
            Step(3_000L, Input.Tick, Profile.VOICE, emptyList(), Wakeup.NoTimer),
        ))
    }

    @Test
    fun `a headset connecting while other audio already plays switches to MEDIA at once`() {
        // The dwell kept running while the route was inert, so the 2 s is already served
        // when the headset arrives.
        assertRow("a headset connecting while other audio already plays switches to MEDIA at once", listOf(
            Step(0L, Input.OtherAudio(true), Profile.VOICE, emptyList(), Wakeup.At(2_000L)),
            Step(2_000L, Input.Tick, Profile.VOICE, emptyList(), Wakeup.NoTimer),
            Step(5_000L, Input.RouteRequiresVoiceLink(true), Profile.MEDIA, emptyList(), Wakeup.NoTimer),
        ))
    }

    // endregion

    // region Radio-idle queuing and the rate limit

    @Test
    fun `a switch waits while the radio is busy and applies when it goes idle`() {
        // No timer is reported while the radio is busy: the switch is waiting on an input
        // (the radio going idle), not on a clock.
        assertRow("a switch waits while the radio is busy and applies when it goes idle", listOf(
            Step(0L, Input.RouteRequiresVoiceLink(true), Profile.VOICE, emptyList(), Wakeup.NoTimer),
            Step(0L, Input.RadioActive(true), Profile.VOICE, emptyList(), Wakeup.NoTimer),
            Step(0L, Input.OtherAudio(true), Profile.VOICE, emptyList(), Wakeup.At(2_000L)),
            Step(2_000L, Input.Tick, Profile.VOICE, emptyList(), Wakeup.NoTimer),
            Step(5_000L, Input.RadioActive(false), Profile.MEDIA, emptyList(), Wakeup.NoTimer),
        ))
    }

    @Test
    fun `a second switch inside ten seconds waits for the rate limit`() {
        assertRow("a second switch inside ten seconds waits for the rate limit", listOf(
            Step(0L, Input.RouteRequiresVoiceLink(true), Profile.VOICE, emptyList(), Wakeup.NoTimer),
            Step(0L, Input.OtherAudio(true), Profile.VOICE, emptyList(), Wakeup.At(2_000L)),
            Step(2_000L, Input.Tick, Profile.MEDIA, emptyList(), Wakeup.NoTimer),
            Step(3_000L, Input.SetAudioMode(AudioMode.VOICE), Profile.MEDIA, emptyList(), Wakeup.At(12_000L)),
            Step(11_999L, Input.Tick, Profile.MEDIA, emptyList(), Wakeup.At(12_000L)),
            Step(12_000L, Input.Tick, Profile.VOICE, emptyList(), Wakeup.NoTimer),
        ))
    }

    @Test
    fun `a switch more than ten seconds after the previous one is not delayed`() {
        assertRow("a switch more than ten seconds after the previous one is not delayed", listOf(
            Step(0L, Input.RouteRequiresVoiceLink(true), Profile.VOICE, emptyList(), Wakeup.NoTimer),
            Step(0L, Input.OtherAudio(true), Profile.VOICE, emptyList(), Wakeup.At(2_000L)),
            Step(2_000L, Input.Tick, Profile.MEDIA, emptyList(), Wakeup.NoTimer),
            Step(12_000L, Input.SetAudioMode(AudioMode.VOICE), Profile.VOICE, emptyList(), Wakeup.NoTimer),
        ))
    }

    @Test
    fun `a pinned mode change also waits for the radio to go idle`() {
        assertRow("a pinned mode change also waits for the radio to go idle", listOf(
            Step(0L, Input.RadioActive(true), Profile.VOICE, emptyList(), Wakeup.NoTimer),
            Step(0L, Input.SetAudioMode(AudioMode.MEDIA), Profile.VOICE, emptyList(), Wakeup.NoTimer),
            Step(1_000L, Input.RadioActive(false), Profile.MEDIA, emptyList(), Wakeup.NoTimer),
        ))
    }

    @Test
    fun `a queued switch waits for both the rate limit and the radio`() {
        assertRow("a queued switch waits for both the rate limit and the radio", listOf(
            Step(0L, Input.RouteRequiresVoiceLink(true), Profile.VOICE, emptyList(), Wakeup.NoTimer),
            Step(0L, Input.OtherAudio(true), Profile.VOICE, emptyList(), Wakeup.At(2_000L)),
            Step(2_000L, Input.Tick, Profile.MEDIA, emptyList(), Wakeup.NoTimer),
            Step(3_000L, Input.SetAudioMode(AudioMode.VOICE), Profile.MEDIA, emptyList(), Wakeup.At(12_000L)),
            Step(4_000L, Input.RadioActive(true), Profile.MEDIA, emptyList(), Wakeup.NoTimer),
            Step(20_000L, Input.Tick, Profile.MEDIA, emptyList(), Wakeup.NoTimer),
            Step(21_000L, Input.RadioActive(false), Profile.VOICE, emptyList(), Wakeup.NoTimer),
        ))
    }

    // endregion

    // region PTT, the grant tone and the raise

    @Test
    fun `PTT in VOICE plays the grant tone and starts capture at once`() {
        assertRow("PTT in VOICE plays the grant tone and starts capture at once", listOf(
            Step(0L, Input.PttPressed, Profile.VOICE,
                listOf(Action.PlayGrantTone, Action.StartCapture(MicSource.ROUTE_DEFAULT)), Wakeup.NoTimer),
            Step(500L, Input.RadioActive(true), Profile.VOICE, emptyList(), Wakeup.NoTimer),
            Step(3_000L, Input.PttReleased, Profile.VOICE, emptyList(), Wakeup.NoTimer),
        ))
    }

    @Test
    fun `PTT on a route with no voice link is immediate even in MEDIA`() {
        assertRow("PTT on a route with no voice link is immediate even in MEDIA", listOf(
            Step(0L, Input.SetAudioMode(AudioMode.MEDIA), Profile.MEDIA, emptyList(), Wakeup.NoTimer),
            Step(1_000L, Input.PttPressed, Profile.MEDIA,
                listOf(Action.PlayGrantTone, Action.StartCapture(MicSource.ROUTE_DEFAULT)), Wakeup.NoTimer),
            Step(3_000L, Input.PttReleased, Profile.MEDIA, emptyList(), Wakeup.NoTimer),
        ))
    }

    @Test
    fun `PTT in MEDIA on a voice link route raises the link and waits`() {
        assertRow("PTT in MEDIA on a voice link route raises the link and waits", listOf(
            Step(0L, Input.RouteRequiresVoiceLink(true), Profile.VOICE, emptyList(), Wakeup.NoTimer),
            Step(0L, Input.OtherAudio(true), Profile.VOICE, emptyList(), Wakeup.At(2_000L)),
            Step(2_000L, Input.Tick, Profile.MEDIA, emptyList(), Wakeup.NoTimer),
            Step(3_000L, Input.PttPressed, Profile.VOICE, listOf(Action.RaiseVoiceLink), Wakeup.At(7_000L)),
            Step(4_000L, Input.Tick, Profile.VOICE, emptyList(), Wakeup.At(7_000L)),
        ))
    }

    @Test
    fun `the grant tone follows the established link and capture uses the route mic`() {
        assertRow("the grant tone follows the established link and capture uses the route mic", listOf(
            Step(0L, Input.RouteRequiresVoiceLink(true), Profile.VOICE, emptyList(), Wakeup.NoTimer),
            Step(0L, Input.OtherAudio(true), Profile.VOICE, emptyList(), Wakeup.At(2_000L)),
            Step(2_000L, Input.Tick, Profile.MEDIA, emptyList(), Wakeup.NoTimer),
            Step(3_000L, Input.PttPressed, Profile.VOICE, listOf(Action.RaiseVoiceLink), Wakeup.At(7_000L)),
            Step(3_500L, Input.VoiceLinkEstablished, Profile.VOICE,
                listOf(Action.PlayGrantTone, Action.StartCapture(MicSource.ROUTE_DEFAULT)), Wakeup.NoTimer),
        ))
    }

    @Test
    fun `a link that never comes up times out after four seconds into the phone mic`() {
        assertRow("a link that never comes up times out after four seconds into the phone mic", listOf(
            Step(0L, Input.RouteRequiresVoiceLink(true), Profile.VOICE, emptyList(), Wakeup.NoTimer),
            Step(0L, Input.OtherAudio(true), Profile.VOICE, emptyList(), Wakeup.At(2_000L)),
            Step(2_000L, Input.Tick, Profile.MEDIA, emptyList(), Wakeup.NoTimer),
            Step(3_000L, Input.PttPressed, Profile.VOICE, listOf(Action.RaiseVoiceLink), Wakeup.At(7_000L)),
            Step(6_999L, Input.Tick, Profile.VOICE, emptyList(), Wakeup.At(7_000L)),
            Step(7_000L, Input.Tick, Profile.MEDIA,
                listOf(Action.DropVoiceLink, Action.PlayGrantTone, Action.StartCapture(MicSource.PHONE_FALLBACK)),
                Wakeup.NoTimer),
            Step(10_000L, Input.PttReleased, Profile.MEDIA, emptyList(), Wakeup.NoTimer),
        ))
    }

    @Test
    fun `an immediate link failure falls back to the phone mic without waiting`() {
        assertRow("an immediate link failure falls back to the phone mic without waiting", listOf(
            Step(0L, Input.RouteRequiresVoiceLink(true), Profile.VOICE, emptyList(), Wakeup.NoTimer),
            Step(0L, Input.OtherAudio(true), Profile.VOICE, emptyList(), Wakeup.At(2_000L)),
            Step(2_000L, Input.Tick, Profile.MEDIA, emptyList(), Wakeup.NoTimer),
            Step(3_000L, Input.PttPressed, Profile.VOICE, listOf(Action.RaiseVoiceLink), Wakeup.At(7_000L)),
            Step(3_100L, Input.VoiceLinkFailed, Profile.MEDIA,
                listOf(Action.DropVoiceLink, Action.PlayGrantTone, Action.StartCapture(MicSource.PHONE_FALLBACK)),
                Wakeup.NoTimer),
        ))
    }

    @Test
    fun `releasing before the link comes up abandons the raise with no tone`() {
        // The tone means "you may talk" and the user already let go, so there is none.
        assertRow("releasing before the link comes up abandons the raise with no tone", listOf(
            Step(0L, Input.RouteRequiresVoiceLink(true), Profile.VOICE, emptyList(), Wakeup.NoTimer),
            Step(0L, Input.OtherAudio(true), Profile.VOICE, emptyList(), Wakeup.At(2_000L)),
            Step(2_000L, Input.Tick, Profile.MEDIA, emptyList(), Wakeup.NoTimer),
            Step(3_000L, Input.PttPressed, Profile.VOICE, listOf(Action.RaiseVoiceLink), Wakeup.At(7_000L)),
            Step(3_500L, Input.PttReleased, Profile.MEDIA, listOf(Action.DropVoiceLink), Wakeup.NoTimer),
            Step(7_000L, Input.Tick, Profile.MEDIA, emptyList(), Wakeup.NoTimer),
        ))
    }

    @Test
    fun `a second press while the link is being raised is ignored`() {
        assertRow("a second press while the link is being raised is ignored", listOf(
            Step(0L, Input.RouteRequiresVoiceLink(true), Profile.VOICE, emptyList(), Wakeup.NoTimer),
            Step(0L, Input.OtherAudio(true), Profile.VOICE, emptyList(), Wakeup.At(2_000L)),
            Step(2_000L, Input.Tick, Profile.MEDIA, emptyList(), Wakeup.NoTimer),
            Step(3_000L, Input.PttPressed, Profile.VOICE, listOf(Action.RaiseVoiceLink), Wakeup.At(7_000L)),
            Step(3_100L, Input.PttPressed, Profile.VOICE, emptyList(), Wakeup.At(7_000L)),
        ))
    }

    // endregion

    // region The linger and the drop

    @Test
    fun `the raised link lingers fifteen seconds after release`() {
        assertRow("the raised link lingers fifteen seconds after release", listOf(
            Step(0L, Input.RouteRequiresVoiceLink(true), Profile.VOICE, emptyList(), Wakeup.NoTimer),
            Step(0L, Input.OtherAudio(true), Profile.VOICE, emptyList(), Wakeup.At(2_000L)),
            Step(2_000L, Input.Tick, Profile.MEDIA, emptyList(), Wakeup.NoTimer),
            Step(3_000L, Input.PttPressed, Profile.VOICE, listOf(Action.RaiseVoiceLink), Wakeup.At(7_000L)),
            Step(3_500L, Input.VoiceLinkEstablished, Profile.VOICE,
                listOf(Action.PlayGrantTone, Action.StartCapture(MicSource.ROUTE_DEFAULT)), Wakeup.NoTimer),
            Step(5_000L, Input.PttReleased, Profile.VOICE, emptyList(), Wakeup.At(20_000L)),
            Step(19_999L, Input.Tick, Profile.VOICE, emptyList(), Wakeup.At(20_000L)),
        ))
    }

    @Test
    fun `a press inside the linger window is instant`() {
        assertRow("a press inside the linger window is instant", listOf(
            Step(0L, Input.RouteRequiresVoiceLink(true), Profile.VOICE, emptyList(), Wakeup.NoTimer),
            Step(0L, Input.OtherAudio(true), Profile.VOICE, emptyList(), Wakeup.At(2_000L)),
            Step(2_000L, Input.Tick, Profile.MEDIA, emptyList(), Wakeup.NoTimer),
            Step(3_000L, Input.PttPressed, Profile.VOICE, listOf(Action.RaiseVoiceLink), Wakeup.At(7_000L)),
            Step(3_500L, Input.VoiceLinkEstablished, Profile.VOICE,
                listOf(Action.PlayGrantTone, Action.StartCapture(MicSource.ROUTE_DEFAULT)), Wakeup.NoTimer),
            Step(5_000L, Input.PttReleased, Profile.VOICE, emptyList(), Wakeup.At(20_000L)),
            Step(10_000L, Input.PttPressed, Profile.VOICE,
                listOf(Action.PlayGrantTone, Action.StartCapture(MicSource.ROUTE_DEFAULT)), Wakeup.NoTimer),
        ))
    }

    @Test
    fun `the linger restarts on every release`() {
        assertRow("the linger restarts on every release", listOf(
            Step(0L, Input.RouteRequiresVoiceLink(true), Profile.VOICE, emptyList(), Wakeup.NoTimer),
            Step(0L, Input.OtherAudio(true), Profile.VOICE, emptyList(), Wakeup.At(2_000L)),
            Step(2_000L, Input.Tick, Profile.MEDIA, emptyList(), Wakeup.NoTimer),
            Step(3_000L, Input.PttPressed, Profile.VOICE, listOf(Action.RaiseVoiceLink), Wakeup.At(7_000L)),
            Step(3_500L, Input.VoiceLinkEstablished, Profile.VOICE,
                listOf(Action.PlayGrantTone, Action.StartCapture(MicSource.ROUTE_DEFAULT)), Wakeup.NoTimer),
            Step(5_000L, Input.PttReleased, Profile.VOICE, emptyList(), Wakeup.At(20_000L)),
            Step(10_000L, Input.PttPressed, Profile.VOICE,
                listOf(Action.PlayGrantTone, Action.StartCapture(MicSource.ROUTE_DEFAULT)), Wakeup.NoTimer),
            Step(12_000L, Input.PttReleased, Profile.VOICE, emptyList(), Wakeup.At(27_000L)),
        ))
    }

    @Test
    fun `the link drops when the linger expires and MEDIA returns`() {
        assertRow("the link drops when the linger expires and MEDIA returns", listOf(
            Step(0L, Input.RouteRequiresVoiceLink(true), Profile.VOICE, emptyList(), Wakeup.NoTimer),
            Step(0L, Input.OtherAudio(true), Profile.VOICE, emptyList(), Wakeup.At(2_000L)),
            Step(2_000L, Input.Tick, Profile.MEDIA, emptyList(), Wakeup.NoTimer),
            Step(3_000L, Input.PttPressed, Profile.VOICE, listOf(Action.RaiseVoiceLink), Wakeup.At(7_000L)),
            Step(3_500L, Input.VoiceLinkEstablished, Profile.VOICE,
                listOf(Action.PlayGrantTone, Action.StartCapture(MicSource.ROUTE_DEFAULT)), Wakeup.NoTimer),
            Step(5_000L, Input.PttReleased, Profile.VOICE, emptyList(), Wakeup.At(20_000L)),
            Step(20_000L, Input.Tick, Profile.MEDIA, listOf(Action.DropVoiceLink), Wakeup.NoTimer),
        ))
    }

    @Test
    fun `a phone mic fallback transmission does not linger`() {
        assertRow("a phone mic fallback transmission does not linger", listOf(
            Step(0L, Input.RouteRequiresVoiceLink(true), Profile.VOICE, emptyList(), Wakeup.NoTimer),
            Step(0L, Input.OtherAudio(true), Profile.VOICE, emptyList(), Wakeup.At(2_000L)),
            Step(2_000L, Input.Tick, Profile.MEDIA, emptyList(), Wakeup.NoTimer),
            Step(3_000L, Input.PttPressed, Profile.VOICE, listOf(Action.RaiseVoiceLink), Wakeup.At(7_000L)),
            Step(7_000L, Input.Tick, Profile.MEDIA,
                listOf(Action.DropVoiceLink, Action.PlayGrantTone, Action.StartCapture(MicSource.PHONE_FALLBACK)),
                Wakeup.NoTimer),
            Step(10_000L, Input.PttReleased, Profile.MEDIA, emptyList(), Wakeup.NoTimer),
            Step(40_000L, Input.Tick, Profile.MEDIA, emptyList(), Wakeup.NoTimer),
        ))
    }

    @Test
    fun `the linger drop waits for the radio to go idle`() {
        // Section 7 exempts the raise/drop from the 10 s rate limit by name, not from the
        // "switches never run during receive or transmit" rule in the same bullet.
        assertRow("the linger drop waits for the radio to go idle", listOf(
            Step(0L, Input.RouteRequiresVoiceLink(true), Profile.VOICE, emptyList(), Wakeup.NoTimer),
            Step(0L, Input.OtherAudio(true), Profile.VOICE, emptyList(), Wakeup.At(2_000L)),
            Step(2_000L, Input.Tick, Profile.MEDIA, emptyList(), Wakeup.NoTimer),
            Step(3_000L, Input.PttPressed, Profile.VOICE, listOf(Action.RaiseVoiceLink), Wakeup.At(7_000L)),
            Step(3_500L, Input.VoiceLinkEstablished, Profile.VOICE,
                listOf(Action.PlayGrantTone, Action.StartCapture(MicSource.ROUTE_DEFAULT)), Wakeup.NoTimer),
            Step(5_000L, Input.PttReleased, Profile.VOICE, emptyList(), Wakeup.At(20_000L)),
            Step(10_000L, Input.RadioActive(true), Profile.VOICE, emptyList(), Wakeup.At(20_000L)),
            Step(20_000L, Input.Tick, Profile.VOICE, emptyList(), Wakeup.NoTimer),
            Step(25_000L, Input.RadioActive(false), Profile.MEDIA, listOf(Action.DropVoiceLink), Wakeup.NoTimer),
        ))
    }

    @Test
    fun `the raise is exempt from the rate limit and the drop does not consume it`() {
        // The raise happens 500 ms after a policy switch and is not deferred; the drop
        // does not stamp the limit either, which the last step proves — a policy switch
        // 100 ms after the drop is applied at once.
        assertRow("the raise is exempt from the rate limit and the drop does not consume it", listOf(
            Step(0L, Input.RouteRequiresVoiceLink(true), Profile.VOICE, emptyList(), Wakeup.NoTimer),
            Step(0L, Input.OtherAudio(true), Profile.VOICE, emptyList(), Wakeup.At(2_000L)),
            Step(2_000L, Input.Tick, Profile.MEDIA, emptyList(), Wakeup.NoTimer),
            Step(2_500L, Input.PttPressed, Profile.VOICE, listOf(Action.RaiseVoiceLink), Wakeup.At(6_500L)),
            Step(2_600L, Input.VoiceLinkEstablished, Profile.VOICE,
                listOf(Action.PlayGrantTone, Action.StartCapture(MicSource.ROUTE_DEFAULT)), Wakeup.NoTimer),
            Step(2_700L, Input.PttReleased, Profile.VOICE, emptyList(), Wakeup.At(17_700L)),
            Step(17_700L, Input.Tick, Profile.MEDIA, listOf(Action.DropVoiceLink), Wakeup.NoTimer),
            Step(17_800L, Input.SetAudioMode(AudioMode.VOICE), Profile.VOICE, emptyList(), Wakeup.NoTimer),
        ))
    }

    @Test
    fun `the link is kept when the policy wants VOICE by the time the linger expires`() {
        assertRow("the link is kept when the policy wants VOICE by the time the linger expires", listOf(
            Step(0L, Input.RouteRequiresVoiceLink(true), Profile.VOICE, emptyList(), Wakeup.NoTimer),
            Step(0L, Input.OtherAudio(true), Profile.VOICE, emptyList(), Wakeup.At(2_000L)),
            Step(2_000L, Input.Tick, Profile.MEDIA, emptyList(), Wakeup.NoTimer),
            Step(3_000L, Input.PttPressed, Profile.VOICE, listOf(Action.RaiseVoiceLink), Wakeup.At(7_000L)),
            Step(3_100L, Input.VoiceLinkEstablished, Profile.VOICE,
                listOf(Action.PlayGrantTone, Action.StartCapture(MicSource.ROUTE_DEFAULT)), Wakeup.NoTimer),
            Step(3_200L, Input.OtherAudio(false), Profile.VOICE, emptyList(), Wakeup.At(33_200L)),
            Step(4_000L, Input.PttReleased, Profile.VOICE, emptyList(), Wakeup.At(19_000L)),
            Step(18_000L, Input.PttPressed, Profile.VOICE,
                listOf(Action.PlayGrantTone, Action.StartCapture(MicSource.ROUTE_DEFAULT)), Wakeup.At(33_200L)),
            Step(19_000L, Input.PttReleased, Profile.VOICE, emptyList(), Wakeup.At(33_200L)),
            Step(33_200L, Input.Tick, Profile.VOICE, emptyList(), Wakeup.At(34_000L)),
            Step(34_000L, Input.Tick, Profile.VOICE, emptyList(), Wakeup.NoTimer),
        ))
    }

    @Test
    fun `PTT raises the link inside a pinned media mode`() {
        assertRow("PTT raises the link inside a pinned media mode", listOf(
            Step(0L, Input.RouteRequiresVoiceLink(true), Profile.VOICE, emptyList(), Wakeup.NoTimer),
            Step(0L, Input.SetAudioMode(AudioMode.MEDIA), Profile.MEDIA, emptyList(), Wakeup.NoTimer),
            Step(1_000L, Input.PttPressed, Profile.VOICE, listOf(Action.RaiseVoiceLink), Wakeup.At(5_000L)),
            Step(1_500L, Input.VoiceLinkEstablished, Profile.VOICE,
                listOf(Action.PlayGrantTone, Action.StartCapture(MicSource.ROUTE_DEFAULT)), Wakeup.NoTimer),
            Step(2_000L, Input.PttReleased, Profile.VOICE, emptyList(), Wakeup.At(17_000L)),
            Step(17_000L, Input.Tick, Profile.MEDIA, listOf(Action.DropVoiceLink), Wakeup.NoTimer),
        ))
    }

    // endregion

    // region Section 9 behaviour contract, as compositions

    @Test
    fun `section 9 headset connects then music starts then PTT then music stops`() {
        // Section 9 rows: "BT headset connects, no music"; "user starts music"; "incoming
        // voice during music"; "PTT press during music"; "music stops".
        assertRow("section 9 headset connects then music starts then PTT then music stops", listOf(
            Step(0L, Input.RouteRequiresVoiceLink(true), Profile.VOICE, emptyList(), Wakeup.NoTimer),
            Step(5_000L, Input.OtherAudio(true), Profile.VOICE, emptyList(), Wakeup.At(7_000L)),
            Step(7_000L, Input.Tick, Profile.MEDIA, emptyList(), Wakeup.NoTimer),
            Step(10_000L, Input.RadioActive(true), Profile.MEDIA, emptyList(), Wakeup.NoTimer),
            Step(13_000L, Input.RadioActive(false), Profile.MEDIA, emptyList(), Wakeup.NoTimer),
            Step(20_000L, Input.PttPressed, Profile.VOICE, listOf(Action.RaiseVoiceLink), Wakeup.At(24_000L)),
            Step(21_500L, Input.VoiceLinkEstablished, Profile.VOICE,
                listOf(Action.PlayGrantTone, Action.StartCapture(MicSource.ROUTE_DEFAULT)), Wakeup.NoTimer),
            Step(21_500L, Input.RadioActive(true), Profile.VOICE, emptyList(), Wakeup.NoTimer),
            Step(25_000L, Input.PttReleased, Profile.VOICE, emptyList(), Wakeup.At(40_000L)),
            Step(25_000L, Input.RadioActive(false), Profile.VOICE, emptyList(), Wakeup.At(40_000L)),
            Step(40_000L, Input.Tick, Profile.MEDIA, listOf(Action.DropVoiceLink), Wakeup.NoTimer),
            Step(45_000L, Input.OtherAudio(false), Profile.MEDIA, emptyList(), Wakeup.At(75_000L)),
            Step(75_000L, Input.Tick, Profile.VOICE, emptyList(), Wakeup.NoTimer),
        ))
    }

    @Test
    fun `section 9 the headset dies during the linger`() {
        // Section 9 row: "Headset battery dies / walks out of range → immediate
        // loudspeaker + phone mic; no error state". The link is not dropped on the way
        // out: with no headset there is no profile conflict, so VOICE is where the policy
        // belongs.
        assertRow("section 9 the headset dies during the linger", listOf(
            Step(0L, Input.RouteRequiresVoiceLink(true), Profile.VOICE, emptyList(), Wakeup.NoTimer),
            Step(0L, Input.OtherAudio(true), Profile.VOICE, emptyList(), Wakeup.At(2_000L)),
            Step(2_000L, Input.Tick, Profile.MEDIA, emptyList(), Wakeup.NoTimer),
            Step(3_000L, Input.PttPressed, Profile.VOICE, listOf(Action.RaiseVoiceLink), Wakeup.At(7_000L)),
            Step(3_500L, Input.VoiceLinkEstablished, Profile.VOICE,
                listOf(Action.PlayGrantTone, Action.StartCapture(MicSource.ROUTE_DEFAULT)), Wakeup.NoTimer),
            Step(5_000L, Input.PttReleased, Profile.VOICE, emptyList(), Wakeup.At(20_000L)),
            Step(8_000L, Input.RouteRequiresVoiceLink(false), Profile.VOICE, emptyList(), Wakeup.At(20_000L)),
            Step(20_000L, Input.Tick, Profile.VOICE, emptyList(), Wakeup.NoTimer),
        ))
    }

    @Test
    fun `section 9 incoming voice during other audio never switches the profile`() {
        // Section 9 row: "Incoming voice during music → voice plays into the A2DP stream;
        // no profile switch".
        assertRow("section 9 incoming voice during other audio never switches the profile", listOf(
            Step(0L, Input.RouteRequiresVoiceLink(true), Profile.VOICE, emptyList(), Wakeup.NoTimer),
            Step(0L, Input.OtherAudio(true), Profile.VOICE, emptyList(), Wakeup.At(2_000L)),
            Step(2_000L, Input.Tick, Profile.MEDIA, emptyList(), Wakeup.NoTimer),
            Step(3_000L, Input.RadioActive(true), Profile.MEDIA, emptyList(), Wakeup.NoTimer),
            Step(9_000L, Input.RadioActive(false), Profile.MEDIA, emptyList(), Wakeup.NoTimer),
            Step(9_000L, Input.Tick, Profile.MEDIA, emptyList(), Wakeup.NoTimer),
        ))
    }

    // endregion
}
