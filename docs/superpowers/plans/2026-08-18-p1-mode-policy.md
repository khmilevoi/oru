# Mode policy (§7) — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement §7's shared VOICE/MEDIA mode policy as pure, I/O-free logic, twice — once in Swift and once in Kotlin, with identical constants and a transition table both platforms assert line for line.

**Architecture:** One class per platform (`ModePolicy`) holding only its own state. It takes events plus a caller-supplied monotonic timestamp (`nowMs`) on every call and returns a `Decision`: the profile the platform should have applied, the actions it should perform (raise/drop the voice link, play the grant tone, start capture), and the absolute millisecond at which the platform must call `tick`. It owns no timers, no threads and no audio API: everything §7 calls a "timer" is a deadline the caller is told about and calls back at. The tests are a data-driven transition table — a named row is a list of `(atMs, input, expected profile, expected actions, expected wakeup)` steps — and the two files carry the same row names in the same order, which a `diff` in every task's verification enforces.

**Tech Stack:** Swift 5.9 / iOS 16 (SwiftPM package `ios/Radio`, XCTest); Kotlin 2.2.0 / Android (Gradle JVM unit tests, JUnit 4.13.2). No new dependencies, no build-file changes: SwiftPM compiles every file under `Sources/RadioKit`, Gradle every file under `src/main/java` and `src/test/java`.

**Spec:** `docs/superpowers/specs/2026-08-18-seamless-headphone-audio-design.md` — §3 D1/D2/D4, §7, §10 ("Shared"). Schedule: `docs/superpowers/execution/2026-08-18-seamless-headphone-audio.md`, plan **P1 `mode-policy`**, wave 1 track A.

---

## Global Constraints

Every task's requirements implicitly include this section.

**This plan writes exactly four files, all new. It modifies nothing.**

- `ios/Radio/Sources/RadioKit/ModePolicy.swift`
- `ios/Radio/Tests/RadioKitTests/ModePolicyTests.swift`
- `android/app/src/main/java/com/oru/radio/ModePolicy.kt`
- `android/app/src/test/java/com/oru/radio/ModePolicyTest.kt`

No other file may be touched — not `RadioConfig.swift`/`RadioConfig.kt`, not `Package.swift`, not `build.gradle`, not anything under `src/` or `specs/`. The sync-1 rule in the schedule is "P1 writes only new files under the two native radio source trees"; a modified shared file at that merge is a decomposition violation, and the neighbouring plan P2 is writing `src/`, `specs/` and the bridge glue in parallel. **This is why §7's five constants live inside `ModePolicy`, not in `RadioConfig`** — the house rule "every tunable in one place" is overridden here by the ownership rule, and the two `ModePolicy` files are that one place for these five numbers.

**Task gate** (copied verbatim from the schedule header):

> pnpm typecheck && pnpm lint && pnpm test \<paths\> · when the task touched `android/`, plus `node scripts/build-android.js :app:testDebugUnitTest` and `pnpm build:android` · when the task touched `ios/`, plus `cd ios/Radio && DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild test -scheme RadioKit -destination 'platform=iOS Simulator,name=iPhone 17'`

Every task in this plan touches both `android/` and `ios/`, and none of them touches a JS file, so the gate instantiates to exactly this block for every task. Run it from the repository root:

```bash
pnpm typecheck && pnpm lint && pnpm test
node scripts/build-android.js :app:testDebugUnitTest
pnpm build:android
(cd ios/Radio && DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild test -scheme RadioKit -destination 'platform=iOS Simulator,name=iPhone 17')
```

`pnpm test` runs with no `<paths>` argument because this plan changes no JS: the path subset is empty, and a full jest run is the honest substitute (it is seconds, and it proves the plan broke nothing in JS).

**Known flakes** (copied verbatim from the schedule header): (1) first Gradle / NDK / CMake / dependency downloads are slow and can time out — a download failure or timeout is infrastructure, not a regression; re-run once before reporting. (2) `xcode-select` on this host points at CommandLineTools, so a *bare* `xcodebuild` fails with a tools error — that is environment, not a regression; every xcodebuild carries the `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer` prefix already baked into the gates above. (3) The `Oru` app scheme has no test action ("no test bundles available") — the RadioKit tests run **only** from `ios/Radio`'s own package workspace; the app build and the package tests are two separate commands, never one. (4) The simulator destination `iPhone 17` is the recorded-working one from the 2026-08-13 spike report; if xcodebuild reports the device missing, substitute any available iPhone simulator — device-list drift, not a regression. (5) The first xcodebuild in a fresh worktree resolves SPM packages (google/nearby, alta/swift-opus) — a slow first run or a transient network failure there is infrastructure; re-run once. (6) `pnpm lingui:extract` rewrites two stale source-line references in the `*.po` catalogs — harmless churn; commit it with whatever catalog change triggered it.

**The mirror check.** §10 "Shared" requires both platforms to assert the same table. Every task's verification runs this from the repository root and expects **no output**:

```bash
diff <(grep -o 'assertRow("[^"]*"' ios/Radio/Tests/RadioKitTests/ModePolicyTests.swift) \
     <(grep -o 'assertRow("[^"]*"' android/app/src/test/java/com/oru/radio/ModePolicyTest.kt)
```

