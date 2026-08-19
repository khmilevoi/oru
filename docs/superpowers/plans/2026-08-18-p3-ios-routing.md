# iOS routing (§5) — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the iOS audio-session machinery with §5's design — two static session configurations applied whole and diff-only, a speaker override that is a pure function of the current outputs, six notification observers all reduced onto the `RadioEngine` queue through one pure reaction table, an engine graph that is rebuilt instead of dying on a route change, and the real `audioRoute` / `audioMode` publication through the bridge.

**Architecture:** Every decision §5 makes becomes a pure function over plain values, and every side effect stays behind the `AudioIO` / `BackgroundSession` ports the tests already fake. `AlwaysHotBackgroundManager` stops being a state machine and becomes an *executor*: a notification arrives, it is re-posted onto the engine queue, `AudioSessionReactor.react(to:from:)` answers with the next status and a list of actions, and the manager performs them against `AVAudioSession`. `RadioEngine` owns the merged `ModePolicy` and is the only place inputs (route, other audio, radio activity, PTT, `audioMode`) meet outputs (apply profile, grant tone, start capture) — which is why the whole of §7's wiring is testable with `FakeBackground`, `FakeAudio` and `ManualClock`.

**Tech Stack:** Swift 5.9 / iOS 16, SwiftPM package `ios/Radio` (target `RadioKit`, test target `RadioKitTests`, XCTest); AVFoundation (`AVAudioSession`, `AVAudioEngine`, `AVAudioConverter`); the app-side Turbo Module glue in `ios/Oru` (Swift + Objective-C++, CocoaPods). No new dependencies, no `Package.swift` change, no `Podfile` change: SwiftPM compiles every file under `Sources/RadioKit` and `Tests/RadioKitTests` automatically.

**Spec:** `docs/superpowers/specs/2026-08-18-seamless-headphone-audio-design.md` — §3, §4, §5, §7 (wiring only), §9, §10 (iOS), §11. Schedule: `docs/superpowers/execution/2026-08-18-seamless-headphone-audio.md`, plan **P3 `ios-routing`**, wave 2 track A.

---

## Global Constraints

Every task's requirements implicitly include this section.

### Ownership — what this plan may and may not touch

**May write, all under `ios/`:**

- everything under `ios/Radio/Sources/RadioKit/` **except** `ModePolicy.swift`
- everything under `ios/Radio/Tests/RadioKitTests/` **except** `ModePolicyTests.swift`
- `ios/Oru/RadioBridge.swift` (the iOS bridge glue transferred from P2 to P3 at sync 1)

**Must not touch, under any circumstance:**

- `ios/Radio/Sources/RadioKit/ModePolicy.swift` and `ios/Radio/Tests/RadioKitTests/ModePolicyTests.swift` — merged P1. A needed table or constant change is **reported in the task report, never patched**: a local patch silently forks a contract §10 "Shared" exists to keep identical, and sync 2 cross-checks that this branch did not touch either file.
- anything under `src/`, `specs/`, `__tests__/`, `jest/` — merged P2. This plan changes **no JavaScript at all**; `specs/NativeRadio.ts` already publishes `audioRoute` and `audioMode` and is the contract this plan implements, not a file it edits.
- anything under `android/` — P4 is writing that tree in parallel in the same wave.
- `package.json`, `pnpm-lock.yaml`, `ios/Podfile`, `ios/Podfile.lock`, `ios/Radio/Package.swift`, `ios/Radio/Package.resolved`.

### The task gate

Copied verbatim from the schedule header:

> pnpm typecheck && pnpm lint && pnpm test \<paths\> · when the task touched `android/`, plus `node scripts/build-android.js :app:testDebugUnitTest` and `pnpm build:android` · when the task touched `ios/`, plus `cd ios/Radio && DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild test -scheme RadioKit -destination 'platform=iOS Simulator,name=iPhone 17'`

Every task in this plan touches `ios/` and no task touches `android/` or any JavaScript file, so the gate instantiates to exactly this block for **every** task. Run it from the repository root:

```bash
pnpm typecheck && pnpm lint && pnpm test
(cd ios/Radio && DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild test -scheme RadioKit -destination 'platform=iOS Simulator,name=iPhone 17')
```

`pnpm test` runs with no `<paths>` argument because the path subset is empty — no JS file changes anywhere in this plan. A full jest run is the honest substitute: it takes seconds and it proves the plan broke nothing in JavaScript.

**Known flakes** (copied verbatim from the schedule header): (1) first Gradle / NDK / CMake / dependency downloads are slow and can time out — a download failure or timeout is infrastructure, not a regression; re-run once before reporting. (2) `xcode-select` on this host points at CommandLineTools, so a *bare* `xcodebuild` fails with a tools error — that is environment, not a regression; every xcodebuild carries the `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer` prefix already baked into the gates above. (3) The `Oru` app scheme has no test action ("no test bundles available") — the RadioKit tests run **only** from `ios/Radio`'s own package workspace; the app build and the package tests are two separate commands, never one. (4) The simulator destination `iPhone 17` is the recorded-working one from the 2026-08-13 spike report; if xcodebuild reports the device missing, substitute any available iPhone simulator — device-list drift, not a regression. (5) The first xcodebuild in a fresh worktree resolves SPM packages (google/nearby, alta/swift-opus) — a slow first run or a transient network failure there is infrastructure; re-run once. (6) `pnpm lingui:extract` rewrites two stale source-line references in the `*.po` catalogs — harmless churn; commit it with whatever catalog change triggered it.

### Acceptance beyond the gate

The RadioKit test scheme does **not** compile `ios/Oru/RadioBridge.swift`, and this plan rewrites it. Task 6 and Task 7 therefore additionally run, once, in the worktree:

```bash
(cd ios && pod install)
(cd ios && DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild -workspace Oru.xcworkspace -scheme Oru -destination 'platform=iOS Simulator,name=iPhone 17' build)
```

The worktree is created with `pnpm install` only, so `ios/Pods` does not exist there until `pod install` runs. It only has to run once per worktree; Task 7 may skip it if Task 6 already ran it in the same worktree.

### What §11 deletes, and what stays

**Deleted by this plan** (§11 "iOS deletes"): the two-phase HFP/A2DP detection state machine, the `AudioSessionProfile` profile enum, `setPreferredInput` pinning, the `isApplyingProfile` recursion flag, `AudioSessionProfile.swift` and `AudioSessionProfileTests.swift` as files.

**Kept** (§11 "iOS keeps"): `AlwaysHotBackgroundManager` as the session owner, the always-hot keep-alive tap, heartbeat logging, and `AudioRouteFormatter` — which moves verbatim into `AudioRoute.swift` because its only home is being deleted. `SpikeControlPanel.swift:61` calls `AudioRouteFormatter.compact` and must keep compiling untouched.

### The two session configurations (§5), verbatim

| | VOICE | MEDIA |
|---|---|---|
| Category | `.playAndRecord` | `.playAndRecord` |
| Mode | `.voiceChat` | `.default` |
| Options | `[.allowBluetooth, .mixWithOthers]` | `[.allowBluetoothA2DP, .mixWithOthers]` |

