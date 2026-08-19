# Android seamless headphone routing — Implementation Plan (P4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Android routing machinery inside `RadioForegroundService` with a
dedicated, unit-tested `AudioRouteController` that implements §6 of the spec — two profiles,
per-burst ducking focus, bounded retries instead of a blacklist, no dead air while a headset
link establishes, stream survival across route changes, and real `audioRoute` / `audioMode`
publication through the existing bridge.

**Architecture:** Every routing *decision* moves out of the service into
`AudioRouteController`, which owns a dedicated `HandlerThread("audio-route")` (through the
existing `Scheduler` port), funnels every event into one idempotent `reevaluate()`, and
reaches the platform only through an injected `AudioManagerFacade`. Pure classification —
device priority, the `" Watch"` filter, HFP cross-validation, route kind/label — lives in a
side-effect-free `RoutePicker`. The already-merged `ModePolicy` (P1) decides VOICE/MEDIA and
the PTT raise; the controller only executes its decisions. `RadioEngine` gains an
`AudioRouting` port so PTT press → grant tone → capture is sequenced by the policy, and
`AudioEngine` rebuilds its `AudioRecord`/`AudioTrack` whenever the applied route or profile
changes.

**Tech Stack:** Kotlin (JVM target 17), Android API 26 minimum with API 31+ primitives
(`setCommunicationDevice`, `OnCommunicationDeviceChangedListener`, `OnModeChangedListener`)
and a legacy SCO fallback, JUnit 4 + mockito-kotlin for unit tests, Gradle
(`:app:testDebugUnitTest`), React Native Turbo Module bridge (`com.oru.bridge`).

**Spec:** `docs/superpowers/specs/2026-08-18-seamless-headphone-audio-design.md` — this plan
implements §3, §4, §6, §7 (the Android wiring of it), §9, §10 (Android) and §11.

## Global Constraints

- **Scope is `android/` only.** No file under `src/`, `specs/`, `ios/` or `design/` may be
  created, edited or deleted by any task in this plan. The JS contract (`audioRoute`,
  `audioMode`, `setAudioMode`) is already merged and is consumed exactly as written in
  `specs/NativeRadio.ts`.
- **`android/app/src/main/java/com/oru/radio/ModePolicy.kt` and
  `android/app/src/test/java/com/oru/radio/ModePolicyTest.kt` are read-only.** They are the
  merged P1 contract and their Swift twin must stay a line-for-line mirror. If a task needs
  a change there, **stop and report it** — do not patch it locally. Everything this plan
  needs from the policy is already public: `ModePolicy.Profile`, `ModePolicy.AudioMode`,
  `ModePolicy.MicSource`, `ModePolicy.Action`, `ModePolicy.Decision`, `ModePolicy.Constants`
  and the input methods `setAudioMode`, `setOtherAudioActive`, `setRadioActive`,
  `setRouteRequiresVoiceLink`, `pttPressed`, `pttReleased`, `voiceLinkEstablished`,
  `voiceLinkFailed`, `tick`.
- **The five §7 timing constants are never re-declared.** Read them from
  `ModePolicy.Constants` (`OTHER_AUDIO_TO_MEDIA_MS` 2 000, `OTHER_AUDIO_TO_VOICE_MS` 30 000,
  `SWITCH_RATE_LIMIT_MS` 10 000, `VOICE_LINK_GRANT_TIMEOUT_MS` 4 000, `VOICE_LINK_LINGER_MS`
  15 000). This plan's own constants (debounce, attempt cap, establishment backstop) are
  declared in `AudioRouteController`.
- **No new Gradle or npm dependencies.** JUnit 4.13.2, mockito-core 5.18.0 and
  mockito-kotlin 5.4.0 are already on the test classpath; `testOptions.unitTests.returnDefaultValues
  = true` is already set.
- **Android framework values in unit tests:** `AudioDeviceInfo.TYPE_*`, `AudioManager.MODE_*`,
  `AudioManager.AUDIOFOCUS_*` and `AudioAttributes.USAGE_*` are `static final int` compile-time
  constants and inline into test bytecode, so tests may reference them. Framework *instances*
  (`AudioDeviceInfo`, `AudioManager`, `SharedPreferences`) may not be constructed in unit tests —
  which is exactly why `RouteDevice` and `AudioManagerFacade` exist.
- **The radio wire format stays 16 kHz mono Opus** (spec D7). No task changes
  `RadioConfig.SAMPLE_RATE_HZ`, `FRAME_MS` or `BITRATE_BPS`.
- **Out of scope (§2, §12):** Telecom / ConnectionService, an LE Audio fast path, a manual
  device picker, per-user disconnect settings. The hardware checklist is closeout, not a task.
- **Instrumentation (§10):** every applied route logs a timestamped line carrying the
  milliseconds since the device event that caused it, so switch latency is measured, not
  guessed.

### Task gate — every task's verification step runs this

Copied verbatim from the execution schedule
(`docs/superpowers/execution/2026-08-18-seamless-headphone-audio.md`):

> **Task gate:** pnpm typecheck && pnpm lint && pnpm test \<paths\> · when the task touched
> `android/`, plus `node scripts/build-android.js :app:testDebugUnitTest` and
> `pnpm build:android` · when the task touched `ios/`, plus `cd ios/Radio &&
> DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild test -scheme RadioKit
> -destination 'platform=iOS Simulator,name=iPhone 17'`

Every task in this plan touches `android/` and none touches `ios/` or any JavaScript, so
`<paths>` is empty (run the whole Jest suite — it must stay green) and the concrete command
for every task is:

```bash
pnpm typecheck && pnpm lint && pnpm test && \
node scripts/build-android.js :app:testDebugUnitTest && \
pnpm build:android
```

`scripts/build-android.js` takes exactly one Gradle task argument and passes no extra flags
through, so there is no per-class JUnit filter: `:app:testDebugUnitTest` runs the whole
Kotlin unit-test suite each time.

### Known flakes — copied verbatim from the schedule

1. First Gradle / NDK / CMake / dependency downloads are slow and can time out — a download
   failure or timeout is infrastructure, not a regression; re-run once before reporting.
2. `xcode-select` on this host points at CommandLineTools, so a *bare* `xcodebuild` fails with
   a tools error — that is environment, not a regression; every xcodebuild carries the
   `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer` prefix already baked into the
   gates above.
3. The `Oru` app scheme has no test action ("no test bundles available") — the RadioKit tests
   run **only** from `ios/Radio`'s own package workspace; the app build and the package tests
   are two separate commands, never one.
4. The simulator destination `iPhone 17` is the recorded-working one from the 2026-08-13 spike
   report; if xcodebuild reports the device missing, substitute any available iPhone simulator
   — device-list drift, not a regression.
5. The first xcodebuild in a fresh worktree resolves SPM packages (google/nearby,
   alta/swift-opus) — a slow first run or a transient network failure there is infrastructure;
   re-run once.
6. `pnpm lingui:extract` rewrites two stale source-line references in the `*.po` catalogs —
   harmless churn; commit it with whatever catalog change triggered it.

(Flakes 2–5 concern iOS legs that no task in this plan runs; they are reproduced because the
schedule lists them beside the gate.)

## File Structure

**Created**

| File | Responsibility |
|---|---|
| `android/app/src/main/java/com/oru/radio/AudioRouteTypes.kt` | `RouteDevice`, `AudioRoute`, `VoiceLinkState`, the wire mappings for `ModePolicy.Profile`/`AudioMode`, and the pure `RoutePicker` (priority, watch filter, HFP trust, kind/label, requires-voice-link). No Android instances, no I/O. |
| `android/app/src/main/java/com/oru/radio/AudioManagerFacade.kt` | The injected platform seam: `AudioManagerFacade`, `AudioFacadeListener`, `RouteLogger`. Interfaces only. |
| `android/app/src/main/java/com/oru/radio/AndroidAudioManagerFacade.kt` | The one Android implementation of the facade: `AudioManager`, the device callback, the noisy receiver, the SCO receiver, the comm-device and mode listeners, the HFP profile proxy, the playback callback, focus, the grant tone. Carries no decisions. |
| `android/app/src/main/java/com/oru/radio/AudioRouteController.kt` | The §6 state machine: one idempotent `reevaluate()`, profile apply, bounded retries, focus, and the `ModePolicy` wiring. |
| `android/app/src/main/java/com/oru/radio/AudioStreamGuard.kt` | Pure per-stream bookkeeping for §6 stream survival: rebuild-on-generation-change and the consecutive-error run. |
| `android/app/src/main/java/com/oru/radio/AudioModeStore.kt` | §8 `audioMode` persistence, `PttBindingStore`-shaped: interface + `SharedPreferencesAudioModeStore`. |
| `android/app/src/test/java/com/oru/radio/RoutePickerTest.kt` | Every pure classification decision. |
| `android/app/src/test/java/com/oru/radio/FakeAudioManagerFacade.kt` | The §10 fake `AudioManager` facade plus the recording route listener/logger and device fixtures shared by the four controller test files. |
| `android/app/src/test/java/com/oru/radio/AudioRouteControllerTest.kt` | Connect / disconnect / reconnect, debounce, noisy, watch filter, idempotence, latency instrumentation. |
| `android/app/src/test/java/com/oru/radio/AudioRouteControllerProfileTest.kt` | VOICE/MEDIA apply, the mode listener, audio-flows-while-establishing. |
| `android/app/src/test/java/com/oru/radio/AudioRouteControllerRecoveryTest.kt` | Bounded retries, establishment timeout + ground truth, re-assert, SCO theft, counter resets. |
| `android/app/src/test/java/com/oru/radio/AudioRouteControllerPolicyTest.kt` | Focus pairing, other-audio detection, the §7 transitions through the controller, the grant tone. |
| `android/app/src/test/java/com/oru/radio/AudioStreamGuardTest.kt` | The stream-survival bookkeeping. |

**Modified**

| File | Change |
|---|---|
| `android/app/src/main/java/com/oru/radio/RadioPorts.kt` | Adds `AudioRouting` + `AudioRouteListener`; `AudioIo` gains `onRouteChanged`. |
| `android/app/src/main/java/com/oru/radio/AudioEngine.kt` | Per-profile track/record attributes, rebuild on route change, `AudioStreamGuard`. |
| `android/app/src/main/java/com/oru/radio/RadioEngine.kt` | The `AudioRouting` port, capture gated on the grant, radio-active feed, route/mode in `RadioState`. |
| `android/app/src/main/java/com/oru/radio/RadioState.kt` | `audioRoute` + `audioMode` fields and their `toMap()` projection. |
| `android/app/src/main/java/com/oru/radio/RadioForegroundService.kt` | ~700 lines of routing deleted; constructs the controller, the facade and the route thread. |
| `android/app/src/main/java/com/oru/bridge/RadioBridgeCore.kt` | Placeholder constants deleted; real projection + stored-mode off-state. |
| `android/app/src/main/java/com/oru/bridge/NativeRadioModule.kt` | Real `setAudioMode`. |
| `android/app/src/test/java/com/oru/radio/TestDoubles.kt` | `FakeAudioRouting`; `FakeAudioIo.onRouteChanged`. |
| `android/app/src/test/java/com/oru/radio/RadioEngineTest.kt` | The routing port and the deferred-capture path. |
| `android/app/src/test/java/com/oru/radio/RadioStateTest.kt` | `toMap()` carries the route and mode. |
| `android/app/src/test/java/com/oru/bridge/RadioBridgeCoreTest.kt` | Real bridge mapping replaces the placeholder assertions. |

---

## Task 1: The route seam — vocabulary, pure picker, and the AudioManager facade

**Files:**
- Create: `android/app/src/main/java/com/oru/radio/AudioRouteTypes.kt`
- Create: `android/app/src/main/java/com/oru/radio/AudioManagerFacade.kt`
- Create: `android/app/src/main/java/com/oru/radio/AndroidAudioManagerFacade.kt`
- Test: `android/app/src/test/java/com/oru/radio/RoutePickerTest.kt`

**Interfaces:**
- Consumes: `ModePolicy.Profile`, `ModePolicy.AudioMode` (merged P1, read-only).
- Produces: `RouteDevice(id, type, address, productName, isSource, isSink)` with `val key: String`;
  `AudioRoute(kind, label, mode)` with `AudioRoute.Kind` (`SPEAKER`/`WIRED`/`BLUETOOTH`/`USB`,
  each with a `wire` string) and `fun toMap(): Map<String, Any?>`; `VoiceLinkState`;
  `fun ModePolicy.Profile.wire(): String`; `fun ModePolicy.AudioMode.wire(): String`;
  `fun audioModeFromWire(value: String?): ModePolicy.AudioMode`; the `RoutePicker` object with
  `isWatch`, `isTrustedBluetoothInput`, `inputCandidates`, `outputDevice`, `kindOf`, `labelOf`,
  `requiresVoiceLink`; `AudioManagerFacade`, `AudioFacadeListener`, `RouteLogger`;
  `AndroidAudioManagerFacade(context)`, `AndroidRouteLogger`.

- [ ] **Step 1: Write the failing test**

Create `android/app/src/test/java/com/oru/radio/RoutePickerTest.kt`:

```kotlin
package com.oru.radio

import android.media.AudioDeviceInfo
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Section 6 "Device selection and recovery", as pure functions. Everything the route
 * controller decides about a device list is decided here, so it is testable without an
 * android.media.AudioDeviceInfo (which has no public constructor).
 */
class RoutePickerTest {

    private fun device(
        id: Int,
        type: Int,
        address: String = "",
        productName: String = "device",
        isSource: Boolean = false,
        isSink: Boolean = false,
    ) = RouteDevice(id, type, address, productName, isSource, isSink)

    private val btMic = device(
        id = 7,
        type = AudioDeviceInfo.TYPE_BLUETOOTH_SCO,
        address = "AA:BB:CC:DD:EE:FF",
        productName = "Buds Pro",
        isSource = true,
        isSink = true,
    )
    private val btMedia = device(
        id = 8,
        type = AudioDeviceInfo.TYPE_BLUETOOTH_A2DP,
        address = "AA:BB:CC:DD:EE:FF",
        productName = "Buds Pro",
        isSink = true,
    )
    private val wiredHeadset = device(
        id = 3,
        type = AudioDeviceInfo.TYPE_WIRED_HEADSET,
        productName = "Wired headset",
        isSource = true,
        isSink = true,
    )
    private val usbHeadset = device(
        id = 4,
        type = AudioDeviceInfo.TYPE_USB_HEADSET,
        productName = "USB headset",
        isSource = true,
        isSink = true,
    )
    private val bleHeadset = device(
        id = 9,
        type = AudioDeviceInfo.TYPE_BLE_HEADSET,
        address = "11:22:33:44:55:66",
        productName = "LE buds",
        isSource = true,
        isSink = true,
    )
    private val speaker = device(id = 1, type = AudioDeviceInfo.TYPE_BUILTIN_SPEAKER, isSink = true)
    private val phoneMic = device(id = 2, type = AudioDeviceInfo.TYPE_BUILTIN_MIC, isSource = true)

    private val hfp = listOf("AA:BB:CC:DD:EE:FF")

    @Test
    fun `bluetooth wins over wired and usb, and le audio wins inside bluetooth`() {
        // Section 6: "BT SCO / BLE headset > wired headset > USB headset". This deliberately
        // reverses the pre-spec order, which preferred a plugged cable.
        val devices = listOf(speaker, phoneMic, usbHeadset, wiredHeadset, btMic, bleHeadset)

        val candidates = RoutePicker.inputCandidates(devices, hfp + "11:22:33:44:55:66")

        assertEquals(
            listOf(bleHeadset, btMic, wiredHeadset, usbHeadset),
            candidates,
        )
    }

    @Test
    fun `devices with no microphone are never candidates`() {
        assertEquals(emptyList<RouteDevice>(), RoutePicker.inputCandidates(listOf(speaker, btMedia), hfp))
    }

    @Test
    fun `a watch is filtered out of both candidates and outputs`() {
        val watch = device(
            id = 12,
            type = AudioDeviceInfo.TYPE_BLUETOOTH_SCO,
            address = "99:99:99:99:99:99",
            productName = "Galaxy Watch5",
            isSource = true,
            isSink = true,
        )

        assertTrue(RoutePicker.isWatch(watch))
        assertFalse(RoutePicker.isWatch(btMic))
        assertEquals(
            emptyList<RouteDevice>(),
            RoutePicker.inputCandidates(listOf(watch), listOf("99:99:99:99:99:99")),
        )
        assertNull(RoutePicker.outputDevice(listOf(speaker, watch)))
    }

    @Test
    fun `a bluetooth input is only trusted when the hfp stack has it connected`() {
        assertTrue(RoutePicker.isTrustedBluetoothInput(btMic, hfp))
        assertFalse(RoutePicker.isTrustedBluetoothInput(btMic, emptyList()))
        // Null means the profile proxy has not arrived: unverifiable, so untrusted.
        assertFalse(RoutePicker.isTrustedBluetoothInput(btMic, null))
        // Wired and USB inputs bypass the cross-validation entirely.
        assertTrue(RoutePicker.isTrustedBluetoothInput(wiredHeadset, null))
    }

    @Test
    fun `a zero-mac sco input stands in for a connected hfp headset`() {
        // ColorOS enumerates one SCO input named after the phone with a zeroed MAC; it is the
        // OEM's only representation of the headset when HFP really is connected, and a true
        // phantom when it is not (2026-08-17 hardware session).
        val zeroMac = btMic.copy(id = 21, address = "00:00:00:00:00:00", productName = "CPH2747")

        assertTrue(RoutePicker.isTrustedBluetoothInput(zeroMac, hfp))
        assertFalse(RoutePicker.isTrustedBluetoothInput(zeroMac, emptyList()))
        assertFalse(RoutePicker.isTrustedBluetoothInput(zeroMac.copy(address = ""), null))
    }

    @Test
    fun `the output device is the highest priority external sink`() {
        assertEquals(btMedia, RoutePicker.outputDevice(listOf(speaker, btMedia, wiredHeadset)))
        assertEquals(wiredHeadset, RoutePicker.outputDevice(listOf(speaker, wiredHeadset)))
        assertNull(RoutePicker.outputDevice(listOf(speaker, phoneMic)))
    }

    @Test
    fun `route kinds and labels follow section 8`() {
        assertEquals(AudioRoute.Kind.BLUETOOTH, RoutePicker.kindOf(btMedia))
        assertEquals(AudioRoute.Kind.BLUETOOTH, RoutePicker.kindOf(bleHeadset))
        assertEquals(AudioRoute.Kind.WIRED, RoutePicker.kindOf(wiredHeadset))
        assertEquals(AudioRoute.Kind.USB, RoutePicker.kindOf(usbHeadset))
        assertEquals(AudioRoute.Kind.SPEAKER, RoutePicker.kindOf(null))
        assertEquals(AudioRoute.Kind.SPEAKER, RoutePicker.kindOf(speaker))

        assertEquals("Buds Pro", RoutePicker.labelOf(btMedia))
        // Only bluetooth routes carry a label, and a nameless one carries none at all.
        assertNull(RoutePicker.labelOf(wiredHeadset))
        assertNull(RoutePicker.labelOf(btMedia.copy(productName = "  ")))
        assertNull(RoutePicker.labelOf(null))
    }

    @Test
    fun `only bluetooth classic needs a voice link raised`() {
        // Section 7: the policy is inert on speaker, wired, USB and LE Audio.
        assertTrue(RoutePicker.requiresVoiceLink(btMic))
        assertFalse(RoutePicker.requiresVoiceLink(bleHeadset))
        assertFalse(RoutePicker.requiresVoiceLink(wiredHeadset))
        assertFalse(RoutePicker.requiresVoiceLink(usbHeadset))
        assertFalse(RoutePicker.requiresVoiceLink(null))
    }

    @Test
    fun `the wire mappings match the section 8 contract`() {
        assertEquals("voice", ModePolicy.Profile.VOICE.wire())
        assertEquals("media", ModePolicy.Profile.MEDIA.wire())
        assertEquals("auto", ModePolicy.AudioMode.AUTO.wire())
        assertEquals("voice", ModePolicy.AudioMode.VOICE.wire())
        assertEquals("media", ModePolicy.AudioMode.MEDIA.wire())

        assertEquals(ModePolicy.AudioMode.VOICE, audioModeFromWire("voice"))
        assertEquals(ModePolicy.AudioMode.MEDIA, audioModeFromWire("media"))
        assertEquals(ModePolicy.AudioMode.AUTO, audioModeFromWire("auto"))
        // An unknown or absent value is the default, never a crash.
        assertEquals(ModePolicy.AudioMode.AUTO, audioModeFromWire(null))
        assertEquals(ModePolicy.AudioMode.AUTO, audioModeFromWire("nonsense"))
    }

    @Test
    fun `an audio route projects the section 8 shape and omits an absent label`() {
        val bluetooth = AudioRoute(AudioRoute.Kind.BLUETOOTH, "Buds Pro", ModePolicy.Profile.MEDIA)
        assertEquals(
            mapOf("kind" to "bluetooth", "label" to "Buds Pro", "mode" to "media"),
            bluetooth.toMap(),
        )
        assertEquals(
            mapOf("kind" to "speaker", "mode" to "voice"),
            AudioRoute().toMap(),
        )
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node scripts/build-android.js :app:testDebugUnitTest`
Expected: FAIL — compilation errors, `Unresolved reference: RouteDevice` / `RoutePicker` /
`AudioRoute` / `wire` / `audioModeFromWire`.