Row names contain no `:` so that each Kotlin test method can be named with the row string verbatim in backticks (JVM method names cannot contain `.;[]/<>:\`), which makes the Kotlin method names part of the same mirror.

**No I/O, ever.** `ModePolicy` imports `Foundation` (Swift) and nothing (Kotlin). It must not reference `AVAudioSession`, `AVAudioEngine`, `AudioManager`, `android.*`, `Date()`, `System.currentTimeMillis()`, `SystemClock`, `DispatchQueue`, threads, or logging. Time enters only as the `nowMs` parameter. Wiring the inputs and executing the outputs is P3 (iOS) and P4 (Android); this plan produces the logic they call.

**Constants (§7), identical on both platforms:**

| Meaning | Swift | Kotlin | Value |
|---|---|---|---|
| VOICE → MEDIA dwell | `otherAudioToMediaMs` | `OTHER_AUDIO_TO_MEDIA_MS` | 2 000 |
| MEDIA → VOICE dwell | `otherAudioToVoiceMs` | `OTHER_AUDIO_TO_VOICE_MS` | 30 000 |
| Global switch rate limit | `switchRateLimitMs` | `SWITCH_RATE_LIMIT_MS` | 10 000 |
| PTT grant timeout | `voiceLinkGrantTimeoutMs` | `VOICE_LINK_GRANT_TIMEOUT_MS` | 4 000 |
| Post-release linger | `voiceLinkLingerMs` | `VOICE_LINK_LINGER_MS` | 15 000 |

**Time unit:** absolute monotonic **milliseconds** as `Int64` (Swift) / `Long` (Kotlin). Not `Date`/wall clock: a system clock change must not move a dwell deadline. P3/P4 supply it (`DispatchTime.now().uptimeNanoseconds / 1_000_000`, `SystemClock.elapsedRealtime()`); this plan never reads a clock.

**Not in this plan** (schedule "Not here"): wiring the inputs — other-audio detectors, route events, PTT hardware — and executing the outputs — session-config apply, SCO raise, tone playback — belong to P3 (iOS) and P4 (Android); the `audioMode` setting's contract surface belongs to P2 and its persistence to P3/P4. This plan defines the `AudioMode` vocabulary the policy consumes and nothing about how the setting is stored or displayed.

**Downstream rule:** after this branch merges, P3 and P4 *read* these four files and never edit them. A needed table change discovered in wave 2 is reported, not patched — a local patch silently forks the contract. Sync 2 cross-checks that neither wave-2 branch touched them.

**Readings of §7 this plan fixes** (each is a place the spec states a rule but not its mechanics; the reading and its textual basis are recorded here and repeated in the code comment that implements it, so a reviewer can overrule one without archaeology):

1. **The dwell latches a desired profile; the gates only delay applying it.** §7 says "other audio detected for ≥ 2 s → switch at the next radio-idle moment", i.e. the dwell arms the switch and the idle moment performs it. So the 2 s / 30 s conditions move an internal `desiredAutoProfile`, and the radio-idle and rate-limit gates decide when the applied profile catches up.
2. **The dwell keeps running on routes with no voice link.** §7's "the policy is inert there" suppresses the *switch* on such routes (the policy holds VOICE, which costs nothing when there is no A2DP/HFP conflict), but the other-audio timer keeps running, so a headset connecting into already-playing music switches at once instead of waiting another 2 s.
3. **The raise/drop is exempt from the 10 s rate limit but not from the radio-idle rule.** §7 exempts it from "the 10 s rate limit" by name; the idle rule is a separate clause of the same bullet ("switches never run during receive or transmit"). The raise happens at PTT press, before capture starts, so the radio is idle anyway; an expired linger therefore holds the link until the radio goes idle instead of dropping it mid-receive. The raise/drop also never *stamps* the rate limit — being exempt from a budget means neither paying it nor charging it.
4. **A raise that times out or fails is abandoned for this transmission.** §7 says "Timeout 4 s → grant tone + phone-mic fallback for this transmission" and D2 says "on SCO failure, grant-tone and fall back to the phone mic". The pending raise is therefore undone (`dropVoiceLink`) *before* the tone and capture, so capture starts with the base profile already restored — no mid-transmission mic hot-swap, which D2 rejects by name — and there is no linger, because no link was ever raised.
5. **Releasing PTT before the link comes up cancels it silently.** The tone means "you may talk"; the user already let go. The raise is undone, no tone, no capture.
6. **A pin change goes through the same idle and rate gates as a policy switch.** §7 attaches those gates to VOICE↔MEDIA switches, not to their cause; applying a pin mid-transmission would break the same audio a policy switch would.

---

## File structure

| File | Responsibility |
|---|---|
| `ios/Radio/Sources/RadioKit/ModePolicy.swift` | The whole policy: vocabulary (`Profile`, `AudioMode`, `MicSource`, `Action`, `Decision`), `Constants`, the state, the nine input methods, the private core (`step`, dwell, gates, PTT sub-machine, wakeup). ~230 lines. |
| `ios/Radio/Tests/RadioKitTests/ModePolicyTests.swift` | The transition table: the `Input`/`Wakeup`/`Step` harness, `assertRow`, one test method per row, plus a constants test. ~420 lines. |
| `android/app/src/main/java/com/oru/radio/ModePolicy.kt` | Line-for-line Kotlin twin of `ModePolicy.swift`. |
| `android/app/src/test/java/com/oru/radio/ModePolicyTest.kt` | Line-for-line Kotlin twin of `ModePolicyTests.swift`. |

All four files stay whole: the policy is one state machine and splitting it would put its transitions in two places, which is exactly the failure §10 "Shared" exists to prevent.

## The interface P3 and P4 consume

This is the public surface after Task 5. Wave 2 wires it; nothing else about it is negotiable at that point.

```swift
// Swift — RadioKit
public final class ModePolicy {
    public enum Profile: Equatable { case voice, media }
    public enum AudioMode: Equatable { case auto, voice, media }
    public enum MicSource: Equatable { case routeDefault, phoneFallback }
    public enum Action: Equatable {
        case raiseVoiceLink
        case dropVoiceLink
        case playGrantTone
        case startCapture(MicSource)
    }
    public struct Decision: Equatable {
        public let profile: Profile
        public let actions: [Action]
        public let nextWakeupMs: Int64?
    }
    public enum Constants { /* the five §7 values */ }

    public init()
    public func setAudioMode(_ mode: AudioMode, nowMs: Int64) -> Decision
    public func setOtherAudioActive(_ active: Bool, nowMs: Int64) -> Decision
    public func setRadioActive(_ active: Bool, nowMs: Int64) -> Decision
    public func setRouteRequiresVoiceLink(_ requires: Bool, nowMs: Int64) -> Decision
    public func pttPressed(nowMs: Int64) -> Decision
    public func pttReleased(nowMs: Int64) -> Decision
    public func voiceLinkEstablished(nowMs: Int64) -> Decision
    public func voiceLinkFailed(nowMs: Int64) -> Decision
    public func tick(nowMs: Int64) -> Decision
}
```

```kotlin
// Kotlin — com.oru.radio
class ModePolicy {
    enum class Profile { VOICE, MEDIA }
    enum class AudioMode { AUTO, VOICE, MEDIA }
    enum class MicSource { ROUTE_DEFAULT, PHONE_FALLBACK }
    sealed interface Action {
        data object RaiseVoiceLink : Action
        data object DropVoiceLink : Action
        data object PlayGrantTone : Action
        data class StartCapture(val mic: MicSource) : Action
    }
    data class Decision(val profile: Profile, val actions: List<Action>, val nextWakeupMs: Long?)
    object Constants { /* the five §7 values */ }

    fun setAudioMode(mode: AudioMode, nowMs: Long): Decision
    fun setOtherAudioActive(active: Boolean, nowMs: Long): Decision
    fun setRadioActive(active: Boolean, nowMs: Long): Decision
    fun setRouteRequiresVoiceLink(requires: Boolean, nowMs: Long): Decision
    fun pttPressed(nowMs: Long): Decision
    fun pttReleased(nowMs: Long): Decision
    fun voiceLinkEstablished(nowMs: Long): Decision
    fun voiceLinkFailed(nowMs: Long): Decision
    fun tick(nowMs: Long): Decision
}
```

Meaning of each input, for the platforms that will feed them:

- `setOtherAudioActive` — another app is playing audio (iOS `isOtherAudioPlaying` / the silence-hint edge; Android `registerAudioPlaybackCallback` / `isMusicActive`). Raw, not debounced: the 2 s / 30 s dwell lives in the policy.
- `setRadioActive` — the radio is receiving or transmitting. Fed by the engine, not derived from PTT (a transmission also ends on the 120 s safety cap).
- `setRouteRequiresVoiceLink` — reaching the accessory's microphone would need a BT-Classic voice link raised (iOS: current output is an A2DP headset; Android: the selected device is an SCO/BLE headset). `false` for speaker, wired, USB and any route with no profile conflict.
- `pttPressed` / `pttReleased` — the button, hardware or UI.
- `voiceLinkEstablished` / `voiceLinkFailed` — the answer to a `raiseVoiceLink` action (SCO connected / comm device applied, versus `setCommunicationDevice` returning false or `SCO_AUDIO_STATE_ERROR`). If neither arrives, the policy times out on its own after 4 s.
- `tick` — called when the previous `Decision.nextWakeupMs` says to. `nextWakeupMs` is absolute; re-read it after **every** call and reschedule. `nil` means no timer is pending.

`Decision.profile` is the profile the platform should have applied, diff-only: re-applying an unchanged profile is the platform's job to skip. `Decision.actions` are performed in order.

---

## Task 1: Vocabulary, constants, the `audioMode` pin

**Files:**
- Create: `ios/Radio/Sources/RadioKit/ModePolicy.swift`
- Create: `ios/Radio/Tests/RadioKitTests/ModePolicyTests.swift`
- Create: `android/app/src/main/java/com/oru/radio/ModePolicy.kt`
- Create: `android/app/src/test/java/com/oru/radio/ModePolicyTest.kt`

**Interfaces:**
- Consumes: nothing.
- Produces: the whole public surface listed above (`ModePolicy.Profile`, `.AudioMode`, `.MicSource`, `.Action`, `.Decision`, `.Constants`, the nine input methods) and, in the test files, the table harness `Input` / `Wakeup` / `Step` / `assertRow(_:_:)` that Tasks 2–6 add rows to. In this task the PTT methods and `tick` are inert (`[]` / `emptyList()`), `nextWakeupMs` is always `nil`, and only the `audioMode` pin can move the profile.

- [ ] **Step 1: Write the failing Swift test**

Create `ios/Radio/Tests/RadioKitTests/ModePolicyTests.swift`:

```swift
import XCTest
@testable import RadioKit

/// §7 of docs/superpowers/specs/2026-08-18-seamless-headphone-audio-design.md,
/// as a transition table.
///
/// §10 "Shared": `android/app/src/test/java/com/oru/radio/ModePolicyTest.kt` asserts
/// the same rows, with the same names, in the same order. The two files are kept
/// honest mechanically — from the repository root:
///
///     diff <(grep -o 'assertRow("[^"]*"' ios/Radio/Tests/RadioKitTests/ModePolicyTests.swift) \
///          <(grep -o 'assertRow("[^"]*"' android/app/src/test/java/com/oru/radio/ModePolicyTest.kt)
///
/// must print nothing. A row added on one side only is a forked contract, not a test.
final class ModePolicyTests: XCTestCase {

    // MARK: - Table harness

    /// One input to the policy. Mirrors `Input` in ModePolicyTest.kt.
    private enum Input {
        case otherAudio(Bool)
        case radioActive(Bool)
        case routeRequiresVoiceLink(Bool)
        case audioMode(ModePolicy.AudioMode)
        case pttPressed
        case pttReleased
        case voiceLinkEstablished
        case voiceLinkFailed
        case tick
    }

    /// What a step expects of `Decision.nextWakeupMs`. `unchecked` is for steps whose
    /// pending timers a later task changes; `noTimer` asserts nil.
    private enum Wakeup {
        case unchecked
        case noTimer
        case at(Int64)
    }

    private struct Step {
        let atMs: Int64
        let input: Input
        let profile: ModePolicy.Profile
        let actions: [ModePolicy.Action]
        let wakeup: Wakeup

        init(
            _ atMs: Int64,
            _ input: Input,
            _ profile: ModePolicy.Profile,
            _ actions: [ModePolicy.Action] = [],
            _ wakeup: Wakeup = .unchecked
        ) {
            self.atMs = atMs
            self.input = input
            self.profile = profile
            self.actions = actions
            self.wakeup = wakeup
        }
    }

    /// Runs one table row against a fresh policy.
    private func assertRow(
        _ name: String,
        _ steps: [Step],
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        let policy = ModePolicy()
        for (index, step) in steps.enumerated() {
            let decision = feed(policy, step)
            XCTAssertEqual(
                decision.profile, step.profile,
                "\(name) step \(index) profile", file: file, line: line
            )
            XCTAssertEqual(
                decision.actions, step.actions,
                "\(name) step \(index) actions", file: file, line: line
            )
            switch step.wakeup {
            case .unchecked:
                break
            case .noTimer:
                XCTAssertNil(
                    decision.nextWakeupMs,
                    "\(name) step \(index) wakeup", file: file, line: line
                )
            case .at(let ms):
                let expected: Int64? = ms
                XCTAssertEqual(
                    decision.nextWakeupMs, expected,
                    "\(name) step \(index) wakeup", file: file, line: line
                )
            }
        }
    }

    private func feed(_ policy: ModePolicy, _ step: Step) -> ModePolicy.Decision {
        switch step.input {
        case .otherAudio(let active):
            return policy.setOtherAudioActive(active, nowMs: step.atMs)
        case .radioActive(let active):
            return policy.setRadioActive(active, nowMs: step.atMs)
        case .routeRequiresVoiceLink(let requires):
            return policy.setRouteRequiresVoiceLink(requires, nowMs: step.atMs)
        case .audioMode(let mode):
            return policy.setAudioMode(mode, nowMs: step.atMs)
        case .pttPressed:
            return policy.pttPressed(nowMs: step.atMs)
        case .pttReleased:
            return policy.pttReleased(nowMs: step.atMs)
        case .voiceLinkEstablished:
            return policy.voiceLinkEstablished(nowMs: step.atMs)
        case .voiceLinkFailed:
            return policy.voiceLinkFailed(nowMs: step.atMs)
        case .tick:
            return policy.tick(nowMs: step.atMs)
        }
    }

    // MARK: - Constants

    func testConstantsAreTheSpecValues() {
        XCTAssertEqual(ModePolicy.Constants.otherAudioToMediaMs, 2_000)
        XCTAssertEqual(ModePolicy.Constants.otherAudioToVoiceMs, 30_000)
        XCTAssertEqual(ModePolicy.Constants.switchRateLimitMs, 10_000)
        XCTAssertEqual(ModePolicy.Constants.voiceLinkGrantTimeoutMs, 4_000)
        XCTAssertEqual(ModePolicy.Constants.voiceLinkLingerMs, 15_000)
    }

    // MARK: - Defaults and the audioMode pin

    func testFreshPolicyRequestsVoice() {
        assertRow("a fresh policy with no other audio and no external route requests VOICE", [
            Step(0, .tick, .voice, [], .noTimer),
        ])
    }

    func testAudioModeMediaPinsMedia() {
        assertRow("audioMode media pins MEDIA", [
            Step(0, .audioMode(.media), .media, [], .noTimer),
            Step(1_000, .tick, .media, [], .noTimer),
        ])
    }

    func testAudioModeVoicePinsVoice() {
        assertRow("audioMode voice pins VOICE while other audio plays", [
            Step(0, .routeRequiresVoiceLink(true), .voice),
            Step(0, .audioMode(.voice), .voice),
            Step(0, .otherAudio(true), .voice),
            Step(10_000, .tick, .voice, [], .noTimer),
        ])
    }

    func testClearingThePinHandsTheProfileBack() {
        // The second switch is at 10 000 ms, not 1 000: from Task 3 on, the 10 s rate
        // limit would otherwise defer it, and this row is about the pin, not the limit.
        assertRow("clearing the pin hands the profile back to the policy", [
            Step(0, .audioMode(.media), .media, [], .noTimer),
            Step(10_000, .audioMode(.auto), .voice, [], .noTimer),
        ])
    }
}
```

- [ ] **Step 2: Run the Swift test to verify it fails**

Run: `(cd ios/Radio && DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild test -scheme RadioKit -destination 'platform=iOS Simulator,name=iPhone 17' -only-testing:RadioKitTests/ModePolicyTests)`

Expected: FAIL — compile error, "cannot find 'ModePolicy' in scope".

- [ ] **Step 3: Write the Swift implementation**

Create `ios/Radio/Sources/RadioKit/ModePolicy.swift`:

```swift
import Foundation

/// §7 of docs/superpowers/specs/2026-08-18-seamless-headphone-audio-design.md: the
/// shared VOICE/MEDIA mode policy.
///
/// Pure and I/O-free. It takes events plus a caller-supplied monotonic timestamp and
/// returns the profile the platform should have applied, the actions it should perform
/// and the moment it must call `tick` again. It owns no timer, no queue and no audio
/// object: applying a profile, raising SCO, playing the tone and starting capture are
/// the platform's jobs (§5 iOS, §6 Android).
///
/// `android/app/src/main/java/com/oru/radio/ModePolicy.kt` is the line-for-line Kotlin
/// twin of this file, and both test files assert the same table (§10 "Shared"). A change
/// here without the same change there forks the contract; wave-2 platform work reports a
/// needed change instead of patching one side.
///
/// Time is absolute monotonic milliseconds, never a wall clock: a system time change
/// must not move a dwell deadline.
public final class ModePolicy {

    // MARK: - Vocabulary

    /// The profile the platform should have applied. §5 and §6 define what applying it
    /// means on each platform.
    public enum Profile: Equatable {
        case voice
        case media
    }

    /// The §8 `audioMode` setting. `auto` runs this policy; the other two pin it.
    public enum AudioMode: Equatable {
        case auto
        case voice
        case media
    }

    /// Which microphone capture should use for this transmission.
    public enum MicSource: Equatable {
        /// The microphone that belongs to the current route (the headset's, over a
        /// raised voice link).
        case routeDefault
        /// §7's fallback after a raise that timed out or failed: the phone's own mic.
        case phoneFallback
    }

    public enum Action: Equatable {
        /// Bring the headset voice link up now — Android `setCommunicationDevice`/SCO,
        /// iOS the VOICE session configuration — and answer with `voiceLinkEstablished`
        /// or `voiceLinkFailed`. Exempt from the 10 s rate limit (§7).
        case raiseVoiceLink
        /// Undo a raise: clear the communication device / re-apply the MEDIA
        /// configuration, so the headset returns to A2DP and music resumes.
        case dropVoiceLink
        /// The talk-permit tone (D2). Always immediately followed by `startCapture`:
        /// press → tone → talk, in every mode.
        case playGrantTone
        case startCapture(MicSource)
    }

    public struct Decision: Equatable {
        /// The profile the platform should have applied after this event. Diff-only:
        /// the platform skips re-applying an unchanged profile.
        public let profile: Profile
        /// Side effects to perform, in order.
        public let actions: [Action]
        /// Absolute monotonic millisecond at which the platform must call `tick`, or
        /// nil when nothing is pending. Re-read after every call.
        public let nextWakeupMs: Int64?
    }

    /// §7's five constants. `ModePolicy.kt` carries the same five values.
    ///
    /// They live here rather than in `RadioConfig` because these two files are the one
    /// place the two platforms are guaranteed to agree; a value duplicated into two
    /// per-platform config files is a value that can drift.
    public enum Constants {
        /// VOICE → MEDIA once other audio has been playing this long.
        public static let otherAudioToMediaMs: Int64 = 2_000
        /// MEDIA → VOICE once other audio has been silent this long. Asymmetric on
        /// purpose: protect the user's music fast, never flap between tracks.
        public static let otherAudioToVoiceMs: Int64 = 30_000
        /// At most one policy-driven VOICE↔MEDIA switch per this window.
        public static let switchRateLimitMs: Int64 = 10_000
        /// How long a PTT-driven raise waits for the headset mic path before falling
        /// back to the phone mic for this transmission.
        public static let voiceLinkGrantTimeoutMs: Int64 = 4_000
        /// How long a raised link is held after PTT release, so the rest of the
        /// conversation is instant.
        public static let voiceLinkLingerMs: Int64 = 15_000
    }

    // MARK: - State

    private var audioMode: AudioMode = .auto
    private var routeRequiresVoiceLink = false
    private var radioActive = false
    private var otherAudioActive = false
    /// When the current value of `otherAudioActive` began. nil until the first change.
    private var otherAudioSinceMs: Int64?
    /// What the automatic policy wants. The other-audio dwell moves it; the pins ignore it.
    private var desiredAutoProfile: Profile = .voice
    /// What the platform has been told to apply.
    private var appliedProfile: Profile = .voice

    public init() {}

    // MARK: - Inputs

    public func setAudioMode(_ mode: AudioMode, nowMs: Int64) -> Decision {
        step(nowMs) {
            self.audioMode = mode
            return []
        }
    }

    /// Raw, undebounced: the 2 s / 30 s dwell of §7 lives in this class, not in the
    /// detector, so both platforms debounce identically.
    public func setOtherAudioActive(_ active: Bool, nowMs: Int64) -> Decision {
        step(nowMs) {
            guard active != self.otherAudioActive else { return [] }
            self.otherAudioActive = active
            self.otherAudioSinceMs = nowMs
            return []
        }
    }

    /// The radio is receiving or transmitting. Fed by the engine, not derived from the
    /// button: a transmission also ends on the 120 s safety cap.
    public func setRadioActive(_ active: Bool, nowMs: Int64) -> Decision {
        step(nowMs) {
            self.radioActive = active
            return []
        }
    }

    /// True when reaching the accessory's microphone would need a BT-Classic voice link
    /// raised. False for speaker, wired, USB and anything else with no profile conflict
    /// — §7's "the policy is inert there".
    public func setRouteRequiresVoiceLink(_ requires: Bool, nowMs: Int64) -> Decision {
        step(nowMs) {
            self.routeRequiresVoiceLink = requires
            return []
        }
    }

    public func pttPressed(nowMs: Int64) -> Decision {
        step(nowMs) { [] }
    }

    public func pttReleased(nowMs: Int64) -> Decision {
        step(nowMs) { [] }
    }

    public func voiceLinkEstablished(nowMs: Int64) -> Decision {
        step(nowMs) { [] }
    }

    public func voiceLinkFailed(nowMs: Int64) -> Decision {
        step(nowMs) { [] }
    }

    /// Called when the previous decision's `nextWakeupMs` says to.
    public func tick(nowMs: Int64) -> Decision {
        step(nowMs) { [] }
    }

    // MARK: - Core

    /// Every input runs the same pipeline: age the timers that do not produce actions,
    /// apply the input, then let the profile catch up with what the policy wants.
    private func step(_ nowMs: Int64, _ input: () -> [Action]) -> Decision {
        let actions = input()
        applyBaseIfAllowed(nowMs)
        return Decision(
            profile: requestedProfile,
            actions: actions,
            nextWakeupMs: nextWakeupMs(nowMs)
        )
    }

    /// The profile the policy wants, before any gate: a pin wins outright, and `auto`
    /// holds VOICE on routes with no profile conflict.
    private var baseProfile: Profile {
        switch audioMode {
        case .voice:
            return .voice
        case .media:
            return .media
        case .auto:
            return routeRequiresVoiceLink ? desiredAutoProfile : .voice
        }
    }

    private var requestedProfile: Profile {
        appliedProfile
    }

    private func applyBaseIfAllowed(_ nowMs: Int64) {
        let base = baseProfile
        guard base != appliedProfile else { return }
        appliedProfile = base
    }

    private func nextWakeupMs(_ nowMs: Int64) -> Int64? {
        nil
    }
}
```

- [ ] **Step 4: Run the Swift test to verify it passes**

Run: `(cd ios/Radio && DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild test -scheme RadioKit -destination 'platform=iOS Simulator,name=iPhone 17' -only-testing:RadioKitTests/ModePolicyTests)`

Expected: PASS, 5 tests.

- [ ] **Step 5: Write the mirrored failing Kotlin test**

Create `android/app/src/test/java/com/oru/radio/ModePolicyTest.kt`:

```kotlin
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
```

Note the one deliberate name asymmetry: the Kotlin input is `Input.SetAudioMode` because `AudioMode` is already imported as a type. The `assertRow` strings, which are what the mirror check compares, are identical.

- [ ] **Step 6: Run the Kotlin test to verify it fails**

Run: `node scripts/build-android.js :app:testDebugUnitTest`

Expected: FAIL — compile error, "Unresolved reference: ModePolicy".

- [ ] **Step 7: Write the Kotlin implementation**

Create `android/app/src/main/java/com/oru/radio/ModePolicy.kt`:

```kotlin
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

    fun pttPressed(nowMs: Long): Decision = step(nowMs) { emptyList() }

    fun pttReleased(nowMs: Long): Decision = step(nowMs) { emptyList() }

    fun voiceLinkEstablished(nowMs: Long): Decision = step(nowMs) { emptyList() }

    fun voiceLinkFailed(nowMs: Long): Decision = step(nowMs) { emptyList() }

    /** Called when the previous decision's [Decision.nextWakeupMs] says to. */
    fun tick(nowMs: Long): Decision = step(nowMs) { emptyList() }

    // endregion

    // region Core

    /**
     * Every input runs the same pipeline: age the timers that do not produce actions,
     * apply the input, then let the profile catch up with what the policy wants.
     */
    private fun step(nowMs: Long, input: () -> List<Action>): Decision {
        val actions = input()
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

    private fun requestedProfile(): Profile = appliedProfile

    private fun applyBaseIfAllowed(nowMs: Long) {
        val base = baseProfile()
        if (base == appliedProfile) return
        appliedProfile = base
    }

    private fun nextWakeupMs(nowMs: Long): Long? = null

    // endregion
}
```

- [ ] **Step 8: Run the Kotlin test to verify it passes**

Run: `node scripts/build-android.js :app:testDebugUnitTest`

Expected: PASS — `ModePolicyTest` runs 5 tests, all green, and the pre-existing suites stay green.

- [ ] **Step 9: Run the mirror check**

Run:

```bash
diff <(grep -o 'assertRow("[^"]*"' ios/Radio/Tests/RadioKitTests/ModePolicyTests.swift) \
     <(grep -o 'assertRow("[^"]*"' android/app/src/test/java/com/oru/radio/ModePolicyTest.kt)
```

Expected: no output, exit status 0.

- [ ] **Step 10: Run the full task gate**

```bash
pnpm typecheck && pnpm lint && pnpm test
node scripts/build-android.js :app:testDebugUnitTest
pnpm build:android
(cd ios/Radio && DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild test -scheme RadioKit -destination 'platform=iOS Simulator,name=iPhone 17')
```

Expected: all four green.

- [ ] **Step 11: Commit**

```bash
git add ios/Radio/Sources/RadioKit/ModePolicy.swift \
        ios/Radio/Tests/RadioKitTests/ModePolicyTests.swift \
        android/app/src/main/java/com/oru/radio/ModePolicy.kt \
        android/app/src/test/java/com/oru/radio/ModePolicyTest.kt
git commit -m "feat(audio): mode policy vocabulary, constants and the audioMode pin"
```

---

## Task 2: The 2 s / 30 s asymmetric hysteresis

**Files:**
- Modify: `ios/Radio/Sources/RadioKit/ModePolicy.swift` (`step`, add `updateDwell`, `nextWakeupMs`)
- Modify: `ios/Radio/Tests/RadioKitTests/ModePolicyTests.swift` (8 rows)
- Modify: `android/app/src/main/java/com/oru/radio/ModePolicy.kt` (same three)
- Modify: `android/app/src/test/java/com/oru/radio/ModePolicyTest.kt` (same 8 rows)

**Interfaces:**
- Consumes: Task 1's `step`, `baseProfile`, `desiredAutoProfile`, `otherAudioActive`, `otherAudioSinceMs`, `Constants`.
- Produces: `desiredAutoProfile` now moves — MEDIA after `otherAudioToMediaMs` of continuous other audio, VOICE after `otherAudioToVoiceMs` of continuous silence — and `nextWakeupMs` returns the pending dwell deadline. Tasks 3–5 add their own deadlines to the same function.

- [ ] **Step 1: Write the failing Swift rows**

Append to `ModePolicyTests.swift`, after `testClearingThePinHandsTheProfileBack`:

```swift
    // MARK: - Other-audio hysteresis

    func testTwoSecondsOfOtherAudioSwitchToMedia() {
        assertRow("two seconds of other audio switch VOICE to MEDIA", [
            Step(0, .routeRequiresVoiceLink(true), .voice, [], .noTimer),
            Step(1_000, .otherAudio(true), .voice, [], .at(3_000)),
            Step(3_000, .tick, .media, [], .noTimer),
        ])
    }

    func testShortOtherAudioDoesNotSwitch() {
        assertRow("other audio shorter than two seconds does not switch", [
            Step(0, .routeRequiresVoiceLink(true), .voice, [], .noTimer),
            Step(0, .otherAudio(true), .voice, [], .at(2_000)),
            Step(1_999, .tick, .voice, [], .at(2_000)),
            Step(1_999, .otherAudio(false), .voice, [], .noTimer),
            Step(60_000, .tick, .voice, [], .noTimer),
        ])
    }

    func testAGapRestartsTheDwell() {
        assertRow("a gap in other audio restarts the two second dwell", [
            Step(0, .routeRequiresVoiceLink(true), .voice, [], .noTimer),
            Step(0, .otherAudio(true), .voice, [], .at(2_000)),
            Step(1_500, .otherAudio(false), .voice, [], .noTimer),
            Step(1_600, .otherAudio(true), .voice, [], .at(3_600)),
            Step(3_500, .tick, .voice, [], .at(3_600)),
            Step(3_600, .tick, .media, [], .noTimer),
        ])
    }

    func testThirtySecondsOfSilenceSwitchBack() {
        assertRow("thirty seconds of silence switch MEDIA back to VOICE", [
            Step(0, .routeRequiresVoiceLink(true), .voice, [], .noTimer),
            Step(0, .otherAudio(true), .voice, [], .at(2_000)),
            Step(2_000, .tick, .media, [], .noTimer),
            Step(2_000, .otherAudio(false), .media, [], .at(32_000)),
            Step(31_999, .tick, .media, [], .at(32_000)),
            Step(32_000, .tick, .voice, [], .noTimer),
        ])
    }

    func testShortSilenceKeepsMedia() {
        assertRow("silence shorter than thirty seconds keeps MEDIA", [
            Step(0, .routeRequiresVoiceLink(true), .voice, [], .noTimer),
            Step(0, .otherAudio(true), .voice, [], .at(2_000)),
            Step(2_000, .tick, .media, [], .noTimer),
            Step(2_000, .otherAudio(false), .media, [], .at(32_000)),
            Step(31_999, .tick, .media, [], .at(32_000)),
        ])
    }

    func testOtherAudioRestartingKeepsMedia() {
        assertRow("other audio restarting inside the silence window keeps MEDIA", [
            Step(0, .routeRequiresVoiceLink(true), .voice, [], .noTimer),
            Step(0, .otherAudio(true), .voice, [], .at(2_000)),
            Step(2_000, .tick, .media, [], .noTimer),
            Step(2_000, .otherAudio(false), .media, [], .at(32_000)),
            Step(20_000, .otherAudio(true), .media, [], .noTimer),
            Step(60_000, .tick, .media, [], .noTimer),
        ])
    }

    func testInertRouteKeepsVoice() {
        // §7: "Non-BT-Classic routes have no profile conflict: the policy is inert
        // there." Holding VOICE costs nothing without a conflict and keeps PTT instant.
        assertRow("a route with no voice link keeps VOICE while other audio plays", [
            Step(0, .otherAudio(true), .voice, [], .at(2_000)),
            Step(2_000, .tick, .voice, [], .noTimer),
            Step(3_000, .tick, .voice, [], .noTimer),
        ])
    }

    func testHeadsetConnectingIntoMusicSwitchesAtOnce() {
        // The dwell kept running while the route was inert, so the 2 s is already
        // served when the headset arrives.
        assertRow("a headset connecting while other audio already plays switches to MEDIA at once", [
            Step(0, .otherAudio(true), .voice, [], .at(2_000)),
            Step(2_000, .tick, .voice, [], .noTimer),
            Step(5_000, .routeRequiresVoiceLink(true), .media, [], .noTimer),
        ])
    }
```

- [ ] **Step 2: Run the Swift tests to verify they fail**

Run: `(cd ios/Radio && DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild test -scheme RadioKit -destination 'platform=iOS Simulator,name=iPhone 17' -only-testing:RadioKitTests/ModePolicyTests)`

Expected: FAIL — the 8 new tests fail (the first assertion to break is "two seconds of other audio switch VOICE to MEDIA step 1 wakeup", nil instead of 3000); the 5 tests from Task 1 still pass.

- [ ] **Step 3: Write the Swift implementation**

In `ModePolicy.swift`, replace the body of `step` with:

```swift
    private func step(_ nowMs: Int64, _ input: () -> [Action]) -> Decision {
        updateDwell(nowMs)
        let actions = input()
        applyBaseIfAllowed(nowMs)
        return Decision(
            profile: requestedProfile,
            actions: actions,
            nextWakeupMs: nextWakeupMs(nowMs)
        )
    }
```

Add, immediately after `applyBaseIfAllowed`:

```swift
    /// §7's asymmetric hysteresis. The dwell latches what the automatic policy *wants*;
    /// the gates below decide when the applied profile catches up ("switch at the next
    /// radio-idle moment"). It keeps running on routes with no voice link, so a headset
    /// connecting into already-playing music does not restart the 2 s.
    private func updateDwell(_ nowMs: Int64) {
        guard let since = otherAudioSinceMs else { return }
        if otherAudioActive {
            if nowMs - since >= Constants.otherAudioToMediaMs {
                desiredAutoProfile = .media
            }
        } else if nowMs - since >= Constants.otherAudioToVoiceMs {
            desiredAutoProfile = .voice
        }
    }
```

Replace `nextWakeupMs` with:

```swift
    /// The earliest moment at which a `tick` could change something. `updateDwell` has
    /// already run, so a dwell deadline is only reported while it is still in the future.
    private func nextWakeupMs(_ nowMs: Int64) -> Int64? {
        var deadlines: [Int64] = []
        if let since = otherAudioSinceMs {
            if otherAudioActive, desiredAutoProfile != .media {
                deadlines.append(since + Constants.otherAudioToMediaMs)
            }
            if !otherAudioActive, desiredAutoProfile != .voice {
                deadlines.append(since + Constants.otherAudioToVoiceMs)
            }
        }
        return deadlines.min()
    }
```

- [ ] **Step 4: Run the Swift tests to verify they pass**

Run: `(cd ios/Radio && DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild test -scheme RadioKit -destination 'platform=iOS Simulator,name=iPhone 17' -only-testing:RadioKitTests/ModePolicyTests)`

Expected: PASS, 13 tests.

- [ ] **Step 5: Write the mirrored failing Kotlin rows**

Append to `ModePolicyTest.kt`, after the pin region:

```kotlin
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
```

- [ ] **Step 6: Run the Kotlin tests to verify they fail**

Run: `node scripts/build-android.js :app:testDebugUnitTest`

Expected: FAIL — the same 8 rows fail with the same first mismatch.

- [ ] **Step 7: Write the Kotlin implementation**

In `ModePolicy.kt`, replace the body of `step` with:

```kotlin
    private fun step(nowMs: Long, input: () -> List<Action>): Decision {
        updateDwell(nowMs)
        val actions = input()
        applyBaseIfAllowed(nowMs)
        return Decision(
            profile = requestedProfile(),
            actions = actions,
            nextWakeupMs = nextWakeupMs(nowMs),
        )
    }
```

Add, immediately after `applyBaseIfAllowed`:

```kotlin
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
```

Replace `nextWakeupMs` with:

```kotlin
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
        return deadlines.minOrNull()
    }