`.mixWithOthers` is mandatory in **both**: it is what lets another app start playing at all, which is also how MEDIA-mode demand is detected. `.defaultToSpeaker` appears in neither — the speaker is an on-demand override, per the hardware-confirmed iOS 17/18 route-collapse regression. `.allowBluetooth` is spelled exactly that way (the spec's word); it is what `.voiceChat` implies anyway, and writing it makes the VOICE configuration self-describing.

### Readings of §5 this plan fixes

Each is a place the spec states a rule but not its mechanics. The reading and its textual basis are recorded here and repeated in the code comment that implements it, so a reviewer can overrule one without archaeology.

1. **The recursion guard becomes a configuration diff.** The old `isApplyingProfile` flag worked because the handler ran synchronously on the notification thread. §5 requires every handler to be re-posted onto the engine queue, so by the time a handler runs the flag would already be clear and the guard would be a lie. The loop is broken instead by making `applyConfiguration` genuinely diff-only: read the session's live category, mode and options; skip the `setCategory` when they already satisfy the target. Our own `setCategory` therefore cannot cause a second one. This *is* §5's "applied whole (diff-only: skip if already applied)".
2. **"Already applied" means category and mode equal and the live options a superset of ours.** iOS adds implied options (`.voiceChat` implies `.allowBluetooth`), so demanding option-set equality would re-apply the configuration on every `.categoryChange` forever. The two configurations always differ in `mode`, so mode equality alone already separates them; the superset check catches an option someone else cleared.
3. **Route classification and the speaker override are two independent rules.** The override asks "are the outputs *solely* `builtInReceiver`" — §5's exact words — and answers `.speaker` or `.none`. The `kind` asks which of §8's four icons to show. An AirPlay or HDMI output is `kind == .speaker` (none of the four names it) but still takes `.none` for the override, because it is not solely the receiver. Keeping the two rules separate is what fixes the wired-headphones bug: the override never consults a classification.
4. **`.carAudio` classifies as `bluetooth`, `.bluetoothLE` requires a voice link.** §8's union has four kinds and §5 lists `.carAudio` among the external outputs without saying which. A car kit is a named hands-free accessory, so `bluetooth` with its `label` is the closest of the four; the label is published either way, so a wrong icon is cosmetic. `.bluetoothLE` is treated as BT-Classic (a voice link must be raised for its mic) because §12 explicitly defers the LE fast path — the conservative path is correct behaviour, only not optimal.
5. **`requiresVoiceLink` is exactly `kind == .bluetooth`.** §7's `setRouteRequiresVoiceLink` means "reaching this accessory's microphone would need a BT-Classic voice link". That is true for precisely the ports classified `bluetooth` and false for speaker, wired and USB — §7's "the policy is inert there". One port set, two uses, no chance of the two drifting.
6. **Interruption recovery ignores `shouldResume`.** Today's code returns without it. §5 says `.ended` re-applies the configuration and re-activates, and adds that `.ended` is not guaranteed at all — which is why app-foreground runs the same recovery. `shouldResume` is advice about resuming *playback*; the always-hot session is this app's lifeline and comes back either way. The option is logged, not obeyed.
7. **App-foreground runs the full recovery only when the session is not known active.** §5 says foregrounding "also runs the same recovery" because `.ended` may never arrive. Running a `setActive` + engine rebuild on every app switch would glitch audio for no reason, so foreground with `isActive == true` does the cheap refresh instead (override, publish, sample other audio).
8. **A rebuild failure is logged, never raised.** §2 goal 3 is "a route change never kills the radio … route errors never escalate to `status: 'error'`". So `rebuildEngine` and the capture-converter rebuild report to `heartbeat.log` and `os_log` and return; the next configuration change, route change or interruption recovery retries. Encoder failures keep raising `audioFailed` — those are not routing.
9. **`MicSource` is informational on iOS.** §7's `startCapture(.phoneFallback)` means "this transmission uses the phone mic". On iOS the applied session configuration already decides which microphone the input node resolves to, and `ModePolicy.abandonRaise` restores the base configuration *before* emitting the capture action. So the engine logs the source and starts capture; there is no second mechanism, and none is wanted — D2 rejects swapping the mic mid-transmission by name.
10. **Capture starts without waiting for the tone to finish.** §7's "press → tone → talk" gates transmission on the tone being *granted*, not on its decay. The tone is scheduled on its own player node and capture starts in the same turn.

### Threading contract

- **`RadioEngine`'s queue is the one queue.** `RadioAssembly` builds it (`com.oru.radio.engine`) and passes it to `RadioEngine`, to `DispatchRadioClock` and — new in this plan — to `AlwaysHotBackgroundManager`.
- **Every `BackgroundSession` method is called from the engine queue** (`activate`, `deactivate`, `requestBeginTransmitting`, `stopTransmitting`, `setReceiving`, `applyProfile`) — verified: each call site is inside a `RadioEngine` `*Locked` method. They must never dispatch synchronously back onto that queue.
- **Every notification handler hops** with `queue.async` before touching manager state. That single rule is what closes the `isActive`/`currentProfile` data race §5 names.
- **`AudioIO` keeps its own queue** (`com.oru.radio.audio`). `rebuildEngine` and `playGrantTone` are `queue.async` and return immediately, so no call chain from the engine queue can block on the audio queue.
- **The tap thread touches nothing but `HeartbeatLogger.noteInputBuffer()` and `queue.async`**, exactly as today.

### Time

`ModePolicy` takes absolute monotonic **milliseconds** (`Int64`). This plan supplies them by extending `RadioClock` with `var nowMs: Int64 { get }`, implemented as `Int64(DispatchTime.now().uptimeNanoseconds / 1_000_000)` in `DispatchRadioClock` and as a settable field in the test `ManualClock`. No wall clock anywhere: a system time change must not move a dwell deadline.

---

## File structure

| File | Status | Responsibility |
|---|---|---|
| `ios/Radio/Sources/RadioKit/AudioRoute.swift` | **new** | `AudioPort` (the one impure boundary), `AudioRoute` (§8's value), `AudioRouteSnapshot` (what the session reports up), `AudioRouteClassifier` (kind / label / requiresVoiceLink / providesVoiceLink), and `AudioRouteFormatter` moved verbatim from the deleted `AudioSessionProfile.swift`. |
| `ios/Radio/Sources/RadioKit/AudioSessionConfiguration.swift` | **new** | The two static configurations, `of(_ profile:)`, the diff-only `matches(...)`, and `speakerOverride(forOutputs:)`. |
| `ios/Radio/Sources/RadioKit/AudioSessionReactor.swift` | **new** | The (event, status) → (status, actions) reaction table: `AudioSessionEvent`, `AudioSessionStatus`, `AudioSessionAction`, `AudioSessionReaction`, `AudioSessionReactor.react`. Pure. |
| `ios/Radio/Sources/RadioKit/CaptureConverterPolicy.swift` | **new** | `needsRebuild(converterInput:incoming:)` — the one decision behind "the converter is rebuilt whenever the input format changes". |
| `ios/Radio/Sources/RadioKit/GrantTone.swift` | **new** | D2's talk-permit tone as pure Int16 PCM, envelope included. |
| `ios/Radio/Sources/RadioKit/AudioModeStore.swift` | **new** | `AudioModeSetting` (§8's `auto`/`voice`/`media`) and its UserDefaults store, on the `PttBindingStore` pattern. |
| `ios/Radio/Sources/RadioKit/RouteSwitchStopwatch.swift` | **new** | §10's device-event → audio-on-new-route measurement, as a pure struct. |
| `ios/Radio/Sources/RadioKit/AudioSessionProfile.swift` | **deleted** | Two-phase detection and the profile enum (§11). The formatter moves to `AudioRoute.swift`. |
| `ios/Radio/Sources/RadioKit/AlwaysHotBackgroundManager.swift` | rewritten | Session owner: six observers, all re-posted onto the engine queue; runs the reaction table; performs actions against `AVAudioSession`; publishes route and other-audio upward. |
| `ios/Radio/Sources/RadioKit/AudioEngine.swift` | modified | Engine rebuild / recreate, capture-converter rebuild, `beginIncoming` without the per-transmission stop/start, grant-tone player. |
| `ios/Radio/Sources/RadioKit/RadioEngine.swift` | modified | Owns `ModePolicy` and `AudioModeStore`; feeds every §7 input; performs every §7 output; maintains `state.audioRoute` / `state.audioMode`. |
| `ios/Radio/Sources/RadioKit/RadioPorts.swift` | modified | `BackgroundSession.applyProfile`, three new delegate callbacks, `AudioIO.rebuildEngine`/`playGrantTone`, `RadioClock.nowMs`. |
| `ios/Radio/Sources/RadioKit/RadioState.swift` | modified | `audioRoute` and `audioMode` on `RadioState`, in `asDictionary`. |
| `ios/Radio/Sources/RadioKit/RadioConfig.swift` | modified | `Audio` grant-tone constants; a new `Session` block (activation retry, defaults key). |
| `ios/Radio/Sources/RadioKit/RadioAssembly.swift` | modified | Passes the engine queue to the manager. |
| `ios/Radio/Sources/RadioKit/HeartbeatLogger.swift` | modified | `onTick` hook (other-audio sampling) and the route-switch stopwatch. |
| `ios/Radio/Sources/RadioKit/SpikeCommandServer.swift` | modified | One clause in the debug `describe` line. |
| `ios/Oru/RadioBridge.swift` | modified | Real `audioRoute` / `audioMode` projection; `setAudioMode` reaches the engine. Deletes P2's two placeholders. |
| `ios/Radio/Tests/RadioKitTests/AudioSessionProfileTests.swift` | **deleted** | Tests of a deleted enum. |
| `ios/Radio/Tests/RadioKitTests/AudioRouteTests.swift` | **new** | Classification, label, voice-link predicates. |
| `ios/Radio/Tests/RadioKitTests/AudioSessionConfigurationTests.swift` | **new** | The configuration table, the diff, the speaker override. |
| `ios/Radio/Tests/RadioKitTests/AudioSessionReactorTests.swift` | **new** | The whole reaction table, row by row. |
| `ios/Radio/Tests/RadioKitTests/CaptureConverterPolicyTests.swift` | **new** | Format-change detection. |
| `ios/Radio/Tests/RadioKitTests/GrantToneTests.swift` | **new** | Tone shape. |
| `ios/Radio/Tests/RadioKitTests/AudioModeStoreTests.swift` | **new** | Persistence round-trip and defaults. |
| `ios/Radio/Tests/RadioKitTests/RouteSwitchStopwatchTests.swift` | **new** | One line per switch, never twice. |
| `ios/Radio/Tests/RadioKitTests/RadioEngineModeTests.swift` | **new** | §7 wiring end to end through the fakes: the (event, state) → actions story for the engine. |
| `ios/Radio/Tests/RadioKitTests/Fakes.swift` | modified | `FakeBackground` and `FakeAudio` grow the new port surface; `ManualClock` grows `nowMs` and `fireEarliest`. |
| `ios/Radio/Tests/RadioKitTests/RadioEngineTests.swift` | modified | Kept green against the new port surface; one new test for the rebuild forwarding. |

The three "policy" files (`AudioRouteClassifier`, `AudioSessionConfiguration`, `AudioSessionReactor`) are separate from the objects that use them on purpose: they are the whole of §10's "every decision is a pure function with unit tests", and a decision that lives inside `AlwaysHotBackgroundManager` cannot be tested without a real `AVAudioSession`.

---

## The interfaces, in full

Everything below is produced by this plan. A task's `Interfaces` block names which parts it consumes and which it produces; this is the single place the names and types are written out.

```swift
// AudioRoute.swift  (Task 1)
public struct AudioPort: Equatable {
    public let type: AVAudioSession.Port
    public let name: String
    public init(type: AVAudioSession.Port, name: String = "")
    public static func ports(from descriptions: [AVAudioSessionPortDescription]) -> [AudioPort]
}

public struct AudioRoute: Equatable {
    public enum Kind: String { case speaker, wired, bluetooth, usb }
    public enum Mode: String { case voice, media }
    public var kind: Kind
    public var label: String?
    public var mode: Mode
    public init(kind: Kind = .speaker, label: String? = nil, mode: Mode = .voice)
    public var asDictionary: [String: Any]
}
extension AudioRoute.Mode { public init(_ profile: ModePolicy.Profile) }

public struct AudioRouteSnapshot: Equatable {
    public let kind: AudioRoute.Kind
    public let label: String?
    public let requiresVoiceLink: Bool
    public let providesVoiceLink: Bool
    public init(kind: AudioRoute.Kind, label: String?, requiresVoiceLink: Bool, providesVoiceLink: Bool)
}

public enum AudioRouteClassifier {
    public static func kind(forOutputs outputs: [AudioPort]) -> AudioRoute.Kind
    public static func label(forOutputs outputs: [AudioPort]) -> String?
    public static func requiresVoiceLink(outputs: [AudioPort]) -> Bool
    public static func providesVoiceLink(inputs: [AudioPort]) -> Bool
    public static func snapshot(outputs: [AudioPort], inputs: [AudioPort]) -> AudioRouteSnapshot
}

public enum AudioRouteFormatter {           // moved verbatim, unchanged
    public static func compact(_ route: AVAudioSessionRouteDescription) -> String
    public static func portTypes(_ ports: [AVAudioSessionPortDescription]) -> String
    public static func name(of reason: AVAudioSession.RouteChangeReason) -> String
}

// AudioSessionConfiguration.swift  (Task 1)
public struct AudioSessionConfiguration: Equatable {
    public let category: AVAudioSession.Category
    public let mode: AVAudioSession.Mode
    public let options: AVAudioSession.CategoryOptions
    public let logName: String
    public static let voice: AudioSessionConfiguration
    public static let media: AudioSessionConfiguration
    public static func of(_ profile: ModePolicy.Profile) -> AudioSessionConfiguration
    public func matches(
        category: AVAudioSession.Category,
        mode: AVAudioSession.Mode,
        options: AVAudioSession.CategoryOptions
    ) -> Bool
    public static func speakerOverride(forOutputs outputs: [AudioPort]) -> AVAudioSession.PortOverride
}

// CaptureConverterPolicy.swift  (Task 2)
public enum CaptureConverterPolicy {
    public static func needsRebuild(converterInput: AVAudioFormat?, incoming: AVAudioFormat) -> Bool
}

// GrantTone.swift  (Task 2)
public enum GrantTone {
    public static func pcm(
        sampleRate: Double = RadioConfig.Audio.sampleRate,
        durationMs: Int = RadioConfig.Audio.grantToneDurationMs,
        frequency: Double = RadioConfig.Audio.grantToneFrequency,
        amplitude: Double = RadioConfig.Audio.grantToneAmplitude
    ) -> Data
}

// AudioSessionReactor.swift  (Task 3)
public enum AudioSessionEvent: Equatable {
    case activationRequested
    case activationSucceeded
    case activationFailed
    case deactivationRequested
    case profileRequested(ModePolicy.Profile)
    case routeChanged(reason: AVAudioSession.RouteChangeReason)
    case engineConfigurationChanged
    case interruptionBegan
    case interruptionEnded
    case appDidBecomeActive
    case mediaServicesWereReset
    case silenceSecondaryAudioHint
}

public struct AudioSessionStatus: Equatable {
    public var isActive: Bool
    public var profile: ModePolicy.Profile
    public init(isActive: Bool = false, profile: ModePolicy.Profile = .voice)
}

public enum AudioSessionAction: Equatable {
    case applyConfiguration(ModePolicy.Profile)
    case activate
    case deactivate
    case maximizeInputGain
    case syncSpeakerOverride
    case publishRoute
    case sampleOtherAudio
    case rebuildEngine
    case recreateEngine
}

public struct AudioSessionReaction: Equatable {
    public let status: AudioSessionStatus
    public let actions: [AudioSessionAction]
}

public enum AudioSessionReactor {
    public static func react(
        to event: AudioSessionEvent,
        from status: AudioSessionStatus
    ) -> AudioSessionReaction
}

// AudioModeStore.swift  (Task 6)
public enum AudioModeSetting: String, Equatable {
    case auto, voice, media
    public var policyMode: ModePolicy.AudioMode
}
public final class AudioModeStore {
    public init(defaults: UserDefaults = .standard)
    public func load() -> AudioModeSetting
    public func save(_ setting: AudioModeSetting)
}

// RouteSwitchStopwatch.swift  (Task 7)
public struct RouteSwitchStopwatch {
    public init()
    public mutating func markRouteChange(reason: String, atMs: Int64)
    public mutating func noteAudio(atMs: Int64) -> String?
}

// RadioPorts.swift — the port surface after this plan
public protocol AudioIO: AnyObject {
    var delegate: AudioIODelegate? { get set }
    func startPlayback() throws
    func stopPlayback()
    func startCapture() throws
    func stopCapture()
    func beginIncoming(peerId: String)
    func enqueue(frame: Data, from peerId: String)
    func endIncoming(peerId: String)
    func rebuildEngine(recreate: Bool)          // new, Task 2
    func playGrantTone()                        // new, Task 2
}

public protocol BackgroundSession: AnyObject {
    var delegate: BackgroundSessionDelegate? { get set }
    func activate()
    func deactivate()
    func requestBeginTransmitting()
    func stopTransmitting()
    func setReceiving(_ receiving: Bool)
    func applyProfile(_ profile: ModePolicy.Profile)     // new, Task 4
}

public protocol BackgroundSessionDelegate: AnyObject {
    func backgroundSessionDidActivateAudio(_ session: BackgroundSession)
    func backgroundSessionDidDeactivateAudio(_ session: BackgroundSession)
    func backgroundSessionDidRequestTransmitStart(_ session: BackgroundSession)
    func backgroundSessionDidRequestTransmitStop(_ session: BackgroundSession)
    func backgroundSession(_ session: BackgroundSession, didFail error: RadioError)
    // new, Task 4:
    func backgroundSession(_ session: BackgroundSession, routeDidChange snapshot: AudioRouteSnapshot)
    func backgroundSession(_ session: BackgroundSession, otherAudioActiveDidChange active: Bool)
    func backgroundSession(_ session: BackgroundSession, didRequestEngineRebuild recreate: Bool)
}

public protocol RadioClock: AnyObject {
    var nowMs: Int64 { get }                    // new, Task 5
    func schedule(after seconds: TimeInterval, _ block: @escaping () -> Void) -> RadioCancellable
}

// RadioEngine — the public surface this plan adds
extension RadioEngine {
    public func setAudioMode(_ setting: AudioModeSetting)   // new, Task 6
}
```

`ModePolicy` (merged P1, read-only here) supplies `Profile`, `AudioMode`, `MicSource`, `Action`, `Decision`, `Constants`, and the input methods `setAudioMode`, `setOtherAudioActive`, `setRadioActive`, `setRouteRequiresVoiceLink`, `pttPressed`, `pttReleased`, `voiceLinkEstablished`, `voiceLinkFailed`, `tick` — each `(…, nowMs: Int64) -> Decision`.

---

## Task 1: The pure route decisions and the two static configurations

Deletes the two-phase detection, the profile enum and `setPreferredInput`; replaces the speaker override with a pure function of the current outputs (the wired-headphones fix); leaves the manager applying the VOICE configuration statically. The observer layer is still the old one — Task 4 replaces it.

**Files:**
- Create: `ios/Radio/Sources/RadioKit/AudioRoute.swift`
- Create: `ios/Radio/Sources/RadioKit/AudioSessionConfiguration.swift`
- Create: `ios/Radio/Tests/RadioKitTests/AudioRouteTests.swift`
- Create: `ios/Radio/Tests/RadioKitTests/AudioSessionConfigurationTests.swift`
- Delete: `ios/Radio/Sources/RadioKit/AudioSessionProfile.swift`
- Delete: `ios/Radio/Tests/RadioKitTests/AudioSessionProfileTests.swift`
- Modify: `ios/Radio/Sources/RadioKit/AlwaysHotBackgroundManager.swift` (lines 20-28, 40-70, 146-275)

**Interfaces:**
- Consumes: `ModePolicy.Profile` (merged P1, read-only).
- Produces: `AudioPort`, `AudioRoute`, `AudioRoute.Kind`, `AudioRoute.Mode`, `AudioRouteSnapshot`, `AudioRouteClassifier`, `AudioRouteFormatter` (moved), `AudioSessionConfiguration` — signatures exactly as in "The interfaces, in full" above.

- [ ] **Step 1: Write the failing test for route classification**

Create `ios/Radio/Tests/RadioKitTests/AudioRouteTests.swift`:

```swift
import AVFoundation
import XCTest
@testable import RadioKit

/// §5 and §8's route decisions, all pure over port types and names.
/// `AVAudioSessionPortDescription` has no public initialiser, which is why
/// every decision here is a function of `[AudioPort]`.
final class AudioRouteTests: XCTestCase {

    private func port(_ type: AVAudioSession.Port, _ name: String = "") -> AudioPort {
        AudioPort(type: type, name: name)
    }

    // MARK: - kind

    func testSpeakerOnlyOutputsAreTheSpeakerKind() {
        XCTAssertEqual(AudioRouteClassifier.kind(forOutputs: [port(.builtInSpeaker)]), .speaker)
        XCTAssertEqual(AudioRouteClassifier.kind(forOutputs: [port(.builtInReceiver)]), .speaker)
        XCTAssertEqual(AudioRouteClassifier.kind(forOutputs: []), .speaker)
    }

    func testWiredHeadphonesAreTheWiredKind() {
        XCTAssertEqual(AudioRouteClassifier.kind(forOutputs: [port(.headphones)]), .wired)
        XCTAssertEqual(AudioRouteClassifier.kind(forOutputs: [port(.lineOut)]), .wired)
    }

    func testUsbAudioIsTheUsbKind() {
        XCTAssertEqual(AudioRouteClassifier.kind(forOutputs: [port(.usbAudio)]), .usb)
    }

    func testEveryBluetoothPortTypeIsTheBluetoothKind() {
        for type in [AVAudioSession.Port.bluetoothA2DP, .bluetoothHFP, .bluetoothLE, .carAudio] {
            XCTAssertEqual(
                AudioRouteClassifier.kind(forOutputs: [port(type)]), .bluetooth,
                "\(type.rawValue) must classify as bluetooth"
            )
        }
    }

    func testBluetoothWinsOverEveryOtherKindInAMixedRoute() {
        // Priority exists so a transient route carrying two outputs never
        // reports the accessory the user is not listening through.
        XCTAssertEqual(
            AudioRouteClassifier.kind(forOutputs: [port(.builtInSpeaker), port(.headphones), port(.bluetoothA2DP)]),
            .bluetooth
        )
        XCTAssertEqual(
            AudioRouteClassifier.kind(forOutputs: [port(.builtInSpeaker), port(.headphones), port(.usbAudio)]),
            .usb
        )
    }

    func testAirPlayAndHdmiFallBackToSpeaker() {
        // §8's union has four kinds and neither of these is one of them; the
        // radio has no special handling for them either.
        XCTAssertEqual(AudioRouteClassifier.kind(forOutputs: [port(.airPlay)]), .speaker)
        XCTAssertEqual(AudioRouteClassifier.kind(forOutputs: [port(.HDMI)]), .speaker)
    }

    // MARK: - label

    func testOnlyBluetoothRoutesCarryALabel() {
        XCTAssertEqual(AudioRouteClassifier.label(forOutputs: [port(.bluetoothA2DP, "AirPods Pro")]), "AirPods Pro")
        XCTAssertNil(AudioRouteClassifier.label(forOutputs: [port(.headphones, "Headphones")]))
        XCTAssertNil(AudioRouteClassifier.label(forOutputs: [port(.usbAudio, "USB-C Dock")]))
        XCTAssertNil(AudioRouteClassifier.label(forOutputs: [port(.builtInSpeaker, "Speaker")]))
    }

    func testAnEmptyBluetoothNameIsAbsentRatherThanEmpty() {
        // §8: "absent rather than empty when a Bluetooth device reports no name".
        XCTAssertNil(AudioRouteClassifier.label(forOutputs: [port(.bluetoothHFP, "")]))
        XCTAssertNil(AudioRouteClassifier.label(forOutputs: [port(.bluetoothHFP, "   ")]))
    }

    // MARK: - voice link predicates

    func testOnlyBluetoothRoutesRequireAVoiceLink() {
        XCTAssertTrue(AudioRouteClassifier.requiresVoiceLink(outputs: [port(.bluetoothA2DP)]))
        XCTAssertTrue(AudioRouteClassifier.requiresVoiceLink(outputs: [port(.bluetoothLE)]))
        XCTAssertFalse(AudioRouteClassifier.requiresVoiceLink(outputs: [port(.headphones)]))
        XCTAssertFalse(AudioRouteClassifier.requiresVoiceLink(outputs: [port(.usbAudio)]))
        XCTAssertFalse(AudioRouteClassifier.requiresVoiceLink(outputs: [port(.builtInSpeaker)]))
        XCTAssertFalse(AudioRouteClassifier.requiresVoiceLink(outputs: []))
    }

    func testAnHfpInputIsWhatProvesTheHeadsetMicIsLive() {
        XCTAssertTrue(AudioRouteClassifier.providesVoiceLink(inputs: [port(.bluetoothHFP)]))
        XCTAssertTrue(AudioRouteClassifier.providesVoiceLink(inputs: [port(.builtInMic), port(.bluetoothHFP)]))
        XCTAssertFalse(AudioRouteClassifier.providesVoiceLink(inputs: [port(.builtInMic)]))
        XCTAssertFalse(AudioRouteClassifier.providesVoiceLink(inputs: [port(.headsetMic)]))
        XCTAssertFalse(AudioRouteClassifier.providesVoiceLink(inputs: []))
    }

    // MARK: - snapshot

    func testTheA2dpSnapshotIsAHeadsetWhoseMicIsNotLiveYet() {
        let snapshot = AudioRouteClassifier.snapshot(
            outputs: [port(.bluetoothA2DP, "AirPods Pro")],
            inputs: [port(.builtInMic, "iPhone Microphone")]
        )
        XCTAssertEqual(
            snapshot,
            AudioRouteSnapshot(
                kind: .bluetooth, label: "AirPods Pro",
                requiresVoiceLink: true, providesVoiceLink: false
            )
        )
    }

    func testTheHfpSnapshotIsAHeadsetWhoseMicIsLive() {
        let snapshot = AudioRouteClassifier.snapshot(
            outputs: [port(.bluetoothHFP, "AirPods Pro")],
            inputs: [port(.bluetoothHFP, "AirPods Pro")]
        )
        XCTAssertEqual(
            snapshot,
            AudioRouteSnapshot(
                kind: .bluetooth, label: "AirPods Pro",
                requiresVoiceLink: true, providesVoiceLink: true
            )
        )
    }

    func testTheWiredSnapshotNeverAsksForAVoiceLink() {
        let snapshot = AudioRouteClassifier.snapshot(
            outputs: [port(.headphones, "Headphones")],
            inputs: [port(.builtInMic, "iPhone Microphone")]
        )
        XCTAssertEqual(
            snapshot,
            AudioRouteSnapshot(
                kind: .wired, label: nil,
                requiresVoiceLink: false, providesVoiceLink: false
            )
        )
    }

    // MARK: - the §8 value

    func testTheRouteDictionaryOmitsAnAbsentLabel() {
        let route = AudioRoute(kind: .speaker, label: nil, mode: .voice)
        XCTAssertEqual(route.asDictionary["kind"] as? String, "speaker")
        XCTAssertEqual(route.asDictionary["mode"] as? String, "voice")
        XCTAssertNil(route.asDictionary["label"])
    }

    func testTheRouteDictionaryCarriesTheLabelWhenThereIsOne() {
        let route = AudioRoute(kind: .bluetooth, label: "AirPods Pro", mode: .media)
        XCTAssertEqual(route.asDictionary["kind"] as? String, "bluetooth")
        XCTAssertEqual(route.asDictionary["label"] as? String, "AirPods Pro")
        XCTAssertEqual(route.asDictionary["mode"] as? String, "media")
    }

    func testTheModeMirrorsThePolicyProfile() {
        XCTAssertEqual(AudioRoute.Mode(ModePolicy.Profile.voice), .voice)
        XCTAssertEqual(AudioRoute.Mode(ModePolicy.Profile.media), .media)
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd ios/Radio && DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild test -scheme RadioKit -destination 'platform=iOS Simulator,name=iPhone 17'`

Expected: FAIL — compile errors, `cannot find 'AudioPort' in scope`, `cannot find 'AudioRouteClassifier' in scope`, `cannot find 'AudioRoute' in scope`.

- [ ] **Step 3: Write `AudioRoute.swift`**

Create `ios/Radio/Sources/RadioKit/AudioRoute.swift`:

```swift
import AVFoundation
import Foundation

/// One port of the current route, reduced to the two things every §5 decision
/// needs. `AVAudioSessionPortDescription` has no public initialiser, so nothing
/// pure can be tested against it: every decision in this file is a function of
/// `[AudioPort]` instead, and `AudioPort.ports(from:)` is the whole impure
/// boundary between AVFoundation and the decisions.
public struct AudioPort: Equatable {
    public let type: AVAudioSession.Port
    public let name: String

    public init(type: AVAudioSession.Port, name: String = "") {
        self.type = type
        self.name = name
    }

    public static func ports(from descriptions: [AVAudioSessionPortDescription]) -> [AudioPort] {
        descriptions.map { AudioPort(type: $0.portType, name: $0.portName) }
    }
}

/// §8's `audioRoute`, as RadioKit's own value. `mode` is the *effective*
/// profile the engine is running, never the user's `audioMode` pin — `auto` is
/// not a profile.
public struct AudioRoute: Equatable {

    public enum Kind: String {
        case speaker
        case wired
        case bluetooth
        case usb
    }

    public enum Mode: String {
        case voice
        case media
    }

    public var kind: Kind
    public var label: String?
    public var mode: Mode

    public init(kind: Kind = .speaker, label: String? = nil, mode: Mode = .voice) {
        self.kind = kind
        self.label = label
        self.mode = mode
    }

    /// `label` is omitted rather than `NSNull` when absent — §8 makes it
    /// optional, and this is the rule `pttButton.name` already follows.
    public var asDictionary: [String: Any] {
        var dictionary: [String: Any] = ["kind": kind.rawValue, "mode": mode.rawValue]
        if let label {
            dictionary["label"] = label
        }
        return dictionary
    }
}

extension AudioRoute.Mode {
    /// The mapping lives here and not on `ModePolicy.Profile`: `ModePolicy` is
    /// merged P1 and this plan never edits it.
    public init(_ profile: ModePolicy.Profile) {
        switch profile {
        case .voice: self = .voice
        case .media: self = .media
        }
    }
}

/// What the session reports up to the engine on every route change: §8's two
/// display fields plus the two §7 predicates. One value, one delegate call, no
/// chance of the four drifting apart.
public struct AudioRouteSnapshot: Equatable {
    public let kind: AudioRoute.Kind
    public let label: String?
    /// §7's `setRouteRequiresVoiceLink`: reaching this accessory's microphone
    /// would need a BT-Classic voice link raised.
    public let requiresVoiceLink: Bool
    /// The headset microphone is live on this route right now — §7's "the
    /// headset mic path is confirmed", which is what releases the grant tone.
    public let providesVoiceLink: Bool

    public init(
        kind: AudioRoute.Kind,
        label: String?,
        requiresVoiceLink: Bool,
        providesVoiceLink: Bool
    ) {
        self.kind = kind
        self.label = label
        self.requiresVoiceLink = requiresVoiceLink
        self.providesVoiceLink = providesVoiceLink
    }
}

/// §5's route decisions. Every one is a pure function of port types and names.
///
/// This deliberately does NOT decide the speaker override — that lives in
/// `AudioSessionConfiguration` and asks a different question ("are the outputs
/// solely the receiver?"). Keeping the two apart is the wired-headphones fix:
/// the override never consults a classification, which is exactly how wired
/// headphones came to be speaker-stomped.
public enum AudioRouteClassifier {

    /// §4: BT Classic cannot carry HFP and A2DP at once, so every one of these
    /// needs a voice link raised to reach its microphone. `.carAudio` is here
    /// because a car kit is a hands-free accessory (see the plan's reading 4);
    /// `.bluetoothLE` is here because §12 defers the LE fast path, and the
    /// conservative path is correct, only not optimal.
    static let bluetoothTypes: Set<AVAudioSession.Port> = [
        .bluetoothA2DP, .bluetoothHFP, .bluetoothLE, .carAudio
    ]
    static let usbTypes: Set<AVAudioSession.Port> = [.usbAudio]
    static let wiredTypes: Set<AVAudioSession.Port> = [.headphones, .lineOut]

    /// Priority: bluetooth > usb > wired > speaker. A route carrying two
    /// outputs (which happens while Bluetooth negotiates) must report the
    /// accessory, not the fallback.
    public static func kind(forOutputs outputs: [AudioPort]) -> AudioRoute.Kind {
        if outputs.contains(where: { bluetoothTypes.contains($0.type) }) { return .bluetooth }
        if outputs.contains(where: { usbTypes.contains($0.type) }) { return .usb }
        if outputs.contains(where: { wiredTypes.contains($0.type) }) { return .wired }
        return .speaker
    }

    /// §8: the accessory's own name, for Bluetooth routes only, absent rather
    /// than empty.
    public static func label(forOutputs outputs: [AudioPort]) -> String? {
        guard let port = outputs.first(where: { bluetoothTypes.contains($0.type) }) else {
            return nil
        }
        let name = port.name.trimmingCharacters(in: .whitespacesAndNewlines)
        return name.isEmpty ? nil : name
    }

    /// §7's predicate, defined as exactly "the route is a Bluetooth one" so the
    /// two can never disagree.
    public static func requiresVoiceLink(outputs: [AudioPort]) -> Bool {
        kind(forOutputs: outputs) == .bluetooth
    }

    /// HFP is the only path to a BT-Classic headset microphone (§4), so an HFP
    /// input is the proof the mic path is live.
    public static func providesVoiceLink(inputs: [AudioPort]) -> Bool {
        inputs.contains { $0.type == .bluetoothHFP }
    }

    public static func snapshot(outputs: [AudioPort], inputs: [AudioPort]) -> AudioRouteSnapshot {
        AudioRouteSnapshot(
            kind: kind(forOutputs: outputs),
            label: label(forOutputs: outputs),
            requiresVoiceLink: requiresVoiceLink(outputs: outputs),
            providesVoiceLink: providesVoiceLink(inputs: inputs)
        )
    }
}

/// Compact, human-readable route strings for heartbeat.log and the spike panel.
/// Moved here unchanged when `AudioSessionProfile.swift` was deleted (§11: "the
/// route formatter stays").
public enum AudioRouteFormatter {

    /// "→ AirPods (HFP) / ← AirPods (HFP)" or "→ Speaker / ← iPhone mic".
    public static func compact(_ route: AVAudioSessionRouteDescription) -> String {
        let outs = route.outputs.map(label(for:)).joined(separator: "+")
        let ins = route.inputs.map(label(for:)).joined(separator: "+")
        return "→ \(outs.isEmpty ? "none" : outs) / ← \(ins.isEmpty ? "none" : ins)"
    }

    /// "in=MicrophoneBuiltIn out=Speaker" — port-type raw values, the stable
    /// vocabulary for grepping heartbeat.log.
    public static func portTypes(_ ports: [AVAudioSessionPortDescription]) -> String {
        ports.isEmpty ? "none" : ports.map(\.portType.rawValue).joined(separator: ",")
    }

    public static func name(of reason: AVAudioSession.RouteChangeReason) -> String {
        switch reason {
        case .unknown: return "unknown"
        case .newDeviceAvailable: return "newDeviceAvailable"
        case .oldDeviceUnavailable: return "oldDeviceUnavailable"
        case .categoryChange: return "categoryChange"
        case .override: return "override"
        case .wakeFromSleep: return "wakeFromSleep"
        case .noSuitableRouteForCategory: return "noSuitableRouteForCategory"
        case .routeConfigurationChange: return "routeConfigurationChange"
        @unknown default: return "reason(\(reason.rawValue))"
        }
    }

    private static func label(for port: AVAudioSessionPortDescription) -> String {
        switch port.portType {
        case .bluetoothHFP: return "\(port.portName) (HFP)"
        case .bluetoothA2DP: return "\(port.portName) (A2DP)"
        case .bluetoothLE: return "\(port.portName) (LE)"
        case .builtInSpeaker: return "Speaker"
        case .builtInReceiver: return "Receiver"
        case .builtInMic: return "iPhone mic"
        default: return port.portName
        }
    }
}
```

- [ ] **Step 4: Run the route tests to verify they pass**

Run: `cd ios/Radio && DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild test -scheme RadioKit -destination 'platform=iOS Simulator,name=iPhone 17' -only-testing:RadioKitTests/AudioRouteTests`

Expected: PASS, every test in `AudioRouteTests`.

- [ ] **Step 5: Write the failing test for the configurations and the override**

Create `ios/Radio/Tests/RadioKitTests/AudioSessionConfigurationTests.swift`:

```swift
import AVFoundation
import XCTest
@testable import RadioKit

/// §5's session-configuration table, its diff-only rule, and the speaker
/// override — the three decisions that replaced the two-phase detection
/// state machine (§11).
final class AudioSessionConfigurationTests: XCTestCase {

    private func port(_ type: AVAudioSession.Port) -> AudioPort {
        AudioPort(type: type)
    }

    // MARK: - The table, verbatim from §5

    func testTheVoiceConfigurationIsPlayAndRecordVoiceChatAllowBluetoothMixWithOthers() {
        XCTAssertEqual(AudioSessionConfiguration.voice.category, .playAndRecord)
        XCTAssertEqual(AudioSessionConfiguration.voice.mode, .voiceChat)
        XCTAssertEqual(AudioSessionConfiguration.voice.options, [.allowBluetooth, .mixWithOthers])
    }

    func testTheMediaConfigurationIsPlayAndRecordDefaultAllowBluetoothA2dpMixWithOthers() {
        XCTAssertEqual(AudioSessionConfiguration.media.category, .playAndRecord)
        XCTAssertEqual(AudioSessionConfiguration.media.mode, .default)
        XCTAssertEqual(AudioSessionConfiguration.media.options, [.allowBluetoothA2DP, .mixWithOthers])
    }

    func testMixWithOthersIsMandatoryInBothProfiles() {
        // §5: it is what lets another app start playing at all — without it a
        // non-mixable player would interrupt and kill the radio session, and
        // MEDIA-mode demand could never be detected.
        XCTAssertTrue(AudioSessionConfiguration.voice.options.contains(.mixWithOthers))
        XCTAssertTrue(AudioSessionConfiguration.media.options.contains(.mixWithOthers))
    }

    func testDefaultToSpeakerIsInNeitherProfile() {
        // The hardware-confirmed iOS 17/18 route-collapse regression: the
        // speaker is an on-demand override, never a category option.
        XCTAssertFalse(AudioSessionConfiguration.voice.options.contains(.defaultToSpeaker))
        XCTAssertFalse(AudioSessionConfiguration.media.options.contains(.defaultToSpeaker))
    }

    func testTheMediaProfileNeverUsesVoiceChat() {
        // §4: `.voiceChat` implicitly enables `.allowBluetooth` (HFP), which
        // would defeat the entire point of the MEDIA profile.
        XCTAssertNotEqual(AudioSessionConfiguration.media.mode, .voiceChat)
    }

    func testEachPolicyProfileMapsToItsConfiguration() {
        XCTAssertEqual(AudioSessionConfiguration.of(.voice), AudioSessionConfiguration.voice)
        XCTAssertEqual(AudioSessionConfiguration.of(.media), AudioSessionConfiguration.media)
    }

    func testLogNamesAreTheStableGrepVocabulary() {
        XCTAssertEqual(AudioSessionConfiguration.voice.logName, "voice")
        XCTAssertEqual(AudioSessionConfiguration.media.logName, "media")
    }

    // MARK: - Diff-only

    func testAConfigurationAlreadyInForceIsNotReapplied() {
        XCTAssertTrue(
            AudioSessionConfiguration.voice.matches(
                category: .playAndRecord, mode: .voiceChat,
                options: [.allowBluetooth, .mixWithOthers]
            )
        )
    }

    func testImpliedExtraOptionsStillCountAsApplied() {
        // `.voiceChat` implies `.allowBluetooth`, and iOS reports options we
        // never asked for. Demanding equality would re-apply the category on
        // every single `.categoryChange`, forever.
        XCTAssertTrue(
            AudioSessionConfiguration.voice.matches(
                category: .playAndRecord, mode: .voiceChat,
                options: [.allowBluetooth, .allowBluetoothA2DP, .mixWithOthers]
            )
        )
    }

    func testAMissingOptionMeansTheConfigurationMustBeApplied() {
        XCTAssertFalse(
            AudioSessionConfiguration.voice.matches(
                category: .playAndRecord, mode: .voiceChat, options: [.allowBluetooth]
            )
        )
    }

    func testTheOtherProfilesModeNeverCountsAsApplied() {
        // This is what makes a VOICE ↔ MEDIA switch actually happen: the two
        // configurations always differ in `mode`.
        XCTAssertFalse(
            AudioSessionConfiguration.media.matches(
                category: .playAndRecord, mode: .voiceChat,
                options: [.allowBluetooth, .allowBluetoothA2DP, .mixWithOthers]
            )
        )
        XCTAssertFalse(
            AudioSessionConfiguration.voice.matches(
                category: .playAndRecord, mode: .default,
                options: [.allowBluetooth, .allowBluetoothA2DP, .mixWithOthers]
            )
        )
    }

    func testAForeignCategoryMeansTheConfigurationMustBeApplied() {
        XCTAssertFalse(
            AudioSessionConfiguration.voice.matches(
                category: .playback, mode: .voiceChat,
                options: [.allowBluetooth, .mixWithOthers]
            )
        )
    }

    // MARK: - The speaker override (the wired-headphones fix)

    func testOnlyAReceiverOnlyRouteIsOverriddenToTheSpeaker() {
        XCTAssertEqual(
            AudioSessionConfiguration.speakerOverride(forOutputs: [port(.builtInReceiver)]),
            .speaker
        )
    }

    func testWiredHeadphonesKeepTheAudioTheyUsedToLose() {
        // The bug this whole plan exists for: wired headphones were classified
        // `.builtIn` and then force-overridden to the loudspeaker.
        XCTAssertEqual(
            AudioSessionConfiguration.speakerOverride(forOutputs: [port(.headphones)]),
            AVAudioSession.PortOverride.none
        )
    }

    func testEveryExternalOutputClearsTheOverride() {
        for type in [
            AVAudioSession.Port.headphones, .bluetoothHFP, .bluetoothA2DP,
            .bluetoothLE, .usbAudio, .carAudio, .airPlay, .HDMI, .lineOut
        ] {
            XCTAssertEqual(
                AudioSessionConfiguration.speakerOverride(forOutputs: [port(type)]),
                AVAudioSession.PortOverride.none,
                "\(type.rawValue) is external and must never be speaker-stomped"
            )
        }
    }

    func testAnExternalOutputAlongsideTheReceiverStillClearsTheOverride() {
        XCTAssertEqual(
            AudioSessionConfiguration.speakerOverride(
                forOutputs: [port(.builtInReceiver), port(.bluetoothA2DP)]
            ),
            AVAudioSession.PortOverride.none
        )
    }

    func testTheSpeakerItselfNeedsNoOverride() {
        XCTAssertEqual(
            AudioSessionConfiguration.speakerOverride(forOutputs: [port(.builtInSpeaker)]),
            AVAudioSession.PortOverride.none
        )
    }

    func testAnEmptyRouteNeedsNoOverride() {
        XCTAssertEqual(
            AudioSessionConfiguration.speakerOverride(forOutputs: []),
            AVAudioSession.PortOverride.none
        )
    }
}
```

- [ ] **Step 6: Run it to verify it fails**

Run: `cd ios/Radio && DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild test -scheme RadioKit -destination 'platform=iOS Simulator,name=iPhone 17' -only-testing:RadioKitTests/AudioSessionConfigurationTests`

Expected: FAIL — `cannot find 'AudioSessionConfiguration' in scope`.

- [ ] **Step 7: Write `AudioSessionConfiguration.swift`**

Create `ios/Radio/Sources/RadioKit/AudioSessionConfiguration.swift`:

```swift
import AVFoundation
import Foundation

/// §5's two static session configurations, applied whole and diff-only.
///
/// This replaces the two-phase HFP/A2DP detection state machine (§11). That
/// machine existed because the old design had to *discover* which Bluetooth
/// profile to narrow to; this design never narrows. It states the two option
/// sets up front and lets iOS route — "iOS routing is last-in wins and
/// automatic once category options are right" (§4). There is nothing left to
/// detect, so there is no detection.
public struct AudioSessionConfiguration: Equatable {

    public let category: AVAudioSession.Category
    public let mode: AVAudioSession.Mode
    public let options: AVAudioSession.CategoryOptions
    /// Stable short name for heartbeat.log grepping.
    public let logName: String

    /// The BT headset's microphone is ready: HFP both directions, system-picked.
    public static let voice = AudioSessionConfiguration(
        category: .playAndRecord,
        mode: .voiceChat,
        options: [.allowBluetooth, .mixWithOthers],
        logName: "voice"
    )

    /// The headset stays on A2DP: high-quality playback out, built-in mic in.
    /// `.voiceChat` is deliberately absent — §4: it implicitly enables
    /// `.allowBluetooth` (HFP), which is exactly what this profile must not do.
    public static let media = AudioSessionConfiguration(
        category: .playAndRecord,
        mode: .default,
        options: [.allowBluetoothA2DP, .mixWithOthers],
        logName: "media"
    )

    public static func of(_ profile: ModePolicy.Profile) -> AudioSessionConfiguration {
        switch profile {
        case .voice: return voice
        case .media: return media
        }
    }

    /// §5's "diff-only: skip if already applied", and the replacement for the
    /// deleted `isApplyingProfile` recursion guard.
    ///
    /// Every handler is re-posted onto the engine queue now, so a flag set
    /// around a `setCategory` call would already be clear by the time the
    /// notification it caused is processed — the flag would be a lie. This
    /// comparison breaks the loop instead: after our own apply, the live
    /// configuration satisfies the target, so the `.categoryChange` it emits
    /// re-applies nothing.
    ///
    /// Options are compared with a superset test, not equality: iOS adds
    /// implied options (`.voiceChat` implies `.allowBluetooth`) and demanding
    /// equality would re-apply forever. The two configurations always differ in
    /// `mode`, so mode equality alone already separates them; the superset test
    /// is there to catch an option somebody else cleared.
    public func matches(
        category: AVAudioSession.Category,
        mode: AVAudioSession.Mode,
        options: AVAudioSession.CategoryOptions
    ) -> Bool {
        category == self.category
            && mode == self.mode
            && options.isSuperset(of: self.options)
    }

    /// §5's on-demand speaker, and the wired-headphones fix.
    ///
    /// The rule is a pure function of the CURRENT OUTPUTS and nothing else:
    /// `.speaker` only when the outputs are solely `builtInReceiver`, `.none`
    /// whenever any other output is present. It deliberately does not consult
    /// `AudioRouteClassifier` — the old code decided the override from a
    /// collapsed classification, which is precisely how wired headphones came
    /// to be overridden to the loudspeaker.
    public static func speakerOverride(
        forOutputs outputs: [AudioPort]
    ) -> AVAudioSession.PortOverride {
        guard !outputs.isEmpty else { return .none }
        return outputs.allSatisfy { $0.type == .builtInReceiver } ? .speaker : .none
    }
}
```

- [ ] **Step 8: Run the configuration tests to verify they pass**

Run: `cd ios/Radio && DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild test -scheme RadioKit -destination 'platform=iOS Simulator,name=iPhone 17' -only-testing:RadioKitTests/AudioSessionConfigurationTests`

Expected: PASS, every test in `AudioSessionConfigurationTests`.

- [ ] **Step 9: Delete the profile enum and its tests**

```bash
rm ios/Radio/Sources/RadioKit/AudioSessionProfile.swift
rm ios/Radio/Tests/RadioKitTests/AudioSessionProfileTests.swift
```

The build now fails in `AlwaysHotBackgroundManager.swift` only — that is the next step. `SpikeControlPanel.swift:61` keeps compiling because `AudioRouteFormatter` moved into `AudioRoute.swift` in the same module.

- [ ] **Step 10: Cut the two-phase detection out of `AlwaysHotBackgroundManager`**

In `ios/Radio/Sources/RadioKit/AlwaysHotBackgroundManager.swift`:

Replace the three state fields (lines 20-28) with:

```swift
    private var isActive = false
    /// The configuration currently in force. §5's mode switches are a re-apply
    /// of the other one; the merged §7 policy is what asks for a change (wired
    /// in Task 5). Until then activation applies VOICE and nothing changes it.
    private var appliedProfile: ModePolicy.Profile = .voice
```

Replace `activate()` (lines 40-70) with:

```swift
    public func activate() {
        let session = AVAudioSession.sharedInstance()
        do {
            // Category first, then active — activating under the platform
            // default category leaves AVAudioEngine with no real input/output
            // route once the category does switch (the crash documented in
            // AudioEngine.prepareEngineOnMainThread). There is no detection
            // phase any more (§11): the configuration is stated, not discovered.
            try apply(AudioSessionConfiguration.of(appliedProfile), to: session)
            try session.setActive(true)
        } catch {
            delegate?.backgroundSession(
                self,
                didFail: .backgroundFailed("always-hot activation: \(error)")
            )
            return
        }

        isActive = true
        maximizeInputGain(session)
        syncSpeakerOverride(on: session)
        observeInterruptions()
        observeRouteChanges()
        HeartbeatLogger.shared.sessionActive = true
        HeartbeatLogger.shared.start()
        log.info("always-hot audio session active")
        // The port's activation callback. Harmless at this point (nothing is
        // awaiting the session yet), delivered because the contract says the
        // engine learns about activation from here and nowhere else.
        delegate?.backgroundSessionDidActivateAudio(self)
    }
```

In `deactivate()`, replace `currentProfile = nil` with `appliedProfile = .voice`.

Replace the whole `// MARK: - Session profile` section (`detectAndApplyProfile`, `finishProfile`, `syncSpeakerOverride(for:on:)`, lines 146-230) with:

```swift
    // MARK: - Session configuration (§5)

    /// §5's "applied whole (diff-only: skip if already applied)". The diff is
    /// what replaced the `isApplyingProfile` recursion guard: our own
    /// `setCategory` emits a `.categoryChange`, and re-applying on that would
    /// loop — but after the apply the live configuration already satisfies the
    /// target, so nothing is applied a second time.
    private func apply(
        _ configuration: AudioSessionConfiguration,
        to session: AVAudioSession
    ) throws {
        guard
            !configuration.matches(
                category: session.category,
                mode: session.mode,
                options: session.categoryOptions
            )
        else {
            return
        }
        try session.setCategory(
            configuration.category,
            mode: configuration.mode,
            options: configuration.options
        )
        HeartbeatLogger.shared.record("session config \(configuration.logName)")
    }

    /// §5's on-demand speaker: `.speaker` only when the outputs are solely the
    /// built-in receiver, `.none` the moment any external output is present.
    /// Failure is logged, not fatal — audio still flows out of the receiver.
    private func syncSpeakerOverride(on session: AVAudioSession) {
        let route = session.currentRoute
        let override = AudioSessionConfiguration.speakerOverride(
            forOutputs: AudioPort.ports(from: route.outputs)
        )
        do {
            try session.overrideOutputAudioPort(override)
        } catch {
            HeartbeatLogger.shared.record("speaker override FAILED: \(error)")
        }
    }
```

Replace `handleRouteChange` (lines 243-275) with:

```swift
    /// Every change lands in heartbeat.log; a device appearing or disappearing
    /// recomputes the speaker override, which is all the routing §5 asks for on
    /// iOS — "iOS routing is last-in wins and automatic once category options
    /// are right" (§4), so nothing here chases devices. Publishing the route,
    /// feeding the §7 policy and re-applying our configuration on a foreign
    /// `.categoryChange` arrive with the reaction table (Task 4).
    @objc private func handleRouteChange(_ notification: Notification) {
        let session = AVAudioSession.sharedInstance()
        let route = session.currentRoute
        let reasonRaw = notification.userInfo?[AVAudioSessionRouteChangeReasonKey]
            as? UInt ?? 0
        let reason = AVAudioSession.RouteChangeReason(rawValue: reasonRaw) ?? .unknown
        HeartbeatLogger.shared.record(
            "route: reason=\(AudioRouteFormatter.name(of: reason)) "
                + "in=\(AudioRouteFormatter.portTypes(route.inputs)) "
                + "out=\(AudioRouteFormatter.portTypes(route.outputs))"
        )

        guard reason == .oldDeviceUnavailable || reason == .newDeviceAvailable else {
            return
        }
        guard isActive else { return }
        syncSpeakerOverride(on: session)
    }
```

Nothing else in the file changes. `setPreferredInput` now appears nowhere in the repository — confirm with `grep -rn setPreferredInput ios/Radio ios/Oru`, which must print nothing.

- [ ] **Step 11: Run the whole gate**

```bash
pnpm typecheck && pnpm lint && pnpm test
(cd ios/Radio && DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild test -scheme RadioKit -destination 'platform=iOS Simulator,name=iPhone 17')
```

Expected: PASS. `AudioSessionProfileTests` is gone; `AudioRouteTests` and `AudioSessionConfigurationTests` are green; `RadioEngineTests` is untouched and still green.

- [ ] **Step 12: Commit**

```bash
git add ios/Radio/Sources/RadioKit/AudioRoute.swift \
        ios/Radio/Sources/RadioKit/AudioSessionConfiguration.swift \
        ios/Radio/Sources/RadioKit/AudioSessionProfile.swift \
        ios/Radio/Sources/RadioKit/AlwaysHotBackgroundManager.swift \
        ios/Radio/Tests/RadioKitTests/AudioRouteTests.swift \
        ios/Radio/Tests/RadioKitTests/AudioSessionConfigurationTests.swift \
        ios/Radio/Tests/RadioKitTests/AudioSessionProfileTests.swift
git commit -m "feat(ios-audio): state the two session configurations instead of detecting a profile

Deletes the two-phase HFP/A2DP detection, the AudioSessionProfile enum and
setPreferredInput pinning (spec section 11). The speaker override becomes a
pure function of the current outputs, which is the wired-headphones fix."
```

---

## Task 2: The engine survives a route change

Gives `AudioIO` the two rebuild entry points §5 needs, rebuilds the capture converter whenever the input format moves, stops `beginIncoming` from stop/starting the engine per transmission, and adds D2's grant tone. Nothing calls the new methods yet — Task 4 wires the rebuilds and Task 5 the tone.

**Files:**
- Create: `ios/Radio/Sources/RadioKit/CaptureConverterPolicy.swift`
- Create: `ios/Radio/Sources/RadioKit/GrantTone.swift`
- Create: `ios/Radio/Tests/RadioKitTests/CaptureConverterPolicyTests.swift`
- Create: `ios/Radio/Tests/RadioKitTests/GrantToneTests.swift`
- Modify: `ios/Radio/Sources/RadioKit/RadioConfig.swift` (the `Audio` block)
- Modify: `ios/Radio/Sources/RadioKit/RadioPorts.swift` (`AudioIO`)
- Modify: `ios/Radio/Sources/RadioKit/AudioEngine.swift`
- Modify: `ios/Radio/Tests/RadioKitTests/Fakes.swift` (`FakeAudio`)

**Interfaces:**
- Consumes: `OpusFormat.pcm`, `OpusFormat.buffer(from:)`, `RadioConfig.Audio.sampleRate` (existing).
- Produces: `CaptureConverterPolicy.needsRebuild(converterInput:incoming:)`, `GrantTone.pcm(sampleRate:durationMs:frequency:amplitude:)`, `AudioIO.rebuildEngine(recreate: Bool)`, `AudioIO.playGrantTone()`, `RadioConfig.Audio.grantToneFrequency` / `.grantToneDurationMs` / `.grantToneAmplitude`, and on `FakeAudio` the counters `rebuilds: [Bool]` and `grantTones: Int`.

- [ ] **Step 1: Write the failing tests for the two new pure decisions**

Create `ios/Radio/Tests/RadioKitTests/CaptureConverterPolicyTests.swift`:

```swift
import AVFoundation
import XCTest
@testable import RadioKit

/// §5: "the capture converter is rebuilt whenever the input format changes".
/// This is that "whenever", as a pure predicate — the built-in mic runs at
/// 48 kHz and an HFP headset at 8 or 16 kHz, so a route change mid-transmission
/// moves the format under a converter that was built once per transmission.
final class CaptureConverterPolicyTests: XCTestCase {

    private func format(_ sampleRate: Double, channels: AVAudioChannelCount = 1) -> AVAudioFormat {
        AVAudioFormat(
            commonFormat: .pcmFormatFloat32,
            sampleRate: sampleRate,
            channels: channels,
            interleaved: false
        )!
    }

    func testNoConverterAlwaysNeedsABuild() {
        XCTAssertTrue(
            CaptureConverterPolicy.needsRebuild(converterInput: nil, incoming: format(48_000))
        )
    }

    func testTheSameFormatNeedsNothing() {
        XCTAssertFalse(
            CaptureConverterPolicy.needsRebuild(
                converterInput: format(48_000), incoming: format(48_000)
            )
        )
    }

    func testTheBuiltInMicDroppingToHfpNeedsARebuild() {
        // 48 kHz built-in → 16 kHz mSBC: the exact transition that used to
        // raise `audioFailed` mid-transmission.
        XCTAssertTrue(
            CaptureConverterPolicy.needsRebuild(
                converterInput: format(48_000), incoming: format(16_000)
            )
        )
    }

    func testHfpComingBackUpToTheBuiltInMicNeedsARebuild() {
        XCTAssertTrue(
            CaptureConverterPolicy.needsRebuild(
                converterInput: format(8_000), incoming: format(48_000)
            )
        )
    }

    func testAChannelCountChangeNeedsARebuild() {
        XCTAssertTrue(
            CaptureConverterPolicy.needsRebuild(
                converterInput: format(48_000, channels: 1),
                incoming: format(48_000, channels: 2)
            )
        )
    }

    func testASampleFormatChangeNeedsARebuild() {
        let int16 = AVAudioFormat(
            commonFormat: .pcmFormatInt16, sampleRate: 48_000, channels: 1, interleaved: true
        )!
        XCTAssertTrue(
            CaptureConverterPolicy.needsRebuild(converterInput: format(48_000), incoming: int16)
        )
    }
}
```

Create `ios/Radio/Tests/RadioKitTests/GrantToneTests.swift`:

```swift
import AVFoundation
import XCTest
@testable import RadioKit

/// D2's talk-permit tone. Synthesised rather than shipped as an asset: the
/// RadioKit package deliberately has no `resources:` (see Package.swift), and a
/// sine with an envelope is fewer moving parts than a bundle lookup.
final class GrantToneTests: XCTestCase {

    func testTheToneIsExactlyAsLongAsItIsConfiguredToBe() {
        let pcm = GrantTone.pcm(sampleRate: 16_000, durationMs: 120)
        // 16 000 Hz * 0.120 s = 1 920 frames of Int16.
        XCTAssertEqual(pcm.count, 1_920 * MemoryLayout<Int16>.size)
    }

    func testTheDefaultToneUsesTheRadioSampleRateAndConfiguredDuration() {
        let frames = Int(
            RadioConfig.Audio.sampleRate * Double(RadioConfig.Audio.grantToneDurationMs) / 1_000
        )
        XCTAssertEqual(GrantTone.pcm().count, frames * MemoryLayout<Int16>.size)
    }

    func testTheToneStartsAndEndsAtSilenceSoItDoesNotClick() {
        let samples = Self.samples(GrantTone.pcm(sampleRate: 16_000, durationMs: 120))
        XCTAssertEqual(samples.first, 0)
        XCTAssertEqual(samples.last, 0)
    }

    func testTheToneIsAudibleInTheMiddle() {
        let samples = Self.samples(GrantTone.pcm(sampleRate: 16_000, durationMs: 120))
        let peak = samples.map { abs(Int($0)) }.max() ?? 0
        XCTAssertGreaterThan(peak, Int(Double(Int16.max) * 0.2))
    }

    func testTheToneNeverClips() {
        let samples = Self.samples(
            GrantTone.pcm(sampleRate: 16_000, durationMs: 120, amplitude: 1.0)
        )
        XCTAssertLessThanOrEqual(samples.map { abs(Int($0)) }.max() ?? 0, Int(Int16.max))
    }

    func testTheToneIsDeterministic() {
        XCTAssertEqual(
            GrantTone.pcm(sampleRate: 16_000, durationMs: 40),
            GrantTone.pcm(sampleRate: 16_000, durationMs: 40)
        )
    }

    func testAZeroLengthToneIsEmptyRatherThanACrash() {
        XCTAssertTrue(GrantTone.pcm(sampleRate: 16_000, durationMs: 0).isEmpty)
    }

    func testTheToneFitsTheEnginesOnlyPcmFormat() {
        // The tone is scheduled on a player node connected with OpusFormat.pcm,
        // so it must be convertible by the same helper the decoder uses.
        XCTAssertNotNil(OpusFormat.buffer(from: GrantTone.pcm()))
    }

    private static func samples(_ data: Data) -> [Int16] {
        data.withUnsafeBytes { Array($0.bindMemory(to: Int16.self)) }
    }
}
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd ios/Radio && DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild test -scheme RadioKit -destination 'platform=iOS Simulator,name=iPhone 17' -only-testing:RadioKitTests/CaptureConverterPolicyTests -only-testing:RadioKitTests/GrantToneTests`

Expected: FAIL — `cannot find 'CaptureConverterPolicy' in scope`, `cannot find 'GrantTone' in scope`, `type 'RadioConfig.Audio' has no member 'grantToneDurationMs'`.

- [ ] **Step 3: Add the grant-tone constants**

In `ios/Radio/Sources/RadioKit/RadioConfig.swift`, at the end of the `Audio` block (after `idleMeterSeconds`):

```swift
        /// D2's talk-permit tone: "press → tone → talk", in every mode. 1 kHz
        /// is the LMR convention and sits in the middle of what an 8 kHz HFP
        /// link reproduces, so the tone survives the narrowest route the radio
        /// ever uses.
        public static let grantToneFrequency: Double = 1_000
        public static let grantToneDurationMs: Int = 120
        /// Well below full scale: the tone plays into whatever the user is
        /// wearing, at whatever volume they chose for voice.
        public static let grantToneAmplitude: Double = 0.35
```

- [ ] **Step 4: Write `CaptureConverterPolicy.swift`**

Create `ios/Radio/Sources/RadioKit/CaptureConverterPolicy.swift`:

```swift
import AVFoundation
import Foundation

/// §5: "the capture converter is rebuilt whenever the input format changes
/// (detected via the engine configuration change or a format mismatch in the
/// tap); a mid-transmission change re-routes with a short glitch instead of
/// raising `audioFailed`."
///
/// This is that predicate. It compares only what an `AVAudioConverter` is
/// actually built from — sample rate, channel count, sample format — because
/// `AVAudioFormat`'s own equality also compares layout and interleaving, and a
/// hardware format that reports the same audio differently is not a reason to
/// throw the converter away mid-transmission.
public enum CaptureConverterPolicy {

    public static func needsRebuild(
        converterInput: AVAudioFormat?,
        incoming: AVAudioFormat
    ) -> Bool {
        guard let converterInput else { return true }
        return converterInput.sampleRate != incoming.sampleRate
            || converterInput.channelCount != incoming.channelCount
            || converterInput.commonFormat != incoming.commonFormat
    }
}
```

- [ ] **Step 5: Write `GrantTone.swift`**

Create `ios/Radio/Sources/RadioKit/GrantTone.swift`:

```swift
import Foundation

/// D2's talk-permit tone, as 16-bit little-endian mono PCM at the radio's own
/// sample rate — the format `OpusFormat.pcm` describes and every player node in
/// `AudioEngine` is connected with.
///
/// Synthesised rather than shipped as an asset: `Package.swift` deliberately
/// declares no `resources:`, and a sine with an envelope has fewer moving parts
/// than a bundle lookup that can fail at runtime. Pure, so the shape is a unit
/// test rather than a listening test.
public enum GrantTone {

    /// How long the rise and the fall take. A hard start or stop on a 1 kHz
    /// sine is an audible click on every headset, and the click is louder than
    /// the tone.
    private static let fadeSeconds = 0.005

    public static func pcm(
        sampleRate: Double = RadioConfig.Audio.sampleRate,
        durationMs: Int = RadioConfig.Audio.grantToneDurationMs,
        frequency: Double = RadioConfig.Audio.grantToneFrequency,
        amplitude: Double = RadioConfig.Audio.grantToneAmplitude
    ) -> Data {
        let frames = Int(sampleRate * Double(durationMs) / 1_000)
        guard frames > 0, sampleRate > 0 else { return Data() }

        let fade = max(1, Int(sampleRate * fadeSeconds))
        let peak = Double(Int16.max)
        var samples = [Int16]()
        samples.reserveCapacity(frames)

        for index in 0..<frames {
            let phase = 2 * Double.pi * frequency * Double(index) / sampleRate
            var envelope = 1.0
            if index < fade {
                envelope = Double(index) / Double(fade)
            }
            let remaining = frames - 1 - index
            if remaining < fade {
                envelope = min(envelope, Double(remaining) / Double(fade))
            }
            let value = sin(phase) * amplitude * envelope * peak
            samples.append(Int16(max(-peak, min(peak, value.rounded()))))
        }

        return samples.withUnsafeBufferPointer { Data(buffer: $0) }
    }
}
```

- [ ] **Step 6: Run the two pure test classes to verify they pass**

Run: `cd ios/Radio && DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild test -scheme RadioKit -destination 'platform=iOS Simulator,name=iPhone 17' -only-testing:RadioKitTests/CaptureConverterPolicyTests -only-testing:RadioKitTests/GrantToneTests`

Expected: PASS, every test in both classes.

- [ ] **Step 7: Extend the `AudioIO` port**

In `ios/Radio/Sources/RadioKit/RadioPorts.swift`, inside `protocol AudioIO`, after `endIncoming(peerId:)`:

```swift
    /// §5's `AVAudioEngineConfigurationChange` rebuild: stop, disconnect the
    /// nodes, re-query every format from the hardware, reconnect, restart,
    /// reinstall the tap that was on the input. Formats are never cached across
    /// it. `recreate` additionally throws the `AVAudioEngine` itself away and
    /// builds a new one — Apple QA1749's answer to `mediaServicesWereReset`.
    ///
    /// Returns immediately: the work happens on the implementation's own queue,
    /// so no call chain from the engine queue can block on it. A failure is
    /// logged and never raised — §2 goal 3: a route change must not become
    /// `status: 'error'`.
    func rebuildEngine(recreate: Bool)

    /// D2's talk-permit tone. Scheduled, not awaited: §7 gates transmission on
    /// the tone being granted, not on its decay.
    func playGrantTone()
```

- [ ] **Step 8: Teach `FakeAudio` the new surface**

In `ios/Radio/Tests/RadioKitTests/Fakes.swift`, inside `final class FakeAudio`, after `endIncoming`:

```swift
    /// One entry per rebuild request, `true` when the whole AVAudioEngine was
    /// to be thrown away.
    private(set) var rebuilds: [Bool] = []
    private(set) var grantTones = 0

    func rebuildEngine(recreate: Bool) {
        rebuilds.append(recreate)
    }

    func playGrantTone() {
        grantTones += 1
    }
```

- [ ] **Step 9: Rewrite the capture path in `AudioEngine`**

In `ios/Radio/Sources/RadioKit/AudioEngine.swift`:

Change the engine and tone-player storage (line 31 and the field block around it) to:

```swift
    /// `var`, not `let`: `mediaServicesWereReset` requires disposing every
    /// audio object and building new ones (QA1749). A node cannot move between
    /// engines, so `tonePlayer` is replaced with it.
    private var engine = AVAudioEngine()
    private var tonePlayer = AVAudioPlayerNode()
    private var isTonePlayerAttached = false
    /// True between `startPlayback()` and `stopPlayback()`. A rebuild request
    /// that arrives before the first `startPlayback()` must do nothing: the
    /// record permission may still be undetermined, and starting the engine
    /// then is the documented `inputNode != nullptr` crash.
    private var isPlaybackStarted = false
```

In `startPlayback()`, after `try queue.sync { try installKeepAliveTapLocked() }`, add `queue.sync { isPlaybackStarted = true }`.
In `stopPlayback()`, inside the existing `queue.sync` block, add `isPlaybackStarted = false` as the first line.

Replace `startCapture()` (lines 280-325) with a version that delegates the tap to a reusable method:

```swift
    public func startCapture() throws {
        try queue.sync {
            guard !isCapturing else { return }
            encoder = try makeEncoder()
            txMeter = LevelMeter(
                label: "tx",
                interval: RadioConfig.Audio.txMeterSeconds
            )
            // AVAudioEngine allows one tap per bus: the always-hot keep-alive
            // tap yields to the real capture tap for the transmission.
            removeKeepAliveTapLocked()
            try installCaptureTapLocked()
            try ensureEngineRunningLocked()
            isCapturing = true
        }
    }

    /// Installs the capture tap at the format the hardware reports RIGHT NOW and
    /// builds the converter from it. Called at `startCapture` and again after
    /// every engine rebuild — §5's "formats are never cached across a rebuild"
    /// is enforced by there being no other place a capture format is read.
    private func installCaptureTapLocked() throws {
        let input = engine.inputNode
        let inputFormat = input.outputFormat(forBus: 0)
        guard inputFormat.sampleRate > 0 else {
            throw RadioError.audioFailed("no usable microphone format")
        }
        try rebuildConverterLocked(for: inputFormat)
        // Quiet-transmit investigation: `.voiceChat` puts voice processing on
        // the SESSION, but a plain inputNode tap only gets the node's AGC when
        // `setVoiceProcessingEnabled(true)` is called — which this engine never
        // does. Record the actual state as hardware evidence.
        HeartbeatLogger.shared.record(
            "tx capture start rate=\(Int(inputFormat.sampleRate)) "
                + "voiceProcessing=\(input.isVoiceProcessingEnabled) "
                + "gain=\(RadioConfig.Audio.captureGain)"
        )
        input.installTap(onBus: 0, bufferSize: 1_024, format: inputFormat) {
            [weak self] buffer, _ in
            guard let self else { return }
            HeartbeatLogger.shared.noteInputBuffer()
            self.queue.async { self.handleCaptureLocked(buffer) }
        }
        log.info("capture started at \(inputFormat.sampleRate, privacy: .public) Hz")
    }

    private func rebuildConverterLocked(for format: AVAudioFormat) throws {
        guard let converter = AVAudioConverter(from: format, to: OpusFormat.pcm) else {
            throw RadioError.audioFailed("no usable microphone format")
        }
        self.converter = converter
        // The residue belongs to the old rate; keeping it would splice two
        // sample rates into one Opus frame.
        captureResidue.removeAll(keepingCapacity: true)
    }
```

In `handleCaptureLocked`, replace the opening guard (line 343) and the conversion-error branch (lines 373-376) with:

```swift
        guard isCapturing, let encoder else { return }

        // §5: a mid-transmission route change re-routes with a short glitch
        // instead of raising `audioFailed`. The tap keeps its old format after
        // a hardware change until it is reinstalled, so the buffer is the
        // authority on what is actually arriving.
        if CaptureConverterPolicy.needsRebuild(
            converterInput: converter?.inputFormat, incoming: buffer.format
        ) {
            HeartbeatLogger.shared.record(
                "tx converter rebuild rate=\(Int(buffer.format.sampleRate))"
            )
            do {
                try rebuildConverterLocked(for: buffer.format)
            } catch {
                HeartbeatLogger.shared.record("tx converter rebuild FAILED: \(error)")
                return
            }
        }
        guard let converter else { return }
```

and

```swift
        if let conversionError {
            // Never `audioFailed` (§2 goal 3): the format moved under us. Drop
            // this buffer, rebuild from what actually arrived, and carry on —
            // the next buffer transmits.
            HeartbeatLogger.shared.record("tx resample failed, rebuilding: \(conversionError)")
            try? rebuildConverterLocked(for: buffer.format)
            return
        }
```

- [ ] **Step 10: Stop `beginIncoming` from stop/starting the engine**

In `beginIncoming(peerId:)`, delete the `let wasRunning = engine.isRunning` line, the `if wasRunning { engine.stop() }` block and its comment, and reduce the heartbeat line. The body becomes:

```swift
            do {
                let playback = PeerPlayback(decoder: try makeDecoder())
                engine.attach(playback.player)
                engine.connect(
                    playback.player,
                    to: engine.mainMixerNode,
                    format: OpusFormat.pcm
                )
                playbacks[peerId] = playback
                try ensureEngineRunningLocked()
                HeartbeatLogger.shared.record(
                    "rx playback open peer=\(peerId) engine=\(engine.isRunning)"
                )
                log.info("playback opened for \(peerId, privacy: .public)")
            } catch {
```

with this comment above the `do`:

```swift
            // §5: "beginIncoming no longer stop/starts the engine per
            // transmission; engine restarts happen only on configuration change
            // or interruption recovery." The stop/start was a workaround for a
            // graph that was never rebuilt when the hardware format moved —
            // `rebuildEngine` is that rebuild, and attaching a player node to a
            // running engine is a supported dynamic graph change.
```

- [ ] **Step 11: Add the rebuild and the tone**

At the end of `ios/Radio/Sources/RadioKit/AudioEngine.swift`, in a new extension:

```swift
// MARK: - Rebuild and grant tone (§5, D2)

extension AudioEngine {

    /// §5's engine rebuild. Ordered the way AVAudioEngine requires it: taps
    /// come off before anything is disconnected (a tap left on a node that is
    /// about to be disconnected is a documented crash), the graph is torn down,
    /// the hardware is re-queried by touching the I/O nodes, everything is
    /// reconnected, the tap goes back on at the format the hardware reports NOW,
    /// and only then does the engine start.
    ///
    /// `prepare()` is not called and no main-queue hop is needed: the documented
    /// `inputNode != nullptr || outputNode != nullptr` assertion fires when
    /// `prepare()`/`start()` run against an EMPTY graph, and both I/O nodes are
    /// touched above before `start()`.
    public func rebuildEngine(recreate: Bool) {
        queue.async { [self] in
            guard isPlaybackStarted else { return }
            let wasCapturing = isCapturing
            HeartbeatLogger.shared.record(
                "engine rebuild begin recreate=\(recreate) capturing=\(wasCapturing)"
            )

            if wasCapturing {
                engine.inputNode.removeTap(onBus: 0)
            }
            removeKeepAliveTapLocked()
            if engine.isRunning {
                engine.stop()
            }
            for playback in playbacks.values {
                engine.disconnectNodeOutput(playback.player)
            }
            if isTonePlayerAttached {
                engine.disconnectNodeOutput(tonePlayer)
            }

            if recreate {
                // QA1749: after a media-services reset every audio object is
                // dead, including the engine and its nodes.
                for playback in playbacks.values {
                    engine.detach(playback.player)
                }
                if isTonePlayerAttached {
                    engine.detach(tonePlayer)
                    isTonePlayerAttached = false
                }
                engine = AVAudioEngine()
                tonePlayer = AVAudioPlayerNode()
                converter = nil
                for playback in playbacks.values {
                    engine.attach(playback.player)
                }
            }

            _ = engine.inputNode
            _ = engine.mainMixerNode
            for playback in playbacks.values {
                engine.connect(
                    playback.player,
                    to: engine.mainMixerNode,
                    format: OpusFormat.pcm
                )
            }
            if isTonePlayerAttached {
                engine.connect(tonePlayer, to: engine.mainMixerNode, format: OpusFormat.pcm)
            }

            do {
                if wasCapturing {
                    try installCaptureTapLocked()
                } else {
                    try installKeepAliveTapLocked()
                }
                try ensureEngineRunningLocked()
            } catch {
                // §2 goal 3: a route change never kills the radio. The next
                // configuration change, route change or interruption recovery
                // retries; nothing is raised to the delegate.
                HeartbeatLogger.shared.record("engine rebuild FAILED: \(error)")
                return
            }
            // Players that were mid-transmission lost their scheduled buffers
            // with the stop. `drainLocked` calls `play()` when it schedules the
            // next one, so playback resumes on the next frame off the wire.
            HeartbeatLogger.shared.record("engine rebuild done running=\(engine.isRunning)")
        }
    }

    /// D2's talk-permit tone, on its own player node so it never disturbs a
    /// peer's playback chain.
    public func playGrantTone() {
        queue.async { [self] in
            guard let buffer = OpusFormat.buffer(from: GrantTone.pcm()) else { return }
            if !isTonePlayerAttached {
                engine.attach(tonePlayer)
                engine.connect(tonePlayer, to: engine.mainMixerNode, format: OpusFormat.pcm)
                isTonePlayerAttached = true
            }
            do {
                try ensureEngineRunningLocked()
            } catch {
                HeartbeatLogger.shared.record("grant tone SKIPPED: \(error)")
                return
            }
            tonePlayer.scheduleBuffer(buffer, completionHandler: nil)
            if !tonePlayer.isPlaying {
                tonePlayer.play()
            }
            HeartbeatLogger.shared.record("grant tone")
        }
    }
}
```

`installKeepAliveTapLocked` needs one change: its `guard !isKeepAliveTapInstalled, !isCapturing else { return }` stays, and `removeKeepAliveTapLocked()` must be called before it in the rebuild — which it is.

- [ ] **Step 12: Run the whole gate**

```bash
pnpm typecheck && pnpm lint && pnpm test
(cd ios/Radio && DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild test -scheme RadioKit -destination 'platform=iOS Simulator,name=iPhone 17')
```

Expected: PASS. `RadioEngineTests` still compiles because `FakeAudio` gained the two methods in Step 8.

- [ ] **Step 13: Commit**

```bash
git add ios/Radio/Sources/RadioKit/CaptureConverterPolicy.swift \
        ios/Radio/Sources/RadioKit/GrantTone.swift \
        ios/Radio/Sources/RadioKit/RadioConfig.swift \
        ios/Radio/Sources/RadioKit/RadioPorts.swift \
        ios/Radio/Sources/RadioKit/AudioEngine.swift \
        ios/Radio/Tests/RadioKitTests/CaptureConverterPolicyTests.swift \
        ios/Radio/Tests/RadioKitTests/GrantToneTests.swift \
        ios/Radio/Tests/RadioKitTests/Fakes.swift
git commit -m "feat(ios-audio): rebuild the engine and the converter instead of dying

Adds AudioIO.rebuildEngine/playGrantTone, rebuilds the capture converter on any
input-format change so a mid-transmission route change re-routes instead of
raising audioFailed, and drops beginIncoming's per-transmission stop/start
(spec section 5)."
```

---

## Task 3: The session reaction table

§10 (iOS) asks for unit tests over "the (event, state) → actions reaction table". This task is that table: one pure function answering, for every notification §5 names, what the session's next status is and what has to be done. Nothing calls it yet — Task 4 makes `AlwaysHotBackgroundManager` its only caller.

**Files:**
- Create: `ios/Radio/Sources/RadioKit/AudioSessionReactor.swift`
- Create: `ios/Radio/Tests/RadioKitTests/AudioSessionReactorTests.swift`

**Interfaces:**
- Consumes: `ModePolicy.Profile` (merged P1, read-only).
- Produces: `AudioSessionEvent`, `AudioSessionStatus`, `AudioSessionAction`, `AudioSessionReaction`, `AudioSessionReactor.react(to:from:)` — signatures exactly as in "The interfaces, in full".

### The table, as specified

| Event | Guard | Next status | Actions |
|---|---|---|---|
| `activationRequested` | — | unchanged | `applyConfiguration(profile)`, `activate` |
| `activationSucceeded` | — | `isActive = true` | `maximizeInputGain`, `syncSpeakerOverride`, `publishRoute`, `sampleOtherAudio` |
| `activationFailed` | — | `isActive = false` | — |
| `deactivationRequested` | — | `isActive = false`, `profile = .voice` | `deactivate` |
| `profileRequested(p)` | `p == profile` | unchanged | — |
| `profileRequested(p)` | `p != profile` | `profile = p` | `applyConfiguration(p)`, `syncSpeakerOverride`, `publishRoute` |
| `routeChanged(.newDeviceAvailable)` | active | unchanged | `syncSpeakerOverride`, `publishRoute`, `sampleOtherAudio` |
| `routeChanged(.oldDeviceUnavailable)` | active | unchanged | `syncSpeakerOverride`, `publishRoute`, `sampleOtherAudio` |
| `routeChanged(.categoryChange)` | active | unchanged | `applyConfiguration(profile)`, `syncSpeakerOverride`, `publishRoute` |
| `routeChanged(.override)` | — | unchanged | — |
| `routeChanged(any other)` | active | unchanged | `publishRoute` |
| `routeChanged(anything)` | inactive | unchanged | — |
| `engineConfigurationChanged` | active | unchanged | `rebuildEngine`, `publishRoute` |
| `engineConfigurationChanged` | inactive | unchanged | — |
| `interruptionBegan` | — | `isActive = false` | — |
| `interruptionEnded` | — | unchanged | `applyConfiguration(profile)`, `activate`, `rebuildEngine` |
| `appDidBecomeActive` | active | unchanged | `syncSpeakerOverride`, `publishRoute`, `sampleOtherAudio` |
| `appDidBecomeActive` | inactive | unchanged | `applyConfiguration(profile)`, `activate`, `rebuildEngine` |
| `mediaServicesWereReset` | — | `isActive = false` | `applyConfiguration(profile)`, `activate`, `recreateEngine` |
| `silenceSecondaryAudioHint` | active | unchanged | `sampleOtherAudio` |
| `silenceSecondaryAudioHint` | inactive | unchanged | — |

Three things this shape buys, each worth stating because they are not obvious:

- **Activation has exactly one tail.** `activationRequested`, `interruptionEnded`, `appDidBecomeActive`-while-inactive and `mediaServicesWereReset` all end in `activate`; the manager answers a successful `setActive` with `activationSucceeded`, and *that* row carries the input gain, the override, the publication and the other-audio sample. So there is one place "the session came up" is defined and one place it is tested.
- **Only the three recovery rows rebuild the engine.** `activationSucceeded` deliberately does not: the first activation of a run happens *before* `audio.startPlayback()` (`RadioEngine.startRadioLocked` calls `background.activate()` first), and a rebuild there would restart a freshly started engine for nothing. The rebuild is listed after `activate` on each recovery row instead, so it runs on a session that has just been re-activated. If that activation failed, the rebuild fails too and is logged — §2 goal 3 — and the next recovery retries.
- **`.override` produces nothing** because it is the echo of our own `overrideOutputAudioPort` call — §5 says "log only" and reacting would loop.

- [ ] **Step 1: Write the failing table test**

Create `ios/Radio/Tests/RadioKitTests/AudioSessionReactorTests.swift`:

```swift
import AVFoundation
import XCTest
@testable import RadioKit

/// §10 (iOS): "the (event, state) → actions reaction table". Every row of §5's
/// observer behaviour, asserted without an AVAudioSession in sight.
final class AudioSessionReactorTests: XCTestCase {

    private let inactive = AudioSessionStatus(isActive: false, profile: .voice)
    private let active = AudioSessionStatus(isActive: true, profile: .voice)
    private let activeMedia = AudioSessionStatus(isActive: true, profile: .media)

    private func react(
        _ event: AudioSessionEvent,
        _ status: AudioSessionStatus
    ) -> AudioSessionReaction {
        AudioSessionReactor.react(to: event, from: status)
    }

    // MARK: - Activation

    func testActivationRequestedConfiguresThenActivatesAndClaimsNothingYet() {
        let reaction = react(.activationRequested, inactive)
        XCTAssertEqual(reaction.actions, [.applyConfiguration(.voice), .activate])
        XCTAssertFalse(reaction.status.isActive)
    }

    func testActivationRequestedCarriesTheProfileAlreadyInForce() {
        let reaction = react(.activationRequested, AudioSessionStatus(isActive: false, profile: .media))
        XCTAssertEqual(reaction.actions.first, .applyConfiguration(.media))
    }

    func testActivationSuccessIsTheOnePlaceTheSessionComesUp() {
        let reaction = react(.activationSucceeded, inactive)
        XCTAssertTrue(reaction.status.isActive)
        XCTAssertEqual(
            reaction.actions,
            [.maximizeInputGain, .syncSpeakerOverride, .publishRoute, .sampleOtherAudio]
        )
    }

    func testActivationSuccessNeverRebuildsTheEngine() {
        // The first activation of a run happens BEFORE `audio.startPlayback()`
        // — `RadioEngine.startRadioLocked` calls `background.activate()` first
        // — so a rebuild here would restart a freshly started engine for
        // nothing. The three recovery rows carry it instead.
        XCTAssertFalse(react(.activationSucceeded, inactive).actions.contains(.rebuildEngine))
    }

    func testActivationFailureLeavesTheSessionInactiveAndDoesNothing() {
        let reaction = react(.activationFailed, active)
        XCTAssertFalse(reaction.status.isActive)
        XCTAssertEqual(reaction.actions, [])
    }

    func testDeactivationResetsTheProfileSoTheNextStartBeginsInVoice() {
        // §9's first row: no external device, no music → VOICE.
        let reaction = react(.deactivationRequested, activeMedia)
        XCTAssertEqual(reaction.status, AudioSessionStatus(isActive: false, profile: .voice))
        XCTAssertEqual(reaction.actions, [.deactivate])
    }

    // MARK: - Profile switches (§7's output, §5's mechanism)

    func testAProfileAlreadyInForceIsNotReapplied() {
        // §5: "applied whole (diff-only: skip if already applied)".
        let reaction = react(.profileRequested(.voice), active)
        XCTAssertEqual(reaction.actions, [])
        XCTAssertEqual(reaction.status, active)
    }

    func testAProfileChangeAppliesTheOtherConfigurationAndRepublishes() {
        let reaction = react(.profileRequested(.media), active)
        XCTAssertEqual(reaction.status, AudioSessionStatus(isActive: true, profile: .media))
        XCTAssertEqual(
            reaction.actions,
            [.applyConfiguration(.media), .syncSpeakerOverride, .publishRoute]
        )
    }

    func testAProfileChangeIsRememberedEvenWhileTheSessionIsInactive() {
        // A raise requested during an interruption must survive it: the
        // recovery re-applies `status.profile`.
        let reaction = react(.profileRequested(.media), inactive)
        XCTAssertEqual(reaction.status.profile, .media)
    }

    func testAProfileChangeNeverRebuildsTheEngineItself() {
        // §5: mode switches "ride the same rebuild path" — the setCategory
        // emits AVAudioEngineConfigurationChange when the hardware format
        // moves, and that notification is what rebuilds. Doing it here as well
        // would rebuild twice on every switch.
        let reaction = react(.profileRequested(.media), active)
        XCTAssertFalse(reaction.actions.contains(.rebuildEngine))
    }

    // MARK: - Route changes

    func testADeviceAppearingRecomputesTheOverridePublishesAndSamplesOtherAudio() {
        let reaction = react(.routeChanged(reason: .newDeviceAvailable), active)
        XCTAssertEqual(
            reaction.actions, [.syncSpeakerOverride, .publishRoute, .sampleOtherAudio]
        )
        XCTAssertEqual(reaction.status, active)
    }

    func testADeviceDisappearingDoesExactlyTheSame() {
        // §9: "headset battery dies / walks out of range → immediate
        // loudspeaker + phone mic; no error state." The override recomputation
        // is the whole fallback.
        XCTAssertEqual(
            react(.routeChanged(reason: .oldDeviceUnavailable), active).actions,
            [.syncSpeakerOverride, .publishRoute, .sampleOtherAudio]
        )
    }

    func testAForeignCategoryChangeReappliesOurConfiguration() {
        // §5: "someone else changed it".
        let reaction = react(.routeChanged(reason: .categoryChange), activeMedia)
        XCTAssertEqual(
            reaction.actions,
            [.applyConfiguration(.media), .syncSpeakerOverride, .publishRoute]
        )
    }

    func testOurOwnOverrideEchoDoesNothing() {
        // §5: "`.override` → log only". Reacting would loop: syncSpeakerOverride
        // is what emits this reason in the first place.
        XCTAssertEqual(react(.routeChanged(reason: .override), active).actions, [])
    }

    func testEveryOtherReasonRepublishesWithoutTouchingTheSession() {
        for reason in [
            AVAudioSession.RouteChangeReason.unknown, .wakeFromSleep,
            .noSuitableRouteForCategory, .routeConfigurationChange
        ] {
            XCTAssertEqual(
                react(.routeChanged(reason: reason), active).actions, [.publishRoute],
                "\(reason.rawValue) may change the effective route without a device event"
            )
        }
    }

    func testRouteChangesAreIgnoredWhileTheSessionIsNotActive() {
        for reason in [
            AVAudioSession.RouteChangeReason.newDeviceAvailable, .oldDeviceUnavailable,
            .categoryChange, .routeConfigurationChange
        ] {
            XCTAssertEqual(react(.routeChanged(reason: reason), inactive).actions, [])
        }
    }

    // MARK: - Engine configuration

    func testAnEngineConfigurationChangeRebuildsAndRepublishes() {
        // §5: the one thing nothing observed before. A route change that alters
        // the hardware sample rate stops AVAudioEngine silently, and the
        // keep-alive tap dies with it — which suspends the whole radio.
        XCTAssertEqual(
            react(.engineConfigurationChanged, active).actions, [.rebuildEngine, .publishRoute]
        )
    }

    func testAnEngineConfigurationChangeIsIgnoredWhileInactive() {
        XCTAssertEqual(react(.engineConfigurationChanged, inactive).actions, [])
    }

    // MARK: - Interruptions and recovery

    func testAnInterruptionMarksTheSessionInactiveAndDoesNothingElse() {
        let reaction = react(.interruptionBegan, activeMedia)
        XCTAssertFalse(reaction.status.isActive)
        XCTAssertEqual(reaction.status.profile, .media)
        XCTAssertEqual(reaction.actions, [])
    }

    func testInterruptionEndReappliesTheProfileReactivatesAndRebuilds() {
        // §5: "`.ended` → re-apply profile config, `setActive(true)` with retry
        // on `isBusy`, rebuild/restart the engine, recompute route." The
        // recompute rides on `activationSucceeded`.
        let reaction = react(.interruptionEnded, AudioSessionStatus(isActive: false, profile: .media))
        XCTAssertEqual(
            reaction.actions, [.applyConfiguration(.media), .activate, .rebuildEngine]
        )
        XCTAssertFalse(reaction.status.isActive)
    }

    func testTheRebuildComesAfterTheActivationOnEveryRecoveryRow() {
        // An engine cannot start against a session that is not active yet.
        for event in [
            AudioSessionEvent.interruptionEnded, .appDidBecomeActive, .mediaServicesWereReset
        ] {
            let actions = react(event, inactive).actions
            guard
                let activateIndex = actions.firstIndex(of: .activate),
                let rebuildIndex = actions.firstIndex(where: {
                    $0 == .rebuildEngine || $0 == .recreateEngine
                })
            else {
                return XCTFail("\(event) must both activate and rebuild")
            }
            XCTAssertLessThan(activateIndex, rebuildIndex, "\(event)")
        }
    }

    func testForegroundingAfterAMissedInterruptionEndRunsTheSameRecovery() {
        // §5: "Because `.ended` is not guaranteed, app-foreground also runs the
        // same recovery."
        XCTAssertEqual(
            react(.appDidBecomeActive, inactive).actions,
            react(.interruptionEnded, inactive).actions
        )
    }

    func testForegroundingALiveSessionOnlyRefreshes() {
        // Running setActive and an engine rebuild on every app switch would
        // glitch audio for nothing.
        let reaction = react(.appDidBecomeActive, active)
        XCTAssertEqual(
            reaction.actions, [.syncSpeakerOverride, .publishRoute, .sampleOtherAudio]
        )
        XCTAssertTrue(reaction.status.isActive)
    }

    func testAMediaServicesResetRebuildsTheSessionThenThrowsTheEngineAway() {
        // Apple QA1749: dispose every audio object and rebuild from scratch.
        let reaction = react(.mediaServicesWereReset, activeMedia)
        XCTAssertFalse(reaction.status.isActive)
        XCTAssertEqual(reaction.status.profile, .media)
        XCTAssertEqual(
            reaction.actions, [.applyConfiguration(.media), .activate, .recreateEngine]
        )
    }

    // MARK: - Other audio

    func testTheSilenceHintIsAnEdgeTriggerToResample() {
        // §5: `silenceSecondaryAudioHintNotification` observed as an immediate
        // edge trigger. The hint says "look again", `isOtherAudioPlaying` says
        // what is true.
        XCTAssertEqual(react(.silenceSecondaryAudioHint, active).actions, [.sampleOtherAudio])
        XCTAssertEqual(react(.silenceSecondaryAudioHint, inactive).actions, [])
    }

    // MARK: - Invariants across the whole table

    func testNothingEverMutatesTheSessionWhileItIsInactiveExceptOnPurpose() {
        // The only inactive-status rows that touch the session are the three
        // deliberate recovery entry points and deactivation itself.
        let events: [AudioSessionEvent] = [
            .routeChanged(reason: .newDeviceAvailable),
            .routeChanged(reason: .categoryChange),
            .engineConfigurationChanged,
            .silenceSecondaryAudioHint,
            .interruptionBegan,
            .activationFailed
        ]
        for event in events {
            XCTAssertEqual(react(event, inactive).actions, [], "\(event) must be inert")
        }
    }

    func testTheProfileIsOnlyEverChangedByAProfileRequestOrByDeactivation() {
        let events: [AudioSessionEvent] = [
            .activationRequested, .activationSucceeded, .activationFailed,
            .routeChanged(reason: .newDeviceAvailable), .routeChanged(reason: .categoryChange),
            .engineConfigurationChanged, .interruptionBegan, .interruptionEnded,
            .appDidBecomeActive, .mediaServicesWereReset, .silenceSecondaryAudioHint
        ]
        for event in events {
            XCTAssertEqual(
                react(event, activeMedia).status.profile, .media,
                "\(event) must not move the profile"
            )
        }
    }
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd ios/Radio && DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild test -scheme RadioKit -destination 'platform=iOS Simulator,name=iPhone 17' -only-testing:RadioKitTests/AudioSessionReactorTests`

Expected: FAIL — `cannot find 'AudioSessionStatus' in scope`, `cannot find 'AudioSessionReactor' in scope`.

- [ ] **Step 3: Write `AudioSessionReactor.swift`**

Create `ios/Radio/Sources/RadioKit/AudioSessionReactor.swift`:

```swift
import AVFoundation
import Foundation

/// Everything §5 asks an observer to notice.
///
/// `activationSucceeded` / `activationFailed` are not notifications: they are
/// how the manager reports the outcome of the `activate` action back into the
/// table, so recovery has exactly one definition instead of one per entry point.
public enum AudioSessionEvent: Equatable {
    case activationRequested
    case activationSucceeded
    case activationFailed
    case deactivationRequested
    /// The merged §7 policy asked for a profile (`RadioEngine` → `applyProfile`).
    case profileRequested(ModePolicy.Profile)
    case routeChanged(reason: AVAudioSession.RouteChangeReason)
    case engineConfigurationChanged
    case interruptionBegan
    case interruptionEnded
    case appDidBecomeActive
    case mediaServicesWereReset
    case silenceSecondaryAudioHint
}

/// The manager's whole mutable state, as a value.
///
/// It exists as a value so §5's "closes the current data race on
/// `isActive`/`currentProfile`" is structural rather than a promise: the two
/// fields are only ever replaced wholesale, by the pure function below, on the
/// engine queue.
public struct AudioSessionStatus: Equatable {
    /// What the manager last *did* — AVAudioSession has no public "is active"
    /// getter, which is the same reason `HeartbeatLogger.sessionActive` exists.
    public var isActive: Bool
    /// The configuration in force. §5's mode switches are a re-apply of the
    /// other one.
    public var profile: ModePolicy.Profile

    public init(isActive: Bool = false, profile: ModePolicy.Profile = .voice) {
        self.isActive = isActive
        self.profile = profile
    }
}

/// The side effects the manager performs against AVAudioSession, the engine and
/// its delegate. Naming them instead of performing them inline is what makes
/// §10's "(event, state) → actions reaction table" a unit test.
public enum AudioSessionAction: Equatable {
    /// `setCategory` with one of the two static configurations, diff-only.
    case applyConfiguration(ModePolicy.Profile)
    /// `setActive(true)`, retrying on `.isBusy`; answers with
    /// `activationSucceeded` or `activationFailed`.
    case activate
    case deactivate
    case maximizeInputGain
    /// `overrideOutputAudioPort` from the current outputs.
    case syncSpeakerOverride
    /// Classify the current route and hand it to the delegate, diff-only.
    case publishRoute
    /// Read `isOtherAudioPlaying` and hand it to the delegate, diff-only.
    case sampleOtherAudio
    case rebuildEngine
    case recreateEngine
}

public struct AudioSessionReaction: Equatable {
    public let status: AudioSessionStatus
    public let actions: [AudioSessionAction]

    public init(status: AudioSessionStatus, actions: [AudioSessionAction]) {
        self.status = status
        self.actions = actions
    }
}

/// §5's observers, as one pure function. `AlwaysHotBackgroundManager` is its
/// only caller and does nothing but perform what it returns.
public enum AudioSessionReactor {

    public static func react(
        to event: AudioSessionEvent,
        from status: AudioSessionStatus
    ) -> AudioSessionReaction {
        var next = status

        switch event {
        case .activationRequested:
            return AudioSessionReaction(
                status: next,
                actions: [.applyConfiguration(next.profile), .activate]
            )

        case .activationSucceeded:
            next.isActive = true
            // The one place "the session came up" is defined, whichever entry
            // point got here. Deliberately no rebuild: the first activation of
            // a run happens before `audio.startPlayback()`, and the three
            // recovery rows carry the rebuild themselves.
            return AudioSessionReaction(
                status: next,
                actions: [
                    .maximizeInputGain, .syncSpeakerOverride,
                    .publishRoute, .sampleOtherAudio
                ]
            )

        case .activationFailed:
            // Expected while backgrounded: iOS refuses activation from there.
            // The next foreground or interruption end retries.
            next.isActive = false
            return AudioSessionReaction(status: next, actions: [])

        case .deactivationRequested:
            next.isActive = false
            // §9's first row is the state a stopped radio starts from again.
            next.profile = .voice
            return AudioSessionReaction(status: next, actions: [.deactivate])

        case let .profileRequested(profile):
            guard profile != next.profile else {
                return AudioSessionReaction(status: next, actions: [])
            }
            next.profile = profile
            // No rebuild here: the `setCategory` emits
            // AVAudioEngineConfigurationChange when the hardware format moves,
            // and that notification owns the rebuild (§5, "ride the same
            // rebuild path").
            return AudioSessionReaction(
                status: next,
                actions: [.applyConfiguration(profile), .syncSpeakerOverride, .publishRoute]
            )

        case let .routeChanged(reason):
            guard next.isActive else {
                return AudioSessionReaction(status: next, actions: [])
            }
            switch reason {
            case .newDeviceAvailable, .oldDeviceUnavailable:
                return AudioSessionReaction(
                    status: next,
                    actions: [.syncSpeakerOverride, .publishRoute, .sampleOtherAudio]
                )
            case .categoryChange:
                // Someone else changed the category out from under us.
                return AudioSessionReaction(
                    status: next,
                    actions: [
                        .applyConfiguration(next.profile), .syncSpeakerOverride, .publishRoute
                    ]
                )
            case .override:
                // The echo of our own overrideOutputAudioPort: log only (§5).
                return AudioSessionReaction(status: next, actions: [])
            default:
                // wakeFromSleep, routeConfigurationChange, noSuitableRoute,
                // unknown: these can move the effective route without a device
                // event, and publication is a pure read plus a diff.
                return AudioSessionReaction(status: next, actions: [.publishRoute])
            }

        case .engineConfigurationChanged:
            guard next.isActive else {
                return AudioSessionReaction(status: next, actions: [])
            }
            return AudioSessionReaction(status: next, actions: [.rebuildEngine, .publishRoute])

        case .interruptionBegan:
            next.isActive = false
            return AudioSessionReaction(status: next, actions: [])

        case .interruptionEnded:
            // `shouldResume` is deliberately not consulted: it is advice about
            // resuming playback, and the always-hot session is this app's
            // lifeline. It is logged by the manager, not obeyed.
            //
            // The rebuild follows the activation, never precedes it: an engine
            // cannot start against a session that is not active yet. If the
            // activation failed (backgrounded), the rebuild fails too and is
            // logged — §2 goal 3 — and the next recovery retries.
            return AudioSessionReaction(
                status: next,
                actions: [.applyConfiguration(next.profile), .activate, .rebuildEngine]
            )

        case .appDidBecomeActive:
            guard next.isActive else {
                // §5: `.ended` is not guaranteed, so foregrounding runs the
                // same recovery.
                return AudioSessionReaction(
                    status: next,
                    actions: [.applyConfiguration(next.profile), .activate, .rebuildEngine]
                )
            }
            // A live session only needs a refresh; a setActive and an engine
            // rebuild on every app switch would glitch audio for nothing.
            return AudioSessionReaction(
                status: next,
                actions: [.syncSpeakerOverride, .publishRoute, .sampleOtherAudio]
            )

        case .mediaServicesWereReset:
            // Apple QA1749: every audio object is dead. Rebuild the session
            // first, then throw the engine away and build a new one on top.
            next.isActive = false
            return AudioSessionReaction(
                status: next,
                actions: [.applyConfiguration(next.profile), .activate, .recreateEngine]
            )

        case .silenceSecondaryAudioHint:
            guard next.isActive else {
                return AudioSessionReaction(status: next, actions: [])
            }
            return AudioSessionReaction(status: next, actions: [.sampleOtherAudio])
        }
    }
}
```

- [ ] **Step 4: Run the table tests to verify they pass**

Run: `cd ios/Radio && DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild test -scheme RadioKit -destination 'platform=iOS Simulator,name=iPhone 17' -only-testing:RadioKitTests/AudioSessionReactorTests`

Expected: PASS, every test in `AudioSessionReactorTests`.

- [ ] **Step 5: Run the whole gate**

```bash
pnpm typecheck && pnpm lint && pnpm test
(cd ios/Radio && DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild test -scheme RadioKit -destination 'platform=iOS Simulator,name=iPhone 17')
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add ios/Radio/Sources/RadioKit/AudioSessionReactor.swift \
        ios/Radio/Tests/RadioKitTests/AudioSessionReactorTests.swift
git commit -m "feat(ios-audio): the session reaction table, as a pure function

Every observer spec section 5 names becomes one row of (event, status) ->
(status, actions), which is what makes spec section 10's iOS reaction-table
tests possible without an AVAudioSession."
```

---

## Task 4: The manager runs the table on the engine queue

`AlwaysHotBackgroundManager` becomes an executor: six notification registrations, every one re-posted onto the `RadioEngine` queue, each turning into an `AudioSessionEvent`; `AudioSessionReactor.react` answers; the manager performs. Route and other-audio changes go up to `RadioEngine` through the port; engine rebuilds go up the same way and out to `AudioIO`.

§5 names four observers (route change, `AVAudioEngineConfigurationChange`, interruption, `mediaServicesWereReset`) and two further triggers in its prose — app-foreground recovery and the `silenceSecondaryAudioHint` edge. Six registrations, four observers; the count is not a discrepancy.

**Files:**
- Modify: `ios/Radio/Sources/RadioKit/RadioPorts.swift` (`BackgroundSession`, `BackgroundSessionDelegate`)
- Modify: `ios/Radio/Sources/RadioKit/RadioConfig.swift` (new `Session` block)
- Modify: `ios/Radio/Sources/RadioKit/AlwaysHotBackgroundManager.swift` (whole file)
- Modify: `ios/Radio/Sources/RadioKit/HeartbeatLogger.swift` (`onTick`)
- Modify: `ios/Radio/Sources/RadioKit/RadioAssembly.swift` (pass the queue)
- Modify: `ios/Radio/Sources/RadioKit/RadioEngine.swift` (the three new delegate methods)
- Modify: `ios/Radio/Tests/RadioKitTests/Fakes.swift` (`FakeBackground`)
- Modify: `ios/Radio/Tests/RadioKitTests/RadioEngineTests.swift` (one new test)

**Interfaces:**
- Consumes: `AudioSessionReactor.react(to:from:)`, `AudioSessionStatus`, `AudioSessionAction`, `AudioSessionEvent` (Task 3); `AudioSessionConfiguration.of/matches/speakerOverride`, `AudioRouteClassifier.snapshot`, `AudioPort.ports(from:)`, `AudioRouteSnapshot` (Task 1); `AudioIO.rebuildEngine(recreate:)` (Task 2).
- Produces: `BackgroundSession.applyProfile(_ profile: ModePolicy.Profile)`; `BackgroundSessionDelegate.backgroundSession(_:routeDidChange:)`, `backgroundSession(_:otherAudioActiveDidChange:)`, `backgroundSession(_:didRequestEngineRebuild:)`; `AlwaysHotBackgroundManager.init(queue: DispatchQueue)`; `HeartbeatLogger.onTick`; `RadioConfig.Session.activationRetryDelay` / `.activationRetryLimit`; on `FakeBackground` the recorder `appliedProfiles: [ModePolicy.Profile]` and the drivers `publishRoute(_:)`, `publishOtherAudio(_:)`, `requestEngineRebuild(recreate:)`.

- [ ] **Step 1: Write the failing test for the forwarding `RadioEngine` must do**

In `ios/Radio/Tests/RadioKitTests/RadioEngineTests.swift`, add at the end of the class:

```swift
    func testAnEngineRebuildRequestReachesTheAudioPort() {
        // §5: the session observes AVAudioEngineConfigurationChange and
        // mediaServicesWereReset; the engine graph they refer to belongs to
        // AudioIO, so the request travels session -> engine -> audio.
        engine.startRadio()
        flush()

        background.requestEngineRebuild(recreate: false)
        background.requestEngineRebuild(recreate: true)
        flush()

        XCTAssertEqual(audio.rebuilds, [false, true])
    }
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd ios/Radio && DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild test -scheme RadioKit -destination 'platform=iOS Simulator,name=iPhone 17' -only-testing:RadioKitTests/RadioEngineTests/testAnEngineRebuildRequestReachesTheAudioPort`

Expected: FAIL — `value of type 'FakeBackground' has no member 'requestEngineRebuild'`.

- [ ] **Step 3: Extend the `BackgroundSession` port**

In `ios/Radio/Sources/RadioKit/RadioPorts.swift`, replace the `// MARK: - Background` block with:

```swift
public protocol BackgroundSession: AnyObject {
    var delegate: BackgroundSessionDelegate? { get set }

    func activate()
    func deactivate()
    func requestBeginTransmitting()
    func stopTransmitting()
    func setReceiving(_ receiving: Bool)

    /// §5/§7: apply one of the two static session configurations, whole and
    /// diff-only. The merged §7 policy is the only thing that asks. On iOS a
    /// voice-link raise and a mode switch are the same call, which is why there
    /// is one method and not three.
    ///
    /// Called from the engine queue, like every other method here, and must
    /// never dispatch synchronously back onto it.
    func applyProfile(_ profile: ModePolicy.Profile)
}

public protocol BackgroundSessionDelegate: AnyObject {
    /// The audio session is active; the microphone may start now.
    func backgroundSessionDidActivateAudio(_ session: BackgroundSession)
    func backgroundSessionDidDeactivateAudio(_ session: BackgroundSession)
    /// Transmission was started somewhere outside the app. Nothing raises this
    /// under the always-hot architecture (spec section 10.2) — it survives for
    /// a future system-level talk control.
    func backgroundSessionDidRequestTransmitStart(_ session: BackgroundSession)
    func backgroundSessionDidRequestTransmitStop(_ session: BackgroundSession)
    func backgroundSession(_ session: BackgroundSession, didFail error: RadioError)

    /// §8's `audioRoute` and §7's two route predicates, in one value. Delivered
    /// on the engine queue, diff-only: an unchanged route is not republished.
    func backgroundSession(
        _ session: BackgroundSession,
        routeDidChange snapshot: AudioRouteSnapshot
    )
    /// §5's other-audio detection (`isOtherAudioPlaying` on the heartbeat tick
    /// and on every route change, `silenceSecondaryAudioHint` as an edge).
    /// Diff-only, raw and undebounced: the 2 s / 30 s dwell belongs to
    /// `ModePolicy`, so both platforms debounce identically.
    func backgroundSession(
        _ session: BackgroundSession,
        otherAudioActiveDidChange active: Bool
    )
    /// §5: the audio graph must be rebuilt. `recreate` means the
    /// `AVAudioEngine` itself is dead (media services reset) and a new one is
    /// needed. The session observes this; `AudioIO` owns the graph.
    func backgroundSession(
        _ session: BackgroundSession,
        didRequestEngineRebuild recreate: Bool
    )
}
```

- [ ] **Step 4: Add the activation-retry constants**

In `ios/Radio/Sources/RadioKit/RadioConfig.swift`, after the `Background` block:

```swift
    /// The always-hot session's own knobs (spec section 5 of the 2026-08-18
    /// seamless-headphone-audio design).
    public enum Session {
        /// Interruption and foreground recovery retry `setActive(true)` when
        /// the system answers `.isBusy` — the interrupting app has not finished
        /// letting go yet. Signal's pattern: 0.5 s apart, three times.
        public static let activationRetryDelay: TimeInterval = 0.5
        public static let activationRetryLimit = 3
    }
```

- [ ] **Step 5: Teach `FakeBackground` and `HeartbeatLogger` the new surface**

In `ios/Radio/Tests/RadioKitTests/Fakes.swift`, inside `final class FakeBackground`, after `setReceiving`:

```swift
    /// Every profile the engine asked for, in order. `applyProfile` is
    /// deliberately not diff-filtered here: the fake records the request, the
    /// real manager decides whether it changes anything.
    private(set) var appliedProfiles: [ModePolicy.Profile] = []

    func applyProfile(_ profile: ModePolicy.Profile) {
        appliedProfiles.append(profile)
    }

    /// Stands in for a route change the session observed and classified.
    func publishRoute(_ snapshot: AudioRouteSnapshot) {
        delegate?.backgroundSession(self, routeDidChange: snapshot)
    }

    /// Stands in for `isOtherAudioPlaying` changing.
    func publishOtherAudio(_ active: Bool) {
        delegate?.backgroundSession(self, otherAudioActiveDidChange: active)
    }

    /// Stands in for AVAudioEngineConfigurationChange / mediaServicesWereReset.
    func requestEngineRebuild(recreate: Bool) {
        delegate?.backgroundSession(self, didRequestEngineRebuild: recreate)
    }
```

In `ios/Radio/Sources/RadioKit/HeartbeatLogger.swift`, after the `isEngineRunning` property:

```swift
    /// §5: other audio is sampled "on the existing heartbeat tick". Installed
    /// by `AlwaysHotBackgroundManager` while the session is active, cleared when
    /// it is not. Called on the main queue, like every other timer callback
    /// here; the manager hops onto its own queue.
    public var onTick: (() -> Void)?
```

and at the end of `private func tick()`, after the existing `log.notice(...)`:

```swift
        onTick?()
```

- [ ] **Step 6: Rewrite `AlwaysHotBackgroundManager`**

Replace `ios/Radio/Sources/RadioKit/AlwaysHotBackgroundManager.swift` entirely with:

```swift
import AVFoundation
import Foundation
import os
#if canImport(UIKit)
import UIKit
#endif

/// The iOS background architecture (spec section 10.2), and the only
/// `BackgroundSession` there is. The app activates a `.playAndRecord` session
/// itself in the foreground and keeps the microphone pulling samples
/// continuously (see `AudioEngine`'s keep-alive tap), which counts as
/// background audio under the `audio` UIBackgroundMode — so the process legally
/// keeps running while locked, no entitlement required.
///
/// Since the 2026-08-18 seamless-headphone-audio design (§5) this class holds no
/// decisions at all. Six notifications arrive on whatever thread the system
/// chose; each is re-posted onto the engine queue, turned into an
/// `AudioSessionEvent`, and answered by `AudioSessionReactor.react` with the
/// next status and a list of actions. This class performs those actions and
/// nothing else. That is what closes the data race on `isActive`/`currentProfile`
/// the previous version had: the status is one value, mutated on one queue.
public final class AlwaysHotBackgroundManager: NSObject, BackgroundSession {

    public weak var delegate: BackgroundSessionDelegate?

    /// The `RadioEngine` queue. Every notification handler hops onto it before
    /// touching anything; every `BackgroundSession` method is already called on
    /// it, so none of them may dispatch back onto it synchronously.
    private let queue: DispatchQueue
    private var status = AudioSessionStatus()
    /// Diff state for the two upward channels. `nil` means "never reported", so
    /// the first sample always goes up.
    private var lastRouteSnapshot: AudioRouteSnapshot?
    private var lastOtherAudioActive: Bool?
    private var isObserving = false
    private let log = Logger(
        subsystem: RadioConfig.Logging.subsystem,
        category: "background"
    )

    public init(queue: DispatchQueue) {
        self.queue = queue
        super.init()
    }

    // MARK: - BackgroundSession

    public func activate() {
        observeNotifications()
        HeartbeatLogger.shared.onTick = { [weak self] in
            self?.queue.async { self?.sampleOtherAudioLocked() }
        }
        HeartbeatLogger.shared.start()
        handleLocked(.activationRequested)
        log.info("always-hot audio session activating")
        // The port's activation callback. Harmless at this point (nothing is
        // awaiting the session yet), delivered because the contract says the
        // engine learns about activation from here and nowhere else.
        delegate?.backgroundSessionDidActivateAudio(self)
    }

    public func deactivate() {
        NotificationCenter.default.removeObserver(self)
        isObserving = false
        HeartbeatLogger.shared.onTick = nil
        HeartbeatLogger.shared.sessionActive = false
        HeartbeatLogger.shared.stop()
        lastRouteSnapshot = nil
        lastOtherAudioActive = nil
        handleLocked(.deactivationRequested)
        delegate?.backgroundSessionDidDeactivateAudio(self)
    }

    public func requestBeginTransmitting() {
        guard status.isActive else {
            delegate?.backgroundSession(
                self,
                didFail: .backgroundFailed("always-hot session not active")
            )
            return
        }
        // The session is already hot — acknowledge immediately rather than
        // waiting for an activation that will never come. RadioEngine's
        // beginTransmitLocked() takes it from here.
        delegate?.backgroundSessionDidActivateAudio(self)
    }

    public func stopTransmitting() {
        // Nothing to release: the session stays hot between transmissions —
        // that continuity is the whole architecture. RadioEngine has already
        // stopped capture itself by the time it calls this.
    }

    public func setReceiving(_ receiving: Bool) {
        // The port exists so an implementation can activate the session for
        // playback; here it is always active, so there is nothing to do.
    }

    public func applyProfile(_ profile: ModePolicy.Profile) {
        handleLocked(.profileRequested(profile))
    }

    // MARK: - The table

    /// Caller is on `queue`.
    private func handleLocked(_ event: AudioSessionEvent) {
        let reaction = AudioSessionReactor.react(to: event, from: status)
        status = reaction.status
        HeartbeatLogger.shared.sessionActive = status.isActive
        for action in reaction.actions {
            perform(action)
        }
    }

    /// Caller is on `queue`.
    private func perform(_ action: AudioSessionAction) {
        let session = AVAudioSession.sharedInstance()
        switch action {
        case let .applyConfiguration(profile):
            applyConfigurationLocked(AudioSessionConfiguration.of(profile), on: session)
        case .activate:
            activateLocked(retriesLeft: RadioConfig.Session.activationRetryLimit)
        case .deactivate:
            do {
                try session.setActive(false, options: .notifyOthersOnDeactivation)
            } catch {
                log.error("deactivation failed: \(error, privacy: .public)")
            }
        case .maximizeInputGain:
            maximizeInputGain(session)
        case .syncSpeakerOverride:
            syncSpeakerOverrideLocked(on: session)
        case .publishRoute:
            publishRouteLocked(on: session)
        case .sampleOtherAudio:
            sampleOtherAudioLocked()
        case .rebuildEngine:
            delegate?.backgroundSession(self, didRequestEngineRebuild: false)
        case .recreateEngine:
            delegate?.backgroundSession(self, didRequestEngineRebuild: true)
        }
    }

    // MARK: - Actions

    /// §5's "applied whole (diff-only: skip if already applied)". The diff is
    /// also the recursion guard the old `isApplyingProfile` flag used to be:
    /// our own `setCategory` emits a `.categoryChange`, whose row re-applies
    /// the current configuration — and finds it already in force, so it stops.
    private func applyConfigurationLocked(
        _ configuration: AudioSessionConfiguration,
        on session: AVAudioSession
    ) {
        guard
            !configuration.matches(
                category: session.category,
                mode: session.mode,
                options: session.categoryOptions
            )
        else {
            return
        }
        do {
            try session.setCategory(
                configuration.category,
                mode: configuration.mode,
                options: configuration.options
            )
            HeartbeatLogger.shared.record("session config \(configuration.logName)")
        } catch {
            // Never fatal: the session keeps whatever it had, and the next
            // route change or recovery tries again.
            HeartbeatLogger.shared.record(
                "session config \(configuration.logName) FAILED: \(error)"
            )
        }
    }

    /// §5's `setActive` with retry on `.isBusy` (0.5 s × 3, Signal's pattern).
    /// Never blocks the queue — the radio's own work runs on it.
    private func activateLocked(retriesLeft: Int) {
        do {
            try AVAudioSession.sharedInstance().setActive(true)
            handleLocked(.activationSucceeded)
        } catch let error as NSError
            where error.code == AVAudioSession.ErrorCode.isBusy.rawValue && retriesLeft > 0 {
            HeartbeatLogger.shared.record(
                "session busy, retrying activation (\(retriesLeft) left)"
            )
            queue.asyncAfter(deadline: .now() + RadioConfig.Session.activationRetryDelay) {
                [weak self] in
                self?.activateLocked(retriesLeft: retriesLeft - 1)
            }
        } catch {
            // Expected while backgrounded: iOS refuses activation from there.
            // Wanted visible in the log, not swallowed.
            HeartbeatLogger.shared.record("session activation FAILED: \(error)")
            handleLocked(.activationFailed)
        }
    }

    /// §5's on-demand speaker, and the wired-headphones fix: `.speaker` only
    /// when the outputs are solely the built-in receiver, `.none` the moment any
    /// external output is present. A pure function of the current outputs —
    /// never of a classification. Failure is logged, not fatal: audio still
    /// flows out of the receiver.
    private func syncSpeakerOverrideLocked(on session: AVAudioSession) {
        let override = AudioSessionConfiguration.speakerOverride(
            forOutputs: AudioPort.ports(from: session.currentRoute.outputs)
        )
        do {
            try session.overrideOutputAudioPort(override)
        } catch {
            HeartbeatLogger.shared.record("speaker override FAILED: \(error)")
        }
    }

    /// §8's route, classified and handed upward, diff-only.
    private func publishRouteLocked(on session: AVAudioSession) {
        let route = session.currentRoute
        let snapshot = AudioRouteClassifier.snapshot(
            outputs: AudioPort.ports(from: route.outputs),
            inputs: AudioPort.ports(from: route.inputs)
        )
        guard snapshot != lastRouteSnapshot else { return }
        lastRouteSnapshot = snapshot
        HeartbeatLogger.shared.record(
            "route kind=\(snapshot.kind.rawValue) "
                + "label=\(snapshot.label ?? "-") "
                + "voiceLink=\(snapshot.requiresVoiceLink ? "required" : "no")"
                + "/\(snapshot.providesVoiceLink ? "live" : "no") "
                + "in=\(AudioRouteFormatter.portTypes(route.inputs)) "
                + "out=\(AudioRouteFormatter.portTypes(route.outputs))"
        )
        delegate?.backgroundSession(self, routeDidChange: snapshot)
    }

    /// §5's other-audio detection. Our own playback is not "other audio" — the
    /// API already excludes the querying session — so this is exactly D1's
    /// "whether another app is playing audio".
    private func sampleOtherAudioLocked() {
        guard status.isActive else { return }
        let active = AVAudioSession.sharedInstance().isOtherAudioPlaying
        guard active != lastOtherAudioActive else { return }
        lastOtherAudioActive = active
        HeartbeatLogger.shared.record("other audio active=\(active)")
        delegate?.backgroundSession(self, otherAudioActiveDidChange: active)
    }

    /// Quiet-transmit investigation (2026-08-17): iPhone→Android audio is
    /// quiet, so the first lever is the session's own input gain, when the
    /// current route exposes one (the built-in mic on recent iPhones usually
    /// does not — the answer lands in heartbeat.log either way). Runs after
    /// activation because the gain belongs to the resolved input route.
    private func maximizeInputGain(_ session: AVAudioSession) {
        let before = session.inputGain
        guard session.isInputGainSettable else {
            HeartbeatLogger.shared.record(
                String(format: "input gain not settable, value=%.2f", before)
            )
            return
        }
        guard before < 1.0 else {
            HeartbeatLogger.shared.record(
                String(format: "input gain already %.2f", before)
            )
            return
        }
        do {
            try session.setInputGain(1.0)
            HeartbeatLogger.shared.record(
                String(
                    format: "input gain raised %.2f -> %.2f",
                    before, session.inputGain
                )
            )
        } catch {
            HeartbeatLogger.shared.record("input gain set FAILED: \(error)")
        }
    }

    // MARK: - Observers (§5)

    /// Six registrations for §5's four observers plus its two named triggers.
    /// Every one of them does the same two things: turn the notification into an
    /// event, and hop onto the engine queue. No handler reads or writes manager
    /// state on the thread the system delivered it on.
    private func observeNotifications() {
        guard !isObserving else { return }
        isObserving = true
        let center = NotificationCenter.default
        let session = AVAudioSession.sharedInstance()

        center.addObserver(
            self, selector: #selector(handleRouteChange(_:)),
            name: AVAudioSession.routeChangeNotification, object: session
        )
        center.addObserver(
            self, selector: #selector(handleInterruption(_:)),
            name: AVAudioSession.interruptionNotification, object: session
        )
        center.addObserver(
            self, selector: #selector(handleMediaServicesReset(_:)),
            name: AVAudioSession.mediaServicesWereResetNotification, object: session
        )
        center.addObserver(
            self, selector: #selector(handleSilenceSecondaryAudioHint(_:)),
            name: AVAudioSession.silenceSecondaryAudioHintNotification, object: session
        )
        // `object: nil` on purpose: the notification carries the AVAudioEngine
        // that changed, and `AudioIO` replaces that object outright after a
        // media-services reset. An observer registered against one instance
        // would go deaf exactly when it matters most. There is one engine in
        // this process.
        center.addObserver(
            self, selector: #selector(handleEngineConfigurationChange(_:)),
            name: .AVAudioEngineConfigurationChange, object: nil
        )
        #if canImport(UIKit)
        center.addObserver(
            self, selector: #selector(handleAppDidBecomeActive(_:)),
            name: UIApplication.didBecomeActiveNotification, object: nil
        )
        #endif
    }

    @objc private func handleRouteChange(_ notification: Notification) {
        let reasonRaw = notification.userInfo?[AVAudioSessionRouteChangeReasonKey]
            as? UInt ?? 0
        let reason = AVAudioSession.RouteChangeReason(rawValue: reasonRaw) ?? .unknown
        let route = AVAudioSession.sharedInstance().currentRoute
        HeartbeatLogger.shared.record(
            "route: reason=\(AudioRouteFormatter.name(of: reason)) "
                + "in=\(AudioRouteFormatter.portTypes(route.inputs)) "
                + "out=\(AudioRouteFormatter.portTypes(route.outputs))"
        )
        queue.async { [weak self] in
            self?.handleLocked(.routeChanged(reason: reason))
        }
    }

    @objc private func handleEngineConfigurationChange(_ notification: Notification) {
        // §5: a route change that alters the hardware sample rate (built-in
        // 48 kHz ↔ HFP 8/16 kHz) stops AVAudioEngine silently, and the
        // keep-alive tap dies with it — which is how a headset connecting while
        // the phone is locked used to suspend the whole radio.
        HeartbeatLogger.shared.record("engine configuration changed")
        queue.async { [weak self] in
            self?.handleLocked(.engineConfigurationChanged)
        }
    }

    @objc private func handleInterruption(_ notification: Notification) {
        guard
            let raw = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
            let type = AVAudioSession.InterruptionType(rawValue: raw)
        else { return }

        switch type {
        case .began:
            HeartbeatLogger.shared.record("interruption began")
            queue.async { [weak self] in self?.handleLocked(.interruptionBegan) }
        case .ended:
            let optionsRaw = notification.userInfo?[AVAudioSessionInterruptionOptionKey]
                as? UInt ?? 0
            let options = AVAudioSession.InterruptionOptions(rawValue: optionsRaw)
            // `shouldResume` is logged, not obeyed: it is advice about resuming
            // playback, and this session is the app's lifeline. §5 recovers on
            // `.ended` and, because `.ended` is not guaranteed at all, on
            // foregrounding too.
            HeartbeatLogger.shared.record(
                "interruption ended, shouldResume=\(options.contains(.shouldResume))"
            )
            queue.async { [weak self] in self?.handleLocked(.interruptionEnded) }
        @unknown default:
            break
        }
    }

    @objc private func handleMediaServicesReset(_ notification: Notification) {
        HeartbeatLogger.shared.record("media services were reset")
        queue.async { [weak self] in self?.handleLocked(.mediaServicesWereReset) }
    }

    @objc private func handleSilenceSecondaryAudioHint(_ notification: Notification) {
        queue.async { [weak self] in self?.handleLocked(.silenceSecondaryAudioHint) }
    }

    #if canImport(UIKit)
    @objc private func handleAppDidBecomeActive(_ notification: Notification) {
        queue.async { [weak self] in self?.handleLocked(.appDidBecomeActive) }
    }
    #endif
}
```

- [ ] **Step 7: Pass the engine queue in `RadioAssembly`**

In `ios/Radio/Sources/RadioKit/RadioAssembly.swift`, replace line 20:

```swift
        // §5: every session observer re-posts onto this queue, which is the
        // engine's — that shared serial queue is what closes the data race the
        // previous session manager had on its own state.
        let background = AlwaysHotBackgroundManager(queue: engineQueue)
```

- [ ] **Step 8: Implement the three new delegate methods on `RadioEngine`**

In `ios/Radio/Sources/RadioKit/RadioEngine.swift`, in `extension RadioEngine: BackgroundSessionDelegate`, add:

```swift
    /// §8's route. Task 5 feeds it to the §7 policy and Task 6 publishes it into
    /// `RadioState`; for now it is only recorded, so the port is complete and
    /// the wiring is one reviewable change on its own.
    public func backgroundSession(
        _ session: BackgroundSession,
        routeDidChange snapshot: AudioRouteSnapshot
    ) {
        queue.async { self.routeSnapshot = snapshot }
    }

    public func backgroundSession(
        _ session: BackgroundSession,
        otherAudioActiveDidChange active: Bool
    ) {
        queue.async { self.isOtherAudioActive = active }
    }

    /// §5's rebuild travels session → engine → audio: the session is what
    /// observes the notification, `AudioIO` is what owns the graph.
    public func backgroundSession(
        _ session: BackgroundSession,
        didRequestEngineRebuild recreate: Bool
    ) {
        queue.async { self.audio.rebuildEngine(recreate: recreate) }
    }
```

and the two fields, next to the other state at the top of the class:

```swift
    /// The current route as the session classified it (§8). Task 5 feeds it to
    /// the §7 policy; Task 6 publishes it.
    private var routeSnapshot = AudioRouteSnapshot(
        kind: .speaker, label: nil, requiresVoiceLink: false, providesVoiceLink: false
    )
    private var isOtherAudioActive = false
```

- [ ] **Step 9: Run the new engine test to verify it passes**

Run: `cd ios/Radio && DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild test -scheme RadioKit -destination 'platform=iOS Simulator,name=iPhone 17' -only-testing:RadioKitTests/RadioEngineTests`

Expected: PASS, including `testAnEngineRebuildRequestReachesTheAudioPort`.

Swift will warn that `routeSnapshot` and `isOtherAudioActive` are written but never read. That is expected for exactly one task: Task 5 reads both. If the warning is unacceptable to the compiler settings in use, keep the fields and add `_ = routeSnapshot` nowhere — a warning is not an error here, and inventing a fake reader would be worse.

- [ ] **Step 10: Run the whole gate**

```bash
pnpm typecheck && pnpm lint && pnpm test
(cd ios/Radio && DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild test -scheme RadioKit -destination 'platform=iOS Simulator,name=iPhone 17')
```

Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add ios/Radio/Sources/RadioKit/RadioPorts.swift \
        ios/Radio/Sources/RadioKit/RadioConfig.swift \
        ios/Radio/Sources/RadioKit/AlwaysHotBackgroundManager.swift \
        ios/Radio/Sources/RadioKit/HeartbeatLogger.swift \
        ios/Radio/Sources/RadioKit/RadioAssembly.swift \
        ios/Radio/Sources/RadioKit/RadioEngine.swift \
        ios/Radio/Tests/RadioKitTests/Fakes.swift \
        ios/Radio/Tests/RadioKitTests/RadioEngineTests.swift
git commit -m "feat(ios-audio): six observers, one queue, one table

AlwaysHotBackgroundManager stops deciding anything: every notification spec
section 5 names is re-posted onto the RadioEngine queue and answered by the
reaction table, which closes the isActive/currentProfile data race. Adds the
setActive isBusy retry, other-audio detection and route publication."
```

---

## Task 5: The merged §7 policy, wired

`RadioEngine` gains the merged `ModePolicy` and becomes the one place §7's inputs (route, other audio, radio activity, PTT) meet its outputs (apply a profile, play the grant tone, start capture). Nothing in `ModePolicy.swift` is touched: this task only calls it.

**Files:**
- Modify: `ios/Radio/Sources/RadioKit/RadioPorts.swift` (`RadioClock.nowMs`, `DispatchRadioClock`)
- Modify: `ios/Radio/Sources/RadioKit/RadioEngine.swift`
- Modify: `ios/Radio/Tests/RadioKitTests/Fakes.swift` (`ManualClock`)
- Create: `ios/Radio/Tests/RadioKitTests/RadioEngineModeTests.swift`

**Interfaces:**
- Consumes: `ModePolicy` (merged P1, read-only) — `Profile`, `AudioMode`, `MicSource`, `Action`, `Decision`, `Constants`, and the input methods `setAudioMode`, `setOtherAudioActive`, `setRadioActive`, `setRouteRequiresVoiceLink`, `pttPressed`, `pttReleased`, `voiceLinkEstablished`, `voiceLinkFailed`, `tick`, each `(…, nowMs: Int64) -> Decision`. Plus `BackgroundSession.applyProfile` (Task 4), `AudioIO.playGrantTone` (Task 2), `AudioRouteSnapshot` (Task 1).
- Produces: `RadioClock.nowMs`; on `ManualClock` the settable `nowMs` and `fireEarliest()`.

### How a decision is performed

`ModePolicy.Decision` carries three things, and each has exactly one destination:

- **`profile`** → `background.applyProfile(_:)`, but only when it differs from what was last applied. `ModePolicy.swift` states the iOS rule directly: "`raiseVoiceLink`/`dropVoiceLink` and a `Decision.profile` change are the same `setCategory` session-configuration call: apply the profile diff first and treat the raise/drop as satisfied by it, rather than performing the work twice."
- **`actions`** → in order. `raiseVoiceLink` and `dropVoiceLink` perform no session work (the profile diff above already did it); `raiseVoiceLink` only records that a raise is in flight, so a route change can answer it. `playGrantTone` → `audio.playGrantTone()`. `startCapture` → the existing `background.requestBeginTransmitting()` handshake, unchanged.
- **`nextWakeupMs`** → one `RadioCancellable` from the injected clock, cancelled and re-armed on every decision. `nil` obliges the caller to cancel, not merely to skip arming — the policy's own documentation says so.

The engine answers a raise with `voiceLinkEstablished` when a route change reports `providesVoiceLink`, and with `voiceLinkFailed` when the route stops requiring one at all (the accessory vanished) — the second is required by `ModePolicy`'s own comment: "If a raise is in flight when the route it targeted disappears, the caller must report `voiceLinkFailed` — otherwise the policy will wait out the full 4 s grant timeout."

- [ ] **Step 1: Write the failing §7 wiring tests**

Create `ios/Radio/Tests/RadioKitTests/RadioEngineModeTests.swift`:

```swift
import XCTest
@testable import RadioKit

/// §7 as the engine performs it (§10 iOS: the (event, state) → actions story,
/// through the ports' fakes). The transition table itself is P1's
/// `ModePolicyTests`; this asserts that the engine feeds it the right inputs
/// and performs the right outputs.
final class RadioEngineModeTests: XCTestCase {

    private var transport: FakeTransport!
    private var audio: FakeAudio!
    private var ptt: FakePtt!
    private var background: FakeBackground!
    private var clock: ManualClock!
    private var queue: DispatchQueue!
    private var engine: RadioEngine!

    override func setUp() {
        super.setUp()
        transport = FakeTransport()
        audio = FakeAudio()
        ptt = FakePtt()
        background = FakeBackground()
        clock = ManualClock()
        queue = DispatchQueue(label: "radio.engine.mode.tests")
        engine = RadioEngine(
            transport: transport,
            audio: audio,
            ptt: ptt,
            background: background,
            clock: clock,
            queue: queue
        )
        engine.startRadio()
        flush()
    }

    private func flush() {
        queue.sync {}
    }

    /// Advance the injected monotonic clock and fire the soonest timer — the
    /// policy's wakeup, never the 120 s safety cap that is armed alongside it.
    private func advance(to nowMs: Int64) {
        clock.nowMs = nowMs
        clock.fireEarliest()
        flush()
    }

    private let a2dp = AudioRouteSnapshot(
        kind: .bluetooth, label: "AirPods Pro",
        requiresVoiceLink: true, providesVoiceLink: false
    )
    private let hfp = AudioRouteSnapshot(
        kind: .bluetooth, label: "AirPods Pro",
        requiresVoiceLink: true, providesVoiceLink: true
    )
    private let wired = AudioRouteSnapshot(
        kind: .wired, label: nil, requiresVoiceLink: false, providesVoiceLink: false
    )
    private let speaker = AudioRouteSnapshot(
        kind: .speaker, label: nil, requiresVoiceLink: false, providesVoiceLink: false
    )

    /// §9 row 3: headset connected, the user starts music → MEDIA.
    private func reachMedia() {
        background.publishRoute(a2dp)
        flush()
        background.publishOtherAudio(true)
        flush()
        advance(to: ModePolicy.Constants.otherAudioToMediaMs)
        XCTAssertEqual(background.appliedProfiles, [.media])
    }

    // MARK: - Mode switching (§7's hysteresis, §9 rows 3 and 6)

    func testMusicForTwoSecondsMovesTheHeadsetToMedia() {
        reachMedia()
    }

    func testMusicBelowTheDwellChangesNothing() {
        background.publishRoute(a2dp)
        flush()
        background.publishOtherAudio(true)
        flush()

        clock.nowMs = ModePolicy.Constants.otherAudioToMediaMs - 1
        clock.fireEarliest()
        flush()

        XCTAssertEqual(background.appliedProfiles, [])
    }

    func testMusicStoppingComesBackToVoiceAfterThirtySeconds() {
        // §9 row 6: "after 30 s silence, back to VOICE (SCO held, instant PTT)".
        reachMedia()
        background.publishOtherAudio(false)
        flush()

        let silentAt = ModePolicy.Constants.otherAudioToMediaMs
        advance(to: silentAt + ModePolicy.Constants.otherAudioToVoiceMs)

        XCTAssertEqual(background.appliedProfiles, [.media, .voice])
    }

    func testAModeSwitchQueuesUntilTheRadioIsIdle() {
        // §7: "switches never run during receive or transmit (they queue for
        // idle)". §9 row 4: incoming voice during music causes no switch.
        background.publishRoute(a2dp)
        flush()
        transport.delegate?.transport(transport, didStartIncomingAudio: "peer-a")
        flush()
        background.publishOtherAudio(true)
        flush()
        advance(to: ModePolicy.Constants.otherAudioToMediaMs)

        XCTAssertEqual(background.appliedProfiles, [], "no switch while receiving")

        transport.delegate?.transport(transport, didStopIncomingAudio: "peer-a")
        flush()

        XCTAssertEqual(background.appliedProfiles, [.media])
    }

    func testTheAutomaticPolicyIsInertOnARouteWithNoProfileConflict() {
        // §7: "non-BT-Classic routes have no profile conflict: the policy is
        // inert there". Wired headphones plus music must not drop the session
        // into MEDIA.
        background.publishRoute(wired)
        flush()
        background.publishOtherAudio(true)
        flush()
        advance(to: ModePolicy.Constants.otherAudioToMediaMs)

        XCTAssertEqual(background.appliedProfiles, [])
    }

    // MARK: - PTT (§7's "press → tone → talk", D2)

    func testPressOnAWiredRouteTonesAndCapturesImmediately() {
        background.publishRoute(wired)
        flush()

        ptt.delegate?.pttSourceDidPress(ptt)
        flush()

        XCTAssertEqual(audio.grantTones, 1)
        XCTAssertEqual(background.transmitRequests, 1)
        XCTAssertEqual(background.appliedProfiles, [], "already in VOICE, nothing to apply")

        background.grantAudioSession()
        flush()
        XCTAssertTrue(audio.isCapturing)
    }

    func testPressInMediaRaisesTheLinkAndWaitsForTheHeadsetMic() {
        // §9 row 5 / D2: SCO raised → grant tone → headset mic.
        reachMedia()

        ptt.delegate?.pttSourceDidPress(ptt)
        flush()

        XCTAssertEqual(background.appliedProfiles, [.media, .voice], "the raise IS the apply")
        XCTAssertEqual(audio.grantTones, 0, "no tone until the mic path is confirmed")
        XCTAssertEqual(background.transmitRequests, 0)

        background.publishRoute(hfp)
        flush()

        XCTAssertEqual(audio.grantTones, 1)
        XCTAssertEqual(background.transmitRequests, 1)

        background.grantAudioSession()
        flush()
        XCTAssertTrue(audio.isCapturing)
    }

    func testARaiseThatTimesOutTonesAndFallsBackToThePhoneMic() {
        // §7: "Timeout 4 s → grant tone + phone-mic fallback for this
        // transmission." The MEDIA configuration is restored BEFORE the tone,
        // so capture starts on the phone mic — D2 rejects a mid-transmission
        // mic swap.
        reachMedia()
        let pressedAt = ModePolicy.Constants.otherAudioToMediaMs
        ptt.delegate?.pttSourceDidPress(ptt)
        flush()

        advance(to: pressedAt + ModePolicy.Constants.voiceLinkGrantTimeoutMs)

        XCTAssertEqual(background.appliedProfiles, [.media, .voice, .media])
        XCTAssertEqual(audio.grantTones, 1)
        XCTAssertEqual(background.transmitRequests, 1)
    }

    func testTheRouteVanishingDuringARaiseFailsItWithoutWaitingOutTheTimeout() {
        reachMedia()

        ptt.delegate?.pttSourceDidPress(ptt)
        flush()
        background.publishRoute(speaker)
        flush()

        XCTAssertEqual(audio.grantTones, 1, "no four-second wait for a device that left")
        XCTAssertEqual(background.transmitRequests, 1)
    }

    func testTheRaisedLinkLingersAndTheNextPressIsInstant() {
        // §7: "After PTT release, hold the raised link for a 15 s linger;
        // further presses inside the window are instant."
        reachMedia()
        ptt.delegate?.pttSourceDidPress(ptt)
        flush()
        background.publishRoute(hfp)
        flush()
        background.grantAudioSession()
        flush()

        let releasedAt = ModePolicy.Constants.otherAudioToMediaMs
        clock.nowMs = releasedAt
        ptt.delegate?.pttSourceDidRelease(ptt)
        flush()

        XCTAssertEqual(
            background.appliedProfiles, [.media, .voice],
            "the link is held, not dropped"
        )

        clock.nowMs = releasedAt + 1_000
        ptt.delegate?.pttSourceDidPress(ptt)
        flush()

        XCTAssertEqual(audio.grantTones, 2, "instant inside the linger window")
        XCTAssertEqual(background.transmitRequests, 2)
    }

    func testLingerExpiryDropsTheLinkSoMusicResumes() {
        reachMedia()
        ptt.delegate?.pttSourceDidPress(ptt)
        flush()
        background.publishRoute(hfp)
        flush()
        background.grantAudioSession()
        flush()

        let releasedAt = ModePolicy.Constants.otherAudioToMediaMs
        clock.nowMs = releasedAt
        ptt.delegate?.pttSourceDidRelease(ptt)
        flush()

        advance(to: releasedAt + ModePolicy.Constants.voiceLinkLingerMs)

        XCTAssertEqual(background.appliedProfiles, [.media, .voice, .media])
    }

    func testReleasingBeforeTheLinkArrivesNeverTonesAndNeverCaptures() {
        reachMedia()
        ptt.delegate?.pttSourceDidPress(ptt)
        flush()
        ptt.delegate?.pttSourceDidRelease(ptt)
        flush()

        XCTAssertEqual(audio.grantTones, 0)
        XCTAssertEqual(background.transmitRequests, 0)
        XCTAssertFalse(audio.isCapturing)
        XCTAssertEqual(background.appliedProfiles, [.media, .voice, .media])
    }

    // MARK: - Lifetime

    func testStoppingTheRadioForgetsEveryPolicyDeadline() {
        reachMedia()
        engine.stopRadio()
        flush()
        background.publishOtherAudio(false)
        flush()

        let before = background.appliedProfiles
        advance(to: 1_000_000)
        XCTAssertEqual(background.appliedProfiles, before)
    }
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd ios/Radio && DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild test -scheme RadioKit -destination 'platform=iOS Simulator,name=iPhone 17' -only-testing:RadioKitTests/RadioEngineModeTests`

Expected: FAIL — `value of type 'ManualClock' has no member 'nowMs'`, `no member 'fireEarliest'`.

- [ ] **Step 3: Add `nowMs` to the clock port**

In `ios/Radio/Sources/RadioKit/RadioPorts.swift`, in the `// MARK: - Clock` block:

```swift
/// Injected so the 120 s safety cap is testable without waiting 120 s, and so
/// the §7 policy's deadlines are testable without waiting 30 s.
public protocol RadioClock: AnyObject {
    /// Absolute monotonic milliseconds — what `ModePolicy` takes on every call.
    /// Never a wall clock: a system time change must not move a dwell deadline.
    var nowMs: Int64 { get }

    func schedule(after seconds: TimeInterval, _ block: @escaping () -> Void) -> RadioCancellable
}
```

and in `DispatchRadioClock`, before `schedule`:

```swift
    public var nowMs: Int64 {
        Int64(DispatchTime.now().uptimeNanoseconds / 1_000_000)
    }
```

In `ios/Radio/Tests/RadioKitTests/Fakes.swift`, in `ManualClock`:

```swift
    /// The monotonic clock the engine reads. Tests set it, then fire.
    var nowMs: Int64 = 0

    /// Fires only the soonest pending timer. A PTT press arms two — the 120 s
    /// safety cap and the policy's next wakeup — and a test that wants the
    /// policy deadline must not also trip the cap.
    func fireEarliest() {
        guard
            let index = pending.indices.min(by: { pending[$0].seconds < pending[$1].seconds })
        else {
            return
        }
        let entry = pending.remove(at: index)
        entry.block()
    }
```

- [ ] **Step 4: Wire the policy into `RadioEngine`**

In `ios/Radio/Sources/RadioKit/RadioEngine.swift`:

Add to the state block at the top of the class (next to `routeSnapshot` and `isOtherAudioActive` from Task 4):

```swift
    /// §7, merged from P1 and never edited here. Replaced wholesale on
    /// `stopRadio` — it holds dwell and PTT state that must not survive a power
    /// cycle, and P1's file owns its own reset semantics (there are none).
    private var policy = ModePolicy()
    /// The policy's `nextWakeupMs`, as one cancellable timer. nil obliges us to
    /// cancel, not merely to skip arming.
    private var policyTimer: RadioCancellable?
    /// What was last handed to `background.applyProfile`. §5 applies diff-only.
    private var appliedProfile: ModePolicy.Profile = .voice
    /// A press is outstanding. Distinct from `state.transmitting`, because §7
    /// puts a raise (up to 4 s) between the press and the microphone.
    private var isPttHeld = false
    /// A `raiseVoiceLink` is in flight and a route change must answer it.
    private var isAwaitingVoiceLink = false
```

Replace `startTransmitLocked()` with:

```swift
    private func startTransmitLocked() {
        guard isStarted, state.status != .error else { return }
        guard !state.transmitting, !isAwaitingAudioSession, !isPttHeld else { return }

        isPttHeld = true
        // Armed at the press, not at the microphone: §7 puts a raise of up to
        // 4 s in between, and a stuck button during a raise is still stuck.
        armSafetyCapLocked()
        performLocked(policy.pttPressed(nowMs: clock.nowMs))
        log.info("transmit requested")
    }
```

Replace `stopTransmitLocked()`'s opening with:

```swift
    private func stopTransmitLocked() {
        cancelSafetyCapLocked()
        if isPttHeld {
            isPttHeld = false
            isAwaitingVoiceLink = false
            performLocked(policy.pttReleased(nowMs: clock.nowMs))
        }
        guard state.transmitting || isAwaitingAudioSession else { return }
```

and its tail, replacing `log.info("transmit stopped")`:

```swift
        if state.transmitting {
            state.transmitting = false
            emitStateLocked()
        }
        syncRadioActiveLocked()
        log.info("transmit stopped")
    }
```

In `beginTransmitLocked()`, after `state.transmitting = true; emitStateLocked()`, add `syncRadioActiveLocked()`.

Add the policy plumbing in a new `// MARK: - Mode policy (§7)` section before `// MARK: - Emission`:

```swift
    // MARK: - Mode policy (§7)

    /// One decision, performed. `ModePolicy.swift` states the iOS rule this
    /// follows: on iOS `raiseVoiceLink`/`dropVoiceLink` and a `Decision.profile`
    /// change are the same `setCategory` call, so the profile diff is applied
    /// first and the raise/drop is treated as satisfied by it.
    private func performLocked(_ decision: ModePolicy.Decision) {
        if decision.profile != appliedProfile {
            appliedProfile = decision.profile
            background.applyProfile(decision.profile)
        }

        for action in decision.actions {
            switch action {
            case .raiseVoiceLink:
                // The session work is the profile apply above; all that is left
                // is to remember that a route change owes us an answer.
                isAwaitingVoiceLink = true
            case .dropVoiceLink:
                isAwaitingVoiceLink = false
            case .playGrantTone:
                audio.playGrantTone()
            case let .startCapture(source):
                isAwaitingVoiceLink = false
                // §5 has no second microphone mechanism and wants none: the
                // applied configuration decides which mic the input node
                // resolves to, and the policy restored the base configuration
                // before emitting this. The source is recorded as evidence.
                HeartbeatLogger.shared.record(
                    "tx mic=\(source == .routeDefault ? "route" : "phone")"
                )
                isAwaitingAudioSession = true
                background.requestBeginTransmitting()
            }
        }

        scheduleTickLocked(decision.nextWakeupMs)
    }

    private func scheduleTickLocked(_ nextWakeupMs: Int64?) {
        policyTimer?.cancel()
        policyTimer = nil
        guard let nextWakeupMs else { return }
        let delay = max(0, Double(nextWakeupMs - clock.nowMs) / 1_000)
        policyTimer = clock.schedule(after: delay) { [weak self] in
            guard let self else { return }
            self.queue.async {
                self.performLocked(self.policy.tick(nowMs: self.clock.nowMs))
            }
        }
    }

    /// §7's radio-idle gate. Fed from the engine's own truth rather than from
    /// the button: a transmission also ends on the 120 s safety cap.
    private func syncRadioActiveLocked() {
        performLocked(
            policy.setRadioActive(state.transmitting || state.receiving, nowMs: clock.nowMs)
        )
    }
```

In `startRadioLocked()`, after `background.activate()`:

```swift
        // The route and the other-audio state arrive from the session's own
        // publication (they are delivered on this queue, after this returns).
        performLocked(policy.setRadioActive(false, nowMs: clock.nowMs))
```

In `stopRadioLocked()`, before `state = RadioState(...)`:

```swift
        policyTimer?.cancel()
        policyTimer = nil
        policy = ModePolicy()
        appliedProfile = .voice
        isPttHeld = false
        isAwaitingVoiceLink = false
        routeSnapshot = AudioRouteSnapshot(
            kind: .speaker, label: nil, requiresVoiceLink: false, providesVoiceLink: false
        )
        isOtherAudioActive = false
```

In the two transport receive handlers, after each `emitStateLocked()` that flips `state.receiving`, add `self.syncRadioActiveLocked()`.

Replace the two Task 4 delegate stubs with the real feeds:

```swift
    public func backgroundSession(
        _ session: BackgroundSession,
        routeDidChange snapshot: AudioRouteSnapshot
    ) {
        queue.async {
            self.routeSnapshot = snapshot
            self.performLocked(
                self.policy.setRouteRequiresVoiceLink(
                    snapshot.requiresVoiceLink, nowMs: self.clock.nowMs
                )
            )
            guard self.isAwaitingVoiceLink else { return }
            if snapshot.providesVoiceLink {
                // §7: the tone waits for the headset mic path to be confirmed.
                self.performLocked(self.policy.voiceLinkEstablished(nowMs: self.clock.nowMs))
            } else if !snapshot.requiresVoiceLink {
                // The accessory the raise targeted is gone. `ModePolicy`
                // requires this to be reported, or it waits out the whole 4 s.
                self.performLocked(self.policy.voiceLinkFailed(nowMs: self.clock.nowMs))
            }
        }
    }

    public func backgroundSession(
        _ session: BackgroundSession,
        otherAudioActiveDidChange active: Bool
    ) {
        queue.async {
            self.isOtherAudioActive = active
            self.performLocked(self.policy.setOtherAudioActive(active, nowMs: self.clock.nowMs))
        }
    }
```

- [ ] **Step 5: Run the §7 wiring tests to verify they pass**

Run: `cd ios/Radio && DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild test -scheme RadioKit -destination 'platform=iOS Simulator,name=iPhone 17' -only-testing:RadioKitTests/RadioEngineModeTests`

Expected: PASS, every test in `RadioEngineModeTests`.

- [ ] **Step 6: Run the whole gate**

```bash
pnpm typecheck && pnpm lint && pnpm test
(cd ios/Radio && DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild test -scheme RadioKit -destination 'platform=iOS Simulator,name=iPhone 17')
```

Expected: PASS. `RadioEngineTests` is unchanged and still green — every one of its PTT tests goes through the policy now and reaches the same handshake, because a press with no route published is a press on a route that needs no voice link.

- [ ] **Step 7: Commit**

```bash
git add ios/Radio/Sources/RadioKit/RadioPorts.swift \
        ios/Radio/Sources/RadioKit/RadioEngine.swift \
        ios/Radio/Tests/RadioKitTests/Fakes.swift \
        ios/Radio/Tests/RadioKitTests/RadioEngineModeTests.swift
git commit -m "feat(ios-audio): wire the merged mode policy into the engine

RadioEngine feeds spec section 7 its inputs (route, other audio, radio
activity, PTT) and performs its outputs (profile apply, grant tone, capture).
ModePolicy.swift itself is untouched — it is P1's contract."
```

---

## Task 6: `audioRoute` and `audioMode`, published for real

Puts §8's two fields on `RadioState`, persists the setting in UserDefaults on the `PttBindingStore` pattern, and deletes P2's two compile-keeping placeholders from the bridge. This is the task that touches `ios/Oru/`, so it is the first one whose verification includes the app-workspace build.

**Files:**
- Create: `ios/Radio/Sources/RadioKit/AudioModeStore.swift`
- Create: `ios/Radio/Tests/RadioKitTests/AudioModeStoreTests.swift`
- Modify: `ios/Radio/Sources/RadioKit/RadioConfig.swift` (`Session.audioModeDefaultsKey`)
- Modify: `ios/Radio/Sources/RadioKit/RadioState.swift`
- Modify: `ios/Radio/Sources/RadioKit/RadioEngine.swift`
- Modify: `ios/Radio/Sources/RadioKit/SpikeCommandServer.swift` (`describe`)
- Modify: `ios/Oru/RadioBridge.swift`
- Modify: `ios/Radio/Tests/RadioKitTests/RadioEngineModeTests.swift`

**Interfaces:**
- Consumes: `AudioRoute`, `AudioRoute.Kind`, `AudioRoute.Mode` (Task 1); `ModePolicy.AudioMode` (merged P1); `specs/NativeRadio.ts`'s `NativeAudioRoute` / `NativeRadioState` (merged P2 — the contract, not a file this plan edits).
- Produces: `AudioModeSetting`, `AudioModeStore`, `RadioState.audioRoute`, `RadioState.audioMode`, `RadioEngine.setAudioMode(_:)`, `RadioConfig.Session.audioModeDefaultsKey`.

### The §8 contract this implements, verbatim

`specs/NativeRadio.ts` (merged P2) types both fields as **required** on every `NativeRadioState`:

```ts
export type NativeAudioRoute = {
  kind: 'speaker' | 'wired' | 'bluetooth' | 'usb';
  label?: string;        // Bluetooth routes only; absent, never empty
  mode: 'voice' | 'media';
};
// on NativeRadioState:
audioRoute: NativeAudioRoute;
audioMode: 'auto' | 'voice' | 'media';
```

and `setAudioMode(mode: string): Promise<void>` "stores the setting natively (UserDefaults / SharedPreferences, the `PttBindingStore` pattern) and applies it. Must emit `onStateChanged` before resolving." `mode` is `string` and not the union because Codegen accepts string-literal unions in type aliases, not in method parameters.

- [ ] **Step 1: Write the failing persistence test**

Create `ios/Radio/Tests/RadioKitTests/AudioModeStoreTests.swift`:

```swift
import XCTest
@testable import RadioKit

/// §8's persisted setting, on the `PttBindingStore` pattern (spec section 9.2's
/// precedent): the native side owns the storage, JavaScript mirrors it.
final class AudioModeStoreTests: XCTestCase {

    private var defaults: UserDefaults!
    private var suiteName: String!

    override func setUp() {
        super.setUp()
        suiteName = "audio.mode.tests.\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suiteName)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suiteName)
        defaults = nil
        super.tearDown()
    }

    func testTheDefaultIsAuto() {
        // §8: "New persisted setting `audioMode` … (default `auto`)".
        XCTAssertEqual(AudioModeStore(defaults: defaults).load(), .auto)
    }

    func testASavedSettingSurvivesAFreshStore() {
        AudioModeStore(defaults: defaults).save(.media)
        XCTAssertEqual(AudioModeStore(defaults: defaults).load(), .media)
    }

    func testEverySettingRoundTrips() {
        let store = AudioModeStore(defaults: defaults)
        for setting in [AudioModeSetting.auto, .voice, .media] {
            store.save(setting)
            XCTAssertEqual(store.load(), setting)
        }
    }

    func testGarbageInTheDefaultsReadsAsAuto() {
        defaults.set("loudspeaker", forKey: RadioConfig.Session.audioModeDefaultsKey)
        XCTAssertEqual(AudioModeStore(defaults: defaults).load(), .auto)
    }

    func testTheStoredValueIsTheContractString() {
        // The same three strings `specs/NativeRadio.ts` publishes, so a value
        // read out of the defaults is directly the wire value.
        AudioModeStore(defaults: defaults).save(.voice)
        XCTAssertEqual(
            defaults.string(forKey: RadioConfig.Session.audioModeDefaultsKey), "voice"
        )
    }

    func testEachSettingMapsToItsPolicyMode() {
        XCTAssertEqual(AudioModeSetting.auto.policyMode, .auto)
        XCTAssertEqual(AudioModeSetting.voice.policyMode, .voice)
        XCTAssertEqual(AudioModeSetting.media.policyMode, .media)
    }
}
```

- [ ] **Step 2: Write the failing engine tests for the two published fields**

Append to `ios/Radio/Tests/RadioKitTests/RadioEngineModeTests.swift`, inside the class:

```swift
    // MARK: - §8 publication

    private func currentState() -> RadioState {
        var captured = RadioState()
        let done = expectation(description: "state")
        engine.getState { state in
            captured = state
            done.fulfill()
        }
        wait(for: [done], timeout: 1)
        return captured
    }

    func testTheRouteIsPublishedIntoState() {
        background.publishRoute(hfp)
        flush()

        let route = currentState().audioRoute
        XCTAssertEqual(route.kind, .bluetooth)
        XCTAssertEqual(route.label, "AirPods Pro")
        XCTAssertEqual(route.mode, .voice)
    }

    func testTheModeFollowsTheAppliedProfile() {
        reachMedia()
        XCTAssertEqual(currentState().audioRoute.mode, .media)
    }

    func testPinningTheModeAppliesTheProfileAndIsPublished() {
        // §7: "`voice`/`media` pin the profile".
        background.publishRoute(a2dp)
        flush()

        engine.setAudioMode(.media)
        flush()

        XCTAssertEqual(background.appliedProfiles, [.media])
        XCTAssertEqual(currentState().audioMode, .media)
        XCTAssertEqual(currentState().audioRoute.mode, .media)
    }

    func testAPinnedModeSurvivesAPowerCycle() {
        engine.setAudioMode(.voice)
        flush()
        engine.stopRadio()
        flush()
        engine.startRadio()
        flush()

        XCTAssertEqual(currentState().audioMode, .voice)
    }
```

and give the test's engine its own defaults suite, by replacing the `engine = RadioEngine(...)` line in `setUp` with:

```swift
        suiteName = "radio.engine.mode.tests.\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suiteName)!
        engine = RadioEngine(
            transport: transport,
            audio: audio,
            ptt: ptt,
            background: background,
            clock: clock,
            queue: queue,
            audioModeStore: AudioModeStore(defaults: defaults)
        )
```

with the two fields declared alongside the others and cleaned up in `tearDown`:

```swift
    private var defaults: UserDefaults!
    private var suiteName: String!

    override func tearDown() {
        defaults.removePersistentDomain(forName: suiteName)
        defaults = nil
        super.tearDown()
    }
```

- [ ] **Step 3: Run both to verify they fail**

Run: `cd ios/Radio && DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild test -scheme RadioKit -destination 'platform=iOS Simulator,name=iPhone 17' -only-testing:RadioKitTests/AudioModeStoreTests -only-testing:RadioKitTests/RadioEngineModeTests`

Expected: FAIL — `cannot find 'AudioModeStore' in scope`, `value of type 'RadioState' has no member 'audioRoute'`.

- [ ] **Step 4: Write `AudioModeStore.swift` and its constant**

In `ios/Radio/Sources/RadioKit/RadioConfig.swift`, inside the `Session` block:

```swift
        /// §8's persisted setting. The native side owns the storage — there is
        /// no JavaScript store in this app and adding one would move
        /// package.json for no benefit (the `PttBindingStore` precedent).
        public static let audioModeDefaultsKey = "radio.audio.mode"
```

Create `ios/Radio/Sources/RadioKit/AudioModeStore.swift`:

```swift
import Foundation

/// §8's `audioMode` setting. `auto` runs the §7 policy; `voice` and `media` pin
/// the profile (a PTT press still raises the voice link inside a pinned
/// `media` — §7 says so by name).
///
/// The raw values are the contract strings `specs/NativeRadio.ts` publishes, so
/// a value read out of UserDefaults is directly the value that crosses the
/// bridge. `ModePolicy.AudioMode` is the same three cases without raw values;
/// the mapping lives here because `ModePolicy.swift` is merged P1 and is never
/// edited by this plan.
public enum AudioModeSetting: String, Equatable {
    case auto
    case voice
    case media

    public var policyMode: ModePolicy.AudioMode {
        switch self {
        case .auto: return .auto
        case .voice: return .voice
        case .media: return .media
        }
    }
}

/// The setting outlives radio restarts and app launches, exactly as the PTT
/// binding does (spec section 9.2).
public final class AudioModeStore {
    private let defaults: UserDefaults

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    /// §8's default is `auto`, and so is the answer to anything unreadable —
    /// a setting nobody can parse must not leave the radio pinned.
    public func load() -> AudioModeSetting {
        guard
            let raw = defaults.string(forKey: RadioConfig.Session.audioModeDefaultsKey),
            let setting = AudioModeSetting(rawValue: raw)
        else {
            return .auto
        }
        return setting
    }

    public func save(_ setting: AudioModeSetting) {
        defaults.set(setting.rawValue, forKey: RadioConfig.Session.audioModeDefaultsKey)
    }
}
```

- [ ] **Step 5: Put the two fields on `RadioState`**

In `ios/Radio/Sources/RadioKit/RadioState.swift`, in `struct RadioState`, add the properties after `pttButton` and before `pttPairing`, extend the initialiser in the same positions, and extend `asDictionary`:

```swift
    public var pttButton: PttButtonState
    /// §8, always present: there is always a route in use.
    public var audioRoute: AudioRoute
    /// §8's persisted setting, published back so JavaScript mirrors the engine
    /// rather than guessing. Never the same thing as `audioRoute.mode`: `auto`
    /// is not a profile.
    public var audioMode: AudioModeSetting
    public var pttPairing: PttPairingState?

    public init(
        status: Status = .starting,
        nearbyCount: Int = 0,
        transmitting: Bool = false,
        receiving: Bool = false,
        pttButton: PttButtonState = PttButtonState(),
        audioRoute: AudioRoute = AudioRoute(),
        audioMode: AudioModeSetting = .auto,
        pttPairing: PttPairingState? = nil
    ) {
        self.status = status
        self.nearbyCount = nearbyCount
        self.transmitting = transmitting
        self.receiving = receiving
        self.pttButton = pttButton
        self.audioRoute = audioRoute
        self.audioMode = audioMode
        self.pttPairing = pttPairing
    }

    public var asDictionary: [String: Any] {
        var dictionary: [String: Any] = [
            "status": status.rawValue,
            "nearbyCount": nearbyCount,
            "transmitting": transmitting,
            "receiving": receiving,
            "pttButton": pttButton.asDictionary,
            "audioRoute": audioRoute.asDictionary,
            "audioMode": audioMode.rawValue
        ]
        if let pttPairing {
            dictionary["pttPairing"] = pttPairing.asDictionary
        }
        return dictionary
    }
```

- [ ] **Step 6: Publish from `RadioEngine`**

In `ios/Radio/Sources/RadioKit/RadioEngine.swift`:

Add the store to the stored properties and the initialiser:

```swift
    private let audioModeStore: AudioModeStore
```

```swift
    public init(
        transport: RadioTransport,
        audio: AudioIO,
        ptt: PttSource,
        background: BackgroundSession,
        clock: RadioClock,
        queue: DispatchQueue,
        audioModeStore: AudioModeStore = AudioModeStore()
    ) {
        ...
        self.audioModeStore = audioModeStore
```

In `performLocked`, extend the profile branch:

```swift
        if decision.profile != appliedProfile {
            appliedProfile = decision.profile
            background.applyProfile(decision.profile)
            // §8's `mode` is the *effective* profile, so it moves with the
            // apply and not with the user's pin.
            state.audioRoute.mode = AudioRoute.Mode(decision.profile)
            emitStateLocked()
        }
```

In the route delegate, after `self.routeSnapshot = snapshot`:

```swift
            if self.state.audioRoute.kind != snapshot.kind
                || self.state.audioRoute.label != snapshot.label {
                self.state.audioRoute.kind = snapshot.kind
                self.state.audioRoute.label = snapshot.label
                self.emitStateLocked()
            }
```

In `startRadioLocked()`, replace the Task 5 priming line with:

```swift
        state.audioMode = audioModeStore.load()
        performLocked(policy.setAudioMode(state.audioMode.policyMode, nowMs: clock.nowMs))
        performLocked(policy.setRadioActive(false, nowMs: clock.nowMs))
```

In `stopRadioLocked()`, replace the state reset with one that keeps the persisted setting and forgets the route:

```swift
        state = RadioState(
            status: .starting,
            pttButton: ptt.buttonState,
            audioMode: audioModeStore.load()
        )
```

Add the public entry point next to `forgetPtt()`:

```swift
    /// §8's setting. Stores it natively and applies it — `specs/NativeRadio.ts`
    /// requires both, and requires the state emission the callers read.
    public func setAudioMode(_ setting: AudioModeSetting) {
        queue.async {
            self.audioModeStore.save(setting)
            self.state.audioMode = setting
            self.emitStateLocked()
            self.performLocked(
                self.policy.setAudioMode(setting.policyMode, nowMs: self.clock.nowMs)
            )
        }
    }
```

- [ ] **Step 7: Run the RadioKit tests**

Run: `cd ios/Radio && DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild test -scheme RadioKit -destination 'platform=iOS Simulator,name=iPhone 17'`

Expected: PASS, including every `AudioModeStoreTests` case and the four new `RadioEngineModeTests` cases.

- [ ] **Step 8: Replace P2's placeholders in the bridge**

In `ios/Oru/RadioBridge.swift`:

Delete the `placeholderAudioRoute` and `placeholderAudioMode` properties together with their doc comment (lines 283-308), and replace `setAudioMode`, `handle(state:)`, `projectLocked()` and `offDictionary(status:)` with:

```swift
    /// §8. Stores the setting natively (through the engine, which owns the
    /// UserDefaults write) and applies it. `specs/NativeRadio.ts` requires an
    /// `onStateChanged` emission before the promise resolves, so the new value
    /// is projected here and now — the same trick `start()` uses for `running`
    /// — and the engine's own snapshot supersedes it when it arrives.
    ///
    /// An unparseable value changes nothing but is still answered with a state
    /// emission, so a confused JavaScript mirror re-syncs to the truth.
    @objc public func setAudioMode(_ mode: String) {
        let setting = AudioModeSetting(rawValue: mode)

        lock.lock()
        pendingAudioMode = setting
        let projected = projectLocked()
        lock.unlock()

        emit(state: projected)
        guard let setting else { return }
        engine.setAudioMode(setting)
    }

    /// Set the moment `setAudioMode` is called, cleared when the engine's own
    /// snapshot agrees. Guarded by `lock` like every other mutable field here.
    private var pendingAudioMode: AudioModeSetting?

    private func handle(state: RadioState) {
        lock.lock()
        lastState = state
        if state.audioMode == pendingAudioMode {
            pendingAudioMode = nil
        }
        let projected = projectLocked()
        lock.unlock()

        emit(state: projected)
    }

    /// Caller holds `lock`.
    private func projectLocked() -> NSDictionary {
        if failed {
            return offDictionary(status: "error")
        }
        if !running {
            return offDictionary(status: "off")
        }
        guard let state = lastState else {
            return offDictionary(status: "starting")
        }

        var dictionary = state.asDictionary
        if let pendingAudioMode {
            dictionary["audioMode"] = pendingAudioMode.rawValue
        }
        return dictionary as NSDictionary
    }

    /// `radio.native.mock.ts`'s `toOffState()` + `preservedButton()`: the button
    /// survives a power cycle (section 9.2 stores it natively) but is never
    /// reported connected while nothing is running.
    ///
    /// The route reported with the radio off is the honest one: with no session
    /// there is no route, and §9's first row is the loudspeaker in VOICE. The
    /// setting, by contrast, is real — it is read from the same store the
    /// engine writes, so the settings screen shows the truth before the radio
    /// has ever started.
    private func offDictionary(status: String) -> NSDictionary {
        // `buttonState` does a `queue.sync` onto PttManager's own queue while we
        // hold `lock`. Analysed and safe: that queue is `com.oru.radio.ptt`,
        // distinct from the engine's `com.oru.radio.engine`, and nothing running
        // on it ever blocks on the engine queue or on this lock -- every
        // PttSourceDelegate hop is `queue.async`. There is no cycle to deadlock.
        var button = RadioAssembly.shared.ptt.buttonState
        button.connected = false

        return [
            "status": status,
            "nearbyCount": 0,
            "transmitting": false,
            "receiving": false,
            "pttButton": button.asDictionary,
            "audioRoute": AudioRoute().asDictionary,
            "audioMode": (pendingAudioMode ?? audioModeStore.load()).rawValue
        ] as NSDictionary
    }
```

and add the store next to the other stored properties:

```swift
    /// The same store the engine writes, read directly so the off state can
    /// report the real setting without hopping the engine queue under `lock`.
    private let audioModeStore = AudioModeStore()
```

`ios/Oru/NativeRadioModule.mm` needs no change: its `setAudioMode:resolve:reject:` already marshals to `ORURadioBridge.setAudioMode` and resolves.

- [ ] **Step 9: Show the route on the debug spike line**

In `ios/Radio/Sources/RadioKit/SpikeCommandServer.swift`, in `describe(_:)`, extend the interpolation:

```swift
        var line = """
            status=\(state.status.rawValue) \
            nearby=\(state.nearbyCount) \
            tx=\(state.transmitting) \
            rx=\(state.receiving) \
            button=\(state.pttButton.configured)/\(state.pttButton.connected) \
            route=\(state.audioRoute.kind.rawValue)/\(state.audioRoute.mode.rawValue) \
            audioMode=\(state.audioMode.rawValue)
            """
```

- [ ] **Step 10: Run the gate plus the app-workspace build**

```bash
pnpm typecheck && pnpm lint && pnpm test
(cd ios/Radio && DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild test -scheme RadioKit -destination 'platform=iOS Simulator,name=iPhone 17')
(cd ios && pod install)
(cd ios && DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild -workspace Oru.xcworkspace -scheme Oru -destination 'platform=iOS Simulator,name=iPhone 17' build)
```

Expected: all PASS. The app build is the only thing that compiles `RadioBridge.swift`; it is why this step exists (schedule: "Acceptance beyond the gates"). Flake (5) applies to the first xcodebuild in the worktree — re-run once on a network failure.

- [ ] **Step 11: Commit**

```bash
git add ios/Radio/Sources/RadioKit/AudioModeStore.swift \
        ios/Radio/Sources/RadioKit/RadioConfig.swift \
        ios/Radio/Sources/RadioKit/RadioState.swift \
        ios/Radio/Sources/RadioKit/RadioEngine.swift \
        ios/Radio/Sources/RadioKit/SpikeCommandServer.swift \
        ios/Oru/RadioBridge.swift \
        ios/Radio/Tests/RadioKitTests/AudioModeStoreTests.swift \
        ios/Radio/Tests/RadioKitTests/RadioEngineModeTests.swift
git commit -m "feat(ios-bridge): publish the real audioRoute and audioMode

RadioState carries spec section 8's two fields, the setting persists in
UserDefaults on the PttBindingStore pattern, and the bridge's two
compile-keeping placeholders from P2 are gone."
```

---

## Task 7: Switch-latency instrumentation, and the branch's own acceptance

§10 asks for "heartbeat/logcat lines carry timestamps for device-event → audio-on-new-route so switch latency is measured, not guessed", and the closeout reads that number off the merged instrumentation. The measurement has two ends in two different files, so it lives in the one object both already touch: `HeartbeatLogger` — the manager marks the device event, and the audio tap's existing `noteInputBuffer()` closes the stopwatch the first time a buffer arrives afterwards. That first buffer *is* "audio on the new route": the keep-alive tap and the capture tap both call it, and after a rebuild neither delivers until the engine is running again.

**Files:**
- Create: `ios/Radio/Sources/RadioKit/RouteSwitchStopwatch.swift`
- Create: `ios/Radio/Tests/RadioKitTests/RouteSwitchStopwatchTests.swift`
- Modify: `ios/Radio/Sources/RadioKit/HeartbeatLogger.swift`
- Modify: `ios/Radio/Sources/RadioKit/AlwaysHotBackgroundManager.swift` (the route-change handler)

**Interfaces:**
- Consumes: `HeartbeatLogger.noteInputBuffer()` (existing, called from both taps), `AudioRouteFormatter.name(of:)` (Task 1).
- Produces: `RouteSwitchStopwatch`, `HeartbeatLogger.markRouteChange(reason:)`.

- [ ] **Step 1: Write the failing stopwatch test**

Create `ios/Radio/Tests/RadioKitTests/RouteSwitchStopwatchTests.swift`:

```swift
import XCTest
@testable import RadioKit

/// §10's instrumentation: "heartbeat/logcat lines carry timestamps for
/// device-event → audio-on-new-route so switch latency is measured, not
/// guessed". One line per switch, emitted by the first audio buffer that
/// arrives after the device event.
final class RouteSwitchStopwatchTests: XCTestCase {

    func testAudioWithNoPendingSwitchSaysNothing() {
        var stopwatch = RouteSwitchStopwatch()
        XCTAssertNil(stopwatch.noteAudio(atMs: 1_000))
    }

    func testTheFirstBufferAfterADeviceEventReportsTheLatency() {
        var stopwatch = RouteSwitchStopwatch()
        stopwatch.markRouteChange(reason: "newDeviceAvailable", atMs: 1_000)
        XCTAssertEqual(
            stopwatch.noteAudio(atMs: 1_812),
            "route switch reason=newDeviceAvailable latencyMs=812"
        )
    }

    func testOnlyTheFirstBufferReports() {
        // A tap delivers 50 buffers a second; a line per buffer would drown
        // heartbeat.log and the number would stop meaning anything.
        var stopwatch = RouteSwitchStopwatch()
        stopwatch.markRouteChange(reason: "oldDeviceUnavailable", atMs: 0)
        XCTAssertNotNil(stopwatch.noteAudio(atMs: 100))
        XCTAssertNil(stopwatch.noteAudio(atMs: 120))
        XCTAssertNil(stopwatch.noteAudio(atMs: 140))
    }

    func testASecondDeviceEventArmsTheStopwatchAgain() {
        var stopwatch = RouteSwitchStopwatch()
        stopwatch.markRouteChange(reason: "newDeviceAvailable", atMs: 0)
        _ = stopwatch.noteAudio(atMs: 500)
        stopwatch.markRouteChange(reason: "oldDeviceUnavailable", atMs: 10_000)
        XCTAssertEqual(
            stopwatch.noteAudio(atMs: 10_240),
            "route switch reason=oldDeviceUnavailable latencyMs=240"
        )
    }

    func testASecondDeviceEventBeforeAnyAudioRestartsTheMeasurement() {
        // Device lists flap during Bluetooth negotiation. The latency that
        // matters is from the LAST event to audio.
        var stopwatch = RouteSwitchStopwatch()
        stopwatch.markRouteChange(reason: "newDeviceAvailable", atMs: 0)
        stopwatch.markRouteChange(reason: "newDeviceAvailable", atMs: 300)
        XCTAssertEqual(
            stopwatch.noteAudio(atMs: 800),
            "route switch reason=newDeviceAvailable latencyMs=500"
        )
    }

    func testAnOutOfOrderTimestampNeverReportsANegativeLatency() {
        var stopwatch = RouteSwitchStopwatch()
        stopwatch.markRouteChange(reason: "newDeviceAvailable", atMs: 1_000)
        XCTAssertEqual(
            stopwatch.noteAudio(atMs: 900),
            "route switch reason=newDeviceAvailable latencyMs=0"
        )
    }
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd ios/Radio && DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild test -scheme RadioKit -destination 'platform=iOS Simulator,name=iPhone 17' -only-testing:RadioKitTests/RouteSwitchStopwatchTests`

Expected: FAIL — `cannot find 'RouteSwitchStopwatch' in scope`.

- [ ] **Step 3: Write `RouteSwitchStopwatch.swift`**

Create `ios/Radio/Sources/RadioKit/RouteSwitchStopwatch.swift`:

```swift
import Foundation

/// §10's switch-latency measurement, as a value: a device event arms it, the
/// first audio buffer after that disarms it and answers with the one line the
/// closeout reads.
///
/// A struct with no I/O because the two ends live in two different threads of
/// two different files — the notification handler and the audio tap — and the
/// only safe way to share them is one small piece of state under
/// `HeartbeatLogger`'s existing lock.
public struct RouteSwitchStopwatch {

    private struct Pending {
        let reason: String
        let atMs: Int64
    }

    private var pending: Pending?

    public init() {}

    /// A device appeared or disappeared. A second mark before any audio
    /// replaces the first: device lists flap during Bluetooth negotiation, and
    /// the latency that matters is from the last event to audio.
    public mutating func markRouteChange(reason: String, atMs: Int64) {
        pending = Pending(reason: reason, atMs: atMs)
    }

    /// Called on every buffer, so it must be cheap and must answer at most once
    /// per switch — a tap delivers ~50 buffers a second.
    public mutating func noteAudio(atMs: Int64) -> String? {
        guard let pending else { return nil }
        self.pending = nil
        return "route switch reason=\(pending.reason) "
            + "latencyMs=\(max(0, atMs - pending.atMs))"
    }
}
```

- [ ] **Step 4: Hook it into `HeartbeatLogger`**

In `ios/Radio/Sources/RadioKit/HeartbeatLogger.swift`, add next to the other private state:

```swift
    private var stopwatch = RouteSwitchStopwatch()
```

replace `noteInputBuffer()` with:

```swift
    /// Called from the audio input tap on every buffer. Only a timestamp store
    /// and one comparison: the tap thread must never touch files or os_log.
    /// `record` hops to the main queue, and the stopwatch answers at most once
    /// per route switch, so at most one line per switch is written from here.
    public func noteInputBuffer() {
        lock.lock()
        lastInputBufferAt = Date()
        let line = stopwatch.noteAudio(atMs: Self.monotonicMs())
        lock.unlock()
        if let line {
            record(line)
        }
    }

    /// §10: "device-event → audio-on-new-route". Called by
    /// `AlwaysHotBackgroundManager` when a device appears or disappears; the
    /// next input buffer closes the measurement.
    public func markRouteChange(reason: String) {
        lock.lock()
        stopwatch.markRouteChange(reason: reason, atMs: Self.monotonicMs())
        lock.unlock()
    }

    /// Monotonic, like every other deadline in this radio: a system clock
    /// change must not turn a switch latency into a negative number.
    private static func monotonicMs() -> Int64 {
        Int64(DispatchTime.now().uptimeNanoseconds / 1_000_000)
    }
```

- [ ] **Step 5: Mark the device events in the manager**

In `ios/Radio/Sources/RadioKit/AlwaysHotBackgroundManager.swift`, in `handleRouteChange(_:)`, after the existing heartbeat line and before the `queue.async`:

```swift
        if reason == .newDeviceAvailable || reason == .oldDeviceUnavailable {
            // §10: starts the switch-latency measurement. It is closed by the
            // first buffer either tap delivers afterwards — which is precisely
            // "audio on the new route", because no tap delivers while the
            // engine is stopped for a rebuild.
            HeartbeatLogger.shared.markRouteChange(
                reason: AudioRouteFormatter.name(of: reason)
            )
        }
```

- [ ] **Step 6: Run the stopwatch tests to verify they pass**

Run: `cd ios/Radio && DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild test -scheme RadioKit -destination 'platform=iOS Simulator,name=iPhone 17' -only-testing:RadioKitTests/RouteSwitchStopwatchTests`

Expected: PASS, every test in `RouteSwitchStopwatchTests`.

- [ ] **Step 7: Prove the deletions and the ownership boundaries**

Run each of these from the repository root and confirm the stated output:

```bash
grep -rn "setPreferredInput\|AudioSessionProfile\|afterPermissiveDetection\|afterA2DPActivation\|wantsSpeakerOverride" ios/Radio ios/Oru
```
Expected: **no output**. §11's iOS deletions are complete.

```bash
git diff --name-only $(git merge-base HEAD feature/offline-nearby-ptt)..HEAD
```
Expected: only paths under `ios/Radio/` and `ios/Oru/`. Not one path under `src/`, `specs/`, `android/`, `__tests__/`, `package.json` or `pnpm-lock.yaml`.

```bash
git diff --name-only $(git merge-base HEAD feature/offline-nearby-ptt)..HEAD -- \
  ios/Radio/Sources/RadioKit/ModePolicy.swift \
  ios/Radio/Tests/RadioKitTests/ModePolicyTests.swift
```
Expected: **no output**. Sync 2 cross-checks exactly this; a change needed in either file is reported in the task report instead.

If any of the three disagrees, stop and fix the branch before finishing the task — a boundary violation found at sync 2 costs the whole merge.

- [ ] **Step 8: Run the full gate and the app-workspace build**

```bash
pnpm typecheck && pnpm lint && pnpm test
(cd ios/Radio && DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild test -scheme RadioKit -destination 'platform=iOS Simulator,name=iPhone 17')
(cd ios && DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild -workspace Oru.xcworkspace -scheme Oru -destination 'platform=iOS Simulator,name=iPhone 17' build)
```

`pod install` is only needed if Task 6 did not already run it in this worktree. Expected: all PASS.

- [ ] **Step 9: Commit**

```bash
git add ios/Radio/Sources/RadioKit/RouteSwitchStopwatch.swift \
        ios/Radio/Sources/RadioKit/HeartbeatLogger.swift \
        ios/Radio/Sources/RadioKit/AlwaysHotBackgroundManager.swift \
        ios/Radio/Tests/RadioKitTests/RouteSwitchStopwatchTests.swift
git commit -m "feat(ios-audio): measure device-event to audio-on-new-route

Spec section 10's instrumentation: a device event arms a stopwatch, the first
tap buffer afterwards writes one heartbeat line with the latency. Closeout
reads the switch time off this instead of guessing it."
```

---

## What this plan deliberately leaves undone

- **The §9 behaviour-contract table and the §10 hardware checklist** need physical devices and are closeout items, not tasks. Two things in this plan can only be confirmed there and are called out for the closeout run: that `beginIncoming` without its per-transmission stop/start still produces audible playback on device (the stop/start was a workaround for a graph that was never rebuilt; §5 replaces it with the configuration-change rebuild), and that the grant tone is audible over an HFP link at 8 kHz.
- **Android** (§6) is P4's, in the same wave, in a disjoint tree.
- **`ModePolicy`'s table and constants** are merged P1's. If wave-2 work shows the table needs a change, the task report says so and the run decides; this branch does not patch it.
- **The JS surface** (§8's types, model, screens, mock) is merged P2's. This plan implements the contract; it does not move it.
- **§12's future work** — iOS ducking, the LE Audio fast path, `.bluetoothHighQualityRecording`, the PushToTalk framework — is out of scope by name, and the PushToTalk entitlement must not be re-added (`docs/closeout-remaining.md`).