- [ ] **Step 3: Write the vocabulary and the picker**

Create `android/app/src/main/java/com/oru/radio/AudioRouteTypes.kt`:

```kotlin
package com.oru.radio

import android.media.AudioDeviceInfo

/**
 * One audio device as the route controller sees it.
 *
 * `android.media.AudioDeviceInfo` has no public constructor and is a framework stub on the
 * unit-test classpath, so nothing above [AudioManagerFacade] ever touches one: the facade
 * maps them into this value type on the way in, and every §6 decision is made against it.
 *
 * A Bluetooth Classic headset surfaces as two devices — a `TYPE_BLUETOOTH_SCO` entry that is
 * both source and sink, and a `TYPE_BLUETOOTH_A2DP` sink — with the same address.
 */
data class RouteDevice(
    val id: Int,
    /** One of `AudioDeviceInfo.TYPE_*`. */
    val type: Int,
    /** The hardware address, or "" below API 28 and for devices that report none. */
    val address: String,
    val productName: String,
    val isSource: Boolean,
    val isSink: Boolean,
) {
    /**
     * Stable identity for the per-episode attempt counters of §6. Type plus address, so a
     * headset that reconnects with a new `id` is still recognised as the same device.
     */
    val key: String get() = "$type|$address"
}

/** The SCO / communication-device link state, as §6 recovery reasons about it. */
enum class VoiceLinkState { CONNECTING, CONNECTED, DISCONNECTED, ERROR }

/**
 * Spec §8's `audioRoute`, as the engine publishes it. `mode` is the *effective* profile the
 * radio is running — never the user's `audioMode` pin.
 */
data class AudioRoute(
    val kind: Kind = Kind.SPEAKER,
    /** Bluetooth routes only; absent rather than empty when the device reports no name. */
    val label: String? = null,
    val mode: ModePolicy.Profile = ModePolicy.Profile.VOICE,
) {
    enum class Kind(val wire: String) {
        SPEAKER("speaker"),
        WIRED("wired"),
        BLUETOOTH("bluetooth"),
        USB("usb"),
    }

    /**
     * §8 makes `label` optional, not nullable, so an absent label is an absent key — the
     * same rule `pttButton.name` follows on this bridge.
     */
    fun toMap(): Map<String, Any?> = buildMap {
        put("kind", kind.wire)
        label?.let { put("label", it) }
        put("mode", mode.wire())
    }
}

/**
 * The §8 wire spellings of the two merged-P1 enums.
 *
 * They are extensions here rather than properties on `ModePolicy` because `ModePolicy.kt` is
 * the shared contract with iOS and this plan may not edit it: a wire spelling is Android
 * bridge business, not policy business.
 */
fun ModePolicy.Profile.wire(): String = when (this) {
    ModePolicy.Profile.VOICE -> "voice"
    ModePolicy.Profile.MEDIA -> "media"
}

fun ModePolicy.AudioMode.wire(): String = when (this) {
    ModePolicy.AudioMode.AUTO -> "auto"
    ModePolicy.AudioMode.VOICE -> "voice"
    ModePolicy.AudioMode.MEDIA -> "media"
}

/** Anything unrecognised — including a missing stored value — is §8's `auto` default. */
fun audioModeFromWire(value: String?): ModePolicy.AudioMode = when (value) {
    "voice" -> ModePolicy.AudioMode.VOICE
    "media" -> ModePolicy.AudioMode.MEDIA
    else -> ModePolicy.AudioMode.AUTO
}

/**
 * Every §6 device decision, as pure functions over a [RouteDevice] list.
 */
object RoutePicker {

    /**
     * §6: "devices whose `productName` contains ` Watch` are filtered out (Galaxy Watch
     * hijack)". The leading space is deliberate — it is what keeps a "Watchtower" speaker
     * out of the filter.
     */
    const val WATCH_MARKER = " Watch"

    fun isWatch(device: RouteDevice): Boolean = device.productName.contains(WATCH_MARKER)

    /**
     * §6 priority, input-capable: BT SCO / BLE headset > wired headset > USB headset. LE
     * Audio ranks above BT Classic inside the Bluetooth class because it carries a mic
     * without suspending media (§4).
     */
    private fun inputPreference(type: Int): Int = when (type) {
        AudioDeviceInfo.TYPE_BLE_HEADSET -> 4
        AudioDeviceInfo.TYPE_BLUETOOTH_SCO -> 3
        AudioDeviceInfo.TYPE_WIRED_HEADSET -> 2
        AudioDeviceInfo.TYPE_USB_HEADSET -> 1
        else -> -1
    }

    /** Output-capable externals, most preferred first. Everything else is the loudspeaker. */
    private fun outputPreference(type: Int): Int = when (type) {
        AudioDeviceInfo.TYPE_BLE_HEADSET,
        AudioDeviceInfo.TYPE_BLE_SPEAKER,
        AudioDeviceInfo.TYPE_BLE_BROADCAST,
        -> 5
        AudioDeviceInfo.TYPE_BLUETOOTH_A2DP,
        AudioDeviceInfo.TYPE_BLUETOOTH_SCO,
        -> 4
        AudioDeviceInfo.TYPE_WIRED_HEADSET,
        AudioDeviceInfo.TYPE_WIRED_HEADPHONES,
        -> 3
        AudioDeviceInfo.TYPE_USB_HEADSET,
        AudioDeviceInfo.TYPE_USB_DEVICE,
        AudioDeviceInfo.TYPE_USB_ACCESSORY,
        -> 2
        AudioDeviceInfo.TYPE_HEARING_AID -> 1
        else -> -1
    }

    /**
     * Cross-validation against the Bluetooth stack (§11 keeps it): a Bluetooth input is only
     * trusted as a mic when the HFP proxy actually has a device connected.
     *
     * [hfpAddresses] is null while the async profile proxy has not arrived — unverifiable,
     * therefore untrusted. Wired and USB inputs bypass the check.
     */
    fun isTrustedBluetoothInput(device: RouteDevice, hfpAddresses: List<String>?): Boolean {
        val bluetooth = device.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO ||
            device.type == AudioDeviceInfo.TYPE_BLE_HEADSET
        if (!bluetooth) return true
        val connected = hfpAddresses ?: return false
        val address = device.address
        val zeroMac = address.isBlank() || address == "00:00:00:00:00:00"
        if (zeroMac) {
            // ColorOS's single zero-MAC SCO input is the OEM's only representation of a
            // connected headset, and a true phantom (total silence) when none is connected.
            return device.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO && connected.isNotEmpty()
        }
        return connected.any { it.equals(address, ignoreCase = true) }
    }

    /** The input-capable externals worth trying, most preferred first. */
    fun inputCandidates(
        devices: List<RouteDevice>,
        hfpAddresses: List<String>?,
    ): List<RouteDevice> = devices
        .filter { it.isSource && inputPreference(it.type) >= 0 }
        .filterNot(::isWatch)
        .filter { isTrustedBluetoothInput(it, hfpAddresses) }
        .sortedByDescending { inputPreference(it.type) }

    /** The external sink playback lands on, or null for the loudspeaker. */
    fun outputDevice(devices: List<RouteDevice>): RouteDevice? = devices
        .filter { it.isSink && outputPreference(it.type) >= 0 }
        .filterNot(::isWatch)
        .maxByOrNull { outputPreference(it.type) }

    fun kindOf(device: RouteDevice?): AudioRoute.Kind = when (device?.type) {
        AudioDeviceInfo.TYPE_BLUETOOTH_SCO,
        AudioDeviceInfo.TYPE_BLUETOOTH_A2DP,
        AudioDeviceInfo.TYPE_BLE_HEADSET,
        AudioDeviceInfo.TYPE_BLE_SPEAKER,
        AudioDeviceInfo.TYPE_BLE_BROADCAST,
        AudioDeviceInfo.TYPE_HEARING_AID,
        -> AudioRoute.Kind.BLUETOOTH
        AudioDeviceInfo.TYPE_WIRED_HEADSET,
        AudioDeviceInfo.TYPE_WIRED_HEADPHONES,
        -> AudioRoute.Kind.WIRED
        AudioDeviceInfo.TYPE_USB_HEADSET,
        AudioDeviceInfo.TYPE_USB_DEVICE,
        AudioDeviceInfo.TYPE_USB_ACCESSORY,
        -> AudioRoute.Kind.USB
        else -> AudioRoute.Kind.SPEAKER
    }

    fun labelOf(device: RouteDevice?): String? {
        if (device == null || kindOf(device) != AudioRoute.Kind.BLUETOOTH) return null
        return device.productName.trim().ifBlank { null }
    }

    /**
     * §7: only Bluetooth Classic has the HFP/A2DP conflict. Speaker, wired, USB and LE Audio
     * need no raise, and the mode policy is inert on them.
     */
    fun requiresVoiceLink(device: RouteDevice?): Boolean =
        device?.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO
}
```

- [ ] **Step 4: Write the facade interfaces**

Create `android/app/src/main/java/com/oru/radio/AudioManagerFacade.kt`:

```kotlin
package com.oru.radio

/**
 * The whole platform surface [AudioRouteController] is allowed to touch (§6: "`AudioManager`
 * is accessed through an injected facade so the controller is unit-testable").
 *
 * Implementations carry no decisions: every method is a direct platform call or a direct
 * enumeration. The decisions live in [RoutePicker] and [AudioRouteController].
 *
 * Threading: every method is called from the controller's `audio-route` thread. Callbacks
 * may arrive on any thread — the controller re-posts them.
 */
interface AudioManagerFacade {

    /** Registers every platform listener of §6. Idempotent. */
    fun start(listener: AudioFacadeListener)

    /** Unregisters everything [start] registered and releases the grant tone. Idempotent. */
    fun stop()

    /** Inputs and outputs, deduplicated by device id. */
    fun devices(): List<RouteDevice>

    /** `AudioManager.getAvailableCommunicationDevices()`, empty below API 31. */
    fun availableCommunicationDevices(): List<RouteDevice>

    /** `AudioManager.getCommunicationDevice()`, null below API 31. */
    fun currentCommunicationDevice(): RouteDevice?

    /**
     * Addresses the Bluetooth stack reports connected on HFP, or null while the async
     * profile proxy has not arrived (§11 keeps this cross-validation).
     */
    fun connectedHfpAddresses(): List<String>?

    fun mode(): Int

    fun setMode(mode: Int)

    /** True when the platform accepted the selection — not that the route was built. */
    fun setCommunicationDevice(device: RouteDevice): Boolean

    fun clearCommunicationDevice()

    /**
     * Legacy SCO establishment (`startBluetoothSco` + `setBluetoothScoOn(true)`), run
     * alongside [setCommunicationDevice] on Bluetooth Classic targets: on stacks with
     * `scoManagedByAudio=false` the selection alone never raises the link.
     */
    fun startVoiceLink(device: RouteDevice)

    /** Idempotent legacy SCO teardown. */
    fun stopVoiceLink()

    /**
     * §6's ground truth, re-checked before a timeout is declared: is SCO audio actually
     * connected to [device]? Implemented against `BluetoothHeadset.isAudioConnected`, with
     * `AudioManager.isBluetoothScoOn` as the fallback.
     */
    fun isVoiceLinkConnected(device: RouteDevice): Boolean

    /** §6/D6: `AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK`. True when granted. */
    fun requestTransientDuckFocus(): Boolean

    fun abandonFocus()

    /** `AudioManager.isMusicActive()`, used only to seed other-audio state at start. */
    fun isMusicActive(): Boolean

    /** D2's talk-permit tone, played on [profile]'s path. */
    fun playGrantTone(profile: ModePolicy.Profile)
}

/**
 * Platform events, as §6 names them. Every method may be called from any thread.
 */
interface AudioFacadeListener {
    /**
     * One device-list change. `added` drives the ~500 ms debounce of §6 (the list flaps
     * during BT profile negotiation); `removed` is always handled immediately.
     */
    fun onDevicesChanged(added: List<RouteDevice>, removed: List<RouteDevice>)

    /** `ACTION_AUDIO_BECOMING_NOISY`: the §6 fast path to the loudspeaker. */
    fun onBecomingNoisy()

    /** `OnCommunicationDeviceChangedListener`: the platform's own view of our selection. */
    fun onCommunicationDeviceChanged(device: RouteDevice?)

    /** `OnModeChangedListener` — §6 replaces the 3 × 100 ms mode polling with this. */
    fun onModeChanged(mode: Int)

    /** `ACTION_SCO_AUDIO_STATE_UPDATED`, mapped onto [VoiceLinkState]. */
    fun onVoiceLinkStateChanged(state: VoiceLinkState)

    /** §6 other-audio detection, already filtered to media usages that are not ours. */
    fun onOtherAudioActiveChanged(active: Boolean)
}

/**
 * Where the §10 instrumentation lines go. A seam rather than a direct `Log` call so a test
 * can assert that a switch carries its measured latency.
 */
fun interface RouteLogger {
    fun log(line: String)
}
```

- [ ] **Step 5: Write the Android facade implementation**

This file is the one place with no unit test: it holds no decisions, only platform calls, and
the §10 hardware checklist is what exercises it. Everything it decides — which device wins,
when to retry, which profile to hold — lives in `RoutePicker` and `AudioRouteController`,
both of which are unit-tested. Create
`android/app/src/main/java/com/oru/radio/AndroidAudioManagerFacade.kt`:

```kotlin
package com.oru.radio

import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothHeadset
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.media.AudioAttributes
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.AudioPlaybackConfiguration
import android.media.ToneGenerator
import android.os.Build
import android.os.Handler
import android.util.Log

/** The `RouteLogger` used in production: one tagged logcat line per event. */
class AndroidRouteLogger : RouteLogger {
    override fun log(line: String) {
        Log.i("OruRadio", line)
    }
}

/**
 * The one Android implementation of [AudioManagerFacade].
 *
 * [handler] is the route thread's handler: every platform listener that accepts an executor
 * or handler is registered against it, so callbacks arrive on the same thread the controller
 * runs on and the controller's own re-post is a no-op hop rather than a thread switch.
 */
class AndroidAudioManagerFacade(
    context: Context,
    private val handler: Handler,
) : AudioManagerFacade {

    private companion object {
        const val TAG = "OruRadio"
        const val TONE_MS = 150
        const val TONE_RELEASE_DELAY_MS = 400L
        const val TONE_VOLUME = 80
    }

    private val appContext = context.applicationContext
    private val audioManager = appContext.getSystemService(AudioManager::class.java)

    private var listener: AudioFacadeListener? = null
    private var focusRequest: AudioFocusRequest? = null

    private var bluetoothAdapter: BluetoothAdapter? = null
    private var headsetProxy: BluetoothProfile? = null

    private var deviceCallback: AudioDeviceCallback? = null
    private var noisyReceiver: BroadcastReceiver? = null
    private var scoReceiver: BroadcastReceiver? = null
    private var commDeviceListener: AudioManager.OnCommunicationDeviceChangedListener? = null
    private var modeListener: AudioManager.OnModeChangedListener? = null
    private var playbackCallback: AudioManager.AudioPlaybackCallback? = null
    private var otherAudioActive = false

    private val headsetProfileListener = object : BluetoothProfile.ServiceListener {
        override fun onServiceConnected(profile: Int, proxy: BluetoothProfile) {
            if (profile != BluetoothProfile.HEADSET) return
            headsetProxy = proxy
            // A mic that was skipped as unverifiable may now pass cross-validation.
            listener?.onDevicesChanged(emptyList(), emptyList())
        }

        override fun onServiceDisconnected(profile: Int) {
            if (profile != BluetoothProfile.HEADSET) return
            headsetProxy = null
            listener?.onDevicesChanged(emptyList(), emptyList())
        }
    }

    override fun start(listener: AudioFacadeListener) {
        if (this.listener != null) return
        this.listener = listener
        val manager = audioManager ?: return

        requestHeadsetProxy()

        val devices = object : AudioDeviceCallback() {
            override fun onAudioDevicesAdded(addedDevices: Array<out AudioDeviceInfo>) {
                listener.onDevicesChanged(addedDevices.map(::toRouteDevice), emptyList())
            }

            override fun onAudioDevicesRemoved(removedDevices: Array<out AudioDeviceInfo>) {
                listener.onDevicesChanged(emptyList(), removedDevices.map(::toRouteDevice))
            }
        }
        deviceCallback = devices
        manager.registerAudioDeviceCallback(devices, handler)

        noisyReceiver = register(AudioManager.ACTION_AUDIO_BECOMING_NOISY) {
            listener.onBecomingNoisy()
        }
        @Suppress("DEPRECATION")
        scoReceiver = register(AudioManager.ACTION_SCO_AUDIO_STATE_UPDATED) { intent ->
            listener.onVoiceLinkStateChanged(
                when (
                    intent.getIntExtra(
                        AudioManager.EXTRA_SCO_AUDIO_STATE,
                        AudioManager.SCO_AUDIO_STATE_ERROR,
                    )
                ) {
                    AudioManager.SCO_AUDIO_STATE_CONNECTED -> VoiceLinkState.CONNECTED
                    AudioManager.SCO_AUDIO_STATE_CONNECTING -> VoiceLinkState.CONNECTING
                    AudioManager.SCO_AUDIO_STATE_DISCONNECTED -> VoiceLinkState.DISCONNECTED
                    else -> VoiceLinkState.ERROR
                },
            )
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            val comm = AudioManager.OnCommunicationDeviceChangedListener { device ->
                listener.onCommunicationDeviceChanged(device?.let(::toRouteDevice))
            }
            commDeviceListener = comm
            manager.addOnCommunicationDeviceChangedListener(handler::post, comm)

            val mode = AudioManager.OnModeChangedListener { value -> listener.onModeChanged(value) }
            modeListener = mode
            manager.addOnModeChangedListener(handler::post, mode)
        }

        val playback = object : AudioManager.AudioPlaybackCallback() {
            override fun onPlaybackConfigChanged(configs: MutableList<AudioPlaybackConfiguration>) {
                publishOtherAudio(configs.any(::isForeignMedia))
            }
        }
        playbackCallback = playback
        manager.registerAudioPlaybackCallback(playback, handler)
        // Seeded once, before the radio plays anything of its own: after this the callback is
        // the only source of truth, because our own MEDIA-profile track counts as music to
        // isMusicActive() and would latch MEDIA forever.
        publishOtherAudio(manager.isMusicActive)
    }

    override fun stop() {
        val manager = audioManager
        listener = null
        deviceCallback?.let { manager?.unregisterAudioDeviceCallback(it) }
        deviceCallback = null
        noisyReceiver?.let(appContext::unregisterReceiver)
        noisyReceiver = null
        scoReceiver?.let(appContext::unregisterReceiver)
        scoReceiver = null
        playbackCallback?.let { manager?.unregisterAudioPlaybackCallback(it) }
        playbackCallback = null
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            commDeviceListener?.let { manager?.removeOnCommunicationDeviceChangedListener(it) }
            modeListener?.let { manager?.removeOnModeChangedListener(it) }
        }
        commDeviceListener = null
        modeListener = null
        headsetProxy?.let { proxy ->
            bluetoothAdapter?.closeProfileProxy(BluetoothProfile.HEADSET, proxy)
        }
        headsetProxy = null
        bluetoothAdapter = null
        otherAudioActive = false
    }

    override fun devices(): List<RouteDevice> {
        val manager = audioManager ?: return emptyList()
        return (
            manager.getDevices(AudioManager.GET_DEVICES_INPUTS).toList() +
                manager.getDevices(AudioManager.GET_DEVICES_OUTPUTS).toList()
            )
            .distinctBy { it.id }
            .map(::toRouteDevice)
    }

    override fun availableCommunicationDevices(): List<RouteDevice> {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return emptyList()
        return audioManager?.availableCommunicationDevices.orEmpty().map(::toRouteDevice)
    }

    override fun currentCommunicationDevice(): RouteDevice? {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return null
        return audioManager?.communicationDevice?.let(::toRouteDevice)
    }

    override fun connectedHfpAddresses(): List<String>? {
        val proxy = headsetProxy ?: return null
        return try {
            proxy.connectedDevices.map { it.address }
        } catch (error: SecurityException) {
            Log.w(TAG, "route: BLUETOOTH_CONNECT denied; cannot enumerate HFP devices", error)
            emptyList()
        }
    }

    override fun mode(): Int = audioManager?.mode ?: AudioManager.MODE_NORMAL

    override fun setMode(mode: Int) {
        audioManager?.mode = mode
    }

    override fun setCommunicationDevice(device: RouteDevice): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return false
        val manager = audioManager ?: return false
        // setCommunicationDevice only accepts objects from this list, and the input-side
        // AudioDeviceInfo is a different object with the same address.
        val target = manager.availableCommunicationDevices.firstOrNull { it.id == device.id }
            ?: manager.availableCommunicationDevices.firstOrNull {
                it.address == device.address && it.type == device.type
            }
            ?: manager.availableCommunicationDevices.firstOrNull { it.type == device.type }
            ?: return false
        return manager.setCommunicationDevice(target)
    }

    override fun clearCommunicationDevice() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return
        audioManager?.clearCommunicationDevice()
    }

    @Suppress("DEPRECATION")
    override fun startVoiceLink(device: RouteDevice) {
        val manager = audioManager ?: return
        manager.startBluetoothSco()
        manager.isBluetoothScoOn = true
    }

    @Suppress("DEPRECATION")
    override fun stopVoiceLink() {
        val manager = audioManager ?: return
        manager.isBluetoothScoOn = false
        manager.stopBluetoothSco()
    }

    @Suppress("DEPRECATION")
    override fun isVoiceLinkConnected(device: RouteDevice): Boolean {
        val proxy = headsetProxy as? BluetoothHeadset
        if (proxy != null) {
            val match = try {
                proxy.connectedDevices.firstOrNull { it.address.equals(device.address, true) }
            } catch (error: SecurityException) {
                null
            }
            if (match != null) {
                return try {
                    proxy.isAudioConnected(match)
                } catch (error: SecurityException) {
                    audioManager?.isBluetoothScoOn == true
                }
            }
        }
        return audioManager?.isBluetoothScoOn == true
    }

    override fun requestTransientDuckFocus(): Boolean {
        val manager = audioManager ?: return false
        if (focusRequest != null) return true
        val request = AudioFocusRequest
            .Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build(),
            )
            .setOnAudioFocusChangeListener({ change ->
                Log.v(TAG, "route: audio focus changed -> $change")
            }, handler)
            .build()
        val granted = manager.requestAudioFocus(request) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
        if (granted) focusRequest = request
        return granted
    }

    override fun abandonFocus() {
        val manager = audioManager ?: return
        focusRequest?.let(manager::abandonAudioFocusRequest)
        focusRequest = null
    }

    override fun isMusicActive(): Boolean = audioManager?.isMusicActive == true

    @Suppress("DEPRECATION")
    override fun playGrantTone(profile: ModePolicy.Profile) {
        val stream = when (profile) {
            ModePolicy.Profile.VOICE -> AudioManager.STREAM_VOICE_CALL
            ModePolicy.Profile.MEDIA -> AudioManager.STREAM_MUSIC
        }
        val generator = try {
            ToneGenerator(stream, TONE_VOLUME)
        } catch (error: RuntimeException) {
            Log.w(TAG, "route: no tone generator", error)
            return
        }
        generator.startTone(ToneGenerator.TONE_PROP_BEEP, TONE_MS)
        handler.postDelayed({ generator.release() }, TONE_RELEASE_DELAY_MS)
    }

    // --- internals -----------------------------------------------------------------------

    private fun publishOtherAudio(active: Boolean) {
        if (active == otherAudioActive) return
        otherAudioActive = active
        listener?.onOtherAudioActiveChanged(active)
    }

    /**
     * §6: "filtering out our own player and non-media usages". Our own two players use
     * `USAGE_VOICE_COMMUNICATION` (VOICE) and `USAGE_ASSISTANCE_NAVIGATION_GUIDANCE` (MEDIA),
     * so counting only genuine media usages excludes them without a uid check — which is not
     * public API.
     */
    private fun isForeignMedia(config: AudioPlaybackConfiguration): Boolean =
        when (config.audioAttributes.usage) {
            AudioAttributes.USAGE_MEDIA,
            AudioAttributes.USAGE_GAME,
            AudioAttributes.USAGE_UNKNOWN,
            -> true
            else -> false
        }

    private fun register(action: String, onReceive: (Intent) -> Unit): BroadcastReceiver {
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context, intent: Intent) {
                if (intent.action == action) onReceive(intent)
            }
        }
        val filter = IntentFilter(action)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            appContext.registerReceiver(receiver, filter, null, handler, Context.RECEIVER_NOT_EXPORTED)
        } else {
            appContext.registerReceiver(receiver, filter, null, handler)
        }
        return receiver
    }

    private fun requestHeadsetProxy() {
        val adapter = appContext.getSystemService(BluetoothManager::class.java)?.adapter
        bluetoothAdapter = adapter ?: return
        try {
            adapter.getProfileProxy(appContext, headsetProfileListener, BluetoothProfile.HEADSET)
        } catch (error: SecurityException) {
            Log.w(TAG, "route: HFP profile proxy refused", error)
        }
    }

    private fun toRouteDevice(device: AudioDeviceInfo): RouteDevice = RouteDevice(
        id = device.id,
        type = device.type,
        address = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) device.address else "",
        productName = device.productName?.toString().orEmpty(),
        isSource = device.isSource,
        isSink = device.isSink,
    )
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node scripts/build-android.js :app:testDebugUnitTest`
Expected: PASS — all nine `RoutePickerTest` cases green, the rest of the suite unchanged.

- [ ] **Step 7: Run the task gate**

```bash
pnpm typecheck && pnpm lint && pnpm test && \
node scripts/build-android.js :app:testDebugUnitTest && \
pnpm build:android
```

Expected: all five commands exit 0. (See "Known flakes": a first-run Gradle/NDK download
timeout is infrastructure — re-run once before reporting.)

- [ ] **Step 8: Commit**

```bash
git add android/app/src/main/java/com/oru/radio/AudioRouteTypes.kt \
        android/app/src/main/java/com/oru/radio/AudioManagerFacade.kt \
        android/app/src/main/java/com/oru/radio/AndroidAudioManagerFacade.kt \
        android/app/src/test/java/com/oru/radio/RoutePickerTest.kt
git commit -m "feat(android): route vocabulary, pure picker and the AudioManager facade"
```

---

## Task 2: `AudioRouteController` core — one idempotent `reevaluate()`

**Files:**
- Create: `android/app/src/main/java/com/oru/radio/AudioRouteController.kt`
- Create: `android/app/src/test/java/com/oru/radio/FakeAudioManagerFacade.kt`
- Create: `android/app/src/test/java/com/oru/radio/AudioRouteControllerTest.kt`
- Modify: `android/app/src/main/java/com/oru/radio/RadioPorts.kt`

**Interfaces:**
- Consumes: `AudioManagerFacade`, `AudioFacadeListener`, `RouteLogger`, `RoutePicker`,
  `RouteDevice`, `AudioRoute` (Task 1); `Scheduler` and `Cancellable` (existing
  `RadioPorts.kt`); `ModePolicy` (merged P1).
- Produces: `interface AudioRouteListener { fun onAudioRouteChanged(route: AudioRoute); fun
  onCaptureGranted(mic: ModePolicy.MicSource) }` in `RadioPorts.kt`;
  `class AudioRouteController(facade, scheduler, clock: () -> Long, policy: ModePolicy,
  logger: RouteLogger) : AudioFacadeListener` with `fun start(listener: AudioRouteListener)`
  and `fun stop()`, and the constants `DEVICE_ADD_DEBOUNCE_MS = 500L`,
  `NOISY_GUARD_MS = 750L`, `MAX_ESTABLISH_ATTEMPTS = 2`, `ESTABLISH_TIMEOUT_MS = 6_000L`,
  `MODE_SETTLE_TIMEOUT_MS = 500L`; the test doubles `FakeAudioManagerFacade`,
  `RecordingRouteListener`, `RecordingRouteLogger` and the `TestDevices` fixtures.

- [ ] **Step 1: Write the shared test doubles**

Create `android/app/src/test/java/com/oru/radio/FakeAudioManagerFacade.kt`. This is the §10
"fake `AudioManager` facade" every controller test runs against; it is written whole here so
later tasks extend behaviour, not the file's shape.

```kotlin
package com.oru.radio

import android.media.AudioDeviceInfo
import android.media.AudioManager

/**
 * The §10 fake `AudioManager` facade: an in-memory platform whose every observable is a
 * public field, so a test states the world and then asserts the calls the controller made.
 */
class FakeAudioManagerFacade : AudioManagerFacade {

    var listener: AudioFacadeListener? = null
    var started = false
    var stopped = false

    /** The world. Mutate through [connect] / [disconnect] so the callback fires too. */
    val devices = mutableListOf<RouteDevice>()

    var hfpAddresses: List<String>? = emptyList()

    var mode: Int = AudioManager.MODE_NORMAL
    val modeSets = mutableListOf<Int>()

    /** False for the OEM stacks whose `setMode` silently does not take effect. */
    var modeFollowsSet = true

    var communicationDevice: RouteDevice? = null
    var acceptsCommunicationDevice = true

    /** When false, an accepted selection is not echoed back through the listener. */
    var confirmsCommunicationDevice = true

    val communicationDeviceSelections = mutableListOf<RouteDevice>()
    var communicationDeviceClears = 0

    val voiceLinkStarts = mutableListOf<RouteDevice>()
    var voiceLinkStops = 0

    /** Ground truth for [isVoiceLinkConnected] — deliberately independent of the callbacks. */
    var voiceLinkConnected = false

    var focusGranted = true
    var focusRequests = 0
    var focusAbandons = 0

    var musicActive = false
    val grantTones = mutableListOf<ModePolicy.Profile>()

    override fun start(listener: AudioFacadeListener) {
        this.listener = listener
        started = true
    }

    override fun stop() {
        listener = null
        stopped = true
    }

    override fun devices(): List<RouteDevice> = devices.toList()

    override fun availableCommunicationDevices(): List<RouteDevice> =
        devices.filter { it.isSink || it.isSource }

    override fun currentCommunicationDevice(): RouteDevice? = communicationDevice

    override fun connectedHfpAddresses(): List<String>? = hfpAddresses

    override fun mode(): Int = mode

    override fun setMode(mode: Int) {
        modeSets.add(mode)
        if (!modeFollowsSet) return
        this.mode = mode
        listener?.onModeChanged(mode)
    }

    override fun setCommunicationDevice(device: RouteDevice): Boolean {
        communicationDeviceSelections.add(device)
        if (!acceptsCommunicationDevice) return false
        communicationDevice = device
        if (confirmsCommunicationDevice) listener?.onCommunicationDeviceChanged(device)
        return true
    }

    override fun clearCommunicationDevice() {
        communicationDeviceClears++
        communicationDevice = null
    }

    override fun startVoiceLink(device: RouteDevice) {
        voiceLinkStarts.add(device)
    }

    override fun stopVoiceLink() {
        voiceLinkStops++
        voiceLinkConnected = false
    }

    override fun isVoiceLinkConnected(device: RouteDevice): Boolean = voiceLinkConnected

    override fun requestTransientDuckFocus(): Boolean {
        focusRequests++
        return focusGranted
    }

    override fun abandonFocus() {
        focusAbandons++
    }

    override fun isMusicActive(): Boolean = musicActive

    override fun playGrantTone(profile: ModePolicy.Profile) {
        grantTones.add(profile)
    }

    // --- world manipulation ---------------------------------------------------------------

    fun connect(vararg added: RouteDevice) {
        devices.addAll(added)
        listener?.onDevicesChanged(added.toList(), emptyList())
    }

    fun disconnect(vararg removed: RouteDevice) {
        devices.removeAll(removed.toSet())
        if (removed.any { it.id == communicationDevice?.id }) communicationDevice = null
        listener?.onDevicesChanged(emptyList(), removed.toList())
    }

    /** The platform's own view changed — a clear, a replacement, or our own confirmation. */
    fun platformCommunicationDevice(device: RouteDevice?) {
        communicationDevice = device
        listener?.onCommunicationDeviceChanged(device)
    }

    fun voiceLink(state: VoiceLinkState) {
        voiceLinkConnected = state == VoiceLinkState.CONNECTED
        listener?.onVoiceLinkStateChanged(state)
    }

    fun otherAudio(active: Boolean) {
        musicActive = active
        listener?.onOtherAudioActiveChanged(active)
    }

    fun becomingNoisy() {
        listener?.onBecomingNoisy()
    }
}

class RecordingRouteListener : AudioRouteListener {
    val routes = mutableListOf<AudioRoute>()
    val grants = mutableListOf<ModePolicy.MicSource>()

    override fun onAudioRouteChanged(route: AudioRoute) {
        routes.add(route)
    }

    override fun onCaptureGranted(mic: ModePolicy.MicSource) {
        grants.add(mic)
    }

    val last: AudioRoute get() = routes.last()
}

class RecordingRouteLogger : RouteLogger {
    val lines = mutableListOf<String>()

    override fun log(line: String) {
        lines.add(line)
    }
}

/** The device fixtures every controller test shares. */
object TestDevices {
    val speaker = RouteDevice(1, AudioDeviceInfo.TYPE_BUILTIN_SPEAKER, "", "speaker", false, true)
    val phoneMic = RouteDevice(2, AudioDeviceInfo.TYPE_BUILTIN_MIC, "", "mic", true, false)

    const val BT_ADDRESS = "AA:BB:CC:DD:EE:FF"

    val btMic = RouteDevice(
        id = 7,
        type = AudioDeviceInfo.TYPE_BLUETOOTH_SCO,
        address = BT_ADDRESS,
        productName = "Buds Pro",
        isSource = true,
        isSink = true,
    )
    val btMedia = RouteDevice(
        id = 8,
        type = AudioDeviceInfo.TYPE_BLUETOOTH_A2DP,
        address = BT_ADDRESS,
        productName = "Buds Pro",
        isSource = false,
        isSink = true,
    )
    val wiredHeadset = RouteDevice(
        id = 3,
        type = AudioDeviceInfo.TYPE_WIRED_HEADSET,
        address = "",
        productName = "Wired headset",
        isSource = true,
        isSink = true,
    )
    val wiredHeadphones = RouteDevice(
        id = 5,
        type = AudioDeviceInfo.TYPE_WIRED_HEADPHONES,
        address = "",
        productName = "Wired headphones",
        isSource = false,
        isSink = true,
    )
    val watch = RouteDevice(
        id = 12,
        type = AudioDeviceInfo.TYPE_BLUETOOTH_SCO,
        address = "99:99:99:99:99:99",
        productName = "Galaxy Watch5",
        isSource = true,
        isSink = true,
    )
}
```