```

- [ ] **Step 8: Run the Kotlin tests to verify they pass**

Run: `node scripts/build-android.js :app:testDebugUnitTest`

Expected: PASS, 13 `ModePolicyTest` tests.

- [ ] **Step 9: Run the mirror check and the full task gate**

```bash
diff <(grep -o 'assertRow("[^"]*"' ios/Radio/Tests/RadioKitTests/ModePolicyTests.swift) \
     <(grep -o 'assertRow("[^"]*"' android/app/src/test/java/com/oru/radio/ModePolicyTest.kt)
pnpm typecheck && pnpm lint && pnpm test
node scripts/build-android.js :app:testDebugUnitTest
pnpm build:android
(cd ios/Radio && DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild test -scheme RadioKit -destination 'platform=iOS Simulator,name=iPhone 17')
```

Expected: the diff prints nothing; all four gate legs green.

- [ ] **Step 10: Commit**

```bash
git add ios/Radio/Sources/RadioKit/ModePolicy.swift \
        ios/Radio/Tests/RadioKitTests/ModePolicyTests.swift \
        android/app/src/main/java/com/oru/radio/ModePolicy.kt \
        android/app/src/test/java/com/oru/radio/ModePolicyTest.kt
git commit -m "feat(audio): asymmetric 2s/30s other-audio hysteresis in the mode policy"
```

---

## Task 3: Radio-idle queuing and the 10 s rate limit

**Files:**
- Modify: `ios/Radio/Sources/RadioKit/ModePolicy.swift` (`applyBaseIfAllowed`, `nextWakeupMs`, add `lastSwitchMs`)
- Modify: `ios/Radio/Tests/RadioKitTests/ModePolicyTests.swift` (5 rows)
- Modify: `android/app/src/main/java/com/oru/radio/ModePolicy.kt` (same)
- Modify: `android/app/src/test/java/com/oru/radio/ModePolicyTest.kt` (same 5 rows)

**Interfaces:**
- Consumes: Task 2's `desiredAutoProfile` and `nextWakeupMs`; Task 1's `radioActive`, `baseProfile`, `appliedProfile`.
- Produces: a new private `lastSwitchMs: Int64?` / `Long?` stamped by every policy-driven switch, the two gates on `applyBaseIfAllowed`, and a rate-limit deadline in `nextWakeupMs`. Task 5's raise/drop path deliberately bypasses both.

- [ ] **Step 1: Write the failing Swift rows**

Append to `ModePolicyTests.swift`:

```swift
    // MARK: - Radio-idle queuing and the rate limit

    func testASwitchWaitsWhileTheRadioIsBusy() {
        // No timer is reported while the radio is busy: the switch is waiting on an
        // input (the radio going idle), not on a clock.
        assertRow("a switch waits while the radio is busy and applies when it goes idle", [
            Step(0, .routeRequiresVoiceLink(true), .voice, [], .noTimer),
            Step(0, .radioActive(true), .voice, [], .noTimer),
            Step(0, .otherAudio(true), .voice, [], .at(2_000)),
            Step(2_000, .tick, .voice, [], .noTimer),
            Step(5_000, .radioActive(false), .media, [], .noTimer),
        ])
    }

    func testASecondSwitchWaitsForTheRateLimit() {
        assertRow("a second switch inside ten seconds waits for the rate limit", [
            Step(0, .routeRequiresVoiceLink(true), .voice, [], .noTimer),
            Step(0, .otherAudio(true), .voice, [], .at(2_000)),
            Step(2_000, .tick, .media, [], .noTimer),
            Step(3_000, .audioMode(.voice), .media, [], .at(12_000)),
            Step(11_999, .tick, .media, [], .at(12_000)),
            Step(12_000, .tick, .voice, [], .noTimer),
        ])
    }

    func testASwitchAfterTheWindowIsNotDelayed() {
        assertRow("a switch more than ten seconds after the previous one is not delayed", [
            Step(0, .routeRequiresVoiceLink(true), .voice, [], .noTimer),
            Step(0, .otherAudio(true), .voice, [], .at(2_000)),
            Step(2_000, .tick, .media, [], .noTimer),
            Step(12_000, .audioMode(.voice), .voice, [], .noTimer),
        ])
    }

    func testAPinnedModeChangeWaitsForIdle() {
        assertRow("a pinned mode change also waits for the radio to go idle", [
            Step(0, .radioActive(true), .voice, [], .noTimer),
            Step(0, .audioMode(.media), .voice, [], .noTimer),
            Step(1_000, .radioActive(false), .media, [], .noTimer),
        ])
    }

    func testAQueuedSwitchWaitsForBoth() {
        assertRow("a queued switch waits for both the rate limit and the radio", [
            Step(0, .routeRequiresVoiceLink(true), .voice, [], .noTimer),
            Step(0, .otherAudio(true), .voice, [], .at(2_000)),
            Step(2_000, .tick, .media, [], .noTimer),
            Step(3_000, .audioMode(.voice), .media, [], .at(12_000)),
            Step(4_000, .radioActive(true), .media, [], .noTimer),
            Step(20_000, .tick, .media, [], .noTimer),
            Step(21_000, .radioActive(false), .voice, [], .noTimer),
        ])
    }
