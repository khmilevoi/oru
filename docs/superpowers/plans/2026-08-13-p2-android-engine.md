# P2 — Android RadioEngine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the entire Android radio — Nearby transport, Opus audio pipeline, PTT drivers, foreground service and native spike hooks — so that two Android devices exchange voice with no React Native involved.

**Architecture:** One `RadioEngine` state machine owns all radio state and is driven through four ports it does not implement: `Transport` (Nearby Connections), `AudioIo` (AudioRecord/libopus/AudioTrack), `PttSource` (BLE/HID/media-button drivers) and `Scheduler` (the engine's single thread). Everything with real logic — the control-message codec, the audio framing, the state machine, the jitter buffer, the mixer, the backoff, the binding codec, the learning state machine — is a plain Kotlin class with no Android imports and is covered by JVM unit tests; everything that touches the Android framework is a thin adapter behind one of those ports. `RadioForegroundService` owns the engine so the radio survives the death of the RN Activity, and debug-only spike hooks drive the whole thing over `adb` for the Phase 0 gate.

**Tech Stack:** Kotlin 2.2 · Android minSdk 26 / compileSdk 37 / targetSdk 36 · Google Play Services Nearby Connections 19.4.0 (`P2P_CLUSTER`) · libopus 1.5.2 built from source by CMake + NDK 27.1.12297006 · AudioRecord/AudioTrack · JUnit 4.13.2 JVM unit tests · React Native 0.87 host app (untouched by this plan except for Gradle wiring).

**Spec:** `docs/superpowers/specs/2026-08-13-offline-nearby-ptt-design.md` — sections §6, §6.3, §7, §8, §9, §10.1, §13, §15 (Phase 0 + Stage 1).

## Global Constraints

Every task's requirements implicitly include this section.

**Gates**

- **Task gate (run at the end of every task, verbatim from the schedule):**
  `pnpm typecheck && pnpm lint && pnpm test <paths>` (+ `pnpm build:android` when the task
  touched `android/`). **Every task in this plan touches `android/`**, so every task runs
  `pnpm build:android` as well.
- **Merge gate:** `pnpm typecheck && pnpm lint && pnpm test && pnpm build:android`.
- **Known flakes (verbatim from the schedule):** none known — greenfield repository. Two
  standing environment caveats: (1) the first Gradle / NDK / CMake / dependency downloads are
  slow and can time out — a download failure or timeout is infrastructure, not a regression;
  re-run once before reporting. (2) Swift is never compiled by any gate on this Windows host —
  a green merge gate is **not** evidence of iOS health; iOS compilation happens only at
  closeout on macOS.
- **Kotlin unit tests are not part of `pnpm test`.** `pnpm test` is Jest and only sees
  JavaScript/TypeScript. The Kotlin tests this plan writes are run with
  `pnpm build:android :app:testDebugUnitTest`, which forwards the Gradle task through
  `scripts/build-android.js` (verified: `pnpm <script> <arg>` forwards `<arg>` without `--`).
  Each task that adds Kotlin logic runs that command as its own TDD step, *in addition to* the
  task gate above.

**Spec values that must appear exactly as written (§5, §7, §8, §9)**

- Minimum Android: `minSdk 26` (already set in `android/build.gradle`; do not change).
- Audio: PCM **16 kHz**, **mono**, Opus **20 ms** frames at **~24 kbps**, jitter buffer of
  **2–3 frames** (40–60 ms). All of these live in **one** config object (`RadioConfig.kt`) so
  field tests retune without touching logic.
- Capture source: `MediaRecorder.AudioSource.VOICE_COMMUNICATION` (system AEC/NS).
- Codec: **embedded libopus**, built from source. Platform codecs are forbidden.
- Transport: Nearby Connections, strategy **`P2P_CLUSTER`**, simultaneous advertise +
  discover, automatic connection acceptance, no peer-selection UI.
- Control messages are **reliable BYTES payloads carrying JSON**; audio is a **separate STREAM
  payload, one per transmission (press → release)**, fanned out to each connected peer.
- `hello` version mismatch → disconnect that peer gracefully and ignore it.
- **Transmit safety cap: transmission auto-stops after 120 s of continuous hold.**
- Reconnect is **fully native** with backoff; JS is never involved.
- Errors: unrecoverable → `error { code, message }` event **and** `status: 'error'`.
  Recoverable conditions (peer lost, button disconnected) are **state**, not errors (§13). A
  failed *pairing* emits the `error` event but must **not** move the radio into
  `status: 'error'` — the radio itself is still working.
- **Contract amendment of 2026-08-14** (resolves the contradiction between §9.3's
  "scan → pick" flow and §6.1's argument-free `configurePtt()`; binding on both engines):
  all seven §6.1 methods keep their signatures, `configurePtt()` is redefined as "opens the
  native pairing session and resolves when the binding is saved", exactly one method is added
  — `selectPttCandidate(deviceId: string): Promise<void>` — and pairing progress is published
  through the **existing** `stateChanged` event by one optional `RadioState` field:
  ```ts
  pttPairing?: {
    phase: 'scanning' | 'learning' | 'saved'
    candidates: Array<{ deviceId: string; name: string; rssi: number }>
  }
  ```
  absent whenever no pairing session is running, so `screenState` and resume re-sync via
  `getState()` are untouched. Cancel and timeout surface through the existing `error` event;
  `forgetPtt()` is untouched. The user's pick in the RN pairing UI is the product behaviour;
  a strongest-signal auto-pick would be a native safety net only and is **not** implemented
  here — the engine only sorts candidates strongest-first.
- The engine must not import, reference or depend on React Native, JSI or any JS runtime type
  (§6, §18). `android/app/src/main/java/com/oru/radio/**` must contain no `com.facebook.*`
  import.

**Ownership boundary (from the schedule)**

- **This plan owns:** everything under `android/app/src/main/java/com/oru/radio/`,
  `android/app/src/debug/`, the new `android/opus/` Gradle module, the Android radio entries in
  `android/app/build.gradle` / `android/settings.gradle` / `android/app/src/main/AndroidManifest.xml`,
  Android `res/values*/strings.xml` radio strings, `__tests__/android-radio.test.ts`, and
  `docs/phase0-android-spike-hooks.md`.
- **Not here:** the iOS mirror → P3 · the TypeScript layer (`src/`, `specs/`) → P4 · the
  `RadioNative` Turbo Module and `MainApplication` registration → P5 · screens → P6 · runtime
  permission sequencing and app wiring → P7 · the concrete purchased button's protocol →
  closeout (Stage 5). **Do not edit `package.json`, `src/`, `specs/`, `ios/`, `App.tsx`,
  `index.js`, or `android/app/src/main/java/com/oru/MainActivity.kt` /
  `MainApplication.kt`** — P3, P4 and P5 own those and a conflict at sync 2 is a decomposition
  violation.

**Host environment facts (agents run in fresh shells — none of this is in the environment)**

- Android SDK: `C:\Users\Khmil\AppData\Local\Android\Sdk`. `ANDROID_HOME` is **not** set;
  `scripts/build-android.js` resolves the SDK and the JDK itself. Always build through
  `pnpm build:android`, never by calling `gradlew` directly.
- Installed and ready: NDK `27.1.12297006`, CMake `3.22.1`. JDK: Android Studio JBR.
- **Windows path budget.** `scripts/build-android.js` `subst`s a short drive onto the repo root
  and points CMake's `buildStagingDirectory` at `C:\b` through `ORU_CXX_DIR`; the measured
  remaining margin is **~14 characters**. That margin is consumed only by native sources CMake
  reaches from **outside** its `CMakeLists.txt` tree. Everything this plan compiles is inside
  its own CMakeLists tree (libopus is unpacked into the CMake binary directory by
  `FetchContent`, whose object paths stay relative and short), so the margin is not spent. Do
  not reference native sources by long absolute paths.

## Cross-plan interfaces

**What this plan produces for P5 (`bridge`) — do not change these names later:**

```kotlin
package com.oru.radio

object RadioController {
    fun start(context: Context)                       // starts RadioForegroundService
    fun stop(context: Context)
    fun engine(): RadioEngine?                        // null until the service is running
    fun addListener(listener: RadioEngineListener)    // buffered until the service attaches
    fun removeListener(listener: RadioEngineListener)
}

class RadioEngine {
    fun getState(): RadioState                        // §6.1 getState()
    fun startTransmit()                               // §6.1 pressPtt()   — the same path the button takes
    fun stopTransmit()                                // §6.1 releasePtt()
    fun startPttPairing()                             // §6.1 configurePtt()
    fun selectPttCandidate(deviceId: String)          // §6.1 selectPttCandidate(deviceId)
    fun cancelPttPairing()
    fun forgetPtt()                                   // §6.1 forgetPtt()
}
// §6.1 start()/stop() are RadioController.start(context) / RadioController.stop(context):
// the radio lives in the foreground service, so starting it means starting the service.
//
// How P5 fulfils the amended §6.1 promises:
//   configurePtt()          -> startPttPairing(), resolve when a stateChanged arrives with
//                              pttPairing.phase == "saved"; reject on the error event
//   selectPttCandidate(id)  -> selectPttCandidate(id), resolve immediately
// Pairing progress travels on the existing stateChanged event only; there is no second
// event type and no callback argument.

data class RadioState(...) { fun toMap(): Map<String, Any?> }   // exactly the §6.1 RadioState shape

interface RadioEngineListener {
    fun onStateChanged(state: RadioState)
    fun onError(code: String, message: String)
}
```

**What P3 (`ios-engine`) must mirror byte for byte** — the Phase 0 scenarios are
Android↔iPhone, so these are interop-critical and the spec does not fix them:

| Item | Value chosen here |
|---|---|
| Nearby Service ID | `com.oru.radio` |
| Control payload | reliable BYTES, compact UTF-8 JSON, keys exactly `type`, `version`, `streamId` (§7) |
| Protocol version | `1` |
| Audio stream framing | per Opus packet: **2-byte big-endian unsigned length**, then that many bytes. No other header, no trailer. |
| Max encoded frame | 400 bytes (a receiver rejects a length outside `1..400` and closes the stream) |
| PCM | 16 kHz, mono, signed 16-bit little-endian, 320 samples (640 bytes) per 20 ms frame |
| Opus | `OPUS_APPLICATION_VOIP`, bitrate 24000, one frame per packet |

**What P4 (`ts-domain`) mirrors in TypeScript:** the `ControlMessage` JSON shapes above and the
`PttBinding` shape below. `PttBinding.pressedValue` / `releasedValue` are the raw BLE
characteristic bytes as **uppercase hex with no separators** (e.g. `"01"`, `"0100"`);
`deviceId` is the BLE MAC address as reported by `BluetoothDevice.getAddress()`
(e.g. `"AA:BB:CC:DD:EE:FF"`); `serviceUuid` / `characteristicUuid` are lowercase 128-bit UUID
strings.

## File Structure

**New Gradle module — libopus (Task 2)**

| File | Responsibility |
|---|---|
| `android/opus/build.gradle` | `com.android.library` module that compiles the native code; nothing else |
| `android/opus/src/main/cpp/CMakeLists.txt` | fetches pinned libopus 1.5.2 and builds `liboru_opus.so` |
| `android/opus/src/main/cpp/opus_jni.c` | the whole JNI surface: encoder/decoder create, encode, decode, destroy |

**Engine — `android/app/src/main/java/com/oru/radio/` (package `com.oru.radio`, flat, per spec §17)**

| File | Responsibility |
|---|---|
| `RadioConfig.kt` | every tunable number in one object (§8) |
| `ReconnectBackoff.kt` | pure exponential backoff with reset |
| `ControlMessage.kt` | `hello` / `tx-start` / `tx-stop` sealed type + JSON codec |
| `AudioFraming.kt` | length-prefixed frame reader/writer for the STREAM payload |
| `RadioState.kt` | the §6.1 state shape (including the amended `pttPairing` field) + `toMap()` |
| `RadioPorts.kt` | `Scheduler`, `Cancellable`, `Transport`, `TransmissionSink`, `TransportListener`, `AudioIo`, `PttSource`, `PttListener`, `RadioEngineListener` |
| `RadioEngine.kt` | the state machine: §6.3 operations, 120 s cap, listener fan-out |
| `HandlerScheduler.kt` | the one real `Scheduler`, backed by a `HandlerThread` |
| `NearbyManager.kt` | `Transport` over Nearby Connections |
| `JitterBuffer.kt` | pure 2–3 frame jitter buffer with underrun handling |
| `AudioMixer.kt` | pure PCM mixing with saturation |
| `OpusCodec.kt` | Kotlin binding to `liboru_opus.so` |
| `AudioEngine.kt` | `AudioIo`: AudioRecord → Opus → sink; stream → jitter → Opus → mix → AudioTrack |
| `PttBinding.kt` | `PttBinding` / `PttConfiguration` types + JSON codec |
| `PttBindingStore.kt` | persistence port + SharedPreferences implementation |
| `PttLearningStateMachine.kt` | pure pressed/released value capture |
| `PttManager.kt` | `PttSource`: picks the driver for the stored binding, runs the learning flow |
| `BleGattPttDriver.kt` | GATT notify driver, auto-reconnecting |
| `HidPttDriver.kt` | key-code driver fed from any `KeyEvent` source |
| `MediaButtonPttDriver.kt` | MediaSession media-button driver |
| `RadioForegroundService.kt` | foreground service (`microphone` + `connectedDevice`) that owns the engine |
| `RadioController.kt` | process-wide handle to the service and engine (the P5 seam) |

**Debug-only spike hooks — `android/app/src/debug/` (Task 11)**

| File | Responsibility |
|---|---|
| `android/app/src/debug/AndroidManifest.xml` | declares the two hooks, debug variant only |
| `android/app/src/debug/java/com/oru/radio/SpikeActivity.kt` | starts/stops the radio without React Native |
| `android/app/src/debug/java/com/oru/radio/SpikeReceiver.kt` | `adb`-driven PTT, state dump, PTT pairing |

**Kotlin unit tests — `android/app/src/test/java/com/oru/radio/`**

`TestDoubles.kt`, `ReconnectBackoffTest.kt`, `ControlMessageCodecTest.kt`, `AudioFramingTest.kt`,
`RadioStateTest.kt`, `RadioEngineTest.kt`, `JitterBufferTest.kt`, `AudioMixerTest.kt`,
`PttBindingCodecTest.kt`, `PttManagerTest.kt`, `PttLearningStateMachineTest.kt`.

**Shared/edited elsewhere**

`android/settings.gradle` (add `:opus`), `android/app/build.gradle` (dependencies, test
options), `android/app/src/main/AndroidManifest.xml` (the service), `android/app/src/main/res/values/strings.xml`
and new `values-ru/strings.xml`, `__tests__/android-radio.test.ts` (grown by Tasks 1, 2, 5, 10,
11), `docs/phase0-android-spike-hooks.md`.

---

### Task 1: Kotlin unit-test harness, `RadioConfig`, `ReconnectBackoff`

The whole plan depends on being able to run Kotlin tests. This task establishes that path and
uses it immediately for the first piece of real logic.

**Files:**
- Modify: `android/app/build.gradle` (add `testOptions` inside `android { }`, add
  `testImplementation` dependencies)
- Create: `android/app/src/main/java/com/oru/radio/RadioConfig.kt`
- Create: `android/app/src/main/java/com/oru/radio/ReconnectBackoff.kt`
- Test: `android/app/src/test/java/com/oru/radio/ReconnectBackoffTest.kt`
- Test: `__tests__/android-radio.test.ts`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: `object RadioConfig` with `const val PROTOCOL_VERSION: Int`, `SERVICE_ID: String`,
  `SAMPLE_RATE_HZ: Int`, `CHANNEL_COUNT: Int`, `FRAME_MS: Int`, `BITRATE_BPS: Int`,
  `FRAME_SAMPLES: Int`, `MAX_ENCODED_FRAME_BYTES: Int`, `JITTER_TARGET_FRAMES: Int`,
  `JITTER_MIN_FRAMES: Int`, `JITTER_CAPACITY_FRAMES: Int`, `MAX_TRANSMIT_MS: Long`,
  `PAIRING_TIMEOUT_MS: Long`, `RECONNECT_INITIAL_DELAY_MS: Long`,
  `RECONNECT_MAX_DELAY_MS: Long`, `RECONNECT_MULTIPLIER: Int`; and
  `class ReconnectBackoff(initialDelayMs: Long, maxDelayMs: Long, multiplier: Int)` with
  `fun nextDelayMs(): Long` and `fun reset()`.

- [ ] **Step 1: Wire the Kotlin unit-test source set**

In `android/app/build.gradle`, inside the existing `android { }` block, immediately after the
`externalNativeBuild { ... }` block, add:

```groovy
    testOptions {
        unitTests {
            // Android framework classes are stubs on the JVM classpath and throw by
            // default. Everything this plan unit-tests is deliberately free of the
            // Android framework; returning defaults keeps an accidental framework call
            // from failing with a confusing "not mocked" stack instead of an assertion.
            returnDefaultValues = true
        }
    }
```

and replace the whole `dependencies { }` block at the bottom of the file with:

```groovy
dependencies {
    // The version of react-native is set by the React Native Gradle Plugin
    implementation("com.facebook.react:react-android")

    if (hermesEnabled.toBoolean()) {
        implementation("com.facebook.react:hermes-android")
    } else {
        implementation jscFlavor
    }

    testImplementation("junit:junit:4.13.2")
    // The real org.json implementation. android.jar's org.json is a stub on the unit
    // test classpath and AGP puts android.jar last, so this one wins and the control
    // message codec is testable on the JVM exactly as it behaves on a device.
    testImplementation("org.json:json:20250517")
}
```

- [ ] **Step 2: Write the failing Kotlin test**

Create `android/app/src/test/java/com/oru/radio/ReconnectBackoffTest.kt`:

```kotlin
package com.oru.radio

import org.junit.Assert.assertEquals
import org.junit.Test

class ReconnectBackoffTest {

    @Test
    fun `first delay is the initial delay`() {
        val backoff = ReconnectBackoff(initialDelayMs = 1_000, maxDelayMs = 30_000, multiplier = 2)

        assertEquals(1_000L, backoff.nextDelayMs())
    }

    @Test
    fun `delays double until they reach the cap and then stay there`() {
        val backoff = ReconnectBackoff(initialDelayMs = 1_000, maxDelayMs = 30_000, multiplier = 2)

        val delays = (1..8).map { backoff.nextDelayMs() }

        assertEquals(
            listOf(1_000L, 2_000L, 4_000L, 8_000L, 16_000L, 30_000L, 30_000L, 30_000L),
            delays,
        )
    }

    @Test
    fun `reset returns to the initial delay`() {
        val backoff = ReconnectBackoff(initialDelayMs = 1_000, maxDelayMs = 30_000, multiplier = 2)
        repeat(4) { backoff.nextDelayMs() }

        backoff.reset()

        assertEquals(1_000L, backoff.nextDelayMs())
    }

    @Test
    fun `the default constructor uses the radio config values`() {
        val backoff = ReconnectBackoff()

        assertEquals(RadioConfig.RECONNECT_INITIAL_DELAY_MS, backoff.nextDelayMs())
    }
}
```

- [ ] **Step 3: Run the Kotlin test to verify it fails**

Run: `pnpm build:android :app:testDebugUnitTest`

Expected: FAIL — Kotlin compilation error, `Unresolved reference: ReconnectBackoff`.
(The very first run in a fresh worktree downloads Gradle and its dependencies and can take
many minutes; a download timeout is infrastructure, not a failure — re-run once.)

- [ ] **Step 4: Write `RadioConfig`**

Create `android/app/src/main/java/com/oru/radio/RadioConfig.kt`:

```kotlin
package com.oru.radio

/**
 * Every tunable number of the radio, in one place (spec section 8): field tests retune
 * values here and no logic anywhere else changes.
 */
object RadioConfig {

    /** Bumped whenever the wire protocol changes; peers with another version are ignored. */
    const val PROTOCOL_VERSION = 1

    /** Shared Nearby Connections service id. iOS must advertise exactly this string. */
    const val SERVICE_ID = "com.oru.radio"

    const val SAMPLE_RATE_HZ = 16_000
    const val CHANNEL_COUNT = 1
    const val FRAME_MS = 20
    const val BITRATE_BPS = 24_000

    /** 16 kHz * 20 ms = 320 samples per mono frame (640 bytes of PCM 16). */
    const val FRAME_SAMPLES = SAMPLE_RATE_HZ / 1_000 * FRAME_MS

    /** Upper bound for one encoded 20 ms Opus packet, well above 24 kbps (60 bytes). */
    const val MAX_ENCODED_FRAME_BYTES = 400

    /** Playback starts once this many frames are buffered (3 frames = 60 ms). */
    const val JITTER_TARGET_FRAMES = 3

    /** After an underrun, playback resumes at this many frames (2 frames = 40 ms). */
    const val JITTER_MIN_FRAMES = 2

    /** Hard ceiling on buffered frames; the oldest are dropped past it. */
    const val JITTER_CAPACITY_FRAMES = 25

    /** Stuck-button protection: a held transmission stops itself after 120 s. */
    const val MAX_TRANSMIT_MS = 120_000L

    /**
     * A pairing session that neither saves a binding nor is cancelled gives up after this
     * long and reports the timeout as an error event (contract amendment of 2026-08-14).
     */
    const val PAIRING_TIMEOUT_MS = 60_000L

    const val RECONNECT_INITIAL_DELAY_MS = 1_000L
    const val RECONNECT_MAX_DELAY_MS = 30_000L
    const val RECONNECT_MULTIPLIER = 2
}
```

- [ ] **Step 5: Write `ReconnectBackoff`**

Create `android/app/src/main/java/com/oru/radio/ReconnectBackoff.kt`:

```kotlin
package com.oru.radio

/**
 * Exponential backoff for native reconnection (spec section 7): a lost peer is retried
 * with a growing delay, and a successful connection resets the sequence.
 */
class ReconnectBackoff(
    private val initialDelayMs: Long = RadioConfig.RECONNECT_INITIAL_DELAY_MS,
    private val maxDelayMs: Long = RadioConfig.RECONNECT_MAX_DELAY_MS,
    private val multiplier: Int = RadioConfig.RECONNECT_MULTIPLIER,
) {
    private var nextDelay: Long = initialDelayMs

    fun nextDelayMs(): Long {
        val delay = nextDelay
        nextDelay = minOf(nextDelay * multiplier, maxDelayMs)
        return delay
    }

    fun reset() {
        nextDelay = initialDelayMs
    }
}
```

- [ ] **Step 6: Run the Kotlin test to verify it passes**

Run: `pnpm build:android :app:testDebugUnitTest`
Expected: PASS — `BUILD SUCCESSFUL`, 4 tests executed, 0 failures. If Gradle reports
`Task :app:testDebugUnitTest NO-SOURCE`, the test source set is in the wrong directory — it
must be exactly `android/app/src/test/java/com/oru/radio/`.

- [ ] **Step 7: Write the failing JavaScript test**

Create `__tests__/android-radio.test.ts`:

```ts
import {existsSync, readFileSync} from 'fs';
import {join} from 'path';

const REPO_ROOT = join(__dirname, '..');
const RADIO_DIR = 'android/app/src/main/java/com/oru/radio';

const read = (relative: string): string =>
  readFileSync(join(REPO_ROOT, relative), 'utf8');

describe('android radio audio parameters (spec section 8)', () => {
  const config = () => read(`${RADIO_DIR}/RadioConfig.kt`);

  it('keeps every codec parameter in one config file', () => {
    expect(existsSync(join(REPO_ROOT, RADIO_DIR, 'RadioConfig.kt'))).toBe(true);
  });

  it.each([
    ['SAMPLE_RATE_HZ', '16_000'],
    ['CHANNEL_COUNT', '1'],
    ['FRAME_MS', '20'],
    ['BITRATE_BPS', '24_000'],
    ['JITTER_TARGET_FRAMES', '3'],
    ['JITTER_MIN_FRAMES', '2'],
    ['MAX_TRANSMIT_MS', '120_000L'],
    ['PROTOCOL_VERSION', '1'],
  ])('pins %s to %s', (name, value) => {
    expect(config()).toMatch(
      new RegExp(`const val ${name} = ${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`),
    );
  });

  it('advertises the shared nearby service id', () => {
    expect(config()).toMatch(/const val SERVICE_ID = "com\.oru\.radio"/);
  });
});

describe('android engine build wiring', () => {
  const appGradle = () => read('android/app/build.gradle');

  it('runs Kotlin unit tests from the app module', () => {
    expect(appGradle()).toMatch(/testImplementation\("junit:junit:4\.13\.2"\)/);
    expect(appGradle()).toMatch(/testImplementation\("org\.json:json:\d+"\)/);
    expect(appGradle()).toMatch(/returnDefaultValues = true/);
  });
});
```

- [ ] **Step 8: Run the JavaScript test**

Run: `pnpm test __tests__/android-radio.test.ts`
Expected: PASS (the Kotlin and Gradle files it asserts on were written in steps 1–5). If it
fails, the constants or the Gradle edit do not match the spec values — fix the source, not the
test.

- [ ] **Step 9: Run the task gate**

Run: `pnpm typecheck && pnpm lint && pnpm test __tests__/android-radio.test.ts && pnpm build:android`
Expected: all four green.

- [ ] **Step 10: Commit**

```bash
git add android/app/build.gradle android/app/src/main/java/com/oru/radio android/app/src/test __tests__/android-radio.test.ts
git commit -m "feat(android): add the Kotlin unit test harness, radio config and reconnect backoff"
```

---

### Task 2: libopus built from source, and its JNI binding

**Files:**
- Create: `android/opus/build.gradle`
- Create: `android/opus/src/main/cpp/CMakeLists.txt`
- Create: `android/opus/src/main/cpp/opus_jni.c`
- Create: `android/app/src/main/java/com/oru/radio/OpusCodec.kt`
- Modify: `android/settings.gradle` (add `include ':opus'`)
- Modify: `android/app/build.gradle` (add `implementation project(':opus')`)
- Test: `__tests__/android-radio.test.ts` (append a describe block)

**Interfaces:**
- Consumes: `RadioConfig.SAMPLE_RATE_HZ`, `CHANNEL_COUNT`, `BITRATE_BPS`, `FRAME_SAMPLES`,
  `MAX_ENCODED_FRAME_BYTES` (Task 1).
- Produces:
  ```kotlin
  class OpusEncoder(sampleRateHz: Int, channels: Int, bitrateBps: Int) : Closeable {
      fun encode(pcm: ShortArray, frameSamples: Int, out: ByteArray): Int  // bytes written, -1 on error
      override fun close()
  }
  class OpusDecoder(sampleRateHz: Int, channels: Int) : Closeable {
      fun decode(packet: ByteArray?, length: Int, pcm: ShortArray, frameSamples: Int): Int // samples
      override fun close()
  }
  ```
  Task 7 (`AudioEngine`) is the only consumer.

- [ ] **Step 1: Create the native module's Gradle file**

Create `android/opus/build.gradle`:

```groovy
apply plugin: "com.android.library"

/**
 * libopus and its JNI wrapper, built from source (spec section 8: embedded libopus,
 * platform codecs are not used).
 *
 * This is a separate Gradle module on purpose: the app module's externalNativeBuild is
 * owned by the React Native Gradle Plugin, and the radio's codec has no business inside
 * it. Nothing here depends on React Native.
 */
android {
    namespace "com.oru.opus"
    ndkVersion rootProject.ext.ndkVersion
    buildToolsVersion rootProject.ext.buildToolsVersion
    compileSdk rootProject.ext.compileSdkVersion

    defaultConfig {
        minSdkVersion rootProject.ext.minSdkVersion
    }

    externalNativeBuild {
        cmake {
            path "src/main/cpp/CMakeLists.txt"
            version "3.22.1"
            // Same Windows MAX_PATH lever as the app module: scripts/build-android.js
            // exports ORU_CXX_DIR, and this module gets its own subdirectory under it so
            // the two modules never stage objects into the same tree. Unset everywhere
            // else, where the default .cxx is fine.
            buildStagingDirectory System.getenv('ORU_CXX_DIR')
                ? file("${System.getenv('ORU_CXX_DIR')}/opus")
                : file('.cxx')
        }
    }
}
```

- [ ] **Step 2: Create the CMake build for libopus**

Create `android/opus/src/main/cpp/CMakeLists.txt`:

```cmake
cmake_minimum_required(VERSION 3.22)
project(OruOpus LANGUAGES C)

include(FetchContent)

# Pinned libopus release. The hash was taken from the canonical HTTPS download on
# 2026-08-14. For an offline build, point ORU_OPUS_URL at a local copy:
#   -DORU_OPUS_URL=file:///C:/somewhere/opus-1.5.2.tar.gz
# The same file is mirrored at
#   https://github.com/xiph/opus/releases/download/v1.5.2/opus-1.5.2.tar.gz
set(ORU_OPUS_URL
    "https://downloads.xiph.org/releases/opus/opus-1.5.2.tar.gz"
    CACHE STRING "libopus release tarball")
set(ORU_OPUS_SHA256
    "65c1d2f78b9f2fb20082c38cbe47c951ad5839345876e46941612ee87f9a7ce1"
    CACHE STRING "SHA-256 of ORU_OPUS_URL")

# Static libopus, no programs, no tests, no install rules: this build produces exactly
# one artifact, liboru_opus.so, with libopus linked into it. Fixed point is the right
# choice for phones and is what mobile Opus builds use.
set(OPUS_BUILD_SHARED_LIBRARY OFF CACHE BOOL "" FORCE)
set(OPUS_BUILD_PROGRAMS OFF CACHE BOOL "" FORCE)
set(OPUS_BUILD_TESTING OFF CACHE BOOL "" FORCE)
set(OPUS_INSTALL_PKG_CONFIG_MODULE OFF CACHE BOOL "" FORCE)
set(OPUS_INSTALL_CMAKE_CONFIG_MODULE OFF CACHE BOOL "" FORCE)
set(OPUS_FIXED_POINT ON CACHE BOOL "" FORCE)

FetchContent_Declare(
    opus
    URL ${ORU_OPUS_URL}
    URL_HASH SHA256=${ORU_OPUS_SHA256}
)
FetchContent_MakeAvailable(opus)

add_library(oru_opus SHARED opus_jni.c)
target_link_libraries(oru_opus PRIVATE opus log)
```

- [ ] **Step 3: Write the JNI wrapper**

Create `android/opus/src/main/cpp/opus_jni.c`:

```c
/*
 * The entire native surface of the radio: create/encode/decode/destroy. No audio
 * policy lives here -- frame sizes, bitrate and sample rate are passed in from
 * RadioConfig.kt so section 8's "codec parameters live in a single config" holds.
 *
 * Method names must stay in sync with com.oru.radio.OpusCodec.
 */
#include <jni.h>
#include <stdint.h>
#include <stdlib.h>
#include <opus.h>

#define ORU_FN(name) Java_com_oru_radio_OpusCodec_##name

JNIEXPORT jlong JNICALL
ORU_FN(nativeCreateEncoder)(JNIEnv *env, jclass clazz, jint sampleRate, jint channels, jint bitrate) {
    (void) env;
    (void) clazz;
    int error = OPUS_OK;
    OpusEncoder *encoder = opus_encoder_create(sampleRate, channels, OPUS_APPLICATION_VOIP, &error);
    if (error != OPUS_OK || encoder == NULL) {
        return 0;
    }
    opus_encoder_ctl(encoder, OPUS_SET_BITRATE(bitrate));
    opus_encoder_ctl(encoder, OPUS_SET_SIGNAL(OPUS_SIGNAL_VOICE));
    opus_encoder_ctl(encoder, OPUS_SET_INBAND_FEC(1));
    opus_encoder_ctl(encoder, OPUS_SET_PACKET_LOSS_PERC(10));
    return (jlong) (intptr_t) encoder;
}

JNIEXPORT jint JNICALL
ORU_FN(nativeEncode)(JNIEnv *env, jclass clazz, jlong handle, jshortArray pcm, jint frameSamples, jbyteArray out) {
    (void) clazz;
    OpusEncoder *encoder = (OpusEncoder *) (intptr_t) handle;
    if (encoder == NULL) {
        return -1;
    }
    jshort *pcmBuffer = (*env)->GetShortArrayElements(env, pcm, NULL);
    jbyte *outBuffer = (*env)->GetByteArrayElements(env, out, NULL);
    jint capacity = (*env)->GetArrayLength(env, out);

    int written = opus_encode(encoder, (const opus_int16 *) pcmBuffer, frameSamples,
                              (unsigned char *) outBuffer, capacity);

    (*env)->ReleaseShortArrayElements(env, pcm, pcmBuffer, JNI_ABORT);
    (*env)->ReleaseByteArrayElements(env, out, outBuffer, 0);
    return written < 0 ? -1 : written;
}

JNIEXPORT void JNICALL
ORU_FN(nativeDestroyEncoder)(JNIEnv *env, jclass clazz, jlong handle) {
    (void) env;
    (void) clazz;
    OpusEncoder *encoder = (OpusEncoder *) (intptr_t) handle;
    if (encoder != NULL) {
        opus_encoder_destroy(encoder);
    }
}

JNIEXPORT jlong JNICALL
ORU_FN(nativeCreateDecoder)(JNIEnv *env, jclass clazz, jint sampleRate, jint channels) {
    (void) env;
    (void) clazz;
    int error = OPUS_OK;
    OpusDecoder *decoder = opus_decoder_create(sampleRate, channels, &error);
    if (error != OPUS_OK || decoder == NULL) {
        return 0;
    }
    return (jlong) (intptr_t) decoder;
}

/* packet == NULL asks Opus for packet loss concealment for one frame. */
JNIEXPORT jint JNICALL
ORU_FN(nativeDecode)(JNIEnv *env, jclass clazz, jlong handle, jbyteArray packet, jint length, jshortArray pcm, jint frameSamples) {
    (void) clazz;
    OpusDecoder *decoder = (OpusDecoder *) (intptr_t) handle;
    if (decoder == NULL) {
        return -1;
    }
    jshort *pcmBuffer = (*env)->GetShortArrayElements(env, pcm, NULL);
    jbyte *packetBuffer = packet == NULL ? NULL : (*env)->GetByteArrayElements(env, packet, NULL);

    int samples = opus_decode(decoder,
                              packetBuffer == NULL ? NULL : (const unsigned char *) packetBuffer,
                              packetBuffer == NULL ? 0 : length,
                              (opus_int16 *) pcmBuffer, frameSamples,
                              packetBuffer == NULL ? 1 : 0);

    if (packetBuffer != NULL) {
        (*env)->ReleaseByteArrayElements(env, packet, packetBuffer, JNI_ABORT);
    }
    (*env)->ReleaseShortArrayElements(env, pcm, pcmBuffer, 0);
    return samples < 0 ? -1 : samples;
}

JNIEXPORT void JNICALL
ORU_FN(nativeDestroyDecoder)(JNIEnv *env, jclass clazz, jlong handle) {
    (void) env;
    (void) clazz;
    OpusDecoder *decoder = (OpusDecoder *) (intptr_t) handle;
    if (decoder != NULL) {
        opus_decoder_destroy(decoder);
    }
}
```

- [ ] **Step 4: Write the Kotlin binding**

Create `android/app/src/main/java/com/oru/radio/OpusCodec.kt`:

```kotlin
package com.oru.radio

import java.io.Closeable

/**
 * The JNI entry points of liboru_opus.so. Declared here, in com.oru.radio, because JNI
 * symbol names encode the declaring class: opus_jni.c defines
 * Java_com_oru_radio_OpusCodec_*. Nothing outside this file calls them.
 */
internal object OpusCodec {

    @Volatile
    private var loaded = false

    @Synchronized
    fun ensureLoaded() {
        if (!loaded) {
            System.loadLibrary("oru_opus")
            loaded = true
        }
    }

    @JvmStatic external fun nativeCreateEncoder(sampleRate: Int, channels: Int, bitrate: Int): Long
    @JvmStatic external fun nativeEncode(handle: Long, pcm: ShortArray, frameSamples: Int, out: ByteArray): Int
    @JvmStatic external fun nativeDestroyEncoder(handle: Long)
    @JvmStatic external fun nativeCreateDecoder(sampleRate: Int, channels: Int): Long
    @JvmStatic external fun nativeDecode(handle: Long, packet: ByteArray?, length: Int, pcm: ShortArray, frameSamples: Int): Int
    @JvmStatic external fun nativeDestroyDecoder(handle: Long)
}

/** Thrown when libopus refuses to create a codec; the engine turns this into an error event. */
class OpusException(message: String) : RuntimeException(message)

class OpusEncoder(
    sampleRateHz: Int = RadioConfig.SAMPLE_RATE_HZ,
    channels: Int = RadioConfig.CHANNEL_COUNT,
    bitrateBps: Int = RadioConfig.BITRATE_BPS,
) : Closeable {

    private var handle: Long

    init {
        OpusCodec.ensureLoaded()
        handle = OpusCodec.nativeCreateEncoder(sampleRateHz, channels, bitrateBps)
        if (handle == 0L) throw OpusException("opus_encoder_create failed")
    }

    /** Returns the number of encoded bytes written into [out], or -1 on failure. */
    fun encode(pcm: ShortArray, frameSamples: Int, out: ByteArray): Int {
        val current = handle
        if (current == 0L) return -1
        return OpusCodec.nativeEncode(current, pcm, frameSamples, out)
    }

    override fun close() {
        val current = handle
        handle = 0L
        if (current != 0L) OpusCodec.nativeDestroyEncoder(current)
    }
}

class OpusDecoder(
    sampleRateHz: Int = RadioConfig.SAMPLE_RATE_HZ,
    channels: Int = RadioConfig.CHANNEL_COUNT,
) : Closeable {

    private var handle: Long

    init {
        OpusCodec.ensureLoaded()
        handle = OpusCodec.nativeCreateDecoder(sampleRateHz, channels)
        if (handle == 0L) throw OpusException("opus_decoder_create failed")
    }

    /**
     * Decodes one packet into [pcm] and returns the sample count, or -1 on failure.
     * A null [packet] asks libopus for one frame of packet loss concealment.
     */
    fun decode(packet: ByteArray?, length: Int, pcm: ShortArray, frameSamples: Int): Int {
        val current = handle
        if (current == 0L) return -1
        return OpusCodec.nativeDecode(current, packet, length, pcm, frameSamples)
    }

    override fun close() {
        val current = handle
        handle = 0L
        if (current != 0L) OpusCodec.nativeDestroyDecoder(current)
    }
}
```

- [ ] **Step 5: Wire the module into the build**

In `android/settings.gradle`, add `include ':opus'` on the line after `include ':app'`, so the
file reads:

```groovy
pluginManagement { includeBuild("../node_modules/@react-native/gradle-plugin") }
plugins { id("com.facebook.react.settings") }
extensions.configure(com.facebook.react.ReactSettingsExtension){ ex -> ex.autolinkLibrariesFromCommand() }
rootProject.name = 'Oru'
include ':app'
include ':opus'
includeBuild('../node_modules/@react-native/gradle-plugin')
```

In `android/app/build.gradle`, add to the `dependencies { }` block, right after the
`implementation("com.facebook.react:react-android")` line:

```groovy
    // Embedded libopus (spec section 8), built from source by :opus.
    implementation project(':opus')
```

- [ ] **Step 6: Build and verify the native library is produced**

Run: `pnpm build:android`
Expected: `BUILD SUCCESSFUL`. The first run downloads the opus tarball (about 8 MB) at CMake
configure time and compiles roughly 250 C files — allow ten minutes and re-run once on a
network timeout. Then confirm the library exists and is packaged:

```bash
ls android/opus/build/intermediates/cxx/Debug/*/obj/arm64-v8a/liboru_opus.so
unzip -l android/app/build/outputs/apk/debug/app-debug.apk | grep oru_opus
```
Expected: both print a path containing `liboru_opus.so`.

If CMake fails while configuring libopus for ARM intrinsics, add
`set(OPUS_DISABLE_INTRINSICS ON CACHE BOOL "" FORCE)` above the `FetchContent_Declare` call and
re-run; record that you did so in the task report.

- [ ] **Step 7: Write the failing JavaScript test**

Append to `__tests__/android-radio.test.ts`:

```ts
describe('embedded libopus (spec section 8)', () => {
  it('builds libopus from a pinned, hash-checked release', () => {
    const cmake = read('android/opus/src/main/cpp/CMakeLists.txt');
    expect(cmake).toMatch(/opus-1\.5\.2\.tar\.gz/);
    expect(cmake).toMatch(/URL_HASH SHA256=\$\{ORU_OPUS_SHA256\}/);
    expect(cmake).toMatch(/set\(OPUS_BUILD_SHARED_LIBRARY OFF/);
    expect(cmake).toMatch(/add_library\(oru_opus SHARED opus_jni\.c\)/);
  });

  it('wires the native module into the app build', () => {
    expect(read('android/settings.gradle')).toMatch(/include ':opus'/);
    expect(read('android/app/build.gradle')).toMatch(
      /implementation project\(':opus'\)/,
    );
  });

  it('binds the codec from the com.oru.radio package, matching the JNI symbol names', () => {
    expect(read('android/opus/src/main/cpp/opus_jni.c')).toMatch(
      /Java_com_oru_radio_OpusCodec_##name/,
    );
    expect(read(`${RADIO_DIR}/OpusCodec.kt`)).toMatch(
      /System\.loadLibrary\("oru_opus"\)/,
    );
  });
});
```

- [ ] **Step 8: Run the JavaScript test**

Run: `pnpm test __tests__/android-radio.test.ts`
Expected: PASS.

- [ ] **Step 9: Run the task gate**

Run: `pnpm typecheck && pnpm lint && pnpm test __tests__/android-radio.test.ts && pnpm build:android`
Expected: all four green.

- [ ] **Step 10: Commit**

```bash
git add android/opus android/settings.gradle android/app/build.gradle android/app/src/main/java/com/oru/radio/OpusCodec.kt __tests__/android-radio.test.ts
git commit -m "feat(android): build libopus from source and bind it through JNI"
```

---

### Task 3: The serialized shapes — control messages, audio framing, PTT bindings

Everything the radio turns into bytes, in one reviewable unit, with no Android framework
anywhere. These are the interop-critical shapes: P3 mirrors them in Swift and P4 mirrors the
JSON in TypeScript.

**Files:**
- Create: `android/app/src/main/java/com/oru/radio/ControlMessage.kt`
- Create: `android/app/src/main/java/com/oru/radio/AudioFraming.kt`
- Create: `android/app/src/main/java/com/oru/radio/PttBinding.kt`
- Test: `android/app/src/test/java/com/oru/radio/ControlMessageCodecTest.kt`
- Test: `android/app/src/test/java/com/oru/radio/AudioFramingTest.kt`
- Test: `android/app/src/test/java/com/oru/radio/PttBindingCodecTest.kt`

**Interfaces:**
- Consumes: `RadioConfig.PROTOCOL_VERSION`, `RadioConfig.MAX_ENCODED_FRAME_BYTES` (Task 1).
- Produces:
  ```kotlin
  sealed class ControlMessage {
      data class Hello(val version: Int) : ControlMessage()
      data class TxStart(val streamId: String) : ControlMessage()
      data class TxStop(val streamId: String) : ControlMessage()
  }
  object ControlMessageCodec {
      fun encode(message: ControlMessage): ByteArray
      fun decode(bytes: ByteArray): ControlMessage?    // null on anything unparseable
  }
  object AudioFraming {
      const val HEADER_BYTES = 2
      fun writeFrame(out: OutputStream, frame: ByteArray)
      fun readFrame(input: InputStream, maxFrameBytes: Int = RadioConfig.MAX_ENCODED_FRAME_BYTES): ByteArray?
  }
  sealed class PttBinding {
      data class Ble(val deviceId: String, val serviceUuid: String, val characteristicUuid: String,
                     val pressedValue: String, val releasedValue: String) : PttBinding()
      data class Hid(val keyCode: Int) : PttBinding()
  }
  data class PttConfiguration(val name: String, val binding: PttBinding)
  object PttBindingCodec {
      fun encode(configuration: PttConfiguration): String
      fun decode(raw: String?): PttConfiguration?
      fun toHex(bytes: ByteArray): String
      fun fromHex(hex: String): ByteArray?
  }
  ```

- [ ] **Step 1: Write the failing control-message test**

Create `android/app/src/test/java/com/oru/radio/ControlMessageCodecTest.kt`:

```kotlin
package com.oru.radio

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ControlMessageCodecTest {

    private fun json(message: ControlMessage) =
        JSONObject(String(ControlMessageCodec.encode(message), Charsets.UTF_8))

    @Test
    fun `hello encodes the spec shape`() {
        val encoded = json(ControlMessage.Hello(1))

        assertEquals("hello", encoded.getString("type"))
        assertEquals(1, encoded.getInt("version"))
    }

    @Test
    fun `tx-start encodes the spec shape`() {
        val encoded = json(ControlMessage.TxStart("stream-1"))

        assertEquals("tx-start", encoded.getString("type"))
        assertEquals("stream-1", encoded.getString("streamId"))
    }

    @Test
    fun `tx-stop encodes the spec shape`() {
        val encoded = json(ControlMessage.TxStop("stream-1"))

        assertEquals("tx-stop", encoded.getString("type"))
        assertEquals("stream-1", encoded.getString("streamId"))
    }

    @Test
    fun `every message round-trips`() {
        val messages = listOf(
            ControlMessage.Hello(RadioConfig.PROTOCOL_VERSION),
            ControlMessage.TxStart("2b1f0c8e-0000-4000-8000-000000000001"),
            ControlMessage.TxStop("2b1f0c8e-0000-4000-8000-000000000001"),
        )

        messages.forEach { message ->
            assertEquals(message, ControlMessageCodec.decode(ControlMessageCodec.encode(message)))
        }
    }

    @Test
    fun `a foreign protocol version decodes - the gate is the engine's job, not the codec's`() {
        val decoded = ControlMessageCodec.decode("""{"type":"hello","version":7}""".toByteArray())

        assertEquals(ControlMessage.Hello(7), decoded)
    }

    @Test
    fun `unparseable payloads decode to null instead of throwing`() {
        val garbage = listOf(
            "",
            "not json",
            "{}",
            """{"type":"nope"}""",
            """{"type":"hello"}""",
            """{"type":"hello","version":"one"}""",
            """{"type":"tx-start"}""",
            """{"type":"tx-start","streamId":""}""",
        )

        garbage.forEach { raw ->
            assertNull("expected null for: $raw", ControlMessageCodec.decode(raw.toByteArray()))
        }
    }
}
```

- [ ] **Step 2: Write the failing audio-framing test**

Create `android/app/src/test/java/com/oru/radio/AudioFramingTest.kt`:

```kotlin
package com.oru.radio

import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Test

class AudioFramingTest {

    @Test
    fun `frames round-trip in order`() {
        val first = byteArrayOf(1, 2, 3)
        val second = ByteArray(300) { (it % 251).toByte() }
        val buffer = ByteArrayOutputStream()

        AudioFraming.writeFrame(buffer, first)
        AudioFraming.writeFrame(buffer, second)

        val input = ByteArrayInputStream(buffer.toByteArray())
        assertArrayEquals(first, AudioFraming.readFrame(input))
        assertArrayEquals(second, AudioFraming.readFrame(input))
        assertNull(AudioFraming.readFrame(input))
    }

    @Test
    fun `the header is two bytes, big endian`() {
        val buffer = ByteArrayOutputStream()

        AudioFraming.writeFrame(buffer, ByteArray(258) { 7 })

        val bytes = buffer.toByteArray()
        assertArrayEquals(byteArrayOf(0x01, 0x02), bytes.copyOfRange(0, 2))
    }

    @Test
    fun `a truncated header yields null`() {
        assertNull(AudioFraming.readFrame(ByteArrayInputStream(byteArrayOf(0x00))))
    }

    @Test
    fun `a truncated body yields null`() {
        val truncated = byteArrayOf(0x00, 0x05, 1, 2)

        assertNull(AudioFraming.readFrame(ByteArrayInputStream(truncated)))
    }

    @Test
    fun `a zero length frame yields null`() {
        assertNull(AudioFraming.readFrame(ByteArrayInputStream(byteArrayOf(0x00, 0x00))))
    }

    @Test
    fun `a length above the maximum yields null instead of allocating`() {
        val oversized = byteArrayOf(0xFF.toByte(), 0xFF.toByte(), 1, 2, 3)

        assertNull(AudioFraming.readFrame(ByteArrayInputStream(oversized), maxFrameBytes = 400))
    }

    @Test
    fun `writing an empty frame is a programming error`() {
        assertThrows(IllegalArgumentException::class.java) {
            AudioFraming.writeFrame(ByteArrayOutputStream(), ByteArray(0))
        }
    }
}
```

- [ ] **Step 3: Write the failing PTT binding test**

Create `android/app/src/test/java/com/oru/radio/PttBindingCodecTest.kt`:

```kotlin
package com.oru.radio

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class PttBindingCodecTest {

    private val ble = PttConfiguration(
        name = "PTT-Button",
        binding = PttBinding.Ble(
            deviceId = "AA:BB:CC:DD:EE:FF",
            serviceUuid = "0000ffe0-0000-1000-8000-00805f9b34fb",
            characteristicUuid = "0000ffe1-0000-1000-8000-00805f9b34fb",
            pressedValue = "01",
            releasedValue = "00",
        ),
    )

    private val hid = PttConfiguration(name = "Keyboard", binding = PttBinding.Hid(keyCode = 85))

    @Test
    fun `a ble configuration round-trips`() {
        assertEquals(ble, PttBindingCodec.decode(PttBindingCodec.encode(ble)))
    }

    @Test
    fun `a hid configuration round-trips`() {
        assertEquals(hid, PttBindingCodec.decode(PttBindingCodec.encode(hid)))
    }

    @Test
    fun `unusable stored values decode to null instead of throwing`() {
        val garbage = listOf(
            null,
            "",
            "not json",
            "{}",
            """{"name":"x"}""",
            """{"name":"x","binding":{"type":"ble"}}""",
            """{"name":"x","binding":{"type":"hid"}}""",
            """{"name":"x","binding":{"type":"other","keyCode":1}}""",
        )

        garbage.forEach { raw -> assertNull("expected null for: $raw", PttBindingCodec.decode(raw)) }
    }

    @Test
    fun `hex uses uppercase with no separators`() {
        assertEquals("00", PttBindingCodec.toHex(byteArrayOf(0)))
        assertEquals("01FF0A", PttBindingCodec.toHex(byteArrayOf(1, -1, 10)))
        assertEquals("", PttBindingCodec.toHex(ByteArray(0)))
    }

    @Test
    fun `hex parses back to the same bytes and rejects nonsense`() {
        assertArrayEquals(byteArrayOf(1, -1, 10), PttBindingCodec.fromHex("01FF0A"))
        assertArrayEquals(byteArrayOf(1, -1, 10), PttBindingCodec.fromHex("01ff0a"))
        assertNull(PttBindingCodec.fromHex("0"))
        assertNull(PttBindingCodec.fromHex("zz"))
    }
}
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `pnpm build:android :app:testDebugUnitTest`
Expected: FAIL — `Unresolved reference: ControlMessageCodec` (and `AudioFraming`,
`PttBindingCodec`).

- [ ] **Step 5: Write `ControlMessage.kt`**

```kotlin
package com.oru.radio

import org.json.JSONException
import org.json.JSONObject

/** The reliable BYTES control channel of spec section 7. */
sealed class ControlMessage {
    data class Hello(val version: Int) : ControlMessage()
    data class TxStart(val streamId: String) : ControlMessage()
    data class TxStop(val streamId: String) : ControlMessage()
}

/**
 * JSON on the wire, exactly the shapes in spec section 7. iOS and the TypeScript layer
 * implement the same three shapes; key order is irrelevant, key names are not.
 */
object ControlMessageCodec {

    fun encode(message: ControlMessage): ByteArray {
        val json = when (message) {
            is ControlMessage.Hello ->
                JSONObject().put("type", "hello").put("version", message.version)
            is ControlMessage.TxStart ->
                JSONObject().put("type", "tx-start").put("streamId", message.streamId)
            is ControlMessage.TxStop ->
                JSONObject().put("type", "tx-stop").put("streamId", message.streamId)
        }
        return json.toString().toByteArray(Charsets.UTF_8)
    }

    /** Returns null for anything this version cannot use; a peer never crashes us. */
    fun decode(bytes: ByteArray): ControlMessage? = try {
        val json = JSONObject(String(bytes, Charsets.UTF_8))
        when (json.optString("type")) {
            "hello" -> if (json.get("version") is Int) ControlMessage.Hello(json.getInt("version")) else null
            "tx-start" -> streamId(json)?.let(ControlMessage::TxStart)
            "tx-stop" -> streamId(json)?.let(ControlMessage::TxStop)
            else -> null
        }
    } catch (e: JSONException) {
        null
    }

    private fun streamId(json: JSONObject): String? =
        json.optString("streamId").takeIf { it.isNotEmpty() }
}
```

- [ ] **Step 6: Write `AudioFraming.kt`**

```kotlin
package com.oru.radio

import java.io.InputStream
import java.io.OutputStream

/**
 * The audio STREAM payload's framing (spec section 7 leaves it to the implementation):
 * every Opus packet is preceded by its length as two big-endian bytes. iOS writes and
 * reads exactly this; see the cross-plan contract in the plan document.
 */
object AudioFraming {

    const val HEADER_BYTES = 2

    fun writeFrame(out: OutputStream, frame: ByteArray) {
        require(frame.isNotEmpty() && frame.size <= 0xFFFF) {
            "frame size out of range: ${frame.size}"
        }
        out.write((frame.size ushr 8) and 0xFF)
        out.write(frame.size and 0xFF)
        out.write(frame)
        out.flush()
    }

    /**
     * Reads one frame, or returns null at end of stream and on any malformed header.
     * A null means "this stream is over" — the caller closes it.
     */
    fun readFrame(
        input: InputStream,
        maxFrameBytes: Int = RadioConfig.MAX_ENCODED_FRAME_BYTES,
    ): ByteArray? {
        val header = ByteArray(HEADER_BYTES)
        if (!readFully(input, header)) return null

        val length = ((header[0].toInt() and 0xFF) shl 8) or (header[1].toInt() and 0xFF)
        if (length < 1 || length > maxFrameBytes) return null

        val frame = ByteArray(length)
        return if (readFully(input, frame)) frame else null
    }

    private fun readFully(input: InputStream, buffer: ByteArray): Boolean {
        var offset = 0
        while (offset < buffer.size) {
            val read = input.read(buffer, offset, buffer.size - offset)
            if (read < 0) return false
            offset += read
        }
        return true
    }
}
```

- [ ] **Step 7: Write `PttBinding.kt`**

```kotlin
package com.oru.radio

import org.json.JSONException
import org.json.JSONObject

/** Spec section 9.2. Hex values are uppercase with no separators, e.g. "01", "0100". */
sealed class PttBinding {

    data class Ble(
        val deviceId: String,
        val serviceUuid: String,
        val characteristicUuid: String,
        val pressedValue: String,
        val releasedValue: String,
    ) : PttBinding()

    data class Hid(val keyCode: Int) : PttBinding()
}

/** The result of the learning flow (spec section 6.1 PttConfiguration). */
data class PttConfiguration(val name: String, val binding: PttBinding)

object PttBindingCodec {

    private const val HEX_DIGITS = "0123456789ABCDEF"

    fun encode(configuration: PttConfiguration): String {
        val binding = JSONObject()
        when (val value = configuration.binding) {
            is PttBinding.Ble -> binding
                .put("type", "ble")
                .put("deviceId", value.deviceId)
                .put("serviceUuid", value.serviceUuid)
                .put("characteristicUuid", value.characteristicUuid)
                .put("pressedValue", value.pressedValue)
                .put("releasedValue", value.releasedValue)
            is PttBinding.Hid -> binding
                .put("type", "hid")
                .put("keyCode", value.keyCode)
        }
        return JSONObject()
            .put("name", configuration.name)
            .put("binding", binding)
            .toString()
    }

    /** Returns null for anything unusable; a corrupt preference must not crash the radio. */
    fun decode(raw: String?): PttConfiguration? {
        if (raw.isNullOrEmpty()) return null
        return try {
            val json = JSONObject(raw)
            val binding = json.optJSONObject("binding") ?: return null
            val parsed = when (binding.optString("type")) {
                "ble" -> PttBinding.Ble(
                    deviceId = binding.string("deviceId") ?: return null,
                    serviceUuid = binding.string("serviceUuid") ?: return null,
                    characteristicUuid = binding.string("characteristicUuid") ?: return null,
                    pressedValue = binding.string("pressedValue") ?: return null,
                    releasedValue = binding.string("releasedValue") ?: return null,
                )
                "hid" -> if (binding.get("keyCode") is Int) {
                    PttBinding.Hid(binding.getInt("keyCode"))
                } else {
                    return null
                }
                else -> return null
            }
            PttConfiguration(json.string("name") ?: "PTT", parsed)
        } catch (e: JSONException) {
            null
        }
    }

    fun toHex(bytes: ByteArray): String {
        val text = StringBuilder(bytes.size * 2)
        for (byte in bytes) {
            val value = byte.toInt() and 0xFF
            text.append(HEX_DIGITS[value ushr 4]).append(HEX_DIGITS[value and 0x0F])
        }
        return text.toString()
    }

    fun fromHex(hex: String): ByteArray? {
        if (hex.length % 2 != 0) return null
        val bytes = ByteArray(hex.length / 2)
        for (index in bytes.indices) {
            val high = Character.digit(hex[index * 2], 16)
            val low = Character.digit(hex[index * 2 + 1], 16)
            if (high < 0 || low < 0) return null
            bytes[index] = ((high shl 4) or low).toByte()
        }
        return bytes
    }

    private fun JSONObject.string(key: String): String? = optString(key).takeIf { it.isNotEmpty() }
}
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `pnpm build:android :app:testDebugUnitTest`
Expected: PASS — all three new test classes green (22 tests in this task).

- [ ] **Step 9: Run the task gate**

Run: `pnpm typecheck && pnpm lint && pnpm test __tests__/android-radio.test.ts && pnpm build:android`
Expected: all four green.

- [ ] **Step 10: Commit**

```bash
git add android/app/src/main/java/com/oru/radio android/app/src/test/java/com/oru/radio
git commit -m "feat(android): add the control message codec, audio framing and PTT binding shapes"
```

---

### Task 4: `RadioState`, the engine's ports, and the `RadioEngine` state machine

The core of the plan. The engine holds all radio state and implements every spec §6.3
operation; it touches no Android class, so it is fully unit-tested.

**Files:**
- Create: `android/app/src/main/java/com/oru/radio/RadioState.kt`
- Create: `android/app/src/main/java/com/oru/radio/RadioPorts.kt`
- Create: `android/app/src/main/java/com/oru/radio/RadioEngine.kt`
- Create: `android/app/src/main/java/com/oru/radio/HandlerScheduler.kt`
- Test: `android/app/src/test/java/com/oru/radio/TestDoubles.kt`
- Test: `android/app/src/test/java/com/oru/radio/RadioStateTest.kt`
- Test: `android/app/src/test/java/com/oru/radio/RadioEngineTest.kt`

**Interfaces:**
- Consumes: `RadioConfig.MAX_TRANSMIT_MS` (Task 1); `PttConfiguration` (Task 3).
- Produces: `RadioStatus`, `PttButtonState`, `PttPairingPhase`, `PttCandidate`,
  `PttPairingState`, `RadioState` (+ `toMap()`); the ports `Cancellable`, `Scheduler`,
  `TransmissionSink`, `Transport`, `TransportListener`, `AudioIo`, `PttSource`, `PttListener`,
  `PttLearningListener`, `RadioEngineListener`; and
  ```kotlin
  class RadioEngine(
      transport: Transport, audio: AudioIo, ptt: PttSource, scheduler: Scheduler,
      streamIds: () -> String = { UUID.randomUUID().toString() },
  ) : TransportListener, PttListener {
      fun addListener(listener: RadioEngineListener)
      fun removeListener(listener: RadioEngineListener)
      fun getState(): RadioState
      fun startRadio(); fun stopRadio()
      fun startTransmit(); fun stopTransmit()
      fun startPttPairing(); fun selectPttCandidate(deviceId: String); fun cancelPttPairing()
      fun forgetPtt()
  }
  class HandlerScheduler(name: String = "oru-radio") : Scheduler { fun shutdown() }
  ```
  Task 5 implements `Transport`, Task 7 implements `AudioIo`, Task 8 implements `PttSource`,
  Task 10 constructs the engine, P5 calls the public methods.

- [ ] **Step 1: Write the failing state-shape test, then the state and the ports**

`toMap()` is the one piece of real logic in the state file — the amended contract makes
`pttPairing` an *optional* field, so the key must be absent, not null, when no pairing session
is running. Write the test first.

Create `android/app/src/test/java/com/oru/radio/RadioStateTest.kt`:

```kotlin
package com.oru.radio

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RadioStateTest {

    @Test
    fun `the default state is the section 6-1 starting state`() {
        val map = RadioState().toMap()

        assertEquals("starting", map["status"])
        assertEquals(0, map["nearbyCount"])
        assertEquals(false, map["transmitting"])
        assertEquals(false, map["receiving"])
        assertEquals(
            mapOf("configured" to false, "connected" to false, "name" to null),
            map["pttButton"],
        )
    }

    @Test
    fun `pttPairing is absent, not null, when no pairing session is running`() {
        assertFalse(RadioState().toMap().containsKey("pttPairing"))
    }

    @Test
    fun `a running pairing session serializes phase and candidates`() {
        val state = RadioState(
            status = RadioStatus.READY,
            pttPairing = PttPairingState(
                phase = PttPairingPhase.SCANNING,
                candidates = listOf(
                    PttCandidate("AA:BB:CC:DD:EE:FF", "PTT-Button", -54),
                    PttCandidate("11:22:33:44:55:66", "11:22:33:44:55:66", -80),
                ),
            ),
        )

        val map = state.toMap()

        assertTrue(map.containsKey("pttPairing"))
        assertEquals(
            mapOf(
                "phase" to "scanning",
                "candidates" to listOf(
                    mapOf("deviceId" to "AA:BB:CC:DD:EE:FF", "name" to "PTT-Button", "rssi" to -54),
                    mapOf(
                        "deviceId" to "11:22:33:44:55:66",
                        "name" to "11:22:33:44:55:66",
                        "rssi" to -80,
                    ),
                ),
            ),
            map["pttPairing"],
        )
    }

    @Test
    fun `every pairing phase has the contract's wire name`() {
        assertEquals(
            listOf("scanning", "learning", "saved"),
            PttPairingPhase.entries.map { it.wire },
        )
    }
}
```

Run: `pnpm build:android :app:testDebugUnitTest`
Expected: FAIL — `Unresolved reference: PttPairingState`.

Then create `android/app/src/main/java/com/oru/radio/RadioState.kt`:

```kotlin
package com.oru.radio

/** Spec section 6.1: 'starting' | 'ready' | 'error'. */
enum class RadioStatus(val wire: String) {
    STARTING("starting"),
    READY("ready"),
    ERROR("error"),
}

data class PttButtonState(
    val configured: Boolean = false,
    val connected: Boolean = false,
    val name: String? = null,
)

/** The four-step pairing flow of spec section 9.3, as the contract amendment names it. */
enum class PttPairingPhase(val wire: String) {
    SCANNING("scanning"),
    LEARNING("learning"),
    SAVED("saved"),
}

/** `name` is never null on the wire: a nameless device is published under its address. */
data class PttCandidate(val deviceId: String, val name: String, val rssi: Int)

data class PttPairingState(
    val phase: PttPairingPhase,
    val candidates: List<PttCandidate> = emptyList(),
)

/** Exactly the RadioState of spec section 6.1, plus the amended optional pairing field. */
data class RadioState(
    val status: RadioStatus = RadioStatus.STARTING,
    val nearbyCount: Int = 0,
    val transmitting: Boolean = false,
    val receiving: Boolean = false,
    val pttButton: PttButtonState = PttButtonState(),
    /** Non-null only while a pairing session is running (contract amendment 2026-08-14). */
    val pttPairing: PttPairingState? = null,
) {
    /**
     * The bridge (P5) serializes exactly this map; the engine owns the shape. When there
     * is no pairing session the key is omitted entirely rather than sent as null, so JS
     * sees `pttPairing === undefined` and the TypeScript optional field holds.
     */
    fun toMap(): Map<String, Any?> = buildMap {
        put("status", status.wire)
        put("nearbyCount", nearbyCount)
        put("transmitting", transmitting)
        put("receiving", receiving)
        put(
            "pttButton",
            mapOf(
                "configured" to pttButton.configured,
                "connected" to pttButton.connected,
                "name" to pttButton.name,
            ),
        )
        pttPairing?.let { pairing ->
            put(
                "pttPairing",
                mapOf(
                    "phase" to pairing.phase.wire,
                    "candidates" to pairing.candidates.map { candidate ->
                        mapOf(
                            "deviceId" to candidate.deviceId,
                            "name" to candidate.name,
                            "rssi" to candidate.rssi,
                        )
                    },
                ),
            )
        }
    }
}
```

Create `android/app/src/main/java/com/oru/radio/RadioPorts.kt`:

```kotlin
package com.oru.radio

/**
 * Everything RadioEngine talks to. Each port has exactly one Android implementation and
 * one test double, which is why the engine itself never imports an Android class.
 */

fun interface Cancellable {
    fun cancel()
}

/** The engine's single thread. Every engine mutation is posted here. */
interface Scheduler {
    fun execute(action: () -> Unit)
    fun schedule(delayMs: Long, action: () -> Unit): Cancellable
}

/** One outgoing transmission: encoded Opus frames in, peers out. */
interface TransmissionSink {
    fun writeFrame(frame: ByteArray)
    fun close()
}

interface Transport {
    fun start(listener: TransportListener)
    fun stop()
    /** Announces tx-start to every peer and opens the audio stream(s). Never null. */
    fun openTransmission(streamId: String): TransmissionSink
    /** Closes the audio stream(s) and announces tx-stop. */
    fun closeTransmission(streamId: String)
}

/** Transport callbacks. They may arrive on any thread; the engine re-posts them. */
interface TransportListener {
    fun onPeerConnected(peerId: String)
    fun onPeerDisconnected(peerId: String)
    fun onIncomingAudioStarted(peerId: String, streamId: String)
    fun onIncomingAudioFrame(peerId: String, frame: ByteArray)
    fun onIncomingAudioStopped(peerId: String, streamId: String)
    /** Unrecoverable (spec section 13): the engine goes to status 'error'. */
    fun onTransportFailure(code: String, message: String)
}

interface AudioIo {
    /**
     * Reports an unrecoverable audio failure — a microphone that will not open, a codec
     * that will not initialize. The engine turns it into an error event and the error
     * status (spec section 13). May be called from an audio thread.
     */
    fun setFailureListener(listener: (code: String, message: String) -> Unit)
    fun startCapture(sink: TransmissionSink)
    fun stopCapture()
    fun openPlayback(peerId: String)
    fun playFrame(peerId: String, frame: ByteArray)
    fun closePlayback(peerId: String)
    fun release()
}

interface PttSource {
    fun start(listener: PttListener)
    fun stop()
    fun snapshot(): PttButtonState
    /** The amended configurePtt(): opens the pairing session and starts scanning. */
    fun startPairing()
    /** The amended selectPttCandidate(): the user picked one of the published candidates. */
    fun selectCandidate(deviceId: String)
    fun cancelPairing()
    fun forget()
}

interface PttListener {
    fun onPttPressed()
    fun onPttReleased()
    fun onPttButtonStateChanged(state: PttButtonState)
    /** Mirrored straight into RadioState.pttPairing; null ends the session. */
    fun onPttPairingChanged(pairing: PttPairingState?)
    /** Cancel, timeout or a BLE failure: an error event, never the error status (section 13). */
    fun onPttPairingFailed(code: String, message: String)
}

/**
 * The driver-to-manager half of the learning flow (spec section 9.3). This one is
 * internal: it never reaches the bridge, which sees only RadioState.pttPairing.
 */
interface PttLearningListener {
    fun onDeviceFound(deviceId: String, name: String?, rssi: Int)
    fun onLearned(configuration: PttConfiguration)
    fun onLearningFailed(code: String, message: String)
}

interface RadioEngineListener {
    fun onStateChanged(state: RadioState)
    fun onError(code: String, message: String)
}
```

- [ ] **Step 2: Write the test doubles**

Create `android/app/src/test/java/com/oru/radio/TestDoubles.kt`:

```kotlin
package com.oru.radio

/** Runs work inline and gives the test a virtual clock for the 120 s safety cap. */
class TestScheduler : Scheduler {

    private class Scheduled(val dueAtMs: Long, val action: () -> Unit) {
        var cancelled = false
    }

    private val scheduled = mutableListOf<Scheduled>()

    var nowMs: Long = 0L
        private set

    override fun execute(action: () -> Unit) = action()

    override fun schedule(delayMs: Long, action: () -> Unit): Cancellable {
        val item = Scheduled(nowMs + delayMs, action)
        scheduled.add(item)
        return Cancellable { item.cancelled = true }
    }

    fun advance(millis: Long) {
        nowMs += millis
        val due = scheduled.filter { !it.cancelled && it.dueAtMs <= nowMs }
        scheduled.removeAll(due)
        due.forEach { it.action() }
    }

    val pendingCount: Int get() = scheduled.count { !it.cancelled }
}

class FakeTransport : Transport {

    class FakeSink(val streamId: String) : TransmissionSink {
        val frames = mutableListOf<ByteArray>()
        var closed = false
        override fun writeFrame(frame: ByteArray) {
            frames.add(frame)
        }
        override fun close() {
            closed = true
        }
    }

    var listener: TransportListener? = null
    var started = false
    var stopped = false
    val openedStreams = mutableListOf<String>()
    val closedStreams = mutableListOf<String>()
    var lastSink: FakeSink? = null

    override fun start(listener: TransportListener) {
        this.listener = listener
        started = true
    }

    override fun stop() {
        stopped = true
        listener = null
    }

    override fun openTransmission(streamId: String): TransmissionSink {
        openedStreams.add(streamId)
        return FakeSink(streamId).also { lastSink = it }
    }

    override fun closeTransmission(streamId: String) {
        closedStreams.add(streamId)
    }
}

class FakeAudioIo : AudioIo {
    var capturing = false
    var captureSink: TransmissionSink? = null
    val openedPlayback = mutableListOf<String>()
    val closedPlayback = mutableListOf<String>()
    val playedFrames = mutableListOf<Pair<String, ByteArray>>()
    var released = false
    var failureListener: ((String, String) -> Unit)? = null

    override fun setFailureListener(listener: (code: String, message: String) -> Unit) {
        failureListener = listener
    }

    override fun startCapture(sink: TransmissionSink) {
        capturing = true
        captureSink = sink
    }

    override fun stopCapture() {
        capturing = false
        captureSink = null
    }

    override fun openPlayback(peerId: String) {
        openedPlayback.add(peerId)
    }

    override fun playFrame(peerId: String, frame: ByteArray) {
        playedFrames.add(peerId to frame)
    }

    override fun closePlayback(peerId: String) {
        closedPlayback.add(peerId)
    }

    override fun release() {
        released = true
    }
}

class FakePttSource(private var state: PttButtonState = PttButtonState()) : PttSource {
    var listener: PttListener? = null
    var started = false
    var stopped = false
    var forgotten = false
    var pairingStarted = false
    var pairingCancelled = false
    var selectedDevice: String? = null

    override fun start(listener: PttListener) {
        this.listener = listener
        started = true
    }

    override fun stop() {
        stopped = true
        listener = null
    }

    override fun snapshot(): PttButtonState = state

    override fun startPairing() {
        pairingStarted = true
    }

    override fun selectCandidate(deviceId: String) {
        selectedDevice = deviceId
    }

    override fun cancelPairing() {
        pairingCancelled = true
    }

    override fun forget() {
        forgotten = true
        state = PttButtonState()
    }
}

class RecordingListener : RadioEngineListener {
    val states = mutableListOf<RadioState>()
    val errors = mutableListOf<Pair<String, String>>()

    override fun onStateChanged(state: RadioState) {
        states.add(state)
    }

    override fun onError(code: String, message: String) {
        errors.add(code to message)
    }

    val last: RadioState get() = states.last()
}
```

- [ ] **Step 3: Write the failing engine test**

Create `android/app/src/test/java/com/oru/radio/RadioEngineTest.kt`:

```kotlin
package com.oru.radio

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class RadioEngineTest {

    private lateinit var transport: FakeTransport
    private lateinit var audio: FakeAudioIo
    private lateinit var ptt: FakePttSource
    private lateinit var scheduler: TestScheduler
    private lateinit var listener: RecordingListener
    private lateinit var engine: RadioEngine

    @Before
    fun setUp() {
        transport = FakeTransport()
        audio = FakeAudioIo()
        ptt = FakePttSource()
        scheduler = TestScheduler()
        listener = RecordingListener()
        engine = RadioEngine(transport, audio, ptt, scheduler, streamIds = { "stream-1" })
        engine.addListener(listener)
    }

    @Test
    fun `a new engine is starting and empty`() {
        assertEquals(RadioStatus.STARTING, engine.getState().status)
        assertEquals(0, engine.getState().nearbyCount)
        assertEquals(RadioState(), listener.states.first())
    }

    @Test
    fun `startRadio starts the transport and the button, then reports ready`() {
        engine.startRadio()

        assertTrue(transport.started)
        assertTrue(ptt.started)
        assertEquals(RadioStatus.READY, engine.getState().status)
    }

    @Test
    fun `startRadio is idempotent`() {
        engine.startRadio()
        transport.started = false

        engine.startRadio()

        assertFalse(transport.started)
    }

    @Test
    fun `peers are counted once each and removed on disconnect`() {
        engine.startRadio()

        engine.onPeerConnected("a")
        engine.onPeerConnected("a")
        engine.onPeerConnected("b")
        assertEquals(2, engine.getState().nearbyCount)

        engine.onPeerDisconnected("a")
        assertEquals(1, engine.getState().nearbyCount)
    }

    @Test
    fun `startTransmit opens a stream, starts capture and reports transmitting`() {
        engine.startRadio()

        engine.startTransmit()

        assertEquals(listOf("stream-1"), transport.openedStreams)
        assertTrue(audio.capturing)
        assertEquals(transport.lastSink, audio.captureSink)
        assertTrue(engine.getState().transmitting)
    }

    @Test
    fun `a second startTransmit while transmitting does nothing`() {
        engine.startRadio()
        engine.startTransmit()

        engine.startTransmit()

        assertEquals(1, transport.openedStreams.size)
    }

    @Test
    fun `stopTransmit stops capture, closes the sink and announces tx-stop`() {
        engine.startRadio()
        engine.startTransmit()
        val sink = transport.lastSink!!

        engine.stopTransmit()

        assertFalse(audio.capturing)
        assertTrue(sink.closed)
        assertEquals(listOf("stream-1"), transport.closedStreams)
        assertFalse(engine.getState().transmitting)
    }

    @Test
    fun `stopTransmit without a transmission is a no-op`() {
        engine.startRadio()

        engine.stopTransmit()

        assertTrue(transport.closedStreams.isEmpty())
    }

    @Test
    fun `a held transmission stops itself after the 120 second safety cap`() {
        engine.startRadio()
        engine.startTransmit()

        scheduler.advance(RadioConfig.MAX_TRANSMIT_MS - 1)
        assertTrue(engine.getState().transmitting)

        scheduler.advance(1)
        assertFalse(engine.getState().transmitting)
        assertEquals(listOf("stream-1"), transport.closedStreams)
    }

    @Test
    fun `releasing before the cap cancels it`() {
        engine.startRadio()
        engine.startTransmit()
        engine.stopTransmit()

        scheduler.advance(RadioConfig.MAX_TRANSMIT_MS * 2)

        assertEquals(1, transport.closedStreams.size)
        assertEquals(0, scheduler.pendingCount)
    }

    @Test
    fun `the button drives the same path as the screen`() {
        engine.startRadio()

        ptt.listener!!.onPttPressed()
        assertTrue(engine.getState().transmitting)

        ptt.listener!!.onPttReleased()
        assertFalse(engine.getState().transmitting)
    }

    @Test
    fun `incoming audio opens playback and reports receiving`() {
        engine.startRadio()

        engine.onIncomingAudioStarted("a", "s1")
        assertTrue(engine.getState().receiving)
        assertEquals(listOf("a"), audio.openedPlayback)

        engine.onIncomingAudioFrame("a", byteArrayOf(9))
        assertEquals(1, audio.playedFrames.size)

        engine.onIncomingAudioStopped("a", "s1")
        assertFalse(engine.getState().receiving)
        assertEquals(listOf("a"), audio.closedPlayback)
    }

    @Test
    fun `receiving stays true while any peer is still transmitting`() {
        engine.startRadio()
        engine.onIncomingAudioStarted("a", "s1")
        engine.onIncomingAudioStarted("b", "s2")

        engine.onIncomingAudioStopped("a", "s1")

        assertTrue(engine.getState().receiving)
    }

    @Test
    fun `a peer that disappears mid-transmission stops its playback`() {
        engine.startRadio()
        engine.onIncomingAudioStarted("a", "s1")

        engine.onPeerDisconnected("a")

        assertFalse(engine.getState().receiving)
        assertEquals(listOf("a"), audio.closedPlayback)
    }

    @Test
    fun `frames from a peer that is not transmitting are dropped`() {
        engine.startRadio()

        engine.onIncomingAudioFrame("ghost", byteArrayOf(1))

        assertTrue(audio.playedFrames.isEmpty())
    }

    @Test
    fun `an unrecoverable transport failure is an error event and an error status`() {
        engine.startRadio()
        engine.startTransmit()

        engine.onTransportFailure("advertising_failed", "boom")

        assertEquals(RadioStatus.ERROR, engine.getState().status)
        assertEquals(listOf("advertising_failed" to "boom"), listener.errors)
        assertFalse(engine.getState().transmitting)
    }

    @Test
    fun `an unrecoverable audio failure is reported the same way`() {
        engine.startRadio()

        audio.failureListener!!("microphone_unavailable", "AudioRecord did not initialize")

        assertEquals(RadioStatus.ERROR, engine.getState().status)
        assertEquals(
            listOf("microphone_unavailable" to "AudioRecord did not initialize"),
            listener.errors,
        )
    }

    @Test
    fun `transmission is refused while in the error status`() {
        engine.startRadio()
        engine.onTransportFailure("advertising_failed", "boom")

        engine.startTransmit()

        assertTrue(transport.openedStreams.isEmpty())
    }

    @Test
    fun `the button state is mirrored into the radio state`() {
        engine.startRadio()

        ptt.listener!!.onPttButtonStateChanged(PttButtonState(true, true, "PTT-Button"))

        assertEquals(PttButtonState(true, true, "PTT-Button"), engine.getState().pttButton)
    }

    @Test
    fun `stopRadio tears everything down and resets the state`() {
        engine.startRadio()
        engine.onPeerConnected("a")
        engine.onIncomingAudioStarted("a", "s1")
        engine.startTransmit()

        engine.stopRadio()

        assertTrue(transport.stopped)
        assertTrue(ptt.stopped)
        assertTrue(audio.released)
        assertEquals(RadioState(), engine.getState())
    }

    @Test
    fun `pairing and forgetting are delegated to the ptt source`() {
        engine.startRadio()

        engine.startPttPairing()
        assertTrue(ptt.pairingStarted)

        engine.selectPttCandidate("AA:BB:CC:DD:EE:FF")
        assertEquals("AA:BB:CC:DD:EE:FF", ptt.selectedDevice)

        engine.cancelPttPairing()
        assertTrue(ptt.pairingCancelled)

        engine.forgetPtt()
        assertTrue(ptt.forgotten)
    }

    @Test
    fun `pairing progress rides on the state, not on a second event`() {
        engine.startRadio()
        assertNull(engine.getState().pttPairing)

        val scanning = PttPairingState(
            phase = PttPairingPhase.SCANNING,
            candidates = listOf(PttCandidate("AA:BB:CC:DD:EE:FF", "PTT-Button", -54)),
        )
        ptt.listener!!.onPttPairingChanged(scanning)

        assertEquals(scanning, engine.getState().pttPairing)
        assertEquals(scanning, listener.last.pttPairing)
    }

    @Test
    fun `a failed pairing is an error event but leaves the radio ready`() {
        engine.startRadio()
        ptt.listener!!.onPttPairingChanged(PttPairingState(PttPairingPhase.SCANNING))

        ptt.listener!!.onPttPairingFailed("pairing_timeout", "No PTT button was paired in time")

        assertNull(engine.getState().pttPairing)
        assertEquals(RadioStatus.READY, engine.getState().status)
        assertEquals(
            listOf("pairing_timeout" to "No PTT button was paired in time"),
            listener.errors,
        )
    }

    @Test
    fun `a listener only hears about real changes`() {
        engine.startRadio()
        val before = listener.states.size

        engine.onPeerDisconnected("nobody")

        assertEquals(before, listener.states.size)
    }
}
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `pnpm build:android :app:testDebugUnitTest`
Expected: FAIL — `Unresolved reference: RadioEngine`.

- [ ] **Step 5: Write the engine**

Create `android/app/src/main/java/com/oru/radio/RadioEngine.kt`:

```kotlin
package com.oru.radio

import java.util.UUID
import java.util.concurrent.CopyOnWriteArrayList

/**
 * The radio itself (spec section 18: "the UI may die, JS may sleep, the RadioEngine must
 * keep working"). Every operation of spec section 6.3 lives here, and every mutation runs
 * on the injected scheduler's single thread, so no field below is synchronized.
 */
class RadioEngine(
    private val transport: Transport,
    private val audio: AudioIo,
    private val ptt: PttSource,
    private val scheduler: Scheduler,
    private val streamIds: () -> String = { UUID.randomUUID().toString() },
) : TransportListener, PttListener {

    private val listeners = CopyOnWriteArrayList<RadioEngineListener>()
    private val peers = LinkedHashSet<String>()
    private val incoming = LinkedHashSet<String>()

    private var state = RadioState()
    private var running = false
    private var currentStreamId: String? = null
    private var currentSink: TransmissionSink? = null
    private var safetyCap: Cancellable? = null

    fun addListener(listener: RadioEngineListener) {
        listeners.add(listener)
        listener.onStateChanged(state)
    }

    fun removeListener(listener: RadioEngineListener) {
        listeners.remove(listener)
    }

    fun getState(): RadioState = state

    // --- spec section 6.3 operations ---------------------------------------------------

    fun startRadio() = scheduler.execute {
        if (running) return@execute
        running = true
        audio.setFailureListener { code, message -> scheduler.execute { fail(code, message) } }
        transport.start(this)
        ptt.start(this)
        update { it.copy(status = RadioStatus.READY, pttButton = ptt.snapshot()) }
    }

    fun stopRadio() = scheduler.execute {
        if (!running) return@execute
        stopTransmitNow()
        incoming.toList().forEach { audio.closePlayback(it) }
        incoming.clear()
        peers.clear()
        ptt.stop()
        transport.stop()
        audio.release()
        running = false
        update { RadioState() }
    }

    fun startTransmit() = scheduler.execute { startTransmitNow() }

    fun stopTransmit() = scheduler.execute { stopTransmitNow() }

    fun startPttPairing() = scheduler.execute { ptt.startPairing() }

    fun selectPttCandidate(deviceId: String) = scheduler.execute { ptt.selectCandidate(deviceId) }

    fun cancelPttPairing() = scheduler.execute { ptt.cancelPairing() }

    fun forgetPtt() = scheduler.execute {
        ptt.forget()
        update { it.copy(pttButton = ptt.snapshot()) }
    }

    // --- transport callbacks ------------------------------------------------------------

    override fun onPeerConnected(peerId: String) = scheduler.execute {
        if (peers.add(peerId)) update { it.copy(nearbyCount = peers.size) }
    }

    override fun onPeerDisconnected(peerId: String) = scheduler.execute {
        val hadPeer = peers.remove(peerId)
        val wasReceiving = incoming.remove(peerId)
        if (wasReceiving) audio.closePlayback(peerId)
        if (hadPeer || wasReceiving) {
            update { it.copy(nearbyCount = peers.size, receiving = incoming.isNotEmpty()) }
        }
    }

    override fun onIncomingAudioStarted(peerId: String, streamId: String) = scheduler.execute {
        if (incoming.add(peerId)) {
            audio.openPlayback(peerId)
            update { it.copy(receiving = true) }
        }
    }

    override fun onIncomingAudioFrame(peerId: String, frame: ByteArray) = scheduler.execute {
        if (peerId in incoming) audio.playFrame(peerId, frame)
    }

    override fun onIncomingAudioStopped(peerId: String, streamId: String) = scheduler.execute {
        if (incoming.remove(peerId)) {
            audio.closePlayback(peerId)
            update { it.copy(receiving = incoming.isNotEmpty()) }
        }
    }

    override fun onTransportFailure(code: String, message: String) = scheduler.execute {
        fail(code, message)
    }

    // --- ptt callbacks ------------------------------------------------------------------

    override fun onPttPressed() = scheduler.execute { startTransmitNow() }

    override fun onPttReleased() = scheduler.execute { stopTransmitNow() }

    override fun onPttButtonStateChanged(state: PttButtonState) = scheduler.execute {
        update { it.copy(pttButton = state) }
    }

    override fun onPttPairingChanged(pairing: PttPairingState?) = scheduler.execute {
        update { it.copy(pttPairing = pairing) }
    }

    override fun onPttPairingFailed(code: String, message: String) = scheduler.execute {
        update { it.copy(pttPairing = null) }
        // A pairing that fails leaves the radio itself perfectly healthy, so this is an
        // error event without the error status (spec section 13).
        reportError(code, message)
    }

    // --- internals ----------------------------------------------------------------------

    private fun startTransmitNow() {
        if (!running || state.status == RadioStatus.ERROR || currentStreamId != null) return

        val streamId = streamIds()
        val sink = transport.openTransmission(streamId)
        currentStreamId = streamId
        currentSink = sink
        audio.startCapture(sink)
        // Stuck-button protection (spec section 9.4): a hold never lasts past 120 s.
        safetyCap = scheduler.schedule(RadioConfig.MAX_TRANSMIT_MS) { stopTransmitNow() }
        update { it.copy(transmitting = true) }
    }

    private fun stopTransmitNow() {
        val streamId = currentStreamId ?: return
        safetyCap?.cancel()
        safetyCap = null
        audio.stopCapture()
        currentSink?.close()
        currentSink = null
        currentStreamId = null
        transport.closeTransmission(streamId)
        update { it.copy(transmitting = false) }
    }

    /** An error event on its own: something failed, the radio keeps working. */
    private fun reportError(code: String, message: String) {
        listeners.forEach { it.onError(code, message) }
    }

    /** Spec section 13: unrecoverable failures are an event *and* the error status. */
    private fun fail(code: String, message: String) {
        stopTransmitNow()
        update { it.copy(status = RadioStatus.ERROR) }
        reportError(code, message)
    }

    private fun update(transform: (RadioState) -> RadioState) {
        val next = transform(state)
        if (next == state) return
        state = next
        listeners.forEach { it.onStateChanged(next) }
    }
}
```

- [ ] **Step 6: Write the real scheduler**

Create `android/app/src/main/java/com/oru/radio/HandlerScheduler.kt`:

```kotlin
package com.oru.radio

import android.os.Handler
import android.os.HandlerThread

/**
 * The engine's thread in production. Nearby, BLE and audio callbacks arrive on whatever
 * thread the platform picks; everything is funnelled here.
 */
class HandlerScheduler(name: String = "oru-radio") : Scheduler {

    private val thread = HandlerThread(name).apply { start() }
    private val handler = Handler(thread.looper)

    override fun execute(action: () -> Unit) {
        handler.post { action() }
    }

    override fun schedule(delayMs: Long, action: () -> Unit): Cancellable {
        val runnable = Runnable { action() }
        handler.postDelayed(runnable, delayMs)
        return Cancellable { handler.removeCallbacks(runnable) }
    }

    fun shutdown() {
        handler.removeCallbacksAndMessages(null)
        thread.quitSafely()
    }
}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `pnpm build:android :app:testDebugUnitTest`
Expected: PASS — `RadioStateTest` (4 tests) and `RadioEngineTest` (23 tests) fully green, and
every test from Tasks 1 and 3 still green.

- [ ] **Step 8: Run the task gate**

Run: `pnpm typecheck && pnpm lint && pnpm test __tests__/android-radio.test.ts && pnpm build:android`
Expected: all four green.

- [ ] **Step 9: Commit**

```bash
git add android/app/src/main/java/com/oru/radio android/app/src/test/java/com/oru/radio
git commit -m "feat(android): add the RadioEngine state machine, its ports and the 120s safety cap"
```

---

### Task 5: `NearbyManager` — the Nearby Connections transport

**Files:**
- Create: `android/app/src/main/java/com/oru/radio/NearbyManager.kt`
- Modify: `android/app/build.gradle` (add the Nearby dependency)
- Test: `__tests__/android-radio.test.ts` (append a describe block)

**Interfaces:**
- Consumes: `Transport`, `TransportListener`, `TransmissionSink`, `Scheduler` (Task 4);
  `ControlMessage`, `ControlMessageCodec`, `AudioFraming` (Task 3); `ReconnectBackoff`,
  `RadioConfig.SERVICE_ID`, `RadioConfig.PROTOCOL_VERSION` (Task 1).
- Produces: `class NearbyManager(context: Context, endpointName: String, scheduler: Scheduler) : Transport`.
  Task 10 constructs it.

- [ ] **Step 1: Add the Nearby dependency**

In `android/app/build.gradle`, in `dependencies { }`, after the `implementation project(':opus')`
line, add:

```groovy
    // Nearby Connections (spec section 7): P2P_CLUSTER, advertise and discover at once.
    implementation("com.google.android.gms:play-services-nearby:19.4.0")
```

- [ ] **Step 2: Write `NearbyManager`**

Create `android/app/src/main/java/com/oru/radio/NearbyManager.kt`:

```kotlin
package com.oru.radio

import android.content.Context
import android.os.ParcelFileDescriptor
import android.util.Log
import com.google.android.gms.nearby.Nearby
import com.google.android.gms.nearby.connection.AdvertisingOptions
import com.google.android.gms.nearby.connection.ConnectionInfo
import com.google.android.gms.nearby.connection.ConnectionLifecycleCallback
import com.google.android.gms.nearby.connection.ConnectionResolution
import com.google.android.gms.nearby.connection.ConnectionsClient
import com.google.android.gms.nearby.connection.ConnectionsStatusCodes
import com.google.android.gms.nearby.connection.DiscoveredEndpointInfo
import com.google.android.gms.nearby.connection.DiscoveryOptions
import com.google.android.gms.nearby.connection.EndpointDiscoveryCallback
import com.google.android.gms.nearby.connection.Payload
import com.google.android.gms.nearby.connection.PayloadCallback
import com.google.android.gms.nearby.connection.PayloadTransferUpdate
import com.google.android.gms.nearby.connection.Strategy
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.util.concurrent.ConcurrentHashMap

/**
 * The transport of spec section 7: P2P_CLUSTER, advertising and discovering at the same
 * time under one shared service id, accepting every connection, gating peers on `hello`,
 * and reconnecting natively with backoff. Nothing here knows about JavaScript.
 *
 * A peer counts as connected only after its `hello` has been seen, so `nearbyCount` never
 * includes a device that is about to be dropped for a version mismatch.
 */
class NearbyManager(
    context: Context,
    private val endpointName: String,
    private val scheduler: Scheduler,
) : Transport {

    private companion object {
        const val TAG = "OruRadio"
    }

    private val client: ConnectionsClient = Nearby.getConnectionsClient(context.applicationContext)

    private val handshaked = ConcurrentHashMap.newKeySet<String>()
    private val awaitingHello = ConcurrentHashMap.newKeySet<String>()
    private val ignored = ConcurrentHashMap.newKeySet<String>()
    private val backoffs = ConcurrentHashMap<String, ReconnectBackoff>()
    private val announcedStreamIds = ConcurrentHashMap<String, String>()
    private val activeIncoming = ConcurrentHashMap<String, String>()

    @Volatile private var listener: TransportListener? = null
    @Volatile private var running = false
    @Volatile private var transmission: PeerFanout? = null

    override fun start(listener: TransportListener) {
        this.listener = listener
        running = true

        client.startAdvertising(
            endpointName,
            RadioConfig.SERVICE_ID,
            connectionLifecycle,
            AdvertisingOptions.Builder().setStrategy(Strategy.P2P_CLUSTER).build(),
        ).addOnFailureListener { error ->
            listener.onTransportFailure("advertising_failed", error.message ?: "startAdvertising failed")
        }

        client.startDiscovery(
            RadioConfig.SERVICE_ID,
            discoveryCallback,
            DiscoveryOptions.Builder().setStrategy(Strategy.P2P_CLUSTER).build(),
        ).addOnFailureListener { error ->
            listener.onTransportFailure("discovery_failed", error.message ?: "startDiscovery failed")
        }
    }

    override fun stop() {
        running = false
        transmission?.close()
        transmission = null
        client.stopAdvertising()
        client.stopDiscovery()
        client.stopAllEndpoints()
        handshaked.clear()
        awaitingHello.clear()
        ignored.clear()
        backoffs.clear()
        announcedStreamIds.clear()
        activeIncoming.clear()
        listener = null
    }

    override fun openTransmission(streamId: String): TransmissionSink {
        val peers = handshaked.toList()
        peers.forEach { send(it, ControlMessage.TxStart(streamId)) }
        return PeerFanout(streamId, peers).also { transmission = it }
    }

    override fun closeTransmission(streamId: String) {
        transmission?.close()
        transmission = null
        handshaked.forEach { send(it, ControlMessage.TxStop(streamId)) }
    }

    // --- outgoing audio -------------------------------------------------------------------

    /**
     * One pipe per peer for the duration of one transmission. Nearby reads the read end;
     * the audio engine writes length-prefixed Opus frames into the write end. A peer whose
     * pipe breaks simply drops out of the fanout — that is a recoverable condition, not an
     * error (spec section 13).
     */
    private inner class PeerFanout(val streamId: String, peers: List<String>) : TransmissionSink {

        private val writers = ConcurrentHashMap<String, OutputStream>()

        init {
            peers.forEach { peerId ->
                try {
                    val pipe = ParcelFileDescriptor.createPipe()
                    client.sendPayload(peerId, Payload.fromStream(pipe[0]))
                    writers[peerId] = ParcelFileDescriptor.AutoCloseOutputStream(pipe[1])
                } catch (error: IOException) {
                    Log.w(TAG, "could not open an audio stream to $peerId", error)
                }
            }
        }

        override fun writeFrame(frame: ByteArray) {
            val iterator = writers.entries.iterator()
            while (iterator.hasNext()) {
                val entry = iterator.next()
                try {
                    AudioFraming.writeFrame(entry.value, frame)
                } catch (error: IOException) {
                    runCatching { entry.value.close() }
                    iterator.remove()
                }
            }
        }

        override fun close() {
            writers.values.forEach { runCatching { it.close() } }
            writers.clear()
        }
    }

    // --- connection lifecycle -------------------------------------------------------------

    private val discoveryCallback = object : EndpointDiscoveryCallback() {
        override fun onEndpointFound(endpointId: String, info: DiscoveredEndpointInfo) {
            if (info.serviceId != RadioConfig.SERVICE_ID) return
            if (endpointId in ignored || endpointId in handshaked || endpointId in awaitingHello) return
            requestConnection(endpointId)
        }

        override fun onEndpointLost(endpointId: String) {
            // Discovery keeps running; the endpoint reappears on its own when it is back.
        }
    }

    private val connectionLifecycle = object : ConnectionLifecycleCallback() {
        override fun onConnectionInitiated(endpointId: String, info: ConnectionInfo) {
            // Spec section 7: connections are accepted automatically, there is no peer UI.
            client.acceptConnection(endpointId, payloadCallback)
        }

        override fun onConnectionResult(endpointId: String, resolution: ConnectionResolution) {
            if (resolution.status.statusCode == ConnectionsStatusCodes.STATUS_OK) {
                backoffs.remove(endpointId)
                awaitingHello.add(endpointId)
                send(endpointId, ControlMessage.Hello(RadioConfig.PROTOCOL_VERSION))
            } else {
                scheduleReconnect(endpointId)
            }
        }

        override fun onDisconnected(endpointId: String) {
            awaitingHello.remove(endpointId)
            activeIncoming.remove(endpointId)?.let { streamId ->
                listener?.onIncomingAudioStopped(endpointId, streamId)
            }
            if (handshaked.remove(endpointId)) listener?.onPeerDisconnected(endpointId)
        }
    }

    private fun requestConnection(endpointId: String) {
        client.requestConnection(endpointName, endpointId, connectionLifecycle)
            .addOnFailureListener { error ->
                val code = (error as? com.google.android.gms.common.api.ApiException)?.statusCode
                if (code == ConnectionsStatusCodes.STATUS_ALREADY_CONNECTED_TO_ENDPOINT) return@addOnFailureListener
                scheduleReconnect(endpointId)
            }
    }

    /** Spec section 7: reconnection is fully native, with backoff. */
    private fun scheduleReconnect(endpointId: String) {
        if (!running || endpointId in ignored) return
        val delay = backoffs.getOrPut(endpointId) { ReconnectBackoff() }.nextDelayMs()
        scheduler.schedule(delay) {
            if (running && endpointId !in handshaked && endpointId !in ignored) {
                requestConnection(endpointId)
            }
        }
    }

    // --- payloads --------------------------------------------------------------------------

    private val payloadCallback = object : PayloadCallback() {
        override fun onPayloadReceived(endpointId: String, payload: Payload) {
            when (payload.type) {
                Payload.Type.BYTES -> payload.asBytes()?.let { handleControl(endpointId, it) }
                Payload.Type.STREAM -> payload.asStream()?.asInputStream()
                    ?.let { startReader(endpointId, it) }
                else -> Unit
            }
        }

        override fun onPayloadTransferUpdate(endpointId: String, update: PayloadTransferUpdate) {
            // Frame delivery is driven by the stream reader; nothing to do here.
        }
    }

    private fun handleControl(peerId: String, bytes: ByteArray) {
        when (val message = ControlMessageCodec.decode(bytes)) {
            is ControlMessage.Hello -> {
                if (message.version != RadioConfig.PROTOCOL_VERSION) {
                    // Spec section 7: disconnect gracefully and ignore this peer.
                    ignored.add(peerId)
                    awaitingHello.remove(peerId)
                    handshaked.remove(peerId)
                    client.disconnectFromEndpoint(peerId)
                } else {
                    awaitingHello.remove(peerId)
                    if (handshaked.add(peerId)) listener?.onPeerConnected(peerId)
                }
            }
            is ControlMessage.TxStart -> announcedStreamIds[peerId] = message.streamId
            is ControlMessage.TxStop -> activeIncoming.remove(peerId)?.let { streamId ->
                listener?.onIncomingAudioStopped(peerId, streamId)
            }
            null -> Log.w(TAG, "ignoring an unparseable control payload from $peerId")
        }
    }

    /**
     * One thread per incoming transmission. The stream itself is the authoritative
     * boundary: `tx-start` only supplies the stream id, and whichever of `tx-stop` and the
     * end of the stream lands first ends the transmission (the engine is idempotent).
     */
    private fun startReader(peerId: String, input: InputStream) {
        val streamId = announcedStreamIds.remove(peerId) ?: "unknown"
        activeIncoming[peerId] = streamId
        listener?.onIncomingAudioStarted(peerId, streamId)

        Thread({
            try {
                while (true) {
                    val frame = AudioFraming.readFrame(input) ?: break
                    listener?.onIncomingAudioFrame(peerId, frame)
                }
            } catch (error: IOException) {
                Log.w(TAG, "audio stream from $peerId ended", error)
            } finally {
                runCatching { input.close() }
                activeIncoming.remove(peerId)?.let { listener?.onIncomingAudioStopped(peerId, it) }
            }
        }, "oru-rx-$peerId").start()
    }

    private fun send(peerId: String, message: ControlMessage) {
        client.sendPayload(peerId, Payload.fromBytes(ControlMessageCodec.encode(message)))
    }
}
```

- [ ] **Step 3: Write the failing JavaScript test**

In `__tests__/android-radio.test.ts`, change the first import line to

```ts
import {existsSync, readdirSync, readFileSync} from 'fs';
```

and append:

```ts
describe('nearby transport (spec section 7)', () => {
  const nearby = () => read(`${RADIO_DIR}/NearbyManager.kt`);

  it('depends on Google Play Services Nearby', () => {
    expect(read('android/app/build.gradle')).toMatch(
      /com\.google\.android\.gms:play-services-nearby:\d+\.\d+\.\d+/,
    );
  });

  it('advertises and discovers at the same time with P2P_CLUSTER', () => {
    expect(nearby()).toMatch(/client\.startAdvertising\(/);
    expect(nearby()).toMatch(/client\.startDiscovery\(/);
    expect(nearby().match(/Strategy\.P2P_CLUSTER/g)).toHaveLength(2);
  });

  it('accepts every connection automatically', () => {
    expect(nearby()).toMatch(/client\.acceptConnection\(endpointId, payloadCallback\)/);
  });

  it('gates peers on the hello version and drops mismatches', () => {
    expect(nearby()).toMatch(/message\.version != RadioConfig\.PROTOCOL_VERSION/);
    expect(nearby()).toMatch(/client\.disconnectFromEndpoint\(peerId\)/);
  });

  it('leaves no engine file importing React Native (spec section 6)', () => {
    const files = readdirSync(join(REPO_ROOT, RADIO_DIR)).filter(name =>
      name.endsWith('.kt'),
    );
    expect(files.length).toBeGreaterThan(0);
    files.forEach(name => {
      expect(read(`${RADIO_DIR}/${name}`)).not.toMatch(/com\.facebook\./);
    });
  });
});
```

- [ ] **Step 4: Run the JavaScript test**

Run: `pnpm test __tests__/android-radio.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the Kotlin tests and the task gate**

Run: `pnpm build:android :app:testDebugUnitTest`
Expected: PASS — nothing new, but `NearbyManager` must compile.

Run: `pnpm typecheck && pnpm lint && pnpm test __tests__/android-radio.test.ts && pnpm build:android`
Expected: all four green.

- [ ] **Step 6: Commit**

```bash
git add android/app/build.gradle android/app/src/main/java/com/oru/radio/NearbyManager.kt __tests__/android-radio.test.ts
git commit -m "feat(android): add the Nearby Connections transport with hello gating and native reconnect"
```

---

### Task 6: The jitter buffer and the mixer

Both are pure, both are the parts of the audio path that can actually be wrong, and both are
fully unit-tested here so Task 7 is only plumbing.

**Files:**
- Create: `android/app/src/main/java/com/oru/radio/JitterBuffer.kt`
- Create: `android/app/src/main/java/com/oru/radio/AudioMixer.kt`
- Test: `android/app/src/test/java/com/oru/radio/JitterBufferTest.kt`
- Test: `android/app/src/test/java/com/oru/radio/AudioMixerTest.kt`

**Interfaces:**
- Consumes: `RadioConfig.JITTER_TARGET_FRAMES`, `JITTER_MIN_FRAMES`, `JITTER_CAPACITY_FRAMES`
  (Task 1).
- Produces:
  ```kotlin
  class JitterBuffer(targetFrames: Int, resumeFrames: Int, capacityFrames: Int) {
      fun push(frame: ByteArray)
      fun pop(): ByteArray?     // null while filling or on underrun
      val size: Int
  }
  object AudioMixer { fun mix(sources: List<ShortArray>, out: ShortArray) }
  ```
  Task 7 is the only consumer.

- [ ] **Step 1: Write the failing jitter buffer test**

Create `android/app/src/test/java/com/oru/radio/JitterBufferTest.kt`:

```kotlin
package com.oru.radio

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class JitterBufferTest {

    private fun frame(value: Int) = byteArrayOf(value.toByte())

    @Test
    fun `playback waits for the target of three frames`() {
        val buffer = JitterBuffer()

        buffer.push(frame(1))
        assertNull(buffer.pop())
        buffer.push(frame(2))
        assertNull(buffer.pop())
        buffer.push(frame(3))

        assertArrayEquals(frame(1), buffer.pop())
    }

    @Test
    fun `frames come out in order`() {
        val buffer = JitterBuffer()
        (1..3).forEach { buffer.push(frame(it)) }

        assertArrayEquals(frame(1), buffer.pop())
        assertArrayEquals(frame(2), buffer.pop())
        assertArrayEquals(frame(3), buffer.pop())
        assertNull(buffer.pop())
    }

    @Test
    fun `after an underrun playback resumes at the minimum of two frames`() {
        val buffer = JitterBuffer()
        (1..3).forEach { buffer.push(frame(it)) }
        repeat(3) { buffer.pop() }
        assertNull(buffer.pop())

        buffer.push(frame(4))
        assertNull(buffer.pop())

        buffer.push(frame(5))
        assertArrayEquals(frame(4), buffer.pop())
    }

    @Test
    fun `a buffer past its capacity drops the oldest frames`() {
        val buffer = JitterBuffer(targetFrames = 2, resumeFrames = 2, capacityFrames = 3)
        (1..5).forEach { buffer.push(frame(it)) }

        assertEquals(3, buffer.size)
        assertArrayEquals(frame(3), buffer.pop())
    }
}
```

- [ ] **Step 2: Write the failing mixer test**

Create `android/app/src/test/java/com/oru/radio/AudioMixerTest.kt`:

```kotlin
package com.oru.radio

import org.junit.Assert.assertArrayEquals
import org.junit.Test

class AudioMixerTest {

    @Test
    fun `no sources means silence`() {
        val out = shortArrayOf(7, 7, 7)

        AudioMixer.mix(emptyList(), out)

        assertArrayEquals(shortArrayOf(0, 0, 0), out)
    }

    @Test
    fun `a single source passes through unchanged`() {
        val out = ShortArray(3)

        AudioMixer.mix(listOf(shortArrayOf(1, -2, 3)), out)

        assertArrayEquals(shortArrayOf(1, -2, 3), out)
    }

    @Test
    fun `concurrent transmitters are summed`() {
        val out = ShortArray(3)

        AudioMixer.mix(listOf(shortArrayOf(100, -100, 0), shortArrayOf(50, -50, 25)), out)

        assertArrayEquals(shortArrayOf(150, -150, 25), out)
    }

    @Test
    fun `the sum saturates instead of wrapping around`() {
        val out = ShortArray(2)

        AudioMixer.mix(
            listOf(
                shortArrayOf(Short.MAX_VALUE, Short.MIN_VALUE),
                shortArrayOf(Short.MAX_VALUE, Short.MIN_VALUE),
            ),
            out,
        )

        assertArrayEquals(shortArrayOf(Short.MAX_VALUE, Short.MIN_VALUE), out)
    }

    @Test
    fun `a shorter source is treated as silence past its end`() {
        val out = ShortArray(3)

        AudioMixer.mix(listOf(shortArrayOf(5, 5), shortArrayOf(1, 1, 1)), out)

        assertArrayEquals(shortArrayOf(6, 6, 1), out)
    }
}
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm build:android :app:testDebugUnitTest`
Expected: FAIL — `Unresolved reference: JitterBuffer` and `AudioMixer`.

- [ ] **Step 4: Write `JitterBuffer.kt`**

```kotlin
package com.oru.radio

/**
 * The 2-3 frame (40-60 ms) receive buffer of spec section 8. Frames are pushed by the
 * engine thread and pulled by the playback thread, so every method is synchronized; the
 * logic itself is plain and has no Android dependency.
 */
class JitterBuffer(
    private val targetFrames: Int = RadioConfig.JITTER_TARGET_FRAMES,
    private val resumeFrames: Int = RadioConfig.JITTER_MIN_FRAMES,
    private val capacityFrames: Int = RadioConfig.JITTER_CAPACITY_FRAMES,
) {
    private val frames = ArrayDeque<ByteArray>()

    /** True while waiting for enough frames to start (or restart) playback. */
    private var filling = true

    /** False until the first frame has ever been played, which picks the fill threshold. */
    private var started = false

    val size: Int
        @Synchronized get() = frames.size

    @Synchronized
    fun push(frame: ByteArray) {
        if (frames.size >= capacityFrames) frames.removeFirst()
        frames.addLast(frame)
    }

    /** The next frame, or null while filling — the caller plays silence for that slot. */
    @Synchronized
    fun pop(): ByteArray? {
        if (filling) {
            if (frames.size < if (started) resumeFrames else targetFrames) return null
            filling = false
        }
        val frame = frames.removeFirstOrNull()
        if (frame == null) {
            filling = true
            return null
        }
        started = true
        return frame
    }
}
```

- [ ] **Step 5: Write `AudioMixer.kt`**

```kotlin
package com.oru.radio

/**
 * Spec section 7: there is no floor control, so a receiver mixes concurrent transmitters.
 * Summing with saturation is the whole policy; the practical design limit is 2 speakers.
 */
object AudioMixer {

    fun mix(sources: List<ShortArray>, out: ShortArray) {
        for (index in out.indices) {
            var sum = 0
            for (source in sources) {
                if (index < source.size) sum += source[index]
            }
            out[index] = when {
                sum > Short.MAX_VALUE -> Short.MAX_VALUE
                sum < Short.MIN_VALUE -> Short.MIN_VALUE
                else -> sum.toShort()
            }
        }
    }
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm build:android :app:testDebugUnitTest`
Expected: PASS — 9 new tests.

- [ ] **Step 7: Run the task gate**

Run: `pnpm typecheck && pnpm lint && pnpm test __tests__/android-radio.test.ts && pnpm build:android`
Expected: all four green.

- [ ] **Step 8: Commit**

```bash
git add android/app/src/main/java/com/oru/radio android/app/src/test/java/com/oru/radio
git commit -m "feat(android): add the jitter buffer and the concurrent-stream mixer"
```

---

### Task 7: `AudioEngine` — capture, encode, decode, mix, play

**Files:**
- Create: `android/app/src/main/java/com/oru/radio/AudioEngine.kt`
- Test: `__tests__/android-radio.test.ts` (append a describe block)

**Interfaces:**
- Consumes: `AudioIo`, `TransmissionSink` (Task 4); `JitterBuffer`, `AudioMixer` (Task 6);
  `OpusEncoder`, `OpusDecoder`, `OpusException` (Task 2); every `RadioConfig` audio constant
  (Task 1).
- Produces: `class AudioEngine : AudioIo`. Task 10 constructs it; nothing else uses it.

- [ ] **Step 1: Write `AudioEngine.kt`**

```kotlin
package com.oru.radio

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.AudioTrack
import android.media.MediaRecorder
import android.util.Log
import java.util.concurrent.ConcurrentHashMap

/**
 * The audio pipeline of spec section 8:
 *
 *   microphone -> PCM 16 kHz mono -> Opus 20 ms -> TransmissionSink
 *   incoming frames -> jitter buffer -> Opus decode -> mix -> AudioTrack
 *
 * Two threads: one for capture (started only while transmitting) and one for playback
 * (running while at least one peer is transmitting). Both are paced by the audio hardware,
 * so neither spins. JS never sees a frame.
 */
class AudioEngine : AudioIo {

    private companion object {
        const val TAG = "OruRadio"
        const val BYTES_PER_SAMPLE = 2
        const val BUFFER_FRAMES = 4
    }

    private class Playback(
        val jitter: JitterBuffer = JitterBuffer(),
        val decoder: OpusDecoder = OpusDecoder(),
        val pcm: ShortArray = ShortArray(RadioConfig.FRAME_SAMPLES),
    )

    private val playbacks = ConcurrentHashMap<String, Playback>()

    @Volatile private var capturing = false
    @Volatile private var playing = false
    @Volatile private var onFailure: ((String, String) -> Unit)? = null
    private var captureThread: Thread? = null
    private var playbackThread: Thread? = null

    override fun setFailureListener(listener: (code: String, message: String) -> Unit) {
        onFailure = listener
    }

    // --- capture ---------------------------------------------------------------------------

    override fun startCapture(sink: TransmissionSink) {
        if (capturing) return
        capturing = true
        captureThread = Thread({ captureLoop(sink) }, "oru-capture").apply {
            priority = Thread.MAX_PRIORITY
            start()
        }
    }

    override fun stopCapture() {
        capturing = false
        captureThread?.join(500)
        captureThread = null
    }

    private fun captureLoop(sink: TransmissionSink) {
        var record: AudioRecord? = null
        var encoder: OpusEncoder? = null
        try {
            val minimum = AudioRecord.getMinBufferSize(
                RadioConfig.SAMPLE_RATE_HZ,
                AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT,
            )
            val bufferBytes = maxOf(
                minimum,
                RadioConfig.FRAME_SAMPLES * BYTES_PER_SAMPLE * BUFFER_FRAMES,
            )
            // VOICE_COMMUNICATION gives us the system's echo cancellation and noise
            // suppression (spec section 8).
            record = AudioRecord(
                MediaRecorder.AudioSource.VOICE_COMMUNICATION,
                RadioConfig.SAMPLE_RATE_HZ,
                AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT,
                bufferBytes,
            )
            if (record.state != AudioRecord.STATE_INITIALIZED) {
                Log.e(TAG, "AudioRecord did not initialize")
                onFailure?.invoke("microphone_unavailable", "AudioRecord did not initialize")
                return
            }

            encoder = OpusEncoder()
            val pcm = ShortArray(RadioConfig.FRAME_SAMPLES)
            val encoded = ByteArray(RadioConfig.MAX_ENCODED_FRAME_BYTES)

            record.startRecording()
            while (capturing) {
                var offset = 0
                while (offset < pcm.size && capturing) {
                    val read = record.read(pcm, offset, pcm.size - offset)
                    if (read <= 0) break
                    offset += read
                }
                if (offset < pcm.size) continue

                val length = encoder.encode(pcm, RadioConfig.FRAME_SAMPLES, encoded)
                if (length > 0) sink.writeFrame(encoded.copyOf(length))
            }
        } catch (error: Exception) {
            Log.e(TAG, "capture stopped on an error", error)
            onFailure?.invoke("capture_failed", error.message ?: error.javaClass.simpleName)
        } finally {
            runCatching { record?.stop() }
            record?.release()
            encoder?.close()
        }
    }

    // --- playback --------------------------------------------------------------------------

    override fun openPlayback(peerId: String) {
        if (playbacks.containsKey(peerId)) return
        try {
            playbacks[peerId] = Playback()
        } catch (error: OpusException) {
            Log.e(TAG, "no decoder for $peerId", error)
            onFailure?.invoke("decoder_unavailable", error.message ?: "opus_decoder_create failed")
            return
        }
        startPlayback()
    }

    override fun playFrame(peerId: String, frame: ByteArray) {
        playbacks[peerId]?.jitter?.push(frame)
    }

    override fun closePlayback(peerId: String) {
        playbacks.remove(peerId)?.decoder?.close()
        if (playbacks.isEmpty()) stopPlayback()
    }

    override fun release() {
        stopCapture()
        playbacks.keys.toList().forEach { closePlayback(it) }
        stopPlayback()
    }

    private fun startPlayback() {
        if (playing) return
        playing = true
        playbackThread = Thread(::playbackLoop, "oru-playback").apply {
            priority = Thread.MAX_PRIORITY
            start()
        }
    }

    private fun stopPlayback() {
        if (!playing) return
        playing = false
        playbackThread?.join(500)
        playbackThread = null
    }

    private fun playbackLoop() {
        var track: AudioTrack? = null
        try {
            val minimum = AudioTrack.getMinBufferSize(
                RadioConfig.SAMPLE_RATE_HZ,
                AudioFormat.CHANNEL_OUT_MONO,
                AudioFormat.ENCODING_PCM_16BIT,
            )
            track = AudioTrack.Builder()
                .setAudioAttributes(
                    AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
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
                    maxOf(minimum, RadioConfig.FRAME_SAMPLES * BYTES_PER_SAMPLE * BUFFER_FRAMES),
                )
                .setTransferMode(AudioTrack.MODE_STREAM)
                .build()

            val mixed = ShortArray(RadioConfig.FRAME_SAMPLES)
            val ready = ArrayList<ShortArray>(4)
            track.play()

            while (playing) {
                ready.clear()
                for (playback in playbacks.values) {
                    val frame = playback.jitter.pop() ?: continue
                    val samples = playback.decoder.decode(
                        frame,
                        frame.size,
                        playback.pcm,
                        RadioConfig.FRAME_SAMPLES,
                    )
                    // playback.pcm is reused, which is safe: it is mixed below, before
                    // this peer decodes again on the next iteration.
                    if (samples > 0) ready.add(playback.pcm)
                }
                AudioMixer.mix(ready, mixed)
                // A silent frame when nothing is ready keeps AudioTrack's blocking write
                // pacing this loop at real time instead of spinning.
                track.write(mixed, 0, mixed.size)
            }
        } catch (error: Exception) {
            Log.e(TAG, "playback stopped on an error", error)
            onFailure?.invoke("playback_failed", error.message ?: error.javaClass.simpleName)
        } finally {
            runCatching { track?.stop() }
            track?.release()
        }
    }
}
```

- [ ] **Step 2: Write the failing JavaScript test**

Append to `__tests__/android-radio.test.ts`:

```ts
describe('audio pipeline (spec section 8)', () => {
  const audio = () => read(`${RADIO_DIR}/AudioEngine.kt`);

  it('captures from VOICE_COMMUNICATION at the configured rate', () => {
    expect(audio()).toMatch(/MediaRecorder\.AudioSource\.VOICE_COMMUNICATION/);
    expect(audio()).toMatch(/RadioConfig\.SAMPLE_RATE_HZ/);
    expect(audio()).toMatch(/AudioFormat\.CHANNEL_IN_MONO/);
    expect(audio()).toMatch(/AudioFormat\.ENCODING_PCM_16BIT/);
  });

  it('plays back through AudioTrack and mixes concurrent streams', () => {
    expect(audio()).toMatch(/AudioTrack\.Builder\(\)/);
    expect(audio()).toMatch(/AudioMixer\.mix\(ready, mixed\)/);
    expect(audio()).toMatch(/JitterBuffer\(\)/);
  });

  it('uses embedded libopus rather than a platform codec', () => {
    expect(audio()).toMatch(/OpusEncoder\(\)/);
    expect(audio()).toMatch(/OpusDecoder\(\)/);
    expect(audio()).not.toMatch(/MediaCodec/);
  });

  it('hard-codes no audio parameter of its own', () => {
    expect(audio()).not.toMatch(/16_?000/);
    expect(audio()).not.toMatch(/24_?000/);
  });
});
```

- [ ] **Step 3: Run the JavaScript test**

Run: `pnpm test __tests__/android-radio.test.ts`
Expected: PASS.

- [ ] **Step 4: Run the Kotlin tests and the task gate**

Run: `pnpm build:android :app:testDebugUnitTest`
Expected: PASS — `AudioEngine` must compile; earlier tests stay green.

Run: `pnpm typecheck && pnpm lint && pnpm test __tests__/android-radio.test.ts && pnpm build:android`
Expected: all four green.

- [ ] **Step 5: Commit**

```bash
git add android/app/src/main/java/com/oru/radio/AudioEngine.kt __tests__/android-radio.test.ts
git commit -m "feat(android): add the AudioRecord/libopus/AudioTrack audio engine"
```

---

### Task 8: `PttManager` — the pairing session, driver selection and binding persistence

**Files:**
- Create: `android/app/src/main/java/com/oru/radio/PttBindingStore.kt`
- Create: `android/app/src/main/java/com/oru/radio/PttManager.kt`
- Test: `android/app/src/test/java/com/oru/radio/PttManagerTest.kt`

**Interfaces:**
- Consumes: `PttSource`, `PttListener`, `PttLearningListener`, `PttButtonState`,
  `PttPairingState`, `PttPairingPhase`, `PttCandidate`, `Scheduler`, `Cancellable` (Task 4);
  `PttBinding`, `PttConfiguration`, `PttBindingCodec` (Task 3);
  `RadioConfig.PAIRING_TIMEOUT_MS` (Task 1).
- Produces:
  ```kotlin
  interface PttBindingStore { fun load(): PttConfiguration?; fun save(c: PttConfiguration); fun clear() }
  class SharedPreferencesPttBindingStore(context: Context) : PttBindingStore
  interface PttDriver { fun start(); fun stop() }
  interface PttDriverListener { fun onPressed(); fun onReleased(); fun onConnectionChanged(connected: Boolean) }
  interface PttDriverFactory {
      fun create(binding: PttBinding, listener: PttDriverListener): PttDriver?
      fun startLearning(listener: PttLearningListener)
      fun selectCandidate(deviceId: String)
      fun cancelLearning()
  }
  enum class PttDriverKind { BLE, MEDIA_BUTTON, HID }
  object PttDriverSelection { fun kindFor(binding: PttBinding): PttDriverKind }
  class PttManager(store: PttBindingStore, drivers: PttDriverFactory, scheduler: Scheduler)
      : PttSource, PttDriverListener, PttLearningListener
  ```
  Task 9 implements `PttDriverFactory`; Task 10 constructs `PttManager`.

- [ ] **Step 1: Write the failing test**

Create `android/app/src/test/java/com/oru/radio/PttManagerTest.kt`:

```kotlin
package com.oru.radio

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class PttManagerTest {

    private class FakeStore(var stored: PttConfiguration? = null) : PttBindingStore {
        var cleared = false
        override fun load(): PttConfiguration? = stored
        override fun save(configuration: PttConfiguration) {
            stored = configuration
        }
        override fun clear() {
            stored = null
            cleared = true
        }
    }

    private class FakeDriver(val binding: PttBinding) : PttDriver {
        var started = false
        var stopped = false
        override fun start() {
            started = true
        }
        override fun stop() {
            stopped = true
        }
    }

    private class FakeFactory : PttDriverFactory {
        val created = mutableListOf<FakeDriver>()
        var driverListener: PttDriverListener? = null
        var learningListener: PttLearningListener? = null
        var selectedDevice: String? = null
        var learningCancelled = 0

        override fun create(binding: PttBinding, listener: PttDriverListener): PttDriver {
            driverListener = listener
            return FakeDriver(binding).also { created.add(it) }
        }

        override fun startLearning(listener: PttLearningListener) {
            learningListener = listener
        }

        override fun selectCandidate(deviceId: String) {
            selectedDevice = deviceId
        }

        override fun cancelLearning() {
            learningCancelled++
        }
    }

    private class RecordingPttListener : PttListener {
        var presses = 0
        var releases = 0
        val states = mutableListOf<PttButtonState>()
        val pairings = mutableListOf<PttPairingState?>()
        val failures = mutableListOf<Pair<String, String>>()

        override fun onPttPressed() {
            presses++
        }
        override fun onPttReleased() {
            releases++
        }
        override fun onPttButtonStateChanged(state: PttButtonState) {
            states.add(state)
        }
        override fun onPttPairingChanged(pairing: PttPairingState?) {
            pairings.add(pairing)
        }
        override fun onPttPairingFailed(code: String, message: String) {
            failures.add(code to message)
        }

        val lastPairing: PttPairingState? get() = pairings.last()
    }

    private val bleConfiguration = PttConfiguration(
        name = "PTT-Button",
        binding = PttBinding.Ble(
            deviceId = "AA:BB:CC:DD:EE:FF",
            serviceUuid = "0000ffe0-0000-1000-8000-00805f9b34fb",
            characteristicUuid = "0000ffe1-0000-1000-8000-00805f9b34fb",
            pressedValue = "01",
            releasedValue = "00",
        ),
    )

    private lateinit var store: FakeStore
    private lateinit var factory: FakeFactory
    private lateinit var listener: RecordingPttListener
    private lateinit var scheduler: TestScheduler
    private lateinit var manager: PttManager

    @Before
    fun setUp() {
        store = FakeStore()
        factory = FakeFactory()
        listener = RecordingPttListener()
        scheduler = TestScheduler()
        manager = PttManager(store, factory, scheduler)
    }

    @Test
    fun `with nothing stored the button is simply not configured`() {
        manager.start(listener)

        assertEquals(PttButtonState(false, false, null), manager.snapshot())
        assertTrue(factory.created.isEmpty())
    }

    @Test
    fun `a stored binding is reconnected automatically on start`() {
        store.stored = bleConfiguration

        manager.start(listener)

        assertEquals(1, factory.created.size)
        assertEquals(bleConfiguration.binding, factory.created.single().binding)
        assertTrue(factory.created.single().started)
        assertEquals(PttButtonState(true, false, "PTT-Button"), manager.snapshot())
    }

    @Test
    fun `driver connection is state, not an error`() {
        store.stored = bleConfiguration
        manager.start(listener)

        factory.driverListener!!.onConnectionChanged(true)

        assertEquals(PttButtonState(true, true, "PTT-Button"), manager.snapshot())
        assertEquals(PttButtonState(true, true, "PTT-Button"), listener.states.last())
    }

    @Test
    fun `presses and releases reach the engine`() {
        store.stored = bleConfiguration
        manager.start(listener)

        factory.driverListener!!.onPressed()
        factory.driverListener!!.onReleased()

        assertEquals(1, listener.presses)
        assertEquals(1, listener.releases)
    }

    @Test
    fun `pairing opens with the scanning phase and no candidates`() {
        manager.start(listener)

        manager.startPairing()

        assertEquals(PttPairingState(PttPairingPhase.SCANNING, emptyList()), listener.lastPairing)
    }

    @Test
    fun `found devices become candidates, strongest signal first`() {
        manager.start(listener)
        manager.startPairing()

        factory.learningListener!!.onDeviceFound("11:22:33:44:55:66", null, -80)
        factory.learningListener!!.onDeviceFound("AA:BB:CC:DD:EE:FF", "PTT-Button", -54)

        assertEquals(
            listOf(
                // A nameless device is published under its own address: the contract's
                // candidate name is not optional.
                PttCandidate("AA:BB:CC:DD:EE:FF", "PTT-Button", -54),
                PttCandidate("11:22:33:44:55:66", "11:22:33:44:55:66", -80),
            ),
            listener.lastPairing!!.candidates,
        )
        assertEquals(PttPairingPhase.SCANNING, listener.lastPairing!!.phase)
    }

    @Test
    fun `the same device found twice is one candidate`() {
        manager.start(listener)
        manager.startPairing()

        factory.learningListener!!.onDeviceFound("AA:BB:CC:DD:EE:FF", "PTT-Button", -70)
        factory.learningListener!!.onDeviceFound("AA:BB:CC:DD:EE:FF", "PTT-Button", -54)

        assertEquals(
            listOf(PttCandidate("AA:BB:CC:DD:EE:FF", "PTT-Button", -54)),
            listener.lastPairing!!.candidates,
        )
    }

    @Test
    fun `selecting a candidate moves the session to learning and reaches the driver`() {
        manager.start(listener)
        manager.startPairing()

        manager.selectCandidate("AA:BB:CC:DD:EE:FF")

        assertEquals("AA:BB:CC:DD:EE:FF", factory.selectedDevice)
        assertEquals(PttPairingPhase.LEARNING, listener.lastPairing!!.phase)
    }

    @Test
    fun `selecting a candidate outside a session does nothing`() {
        manager.start(listener)

        manager.selectCandidate("AA:BB:CC:DD:EE:FF")

        assertNull(factory.selectedDevice)
    }

    @Test
    fun `a learned binding is saved, attached, and published as the saved phase`() {
        manager.start(listener)
        manager.startPairing()
        manager.selectCandidate("AA:BB:CC:DD:EE:FF")

        factory.learningListener!!.onLearned(bleConfiguration)

        assertEquals(bleConfiguration, store.stored)
        assertEquals(1, factory.created.size)
        assertTrue(factory.created.single().started)
        assertEquals(PttButtonState(true, false, "PTT-Button"), manager.snapshot())
        assertEquals(PttPairingPhase.SAVED, listener.lastPairing!!.phase)
    }

    @Test
    fun `a failed learning attempt clears the session and reports the failure`() {
        manager.start(listener)
        manager.startPairing()

        factory.learningListener!!.onLearningFailed("scan_failed", "no adapter")

        assertNull(store.stored)
        assertTrue(factory.created.isEmpty())
        assertNull(listener.lastPairing)
        assertEquals(listOf("scan_failed" to "no adapter"), listener.failures)
    }

    @Test
    fun `an unanswered pairing session times out`() {
        manager.start(listener)
        manager.startPairing()

        scheduler.advance(RadioConfig.PAIRING_TIMEOUT_MS)

        assertNull(listener.lastPairing)
        assertEquals(
            listOf("pairing_timeout" to "No PTT button was paired in time"),
            listener.failures,
        )
    }

    @Test
    fun `a saved session does not time out afterwards`() {
        manager.start(listener)
        manager.startPairing()
        factory.learningListener!!.onLearned(bleConfiguration)

        scheduler.advance(RadioConfig.PAIRING_TIMEOUT_MS * 2)

        assertEquals(PttPairingPhase.SAVED, listener.lastPairing!!.phase)
        assertTrue(listener.failures.isEmpty())
    }

    @Test
    fun `cancelling ends the session without reporting a failure`() {
        manager.start(listener)
        manager.startPairing()

        manager.cancelPairing()

        assertNull(listener.lastPairing)
        assertTrue(listener.failures.isEmpty())
        assertEquals(1, factory.learningCancelled)
    }

    @Test
    fun `forgetting stops the driver, clears storage and resets the state`() {
        store.stored = bleConfiguration
        manager.start(listener)

        manager.forget()

        assertTrue(factory.created.single().stopped)
        assertTrue(store.cleared)
        assertEquals(PttButtonState(false, false, null), manager.snapshot())
        assertEquals(PttButtonState(false, false, null), listener.states.last())
    }

    @Test
    fun `stopping releases the driver`() {
        store.stored = bleConfiguration
        manager.start(listener)

        manager.stop()

        assertTrue(factory.created.single().stopped)
        assertFalse(manager.snapshot().connected)
    }

    @Test
    fun `driver selection follows the binding`() {
        assertEquals(PttDriverKind.BLE, PttDriverSelection.kindFor(bleConfiguration.binding))
        // KEYCODE_MEDIA_PLAY_PAUSE (85) and KEYCODE_HEADSETHOOK (79) arrive through a
        // MediaSession, which is the only way to hear them in the background.
        assertEquals(PttDriverKind.MEDIA_BUTTON, PttDriverSelection.kindFor(PttBinding.Hid(85)))
        assertEquals(PttDriverKind.MEDIA_BUTTON, PttDriverSelection.kindFor(PttBinding.Hid(79)))
        assertEquals(PttDriverKind.HID, PttDriverSelection.kindFor(PttBinding.Hid(66)))
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm build:android :app:testDebugUnitTest`
Expected: FAIL — `Unresolved reference: PttManager`.

- [ ] **Step 3: Write `PttBindingStore.kt`**

```kotlin
package com.oru.radio

import android.content.Context

/** Spec section 9.2: the binding is stored natively and survives radio restarts. */
interface PttBindingStore {
    fun load(): PttConfiguration?
    fun save(configuration: PttConfiguration)
    fun clear()
}

class SharedPreferencesPttBindingStore(context: Context) : PttBindingStore {

    private companion object {
        const val FILE = "oru.ptt"
        const val KEY = "configuration"
    }

    private val preferences =
        context.applicationContext.getSharedPreferences(FILE, Context.MODE_PRIVATE)

    override fun load(): PttConfiguration? =
        PttBindingCodec.decode(preferences.getString(KEY, null))

    override fun save(configuration: PttConfiguration) {
        preferences.edit().putString(KEY, PttBindingCodec.encode(configuration)).apply()
    }

    override fun clear() {
        preferences.edit().remove(KEY).apply()
    }
}
```

- [ ] **Step 4: Write `PttManager.kt`**

```kotlin
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
 */
class PttManager(
    private val store: PttBindingStore,
    private val drivers: PttDriverFactory,
    private val scheduler: Scheduler,
) : PttSource, PttDriverListener, PttLearningListener {

    private var listener: PttListener? = null
    private var driver: PttDriver? = null
    private var configuration: PttConfiguration? = null
    private var connected = false

    private val candidates = LinkedHashMap<String, PttCandidate>()
    private var pairing: PttPairingState? = null
    private var pairingTimeout: Cancellable? = null

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
        pairingTimeout = scheduler.schedule(RadioConfig.PAIRING_TIMEOUT_MS) {
            failPairing("pairing_timeout", "No PTT button was paired in time")
        }
        publishPairing(PttPairingPhase.SCANNING)
        drivers.startLearning(this)
    }

    override fun selectCandidate(deviceId: String) {
        if (pairing == null) return
        publishPairing(PttPairingPhase.LEARNING)
        drivers.selectCandidate(deviceId)
    }

    override fun cancelPairing() {
        if (pairing == null) return
        endPairing()
        listener?.onPttPairingChanged(null)
    }

    // --- learning callbacks from the driver factory --------------------------------------

    override fun onDeviceFound(deviceId: String, name: String?, rssi: Int) {
        if (pairing?.phase != PttPairingPhase.SCANNING) return
        candidates[deviceId] = PttCandidate(deviceId, name ?: deviceId, rssi)
        publishPairing(PttPairingPhase.SCANNING)
    }

    override fun onLearned(configuration: PttConfiguration) {
        pairingTimeout?.cancel()
        pairingTimeout = null
        store.save(configuration)
        this.configuration = configuration
        connected = false
        attach()
        publishPairing(PttPairingPhase.SAVED)
    }

    override fun onLearningFailed(code: String, message: String) {
        failPairing(code, message)
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
    }

    private fun publishPairing(phase: PttPairingPhase) {
        // Strongest signal first. The pick itself is always the user's: an automatic
        // strongest-signal pick would be a safety net only, and this plan does not add one.
        pairing = PttPairingState(phase, candidates.values.sortedByDescending { it.rssi })
        listener?.onPttPairingChanged(pairing)
    }

    override fun forget() {
        driver?.stop()
        driver = null
        configuration = null
        connected = false
        store.clear()
        publish()
    }

    // --- driver events -----------------------------------------------------------------

    override fun onPressed() {
        listener?.onPttPressed()
    }

    override fun onReleased() {
        listener?.onPttReleased()
    }

    override fun onConnectionChanged(connected: Boolean) {
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
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm build:android :app:testDebugUnitTest`
Expected: PASS — 17 new tests in `PttManagerTest`.

- [ ] **Step 6: Run the task gate**

Run: `pnpm typecheck && pnpm lint && pnpm test __tests__/android-radio.test.ts && pnpm build:android`
Expected: all four green.

- [ ] **Step 7: Commit**

```bash
git add android/app/src/main/java/com/oru/radio android/app/src/test/java/com/oru/radio
git commit -m "feat(android): add PttManager, the pairing session and binding persistence"
```

---

### Task 9: The three PTT drivers and the BLE learning flow

**Files:**
- Create: `android/app/src/main/java/com/oru/radio/PttLearningStateMachine.kt`
- Create: `android/app/src/main/java/com/oru/radio/BleGattPttDriver.kt`
- Create: `android/app/src/main/java/com/oru/radio/HidPttDriver.kt`
- Create: `android/app/src/main/java/com/oru/radio/MediaButtonPttDriver.kt`
- Create: `android/app/src/main/java/com/oru/radio/AndroidPttDriverFactory.kt`
- Test: `android/app/src/test/java/com/oru/radio/PttLearningStateMachineTest.kt`

**Interfaces:**
- Consumes: `PttDriver`, `PttDriverListener`, `PttDriverFactory`, `PttDriverKind`,
  `PttDriverSelection` (Task 8); `PttBinding`, `PttConfiguration`, `PttBindingCodec.toHex`
  (Task 3); `PttLearningListener` (Task 4).
- Produces:
  ```kotlin
  class PttLearningStateMachine(deviceId: String, deviceName: String?) {
      fun onNotification(serviceUuid: String, characteristicUuid: String, valueHex: String): PttConfiguration?
      fun reset()
  }
  class BleGattPttDriver(context: Context, binding: PttBinding.Ble, listener: PttDriverListener) : PttDriver
  class HidPttDriver(keyCode: Int, listener: PttDriverListener) : PttDriver
  object HidKeyEventBus { fun dispatch(keyCode: Int, action: Int): Boolean }
  class MediaButtonPttDriver(context: Context, keyCode: Int, listener: PttDriverListener) : PttDriver
  class AndroidPttDriverFactory(context: Context) : PttDriverFactory
  ```
  Task 10 constructs `AndroidPttDriverFactory`; Task 11 calls `HidKeyEventBus.dispatch`.

- [ ] **Step 1: Write the failing learning test**

Create `android/app/src/test/java/com/oru/radio/PttLearningStateMachineTest.kt`:

```kotlin
package com.oru.radio

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class PttLearningStateMachineTest {

    private val service = "0000ffe0-0000-1000-8000-00805f9b34fb"
    private val characteristic = "0000ffe1-0000-1000-8000-00805f9b34fb"

    private fun machine(name: String? = "PTT-Button") =
        PttLearningStateMachine(deviceId = "AA:BB:CC:DD:EE:FF", deviceName = name)

    @Test
    fun `the first notification only records the pressed value`() {
        assertNull(machine().onNotification(service, characteristic, "01"))
    }

    @Test
    fun `a second, different value on the same characteristic completes the binding`() {
        val subject = machine()
        subject.onNotification(service, characteristic, "01")

        val learned = subject.onNotification(service, characteristic, "00")

        assertEquals(
            PttConfiguration(
                name = "PTT-Button",
                binding = PttBinding.Ble(
                    deviceId = "AA:BB:CC:DD:EE:FF",
                    serviceUuid = service,
                    characteristicUuid = characteristic,
                    pressedValue = "01",
                    releasedValue = "00",
                ),
            ),
            learned,
        )
    }

    @Test
    fun `repeating the pressed value is not a release`() {
        val subject = machine()
        subject.onNotification(service, characteristic, "01")

        assertNull(subject.onNotification(service, characteristic, "01"))
    }

    @Test
    fun `notifications from another characteristic are ignored once one is chosen`() {
        val subject = machine()
        subject.onNotification(service, characteristic, "01")

        assertNull(subject.onNotification(service, "0000ffe2-0000-1000-8000-00805f9b34fb", "00"))
    }

    @Test
    fun `empty notifications are ignored`() {
        val subject = machine()

        assertNull(subject.onNotification(service, characteristic, ""))
        assertNull(subject.onNotification(service, characteristic, "01"))
        assertEquals(
            "01",
            (subject.onNotification(service, characteristic, "02")!!.binding as PttBinding.Ble)
                .pressedValue,
        )
    }

    @Test
    fun `a nameless device falls back to its address`() {
        val subject = machine(name = null)
        subject.onNotification(service, characteristic, "01")

        assertEquals("AA:BB:CC:DD:EE:FF", subject.onNotification(service, characteristic, "00")!!.name)
    }

    @Test
    fun `reset starts the capture over`() {
        val subject = machine()
        subject.onNotification(service, characteristic, "01")

        subject.reset()

        assertNull(subject.onNotification(service, characteristic, "00"))
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm build:android :app:testDebugUnitTest`
Expected: FAIL — `Unresolved reference: PttLearningStateMachine`.

- [ ] **Step 3: Write `PttLearningStateMachine.kt`**

```kotlin
package com.oru.radio

/**
 * The capture half of the learning flow (spec section 9.3): the user presses the button
 * once, and the first two *different* values seen on one notifying characteristic become
 * pressedValue and releasedValue. Pure, so the rule is testable without a button.
 */
class PttLearningStateMachine(
    private val deviceId: String,
    private val deviceName: String?,
) {
    private var serviceUuid: String? = null
    private var characteristicUuid: String? = null
    private var pressedValue: String? = null

    /** Returns the finished configuration on the notification that completes it, else null. */
    fun onNotification(
        serviceUuid: String,
        characteristicUuid: String,
        valueHex: String,
    ): PttConfiguration? {
        if (valueHex.isEmpty()) return null

        val pressed = pressedValue
        if (pressed == null) {
            this.serviceUuid = serviceUuid
            this.characteristicUuid = characteristicUuid
            pressedValue = valueHex
            return null
        }

        if (serviceUuid != this.serviceUuid || characteristicUuid != this.characteristicUuid) {
            return null
        }
        if (valueHex == pressed) return null

        return PttConfiguration(
            name = deviceName ?: deviceId,
            binding = PttBinding.Ble(
                deviceId = deviceId,
                serviceUuid = serviceUuid,
                characteristicUuid = characteristicUuid,
                pressedValue = pressed,
                releasedValue = valueHex,
            ),
        )
    }

    fun reset() {
        serviceUuid = null
        characteristicUuid = null
        pressedValue = null
    }
}
```

- [ ] **Step 4: Write `BleGattPttDriver.kt`**

```kotlin
package com.oru.radio

import android.annotation.SuppressLint
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.content.Context
import android.os.Build
import android.util.Log
import java.util.UUID

/**
 * The preferred driver (spec section 9.1): a GATT notify characteristic, connected with
 * autoConnect so the platform re-establishes the link by itself when the button comes back
 * in range — that is the "button reconnects automatically" requirement of section 9.2, and
 * it costs no code of ours.
 */
@SuppressLint("MissingPermission")
class BleGattPttDriver(
    private val context: Context,
    private val binding: PttBinding.Ble,
    private val listener: PttDriverListener,
) : PttDriver {

    private companion object {
        const val TAG = "OruRadio"
        val CLIENT_CONFIG: UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")
    }

    private var gatt: BluetoothGatt? = null
    private var pressed = false

    override fun start() {
        val manager = context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
        val device = runCatching { manager?.adapter?.getRemoteDevice(binding.deviceId) }.getOrNull()
        if (device == null) {
            Log.w(TAG, "no bluetooth device ${binding.deviceId}")
            return
        }
        gatt = device.connectGatt(context, true, callback, BluetoothDevice.TRANSPORT_LE)
    }

    override fun stop() {
        runCatching {
            gatt?.disconnect()
            gatt?.close()
        }
        gatt = null
        pressed = false
        listener.onConnectionChanged(false)
    }

    private val callback = object : BluetoothGattCallback() {

        override fun onConnectionStateChange(gatt: BluetoothGatt, status: Int, newState: Int) {
            when (newState) {
                BluetoothProfile.STATE_CONNECTED -> {
                    listener.onConnectionChanged(true)
                    gatt.discoverServices()
                }
                BluetoothProfile.STATE_DISCONNECTED -> {
                    pressed = false
                    listener.onConnectionChanged(false)
                }
            }
        }

        override fun onServicesDiscovered(gatt: BluetoothGatt, status: Int) {
            val characteristic = gatt
                .getService(UUID.fromString(binding.serviceUuid))
                ?.getCharacteristic(UUID.fromString(binding.characteristicUuid))
            if (characteristic == null) {
                Log.w(TAG, "the bound characteristic is gone; the button changed firmware?")
                return
            }
            gatt.setCharacteristicNotification(characteristic, true)
            characteristic.getDescriptor(CLIENT_CONFIG)?.let { enableNotifications(gatt, it) }
        }

        override fun onCharacteristicChanged(
            gatt: BluetoothGatt,
            characteristic: BluetoothGattCharacteristic,
            value: ByteArray,
        ) {
            handle(PttBindingCodec.toHex(value))
        }

        @Deprecated("Android below 13 calls this overload instead")
        override fun onCharacteristicChanged(
            gatt: BluetoothGatt,
            characteristic: BluetoothGattCharacteristic,
        ) {
            @Suppress("DEPRECATION")
            handle(PttBindingCodec.toHex(characteristic.value ?: return))
        }
    }

    private fun enableNotifications(gatt: BluetoothGatt, descriptor: BluetoothGattDescriptor) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            gatt.writeDescriptor(descriptor, BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE)
        } else {
            @Suppress("DEPRECATION")
            descriptor.setValue(BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE)
            @Suppress("DEPRECATION")
            gatt.writeDescriptor(descriptor)
        }
    }

    /** Strictly hold-to-talk (spec section 9.4); unknown values are simply not ours. */
    private fun handle(valueHex: String) {
        when (valueHex) {
            binding.pressedValue -> if (!pressed) {
                pressed = true
                listener.onPressed()
            }
            binding.releasedValue -> if (pressed) {
                pressed = false
                listener.onReleased()
            }
            else -> Log.d(TAG, "ignoring PTT characteristic value $valueHex")
        }
    }
}
```

- [ ] **Step 5: Write `HidPttDriver.kt`**

```kotlin
package com.oru.radio

import android.view.KeyEvent
import java.util.concurrent.CopyOnWriteArrayList

/**
 * Key events do not reach a process without a focused window, which is why spec section
 * 9.1 calls HID a foreground-only fallback on Android. Whoever has a window (the spike
 * activity, later the RN activity) forwards its key events here.
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

class HidPttDriver(
    private val keyCode: Int,
    private val listener: PttDriverListener,
) : PttDriver {

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
```

- [ ] **Step 6: Write `MediaButtonPttDriver.kt`**

```kotlin
package com.oru.radio

import android.content.Context
import android.content.Intent
import android.media.session.MediaSession
import android.media.session.PlaybackState
import android.view.KeyEvent

/**
 * The background-capable fallback on Android (spec section 9.1): a media-key button on a
 * Bluetooth headset profile reaches an active MediaSession even with the screen locked.
 * The session claims a "playing" state because the system only routes media buttons to a
 * session that looks like it is playing.
 */
class MediaButtonPttDriver(
    context: Context,
    private val keyCode: Int,
    private val listener: PttDriverListener,
) : PttDriver {

    private val session = MediaSession(context.applicationContext, "OruPtt")
    private var pressed = false

    override fun start() {
        session.setPlaybackState(
            PlaybackState.Builder()
                .setActions(PlaybackState.ACTION_PLAY_PAUSE or PlaybackState.ACTION_PLAY)
                .setState(PlaybackState.STATE_PLAYING, PlaybackState.PLAYBACK_POSITION_UNKNOWN, 1.0f)
                .build(),
        )
        session.setCallback(object : MediaSession.Callback() {
            override fun onMediaButtonEvent(mediaButtonIntent: Intent): Boolean {
                @Suppress("DEPRECATION")
                val event = mediaButtonIntent
                    .getParcelableExtra<KeyEvent>(Intent.EXTRA_KEY_EVENT) ?: return false
                if (event.keyCode != keyCode) return false
                when (event.action) {
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
        })
        session.isActive = true
        listener.onConnectionChanged(true)
    }

    override fun stop() {
        pressed = false
        session.isActive = false
        session.release()
        listener.onConnectionChanged(false)
    }
}
```

- [ ] **Step 7: Write `AndroidPttDriverFactory.kt`**

```kotlin
package com.oru.radio

import android.annotation.SuppressLint
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanResult
import android.content.Context
import android.os.Build
import android.util.Log
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

/** Builds the real drivers and runs the real learning session (spec sections 9.1, 9.3). */
class AndroidPttDriverFactory(private val context: Context) : PttDriverFactory {

    private var learning: BleLearningSession? = null

    override fun create(binding: PttBinding, listener: PttDriverListener): PttDriver =
        when (PttDriverSelection.kindFor(binding)) {
            PttDriverKind.BLE ->
                BleGattPttDriver(context, binding as PttBinding.Ble, listener)
            PttDriverKind.MEDIA_BUTTON ->
                MediaButtonPttDriver(context, (binding as PttBinding.Hid).keyCode, listener)
            PttDriverKind.HID ->
                HidPttDriver((binding as PttBinding.Hid).keyCode, listener)
        }

    override fun startLearning(listener: PttLearningListener) {
        cancelLearning()
        learning = BleLearningSession(context, listener).also { it.startScan() }
    }

    override fun selectCandidate(deviceId: String) {
        learning?.select(deviceId)
    }

    override fun cancelLearning() {
        learning?.cancel()
        learning = null
    }
}

/**
 * Spec section 9.3: scan -> select -> "press the button" -> capture. Every notifying
 * characteristic of the picked device is subscribed to, one descriptor write at a time
 * (the GATT stack allows exactly one outstanding operation), and the first characteristic
 * that produces two different values wins.
 */
@SuppressLint("MissingPermission")
class BleLearningSession(
    private val context: Context,
    private val listener: PttLearningListener,
) {
    private companion object {
        const val TAG = "OruRadio"
        val CLIENT_CONFIG: UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")
    }

    private val names = ConcurrentHashMap<String, String>()
    private val pendingDescriptors = ArrayDeque<BluetoothGattDescriptor>()

    private var gatt: BluetoothGatt? = null
    private var machine: PttLearningStateMachine? = null
    private var scanning = false

    fun startScan() {
        val adapter = (context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager)?.adapter
        if (adapter == null || !adapter.isEnabled) {
            listener.onLearningFailed("bluetooth_unavailable", "Bluetooth is off or missing")
            return
        }
        val scanner = adapter.bluetoothLeScanner
        if (scanner == null) {
            listener.onLearningFailed("scan_unavailable", "No BLE scanner on this device")
            return
        }
        scanning = true
        scanner.startScan(scanCallback)
    }

    fun select(deviceId: String) {
        stopScan()
        val adapter = (context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager)?.adapter
        val device = runCatching { adapter?.getRemoteDevice(deviceId) }.getOrNull()
        if (device == null) {
            listener.onLearningFailed("unknown_device", deviceId)
            return
        }
        machine = PttLearningStateMachine(deviceId, names[deviceId] ?: device.name)
        gatt = device.connectGatt(context, false, gattCallback, BluetoothDevice.TRANSPORT_LE)
    }

    fun cancel() {
        stopScan()
        runCatching {
            gatt?.disconnect()
            gatt?.close()
        }
        gatt = null
        machine = null
        pendingDescriptors.clear()
    }

    private fun stopScan() {
        if (!scanning) return
        scanning = false
        val adapter = (context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager)?.adapter
        runCatching { adapter?.bluetoothLeScanner?.stopScan(scanCallback) }
    }

    private val scanCallback = object : ScanCallback() {
        override fun onScanResult(callbackType: Int, result: ScanResult) {
            val address = result.device?.address ?: return
            val name = result.device?.name ?: result.scanRecord?.deviceName
            if (name != null) names[address] = name
            // rssi is what orders the candidate list the pairing UI shows.
            listener.onDeviceFound(address, name, result.rssi)
        }

        override fun onScanFailed(errorCode: Int) {
            scanning = false
            listener.onLearningFailed("scan_failed", "BLE scan failed with code $errorCode")
        }
    }

    private val gattCallback = object : BluetoothGattCallback() {

        override fun onConnectionStateChange(gatt: BluetoothGatt, status: Int, newState: Int) {
            when (newState) {
                BluetoothProfile.STATE_CONNECTED -> gatt.discoverServices()
                BluetoothProfile.STATE_DISCONNECTED ->
                    listener.onLearningFailed("device_disconnected", "The button disconnected")
            }
        }

        override fun onServicesDiscovered(gatt: BluetoothGatt, status: Int) {
            pendingDescriptors.clear()
            for (service in gatt.services) {
                for (characteristic in service.characteristics) {
                    val notifies = characteristic.properties and
                        (BluetoothGattCharacteristic.PROPERTY_NOTIFY or
                            BluetoothGattCharacteristic.PROPERTY_INDICATE) != 0
                    if (!notifies) continue
                    gatt.setCharacteristicNotification(characteristic, true)
                    characteristic.getDescriptor(CLIENT_CONFIG)?.let { pendingDescriptors.addLast(it) }
                }
            }
            if (pendingDescriptors.isEmpty()) {
                listener.onLearningFailed("no_notify_characteristic", "This device notifies nothing")
                return
            }
            writeNextDescriptor(gatt)
        }

        override fun onDescriptorWrite(
            gatt: BluetoothGatt,
            descriptor: BluetoothGattDescriptor,
            status: Int,
        ) {
            writeNextDescriptor(gatt)
        }

        override fun onCharacteristicChanged(
            gatt: BluetoothGatt,
            characteristic: BluetoothGattCharacteristic,
            value: ByteArray,
        ) {
            capture(characteristic, PttBindingCodec.toHex(value))
        }

        @Deprecated("Android below 13 calls this overload instead")
        override fun onCharacteristicChanged(
            gatt: BluetoothGatt,
            characteristic: BluetoothGattCharacteristic,
        ) {
            @Suppress("DEPRECATION")
            capture(characteristic, PttBindingCodec.toHex(characteristic.value ?: return))
        }
    }

    private fun writeNextDescriptor(gatt: BluetoothGatt) {
        val descriptor = pendingDescriptors.removeFirstOrNull() ?: return
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            gatt.writeDescriptor(descriptor, BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE)
        } else {
            @Suppress("DEPRECATION")
            descriptor.setValue(BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE)
            @Suppress("DEPRECATION")
            gatt.writeDescriptor(descriptor)
        }
    }

    private fun capture(characteristic: BluetoothGattCharacteristic, valueHex: String) {
        val learned = machine?.onNotification(
            characteristic.service.uuid.toString(),
            characteristic.uuid.toString(),
            valueHex,
        ) ?: return
        Log.i(TAG, "learned a PTT binding on ${characteristic.uuid}")
        listener.onLearned(learned)
        cancel()
    }
}
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `pnpm build:android :app:testDebugUnitTest`
Expected: PASS — 7 new tests, everything else still green.

- [ ] **Step 9: Run the task gate**

Run: `pnpm typecheck && pnpm lint && pnpm test __tests__/android-radio.test.ts && pnpm build:android`
Expected: all four green.

- [ ] **Step 10: Commit**

```bash
git add android/app/src/main/java/com/oru/radio android/app/src/test/java/com/oru/radio
git commit -m "feat(android): add the BLE, HID and media-button PTT drivers and the learning flow"
```

---

### Task 10: `RadioForegroundService`, `RadioController`, and the localized notification

**Files:**
- Create: `android/app/src/main/java/com/oru/radio/RadioForegroundService.kt`
- Create: `android/app/src/main/java/com/oru/radio/RadioController.kt`
- Create: `android/app/src/main/res/values-ru/strings.xml`
- Modify: `android/app/src/main/res/values/strings.xml`
- Modify: `android/app/src/main/AndroidManifest.xml`
- Test: `__tests__/android-radio.test.ts` (append a describe block)

**Interfaces:**
- Consumes: `RadioEngine`, `HandlerScheduler`, `RadioEngineListener` (Task 4); `NearbyManager`
  (Task 5); `AudioEngine` (Task 7); `PttManager`, `SharedPreferencesPttBindingStore` (Task 8);
  `AndroidPttDriverFactory` (Task 9).
- Produces: `object RadioController` and `class RadioForegroundService : Service` with
  `ACTION_START` / `ACTION_STOP`. This is the seam P5's Turbo Module calls; Task 11 uses it
  too.

- [ ] **Step 1: Add the notification strings**

Replace `android/app/src/main/res/values/strings.xml` with:

```xml
<resources>
    <string name="app_name">Oru</string>
    <string name="radio_notification_channel_name">Radio</string>
    <string name="radio_notification_title">Oru radio</string>
    <string name="radio_notification_text">Listening for nearby devices</string>
</resources>
```

Create `android/app/src/main/res/values-ru/strings.xml`:

```xml
<resources>
    <string name="radio_notification_channel_name">Рация</string>
    <string name="radio_notification_title">Рация Oru</string>
    <string name="radio_notification_text">Слушаем устройства рядом</string>
</resources>
```

- [ ] **Step 2: Write `RadioController.kt`**

```kotlin
package com.oru.radio

import android.content.Context
import android.content.Intent
import java.util.concurrent.CopyOnWriteArrayList

/**
 * The one process-wide handle on the radio. The React Native Activity may be destroyed and
 * recreated at will (spec section 10.1); the service and the engine outlive it, and
 * whatever wants engine events registers here instead of holding the engine itself.
 */
object RadioController {

    private val listeners = CopyOnWriteArrayList<RadioEngineListener>()

    @Volatile
    private var engine: RadioEngine? = null

    fun engine(): RadioEngine? = engine

    fun start(context: Context) {
        val intent = Intent(context.applicationContext, RadioForegroundService::class.java)
            .setAction(RadioForegroundService.ACTION_START)
        context.applicationContext.startForegroundService(intent)
    }

    fun stop(context: Context) {
        context.applicationContext.stopService(
            Intent(context.applicationContext, RadioForegroundService::class.java),
        )
    }

    fun addListener(listener: RadioEngineListener) {
        listeners.addIfAbsent(listener)
        engine?.addListener(listener)
    }

    fun removeListener(listener: RadioEngineListener) {
        listeners.remove(listener)
        engine?.removeListener(listener)
    }

    internal fun attach(engine: RadioEngine) {
        this.engine = engine
        listeners.forEach(engine::addListener)
    }

    internal fun detach() {
        engine?.let { current -> listeners.forEach(current::removeListener) }
        engine = null
    }
}
```

- [ ] **Step 3: Write `RadioForegroundService.kt`**

```kotlin
package com.oru.radio

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.AudioManager
import android.os.Build
import android.os.IBinder
import android.util.Log
import com.oru.R

/**
 * Spec section 10.1: the radio lives in a foreground service with the microphone and
 * connectedDevice types, so it keeps running while the RN Activity is destroyed and while
 * the screen is locked.
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
    private var engine: RadioEngine? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()

        val scheduler = HandlerScheduler()
        val engine = RadioEngine(
            transport = NearbyManager(this, Build.MODEL ?: "Android", scheduler),
            audio = AudioEngine(),
            ptt = PttManager(
                SharedPreferencesPttBindingStore(this),
                AndroidPttDriverFactory(this),
                scheduler,
            ),
            scheduler = scheduler,
        )
        this.scheduler = scheduler
        this.engine = engine
        RadioController.attach(engine)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopSelf()
            return START_NOT_STICKY
        }
        startForegroundWithTypes()
        setCommunicationMode(true)
        engine?.startRadio()
        Log.i(TAG, "radio service started")
        return START_STICKY
    }

    override fun onDestroy() {
        engine?.stopRadio()
        RadioController.detach()
        setCommunicationMode(false)
        // Shut the thread down from inside itself, so it runs after stopRadio's work.
        scheduler?.let { current -> current.execute { current.shutdown() } }
        engine = null
        scheduler = null
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

    private fun startForegroundWithTypes() {
        val notification = Notification.Builder(this, CHANNEL_ID)
            .setContentTitle(getString(R.string.radio_notification_title))
            .setContentText(getString(R.string.radio_notification_text))
            .setSmallIcon(android.R.drawable.stat_sys_speakerphone)
            .setOngoing(true)
            .build()

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
    }

    /**
     * Communication mode is what makes VOICE_COMMUNICATION capture and
     * USAGE_VOICE_COMMUNICATION playback share one echo-cancelled route, and it is what
     * puts the volume keys on the call stream while the radio is live.
     */
    private fun setCommunicationMode(active: Boolean) {
        val audioManager = getSystemService(AudioManager::class.java) ?: return
        audioManager.mode = if (active) AudioManager.MODE_IN_COMMUNICATION else AudioManager.MODE_NORMAL
    }
}
```

- [ ] **Step 4: Declare the service**

In `android/app/src/main/AndroidManifest.xml`, inside the existing `<application>` element and
after the existing `<activity>` element, add:

```xml
        <service
            android:name="com.oru.radio.RadioForegroundService"
            android:exported="false"
            android:foregroundServiceType="microphone|connectedDevice" />
```

- [ ] **Step 5: Write the failing JavaScript test**

Append to `__tests__/android-radio.test.ts`:

```ts
describe('foreground service (spec sections 10.1, 12.2)', () => {
  it('declares both foreground service types and is not exported', () => {
    const manifest = read('android/app/src/main/AndroidManifest.xml');
    expect(manifest).toMatch(
      /<service[^>]*android:name="com\.oru\.radio\.RadioForegroundService"/s,
    );
    expect(manifest).toMatch(
      /android:foregroundServiceType="microphone\|connectedDevice"/,
    );
    expect(manifest).toMatch(/<service[\s\S]*?android:exported="false"[\s\S]*?\/>/);
  });

  it('localizes every notification string into en and ru', () => {
    const keys = [
      'radio_notification_channel_name',
      'radio_notification_title',
      'radio_notification_text',
    ];
    const en = read('android/app/src/main/res/values/strings.xml');
    const ru = read('android/app/src/main/res/values-ru/strings.xml');

    keys.forEach(key => {
      const pattern = new RegExp(`<string name="${key}">([^<]+)</string>`);
      const enValue = en.match(pattern);
      const ruValue = ru.match(pattern);
      expect(enValue).not.toBeNull();
      expect(ruValue).not.toBeNull();
      expect(ruValue![1]).not.toEqual(enValue![1]);
      expect(ruValue![1]).toMatch(/[Ѐ-ӿ]/);
    });
  });

  it('reads every notification string from resources instead of hard-coding it', () => {
    const service = read(`${RADIO_DIR}/RadioForegroundService.kt`);
    expect(service).toMatch(/getString\(R\.string\.radio_notification_title\)/);
    expect(service).toMatch(/getString\(R\.string\.radio_notification_text\)/);
    expect(service).toMatch(/getString\(R\.string\.radio_notification_channel_name\)/);
  });
});
```

- [ ] **Step 6: Run the JavaScript test**

Run: `pnpm test __tests__/android-radio.test.ts`
Expected: PASS.

- [ ] **Step 7: Run the Kotlin tests and the task gate**

Run: `pnpm build:android :app:testDebugUnitTest`
Expected: PASS — the service and the controller must compile.

Run: `pnpm typecheck && pnpm lint && pnpm test __tests__/android-radio.test.ts && pnpm build:android`
Expected: all four green.

- [ ] **Step 8: Commit**

```bash
git add android/app/src/main android/app/src/test __tests__/android-radio.test.ts
git commit -m "feat(android): run the radio in a localized microphone+connectedDevice foreground service"
```

---

### Task 11: Phase 0 spike hooks and the runbook

Debug-variant-only hooks that drive scenarios A–D over `adb` with no React Native in the
picture. They live in the `debug` source set, so a release build cannot ship them.

**Files:**
- Create: `android/app/src/debug/AndroidManifest.xml`
- Create: `android/app/src/debug/java/com/oru/radio/SpikeActivity.kt`
- Create: `android/app/src/debug/java/com/oru/radio/SpikeReceiver.kt`
- Create: `docs/phase0-android-spike-hooks.md`
- Test: `__tests__/android-radio.test.ts` (append a describe block)

**Interfaces:**
- Consumes: `RadioController`, `RadioForegroundService` (Task 10); `RadioEngine`,
  `RadioEngineListener`, `RadioState.toMap()` (Task 4); `HidKeyEventBus` (Task 9).
- Produces: nothing other plans consume. P3 writes the iOS equivalent in its own files.

- [ ] **Step 1: Write the spike activity**

Create `android/app/src/debug/java/com/oru/radio/SpikeActivity.kt`:

```kotlin
package com.oru.radio

import android.app.Activity
import android.os.Bundle
import android.util.Log
import android.view.KeyEvent

/**
 * Phase 0 (spec section 15) without React Native. This is an Activity rather than a
 * receiver because Android refuses to start a microphone foreground service from the
 * background: launching a visible component is what makes the start legal. It finishes
 * immediately afterwards, and the service keeps running.
 *
 *   adb shell am start -n com.oru/com.oru.radio.SpikeActivity --es cmd start
 *
 * The "keys" command instead keeps the window open and logs every key code it receives,
 * which is how a HID button's key code is discovered.
 */
/**
 * Prints every state change and every error to logcat for the duration of the spike. With
 * the amended contract this is also the pairing UI: scan candidates and the pairing phase
 * arrive as ordinary state changes.
 */
object SpikeLogger : RadioEngineListener {

    override fun onStateChanged(state: RadioState) {
        Log.i("OruRadio", "spike: state=${state.toMap()}")
    }

    override fun onError(code: String, message: String) {
        Log.w("OruRadio", "spike: error $code $message")
    }
}

class SpikeActivity : Activity() {

    private companion object {
        const val TAG = "OruRadio"
    }

    private var capturingKeys = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        when (intent?.getStringExtra("cmd")) {
            "stop" -> {
                RadioController.stop(this)
                Log.i(TAG, "spike: radio stopped")
                finish()
            }
            "keys" -> {
                capturingKeys = true
                Log.i(TAG, "spike: capturing key codes; press the button, then press back")
            }
            else -> {
                RadioController.addListener(SpikeLogger)
                RadioController.start(this)
                Log.i(TAG, "spike: radio starting")
                finish()
            }
        }
    }

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        if (capturingKeys) {
            Log.i(TAG, "spike: keyCode=${event.keyCode} action=${event.action}")
        }
        return if (HidKeyEventBus.dispatch(event.keyCode, event.action)) {
            true
        } else {
            super.dispatchKeyEvent(event)
        }
    }
}
```

- [ ] **Step 2: Write the spike receiver**

Create `android/app/src/debug/java/com/oru/radio/SpikeReceiver.kt`:

```kotlin
package com.oru.radio

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