- [ ] **Step 2: Write the failing test**

Create `android/app/src/test/java/com/oru/radio/AudioRouteControllerTest.kt`:

```kotlin
package com.oru.radio

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * Section 6 device handling and section 10's "connect/disconnect/reconnect, debounce, noisy,
 * watch filter" list. The controller runs on the injected scheduler, which here is inline and
 * carries the virtual clock the policy and the timers share.
 */
class AudioRouteControllerTest {

    private lateinit var facade: FakeAudioManagerFacade
    private lateinit var scheduler: TestScheduler
    private lateinit var logger: RecordingRouteLogger
    private lateinit var listener: RecordingRouteListener
    private lateinit var controller: AudioRouteController

    @Before
    fun setUp() {
        facade = FakeAudioManagerFacade()
        facade.devices.addAll(listOf(TestDevices.speaker, TestDevices.phoneMic))
        facade.hfpAddresses = listOf(TestDevices.BT_ADDRESS)
        scheduler = TestScheduler()
        logger = RecordingRouteLogger()
        listener = RecordingRouteListener()
        controller = AudioRouteController(
            facade = facade,
            scheduler = scheduler,
            clock = { scheduler.nowMs },
            policy = ModePolicy(),
            logger = logger,
        )
        controller.start(listener)
    }

    private fun settle() = scheduler.advance(AudioRouteController.DEVICE_ADD_DEBOUNCE_MS)

    @Test
    fun `starting publishes the built-in route and registers with the platform`() {
        assertTrue(facade.started)
        assertEquals(AudioRoute.Kind.SPEAKER, listener.last.kind)
        assertEquals(null, listener.last.label)
        assertEquals(ModePolicy.Profile.VOICE, listener.last.mode)
    }

    @Test
    fun `a bluetooth headset connecting takes the route once the list settles`() {
        facade.connect(TestDevices.btMic, TestDevices.btMedia)

        // §6: added devices are debounced ~500 ms, because the list flaps while Bluetooth
        // negotiates profiles. Nothing is published before the window closes.
        assertEquals(1, listener.routes.size)

        settle()

        assertEquals(AudioRoute.Kind.BLUETOOTH, listener.last.kind)
        assertEquals("Buds Pro", listener.last.label)
    }

    @Test
    fun `a removed device is handled immediately, with no debounce`() {
        facade.connect(TestDevices.btMic, TestDevices.btMedia)
        settle()

        facade.disconnect(TestDevices.btMic, TestDevices.btMedia)

        // Missing a transmission is worse than hearing it out loud (D3): no waiting.
        assertEquals(AudioRoute.Kind.SPEAKER, listener.last.kind)
    }

    @Test
    fun `reconnecting takes the route again`() {
        facade.connect(TestDevices.btMic, TestDevices.btMedia)
        settle()
        facade.disconnect(TestDevices.btMic, TestDevices.btMedia)
        facade.connect(TestDevices.btMic, TestDevices.btMedia)
        settle()

        assertEquals(AudioRoute.Kind.BLUETOOTH, listener.last.kind)
    }

    @Test
    fun `a burst of additions publishes once`() {
        facade.connect(TestDevices.btMedia)
        scheduler.advance(200)
        facade.connect(TestDevices.btMic)
        scheduler.advance(200)
        assertEquals(1, listener.routes.size)

        settle()

        assertEquals(2, listener.routes.size)
        assertEquals(AudioRoute.Kind.BLUETOOTH, listener.last.kind)
    }

    @Test
    fun `becoming noisy falls back to the loudspeaker before the removal arrives`() {
        facade.connect(TestDevices.wiredHeadphones)
        settle()
        assertEquals(AudioRoute.Kind.WIRED, listener.last.kind)

        // The jack was pulled; the device list has not caught up yet.
        facade.becomingNoisy()

        assertEquals(AudioRoute.Kind.SPEAKER, listener.last.kind)
    }

    @Test
    fun `the noisy guard expires so a device that really is still there comes back`() {
        facade.connect(TestDevices.wiredHeadphones)
        settle()
        facade.becomingNoisy()
        assertEquals(AudioRoute.Kind.SPEAKER, listener.last.kind)

        scheduler.advance(AudioRouteController.NOISY_GUARD_MS)
        controller.reevaluateNow()

        assertEquals(AudioRoute.Kind.WIRED, listener.last.kind)
    }

    @Test
    fun `a watch is never routed to`() {
        facade.connect(TestDevices.watch)
        settle()

        assertEquals(AudioRoute.Kind.SPEAKER, listener.last.kind)
    }

    @Test
    fun `an evaluation that changes nothing publishes nothing`() {
        val before = listener.routes.size

        controller.reevaluateNow()
        controller.reevaluateNow()

        assertEquals(before, listener.routes.size)
    }

    @Test
    fun `an applied route logs the latency since the device event that caused it`() {
        facade.connect(TestDevices.btMic, TestDevices.btMedia)
        scheduler.advance(AudioRouteController.DEVICE_ADD_DEBOUNCE_MS)

        val applied = logger.lines.last { it.startsWith("route: applied") }

        // §10: switch latency is measured, not guessed.
        assertTrue(applied, applied.contains("sinceDeviceEventMs=500"))
        assertTrue(applied, applied.contains("kind=BLUETOOTH"))
    }

    @Test
    fun `stopping releases the platform`() {
        controller.stop()

        assertTrue(facade.stopped)
    }
}
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `node scripts/build-android.js :app:testDebugUnitTest`
Expected: FAIL — `Unresolved reference: AudioRouteController` and `AudioRouteListener`.

- [ ] **Step 4: Add the listener port**

In `android/app/src/main/java/com/oru/radio/RadioPorts.kt`, append after the `AudioIo`
interface:

```kotlin
/**
 * Section 6/7 callbacks out of the route controller. They arrive on the `audio-route`
 * thread; `RadioEngine` re-posts them onto its own scheduler exactly as it does transport
 * and PTT callbacks.
 */
interface AudioRouteListener {
    /** The route actually in force changed — publish it and rebuild the audio streams. */
    fun onAudioRouteChanged(route: AudioRoute)

    /**
     * Section 7: the talk-permit tone has played and capture may start now. [mic] is
     * `PHONE_FALLBACK` when the headset link never came up for this transmission.
     */
    fun onCaptureGranted(mic: ModePolicy.MicSource)
}
```

- [ ] **Step 5: Write the controller core**

Create `android/app/src/main/java/com/oru/radio/AudioRouteController.kt`:

```kotlin
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
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node scripts/build-android.js :app:testDebugUnitTest`
Expected: PASS — all eleven `AudioRouteControllerTest` cases green.

- [ ] **Step 7: Run the task gate**

```bash
pnpm typecheck && pnpm lint && pnpm test && \
node scripts/build-android.js :app:testDebugUnitTest && \
pnpm build:android
```

Expected: all five commands exit 0.

- [ ] **Step 8: Commit**

```bash
git add android/app/src/main/java/com/oru/radio/AudioRouteController.kt \
        android/app/src/main/java/com/oru/radio/RadioPorts.kt \
        android/app/src/test/java/com/oru/radio/FakeAudioManagerFacade.kt \
        android/app/src/test/java/com/oru/radio/AudioRouteControllerTest.kt
git commit -m "feat(android): idempotent route reevaluation with debounce, noisy and watch filter"
```

---

## Task 3: Profiles — the mode table, device selection, and establishment without dead air

**Files:**
- Modify: `android/app/src/main/java/com/oru/radio/AudioRouteController.kt`
- Test: `android/app/src/test/java/com/oru/radio/AudioRouteControllerProfileTest.kt` (create)

**Interfaces:**
- Consumes: everything Task 2 produced, plus `AudioManagerFacade.setMode`, `mode`,
  `setCommunicationDevice`, `clearCommunicationDevice`, `startVoiceLink`, `stopVoiceLink`,
  `availableCommunicationDevices`, `connectedHfpAddresses`.
- Produces: inside `AudioRouteController` — `private fun wantedMode(candidate: RouteDevice?): Int`
  (the §11 three-row table), `private fun applyProfile(candidate: RouteDevice?)`,
  `private fun routeCommunicationTo(candidate: RouteDevice?)`,
  `private fun markEstablished(device: RouteDevice)`,
  `private fun failEstablishment(device: RouteDevice, reason: String)`, and the state
  `applied`, `establishing`, `attempts`, `demoted`. No new public API.

**Note on the three-row table:** §11 says "Android keeps: the three-row policy table". It is
kept exactly: an input-capable external selected → `MODE_IN_COMMUNICATION` with that device as
the communication device; no input-capable external but an external sink present →
`MODE_NORMAL` so A2DP/LE is not dropped from the route (playback over the headset, phone mic);
nothing external → `MODE_IN_COMMUNICATION` on the loudspeaker. The MEDIA profile is
`MODE_NORMAL` with no communication device at all (§6 profile table).

- [ ] **Step 1: Write the failing test**

Create `android/app/src/test/java/com/oru/radio/AudioRouteControllerProfileTest.kt`:

```kotlin
package com.oru.radio

import android.media.AudioManager
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * Section 6 "Profiles" and the first half of "Device selection and recovery": what the
 * controller asks of the platform, in what order, and what audio is on while it waits.
 */
class AudioRouteControllerProfileTest {

    private lateinit var facade: FakeAudioManagerFacade
    private lateinit var scheduler: TestScheduler
    private lateinit var listener: RecordingRouteListener
    private lateinit var controller: AudioRouteController

    @Before
    fun setUp() {
        facade = FakeAudioManagerFacade()
        facade.devices.addAll(listOf(TestDevices.speaker, TestDevices.phoneMic))
        facade.hfpAddresses = listOf(TestDevices.BT_ADDRESS)
        scheduler = TestScheduler()
        listener = RecordingRouteListener()
        controller = AudioRouteController(
            facade = facade,
            scheduler = scheduler,
            clock = { scheduler.nowMs },
            policy = ModePolicy(),
            logger = RecordingRouteLogger(),
        )
        controller.start(listener)
    }

    private fun settle() = scheduler.advance(AudioRouteController.DEVICE_ADD_DEBOUNCE_MS)

    private fun connectBluetooth() {
        facade.connect(TestDevices.btMic, TestDevices.btMedia)
        settle()
    }

    @Test
    fun `nothing external is communication mode on the loudspeaker`() {
        assertEquals(listOf(AudioManager.MODE_IN_COMMUNICATION), facade.modeSets)
        assertTrue(facade.communicationDeviceSelections.isEmpty())
        assertEquals(AudioRoute.Kind.SPEAKER, listener.last.kind)
    }

    @Test
    fun `an output-only external keeps the platform in normal mode`() {
        // Section 11 keeps the three-row table: MODE_IN_COMMUNICATION would drop A2DP/LE from
        // the route and land playback on the loudspeaker, which is the opposite of the goal.
        facade.connect(TestDevices.wiredHeadphones)
        settle()

        assertEquals(AudioManager.MODE_NORMAL, facade.mode)
        assertTrue(facade.communicationDeviceSelections.isEmpty())
        assertEquals(AudioRoute.Kind.WIRED, listener.last.kind)
    }

    @Test
    fun `voice selects the headset once the platform mode has landed`() {
        connectBluetooth()

        assertEquals(AudioManager.MODE_IN_COMMUNICATION, facade.mode)
        assertEquals(listOf(TestDevices.btMic), facade.communicationDeviceSelections)
        // A Bluetooth Classic target always gets the legacy establishment alongside the
        // selection: on scoManagedByAudio=false stacks it is the only thing that raises SCO.
        assertEquals(listOf(TestDevices.btMic), facade.voiceLinkStarts)
    }

    @Test
    fun `the mode is set before the communication device`() {
        facade.modeFollowsSet = false

        connectBluetooth()

        // The mode never landed, so nothing was selected yet, and the mode was asked for
        // exactly once -- section 6 replaces the 3 x 100 ms polling with the listener.
        assertEquals(listOf(AudioManager.MODE_IN_COMMUNICATION), facade.modeSets)
        assertTrue(facade.communicationDeviceSelections.isEmpty())
    }

    @Test
    fun `a stack that never confirms the mode is routed anyway after the backstop`() {
        facade.modeFollowsSet = false
        connectBluetooth()

        scheduler.advance(AudioRouteController.MODE_SETTLE_TIMEOUT_MS)

        assertEquals(listOf(TestDevices.btMic), facade.communicationDeviceSelections)
        assertEquals(listOf(AudioManager.MODE_IN_COMMUNICATION), facade.modeSets)
    }

    @Test
    fun `audio keeps flowing on the previous route while the new link establishes`() {
        facade.connect(TestDevices.wiredHeadset)
        settle()
        assertEquals(AudioRoute.Kind.WIRED, listener.last.kind)
        val publishedBefore = listener.routes.size

        connectBluetooth()

        // Section 6: "audio keeps flowing on the previous route while SCO / comm-device
        // establishment is in flight". The wired headset is still the communication device
        // and nothing was cleared, so there is no dead air.
        assertEquals(0, facade.communicationDeviceClears)
        assertEquals(publishedBefore, listener.routes.size)

        facade.voiceLink(VoiceLinkState.CONNECTED)

        assertEquals(AudioRoute.Kind.BLUETOOTH, listener.last.kind)
        assertEquals("Buds Pro", listener.last.label)
    }

    @Test
    fun `a wired headset is in force as soon as the platform accepts it`() {
        // Wired, USB and LE Audio have no link to negotiate (section 7: the policy is inert
        // there), so the selection is the route.
        facade.connect(TestDevices.wiredHeadset)
        settle()

        assertEquals(listOf(TestDevices.wiredHeadset), facade.communicationDeviceSelections)
        assertTrue(facade.voiceLinkStarts.isEmpty())
        assertEquals(AudioRoute.Kind.WIRED, listener.last.kind)
    }

    @Test
    fun `a rejected selection is retried once and then demoted to the output-only row`() {
        facade.acceptsCommunicationDevice = false

        connectBluetooth()

        // Section 6: max two attempts per episode; the second failure demotes the device
        // until the next device event -- it is never blacklisted for the session.
        assertEquals(
            AudioRouteController.MAX_ESTABLISH_ATTEMPTS,
            facade.communicationDeviceSelections.size,
        )
        // Playback still reaches the headset over its media route, with the phone mic.
        assertEquals(AudioManager.MODE_NORMAL, facade.mode)
        assertEquals(AudioRoute.Kind.BLUETOOTH, listener.last.kind)
    }