```

- [ ] **Step 2: Run the Swift tests to verify they fail**

Run: `(cd ios/Radio && DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild test -scheme RadioKit -destination 'platform=iOS Simulator,name=iPhone 17' -only-testing:RadioKitTests/ModePolicyTests)`

Expected: FAIL — 4 of the 5 new rows fail (the first is "a switch waits while the radio is busy and applies when it goes idle step 3 profile", media instead of voice); "a switch more than ten seconds after the previous one is not delayed" already passes, because it asserts the *absence* of a delay.

- [ ] **Step 3: Write the Swift implementation**

In `ModePolicy.swift`, add to the state section after `appliedProfile`:

```swift
    /// When the last policy-driven switch was applied, for the 10 s rate limit. The
    /// PTT raise/drop of §7 neither consults nor stamps it.
    private var lastSwitchMs: Int64?
```

Replace `applyBaseIfAllowed` with:

```swift
    /// §7's two gates on a VOICE↔MEDIA switch: it never runs during receive or transmit
    /// (it queues for idle), and at most one runs per `switchRateLimitMs`. A pin change
    /// is a switch like any other — applying one mid-transmission would break the same
    /// audio a policy switch would.
    private func applyBaseIfAllowed(_ nowMs: Int64) {
        let base = baseProfile
        guard base != appliedProfile, !radioActive else { return }
        if let last = lastSwitchMs, nowMs - last < Constants.switchRateLimitMs { return }
        appliedProfile = base
        lastSwitchMs = nowMs
    }