/**
 * The rest of the Phase 0 controls. Safe to send while the screen is locked, because by
 * then the foreground service is already running:
 *
 *   adb shell am broadcast -n com.oru/com.oru.radio.SpikeReceiver --es cmd ptt-down
 */
class SpikeReceiver : BroadcastReceiver() {

    private companion object {
        const val TAG = "OruRadio"
    }

    override fun onReceive(context: Context, intent: Intent) {
        val engine = RadioController.engine()
        if (engine == null) {
            Log.w(TAG, "spike: the radio is not running - start it with SpikeActivity first")
            return
        }

        when (val command = intent.getStringExtra("cmd")) {
            "ptt-down" -> engine.startTransmit()
            "ptt-up" -> engine.stopTransmit()
            "state" -> Log.i(TAG, "spike: state=${engine.getState().toMap()}")
            "stop" -> RadioController.stop(context)
            // Pairing progress and the candidate list are part of the state now (contract
            // amendment of 2026-08-14), so SpikeLogger prints them without any callback
            // of its own; `state` dumps the same snapshot on demand.
            "ptt-scan" -> engine.startPttPairing()
            "ptt-pick" -> intent.getStringExtra("device")?.let { engine.selectPttCandidate(it) }
                ?: Log.w(TAG, "spike: ptt-pick needs --es device <address>")
            "ptt-cancel" -> engine.cancelPttPairing()
            "ptt-forget" -> engine.forgetPtt()
            else -> Log.w(TAG, "spike: unknown command $command")
        }
    }
}
```

- [ ] **Step 3: Declare the hooks in the debug manifest**

Create `android/app/src/debug/AndroidManifest.xml`:

```xml
<manifest xmlns:android="http://schemas.android.com/apk/res/android">

    <!--
      Phase 0 spike hooks (spec section 15). Exported because `adb shell am` cannot reach
      a component that is not, and confined to the debug source set so a release build
      never contains them.
    -->
    <application>
        <activity
            android:name="com.oru.radio.SpikeActivity"
            android:excludeFromRecents="true"
            android:exported="true" />

        <receiver
            android:name="com.oru.radio.SpikeReceiver"
            android:exported="true" />
    </application>