    @Test
    fun `a device event refreshes the retry budget`() {
        facade.acceptsCommunicationDevice = false
        connectBluetooth()
        val exhausted = facade.communicationDeviceSelections.size

        // Any device event lifts the demotion; a fresh connection also zeroes the counter.
        facade.acceptsCommunicationDevice = true
        facade.disconnect(TestDevices.btMic, TestDevices.btMedia)
        facade.connect(TestDevices.btMic, TestDevices.btMedia)
        settle()

        assertEquals(exhausted + 1, facade.communicationDeviceSelections.size)
        assertEquals(TestDevices.btMic, facade.communicationDevice)
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node scripts/build-android.js :app:testDebugUnitTest`
Expected: FAIL — `MAX_ESTABLISH_ATTEMPTS` exists but nothing selects a communication device;
`facade.modeSets` is empty and `communicationDeviceSelections` is empty.

- [ ] **Step 3: Add the profile apply to the controller**

In `AudioRouteController.kt`, add the imports and state, then the apply machinery.

Add at the top of the file:

```kotlin
import android.media.AudioManager
```

Add to the state region, after `private var profile`:

```kotlin
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
```

Replace `evaluateOnce()` and `routeInForce()` with:

```kotlin
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
     * Section 6 replaces the old 3 × 100 ms polling with `OnModeChangedListener`, which
     * re-enters this method through [reevaluate]. [MODE_SETTLE_TIMEOUT_MS] is the single
     * backstop for stacks that never fire it; after it, routing proceeds anyway. Audio is
     * flowing on the previous route the whole time, so the wait is inaudible.
     */
    private fun applyProfile(candidate: RouteDevice?) {
        val wanted = wantedMode(candidate)
        if (facade.mode() != wanted) {
            val deadline = modeSettleDeadlineMs
            if (deadline == null) {
                facade.setMode(wanted)
                if (facade.mode() != wanted) {
                    modeSettleDeadlineMs = clock() + MODE_SETTLE_TIMEOUT_MS
                    modeBackstop = scheduler.schedule(MODE_SETTLE_TIMEOUT_MS) {
                        modeBackstop = null
                        reevaluate()
                    }
                    logger.log("route: awaiting mode t=${clock()}ms wanted=$wanted")
                    return
                }
            } else if (clock() < deadline) {
                return
            } else {
                logger.log("route: mode never landed t=${clock()}ms; routing anyway")
            }
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
```

Replace the `onDeviceEvent` placeholder with the budget reset, and fill the establishment
callbacks:

```kotlin
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
```

Extend `onCommunicationDeviceChanged` and `onVoiceLinkStateChanged`:

```kotlin
    override fun onCommunicationDeviceChanged(device: RouteDevice?) = post {
        if (!started) return@post
        logger.log("route: platform communication device t=${clock()}ms -> ${device?.productName}")
        val target = establishing
        if (target != null && device?.id == target.id && !RoutePicker.requiresVoiceLink(target)) {
            markEstablished(target)
        }
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
```

Add the establishment timer, which Task 4 fills with the ground-truth re-check:

```kotlin
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
```

Finally, `stop()` must release the platform state it took: add before `facade.stop()`:

```kotlin
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node scripts/build-android.js :app:testDebugUnitTest`
Expected: PASS — nine `AudioRouteControllerProfileTest` cases plus the Task 2 suite.

- [ ] **Step 5: Run the task gate**

```bash
pnpm typecheck && pnpm lint && pnpm test && \
node scripts/build-android.js :app:testDebugUnitTest && \
pnpm build:android
```

Expected: all five commands exit 0.

- [ ] **Step 6: Commit**

```bash
git add android/app/src/main/java/com/oru/radio/AudioRouteController.kt \
        android/app/src/test/java/com/oru/radio/AudioRouteControllerProfileTest.kt
git commit -m "feat(android): profile apply, bounded retries and establishment without dead air"
```

---

## Task 4: Recovery — ground truth, re-assert, and SCO theft

**Files:**
- Modify: `android/app/src/main/java/com/oru/radio/AudioRouteController.kt`
- Test: `android/app/src/test/java/com/oru/radio/AudioRouteControllerRecoveryTest.kt` (create)

**Interfaces:**
- Consumes: Task 3's `failEstablishment`, `markEstablished`, `applied`, `establishing`,
  `attempts`, `demoted`, `onEstablishTimeout`; `AudioManagerFacade.isVoiceLinkConnected`.
- Produces: `const val MAX_COMMUNICATION_DEVICE_REASSERTS = 3` on
  `AudioRouteController.Companion`; the private state `reassertCount`; no new public API.

- [ ] **Step 1: Write the failing test**

Create `android/app/src/test/java/com/oru/radio/AudioRouteControllerRecoveryTest.kt`:

```kotlin
package com.oru.radio

import android.media.AudioManager
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * Section 6 "Device selection and recovery", against a platform that lies: a selection it
 * accepts and never builds, a link it drops out from under us, a selection it silently
 * replaces. Section 10's "SCO timeout + bounded retries + counter resets".
 */
class AudioRouteControllerRecoveryTest {

    private lateinit var facade: FakeAudioManagerFacade
    private lateinit var scheduler: TestScheduler
    private lateinit var logger: RecordingRouteLogger
    private lateinit var listener: RecordingRouteListener
    private lateinit var controller: AudioRouteController

    @Before
    fun setUp() {
        facade = FakeAudioManagerFacade()
        facade.devices.addAll(listOf(TestDevices.speaker, TestDevices.phoneMic))
        facade.hfpAddresses = listOf(TestDevices.BT_ADDRESS)
        scheduler = TestScheduler()
        logger = RecordingRouteLogger()
        listener = RecordingRouteListener()
        controller = AudioRouteController(
            facade = facade,
            scheduler = scheduler,
            clock = { scheduler.nowMs },
            policy = ModePolicy(),
            logger = logger,
        )
        controller.start(listener)
        facade.connect(TestDevices.btMic, TestDevices.btMedia)
        scheduler.advance(AudioRouteController.DEVICE_ADD_DEBOUNCE_MS)
    }

    private fun establish() = facade.voiceLink(VoiceLinkState.CONNECTED)

    @Test
    fun `an establishment timeout re-checks ground truth before failing the headset`() {
        // The listener event went missing but the link really is up: keep it. Section 6,
        // "ground truth is re-checked via isAudioConnected before declaring timeout".
        facade.voiceLinkConnected = true

        scheduler.advance(AudioRouteController.ESTABLISH_TIMEOUT_MS)

        assertEquals(AudioRoute.Kind.BLUETOOTH, listener.last.kind)
        assertEquals(AudioManager.MODE_IN_COMMUNICATION, facade.mode)
        // One selection, not a retry: nothing failed.
        assertEquals(1, facade.communicationDeviceSelections.size)
    }

    @Test
    fun `an establishment timeout with no link spends an attempt`() {
        facade.voiceLinkConnected = false

        scheduler.advance(AudioRouteController.ESTABLISH_TIMEOUT_MS)

        assertEquals(2, facade.communicationDeviceSelections.size)
        assertTrue(facade.voiceLinkStops > 0)
    }

    @Test
    fun `two timeouts demote the headset onto the output-only row`() {
        facade.voiceLinkConnected = false

        scheduler.advance(AudioRouteController.ESTABLISH_TIMEOUT_MS)
        scheduler.advance(AudioRouteController.ESTABLISH_TIMEOUT_MS)

        assertEquals(
            AudioRouteController.MAX_ESTABLISH_ATTEMPTS,
            facade.communicationDeviceSelections.size,
        )
        // Playback still reaches the buds over A2DP, with the phone mic.
        assertEquals(AudioManager.MODE_NORMAL, facade.mode)
        assertEquals(AudioRoute.Kind.BLUETOOTH, listener.last.kind)
    }

    @Test
    fun `an sco error spends an attempt immediately`() {
        facade.voiceLink(VoiceLinkState.ERROR)

        assertEquals(2, facade.communicationDeviceSelections.size)
    }

    @Test
    fun `sco theft resets the budget and re-establishes`() {
        establish()
        assertEquals(AudioRoute.Kind.BLUETOOTH, listener.last.kind)
        val selectionsBefore = facade.communicationDeviceSelections.size

        // Signal's wasAudioStateInterrupted: the link went away without us asking.
        facade.voiceLink(VoiceLinkState.DISCONNECTED)

        assertEquals(selectionsBefore + 1, facade.communicationDeviceSelections.size)
        assertTrue(
            logger.lines.any { it.contains("voice link stolen") },
        )
    }

    @Test
    fun `sco theft after two failures still gets a fresh budget`() {
        establish()
        facade.voiceLink(VoiceLinkState.DISCONNECTED)
        facade.voiceLinkConnected = false

        // Section 6: "the counter resets ... on detected SCO theft", so the two attempts
        // that follow are a fresh episode rather than the tail of the old one.
        scheduler.advance(AudioRouteController.ESTABLISH_TIMEOUT_MS)
        scheduler.advance(AudioRouteController.ESTABLISH_TIMEOUT_MS)

        assertEquals(AudioManager.MODE_NORMAL, facade.mode)
    }

    @Test
    fun `the platform clearing our selection is re-asserted`() {
        establish()
        val selectionsBefore = facade.communicationDeviceSelections.size

        facade.platformCommunicationDevice(null)

        assertEquals(selectionsBefore + 1, facade.communicationDeviceSelections.size)
    }

    @Test
    fun `a platform that keeps clearing our selection is given up on`() {
        establish()

        repeat(AudioRouteController.MAX_COMMUNICATION_DEVICE_REASSERTS + 1) {
            facade.platformCommunicationDevice(null)
            facade.voiceLink(VoiceLinkState.CONNECTED)
        }

        // Bounded: the buds end up on the output-only row instead of an applyAudioMode loop.
        assertEquals(AudioManager.MODE_NORMAL, facade.mode)
        assertEquals(AudioRoute.Kind.BLUETOOTH, listener.last.kind)
    }

    @Test
    fun `a confirmation clears the re-assert count`() {
        establish()
        facade.platformCommunicationDevice(null)
        facade.voiceLink(VoiceLinkState.CONNECTED)
        val selectionsAfterFirst = facade.communicationDeviceSelections.size

        // A confirmed route means the previous re-assert is forgotten, so the next clear
        // starts over rather than pushing the count towards the cap.
        facade.platformCommunicationDevice(null)

        assertEquals(selectionsAfterFirst + 1, facade.communicationDeviceSelections.size)
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node scripts/build-android.js :app:testDebugUnitTest`
Expected: FAIL — `Unresolved reference: MAX_COMMUNICATION_DEVICE_REASSERTS`, and the timeout
cases fail because ground truth is not consulted.

- [ ] **Step 3: Add the recovery paths**

In `AudioRouteController.kt`, add the constant to the companion object:

```kotlin
        /**
         * How many times a platform-cleared or platform-replaced communication device is
         * re-asserted before the headset spends an attempt. Keeps an OEM stack that keeps
         * rerouting from turning into an endless re-selection loop.
         */
        const val MAX_COMMUNICATION_DEVICE_REASSERTS = 3
```

Add the state next to `establishing`:

```kotlin
    /** Re-asserts done since the platform last confirmed our communication device. */
    private var reassertCount = 0
```

Replace `onEstablishTimeout` with the ground-truth version:

```kotlin
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
```

Replace `onCommunicationDeviceChanged` with the re-assert version:

```kotlin
    override fun onCommunicationDeviceChanged(device: RouteDevice?) = post {
        if (!started) return@post
        logger.log("route: platform communication device t=${clock()}ms -> ${device?.productName}")
        val target = establishing
        if (target != null && device?.id == target.id) {
            reassertCount = 0
            // A Bluetooth Classic selection is confirmed by the SCO link, not by the
            // selection echo: this is exactly the state the 2026-08-17 total-silence session
            // was stuck in — confirmed selection, no link.
            if (!RoutePicker.requiresVoiceLink(target)) markEstablished(target)
            reevaluate()
            return@post
        }
        val inForce = applied
        if (inForce != null && device?.id != inForce.id) {
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
                failEstablishment(inForce, "the platform kept taking the route away")
            }
        } else if (device != null && device.id == inForce?.id) {
            reassertCount = 0
        }
        reevaluate()
    }
```

Replace `onVoiceLinkStateChanged` with the theft-aware version:

```kotlin
    override fun onVoiceLinkStateChanged(state: VoiceLinkState) = post {
        if (!started) return@post
        logger.log("route: voice link t=${clock()}ms -> $state")
        val target = establishing
        when (state) {
            VoiceLinkState.CONNECTED -> {
                reassertCount = 0
                if (target != null) markEstablished(target)
            }
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
```

Finally, `markEstablished` must clear the re-assert count too — add `reassertCount = 0` next
to `attempts.remove(device.key)`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node scripts/build-android.js :app:testDebugUnitTest`
Expected: PASS — nine `AudioRouteControllerRecoveryTest` cases plus everything before.

- [ ] **Step 5: Run the task gate**

```bash
pnpm typecheck && pnpm lint && pnpm test && \
node scripts/build-android.js :app:testDebugUnitTest && \
pnpm build:android
```

Expected: all five commands exit 0.

- [ ] **Step 6: Commit**

```bash
git add android/app/src/main/java/com/oru/radio/AudioRouteController.kt \
        android/app/src/test/java/com/oru/radio/AudioRouteControllerRecoveryTest.kt
git commit -m "feat(android): route recovery via ground truth, re-assert and SCO theft detection"
```

---

## Task 5: The mode policy wired in — profiles, the PTT raise, and the grant tone

**Files:**
- Modify: `android/app/src/main/java/com/oru/radio/AudioRouteController.kt`
- Modify: `android/app/src/main/java/com/oru/radio/RadioPorts.kt`
- Test: `android/app/src/test/java/com/oru/radio/AudioRouteControllerPolicyTest.kt` (create)

**Interfaces:**
- Consumes: the merged `ModePolicy` — `setAudioMode`, `setOtherAudioActive`, `setRadioActive`,
  `setRouteRequiresVoiceLink`, `pttPressed`, `pttReleased`, `voiceLinkEstablished`,
  `voiceLinkFailed`, `tick`, and `Decision(profile, actions, nextWakeupMs)`.
  **`ModePolicy.kt` is not edited by this task or any other.**
- Produces: `interface AudioRouting { fun start(listener: AudioRouteListener); fun stop();
  fun setAudioMode(mode: ModePolicy.AudioMode); fun setRadioActive(active: Boolean);
  fun onPttPressed(); fun onPttReleased() }` in `RadioPorts.kt`;
  `AudioRouteController` now implements it.

- [ ] **Step 1: Write the failing test**

Create `android/app/src/test/java/com/oru/radio/AudioRouteControllerPolicyTest.kt`:

```kotlin
package com.oru.radio

import android.media.AudioManager
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * Section 7, executed. `ModePolicyTest` already asserts the transition table itself; this
 * file asserts that the Android side does what a decision says — the mode it sets, the
 * device it selects or releases, the tone it plays and the capture it grants.
 */
class AudioRouteControllerPolicyTest {

    private lateinit var facade: FakeAudioManagerFacade
    private lateinit var scheduler: TestScheduler
    private lateinit var listener: RecordingRouteListener
    private lateinit var controller: AudioRouteController

    @Before
    fun setUp() {
        facade = FakeAudioManagerFacade()
        facade.devices.addAll(listOf(TestDevices.speaker, TestDevices.phoneMic))
        facade.hfpAddresses = listOf(TestDevices.BT_ADDRESS)
        scheduler = TestScheduler()
        listener = RecordingRouteListener()
        controller = AudioRouteController(
            facade = facade,
            scheduler = scheduler,
            clock = { scheduler.nowMs },
            policy = ModePolicy(),
            logger = RecordingRouteLogger(),
        )
        controller.start(listener)
        facade.connect(TestDevices.btMic, TestDevices.btMedia)
        scheduler.advance(AudioRouteController.DEVICE_ADD_DEBOUNCE_MS)
        facade.voiceLink(VoiceLinkState.CONNECTED)
    }

    private fun toMedia() {
        facade.otherAudio(true)
        scheduler.advance(ModePolicy.Constants.OTHER_AUDIO_TO_MEDIA_MS)
    }

    @Test
    fun `the headset starts on the voice profile with the link held`() {
        assertEquals(AudioManager.MODE_IN_COMMUNICATION, facade.mode)
        assertEquals(ModePolicy.Profile.VOICE, listener.last.mode)
        assertEquals(AudioRoute.Kind.BLUETOOTH, listener.last.kind)
    }

    @Test
    fun `two seconds of other audio drops the link and hands the headset back to a2dp`() {
        toMedia()

        assertEquals(ModePolicy.Profile.MEDIA, listener.last.mode)
        assertEquals(AudioManager.MODE_NORMAL, facade.mode)
        assertTrue(facade.communicationDeviceClears > 0)
        assertTrue(facade.voiceLinkStops > 0)
        // Playback still goes to the buds, now over A2DP at full quality.
        assertEquals(AudioRoute.Kind.BLUETOOTH, listener.last.kind)
    }

    @Test
    fun `thirty seconds of silence raises the link again`() {
        toMedia()
        val selectionsBefore = facade.communicationDeviceSelections.size

        facade.otherAudio(false)
        scheduler.advance(ModePolicy.Constants.OTHER_AUDIO_TO_VOICE_MS)

        assertEquals(selectionsBefore + 1, facade.communicationDeviceSelections.size)
        assertEquals(AudioManager.MODE_IN_COMMUNICATION, facade.mode)
    }

    @Test
    fun `a switch queues for idle while the radio is busy`() {
        controller.setRadioActive(true)

        toMedia()

        // Section 7: "switches never run during receive or transmit (they queue for idle)".
        assertEquals(ModePolicy.Profile.VOICE, listener.last.mode)

        controller.setRadioActive(false)

        assertEquals(ModePolicy.Profile.MEDIA, listener.last.mode)
    }

    @Test
    fun `pinning voice ignores other audio entirely`() {
        controller.setAudioMode(ModePolicy.AudioMode.VOICE)

        toMedia()

        assertEquals(ModePolicy.Profile.VOICE, listener.last.mode)
        assertEquals(AudioManager.MODE_IN_COMMUNICATION, facade.mode)
    }

    @Test
    fun `pinning media leaves the headset on a2dp with no music playing`() {
        controller.setAudioMode(ModePolicy.AudioMode.MEDIA)

        assertEquals(ModePolicy.Profile.MEDIA, listener.last.mode)
        assertEquals(AudioManager.MODE_NORMAL, facade.mode)
    }

    @Test
    fun `a press in media raises the link, tones and grants capture`() {
        toMedia()
        facade.grantTones.clear()

        controller.onPttPressed()

        // The raise is in flight: no tone yet, no capture yet -- press, then tone, then talk.
        assertTrue(facade.grantTones.isEmpty())
        assertTrue(listener.grants.isEmpty())
        assertEquals(TestDevices.btMic, facade.communicationDeviceSelections.last())

        facade.voiceLink(VoiceLinkState.CONNECTED)

        assertEquals(listOf(ModePolicy.Profile.VOICE), facade.grantTones)
        assertEquals(listOf(ModePolicy.MicSource.ROUTE_DEFAULT), listener.grants)
    }

    @Test
    fun `a raise that times out tones on the media path and falls back to the phone mic`() {
        toMedia()
        facade.grantTones.clear()

        controller.onPttPressed()
        scheduler.advance(ModePolicy.Constants.VOICE_LINK_GRANT_TIMEOUT_MS)

        assertEquals(listOf(ModePolicy.MicSource.PHONE_FALLBACK), listener.grants)
        assertEquals(listOf(ModePolicy.Profile.MEDIA), facade.grantTones)
        assertEquals(AudioManager.MODE_NORMAL, facade.mode)
    }

    @Test
    fun `a raise the platform refuses falls back without waiting for the timeout`() {
        toMedia()
        facade.acceptsCommunicationDevice = false

        controller.onPttPressed()

        assertEquals(listOf(ModePolicy.MicSource.PHONE_FALLBACK), listener.grants)
    }

    @Test
    fun `a press on the voice profile tones immediately`() {
        controller.onPttPressed()

        assertEquals(listOf(ModePolicy.Profile.VOICE), facade.grantTones)
        assertEquals(listOf(ModePolicy.MicSource.ROUTE_DEFAULT), listener.grants)
    }

    @Test
    fun `the linger holds the link and a second press inside it is instant`() {
        toMedia()
        controller.onPttPressed()
        facade.voiceLink(VoiceLinkState.CONNECTED)
        controller.onPttReleased()
        facade.grantTones.clear()
        val selections = facade.communicationDeviceSelections.size

        scheduler.advance(ModePolicy.Constants.VOICE_LINK_LINGER_MS - 1)
        controller.onPttPressed()

        // Still up: no new selection, and the tone is immediate.
        assertEquals(selections, facade.communicationDeviceSelections.size)
        assertEquals(listOf(ModePolicy.Profile.VOICE), facade.grantTones)
    }

    @Test
    fun `the linger expiring drops the link and music resumes`() {
        toMedia()
        controller.onPttPressed()
        facade.voiceLink(VoiceLinkState.CONNECTED)
        controller.onPttReleased()
        val clearsBefore = facade.communicationDeviceClears

        scheduler.advance(ModePolicy.Constants.VOICE_LINK_LINGER_MS)

        assertEquals(ModePolicy.Profile.MEDIA, listener.last.mode)
        assertTrue(facade.communicationDeviceClears > clearsBefore)
    }

    @Test
    fun `a headset that disappears mid-raise fails the raise instead of waiting it out`() {
        toMedia()
        controller.onPttPressed()

        facade.disconnect(TestDevices.btMic, TestDevices.btMedia)

        assertEquals(listOf(ModePolicy.MicSource.PHONE_FALLBACK), listener.grants)
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node scripts/build-android.js :app:testDebugUnitTest`
Expected: FAIL — `Unresolved reference: setAudioMode` / `setRadioActive` / `onPttPressed` on
`AudioRouteController`.

- [ ] **Step 3: Add the routing port**

In `android/app/src/main/java/com/oru/radio/RadioPorts.kt`, above `AudioRouteListener`:

```kotlin
/**
 * Section 6's routing, as the engine drives it. One implementation
 * ([AudioRouteController]) and one test double.
 *
 * Every method returns immediately: the controller posts onto its own thread, so nothing
 * here ever blocks the engine's.
 */
interface AudioRouting {
    fun start(listener: AudioRouteListener)
    fun stop()

    /** Section 8's persisted setting. `AUTO` runs the section 7 policy; the others pin it. */
    fun setAudioMode(mode: ModePolicy.AudioMode)

    /** The radio is receiving or transmitting: section 7 queues switches for idle. */
    fun setRadioActive(active: Boolean)

    /** Section 7: press then tone then talk. Capture starts on [AudioRouteListener.onCaptureGranted]. */
    fun onPttPressed()

    fun onPttReleased()
}
```

- [ ] **Step 4: Wire the policy into the controller**

In `AudioRouteController.kt`, change the class declaration to

```kotlin
class AudioRouteController(
    private val facade: AudioManagerFacade,
    private val scheduler: Scheduler,
    private val clock: () -> Long,
    private val policy: ModePolicy,
    private val logger: RouteLogger,
) : AudioRouting, AudioFacadeListener {
```

and mark `start`/`stop` `override`. Add the state:

```kotlin
    private var policyWakeup: Cancellable? = null

    /** Last value handed to the policy, so an unchanged route is not re-announced. */
    private var routeRequiresVoiceLink = false
```

Add the policy inputs:

```kotlin
    override fun setAudioMode(mode: ModePolicy.AudioMode) = post {
        logger.log("route: audio mode t=${clock()}ms -> $mode")
        apply(policy.setAudioMode(mode, clock()))
    }

    override fun setRadioActive(active: Boolean) = post {
        apply(policy.setRadioActive(active, clock()))
    }

    override fun onPttPressed() = post {
        logger.log("route: ptt pressed t=${clock()}ms profile=$profile")
        apply(policy.pttPressed(clock()))
    }

    override fun onPttReleased() = post {
        logger.log("route: ptt released t=${clock()}ms")
        apply(policy.pttReleased(clock()))
    }
```

Replace `onOtherAudioActiveChanged`:

```kotlin
    override fun onOtherAudioActiveChanged(active: Boolean) = post {
        if (!started) return@post
        logger.log("route: other audio t=${clock()}ms -> $active")
        // Raw and undebounced on purpose: the 2 s / 30 s dwell lives in the shared policy so
        // both platforms debounce identically.
        apply(policy.setOtherAudioActive(active, clock()))
    }
```

Add the decision funnel:

```kotlin
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
```

Replace `pickCandidate` with the profile-independent pair, and feed the policy from
`evaluateOnce`:

```kotlin
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
```

Report every link outcome to the policy. In `markEstablished`, after `reassertCount = 0`:

```kotlin
        // Reported unconditionally: the policy ignores an outcome it is not waiting for, so
        // the controller needs no "was this raise mine?" bookkeeping.
        apply(policy.voiceLinkEstablished(clock()))
```

and in `failEstablishment`, as the last statement (replacing `reevaluateAgain = true`):

```kotlin
        apply(policy.voiceLinkFailed(clock()))
```

A raise whose target disappears must fail rather than wait out the 4 s grant timeout — in
`onDeviceEvent`, inside the `removed.forEach` branch that clears `establishing`, add:

```kotlin
                pendingLinkLoss = true
```

with the field `private var pendingLinkLoss = false` and, at the end of
`onDevicesChanged`'s handler (after the debounce/reevaluate branch):

```kotlin
        if (pendingLinkLoss) {
            pendingLinkLoss = false
            apply(policy.voiceLinkFailed(clock()))
        }
```

Finally, `stop()` must cancel the policy timer: add `policyWakeup?.cancel(); policyWakeup = null`
beside `cancelEstablishTimeout()`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node scripts/build-android.js :app:testDebugUnitTest`
Expected: PASS — thirteen `AudioRouteControllerPolicyTest` cases plus everything before.

- [ ] **Step 6: Run the task gate**

```bash
pnpm typecheck && pnpm lint && pnpm test && \
node scripts/build-android.js :app:testDebugUnitTest && \
pnpm build:android
```

Expected: all five commands exit 0.

- [ ] **Step 7: Commit**

```bash
git add android/app/src/main/java/com/oru/radio/AudioRouteController.kt \
        android/app/src/main/java/com/oru/radio/RadioPorts.kt \
        android/app/src/test/java/com/oru/radio/AudioRouteControllerPolicyTest.kt
git commit -m "feat(android): execute the shared mode policy — profiles, raise, grant tone"
```

---

## Task 6: Per-burst ducking focus

**Files:**
- Modify: `android/app/src/main/java/com/oru/radio/AudioRouteController.kt`
- Test: `android/app/src/test/java/com/oru/radio/AudioRouteControllerFocusTest.kt` (create)

**Interfaces:**
- Consumes: `AudioManagerFacade.requestTransientDuckFocus`, `AudioManagerFacade.abandonFocus`;
  the controller's `setRadioActive`, `onPttPressed`, `onPttReleased`, `stop`.
- Produces: no new public API — `private fun updateFocus()` and the state `focusHeld`,
  `pttHeld`, `radioActive`.

**What a "burst" is:** §6's focus row says "request at burst start, abandon at end". A burst
starts when the radio begins receiving or transmitting, *or* when PTT goes down — the earlier
of the two, so the grant tone and the 1–3 s SCO raise that precede a transmission are ducked
too, which is the whole point of a talk-permit tone over music. It ends when the radio is idle
again and the button is up. The 15 s linger holds the *link*, not focus: there is no voice
during it, so other apps get their volume back.

- [ ] **Step 1: Write the failing test**

Create `android/app/src/test/java/com/oru/radio/AudioRouteControllerFocusTest.kt`:

```kotlin
package com.oru.radio

import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test

/**
 * Decision D6 and section 10's "focus request/abandon pairing": Android ducks other apps for
 * real, with one transient MAY_DUCK request per voice burst.
 */
class AudioRouteControllerFocusTest {

    private lateinit var facade: FakeAudioManagerFacade
    private lateinit var scheduler: TestScheduler
    private lateinit var controller: AudioRouteController

    @Before
    fun setUp() {
        facade = FakeAudioManagerFacade()
        facade.devices.addAll(listOf(TestDevices.speaker, TestDevices.phoneMic))
        scheduler = TestScheduler()
        controller = AudioRouteController(
            facade = facade,
            scheduler = scheduler,
            clock = { scheduler.nowMs },
            policy = ModePolicy(),
            logger = RecordingRouteLogger(),
        )
        controller.start(RecordingRouteListener())
    }

    @Test
    fun `a session holds no focus while nothing is happening`() {
        // The session-long AUDIOFOCUS_GAIN is gone: music plays untouched while the radio idles.
        assertEquals(0, facade.focusRequests)
        assertEquals(0, facade.focusAbandons)
    }

    @Test
    fun `focus is requested at the start of a burst and abandoned at its end`() {
        controller.setRadioActive(true)
        assertEquals(1, facade.focusRequests)
        assertEquals(0, facade.focusAbandons)

        controller.setRadioActive(false)
        assertEquals(1, facade.focusRequests)
        assertEquals(1, facade.focusAbandons)
    }

    @Test
    fun `a press holds focus across the raise and the whole transmission`() {
        controller.onPttPressed()
        assertEquals(1, facade.focusRequests)

        controller.setRadioActive(true)
        controller.setRadioActive(false)
        controller.onPttReleased()

        assertEquals(1, facade.focusRequests)
        assertEquals(1, facade.focusAbandons)
    }

    @Test
    fun `a press during reception does not double-request`() {
        controller.setRadioActive(true)
        controller.onPttPressed()
        controller.onPttReleased()

        assertEquals(1, facade.focusRequests)
        assertEquals(0, facade.focusAbandons)

        controller.setRadioActive(false)
        assertEquals(1, facade.focusAbandons)
    }

    @Test
    fun `a refused request is still abandoned exactly once`() {
        facade.focusGranted = false

        controller.setRadioActive(true)
        controller.setRadioActive(false)

        assertEquals(1, facade.focusRequests)
        assertEquals(1, facade.focusAbandons)
    }

    @Test
    fun `stopping abandons a burst that was still open`() {
        controller.setRadioActive(true)

        controller.stop()

        assertEquals(1, facade.focusAbandons)
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node scripts/build-android.js :app:testDebugUnitTest`
Expected: FAIL — `expected:<1> but was:<0>`, nothing requests focus.

- [ ] **Step 3: Add the focus bookkeeping**

In `AudioRouteController.kt`, add the state:

```kotlin
    private var focusHeld = false
    private var pttHeld = false
    private var radioActive = false
```

Add the method:

```kotlin
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
```

Call it from the three inputs (each already posts onto the route thread):

```kotlin
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
```

and in `stop()`, before `facade.stop()`:

```kotlin
        pttHeld = false
        radioActive = false
        updateFocus()
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node scripts/build-android.js :app:testDebugUnitTest`
Expected: PASS — six `AudioRouteControllerFocusTest` cases plus everything before.

- [ ] **Step 5: Run the task gate**

```bash
pnpm typecheck && pnpm lint && pnpm test && \
node scripts/build-android.js :app:testDebugUnitTest && \
pnpm build:android
```

Expected: all five commands exit 0.

- [ ] **Step 6: Commit**

```bash
git add android/app/src/main/java/com/oru/radio/AudioRouteController.kt \
        android/app/src/test/java/com/oru/radio/AudioRouteControllerFocusTest.kt
git commit -m "feat(android): duck other apps with per-burst transient audio focus"
```

---

## Task 7: Stream survival — `AudioEngine` rebuilds instead of dying

**Files:**
- Create: `android/app/src/main/java/com/oru/radio/AudioStreamGuard.kt`
- Create: `android/app/src/test/java/com/oru/radio/AudioStreamGuardTest.kt`
- Modify: `android/app/src/main/java/com/oru/radio/AudioEngine.kt`
- Modify: `android/app/src/main/java/com/oru/radio/RadioPorts.kt`
- Modify: `android/app/src/test/java/com/oru/radio/TestDoubles.kt`

**Interfaces:**
- Consumes: `ModePolicy.Profile`, `RadioConfig.AUDIO_MAX_CONSECUTIVE_IO_ERRORS`.
- Produces: `class AudioStreamGuard(maxConsecutiveErrors: Int = RadioConfig.AUDIO_MAX_CONSECUTIVE_IO_ERRORS)`
  with `fun needsRebuild(generation: Int): Boolean`, `fun onError(): Boolean`,
  `fun onSuccess()`; `AudioIo.onRouteChanged(profile: ModePolicy.Profile)`;
  `FakeAudioIo.routeChanges: MutableList<ModePolicy.Profile>`.

- [ ] **Step 1: Write the failing test**

Create `android/app/src/test/java/com/oru/radio/AudioStreamGuardTest.kt`:

```kotlin
package com.oru.radio

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Section 6 "Streams survive route changes", as the bookkeeping the two audio loops share.
 * The loops themselves own real AudioRecord/AudioTrack objects and cannot run on the JVM;
 * every decision they make is here instead.
 */
class AudioStreamGuardTest {

    @Test
    fun `the first generation always builds`() {
        assertTrue(AudioStreamGuard().needsRebuild(0))
    }

    @Test
    fun `an unchanged generation is not rebuilt`() {
        val guard = AudioStreamGuard()
        guard.needsRebuild(0)

        assertFalse(guard.needsRebuild(0))
        assertFalse(guard.needsRebuild(0))
    }

    @Test
    fun `a new generation rebuilds`() {
        val guard = AudioStreamGuard()
        guard.needsRebuild(0)

        assertTrue(guard.needsRebuild(1))
    }

    @Test
    fun `the fatal threshold is reached only on a stable route`() {
        val guard = AudioStreamGuard(maxConsecutiveErrors = 3)
        guard.needsRebuild(0)

        assertFalse(guard.onError())
        assertFalse(guard.onError())
        assertTrue(guard.onError())
    }

    @Test
    fun `a route change clears the error run`() {
        val guard = AudioStreamGuard(maxConsecutiveErrors = 3)
        guard.needsRebuild(0)
        guard.onError()
        guard.onError()

        // Section 6: "the consecutive-error counter resets on route transitions, and the fatal
        // threshold applies only while the route is stable" -- a switch must never kill the radio.
        guard.needsRebuild(1)

        assertFalse(guard.onError())
        assertFalse(guard.onError())
        assertTrue(guard.onError())
    }

    @Test
    fun `a good read clears the error run`() {
        val guard = AudioStreamGuard(maxConsecutiveErrors = 2)
        guard.needsRebuild(0)
        guard.onError()
        guard.onSuccess()

        assertFalse(guard.onError())
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node scripts/build-android.js :app:testDebugUnitTest`
Expected: FAIL — `Unresolved reference: AudioStreamGuard`.

- [ ] **Step 3: Write the guard**

Create `android/app/src/main/java/com/oru/radio/AudioStreamGuard.kt`:

```kotlin
package com.oru.radio

/**
 * Section 6 "Streams survive route changes", as pure bookkeeping shared by the capture and
 * playback loops.
 *
 * A route or profile change bumps a generation counter in [AudioEngine]; each loop compares it
 * once per iteration and rebuilds its `AudioRecord`/`AudioTrack` when it moved (their
 * attributes differ per profile anyway). Rebuilding also clears the consecutive-error run, so
 * the fatal threshold of spec section 13 can only be reached while the route is stable — a
 * route change mid-stream can no longer escalate to `microphone_read_failed` /
 * `speaker_write_failed` and kill the radio.
 *
 * One instance per loop; both are confined to their own thread.
 */
class AudioStreamGuard(
    private val maxConsecutiveErrors: Int = RadioConfig.AUDIO_MAX_CONSECUTIVE_IO_ERRORS,
) {

    private var builtGeneration: Int? = null
    private var consecutiveErrors = 0

    /**
     * True when the stream must be built for [generation] — including the very first time.
     * Clears the error run, because the errors belonged to the route that just went away.
     */
    fun needsRebuild(generation: Int): Boolean {
        if (generation == builtGeneration) return false
        builtGeneration = generation
        consecutiveErrors = 0
        return true
    }

    /** True once the run has reached the fatal threshold on this generation. */
    fun onError(): Boolean {
        consecutiveErrors++
        return consecutiveErrors >= maxConsecutiveErrors
    }

    fun onSuccess() {
        consecutiveErrors = 0
    }
}
```

- [ ] **Step 4: Add the port method**

In `android/app/src/main/java/com/oru/radio/RadioPorts.kt`, add to `AudioIo` after
`setFailureListener`:

```kotlin
    /**
     * Section 6: the applied route or profile changed. Capture and playback rebuild their
     * `AudioRecord`/`AudioTrack` at the next loop iteration with [profile]'s attributes and
     * reset their consecutive-error counters. Called from the engine's scheduler thread; the
     * audio threads observe it through volatile state, never by blocking.
     */
    fun onRouteChanged(profile: ModePolicy.Profile)
```

In `android/app/src/test/java/com/oru/radio/TestDoubles.kt`, add to `FakeAudioIo`:

```kotlin
    val routeChanges = mutableListOf<ModePolicy.Profile>()

    override fun onRouteChanged(profile: ModePolicy.Profile) {
        routeChanges.add(profile)
    }
```

- [ ] **Step 5: Rebuild the streams in `AudioEngine`**

In `android/app/src/main/java/com/oru/radio/AudioEngine.kt`:

Add the volatile route state next to `capturing`/`playing`:

```kotlin
    /**
     * Bumped by [onRouteChanged] on the engine's scheduler thread and read once per iteration
     * by each audio thread. An `Int` write is atomic and `@Volatile` makes it visible; the two
     * fields are written together and read independently, so a loop can briefly rebuild with
     * the previous profile — the very next bump fixes it, and a route change is already a
     * glitch boundary.
     */
    @Volatile private var routeGeneration = 0
    @Volatile private var routeProfile: ModePolicy.Profile = ModePolicy.Profile.VOICE

    override fun onRouteChanged(profile: ModePolicy.Profile) {
        routeProfile = profile
        routeGeneration++
        Log.i(TAG, "audio: route changed, streams rebuild on the next frame (profile=$profile)")
    }
```

Extract the two stream constructors:

```kotlin
    /** VOICE_COMMUNICATION in both profiles (§6 capture row): the route decides the mic. */
    private fun openRecord(): AudioRecord? {
        val minimum = AudioRecord.getMinBufferSize(
            RadioConfig.SAMPLE_RATE_HZ,
            AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_16BIT,
        )
        val bufferBytes = maxOf(
            minimum,
            RadioConfig.FRAME_SAMPLES * BYTES_PER_SAMPLE * RadioConfig.AUDIO_BUFFER_FRAMES,
        )
        val record = AudioRecord(
            MediaRecorder.AudioSource.VOICE_COMMUNICATION,
            RadioConfig.SAMPLE_RATE_HZ,
            AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_16BIT,
            bufferBytes,
        )
        if (record.state != AudioRecord.STATE_INITIALIZED) {
            record.release()
            Log.e(TAG, "AudioRecord did not initialize")
            onFailure?.invoke("microphone_unavailable", "AudioRecord did not initialize")
            return null
        }
        return record
    }

    /**
     * Section 6's playback row. VOICE plays on the voice-communication path, which follows the
     * communication device; MEDIA plays as navigation guidance on the media path, which mixes
     * into A2DP instead of dragging the headset onto SCO.
     */
    private fun openTrack(profile: ModePolicy.Profile): AudioTrack {
        val usage = when (profile) {
            ModePolicy.Profile.VOICE -> AudioAttributes.USAGE_VOICE_COMMUNICATION
            ModePolicy.Profile.MEDIA -> AudioAttributes.USAGE_ASSISTANCE_NAVIGATION_GUIDANCE
        }
        val minimum = AudioTrack.getMinBufferSize(
            RadioConfig.SAMPLE_RATE_HZ,
            AudioFormat.CHANNEL_OUT_MONO,
            AudioFormat.ENCODING_PCM_16BIT,
        )
        return AudioTrack.Builder()
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(usage)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build(),
            )
            .setAudioFormat(
                AudioFormat.Builder()
                    .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                    .setSampleRate(RadioConfig.SAMPLE_RATE_HZ)
                    .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                    .build(),
            )
            .setBufferSizeInBytes(
                maxOf(
                    minimum,
                    RadioConfig.FRAME_SAMPLES * BYTES_PER_SAMPLE * RadioConfig.AUDIO_BUFFER_FRAMES,
                ),
            )
            .setTransferMode(AudioTrack.MODE_STREAM)
            .build()
    }

    private fun releaseRecord(record: AudioRecord?) {
        if (record == null) return
        runCatching { record.stop() }
        record.release()
    }

    private fun releaseTrack(track: AudioTrack?) {
        if (track == null) return
        runCatching { track.stop() }
        track.release()
    }
```

Replace the body of `captureLoop` between `Process.setThreadPriority(...)` and the `catch`
with the rebuilding version:

```kotlin
        val guard = AudioStreamGuard()
        var record: AudioRecord? = null
        var encoder: OpusEncoder? = null
        try {
            encoder = OpusEncoder()
            val pcm = ShortArray(RadioConfig.FRAME_SAMPLES)
            val encoded = ByteArray(RadioConfig.MAX_ENCODED_FRAME_BYTES)

            while (capturing) {
                if (guard.needsRebuild(routeGeneration)) {
                    releaseRecord(record)
                    record = openRecord() ?: return
                    record.startRecording()
                }
                val active = record ?: return
                var offset = 0
                var readFailed = false
                while (offset < pcm.size && capturing) {
                    val read = active.read(pcm, offset, pcm.size - offset)
                    if (read < 0) {
                        readFailed = true
                        break
                    }
                    if (read == 0) break
                    offset += read
                }
                if (readFailed) {
                    // A single bad read is tolerated (the hardware can hiccup, and a route
                    // change is a hiccup); only a persistent run on a stable route means the
                    // device is dead. Looping on that at MAX_PRIORITY with no backoff is the
                    // spin spec section 13 forbids.
                    if (guard.onError()) {
                        Log.e(TAG, "AudioRecord.read failed repeatedly")
                        onFailure?.invoke("microphone_read_failed", "AudioRecord.read failed repeatedly")
                        break
                    }
                    continue
                }
                guard.onSuccess()
                if (offset < pcm.size) continue

                val length = encoder.encode(pcm, RadioConfig.FRAME_SAMPLES, encoded)
                if (length > 0) sink.writeFrame(encoded.copyOf(length))
            }
        } catch (error: Exception) {
            Log.e(TAG, "capture stopped on an error", error)
            onFailure?.invoke("capture_failed", error.message ?: error.javaClass.simpleName)
        } finally {
            releaseRecord(record)
            encoder?.close()
        }
```

Replace the body of `playbackLoop` the same way:

```kotlin
        val guard = AudioStreamGuard()
        var track: AudioTrack? = null
        try {
            val mixed = ShortArray(RadioConfig.FRAME_SAMPLES)
            val ready = ArrayList<ShortArray>(4)

            while (playing) {
                if (guard.needsRebuild(routeGeneration)) {
                    releaseTrack(track)
                    track = openTrack(routeProfile)
                    track.play()
                }
                val active = track ?: return
                ready.clear()
                for (playback in playbacks.values) {
                    val frame = playback.jitter.pop() ?: continue
                    val samples = playback.decodeInto(frame, frame.size)
                    if (samples > 0) {
                        ready.add(
                            if (samples == RadioConfig.FRAME_SAMPLES) playback.pcm
                            else playback.pcm.copyOf(samples),
                        )
                    }
                }
                AudioMixer.mix(ready, mixed)
                val written = active.write(mixed, 0, mixed.size)
                if (written < 0) {
                    if (guard.onError()) {
                        Log.e(TAG, "AudioTrack.write failed repeatedly")
                        onFailure?.invoke("speaker_write_failed", "AudioTrack.write failed repeatedly")
                        break
                    }
                } else {
                    guard.onSuccess()
                }
            }
        } catch (error: Exception) {
            Log.e(TAG, "playback stopped on an error", error)
            onFailure?.invoke("playback_failed", error.message ?: error.javaClass.simpleName)
        } finally {
            releaseTrack(track)
        }
```

Keep every existing comment in those two loops that still applies (the reused `playback.pcm`
note, the blocking-write pacing note, the orphaned-capture-thread note in `startCapture`).

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node scripts/build-android.js :app:testDebugUnitTest`
Expected: PASS — six `AudioStreamGuardTest` cases; `RadioEngineTest` still green (the new
`AudioIo` method has a `FakeAudioIo` implementation).

- [ ] **Step 7: Run the task gate**

```bash
pnpm typecheck && pnpm lint && pnpm test && \
node scripts/build-android.js :app:testDebugUnitTest && \
pnpm build:android
```

Expected: all five commands exit 0.

- [ ] **Step 8: Commit**

```bash
git add android/app/src/main/java/com/oru/radio/AudioStreamGuard.kt \
        android/app/src/main/java/com/oru/radio/AudioEngine.kt \
        android/app/src/main/java/com/oru/radio/RadioPorts.kt \
        android/app/src/test/java/com/oru/radio/AudioStreamGuardTest.kt \
        android/app/src/test/java/com/oru/radio/TestDoubles.kt
git commit -m "feat(android): rebuild capture and playback across route and profile changes"
```

---

## Task 8: The flip — engine wiring, the service extraction, and `audioMode` storage

**Files:**
- Modify: `android/app/src/main/java/com/oru/radio/RadioState.kt`
- Modify: `android/app/src/main/java/com/oru/radio/RadioEngine.kt`
- Modify: `android/app/src/main/java/com/oru/radio/HandlerScheduler.kt`
- Modify: `android/app/src/main/java/com/oru/radio/RadioForegroundService.kt`
- Create: `android/app/src/main/java/com/oru/radio/AudioModeStore.kt`
- Modify: `android/app/src/main/AndroidManifest.xml` (one stale comment)
- Modify: `android/app/src/test/java/com/oru/radio/TestDoubles.kt`
- Modify: `android/app/src/test/java/com/oru/radio/RadioEngineTest.kt`
- Modify: `android/app/src/test/java/com/oru/radio/RadioStateTest.kt`

**Interfaces:**
- Consumes: `AudioRouting`, `AudioRouteListener`, `AudioRouteController`,
  `AndroidAudioManagerFacade`, `AndroidRouteLogger`, `AudioIo.onRouteChanged`,
  `audioModeFromWire`, `ModePolicy.AudioMode.wire()`.
- Produces: `RadioState.audioRoute: AudioRoute` and `RadioState.audioMode: ModePolicy.AudioMode`
  (both with defaults, both in `toMap()`); `RadioEngine(transport, audio, ptt, routing,
  scheduler, streamIds)` implementing `AudioRouteListener`, with the new public
  `fun setAudioMode(mode: ModePolicy.AudioMode)`; `interface AudioModeStore { fun load():
  ModePolicy.AudioMode; fun save(mode: ModePolicy.AudioMode) }` and
  `class SharedPreferencesAudioModeStore(context: Context) : AudioModeStore`;
  `HandlerScheduler.handler(): Handler`; `FakeAudioRouting`.

- [ ] **Step 1: Write the failing tests**

Add to `android/app/src/test/java/com/oru/radio/TestDoubles.kt`:

```kotlin
class FakeAudioRouting : AudioRouting {
    var listener: AudioRouteListener? = null
    var started = false
    var stopped = false
    var pressCount = 0
    var releaseCount = 0
    val radioActive = mutableListOf<Boolean>()
    val audioModes = mutableListOf<ModePolicy.AudioMode>()

    /**
     * Answers a press with an immediate grant, the way any route with a live mic does. Set to
     * false to hold the press in the raise, which is the section 7 path a Bluetooth Classic
     * headset on the MEDIA profile takes.
     */
    var autoGrant = true

    override fun start(listener: AudioRouteListener) {
        this.listener = listener
        started = true
    }

    override fun stop() {
        stopped = true
    }

    override fun setAudioMode(mode: ModePolicy.AudioMode) {
        audioModes.add(mode)
    }

    override fun setRadioActive(active: Boolean) {
        radioActive.add(active)
    }

    override fun onPttPressed() {
        pressCount++
        if (autoGrant) grant()
    }

    override fun onPttReleased() {
        releaseCount++
    }

    fun grant(mic: ModePolicy.MicSource = ModePolicy.MicSource.ROUTE_DEFAULT) {
        listener?.onCaptureGranted(mic)
    }

    fun publish(route: AudioRoute) {
        listener?.onAudioRouteChanged(route)
    }
}
```

In `android/app/src/test/java/com/oru/radio/RadioEngineTest.kt`, add the field and
construction, then the new cases:

```kotlin
    private lateinit var routing: FakeAudioRouting
    // in setUp(), before the engine:
    //     routing = FakeAudioRouting()
    //     engine = RadioEngine(transport, audio, ptt, routing, scheduler, streamIds = { "stream-1" })

    @Test
    fun `a press waits for the capture grant before opening a stream`() {
        engine.startRadio()
        routing.autoGrant = false

        engine.startTransmit()

        // Section 7: press, then tone, then talk. Peers never hear the 1-3 s of an SCO raise.
        assertEquals(1, routing.pressCount)
        assertTrue(transport.openedStreams.isEmpty())
        assertFalse(listener.last.transmitting)

        routing.grant()

        assertEquals(listOf("stream-1"), transport.openedStreams)
        assertTrue(audio.capturing)
        assertTrue(listener.last.transmitting)
    }

    @Test
    fun `a release before the grant never opens a stream`() {
        engine.startRadio()
        routing.autoGrant = false
        engine.startTransmit()

        engine.stopTransmit()
        routing.grant()

        assertEquals(1, routing.releaseCount)
        assertTrue(transport.openedStreams.isEmpty())
        assertFalse(listener.last.transmitting)
    }

    @Test
    fun `radio activity is reported to the routing`() {
        engine.startRadio()

        engine.onIncomingAudioStarted("peer-1", "s")
        engine.onIncomingAudioStopped("peer-1", "s")

        // Section 7 queues mode switches for idle, so the policy needs both edges and no
        // duplicates in between.
        assertEquals(listOf(true, false), routing.radioActive)
    }

    @Test
    fun `a published route lands in the state and rebuilds the streams`() {
        engine.startRadio()
        val route = AudioRoute(AudioRoute.Kind.BLUETOOTH, "Buds Pro", ModePolicy.Profile.MEDIA)

        routing.publish(route)

        assertEquals(route, listener.last.audioRoute)
        assertEquals(listOf(ModePolicy.Profile.MEDIA), audio.routeChanges)
    }

    @Test
    fun `the audio mode pin is forwarded and published`() {
        engine.startRadio()

        engine.setAudioMode(ModePolicy.AudioMode.MEDIA)

        assertEquals(listOf(ModePolicy.AudioMode.MEDIA), routing.audioModes)
        assertEquals(ModePolicy.AudioMode.MEDIA, listener.last.audioMode)
    }

    @Test
    fun `stopping the radio keeps the pin and releases the routing`() {
        engine.startRadio()
        engine.setAudioMode(ModePolicy.AudioMode.VOICE)

        engine.stopRadio()

        assertTrue(routing.stopped)
        assertEquals(ModePolicy.AudioMode.VOICE, listener.last.audioMode)
    }
```

Add to `android/app/src/test/java/com/oru/radio/RadioStateTest.kt`:

```kotlin
    @Test
    fun `toMap carries the audio route and the pin`() {
        val map = RadioState(
            audioRoute = AudioRoute(AudioRoute.Kind.BLUETOOTH, "Buds Pro", ModePolicy.Profile.MEDIA),
            audioMode = ModePolicy.AudioMode.MEDIA,
        ).toMap()

        assertEquals(
            mapOf("kind" to "bluetooth", "label" to "Buds Pro", "mode" to "media"),
            map["audioRoute"],
        )
        assertEquals("media", map["audioMode"])
    }

    @Test
    fun `a route with no label omits the key entirely`() {
        @Suppress("UNCHECKED_CAST")
        val route = RadioState().toMap()["audioRoute"] as Map<String, Any?>

        assertEquals("speaker", route["kind"])
        assertEquals("voice", route["mode"])
        assertFalse(route.containsKey("label"))
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node scripts/build-android.js :app:testDebugUnitTest`
Expected: FAIL — `RadioEngine` has no `routing` parameter, `RadioState` has no `audioRoute`.

- [ ] **Step 3: Extend `RadioState`**

In `RadioState.kt`, append the two fields **after** `pttPairing` (appending keeps every
existing positional construction valid) and extend `toMap()`:

```kotlin
data class RadioState(
    val status: RadioStatus = RadioStatus.STARTING,
    val nearbyCount: Int = 0,
    val transmitting: Boolean = false,
    val receiving: Boolean = false,
    val pttButton: PttButtonState = PttButtonState(),
    /** Non-null only while a pairing session is running (contract amendment 2026-08-14). */
    val pttPairing: PttPairingState? = null,
    /** Spec section 8. Always present: there is always a route in use. */
    val audioRoute: AudioRoute = AudioRoute(),
    /** Spec section 8's persisted pin, published back so JavaScript mirrors the engine. */
    val audioMode: ModePolicy.AudioMode = ModePolicy.AudioMode.AUTO,
) {
```

and inside `toMap()`, after the `pttButton` entry and before the `pttPairing` block:

```kotlin
        put("audioRoute", audioRoute.toMap())
        put("audioMode", audioMode.wire())
```

- [ ] **Step 4: Wire the engine**

In `RadioEngine.kt`:

```kotlin
class RadioEngine(
    private val transport: Transport,
    private val audio: AudioIo,
    private val ptt: PttSource,
    private val routing: AudioRouting,
    private val scheduler: Scheduler,
    private val streamIds: () -> String = { UUID.randomUUID().toString() },
) : TransportListener, PttListener, AudioRouteListener {
```

Add the scheduler-confined field beside `currentStreamId`:

```kotlin
    /** A press whose capture the section 7 policy has not granted yet. */
    private var transmitRequested = false
```

`startRadio()` — add after `audio.setFailureListener { ... }`:

```kotlin
        routing.start(this)
```

`stopRadio()` — add before `audio.release()`, and keep the pin across the reset:

```kotlin
        routing.stop()
        ...
        update { RadioState(audioMode = it.audioMode) }
```

Replace `startTransmitNow` and `stopTransmitNow`, and add `beginCapture`:

```kotlin
    /**
     * Section 7: a press asks the routing for permission, it does not take it. The transport
     * stream opens in [beginCapture], once the grant tone has played — so peers never receive
     * the 1–3 s of an SCO raise as dead air, and the UI never claims to be transmitting into
     * a microphone that is not live yet.
     */
    private fun startTransmitNow() {
        if (!running || state.status == RadioStatus.ERROR) return
        if (currentStreamId != null || transmitRequested) return
        transmitRequested = true
        routing.onPttPressed()
    }

    private fun beginCapture(mic: ModePolicy.MicSource) {
        if (!transmitRequested || currentStreamId != null) return
        if (!running || state.status == RadioStatus.ERROR) {
            transmitRequested = false
            return
        }
        val streamId = streamIds()
        val sink = transport.openTransmission(streamId)
        currentStreamId = streamId
        currentSink = sink
        audio.startCapture(sink)
        // Stuck-button protection (spec section 9.4) starts with the audio, not with the press:
        // a raise that takes 3 s must not eat 3 s of the 120 s budget.
        safetyCap = scheduler.schedule(RadioConfig.MAX_TRANSMIT_MS) { stopTransmitNow() }
        update { it.copy(transmitting = true) }
    }

    private fun stopTransmitNow() {
        val wasRequested = transmitRequested
        transmitRequested = false
        // Every press must be answered by exactly one release, including the presses that
        // never became a transmission — the policy has no watchdog on an unreleased one.
        if (wasRequested) routing.onPttReleased()
        val streamId = currentStreamId ?: return
        safetyCap?.cancel()
        safetyCap = null
        currentSink?.close()
        currentSink = null
        audio.stopCapture()
        currentStreamId = null
        transport.closeTransmission(streamId)
        update { it.copy(transmitting = false) }
    }
```

Add the routing callbacks and the pin:

```kotlin
    // --- routing callbacks ----------------------------------------------------------------

    override fun onAudioRouteChanged(route: AudioRoute) = scheduler.execute {
        // Section 6 stream survival: the streams rebuild on the next frame with this
        // profile's attributes, and their error runs reset.
        audio.onRouteChanged(route.mode)
        update { it.copy(audioRoute = route) }
    }

    override fun onCaptureGranted(mic: ModePolicy.MicSource) = scheduler.execute {
        beginCapture(mic)
    }

    /** Section 8's pin. Persisted by the bridge; applied here. */
    fun setAudioMode(mode: ModePolicy.AudioMode) = scheduler.execute {
        routing.setAudioMode(mode)
        update { it.copy(audioMode = mode) }
    }
```

Feed radio activity from the one place state changes:

```kotlin
    private fun update(transform: (RadioState) -> RadioState) {
        val next = transform(state)
        if (next == state) return
        val wasActive = state.receiving || state.transmitting
        state = next
        val isActive = next.receiving || next.transmitting
        // Section 7 queues mode switches for radio-idle; this is the edge it queues on.
        if (isActive != wasActive) routing.setRadioActive(isActive)
        listeners.forEach { it.onStateChanged(next) }
    }
```

- [ ] **Step 5: Add the `audioMode` store**

Create `android/app/src/main/java/com/oru/radio/AudioModeStore.kt`:

```kotlin
package com.oru.radio

import android.content.Context

/**
 * Spec section 8's persisted setting, stored natively exactly as [PttBindingStore] is: no JS
 * storage dependency exists, and the pin must survive a radio restart.
 */
interface AudioModeStore {
    fun load(): ModePolicy.AudioMode
    fun save(mode: ModePolicy.AudioMode)
}

class SharedPreferencesAudioModeStore(context: Context) : AudioModeStore {

    private companion object {
        const val FILE = "oru.audio"
        const val KEY = "mode"
    }

    private val preferences =
        context.applicationContext.getSharedPreferences(FILE, Context.MODE_PRIVATE)

    /** An absent or unrecognised value is section 8's `auto` default. */
    override fun load(): ModePolicy.AudioMode = audioModeFromWire(preferences.getString(KEY, null))

    override fun save(mode: ModePolicy.AudioMode) {
        preferences.edit().putString(KEY, mode.wire()).apply()
    }
}
```

- [ ] **Step 6: Expose the route thread's handler**

In `HandlerScheduler.kt`, add:

```kotlin
    /**
     * The handler backing this scheduler, for the platform APIs that take one directly
     * (`registerAudioDeviceCallback`, `registerReceiver`, `registerAudioPlaybackCallback`).
     * Registering against it is what makes a platform callback arrive on this scheduler's own
     * thread instead of the main one.
     */
    fun handler(): Handler = handler
```

- [ ] **Step 7: Cut the routing out of the service**

Rewrite `android/app/src/main/java/com/oru/radio/RadioForegroundService.kt` as below. Every
routing member is deleted: `ROUTE_MIC_TO_HEADSET`, `MAX_COMMUNICATION_DEVICE_REASSERTS`,
`MODE_RETRY_LIMIT`, `MODE_RETRY_DELAY_MS`, `ROUTE_ESTABLISH_TIMEOUT_MS`, the HFP proxy block
(now in the facade), `communicationModeWanted`, `communicationDeviceId`, `scoStarted`,
`scoConfirmed`, `scoRouteTarget`, `scoStateReceiver`, `audioFocusRequest`, `commDeviceListener`,
**`failedHeadsetKeys`** (§11's "Android deletes: the blacklist"), `reassertCount`,
`routeEstablishTimeout`, `modeRetryCount`, `mainHandler`, `deviceCallback`,
`setCommunicationMode`, `applyAudioMode`, `findExternalMicrophone`,
`isTrustedBluetoothMicrophone`, `micPreference`, `routeCommunicationTo`, `startLegacySco`,
`stopLegacySco`, `scoPending`, `armRouteEstablishTimeout`, `cancelRouteEstablishTimeout`,
`failHeadsetRouting`, `registerCommunicationDeviceListener`,
`unregisterCommunicationDeviceListener`, `registerScoStateReceiver`,
`unregisterScoStateReceiver`, `onScoAudioStateChanged`, `scoStateName`,
`onPlatformCommunicationDeviceChanged`, `requestRadioAudioFocus`, `abandonRadioAudioFocus`,
`deviceKey`, `deviceAddress`, `describeDevice`, `deviceTypeName`, `modeName`,
`focusResultName`, `focusChangeName`, `hasExternalPlaybackDevice`.

```kotlin
package com.oru.radio

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.SystemClock
import android.util.Log
import com.oru.R

/**
 * Spec section 10.1: the radio lives in a foreground service with the microphone and
 * connectedDevice types, so it keeps running while the RN Activity is destroyed and while the
 * screen is locked.
 *
 * Routing is not this class's job any more. Section 6 of the 2026-08-18 headphone design moved
 * every audio decision into [AudioRouteController], which runs on its own `audio-route` thread
 * and is driven by [RadioEngine]; this service only builds the objects and owns their threads.
 */
class RadioForegroundService : Service() {

    companion object {
        const val ACTION_START = "com.oru.radio.action.START"
        const val ACTION_STOP = "com.oru.radio.action.STOP"
        private const val CHANNEL_ID = "oru.radio"
        private const val NOTIFICATION_ID = 1
        private const val TAG = "OruRadio"
    }

    private var scheduler: HandlerScheduler? = null
    private var routeScheduler: HandlerScheduler? = null
    private var engine: RadioEngine? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()

        val scheduler = HandlerScheduler()
        // Section 6: a dedicated HandlerThread("audio-route"); every platform callback is
        // registered against its handler and every controller entry point posts onto it, so
        // the route state machine is single-threaded by construction.
        val routeScheduler = HandlerScheduler("audio-route")
        val routing = AudioRouteController(
            facade = AndroidAudioManagerFacade(this, routeScheduler.handler()),
            scheduler = routeScheduler,
            // Monotonic, never a wall clock: a system time change must not move a dwell deadline.
            clock = SystemClock::elapsedRealtime,
            policy = ModePolicy(),
            logger = AndroidRouteLogger(),
        )
        val engine = RadioEngine(
            transport = NearbyManager(this, Build.MODEL ?: "Android", scheduler),
            audio = AudioEngine(),
            ptt = PttManager(
                SharedPreferencesPttBindingStore(this),
                AndroidPttDriverFactory(this),
                scheduler,
            ),
            routing = routing,
            scheduler = scheduler,
        )
        // A task that throws its way out of either thread would otherwise unwind Looper.loop()
        // and kill the process; both schedulers catch it and report it here, the one
        // unrecoverable-failure path of spec section 13.
        scheduler.setUncaughtHandler { error ->
            engine.failFromHost("engine_task_failed", error.message ?: error.javaClass.simpleName)
        }
        routeScheduler.setUncaughtHandler { error ->
            engine.failFromHost(
                "audio_route_task_failed",
                error.message ?: error.javaClass.simpleName,
            )
        }
        this.scheduler = scheduler
        this.routeScheduler = routeScheduler
        this.engine = engine
        RadioController.attach(engine)
        // Section 8: the pin is stored natively and applies from the first state the bridge
        // ever publishes, not from the first time JavaScript sets it.
        engine.setAudioMode(SharedPreferencesAudioModeStore(this).load())
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            // A service started with startForegroundService() must call startForeground()
            // shortly after, even on the path that immediately tears it back down again.
            startForegroundWithTypes()
            engine?.stopRadio()
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
            return START_NOT_STICKY
        }
        if (!startForegroundWithTypes()) {
            engine?.failFromHost(
                "foreground_service_denied",
                "The radio may not run in the foreground; are the microphone and Bluetooth permissions granted?",
            )
            stopSelf()
            return START_NOT_STICKY
        }
        engine?.startRadio()
        Log.i(TAG, "radio service started")
        return START_STICKY
    }

    override fun onDestroy() {
        engine?.stopRadio()
        RadioController.detach()
        // Shut both threads down from inside themselves, and the route thread from inside the
        // engine thread: stopRadio() posted `routing.stop()` onto the route queue from the
        // engine queue, so this ordering guarantees the shutdown lands behind it.
        val route = routeScheduler
        scheduler?.let { current ->
            current.execute {
                route?.execute { route.shutdown() }
                current.shutdown()
            }
        }
        engine = null
        scheduler = null
        routeScheduler = null
        Log.i(TAG, "radio service stopped")
        super.onDestroy()
    }

    private fun createNotificationChannel() {
        val channel = NotificationChannel(
            CHANNEL_ID,
            getString(R.string.radio_notification_channel_name),
            NotificationManager.IMPORTANCE_LOW,
        )
        getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
    }

    /**
     * Returns false when the platform refused the foreground service. From Android 14 a
     * `microphone` type without RECORD_AUDIO granted, or `connectedDevice` without the
     * Bluetooth permissions, throws; every one of those would otherwise propagate out of
     * `onStartCommand` and take the service down with no state, no error event and no log.
     */
    private fun startForegroundWithTypes(): Boolean {
        val notification = Notification.Builder(this, CHANNEL_ID)
            .setContentTitle(getString(R.string.radio_notification_title))
            .setContentText(getString(R.string.radio_notification_text))
            .setSmallIcon(android.R.drawable.stat_sys_speakerphone)
            .setOngoing(true)
            .build()

        return try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(
                    NOTIFICATION_ID,
                    notification,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE or
                        ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE,
                )
            } else {
                startForeground(NOTIFICATION_ID, notification)
            }
            true
        } catch (error: SecurityException) {
            Log.e(TAG, "the foreground service was refused", error)
            false
        } catch (error: IllegalStateException) {
            Log.e(TAG, "the foreground service was refused", error)
            false
        }
    }
}
```

In `android/app/src/main/AndroidManifest.xml`, the `MODIFY_AUDIO_SETTINGS` comment names the
deleted method. Replace the sentence

`…the radio never gets the shared echo-cancelled voice route or the call-stream volume keys it asks for in RadioForegroundService.setCommunicationMode().`

with

`…the radio never gets the shared echo-cancelled voice route or the call-stream volume keys it asks for in AudioRouteController.applyProfile().`

- [ ] **Step 8: Run the tests to verify they pass**

Run: `node scripts/build-android.js :app:testDebugUnitTest`
Expected: PASS — the six new `RadioEngineTest` cases, the two new `RadioStateTest` cases, and
the whole existing suite.

- [ ] **Step 9: Run the task gate**

```bash
pnpm typecheck && pnpm lint && pnpm test && \
node scripts/build-android.js :app:testDebugUnitTest && \
pnpm build:android
```

Expected: all five commands exit 0. `pnpm build:android` is the check that matters most here —
it is what compiles the rewritten service against the deleted members.

- [ ] **Step 10: Commit**

```bash
git add android/app/src/main/java/com/oru/radio/RadioState.kt \
        android/app/src/main/java/com/oru/radio/RadioEngine.kt \
        android/app/src/main/java/com/oru/radio/HandlerScheduler.kt \
        android/app/src/main/java/com/oru/radio/RadioForegroundService.kt \
        android/app/src/main/java/com/oru/radio/AudioModeStore.kt \
        android/app/src/main/AndroidManifest.xml \
        android/app/src/test/java/com/oru/radio/TestDoubles.kt \
        android/app/src/test/java/com/oru/radio/RadioEngineTest.kt \
        android/app/src/test/java/com/oru/radio/RadioStateTest.kt
git commit -m "refactor(android): move routing out of the service into AudioRouteController"
```

---

## Task 9: The bridge — real `audioRoute`, real `setAudioMode`

**Files:**
- Modify: `android/app/src/main/java/com/oru/bridge/RadioBridgeCore.kt`
- Modify: `android/app/src/main/java/com/oru/bridge/NativeRadioModule.kt`
- Modify: `android/app/src/test/java/com/oru/bridge/RadioBridgeCoreTest.kt`

**Interfaces:**
- Consumes: `RadioState.audioRoute`/`audioMode` and `RadioState.toMap()` (Task 8);
  `AudioModeStore`, `SharedPreferencesAudioModeStore`, `audioModeFromWire`,
  `ModePolicy.AudioMode.wire()`, `RadioEngine.setAudioMode` (Task 8); the merged
  `specs/NativeRadio.ts` contract — `audioRoute: {kind, label?, mode}` and
  `audioMode: 'auto' | 'voice' | 'media'` on every state, `setAudioMode(mode: string)`.
  **No file under `src/` or `specs/` is touched.**
- Produces: `RadioBridgeCore(output, storedConfiguration, storedAudioMode: () -> ModePolicy.AudioMode)`.

- [ ] **Step 1: Write the failing test**

In `android/app/src/test/java/com/oru/bridge/RadioBridgeCoreTest.kt`, delete the two
placeholder tests (`every projection carries the placeholder audio route and mode` and `the
placeholder route never carries a label`) and the `route()` helper's comment about
placeholders, then add the imports `com.oru.radio.AudioRoute` and `com.oru.radio.ModePolicy`,
change the `core(...)` helper, and add the real cases:

```kotlin
    private fun core(
        output: RadioBridgeOutput,
        configuration: () -> PttConfiguration? = { null },
        audioMode: () -> ModePolicy.AudioMode = { ModePolicy.AudioMode.AUTO },
    ) = RadioBridgeCore(output, configuration, audioMode)

    @Suppress("UNCHECKED_CAST")
    private fun Map<String, Any?>.route(): Map<String, Any?> =
        this["audioRoute"] as Map<String, Any?>

    @Test
    fun `a running engine's real route and pin cross the bridge`() {
        val output = RecordingOutput()
        val core = core(output)
        core.start()

        core.onEngineState(
            RadioState(
                status = RadioStatus.READY,
                audioRoute = AudioRoute(
                    AudioRoute.Kind.BLUETOOTH,
                    "Buds Pro",
                    ModePolicy.Profile.MEDIA,
                ),
                audioMode = ModePolicy.AudioMode.MEDIA,
            ),
        )

        assertEquals("bluetooth", output.last().route()["kind"])
        assertEquals("Buds Pro", output.last().route()["label"])
        assertEquals("media", output.last().route()["mode"])
        assertEquals("media", output.last()["audioMode"])
    }

    @Test
    fun `a route with no label omits the key, never sends null`() {
        val output = RecordingOutput()
        val core = core(output)
        core.start()

        core.onEngineState(RadioState(status = RadioStatus.READY))

        assertEquals("speaker", output.last().route()["kind"])
        assertEquals("voice", output.last().route()["mode"])
        assertFalse(output.last().route().containsKey("label"))
    }

    @Test
    fun `off, starting and error report the loudspeaker and the stored pin`() {
        val output = RecordingOutput()
        val stored = core(output, audioMode = { ModePolicy.AudioMode.VOICE })

        // Off: no engine to ask, so the honest answer is the loudspeaker and the pin as saved.
        assertEquals("speaker", stored.snapshot().route()["kind"])
        assertEquals("voice", stored.snapshot()["audioMode"])

        stored.start()
        assertEquals("speaker", output.last().route()["kind"])
        assertEquals("voice", output.last()["audioMode"])

        stored.startFailed("boom", "the service would not start")
        assertEquals("error", output.last()["status"])
        assertEquals("voice", output.last()["audioMode"])
    }
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node scripts/build-android.js :app:testDebugUnitTest`
Expected: FAIL — `RadioBridgeCore` takes two arguments, not three; the projected route is the
placeholder.

- [ ] **Step 3: Make the projection real**

In `RadioBridgeCore.kt`:

Delete `PLACEHOLDER_AUDIO_ROUTE`, `PLACEHOLDER_AUDIO_MODE` and their KDoc entirely. Add the
imports `com.oru.radio.AudioRoute`, `com.oru.radio.ModePolicy` and `com.oru.radio.wire`.

Change the constructor:

```kotlin
class RadioBridgeCore(
    private val output: RadioBridgeOutput,
    private val storedConfiguration: () -> PttConfiguration?,
    /**
     * Spec section 8's pin, read from the native store. The engine publishes its own copy
     * while it is running; this is what the `off`, `starting` and `error` projections
     * report, so a JavaScript context that attaches to a powered-down radio still mirrors
     * the setting the user chose.
     */
    private val storedAudioMode: () -> ModePolicy.AudioMode,
) {
```

Simplify `project()` back to the four branches, with no appended constants:

```kotlin
    private fun project(): Map<String, Any?> {
        val state = lastEngineState
        return when {
            failed -> offState() + ("status" to "error")
            !running -> offState()
            state == null -> offState() + ("status" to "starting")
            else -> withoutNulls(state.toMap())
        }
    }
```

Extend `offState()`:

```kotlin
        return mapOf(
            "status" to "off",
            "nearbyCount" to 0,
            "transmitting" to false,
            "receiving" to false,
            "pttButton" to button,
            // Nothing is running, so nothing is routed anywhere: the loudspeaker on the voice
            // profile is the honest pre-start answer, and it is what the engine's own default
            // RadioState reports too.
            "audioRoute" to AudioRoute().toMap(),
            "audioMode" to storedAudioMode().wire(),
        )
```

- [ ] **Step 4: Implement `setAudioMode`**

In `NativeRadioModule.kt`, add the store and pass it to the core:

```kotlin
    private val audioModeStore = SharedPreferencesAudioModeStore(reactContext)

    private val core = RadioBridgeCore(
        output = object : RadioBridgeOutput {
            override fun emitState(state: Map<String, Any?>) = publishState(state)
            override fun emitError(code: String, message: String) = publishError(code, message)
        },
        storedConfiguration = { store.load() },
        storedAudioMode = { audioModeStore.load() },
    )
```

with the imports `com.oru.radio.SharedPreferencesAudioModeStore` and
`com.oru.radio.audioModeFromWire`, and replace the stub:

```kotlin
    /**
     * Spec section 8. Stores the pin natively (the `PttBindingStore` pattern) and applies it.
     *
     * `radio.native.ts` narrows the string on the way in, but an unknown value still degrades
     * to `auto` rather than throwing across the bridge.
     *
     * With the radio off there is no engine to apply it to, so the store write plus a
     * re-publish is the whole operation — the same shape `forgetPtt` uses. With the radio on,
     * the engine publishes the new pin through `onStateChanged` as it applies it; a pin set to
     * the value it already had changes no state and therefore emits nothing, which is correct:
     * the JavaScript mirror already holds that value.
     */
    override fun setAudioMode(mode: String, promise: Promise) {
        attach()
        val parsed = audioModeFromWire(mode)
        audioModeStore.save(parsed)
        val engine = RadioController.engine()
        if (engine == null) core.refresh() else engine.setAudioMode(parsed)
        promise.resolve(null)
    }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node scripts/build-android.js :app:testDebugUnitTest`
Expected: PASS — the whole Kotlin suite, including the rewritten `RadioBridgeCoreTest`.

- [ ] **Step 6: Run the task gate**

```bash
pnpm typecheck && pnpm lint && pnpm test && \
node scripts/build-android.js :app:testDebugUnitTest && \
pnpm build:android
```

Expected: all five commands exit 0. `pnpm test` covers the merged JS contract tests, which
must be unaffected — this plan changed no JavaScript.

- [ ] **Step 7: Commit**

```bash
git add android/app/src/main/java/com/oru/bridge/RadioBridgeCore.kt \
        android/app/src/main/java/com/oru/bridge/NativeRadioModule.kt \
        android/app/src/test/java/com/oru/bridge/RadioBridgeCoreTest.kt
git commit -m "feat(android): publish the real audio route and persist the audioMode pin"
```

---

## Done when

- `AudioRouteController` owns every §6 decision, on its own thread, behind a faked
  `AudioManager`; `RadioForegroundService` contains no routing code and no
  `failedHeadsetKeys`.
- The §10 Android test list is green: connect/disconnect/reconnect, SCO timeout + bounded
  retries + counter resets, debounce, noisy, watch filter, "audio flows on the old route while
  SCO establishes", mode-policy transitions, focus request/abandon pairing — plus
  `RadioBridgeCoreTest` on the real bridge mapping.
- `ModePolicy.kt`, `ModePolicyTest.kt`, everything under `src/`, `specs/` and `ios/` are
  untouched by every commit of this plan (`git diff --stat feature/offline-nearby-ptt` shows
  only `android/` and this document).
- The §9 behavior table and the §10 hardware checklist remain closeout items; the
  instrumentation that makes them measurable (`route: applied … sinceDeviceEventMs=`) is in.