```

In `nextWakeupMs`, add before `return deadlines.min()`:

```swift
        // A switch the rate limit is holding back will need a tick when the window
        // closes. One the *radio* is holding back does not: the radio going idle is an
        // input, and it runs the gate itself.
        if baseProfile != appliedProfile, !radioActive,
           let last = lastSwitchMs, nowMs - last < Constants.switchRateLimitMs {
            deadlines.append(last + Constants.switchRateLimitMs)
        }
```

- [ ] **Step 4: Run the Swift tests to verify they pass**

Run: `(cd ios/Radio && DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild test -scheme RadioKit -destination 'platform=iOS Simulator,name=iPhone 17' -only-testing:RadioKitTests/ModePolicyTests)`

Expected: PASS, 18 tests.

- [ ] **Step 5: Write the mirrored failing Kotlin rows**

Append to `ModePolicyTest.kt`:

```kotlin
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
```

- [ ] **Step 6: Run the Kotlin tests to verify they fail**

Run: `node scripts/build-android.js :app:testDebugUnitTest`

Expected: FAIL — the same 4 rows.

- [ ] **Step 7: Write the Kotlin implementation**

In `ModePolicy.kt`, add to the state region after `appliedProfile`:

```kotlin
    /**
     * When the last policy-driven switch was applied, for the 10 s rate limit. The PTT
     * raise/drop of section 7 neither consults nor stamps it.
     */
    private var lastSwitchMs: Long? = null
```

Replace `applyBaseIfAllowed` with:

```kotlin
    /**
     * Section 7's two gates on a VOICE/MEDIA switch: it never runs during receive or
     * transmit (it queues for idle), and at most one runs per [Constants.SWITCH_RATE_LIMIT_MS].
     * A pin change is a switch like any other — applying one mid-transmission would break
     * the same audio a policy switch would.
     */
    private fun applyBaseIfAllowed(nowMs: Long) {
        val base = baseProfile()
        if (base == appliedProfile || radioActive) return
        val last = lastSwitchMs
        if (last != null && nowMs - last < Constants.SWITCH_RATE_LIMIT_MS) return
        appliedProfile = base
        lastSwitchMs = nowMs
    }
```

In `nextWakeupMs`, add before `return deadlines.minOrNull()`:

```kotlin
        // A switch the rate limit is holding back will need a tick when the window
        // closes. One the *radio* is holding back does not: the radio going idle is an
        // input, and it runs the gate itself.
        val last = lastSwitchMs
        if (baseProfile() != appliedProfile && !radioActive &&
            last != null && nowMs - last < Constants.SWITCH_RATE_LIMIT_MS
        ) {
            deadlines.add(last + Constants.SWITCH_RATE_LIMIT_MS)
        }
```

- [ ] **Step 8: Run the Kotlin tests to verify they pass**

Run: `node scripts/build-android.js :app:testDebugUnitTest`

Expected: PASS, 18 `ModePolicyTest` tests.

- [ ] **Step 9: Run the mirror check and the full task gate**

```bash
diff <(grep -o 'assertRow("[^"]*"' ios/Radio/Tests/RadioKitTests/ModePolicyTests.swift) \
     <(grep -o 'assertRow("[^"]*"' android/app/src/test/java/com/oru/radio/ModePolicyTest.kt)
pnpm typecheck && pnpm lint && pnpm test
node scripts/build-android.js :app:testDebugUnitTest
pnpm build:android
(cd ios/Radio && DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild test -scheme RadioKit -destination 'platform=iOS Simulator,name=iPhone 17')
```

Expected: the diff prints nothing; all four gate legs green.

- [ ] **Step 10: Commit**

```bash
git add ios/Radio/Sources/RadioKit/ModePolicy.swift \
        ios/Radio/Tests/RadioKitTests/ModePolicyTests.swift \
        android/app/src/main/java/com/oru/radio/ModePolicy.kt \
        android/app/src/test/java/com/oru/radio/ModePolicyTest.kt
git commit -m "feat(audio): queue mode switches for radio idle and rate-limit them to 10s"
```

---

## Task 4: PTT — the grant tone, the raise, the 4 s timeout

**Files:**
- Modify: `ios/Radio/Sources/RadioKit/ModePolicy.swift` (PTT state machine)
- Modify: `ios/Radio/Tests/RadioKitTests/ModePolicyTests.swift` (8 rows)
- Modify: `android/app/src/main/java/com/oru/radio/ModePolicy.kt` (same)
- Modify: `android/app/src/test/java/com/oru/radio/ModePolicyTest.kt` (same 8 rows)

**Interfaces:**
- Consumes: everything from Tasks 1–3.
- Produces: a private `PttState` (`idle` / `awaitingLink(deadlineMs:)` / `talking(linkRaised:)`), `holdsVoiceLink`, a `requestedProfile` that reports VOICE while a link is held, `press`, `release`, `abandonRaise`, `settleLink`, and the grant deadline in `nextWakeupMs`. Task 5 extends `PttState` with `lingering` and `dropPending`.

- [ ] **Step 1: Write the failing Swift rows**

Append to `ModePolicyTests.swift`:

```swift
    // MARK: - PTT, the grant tone and the raise

    func testPttInVoiceIsImmediate() {
        assertRow("PTT in VOICE plays the grant tone and starts capture at once", [
            Step(0, .pttPressed, .voice, [.playGrantTone, .startCapture(.routeDefault)], .noTimer),
            Step(500, .radioActive(true), .voice, [], .noTimer),
            Step(3_000, .pttReleased, .voice, [], .noTimer),
        ])
    }

    func testPttOnAnInertRouteIsImmediate() {
        assertRow("PTT on a route with no voice link is immediate even in MEDIA", [
            Step(0, .audioMode(.media), .media, [], .noTimer),
            Step(1_000, .pttPressed, .media, [.playGrantTone, .startCapture(.routeDefault)], .noTimer),
            Step(3_000, .pttReleased, .media, [], .noTimer),
        ])
    }

    func testPttInMediaRaisesTheLink() {
        assertRow("PTT in MEDIA on a voice link route raises the link and waits", [
            Step(0, .routeRequiresVoiceLink(true), .voice, [], .noTimer),
            Step(0, .otherAudio(true), .voice, [], .at(2_000)),
            Step(2_000, .tick, .media, [], .noTimer),
            Step(3_000, .pttPressed, .voice, [.raiseVoiceLink], .at(7_000)),
            Step(4_000, .tick, .voice, [], .at(7_000)),
        ])
    }

    func testTheToneFollowsTheEstablishedLink() {
        assertRow("the grant tone follows the established link and capture uses the route mic", [
            Step(0, .routeRequiresVoiceLink(true), .voice, [], .noTimer),
            Step(0, .otherAudio(true), .voice, [], .at(2_000)),
            Step(2_000, .tick, .media, [], .noTimer),
            Step(3_000, .pttPressed, .voice, [.raiseVoiceLink], .at(7_000)),
            Step(3_500, .voiceLinkEstablished, .voice,
                 [.playGrantTone, .startCapture(.routeDefault)], .noTimer),
        ])
    }

    func testALinkThatNeverComesUpTimesOut() {
        assertRow("a link that never comes up times out after four seconds into the phone mic", [
            Step(0, .routeRequiresVoiceLink(true), .voice, [], .noTimer),
            Step(0, .otherAudio(true), .voice, [], .at(2_000)),
            Step(2_000, .tick, .media, [], .noTimer),
            Step(3_000, .pttPressed, .voice, [.raiseVoiceLink], .at(7_000)),
            Step(6_999, .tick, .voice, [], .at(7_000)),
            Step(7_000, .tick, .media,
                 [.dropVoiceLink, .playGrantTone, .startCapture(.phoneFallback)], .noTimer),
            Step(10_000, .pttReleased, .media, [], .noTimer),
        ])
    }

    func testAnImmediateFailureFallsBackAtOnce() {
        assertRow("an immediate link failure falls back to the phone mic without waiting", [
            Step(0, .routeRequiresVoiceLink(true), .voice, [], .noTimer),
            Step(0, .otherAudio(true), .voice, [], .at(2_000)),
            Step(2_000, .tick, .media, [], .noTimer),
            Step(3_000, .pttPressed, .voice, [.raiseVoiceLink], .at(7_000)),
            Step(3_100, .voiceLinkFailed, .media,
                 [.dropVoiceLink, .playGrantTone, .startCapture(.phoneFallback)], .noTimer),
        ])
    }

    func testReleasingBeforeTheLinkCancelsIt() {
        // The tone means "you may talk" and the user already let go, so there is none.
        assertRow("releasing before the link comes up abandons the raise with no tone", [
            Step(0, .routeRequiresVoiceLink(true), .voice, [], .noTimer),
            Step(0, .otherAudio(true), .voice, [], .at(2_000)),
            Step(2_000, .tick, .media, [], .noTimer),
            Step(3_000, .pttPressed, .voice, [.raiseVoiceLink], .at(7_000)),
            Step(3_500, .pttReleased, .media, [.dropVoiceLink], .noTimer),
            Step(7_000, .tick, .media, [], .noTimer),
        ])
    }

    func testASecondPressWhileRaisingIsIgnored() {
        assertRow("a second press while the link is being raised is ignored", [
            Step(0, .routeRequiresVoiceLink(true), .voice, [], .noTimer),
            Step(0, .otherAudio(true), .voice, [], .at(2_000)),
            Step(2_000, .tick, .media, [], .noTimer),
            Step(3_000, .pttPressed, .voice, [.raiseVoiceLink], .at(7_000)),
            Step(3_100, .pttPressed, .voice, [], .at(7_000)),
        ])
    }
```

- [ ] **Step 2: Run the Swift tests to verify they fail**

Run: `(cd ios/Radio && DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild test -scheme RadioKit -destination 'platform=iOS Simulator,name=iPhone 17' -only-testing:RadioKitTests/ModePolicyTests)`

Expected: FAIL — all 8 new rows (the first is "PTT in VOICE plays the grant tone and starts capture at once step 0 actions", `[]` instead of the tone and capture).

- [ ] **Step 3: Write the Swift implementation**

In `ModePolicy.swift`, add to the state section, above `audioMode`:

```swift
    /// Where the PTT half of §7 stands. Task 5 adds the linger states.
    private enum PttState {
        case idle
        /// A raise was requested; `deadlineMs` is when §7's 4 s grant timeout fires.
        case awaitingLink(deadlineMs: Int64)
        /// Capture is running. `linkRaised` is false when this transmission fell back to
        /// the phone mic, which is why it has nothing to linger on afterwards.
        case talking(linkRaised: Bool)
    }
```

and after `lastSwitchMs`:

```swift
    private var pttState: PttState = .idle