</manifest>
```

- [ ] **Step 4: Write the runbook**

Create `docs/phase0-android-spike-hooks.md` with exactly this content (the outer fence below
is four backticks; the file itself starts at the `#` heading):

````markdown
# Phase 0 — driving the Android radio without React Native

The debug build carries two hooks (`android/app/src/debug/`) that run the whole engine over
`adb`. They exist for spec §15 Phase 0 scenarios A–D and disappear from release builds.

Install first: `pnpm build:android && adb install -r android/app/build/outputs/apk/debug/app-debug.apk`

## 1. Grant the permissions (once per install)

Nothing in the spike asks for permissions — the app's permission onboarding is P7's work, so
grant them by hand:

```bash
adb shell pm grant com.oru android.permission.RECORD_AUDIO
adb shell pm grant com.oru android.permission.BLUETOOTH_SCAN
adb shell pm grant com.oru android.permission.BLUETOOTH_CONNECT
adb shell pm grant com.oru android.permission.BLUETOOTH_ADVERTISE
adb shell pm grant com.oru android.permission.POST_NOTIFICATIONS
# Android 13+:
adb shell pm grant com.oru android.permission.NEARBY_WIFI_DEVICES
# Android 12 and below, instead of NEARBY_WIFI_DEVICES:
adb shell pm grant com.oru android.permission.ACCESS_FINE_LOCATION
```