```

Replace the four inert PTT methods with:

```swift
    public func pttPressed(nowMs: Int64) -> Decision {
        step(nowMs) { self.press(nowMs) }
    }

    public func pttReleased(nowMs: Int64) -> Decision {
        step(nowMs) { self.release(nowMs) }
    }

    /// The headset mic path is confirmed (SCO connected / the comm device applied).
    public func voiceLinkEstablished(nowMs: Int64) -> Decision {
        step(nowMs) {
            guard case .awaitingLink = self.pttState else { return [] }
            self.pttState = .talking(linkRaised: true)
            return [.playGrantTone, .startCapture(.routeDefault)]
        }
    }

    /// The raise failed outright (`setCommunicationDevice` returned false, an SCO error).
    /// Same answer as the 4 s timeout, without waiting for it.
    public func voiceLinkFailed(nowMs: Int64) -> Decision {
        step(nowMs) {
            guard case .awaitingLink = self.pttState else { return [] }
            return self.abandonRaise()
        }
    }
```

Replace `step` with:

```swift
    private func step(_ nowMs: Int64, _ input: () -> [Action]) -> Decision {
        updateDwell(nowMs)
        var actions = input()
        actions += settleLink(nowMs)
        applyBaseIfAllowed(nowMs)
        return Decision(
            profile: requestedProfile,
            actions: actions,
            nextWakeupMs: nextWakeupMs(nowMs)
        )
    }
```

Replace `requestedProfile` and add the PTT machine after it:

```swift
    /// True while this policy is holding a headset voice link up on the platform.
    private var holdsVoiceLink: Bool {
        switch pttState {
        case .idle:
            return false
        case .talking(let linkRaised):
            return linkRaised
        case .awaitingLink:
            return true
        }
    }

    private var requestedProfile: Profile {
        holdsVoiceLink ? .voice : appliedProfile
    }

    /// §7: "press → tone → talk", in every mode. The tone is immediate wherever the mic
    /// is already live — in VOICE, and on any route with no profile conflict — and waits
    /// for the raise otherwise.
    private func press(_ nowMs: Int64) -> [Action] {
        switch pttState {
        case .awaitingLink, .talking:
            return []
        case .idle:
            if appliedProfile == .voice || !routeRequiresVoiceLink {
                pttState = .talking(linkRaised: false)
                return [.playGrantTone, .startCapture(.routeDefault)]
            }
            pttState = .awaitingLink(
                deadlineMs: nowMs + Constants.voiceLinkGrantTimeoutMs
            )
            return [.raiseVoiceLink]
        }
    }

    private func release(_ nowMs: Int64) -> [Action] {
        switch pttState {
        case .talking:
            pttState = .idle
            return []
        case .awaitingLink:
            // Released before the mic ever went live: no tone, nothing to capture.
            return abandonRaise(startCapture: false)
        case .idle:
            return []
        }
    }

    /// Gives up a raise that timed out or failed (§7's 4 s timeout, D2's SCO failure).
    /// The pending raise is undone *before* the tone, so capture starts with the base
    /// profile already restored — D2 rejects swapping the mic mid-transmission, so a link
    /// that arrives late is not used for this transmission. Restoring the base profile
    /// here is part of the raise/drop mechanism and so is exempt from the rate limit: it
    /// neither consults nor stamps `lastSwitchMs`.
    private func abandonRaise(startCapture: Bool = true) -> [Action] {
        pttState = startCapture ? .talking(linkRaised: false) : .idle
        let base = baseProfile
        appliedProfile = base
        var actions: [Action] = base == .voice ? [] : [.dropVoiceLink]
        if startCapture {
            actions.append(.playGrantTone)
            actions.append(.startCapture(.phoneFallback))
        }
        return actions
    }

    /// Fires the PTT deadlines that have come due. Runs after the input, so an input that
    /// resolves a deadline (a link arriving at 4.1 s, a release) wins over it.
    private func settleLink(_ nowMs: Int64) -> [Action] {
        switch pttState {
        case .awaitingLink(let deadlineMs) where nowMs >= deadlineMs:
            return abandonRaise()
        default:
            return []
        }
    }
```

In `applyBaseIfAllowed`, add these three lines at the top of the body, before `let base = baseProfile`:

```swift
        // While a press is in flight the profile belongs to the PTT machine; a policy
        // switch would fight it.
        guard case .idle = pttState else { return }
```

In `nextWakeupMs`, add the PTT deadline before the rate-limit block:

```swift
        if case .awaitingLink(let deadlineMs) = pttState {
            deadlines.append(deadlineMs)
        }
```

and guard the rate-limit block with the same idle condition, so it reads:

```swift
        if case .idle = pttState, baseProfile != appliedProfile, !radioActive,
           let last = lastSwitchMs, nowMs - last < Constants.switchRateLimitMs {
            deadlines.append(last + Constants.switchRateLimitMs)
        }
```

- [ ] **Step 4: Run the Swift tests to verify they pass**

Run: `(cd ios/Radio && DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild test -scheme RadioKit -destination 'platform=iOS Simulator,name=iPhone 17' -only-testing:RadioKitTests/ModePolicyTests)`

Expected: PASS, 26 tests.

- [ ] **Step 5: Write the mirrored failing Kotlin rows**

Append to `ModePolicyTest.kt`:

```kotlin
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
```

- [ ] **Step 6: Run the Kotlin tests to verify they fail**

Run: `node scripts/build-android.js :app:testDebugUnitTest`

Expected: FAIL — the same 8 rows.

- [ ] **Step 7: Write the Kotlin implementation**

In `ModePolicy.kt`, add to the state region, above `audioMode`:

```kotlin
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
```

and after `lastSwitchMs`:

```kotlin
    private var pttState: PttState = PttState.Idle
```

Replace the four inert PTT methods with:

```kotlin
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
```

Replace `step` with:

```kotlin
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
```

(`input()` is evaluated before `settleLink(nowMs)`: Kotlin evaluates the left operand of `+` first, which is what makes an input that resolves a deadline win over it.)

Replace `requestedProfile` and add the PTT machine after it:

```kotlin
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
```

In `applyBaseIfAllowed`, add as the first line:

```kotlin
        // While a press is in flight the profile belongs to the PTT machine; a policy
        // switch would fight it.
        if (pttState !is PttState.Idle) return
```

In `nextWakeupMs`, add the PTT deadline before the rate-limit block:

```kotlin
        val state = pttState
        if (state is PttState.AwaitingLink) deadlines.add(state.deadlineMs)
```

and add `pttState is PttState.Idle &&` as the first condition of the rate-limit block:

```kotlin
        val last = lastSwitchMs
        if (pttState is PttState.Idle && baseProfile() != appliedProfile && !radioActive &&
            last != null && nowMs - last < Constants.SWITCH_RATE_LIMIT_MS
        ) {
            deadlines.add(last + Constants.SWITCH_RATE_LIMIT_MS)
        }
```

- [ ] **Step 8: Run the Kotlin tests to verify they pass**

Run: `node scripts/build-android.js :app:testDebugUnitTest`

Expected: PASS, 26 `ModePolicyTest` tests.

- [ ] **Step 9: Run the mirror check and the full task gate**

```bash
diff <(grep -o 'assertRow("[^"]*"' ios/Radio/Tests/RadioKitTests/ModePolicyTests.swift) \
     <(grep -o 'assertRow("[^"]*"' android/app/src/test/java/com/oru/radio/ModePolicyTest.kt)
pnpm typecheck && pnpm lint && pnpm test
node scripts/build-android.js :app:testDebugUnitTest
pnpm build:android
(cd ios/Radio && DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild test -scheme RadioKit -destination 'platform=iOS Simulator,name=iPhone 17')
```

Expected: the diff prints nothing; all four gate legs green.

- [ ] **Step 10: Commit**

```bash
git add ios/Radio/Sources/RadioKit/ModePolicy.swift \
        ios/Radio/Tests/RadioKitTests/ModePolicyTests.swift \
        android/app/src/main/java/com/oru/radio/ModePolicy.kt \
        android/app/src/test/java/com/oru/radio/ModePolicyTest.kt
git commit -m "feat(audio): PTT grant tone, voice-link raise and 4s phone-mic fallback"
```

---

## Task 5: The 15 s linger and the drop

**Files:**
- Modify: `ios/Radio/Sources/RadioKit/ModePolicy.swift` (linger states)
- Modify: `ios/Radio/Tests/RadioKitTests/ModePolicyTests.swift` (9 rows)
- Modify: `android/app/src/main/java/com/oru/radio/ModePolicy.kt` (same)
- Modify: `android/app/src/test/java/com/oru/radio/ModePolicyTest.kt` (same 9 rows)

**Interfaces:**
- Consumes: Task 4's `PttState`, `press`, `release`, `settleLink`, `holdsVoiceLink`, `abandonRaise`.
- Produces: `PttState.lingering(untilMs:)` and `PttState.dropPending`, `settleDrop`, and the linger deadline in `nextWakeupMs`. This completes the public behaviour P3/P4 wire in wave 2; no interface changes after this task.

- [ ] **Step 1: Write the failing Swift rows**

Append to `ModePolicyTests.swift`:

```swift
    // MARK: - The linger and the drop

    func testTheRaisedLinkLingers() {
        assertRow("the raised link lingers fifteen seconds after release", [
            Step(0, .routeRequiresVoiceLink(true), .voice, [], .noTimer),
            Step(0, .otherAudio(true), .voice, [], .at(2_000)),
            Step(2_000, .tick, .media, [], .noTimer),
            Step(3_000, .pttPressed, .voice, [.raiseVoiceLink], .at(7_000)),
            Step(3_500, .voiceLinkEstablished, .voice,
                 [.playGrantTone, .startCapture(.routeDefault)], .noTimer),
            Step(5_000, .pttReleased, .voice, [], .at(20_000)),
            Step(19_999, .tick, .voice, [], .at(20_000)),
        ])
    }

    func testAPressInsideTheLingerIsInstant() {
        assertRow("a press inside the linger window is instant", [
            Step(0, .routeRequiresVoiceLink(true), .voice, [], .noTimer),
            Step(0, .otherAudio(true), .voice, [], .at(2_000)),
            Step(2_000, .tick, .media, [], .noTimer),
            Step(3_000, .pttPressed, .voice, [.raiseVoiceLink], .at(7_000)),
            Step(3_500, .voiceLinkEstablished, .voice,
                 [.playGrantTone, .startCapture(.routeDefault)], .noTimer),
            Step(5_000, .pttReleased, .voice, [], .at(20_000)),
            Step(10_000, .pttPressed, .voice,
                 [.playGrantTone, .startCapture(.routeDefault)], .noTimer),
        ])
    }

    func testTheLingerRestartsOnEveryRelease() {
        assertRow("the linger restarts on every release", [
            Step(0, .routeRequiresVoiceLink(true), .voice, [], .noTimer),
            Step(0, .otherAudio(true), .voice, [], .at(2_000)),
            Step(2_000, .tick, .media, [], .noTimer),
            Step(3_000, .pttPressed, .voice, [.raiseVoiceLink], .at(7_000)),
            Step(3_500, .voiceLinkEstablished, .voice,
                 [.playGrantTone, .startCapture(.routeDefault)], .noTimer),
            Step(5_000, .pttReleased, .voice, [], .at(20_000)),
            Step(10_000, .pttPressed, .voice,
                 [.playGrantTone, .startCapture(.routeDefault)], .noTimer),
            Step(12_000, .pttReleased, .voice, [], .at(27_000)),
        ])
    }

    func testTheLinkDropsWhenTheLingerExpires() {
        assertRow("the link drops when the linger expires and MEDIA returns", [
            Step(0, .routeRequiresVoiceLink(true), .voice, [], .noTimer),
            Step(0, .otherAudio(true), .voice, [], .at(2_000)),
            Step(2_000, .tick, .media, [], .noTimer),
            Step(3_000, .pttPressed, .voice, [.raiseVoiceLink], .at(7_000)),
            Step(3_500, .voiceLinkEstablished, .voice,
                 [.playGrantTone, .startCapture(.routeDefault)], .noTimer),
            Step(5_000, .pttReleased, .voice, [], .at(20_000)),
            Step(20_000, .tick, .media, [.dropVoiceLink], .noTimer),
        ])
    }

    func testAFallbackTransmissionDoesNotLinger() {
        assertRow("a phone mic fallback transmission does not linger", [
            Step(0, .routeRequiresVoiceLink(true), .voice, [], .noTimer),
            Step(0, .otherAudio(true), .voice, [], .at(2_000)),
            Step(2_000, .tick, .media, [], .noTimer),
            Step(3_000, .pttPressed, .voice, [.raiseVoiceLink], .at(7_000)),
            Step(7_000, .tick, .media,
                 [.dropVoiceLink, .playGrantTone, .startCapture(.phoneFallback)], .noTimer),
            Step(10_000, .pttReleased, .media, [], .noTimer),
            Step(40_000, .tick, .media, [], .noTimer),
        ])
    }

    func testTheDropWaitsForIdle() {
        // §7 exempts the raise/drop from the 10 s rate limit by name, not from the
        // "switches never run during receive or transmit" rule in the same bullet.
        assertRow("the linger drop waits for the radio to go idle", [
            Step(0, .routeRequiresVoiceLink(true), .voice, [], .noTimer),
            Step(0, .otherAudio(true), .voice, [], .at(2_000)),
            Step(2_000, .tick, .media, [], .noTimer),
            Step(3_000, .pttPressed, .voice, [.raiseVoiceLink], .at(7_000)),
            Step(3_500, .voiceLinkEstablished, .voice,
                 [.playGrantTone, .startCapture(.routeDefault)], .noTimer),
            Step(5_000, .pttReleased, .voice, [], .at(20_000)),
            Step(10_000, .radioActive(true), .voice, [], .at(20_000)),
            Step(20_000, .tick, .voice, [], .noTimer),
            Step(25_000, .radioActive(false), .media, [.dropVoiceLink], .noTimer),
        ])
    }

    func testTheRaiseIsExemptFromTheRateLimit() {
        // The raise happens 500 ms after a policy switch and is not deferred; the drop
        // does not stamp the limit either, which the last step proves — a policy switch
        // 100 ms after the drop is applied at once.
        assertRow("the raise is exempt from the rate limit and the drop does not consume it", [
            Step(0, .routeRequiresVoiceLink(true), .voice, [], .noTimer),
            Step(0, .otherAudio(true), .voice, [], .at(2_000)),
            Step(2_000, .tick, .media, [], .noTimer),
            Step(2_500, .pttPressed, .voice, [.raiseVoiceLink], .at(6_500)),
            Step(2_600, .voiceLinkEstablished, .voice,
                 [.playGrantTone, .startCapture(.routeDefault)], .noTimer),
            Step(2_700, .pttReleased, .voice, [], .at(17_700)),
            Step(17_700, .tick, .media, [.dropVoiceLink], .noTimer),
            Step(17_800, .audioMode(.voice), .voice, [], .noTimer),
        ])
    }

    func testTheLinkIsKeptWhenThePolicyWantsVoice() {
        assertRow("the link is kept when the policy wants VOICE by the time the linger expires", [
            Step(0, .routeRequiresVoiceLink(true), .voice, [], .noTimer),
            Step(0, .otherAudio(true), .voice, [], .at(2_000)),
            Step(2_000, .tick, .media, [], .noTimer),
            Step(3_000, .pttPressed, .voice, [.raiseVoiceLink], .at(7_000)),
            Step(3_100, .voiceLinkEstablished, .voice,
                 [.playGrantTone, .startCapture(.routeDefault)], .noTimer),
            Step(3_200, .otherAudio(false), .voice, [], .at(33_200)),
            Step(4_000, .pttReleased, .voice, [], .at(19_000)),
            Step(18_000, .pttPressed, .voice,
                 [.playGrantTone, .startCapture(.routeDefault)], .at(33_200)),
            Step(19_000, .pttReleased, .voice, [], .at(33_200)),
            Step(33_200, .tick, .voice, [], .at(34_000)),
            Step(34_000, .tick, .voice, [], .noTimer),
        ])
    }

    func testPttRaisesInsideAPinnedMediaMode() {
        assertRow("PTT raises the link inside a pinned media mode", [
            Step(0, .routeRequiresVoiceLink(true), .voice, [], .noTimer),
            Step(0, .audioMode(.media), .media, [], .noTimer),
            Step(1_000, .pttPressed, .voice, [.raiseVoiceLink], .at(5_000)),
            Step(1_500, .voiceLinkEstablished, .voice,
                 [.playGrantTone, .startCapture(.routeDefault)], .noTimer),
            Step(2_000, .pttReleased, .voice, [], .at(17_000)),
            Step(17_000, .tick, .media, [.dropVoiceLink], .noTimer),
        ])
    }
```

- [ ] **Step 2: Run the Swift tests to verify they fail**

Run: `(cd ios/Radio && DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild test -scheme RadioKit -destination 'platform=iOS Simulator,name=iPhone 17' -only-testing:RadioKitTests/ModePolicyTests)`

Expected: FAIL — 8 of the 9 new rows (the first is "the raised link lingers fifteen seconds after release step 5 profile", media instead of voice); "a phone mic fallback transmission does not linger" already passes, because it asserts the absence of a linger.

- [ ] **Step 3: Write the Swift implementation**

In `ModePolicy.swift`, replace the `PttState` enum with:

```swift
    /// Where the PTT half of §7 stands.
    private enum PttState {
        case idle
        /// A raise was requested; `deadlineMs` is when §7's 4 s grant timeout fires.
        case awaitingLink(deadlineMs: Int64)
        /// Capture is running. `linkRaised` is false when this transmission fell back to
        /// the phone mic, which is why it has nothing to linger on afterwards.
        case talking(linkRaised: Bool)
        /// Released with the link up: held until `untilMs` so the rest of the
        /// conversation is instant.
        case lingering(untilMs: Int64)
        /// The linger expired while the radio was busy; the link is held until idle.
        case dropPending
    }
```

Replace `holdsVoiceLink` with:

```swift
    private var holdsVoiceLink: Bool {
        switch pttState {
        case .idle:
            return false
        case .talking(let linkRaised):
            return linkRaised
        case .awaitingLink, .lingering, .dropPending:
            return true
        }
    }
```

Replace `press`, `release` and `settleLink`, and add `settleDrop`:

```swift
    /// §7: "press → tone → talk", in every mode. The tone is immediate wherever the mic
    /// is already live — in VOICE, on any route with no profile conflict, and inside the
    /// linger window where the link is still up — and waits for the raise otherwise.
    private func press(_ nowMs: Int64) -> [Action] {
        switch pttState {
        case .lingering, .dropPending:
            pttState = .talking(linkRaised: true)
            return [.playGrantTone, .startCapture(.routeDefault)]
        case .awaitingLink, .talking:
            return []
        case .idle:
            if appliedProfile == .voice || !routeRequiresVoiceLink {
                pttState = .talking(linkRaised: false)
                return [.playGrantTone, .startCapture(.routeDefault)]
            }
            pttState = .awaitingLink(
                deadlineMs: nowMs + Constants.voiceLinkGrantTimeoutMs
            )
            return [.raiseVoiceLink]
        }
    }

    private func release(_ nowMs: Int64) -> [Action] {
        switch pttState {
        case .talking(let linkRaised):
            pttState = linkRaised
                ? .lingering(untilMs: nowMs + Constants.voiceLinkLingerMs)
                : .idle
            return []
        case .awaitingLink:
            // Released before the mic ever went live: no tone, nothing to capture.
            return abandonRaise(startCapture: false)
        case .idle, .lingering, .dropPending:
            return []
        }
    }

    /// Fires the PTT deadlines that have come due. Runs after the input, so an input that
    /// resolves a deadline (a link arriving at 4.1 s, a release, a press inside the
    /// linger) wins over it.
    private func settleLink(_ nowMs: Int64) -> [Action] {
        switch pttState {
        case .awaitingLink(let deadlineMs) where nowMs >= deadlineMs:
            return abandonRaise()
        case .lingering(let untilMs) where nowMs >= untilMs:
            pttState = .dropPending
            return settleDrop()
        case .dropPending:
            return settleDrop()
        default:
            return []
        }
    }

    /// Lets the raised link go. §7 exempts the raise/drop from the 10 s rate limit by
    /// name — so this neither consults nor stamps `lastSwitchMs` — but not from the
    /// "switches never run during receive or transmit" rule in the same bullet, so an
    /// expired linger holds the link rather than glitching an incoming transmission.
    /// No `dropVoiceLink` when the policy wants VOICE by now: the link stays up as the
    /// profile, not as a leftover.
    private func settleDrop() -> [Action] {
        guard !radioActive else { return [] }
        pttState = .idle
        let base = baseProfile
        appliedProfile = base
        return base == .voice ? [] : [.dropVoiceLink]
    }
```

In `nextWakeupMs`, replace the PTT deadline block with:

```swift
        switch pttState {
        case .awaitingLink(let deadlineMs):
            deadlines.append(deadlineMs)
        case .lingering(let untilMs):
            deadlines.append(untilMs)
        case .idle, .talking, .dropPending:
            // `dropPending` waits on the radio going idle, which is an input.
            break
        }
```

- [ ] **Step 4: Run the Swift tests to verify they pass**

Run: `(cd ios/Radio && DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild test -scheme RadioKit -destination 'platform=iOS Simulator,name=iPhone 17' -only-testing:RadioKitTests/ModePolicyTests)`

Expected: PASS, 35 tests.

- [ ] **Step 5: Write the mirrored failing Kotlin rows**

Append to `ModePolicyTest.kt`:

```kotlin
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
```

- [ ] **Step 6: Run the Kotlin tests to verify they fail**

Run: `node scripts/build-android.js :app:testDebugUnitTest`

Expected: FAIL — the same 8 rows.

- [ ] **Step 7: Write the Kotlin implementation**

In `ModePolicy.kt`, replace the `PttState` interface with:

```kotlin
    /** Where the PTT half of section 7 stands. */
    private sealed interface PttState {
        data object Idle : PttState

        /** A raise was requested; [deadlineMs] is when the 4 s grant timeout fires. */
        data class AwaitingLink(val deadlineMs: Long) : PttState

        /**
         * Capture is running. [linkRaised] is false when this transmission fell back to
         * the phone mic, which is why it has nothing to linger on afterwards.
         */
        data class Talking(val linkRaised: Boolean) : PttState

        /**
         * Released with the link up: held until [untilMs] so the rest of the conversation
         * is instant.
         */
        data class Lingering(val untilMs: Long) : PttState

        /** The linger expired while the radio was busy; the link is held until idle. */
        data object DropPending : PttState
    }
```

Replace `holdsVoiceLink` with:

```kotlin
    private fun holdsVoiceLink(): Boolean = when (val state = pttState) {
        is PttState.Idle -> false
        is PttState.Talking -> state.linkRaised
        is PttState.AwaitingLink, is PttState.Lingering, is PttState.DropPending -> true
    }