Turn Wi-Fi and Bluetooth on and the internet off (aeroplane mode with Wi-Fi and Bluetooth
re-enabled is the honest test of "the internet is completely absent").

## 2. Start and stop the radio

The radio must be started with the screen on: Android forbids starting a microphone
foreground service from the background.

```bash
adb shell am start -n com.oru/com.oru.radio.SpikeActivity --es cmd start
adb shell am start -n com.oru/com.oru.radio.SpikeActivity --es cmd stop
```

Watch everything with: `adb logcat -s OruRadio`

## 3. Drive it while it runs (screen may be locked)

```bash
adb shell am broadcast -n com.oru/com.oru.radio.SpikeReceiver --es cmd ptt-down
adb shell am broadcast -n com.oru/com.oru.radio.SpikeReceiver --es cmd ptt-up
adb shell am broadcast -n com.oru/com.oru.radio.SpikeReceiver --es cmd state
adb shell am broadcast -n com.oru/com.oru.radio.SpikeReceiver --es cmd stop
```

`state` logs the exact `RadioState` the bridge will later return.

## 4. Pair a Bluetooth PTT button

Pairing is one session with three phases, and all of its progress arrives inside the ordinary
state snapshot as `pttPairing={phase=..., candidates=[...]}` — the same field the RN pairing
screen will render. Watch logcat while you run these:

```bash
adb shell am broadcast -n com.oru/com.oru.radio.SpikeReceiver --es cmd ptt-scan
# phase=scanning; candidates fill in, strongest signal first. Read an address, then:
adb shell am broadcast -n com.oru/com.oru.radio.SpikeReceiver --es cmd ptt-pick --es device AA:BB:CC:DD:EE:FF
# phase=learning. Press and release the physical button once -> phase=saved.
adb shell am broadcast -n com.oru/com.oru.radio.SpikeReceiver --es cmd ptt-cancel
adb shell am broadcast -n com.oru/com.oru.radio.SpikeReceiver --es cmd ptt-forget
```

`ptt-cancel` closes the session (that is what dismisses the "saved" screen in the real UI, and
it is also how you abandon a scan). A session nobody finishes gives up after 60 seconds and
logs `error pairing_timeout` — the radio itself stays `ready` throughout.

If the button turns out to be HID rather than GATT, find its key code with:

```bash
adb shell am start -n com.oru/com.oru.radio.SpikeActivity --es cmd keys
# press the button; logcat prints "spike: keyCode=... action=..."
```

## 5. The four Phase 0 scenarios

| Scenario | How to run it here |
|---|---|
| A — Android PTT → locked iPhone plays audio | start both radios, lock the iPhone, `ptt-down`, speak, `ptt-up` |
| B — iPhone BLE PTT → locked Android plays audio | start both, lock the Android, press the iPhone's button; the Android must play without any command from here |
| C — locked iPhone BLE PTT → Android receives | the mirror of B, driven from iOS; here you only confirm reception |
| D — out of range and back | `state` shows `nearbyCount` 1, walk out of range until it reads 0, return, and `state` must return to 1 with no restart |