```

Replace `press`, `release` and `settleLink`, and add `settleDrop`:

```kotlin
    /**
     * Section 7: "press then tone then talk", in every mode. The tone is immediate
     * wherever the mic is already live — in VOICE, on any route with no profile conflict,
     * and inside the linger window where the link is still up — and waits for the raise
     * otherwise.
     */
    private fun press(nowMs: Long): List<Action> = when (pttState) {
        is PttState.Lingering, is PttState.DropPending -> {
            pttState = PttState.Talking(linkRaised = true)
            listOf(Action.PlayGrantTone, Action.StartCapture(MicSource.ROUTE_DEFAULT))
        }
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

    private fun release(nowMs: Long): List<Action> = when (val state = pttState) {
        is PttState.Talking -> {
            pttState = if (state.linkRaised) {
                PttState.Lingering(untilMs = nowMs + Constants.VOICE_LINK_LINGER_MS)
            } else {
                PttState.Idle
            }
            emptyList()
        }
        // Released before the mic ever went live: no tone, nothing to capture.
        is PttState.AwaitingLink -> abandonRaise(startCapture = false)
        is PttState.Idle, is PttState.Lingering, is PttState.DropPending -> emptyList()
    }

    /**
     * Fires the PTT deadlines that have come due. Runs after the input, so an input that
     * resolves a deadline (a link arriving at 4.1 s, a release, a press inside the linger)
     * wins over it.
     */
    private fun settleLink(nowMs: Long): List<Action> = when (val state = pttState) {
        is PttState.AwaitingLink ->
            if (nowMs >= state.deadlineMs) abandonRaise() else emptyList()
        is PttState.Lingering ->
            if (nowMs >= state.untilMs) {
                pttState = PttState.DropPending
                settleDrop()
            } else {
                emptyList()
            }
        is PttState.DropPending -> settleDrop()
        is PttState.Idle, is PttState.Talking -> emptyList()
    }

    /**
     * Lets the raised link go. Section 7 exempts the raise/drop from the 10 s rate limit
     * by name — so this neither consults nor stamps [lastSwitchMs] — but not from the
     * "switches never run during receive or transmit" rule in the same bullet, so an
     * expired linger holds the link rather than glitching an incoming transmission. No
     * [Action.DropVoiceLink] when the policy wants VOICE by now: the link stays up as the
     * profile, not as a leftover.
     */
    private fun settleDrop(): List<Action> {
        if (radioActive) return emptyList()
        pttState = PttState.Idle
        val base = baseProfile()
        appliedProfile = base
        return if (base == Profile.VOICE) emptyList() else listOf(Action.DropVoiceLink)
    }
```

In `nextWakeupMs`, replace Task 4's two-line PTT deadline block — `val state = pttState` and the `if (state is PttState.AwaitingLink) …` line — with:

```kotlin
        when (val state = pttState) {
            is PttState.AwaitingLink -> deadlines.add(state.deadlineMs)
            is PttState.Lingering -> deadlines.add(state.untilMs)
            // DropPending waits on the radio going idle, which is an input.
            is PttState.Idle, is PttState.Talking, is PttState.DropPending -> Unit
        }
```

- [ ] **Step 8: Run the Kotlin tests to verify they pass**

Run: `node scripts/build-android.js :app:testDebugUnitTest`

Expected: PASS, 35 `ModePolicyTest` tests.

- [ ] **Step 9: Run the mirror check and the full task gate**

```bash
diff <(grep -o 'assertRow("[^"]*"' ios/Radio/Tests/RadioKitTests/ModePolicyTests.swift) \
     <(grep -o 'assertRow("[^"]*"' android/app/src/test/java/com/oru/radio/ModePolicyTest.kt)
pnpm typecheck && pnpm lint && pnpm test
node scripts/build-android.js :app:testDebugUnitTest
pnpm build:android
(cd ios/Radio && DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild test -scheme RadioKit -destination 'platform=iOS Simulator,name=iPhone 17')
```

Expected: the diff prints nothing; all four gate legs green.

- [ ] **Step 10: Commit**

```bash
git add ios/Radio/Sources/RadioKit/ModePolicy.swift \
        ios/Radio/Tests/RadioKitTests/ModePolicyTests.swift \
        android/app/src/main/java/com/oru/radio/ModePolicy.kt \
        android/app/src/test/java/com/oru/radio/ModePolicyTest.kt
git commit -m "feat(audio): 15s voice-link linger and its idle-gated drop"
```

---

## Task 6: The §9 acceptance-oracle scenarios and the mirror audit

**Files:**
- Modify: `ios/Radio/Tests/RadioKitTests/ModePolicyTests.swift` (3 rows)
- Modify: `android/app/src/test/java/com/oru/radio/ModePolicyTest.kt` (same 3 rows)

**Interfaces:**
- Consumes: everything from Tasks 1–5. No production code changes.
- Produces: nothing new. This task is the composition check and the audit: three long rows taken from §9's behaviour contract, each exercising several mechanisms in one script, plus the final constant and mirror audits.

**Note on TDD here:** unlike Tasks 1–5, these rows are not expected to be red first. Every step in them composes behaviour an earlier task already proved, and a green first run is the evidence that the parts compose. If one *is* red, it has found a composition bug — fix it in `ModePolicy.swift` **and** `ModePolicy.kt` in this task, before committing, and say so in the commit body.

- [ ] **Step 1: Write the Swift scenario rows**

Append to `ModePolicyTests.swift`:

```swift
    // MARK: - §9 behaviour contract, as compositions

    func testSection9MusicThenPttThenMusicStops() {
        // §9 rows: "BT headset connects, no music"; "user starts music"; "incoming voice
        // during music"; "PTT press during music"; "music stops".
        assertRow("section 9 headset connects then music starts then PTT then music stops", [
            Step(0, .routeRequiresVoiceLink(true), .voice, [], .noTimer),
            Step(5_000, .otherAudio(true), .voice, [], .at(7_000)),
            Step(7_000, .tick, .media, [], .noTimer),
            Step(10_000, .radioActive(true), .media, [], .noTimer),
            Step(13_000, .radioActive(false), .media, [], .noTimer),
            Step(20_000, .pttPressed, .voice, [.raiseVoiceLink], .at(24_000)),
            Step(21_500, .voiceLinkEstablished, .voice,
                 [.playGrantTone, .startCapture(.routeDefault)], .noTimer),
            Step(21_500, .radioActive(true), .voice, [], .noTimer),
            Step(25_000, .pttReleased, .voice, [], .at(40_000)),
            Step(25_000, .radioActive(false), .voice, [], .at(40_000)),
            Step(40_000, .tick, .media, [.dropVoiceLink], .noTimer),
            Step(45_000, .otherAudio(false), .media, [], .at(75_000)),
            Step(75_000, .tick, .voice, [], .noTimer),
        ])
    }

    func testSection9HeadsetDiesDuringTheLinger() {
        // §9 row: "Headset battery dies / walks out of range → immediate loudspeaker +
        // phone mic; no error state". The link is not dropped on the way out: with no
        // headset there is no profile conflict, so VOICE is where the policy belongs.
        assertRow("section 9 the headset dies during the linger", [
            Step(0, .routeRequiresVoiceLink(true), .voice, [], .noTimer),
            Step(0, .otherAudio(true), .voice, [], .at(2_000)),
            Step(2_000, .tick, .media, [], .noTimer),
            Step(3_000, .pttPressed, .voice, [.raiseVoiceLink], .at(7_000)),
            Step(3_500, .voiceLinkEstablished, .voice,
                 [.playGrantTone, .startCapture(.routeDefault)], .noTimer),
            Step(5_000, .pttReleased, .voice, [], .at(20_000)),
            Step(8_000, .routeRequiresVoiceLink(false), .voice, [], .at(20_000)),
            Step(20_000, .tick, .voice, [], .noTimer),
        ])
    }

    func testSection9IncomingVoiceDuringMusicNeverSwitches() {
        // §9 row: "Incoming voice during music → voice plays into the A2DP stream; no
        // profile switch".
        assertRow("section 9 incoming voice during other audio never switches the profile", [
            Step(0, .routeRequiresVoiceLink(true), .voice, [], .noTimer),
            Step(0, .otherAudio(true), .voice, [], .at(2_000)),
            Step(2_000, .tick, .media, [], .noTimer),
            Step(3_000, .radioActive(true), .media, [], .noTimer),
            Step(9_000, .radioActive(false), .media, [], .noTimer),
            Step(9_000, .tick, .media, [], .noTimer),
        ])
    }
```

- [ ] **Step 2: Run the Swift tests**

Run: `(cd ios/Radio && DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild test -scheme RadioKit -destination 'platform=iOS Simulator,name=iPhone 17' -only-testing:RadioKitTests/ModePolicyTests)`

Expected: PASS, 38 tests. A failure here is a composition bug: fix `ModePolicy.swift` and mirror the fix into `ModePolicy.kt` in Step 4.

- [ ] **Step 3: Write the mirrored Kotlin scenario rows**

Append to `ModePolicyTest.kt`:

```kotlin
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
```

- [ ] **Step 4: Run the Kotlin tests**

Run: `node scripts/build-android.js :app:testDebugUnitTest`

Expected: PASS, 38 `ModePolicyTest` tests. A failure that Swift did not have means the two implementations have diverged — fix the divergence, do not adjust the row.

- [ ] **Step 5: Run the audits**

Row names, in order, must be identical:

```bash
diff <(grep -o 'assertRow("[^"]*"' ios/Radio/Tests/RadioKitTests/ModePolicyTests.swift) \
     <(grep -o 'assertRow("[^"]*"' android/app/src/test/java/com/oru/radio/ModePolicyTest.kt)
```

Expected: no output. There should be 37 rows on each side (`grep -c` on either file).

The five constants must appear in the same order with the same values:

```bash
diff <(grep -oE '(2_000|30_000|10_000|4_000|15_000)' ios/Radio/Sources/RadioKit/ModePolicy.swift) \
     <(grep -oE '(2_000|30_000|10_000|4_000|15_000)' android/app/src/main/java/com/oru/radio/ModePolicy.kt)
```

Expected: no output.

No I/O leaked into the policy:

```bash
grep -nE 'AVAudio|AudioSession|DispatchQueue|Date\(\)|import (UIKit|AVFoundation)' ios/Radio/Sources/RadioKit/ModePolicy.swift
grep -nE 'android\.|AudioManager|System\.currentTimeMillis|SystemClock|Handler|Log\.' android/app/src/main/java/com/oru/radio/ModePolicy.kt
```

Expected: no output from either. Any hit is either a real I/O leak or an API name that crept into a doc comment; both get fixed here.

Nothing outside the four owned files changed:

```bash
git diff --name-only feature/offline-nearby-ptt...HEAD
```

Expected: exactly the four paths of this plan.

- [ ] **Step 6: Run the full task gate**

```bash
pnpm typecheck && pnpm lint && pnpm test
node scripts/build-android.js :app:testDebugUnitTest
pnpm build:android
(cd ios/Radio && DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild test -scheme RadioKit -destination 'platform=iOS Simulator,name=iPhone 17')
```

Expected: all four green.

- [ ] **Step 7: Commit**

```bash
git add ios/Radio/Tests/RadioKitTests/ModePolicyTests.swift \
        android/app/src/test/java/com/oru/radio/ModePolicyTest.kt
git commit -m "test(audio): section 9 behaviour-contract scenarios for the mode policy"
```

---

## Spec coverage

| Spec requirement | Where |
|---|---|
| D1 two profiles VOICE/MEDIA switched by whether another app plays audio | Tasks 1–3 (`Profile`, dwell, gates) |
| D2 PTT-in-MEDIA raise, grant tone, linger, phone-mic fallback on failure | Tasks 4–5 |
| D4 `audioMode: auto \| voice \| media`, default `auto` | Task 1 (`AudioMode`, `.auto` default); the setting's surface and storage are P2/P3/P4 |
| §7 VOICE → MEDIA after 2 s | Task 2 |
| §7 MEDIA → VOICE after 30 s | Task 2 |
| §7 switch at the next radio-idle moment | Task 3 |
| §7 one switch per 10 s | Task 3 |
| §7 raise → confirmed → tone → capture | Task 4 |
| §7 4 s grant timeout → tone + phone mic | Task 4 |
| §7 15 s linger, instant re-press, drop at expiry | Task 5 |
| §7 raise/drop exempt from the 10 s limit | Task 5 (row "the raise is exempt…") |
| §7 pins, with the raise still applying inside pinned `media` | Tasks 1 and 5 |
| §7 "press → tone → talk" in every mode | Tasks 4–5 |
| §7 policy inert on non-BT-Classic routes | Task 2 |
| §10 "Shared": both platforms assert the same table | Every task's mirror check; Task 6's audit |
| §9 behaviour contract as the oracle | Task 6 (the rows this policy can answer alone) |