Record the outcome and an explicit **Go** or **No-Go** in
`docs/superpowers/specs/2026-08-13-phase0-spike-report.md`.
````

- [ ] **Step 5: Write the failing JavaScript test**

Append to `__tests__/android-radio.test.ts`:

```ts
describe('phase 0 spike hooks (spec section 15)', () => {
  it('keeps the hooks in the debug source set only', () => {
    expect(
      existsSync(join(REPO_ROOT, 'android/app/src/debug/java/com/oru/radio/SpikeActivity.kt')),
    ).toBe(true);
    expect(
      existsSync(join(REPO_ROOT, 'android/app/src/debug/java/com/oru/radio/SpikeReceiver.kt')),
    ).toBe(true);
    expect(existsSync(join(REPO_ROOT, `${RADIO_DIR}/SpikeActivity.kt`))).toBe(false);
    expect(read('android/app/src/main/AndroidManifest.xml')).not.toMatch(/Spike/);
  });

  it('declares them as exported debug components', () => {
    const manifest = read('android/app/src/debug/AndroidManifest.xml');
    expect(manifest).toMatch(/android:name="com\.oru\.radio\.SpikeActivity"/);
    expect(manifest).toMatch(/android:name="com\.oru\.radio\.SpikeReceiver"/);
  });

  it('documents every command the operator needs for scenarios A to D', () => {
    const runbook = read('docs/phase0-android-spike-hooks.md');
    [
      'start',
      'ptt-down',
      'ptt-up',
      'state',
      'ptt-scan',
      'ptt-pick',
      'ptt-cancel',
      'ptt-forget',
    ].forEach(command => expect(runbook).toContain(command));
    expect(runbook).toMatch(/pm grant com\.oru android\.permission\.RECORD_AUDIO/);
  });
});
```

- [ ] **Step 6: Run the JavaScript test**

Run: `pnpm test __tests__/android-radio.test.ts`
Expected: PASS.

- [ ] **Step 7: Run the Kotlin tests and the task gate**

Run: `pnpm build:android :app:testDebugUnitTest`
Expected: PASS.

Run: `pnpm typecheck && pnpm lint && pnpm test && pnpm build:android`
Expected: all four green — this is the full merge gate, run here because this is the last
task of the plan.

- [ ] **Step 8: Verify the debug hooks are actually in the APK**

Run:

```bash
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
adb shell am start -n com.oru/com.oru.radio.SpikeActivity --es cmd start
adb logcat -d -s OruRadio | tail -20
```

Expected: `radio service started` in logcat and a persistent notification on the device. If no
device is attached, skip this step and say so in the task report — it is manual acceptance,
not a gate.

- [ ] **Step 9: Commit**

```bash
git add android/app/src/debug docs/phase0-android-spike-hooks.md __tests__/android-radio.test.ts
git commit -m "feat(android): add debug-only Phase 0 spike hooks and their runbook"
```

---

## Manual acceptance for this plan (spec §15 Stage 1 and Phase 0)

Automated gates cannot see a radio. Stage 1's acceptance is "two devices exchange voice driven
by native test hooks", and it is executed by the operator, on hardware, at the sync-2 pause —
not by the executor. `docs/phase0-android-spike-hooks.md` is the checklist; the outcome and the
Go/No-Go decision go into `docs/superpowers/specs/2026-08-13-phase0-spike-report.md`.

What a green merge gate *does* prove for this plan: every pure unit of the engine behaves
(over 80 JVM unit tests, including the amended pairing contract end to end from
`startPairing()` to the `pttPairing` snapshot), the whole Kotlin engine compiles against the
real SDK, libopus builds
from source for the target ABI and is packaged into the APK, the manifest and resources carry
what the spec requires, and no engine file imports React Native.



