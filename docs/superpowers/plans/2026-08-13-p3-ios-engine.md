# iOS RadioEngine (P3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the entire iOS radio stack — transport, audio, PTT and background execution — as a self-contained Swift package that runs with React Native asleep, plus the spike hooks that let the operator run Phase 0 scenarios A–D on physical devices.

**Architecture:** All iOS radio code lives in one local Swift package, `ios/Radio` (product `RadioKit`), linked into the `Oru` app target. Inside it a `RadioEngine` state machine owns all state and talks to four ports — `RadioTransport`, `AudioIO`, `PttSource`, `BackgroundSession` — each with exactly one production implementation (`NearbyManager`, `AudioEngine`, `PttManager`, `BackgroundManager`). The engine never imports a third-party module, never imports React, and never touches UIKit; the two third-party dependencies are confined to one file each so a closeout API mismatch is a one-file fix.

**Tech Stack:** Swift 5.9 / iOS 16, SwiftPM local package, Google NearbyConnections (Swift), libopus via an SPM package, AVAudioEngine, Apple PushToTalk framework, CoreBluetooth, UserDefaults, XCTest (run at closeout only), Jest structural tests (run by the task gate on this host).

**Spec:** `docs/superpowers/specs/2026-08-13-offline-nearby-ptt-design.md` — sections §6, §6.3, §7, §8, §9, §10.2, §13, §15 (Phase 0 + Stage 1).

**Schedule:** `docs/superpowers/execution/2026-08-13-offline-nearby-ptt.md` — block "P3 `ios-engine` — wave 2, track B".

## Global Constraints

**Nothing here compiles Swift. Read this before the first task.**

- No macOS and no Swift toolchain exists on this host. `pnpm typecheck`, `pnpm lint`, `pnpm test` and `pnpm build:android` never look at a `.swift` file. **A green gate is not evidence that the iOS code compiles.** The first compile of every line written by this plan happens at closeout, on macOS, per the schedule's Closeout block.
- Because of that, this plan's verification is three layers, and every task uses all three:
  1. **Jest structural tests** (`__tests__/ios-*.test.ts`) — run by the task gate. They assert the architectural invariants that *can* be checked as text: which files exist, which symbols they declare, which module each file is allowed to import, that config constants equal the spec's numbers, that localization key sets match.
  2. **XCTest files** (`ios/Radio/Tests/RadioKitTests/`) — deliverables, not gate steps. No step in this plan runs them. They are run at closeout with `xcodebuild test`.
  3. **Code review** by the executor before the branch is offered for merge — per the schedule, on this plan it is the only behavioural check that exists before closeout.
- **Task gate** (copied from the schedule header), run at the end of every task:
  `pnpm typecheck && pnpm lint && pnpm test <paths>`
  Nothing in this plan touches `android/`, so `pnpm build:android` is not part of any task gate here. Each task names its exact `<paths>` argument. Pass it as a bare substring (`pnpm test ios-radio-package`), not a path with separators — Jest treats the argument as a regex and a bare substring is the form that behaves the same on Windows and POSIX.
- **Known flakes:** none known — greenfield repository. Two standing environment caveats: (1) the first Gradle / NDK / CMake / dependency downloads are slow and can time out — a download failure or timeout is infrastructure, not a regression; re-run once before reporting. (2) Swift is never compiled by any gate on this Windows host — a green merge gate is **not** evidence of iOS health; iOS compilation happens only at closeout on macOS.
- **Formatting:** `pnpm lint` enforces Prettier 2.8.8 through `@react-native/eslint-config` on every `.ts`/`.tsx` file. If lint fails only with `prettier/prettier` errors, run `npx prettier --write <file>` and re-run the gate. Swift files are not linted (`.eslintignore` ignores `ios/`); match the style of the code in this plan — 4-space indent, no trailing whitespace.
- **Do not edit** `package.json`, `pnpm-lock.yaml`, `jest.config.js`, `.eslintrc.js`, `tsconfig.json`, `metro.config.js`, `babel.config.js`, or anything under `android/`, `src/`, `specs/`. P1 pre-installed every dependency this plan needs (none — this plan adds no JS dependency). A change to any of those files is a decomposition violation and must be reported, not made.
- **Do not delete** `ios/Radio/.gitkeep`. `__tests__/project-structure.test.ts` asserts `ios/Radio` is a directory; the placeholder is harmless next to `Package.swift` and SwiftPM ignores it.
- **iOS 16.0 floor** (spec §5, PushToTalk requirement). Already pinned by P1 in `ios/Podfile` and `IPHONEOS_DEPLOYMENT_TARGET`; `Package.swift` must declare `.iOS(.v16)` and no lower.
- **The dependency rule (spec §6):** radio functionality must not depend on React Native or the JavaScript runtime. No file under `ios/Radio/Sources/RadioKit/` may `import React`, `import React_RCTAppDelegate` or reference `RCT`-prefixed symbols. Task 10 adds three lines to `ios/Oru/AppDelegate.swift`; that is the only app-target Swift this plan touches.
- **errore does not apply here.** The errore convention (spec §5) is the TypeScript layer's; Swift uses `throws` and `Result` as written in this plan.

### The two unresolvable dependencies

`NearbyConnections` and `Opus` cannot be fetched, resolved or compiled on this host. This plan declares both in `ios/Radio/Package.swift` and confines every call into them to exactly two files:

| Dependency | Declared as | The only file that imports it |
|---|---|---|
| Google Nearby Connections (Swift) | `.package(url: "https://github.com/google/nearby.git", branch: "main")`, product `NearbyConnections` | `Sources/RadioKit/NearbyManager.swift` |
| libopus | `.package(url: "https://github.com/alta/swift-opus.git", branch: "main")`, product `Opus` | `Sources/RadioKit/OpusCodec.swift` |

Both use `branch: "main"` deliberately: no release tag can be verified from here, and a wrong tag fails resolution outright while a branch does not. The closeout macOS build runs `xcodebuild -resolvePackageDependencies`, which writes `Package.resolved` with exact commits — **committing that file is a closeout step, and it is where these dependencies get pinned.** A Jest test enforces the import isolation, so if either package's API turns out to differ at closeout, the blast radius is `Package.swift` plus one file.

Google's own documentation states that **on iOS the only supported Nearby medium is Wi-Fi LAN**. Phase 0 must therefore be run with both phones joined to the same local Wi-Fi network with no internet (a router or a hotspot with the uplink off) — "internet off" in spec §15 does not mean "Wi-Fi off" for the iPhone. This belongs in the Phase 0 runbook (Task 10) and is a fact the operator needs before the spike, not after.

### Spec amendment to §6.1 — the pairing session (decided, binding on P2/P4/P5/P6)

§9.3 draws the learning flow as *scan → pick device → press*, and §12.1 makes the four-step
`03 Pairing` screen normative — so the pick is a real user choice rendered in React Native.
§6.1 as written has no native→JS channel for the candidate list and, decisively, no JS→native
channel for the choice. The contract is therefore amended, minimally, and this plan is written
against the amended version:

- **All seven methods keep their signatures.** `configurePtt(): Promise<PttConfiguration>` stays
  argument-free and is redefined as *"opens the native pairing session and resolves when the
  binding is saved"*. Cancellation and timeout surface through the existing `error` event.
  `forgetPtt()` is untouched.
- **Scan progress travels on the existing `stateChanged` event**, not a new event variant, as one
  optional field on `RadioState`:

  ```ts
  pttPairing?: {
    phase: 'scanning' | 'learning' | 'saved'
    candidates: Array<{deviceId: string; name: string; rssi: number}>
  }
  ```

  It is **absent whenever no pairing session is running**, so §6.2's `screenState` and the four
  main-screen states are untouched, and §6.2's resume re-sync through `getState()` covers pairing
  for free. This matches §13: a pairing session in progress is state, not an error.
- **Exactly one method is added:** `selectPttCandidate(deviceId: string): Promise<void>`.

This is a spec amendment, and it is mirrored by the two plans running beside this one: P4 carries
it into `specs/NativeRadio.ts` and the TS types, P2 into `PttManager.kt`, which must expose the
same `selectCandidate` and publish the same candidate/phase snapshot. P5 bridges the one extra
method; P6 binds its pick step to `pttPairing.candidates` + `selectPttCandidate`. **Do not edit
those plans from here** — this bullet exists so a reviewer can confirm all four agree.

The strongest-signal auto-pick that an earlier draft of this plan used as the product behaviour is
demoted to a **native safety net**: it fires only after `RadioConfig.Ptt.autoSelectFallback`
seconds with no selection, which is what keeps `RadioSpike.configurePtt()` usable during Phase 0,
where there is no UI to pick with.

### Cross-platform wire contract (must match P2's Android engine byte for byte)

P2 writes the Android side in parallel from the same spec sections. These values are not derivable from the spec alone; both engines must agree or the two platforms silently never see each other, and nothing on this host can detect it. **Sync 2 must diff this table against the Android engine before the operator runs Phase 0.**

| Item | Value |
|---|---|
| Nearby service ID | `com.oru.radio` |
| Strategy | `P2P_CLUSTER` (`.cluster` in the Swift API) |
| Control payload type | Nearby BYTES, UTF-8 JSON |
| `hello` | `{"type":"hello","version":1}` |
| `tx-start` | `{"type":"tx-start","streamId":"<uuid string>"}` |
| `tx-stop` | `{"type":"tx-stop","streamId":"<uuid string>"}` |
| Version gate | On `hello` with `version != 1`, disconnect that endpoint and never count it |
| Peer counting | An endpoint counts toward `nearbyCount` only after a valid `hello` is received from it |
| Audio payload type | Nearby STREAM, one stream per transmission (press → release) |
| Audio framing inside the stream | `UInt16` big-endian byte length, then that many bytes of one Opus packet, repeated |
| Frame length bounds | `1...1275`; anything outside means desync — drop the stream |
| Stream ↔ transmission association | By endpoint ID. One transmission per endpoint at a time; `streamId` is carried for logging and UI only and is never compared across devices |
| Opus | 16 000 Hz, 1 channel, 20 ms frames (320 samples), ~24 000 bps, VOIP application |

### Interfaces this plan produces for later plans

P5 (`bridge`, wave 3) is the only consumer. It gets exactly this and nothing else:

```swift
import RadioKit

RadioAssembly.shared.engine            // RadioEngine, process-wide singleton

engine.startRadio()                    // -> Void
engine.stopRadio()                     // -> Void
engine.startTransmit()                 // -> Void   (pressPtt)
engine.stopTransmit()                  // -> Void   (releasePtt)
engine.getState { (state: RadioState) in }
engine.configurePtt { (result: Result<PttConfiguration, RadioError>) in }
engine.selectPttCandidate(deviceId: String)   // -> Void   (selectPttCandidate)
engine.forgetPtt()                     // -> Void
engine.addObserver("bridge") { (event: RadioEvent) in }
engine.removeObserver("bridge")

RadioState.asDictionary   // [String: Any] shaped exactly like the amended §6.1 RadioState,
                          // including "pttPairing" while a pairing session is running
PttConfiguration.asDictionary // ["name": String, "binding": [String: Any]] per spec §9.2
RadioEvent // .stateChanged(RadioState) | .error(RadioError); RadioError has .code and .message
```

## File Structure

Everything this plan creates, and what each file is responsible for.

```text
ios/Radio/                                   local Swift package, product "RadioKit"
├── Package.swift                            targets, iOS 16 floor, the two remote deps, resources
├── README.md                                build notes + the Phase 0 A–D runbook
├── Sources/RadioKit/
│   ├── RadioConfig.swift                    every tunable in one place (spec §8)
│   ├── RadioState.swift                     RadioState, PttButtonState, RadioError, RadioEvent
│   ├── ControlMessage.swift                 the §7 JSON control protocol + codec
│   ├── AudioFraming.swift                   length-prefix framing for the STREAM payload
│   ├── RadioPorts.swift                     the four ports the engine consumes + RadioClock
│   ├── RadioEngine.swift                    the §6.3 state machine, 120 s safety cap
│   ├── NearbyManager.swift                  RadioTransport — the ONLY NearbyConnections importer
│   ├── OpusCodec.swift                      OpusEncoding/OpusDecoding — the ONLY Opus importer
│   ├── JitterBuffer.swift                   per-peer 2–3 frame cushion
│   ├── AudioEngine.swift                    AudioIO — AVAudioEngine capture, playback, mixing
│   ├── BackgroundManager.swift              BackgroundSession — PushToTalk (§10.2)
│   ├── PttBinding.swift                     §9.2 binding type + UserDefaults store
│   ├── BleGattPttDriver.swift               CoreBluetooth driver + learning flow (§9.3)
│   ├── PttManager.swift                     PttSource — driver ownership, auto-reconnect
│   ├── RadioAssembly.swift                  composition root; the singleton P5 calls
│   ├── RadioSpike.swift                     Phase 0 hooks and structured os_log output
│   └── Resources/{en,ru}.lproj/Localizable.strings   PTT channel name (§12.2)
└── Tests/RadioKitTests/
    ├── Fakes.swift                          in-memory ports for the engine tests
    ├── ControlMessageTests.swift
    ├── AudioFramingTests.swift
    ├── RadioEngineTests.swift
    ├── JitterBufferTests.swift
    └── PttBindingTests.swift

ios/Oru/{en,ru}.lproj/InfoPlist.strings      localized permission prompts (§11, §12.2)
ios/Oru/Info.plist                           MODIFIED: CFBundleLocalizations
ios/Oru/AppDelegate.swift                    MODIFIED: 3 lines, DEBUG-only spike bootstrap
ios/Oru.xcodeproj/project.pbxproj            MODIFIED: link RadioKit, add the strings variant group

__tests__/ios-radio-package.test.ts          Task 1
__tests__/ios-radio-sources.test.ts          Tasks 2–8, 10 (each appends one describe block)
__tests__/ios-localization.test.ts           Task 9
```

---

### Task 1: The RadioKit package and its wiring into the app target

**Files:**
- Create: `ios/Radio/Package.swift`
- Create: `ios/Radio/Sources/RadioKit/RadioConfig.swift`
- Modify: `ios/Oru.xcodeproj/project.pbxproj`
- Test: `__tests__/ios-radio-package.test.ts`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: the `RadioKit` module; `RadioConfig.serviceId` (`String`), `RadioConfig.protocolVersion` (`Int`), `RadioConfig.Audio.*`, `RadioConfig.Transmit.safetyCapSeconds` (`TimeInterval`), `RadioConfig.Reconnect.*`, `RadioConfig.Ptt.*`, `RadioConfig.Background.channelUUID` (`UUID`). Every later task reads its numbers from here and hard-codes none.

- [ ] **Step 1: Write the failing test**

Create `__tests__/ios-radio-package.test.ts`:

```ts
import {existsSync, readFileSync} from 'fs';
import {join} from 'path';

const IOS_DIR = join(__dirname, '..', 'ios');
const PACKAGE_DIR = join(IOS_DIR, 'Radio');

function read(...segments: string[]): string {
  const path = join(...segments);
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

const manifest = read(PACKAGE_DIR, 'Package.swift');
const config = read(PACKAGE_DIR, 'Sources', 'RadioKit', 'RadioConfig.swift');
const pbxproj = read(IOS_DIR, 'Oru.xcodeproj', 'project.pbxproj');

describe('RadioKit package manifest', () => {
  it('declares the RadioKit library product', () => {
    expect(manifest).toContain('name: "RadioKit"');
    expect(manifest).toContain('.library(');
  });

  it('pins the iOS 16 floor from spec section 5', () => {
    expect(manifest).toContain('.iOS(.v16)');
  });

  it('declares english as the default localization', () => {
    expect(manifest).toContain('defaultLocalization: "en"');
  });

  it('declares the two third-party dependencies', () => {
    expect(manifest).toContain('https://github.com/google/nearby.git');
    expect(manifest).toContain('https://github.com/alta/swift-opus.git');
    expect(manifest).toContain('name: "NearbyConnections"');
    expect(manifest).toContain('name: "Opus"');
  });

  it('declares the test target', () => {
    expect(manifest).toContain('.testTarget(');
    expect(manifest).toContain('name: "RadioKitTests"');
  });

  it('processes the localized resources directory', () => {
    expect(manifest).toContain('.process("Resources")');
  });
});

describe('RadioConfig (spec sections 5, 7, 8)', () => {
  it('carries the shared Nearby service id', () => {
    expect(config).toContain('serviceId = "com.oru.radio"');
  });

  it('carries protocol version 1', () => {
    expect(config).toContain('protocolVersion = 1');
  });

  it.each([
    ['sampleRate', '16_000'],
    ['samplesPerFrame', '320'],
    ['frameDurationMs', '20'],
    ['bitrate', '24_000'],
    ['channelCount', '1'],
  ])('audio %s is %s', (name, value) => {
    expect(config).toContain(`${name}: `);
    expect(config).toMatch(new RegExp(`${name}[^=]*= ${value}`));
  });

  it('caps continuous transmission at 120 seconds', () => {
    expect(config).toMatch(/safetyCapSeconds[^=]*= 120/);
  });

  it('primes the jitter buffer with 3 frames (spec section 8)', () => {
    expect(config).toMatch(/jitterTargetFrames[^=]*= 3/);
  });
});

describe('app target wiring', () => {
  it('references the local Radio package', () => {
    expect(pbxproj).toContain('/* Radio */ = {isa = PBXFileReference');
  });

  it('links the RadioKit product into the Oru target', () => {
    expect(pbxproj).toContain('XCSwiftPackageProductDependency');
    expect(pbxproj).toContain('productName = RadioKit;');
    expect(pbxproj).toContain('packageProductDependencies = (');
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `pnpm test ios-radio-package`
Expected: FAIL — every assertion fails against empty strings, e.g. `expect(received).toContain("name: \"RadioKit\"")` with `received` = `""`.

- [ ] **Step 3: Write the package manifest**

Create `ios/Radio/Package.swift`:

```swift
// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "RadioKit",
    defaultLocalization: "en",
    platforms: [.iOS(.v16)],
    products: [
        .library(name: "RadioKit", targets: ["RadioKit"])
    ],
    dependencies: [
        // Pinned to exact commits by Package.resolved at the closeout macOS build:
        // neither package can be resolved from the Windows planning host.
        .package(url: "https://github.com/google/nearby.git", branch: "main"),
        .package(url: "https://github.com/alta/swift-opus.git", branch: "main")
    ],
    targets: [
        .target(
            name: "RadioKit",
            dependencies: [
                .product(name: "NearbyConnections", package: "nearby"),
                .product(name: "Opus", package: "swift-opus")
            ],
            resources: [.process("Resources")]
        ),
        .testTarget(name: "RadioKitTests", dependencies: ["RadioKit"])
    ]
)
```

- [ ] **Step 4: Write RadioConfig**

Create `ios/Radio/Sources/RadioKit/RadioConfig.swift`:

```swift
import Foundation

/// Every tunable of the radio in one place, so field tests can retune the codec
/// without touching logic (spec section 8).
public enum RadioConfig {

    /// Nearby Connections service id. MUST be byte-identical to the Android engine's.
    public static let serviceId = "com.oru.radio"

    /// Version carried in the `hello` control message (spec section 7).
    public static let protocolVersion = 1

    public enum Audio {
        public static let sampleRate: Double = 16_000
        public static let channelCount: UInt32 = 1
        public static let frameDurationMs: Int = 20
        /// 16 000 Hz * 20 ms.
        public static let samplesPerFrame: Int = 320
        public static let bitrate: Int32 = 24_000
        /// Spec section 8 asks for a 2-3 frame cushion; 3 frames is 60 ms.
        public static let jitterTargetFrames: Int = 3
        /// Beyond half a second of backlog the oldest frames are dropped.
        public static let jitterMaxFrames: Int = 25
        /// Opus hard maximum for one packet.
        public static let maxEncodedFrameBytes: Int = 1_275
    }

    public enum Transmit {
        /// Stuck-button protection (spec sections 5 and 9.4).
        public static let safetyCapSeconds: TimeInterval = 120
    }

    public enum Reconnect {
        public static let initialDelay: TimeInterval = 1
        public static let multiplier: Double = 2
        public static let maxDelay: TimeInterval = 30
    }

    public enum Ptt {
        public static let learningTimeout: TimeInterval = 30
        /// Safety net only: how long the pairing session waits for the user's
        /// pick before falling back to the strongest signal. The product path is
        /// `selectPttCandidate` from the UI; this exists so Phase 0 can pair
        /// with no UI at all.
        public static let autoSelectFallback: TimeInterval = 15
        public static let bindingDefaultsKey = "radio.ptt.binding"
        public static let centralRestoreIdentifier = "com.oru.radio.ptt.central"
    }

    public enum Background {
        /// Stable PushToTalk channel identity, the same across launches.
        public static let channelUUID = UUID(
            uuidString: "6F5C1C2E-7C1B-4B7A-9F1A-2C3D4E5F6A7B"
        )!
    }

    public enum Logging {
        public static let subsystem = "com.oru.radio"
    }
}
```

- [ ] **Step 5: Wire the package into the Xcode target — file reference**

`ios/Oru.xcodeproj/project.pbxproj` is indented with **tabs**. Make four edits, exactly as written.

Edit 1 — in `/* Begin PBXBuildFile section */`, after the `AppDelegate.swift in Sources` line, add:

```
		9A1E0011AAAA0000BBBB0011 /* RadioKit in Frameworks */ = {isa = PBXBuildFile; productRef = 9A1E0012AAAA0000BBBB0012 /* RadioKit */; };
```

Edit 2 — in `/* Begin PBXFileReference section */`, after the `AppDelegate.swift` line, add:

```
		9A1E0013AAAA0000BBBB0013 /* Radio */ = {isa = PBXFileReference; lastKnownFileType = wrapper; name = Radio; path = Radio; sourceTree = "<group>"; };
```

Edit 3 — in the Frameworks build phase (`13B07F8C1A680F5B00A75B9A /* Frameworks */`), inside `files = (`, add the product line:

```
			0C80B921A6F3F58F76C31292 /* libPods-Oru.a in Frameworks */,
			9A1E0011AAAA0000BBBB0011 /* RadioKit in Frameworks */,
```

Edit 4 — in the root group `83CBB9F61A601CBA00E9B192`, add the package folder to `children`, after the `Oru` entry:

```
					13B07FAE1A68108700A75B9A /* Oru */,
					9A1E0013AAAA0000BBBB0013 /* Radio */,
```

- [ ] **Step 6: Wire the package into the Xcode target — product dependency**

Edit 5 — in `13B07F861A680F5B00A75B9A /* Oru */` (the `PBXNativeTarget`), insert between the `name = Oru;` line and the `productName = Oru;` line:

```
			packageProductDependencies = (
				9A1E0012AAAA0000BBBB0012 /* RadioKit */,
			);
```

Edit 6 — append a new section at the very end of the objects, immediately after the `/* End XCConfigurationList section */` line:

```

/* Begin XCSwiftPackageProductDependency section */
		9A1E0012AAAA0000BBBB0012 /* RadioKit */ = {
			isa = XCSwiftPackageProductDependency;
			productName = RadioKit;
		};
/* End XCSwiftPackageProductDependency section */
```

There is deliberately **no** `XCRemoteSwiftPackageReference` and no `packageReferences` entry: this is how Xcode represents a *local* package at `objectVersion = 54` — a folder file reference plus a `productName`-only dependency.

- [ ] **Step 7: Run the test and confirm it passes**

Run: `pnpm test ios-radio-package`
Expected: PASS, 15 tests.

- [ ] **Step 8: Run the full task gate**

Run: `pnpm typecheck && pnpm lint && pnpm test ios-radio-package`
Expected: all three green. If lint reports only `prettier/prettier`, run `npx prettier --write __tests__/ios-radio-package.test.ts` and re-run.

- [ ] **Step 9: Commit**

```bash
rtk git add ios/Radio/Package.swift ios/Radio/Sources/RadioKit/RadioConfig.swift ios/Oru.xcodeproj/project.pbxproj __tests__/ios-radio-package.test.ts
rtk git commit -m "feat(ios): add RadioKit package skeleton and radio config"
```

---

### Task 2: Domain types, the control protocol, framing, and the engine's ports

**Files:**
- Create: `ios/Radio/Sources/RadioKit/RadioState.swift`
- Create: `ios/Radio/Sources/RadioKit/ControlMessage.swift`
- Create: `ios/Radio/Sources/RadioKit/AudioFraming.swift`
- Create: `ios/Radio/Sources/RadioKit/RadioPorts.swift`
- Create: `ios/Radio/Tests/RadioKitTests/ControlMessageTests.swift`
- Create: `ios/Radio/Tests/RadioKitTests/AudioFramingTests.swift`
- Test: `__tests__/ios-radio-sources.test.ts` (created here; Tasks 3–8 and 10 append to it)

**Interfaces:**
- Consumes: `RadioConfig.protocolVersion`, `RadioConfig.Audio.maxEncodedFrameBytes` from Task 1.
- Produces: `RadioState`, `RadioState.Status`, `PttButtonState`, `PttCandidate`, `PttPairingState`, `RadioError`, `RadioEvent`, `ControlMessage` (`.hello(version:)`, `.txStart(streamId:)`, `.txStop(streamId:)`) with `encoded() -> Data` and `static decode(_:) -> ControlMessage?`, `AudioFraming.frame(_:) -> Data`, `AudioFrameParser` (`append(_:) -> [Data]`, `isDesynchronised`, `reset()`), and the ports `RadioTransport` + `RadioTransportDelegate` + `AudioStreamSink`, `AudioIO` + `AudioIODelegate`, `PttSource` + `PttSourceDelegate`, `BackgroundSession` + `BackgroundSessionDelegate`, `RadioClock` + `RadioCancellable`. `PttBinding` and `PttConfiguration` are referenced by the ports and defined in Task 8.
- `PttCandidate` and `PttPairingState` are domain types, not driver details: they are part of the amended §6.1 `RadioState`, so they live here rather than in the BLE driver.

- [ ] **Step 1: Write the failing test**

Create `__tests__/ios-radio-sources.test.ts`:

```ts
import {existsSync, readFileSync, readdirSync} from 'fs';
import {join} from 'path';

const SOURCES = join(
  __dirname,
  '..',
  'ios',
  'Radio',
  'Sources',
  'RadioKit',
);

function source(name: string): string {
  const path = join(SOURCES, name);
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

function swiftFiles(): string[] {
  return existsSync(SOURCES)
    ? readdirSync(SOURCES).filter(name => name.endsWith('.swift'))
    : [];
}

describe('domain types (spec section 6.1)', () => {
  const state = source('RadioState.swift');

  it.each([
    'public struct RadioState',
    'public enum Status: String',
    'case starting',
    'case ready',
    'case error',
    'public var nearbyCount: Int',
    'public var transmitting: Bool',
    'public var receiving: Bool',
    'public var pttButton: PttButtonState',
    'public struct PttButtonState',
    'public struct RadioError',
    'public enum RadioEvent',
    'case stateChanged(RadioState)',
    'var asDictionary: [String: Any]',
  ])('RadioState.swift declares %s', declaration => {
    expect(state).toContain(declaration);
  });

  it.each([
    'public struct PttCandidate',
    'public let deviceId: String',
    'public let rssi: Int',
    'public struct PttPairingState',
    'public enum Phase: String',
    'case scanning',
    'case learning',
    'case saved',
    'public var candidates: [PttCandidate]',
    'public var pttPairing: PttPairingState?',
  ])('declares the amended pairing state %s', declaration => {
    expect(state).toContain(declaration);
  });

  it('omits pttPairing from the snapshot when no session is running', () => {
    expect(state).toContain('if let pttPairing');
  });
});

describe('control protocol (spec section 7)', () => {
  const control = source('ControlMessage.swift');

  it.each([
    'public enum ControlMessage',
    'case hello(version: Int)',
    'case txStart(streamId: String)',
    'case txStop(streamId: String)',
    'public func encoded() -> Data',
    'public static func decode(_ data: Data) -> ControlMessage?',
  ])('ControlMessage.swift declares %s', declaration => {
    expect(control).toContain(declaration);
  });

  it.each(['"hello"', '"tx-start"', '"tx-stop"', '"streamId"', '"version"'])(
    'uses the wire token %s verbatim',
    token => {
      expect(control).toContain(token);
    },
  );
});

describe('stream framing (cross-platform wire contract)', () => {
  const framing = source('AudioFraming.swift');

  it.each([
    'public enum AudioFraming',
    'public static func frame(_ payload: Data) -> Data',
    'public final class AudioFrameParser',
    'public func append(_ bytes: Data) -> [Data]',
    'public private(set) var isDesynchronised',
  ])('AudioFraming.swift declares %s', declaration => {
    expect(framing).toContain(declaration);
  });

  it('uses a two-byte big-endian length prefix', () => {
    expect(framing).toContain('UInt16');
    expect(framing).toContain('bigEndian');
  });
});

describe('engine ports', () => {
  const ports = source('RadioPorts.swift');

  it.each([
    'public protocol RadioTransport',
    'public protocol RadioTransportDelegate',
    'public protocol AudioStreamSink',
    'public protocol AudioIO',
    'public protocol AudioIODelegate',
    'public protocol PttSource',
    'public protocol PttSourceDelegate',
    'public protocol BackgroundSession',
    'public protocol BackgroundSessionDelegate',
    'public protocol RadioClock',
    'public protocol RadioCancellable',
    'func selectCandidate(deviceId: String)',
    'pairingStateDidChange state: PttPairingState?',
  ])('RadioPorts.swift declares %s', declaration => {
    expect(ports).toContain(declaration);
  });

  it('keeps every third-party and UI import out of the ports', () => {
    expect(ports).not.toContain('import NearbyConnections');
    expect(ports).not.toContain('import UIKit');
    expect(ports).not.toContain('import React');
  });
});

describe('layering (spec section 6)', () => {
  it('never imports React or UIKit anywhere in the engine', () => {
    const offenders = swiftFiles().filter(name => {
      const text = source(name);
      return text.includes('import React') || text.includes('import UIKit');
    });
    expect(offenders).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `pnpm test ios-radio-sources`
Expected: FAIL — the domain, control, framing and ports blocks all fail against empty strings. The "layering" test passes vacuously; that is correct, it is a guard, not a deliverable.

- [ ] **Step 3: Write the domain types**

Create `ios/Radio/Sources/RadioKit/RadioState.swift`:

```swift
import Foundation

/// The PTT button half of `RadioState` (spec section 6.1).
public struct PttButtonState: Equatable {
    public var configured: Bool
    public var connected: Bool
    public var name: String?

    public init(configured: Bool = false, connected: Bool = false, name: String? = nil) {
        self.configured = configured
        self.connected = connected
        self.name = name
    }

    public var asDictionary: [String: Any] {
        var dictionary: [String: Any] = [
            "configured": configured,
            "connected": connected
        ]
        if let name {
            dictionary["name"] = name
        }
        return dictionary
    }
}

/// One device seen during a pairing scan (amended spec section 6.1).
public struct PttCandidate: Equatable {
    public let deviceId: String
    public let name: String
    public let rssi: Int

    public init(deviceId: String, name: String, rssi: Int) {
        self.deviceId = deviceId
        self.name = name
        self.rssi = rssi
    }

    public var asDictionary: [String: Any] {
        ["deviceId": deviceId, "name": name, "rssi": rssi]
    }
}

/// A pairing session in progress. Present in `RadioState` only while one is
/// running, so the four main-screen states never see it.
public struct PttPairingState: Equatable {
    public enum Phase: String {
        case scanning
        case learning
        case saved
    }

    public var phase: Phase
    public var candidates: [PttCandidate]

    public init(phase: Phase, candidates: [PttCandidate] = []) {
        self.phase = phase
        self.candidates = candidates
    }

    public var asDictionary: [String: Any] {
        [
            "phase": phase.rawValue,
            "candidates": candidates.map(\.asDictionary)
        ]
    }
}

/// The snapshot the engine hands to the bridge; shape is the amended spec
/// section 6.1 verbatim.
public struct RadioState: Equatable {
    public enum Status: String {
        case starting
        case ready
        case error
    }

    public var status: Status
    public var nearbyCount: Int
    public var transmitting: Bool
    public var receiving: Bool
    public var pttButton: PttButtonState
    public var pttPairing: PttPairingState?

    public init(
        status: Status = .starting,
        nearbyCount: Int = 0,
        transmitting: Bool = false,
        receiving: Bool = false,
        pttButton: PttButtonState = PttButtonState(),
        pttPairing: PttPairingState? = nil
    ) {
        self.status = status
        self.nearbyCount = nearbyCount
        self.transmitting = transmitting
        self.receiving = receiving
        self.pttButton = pttButton
        self.pttPairing = pttPairing
    }

    public var asDictionary: [String: Any] {
        var dictionary: [String: Any] = [
            "status": status.rawValue,
            "nearbyCount": nearbyCount,
            "transmitting": transmitting,
            "receiving": receiving,
            "pttButton": pttButton.asDictionary
        ]
        if let pttPairing {
            dictionary["pttPairing"] = pttPairing.asDictionary
        }
        return dictionary
    }
}

/// Engine failures (spec section 13). Recoverable conditions are state, not errors.
public struct RadioError: Error, Equatable {
    public let code: String
    public let message: String

    public init(code: String, message: String) {
        self.code = code
        self.message = message
    }

    public static func startFailed(_ message: String) -> RadioError {
        RadioError(code: "start_failed", message: message)
    }

    public static func transportFailed(_ message: String) -> RadioError {
        RadioError(code: "transport_failed", message: message)
    }

    public static func audioFailed(_ message: String) -> RadioError {
        RadioError(code: "audio_failed", message: message)
    }

    public static func backgroundFailed(_ message: String) -> RadioError {
        RadioError(code: "background_failed", message: message)
    }

    public static func pttFailed(_ message: String) -> RadioError {
        RadioError(code: "ptt_failed", message: message)
    }

    public static func pairingFailed(_ message: String) -> RadioError {
        RadioError(code: "pairing_failed", message: message)
    }
}

/// What observers receive (spec section 6.1 `RadioNativeEvent`).
public enum RadioEvent {
    case stateChanged(RadioState)
    case error(RadioError)
}
```

- [ ] **Step 4: Write the control protocol**

Create `ios/Radio/Sources/RadioKit/ControlMessage.swift`:

```swift
import Foundation

/// The reliable BYTES control protocol of spec section 7. The JSON shape is a
/// cross-platform contract: the Android engine and the TypeScript codec parse the
/// exact same three objects.
public enum ControlMessage: Equatable {
    case hello(version: Int)
    case txStart(streamId: String)
    case txStop(streamId: String)

    private enum Wire {
        static let type = "type"
        static let version = "version"
        static let streamId = "streamId"
        static let hello = "hello"
        static let txStart = "tx-start"
        static let txStop = "tx-stop"
    }

    public func encoded() -> Data {
        let object: [String: Any]
        switch self {
        case let .hello(version):
            object = [Wire.type: Wire.hello, Wire.version: version]
        case let .txStart(streamId):
            object = [Wire.type: Wire.txStart, Wire.streamId: streamId]
        case let .txStop(streamId):
            object = [Wire.type: Wire.txStop, Wire.streamId: streamId]
        }
        // The three shapes above are always serialisable, so the failure branch is
        // unreachable; an empty payload is decoded as nil by the peer either way.
        return (try? JSONSerialization.data(withJSONObject: object)) ?? Data()
    }

    public static func decode(_ data: Data) -> ControlMessage? {
        guard
            let object = try? JSONSerialization.jsonObject(with: data),
            let json = object as? [String: Any],
            let type = json[Wire.type] as? String
        else {
            return nil
        }

        switch type {
        case Wire.hello:
            guard let version = json[Wire.version] as? Int else { return nil }
            return .hello(version: version)
        case Wire.txStart:
            guard let streamId = json[Wire.streamId] as? String else { return nil }
            return .txStart(streamId: streamId)
        case Wire.txStop:
            guard let streamId = json[Wire.streamId] as? String else { return nil }
            return .txStop(streamId: streamId)
        default:
            return nil
        }
    }
}
```

- [ ] **Step 5: Write the stream framing**

Create `ios/Radio/Sources/RadioKit/AudioFraming.swift`:

```swift
import Foundation

/// A Nearby STREAM payload is an ordered byte stream, so Opus packets need their own
/// boundaries: `UInt16` big-endian length, then that many bytes. Both engines frame
/// identically; see the cross-platform wire contract in the plan.
public enum AudioFraming {
    public static let maxFrameBytes = RadioConfig.Audio.maxEncodedFrameBytes

    public static func frame(_ payload: Data) -> Data {
        var framed = Data(capacity: payload.count + 2)
        let length = UInt16(clamping: payload.count).bigEndian
        withUnsafeBytes(of: length) { framed.append(contentsOf: $0) }
        framed.append(payload)
        return framed
    }
}

/// Accumulates bytes read from an incoming stream and hands back whole Opus packets.
public final class AudioFrameParser {
    private var buffer = Data()
    public private(set) var isDesynchronised = false

    public init() {}

    public func append(_ bytes: Data) -> [Data] {
        guard !isDesynchronised else { return [] }
        buffer.append(bytes)

        var frames: [Data] = []
        while buffer.count >= 2 {
            let high = Int(buffer[buffer.startIndex])
            let low = Int(buffer[buffer.startIndex + 1])
            let length = (high << 8) | low

            if length < 1 || length > AudioFraming.maxFrameBytes {
                isDesynchronised = true
                buffer.removeAll(keepingCapacity: false)
                return frames
            }
            guard buffer.count >= length + 2 else { break }

            let start = buffer.startIndex + 2
            frames.append(Data(buffer[start..<(start + length)]))
            buffer.removeSubrange(buffer.startIndex..<(start + length))
        }
        return frames
    }

    public func reset() {
        buffer.removeAll(keepingCapacity: false)
        isDesynchronised = false
    }
}
```

- [ ] **Step 6: Write the ports**

Create `ios/Radio/Sources/RadioKit/RadioPorts.swift`:

```swift
import Foundation

// MARK: - Transport

/// One live outgoing transmission. Frames are already Opus-encoded and framed by
/// the transport implementation.
public protocol AudioStreamSink: AnyObject {
    func write(frame: Data)
    func close()
}

/// Everything the engine needs from Nearby Connections, and nothing more.
public protocol RadioTransport: AnyObject {
    var delegate: RadioTransportDelegate? { get set }
    var connectedPeerCount: Int { get }

    func start() throws
    func stop()
    func broadcastControl(_ message: ControlMessage)
    func beginAudioStream(streamId: String) -> AudioStreamSink?
    func endAudioStream()
}

public protocol RadioTransportDelegate: AnyObject {
    func transport(_ transport: RadioTransport, peerCountDidChange count: Int)
    func transport(_ transport: RadioTransport, didStartIncomingAudio peerId: String)
    func transport(
        _ transport: RadioTransport,
        didReceiveAudioFrame frame: Data,
        from peerId: String
    )
    func transport(_ transport: RadioTransport, didStopIncomingAudio peerId: String)
    func transport(_ transport: RadioTransport, didFail error: RadioError)
}

// MARK: - Audio

public protocol AudioIO: AnyObject {
    var delegate: AudioIODelegate? { get set }

    func startPlayback() throws
    func stopPlayback()
    func startCapture() throws
    func stopCapture()
    func beginIncoming(peerId: String)
    func enqueue(frame: Data, from peerId: String)
    func endIncoming(peerId: String)
}

public protocol AudioIODelegate: AnyObject {
    /// One Opus packet ready to go out on the wire.
    func audioIO(_ audio: AudioIO, didEncodeFrame frame: Data)
    func audioIO(_ audio: AudioIO, didFail error: RadioError)
}

// MARK: - PTT

public protocol PttSource: AnyObject {
    var delegate: PttSourceDelegate? { get set }
    var buttonState: PttButtonState { get }

    func start()
    func stop()
    /// Opens a pairing session; resolves once the binding is saved.
    func beginLearning(completion: @escaping (Result<PttConfiguration, RadioError>) -> Void)
    /// The user's pick from the published candidates.
    func selectCandidate(deviceId: String)
    func forget()
}

public protocol PttSourceDelegate: AnyObject {
    func pttSourceDidPress(_ source: PttSource)
    func pttSourceDidRelease(_ source: PttSource)
    func pttSource(_ source: PttSource, buttonStateDidChange state: PttButtonState)
    /// nil ends the session and removes `pttPairing` from `RadioState`.
    func pttSource(_ source: PttSource, pairingStateDidChange state: PttPairingState?)
}

// MARK: - Background (PushToTalk)

public protocol BackgroundSession: AnyObject {
    var delegate: BackgroundSessionDelegate? { get set }

    func activate()
    func deactivate()
    func requestBeginTransmitting()
    func stopTransmitting()
    func setReceiving(_ receiving: Bool)
}

public protocol BackgroundSessionDelegate: AnyObject {
    /// The system activated the audio session; the microphone may start now.
    func backgroundSessionDidActivateAudio(_ session: BackgroundSession)
    func backgroundSessionDidDeactivateAudio(_ session: BackgroundSession)
    /// Transmission was started somewhere outside the app (the system PTT UI).
    func backgroundSessionDidRequestTransmitStart(_ session: BackgroundSession)
    func backgroundSessionDidRequestTransmitStop(_ session: BackgroundSession)
    func backgroundSession(_ session: BackgroundSession, didFail error: RadioError)
}

// MARK: - Clock

public protocol RadioCancellable: AnyObject {
    func cancel()
}

/// Injected so the 120 s safety cap is testable without waiting 120 s.
public protocol RadioClock: AnyObject {
    func schedule(after seconds: TimeInterval, _ block: @escaping () -> Void) -> RadioCancellable
}

public final class DispatchRadioClock: RadioClock {
    private let queue: DispatchQueue

    public init(queue: DispatchQueue) {
        self.queue = queue
    }

    public func schedule(
        after seconds: TimeInterval,
        _ block: @escaping () -> Void
    ) -> RadioCancellable {
        let item = DispatchWorkItem(block: block)
        queue.asyncAfter(deadline: .now() + seconds, execute: item)
        return Token(item: item)
    }

    private final class Token: RadioCancellable {
        private let item: DispatchWorkItem

        init(item: DispatchWorkItem) {
            self.item = item
        }

        func cancel() {
            item.cancel()
        }
    }
}
```

- [ ] **Step 7: Write the XCTest files (deliverables, not run by the gate)**

Create `ios/Radio/Tests/RadioKitTests/ControlMessageTests.swift`:

```swift
import XCTest
@testable import RadioKit

final class ControlMessageTests: XCTestCase {

    func testHelloEncodesTheSpecShape() throws {
        let data = ControlMessage.hello(version: 1).encoded()
        let json = try XCTUnwrap(
            try JSONSerialization.jsonObject(with: data) as? [String: Any]
        )
        XCTAssertEqual(json["type"] as? String, "hello")
        XCTAssertEqual(json["version"] as? Int, 1)
    }

    func testTransmitMessagesEncodeTheSpecShape() throws {
        let start = ControlMessage.txStart(streamId: "abc").encoded()
        let startJson = try XCTUnwrap(
            try JSONSerialization.jsonObject(with: start) as? [String: Any]
        )
        XCTAssertEqual(startJson["type"] as? String, "tx-start")
        XCTAssertEqual(startJson["streamId"] as? String, "abc")

        let stop = ControlMessage.txStop(streamId: "abc").encoded()
        let stopJson = try XCTUnwrap(
            try JSONSerialization.jsonObject(with: stop) as? [String: Any]
        )
        XCTAssertEqual(stopJson["type"] as? String, "tx-stop")
    }

    func testRoundTrip() {
        let messages: [ControlMessage] = [
            .hello(version: 1),
            .txStart(streamId: "s-1"),
            .txStop(streamId: "s-1")
        ]
        for message in messages {
            XCTAssertEqual(ControlMessage.decode(message.encoded()), message)
        }
    }

    func testDecodesAndroidsWireBytes() {
        let android = Data(#"{"type":"tx-start","streamId":"S1"}"#.utf8)
        XCTAssertEqual(ControlMessage.decode(android), .txStart(streamId: "S1"))
    }

    func testRejectsGarbageAndUnknownTypes() {
        XCTAssertNil(ControlMessage.decode(Data("not json".utf8)))
        XCTAssertNil(ControlMessage.decode(Data(#"{"type":"nope"}"#.utf8)))
        XCTAssertNil(ControlMessage.decode(Data(#"{"type":"hello"}"#.utf8)))
        XCTAssertNil(ControlMessage.decode(Data()))
    }
}
```

Create `ios/Radio/Tests/RadioKitTests/AudioFramingTests.swift`:

```swift
import XCTest
@testable import RadioKit

final class AudioFramingTests: XCTestCase {

    func testFramePrefixesBigEndianLength() {
        let framed = AudioFraming.frame(Data([0xAA, 0xBB, 0xCC]))
        XCTAssertEqual(Array(framed), [0x00, 0x03, 0xAA, 0xBB, 0xCC])
    }

    func testParserReturnsWholeFramesOnly() {
        let parser = AudioFrameParser()
        let framed = AudioFraming.frame(Data([1, 2, 3, 4]))

        XCTAssertEqual(parser.append(framed.prefix(3)), [])
        XCTAssertEqual(parser.append(framed.suffix(from: 3)), [Data([1, 2, 3, 4])])
    }

    func testParserSplitsSeveralFramesFromOneRead() {
        let parser = AudioFrameParser()
        var chunk = AudioFraming.frame(Data([1]))
        chunk.append(AudioFraming.frame(Data([2, 2])))

        XCTAssertEqual(parser.append(chunk), [Data([1]), Data([2, 2])])
    }

    func testOversizedLengthMarksDesync() {
        let parser = AudioFrameParser()
        _ = parser.append(Data([0xFF, 0xFF, 0x00]))

        XCTAssertTrue(parser.isDesynchronised)
        XCTAssertEqual(parser.append(AudioFraming.frame(Data([1]))), [])
    }

    func testResetClearsDesync() {
        let parser = AudioFrameParser()
        _ = parser.append(Data([0xFF, 0xFF]))
        parser.reset()

        XCTAssertFalse(parser.isDesynchronised)
        XCTAssertEqual(parser.append(AudioFraming.frame(Data([7]))), [Data([7])])
    }
}
```

- [ ] **Step 8: Run the test and confirm it passes**

Run: `pnpm test ios-radio-sources`
Expected: PASS — all `domain types`, `control protocol`, `stream framing`, `engine ports` and `layering` assertions green.

- [ ] **Step 9: Run the full task gate**

Run: `pnpm typecheck && pnpm lint && pnpm test ios-radio-sources`
Expected: all green.

- [ ] **Step 10: Commit**

```bash
rtk git add ios/Radio/Sources/RadioKit ios/Radio/Tests __tests__/ios-radio-sources.test.ts
rtk git commit -m "feat(ios): add radio domain types, control protocol, framing and ports"
```

---

### Task 3: The RadioEngine state machine

**Files:**
- Create: `ios/Radio/Sources/RadioKit/RadioEngine.swift`
- Create: `ios/Radio/Tests/RadioKitTests/Fakes.swift`
- Create: `ios/Radio/Tests/RadioKitTests/RadioEngineTests.swift`
- Modify: `__tests__/ios-radio-sources.test.ts` (append one describe block)

**Interfaces:**
- Consumes: every port and type from Task 2; `RadioConfig.Transmit.safetyCapSeconds`.
- Produces: `RadioEngine` with `init(transport:audio:ptt:background:clock:queue:)`, `startRadio()`, `stopRadio()`, `startTransmit()`, `stopTransmit()`, `getState(completion:)`, `configurePtt(completion:)`, `selectPttCandidate(deviceId:)`, `forgetPtt()`, `addObserver(_:_:)`, `removeObserver(_:)`. It conforms to `RadioTransportDelegate`, `AudioIODelegate`, `PttSourceDelegate`, `BackgroundSessionDelegate`. This is the type P5's Turbo Module calls.

**Spec §6.3 maps onto this file like this**, so a reviewer can check it line by line:

| §6.3 operation | Here |
|---|---|
| `startRadio` / `stopRadio` | `startRadio()` / `stopRadio()` |
| `startTransmit` / `stopTransmit` | `startTransmit()` / `stopTransmit()` |
| `peerConnected` / `peerDisconnected` | `transport(_:peerCountDidChange:)` — the transport owns endpoint identity and the engine only mirrors the count, because `RadioState` (§6.1) exposes `nearbyCount` and nothing per-peer |
| `incomingAudioStarted` / `incomingAudioStopped` | `transport(_:didStartIncomingAudio:)` / `transport(_:didStopIncomingAudio:)`, per peer, because playback and mixing are per peer |

**The transmit path (spec §10.2) — read before writing the code.** A press does **not** start the microphone directly. It asks PushToTalk to begin transmitting; the system activates the audio session and calls back; only then does capture start. That indirection is the whole reason a locked iPhone can transmit, so the engine has three transmit states, not two: idle, awaiting-audio-session, transmitting. `state.transmitting` is true only in the third — the mirror must not claim the radio is on air before the microphone is.

- [ ] **Step 1: Write the failing test**

Append to `__tests__/ios-radio-sources.test.ts`:

```ts
describe('RadioEngine (spec sections 6.3, 9.4, 13)', () => {
  const engine = source('RadioEngine.swift');

  it.each([
    'public final class RadioEngine',
    'public func startRadio()',
    'public func stopRadio()',
    'public func startTransmit()',
    'public func stopTransmit()',
    'public func getState(completion: @escaping (RadioState) -> Void)',
    'public func selectPttCandidate(deviceId: String)',
    'public func forgetPtt()',
    'public func addObserver(',
    'public func removeObserver(',
  ])('declares %s', declaration => {
    expect(engine).toContain(declaration);
  });

  it('mirrors the pairing session into state and clears it when it ends', () => {
    expect(engine).toContain('pairingStateDidChange state: PttPairingState?');
    expect(engine).toContain('state.pttPairing = nil');
  });

  it.each([
    'RadioTransportDelegate',
    'AudioIODelegate',
    'PttSourceDelegate',
    'BackgroundSessionDelegate',
  ])('conforms to %s', protocolName => {
    expect(engine).toContain(`extension RadioEngine: ${protocolName}`);
  });

  it('arms the safety cap from config, never from a literal', () => {
    expect(engine).toContain('RadioConfig.Transmit.safetyCapSeconds');
    expect(engine).not.toMatch(/=\s*120\b/);
  });

  it('asks PushToTalk before it opens the microphone', () => {
    const request = engine.indexOf('background.requestBeginTransmitting()');
    const capture = engine.indexOf('audio.startCapture()');
    expect(request).toBeGreaterThan(-1);
    expect(capture).toBeGreaterThan(-1);
    expect(request).toBeLessThan(capture);
  });

  it('announces transmissions with the control protocol', () => {
    expect(engine).toContain('broadcastControl(.txStart(streamId:');
    expect(engine).toContain('broadcastControl(.txStop(streamId:');
  });

  it('serialises all state on one queue', () => {
    expect(engine).toContain('private let queue: DispatchQueue');
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `pnpm test ios-radio-sources`
Expected: FAIL — the new `RadioEngine` block fails; the Task 2 blocks stay green.

- [ ] **Step 3: Write the engine**

Create `ios/Radio/Sources/RadioKit/RadioEngine.swift`:

```swift
import Foundation
import os

/// The radio itself (spec section 6.3). Owns all realtime state, runs entirely
/// without React Native, and reports outward through observers.
///
/// Every mutation happens on `queue`; public entry points hop onto it, delegate
/// callbacks from the ports hop onto it, and observers are notified from it.
public final class RadioEngine {

    private let queue: DispatchQueue
    private let transport: RadioTransport
    private let audio: AudioIO
    private let ptt: PttSource
    private let background: BackgroundSession
    private let clock: RadioClock
    private let log = Logger(
        subsystem: RadioConfig.Logging.subsystem,
        category: "engine"
    )

    private var state = RadioState()
    private var isStarted = false
    private var isAwaitingAudioSession = false
    private var currentStreamId: String?
    private var sink: AudioStreamSink?
    private var safetyCap: RadioCancellable?
    private var receivingPeers: Set<String> = []
    private var observers: [String: (RadioEvent) -> Void] = [:]

    public init(
        transport: RadioTransport,
        audio: AudioIO,
        ptt: PttSource,
        background: BackgroundSession,
        clock: RadioClock,
        queue: DispatchQueue
    ) {
        self.transport = transport
        self.audio = audio
        self.ptt = ptt
        self.background = background
        self.clock = clock
        self.queue = queue

        transport.delegate = self
        audio.delegate = self
        ptt.delegate = self
        background.delegate = self
    }

    // MARK: - Observation

    public func addObserver(_ id: String, _ handler: @escaping (RadioEvent) -> Void) {
        queue.async {
            self.observers[id] = handler
            handler(.stateChanged(self.state))
        }
    }

    public func removeObserver(_ id: String) {
        queue.async { self.observers.removeValue(forKey: id) }
    }

    public func getState(completion: @escaping (RadioState) -> Void) {
        queue.async { completion(self.state) }
    }

    // MARK: - startRadio / stopRadio

    public func startRadio() {
        queue.async { self.startRadioLocked() }
    }

    public func stopRadio() {
        queue.async { self.stopRadioLocked() }
    }

    private func startRadioLocked() {
        guard !isStarted else { return }
        isStarted = true
        state.status = .starting
        state.pttButton = ptt.buttonState
        emitStateLocked()

        ptt.start()
        background.activate()

        do {
            try audio.startPlayback()
            try transport.start()
        } catch {
            failLocked(.startFailed(String(describing: error)), fatal: true)
            return
        }

        state.status = .ready
        state.nearbyCount = transport.connectedPeerCount
        emitStateLocked()
        log.info("radio started")
    }

    private func stopRadioLocked() {
        guard isStarted else { return }
        stopTransmitLocked()
        transport.stop()
        audio.stopPlayback()
        background.deactivate()
        ptt.stop()

        receivingPeers.removeAll()
        isStarted = false
        state = RadioState(status: .starting, pttButton: ptt.buttonState)
        emitStateLocked()
        log.info("radio stopped")
    }

    // MARK: - startTransmit / stopTransmit

    public func startTransmit() {
        queue.async { self.startTransmitLocked() }
    }

    public func stopTransmit() {
        queue.async { self.stopTransmitLocked() }
    }

    private func startTransmitLocked() {
        guard isStarted, state.status != .error else { return }
        guard !state.transmitting, !isAwaitingAudioSession else { return }

        isAwaitingAudioSession = true
        armSafetyCapLocked()
        background.requestBeginTransmitting()
        log.info("transmit requested")
    }

    /// Called once the system has handed us an active audio session.
    private func beginTransmitLocked() {
        guard isAwaitingAudioSession, !state.transmitting else { return }
        isAwaitingAudioSession = false

        let streamId = UUID().uuidString
        currentStreamId = streamId
        transport.broadcastControl(.txStart(streamId: streamId))
        sink = transport.beginAudioStream(streamId: streamId)

        do {
            try audio.startCapture()
        } catch {
            sink?.close()
            sink = nil
            transport.endAudioStream()
            transport.broadcastControl(.txStop(streamId: streamId))
            currentStreamId = nil
            background.stopTransmitting()
            cancelSafetyCapLocked()
            failLocked(.audioFailed(String(describing: error)), fatal: false)
            return
        }

        state.transmitting = true
        emitStateLocked()
        log.info("transmitting \(streamId, privacy: .public)")
    }

    private func stopTransmitLocked() {
        cancelSafetyCapLocked()
        guard state.transmitting || isAwaitingAudioSession else { return }

        isAwaitingAudioSession = false
        if state.transmitting {
            audio.stopCapture()
        }
        sink?.close()
        sink = nil
        transport.endAudioStream()

        if let streamId = currentStreamId {
            transport.broadcastControl(.txStop(streamId: streamId))
            currentStreamId = nil
        }
        background.stopTransmitting()

        if state.transmitting {
            state.transmitting = false
            emitStateLocked()
        }
        log.info("transmit stopped")
    }

    private func armSafetyCapLocked() {
        cancelSafetyCapLocked()
        safetyCap = clock.schedule(after: RadioConfig.Transmit.safetyCapSeconds) {
            [weak self] in
            guard let self else { return }
            self.queue.async {
                self.log.info("safety cap reached, stopping transmission")
                self.stopTransmitLocked()
            }
        }
    }

    private func cancelSafetyCapLocked() {
        safetyCap?.cancel()
        safetyCap = nil
    }

    // MARK: - PTT configuration

    /// Opens the native pairing session (amended spec section 6.1). Progress is
    /// published as `state.pttPairing`; this resolves once the binding is saved.
    public func configurePtt(
        completion: @escaping (Result<PttConfiguration, RadioError>) -> Void
    ) {
        queue.async {
            self.ptt.beginLearning { result in
                self.queue.async {
                    if case .success = result {
                        self.state.pttButton = self.ptt.buttonState
                    }
                    // The session is over either way. `.saved` was already
                    // delivered in its own snapshot by the PTT source, so this
                    // is one emission, not two.
                    self.state.pttPairing = nil
                    self.emitStateLocked()

                    completion(result)
                    if case let .failure(error) = result {
                        self.failLocked(error, fatal: false)
                    }
                }
            }
        }
    }

    /// The user's pick from `state.pttPairing.candidates`.
    public func selectPttCandidate(deviceId: String) {
        queue.async { self.ptt.selectCandidate(deviceId: deviceId) }
    }

    public func forgetPtt() {
        queue.async {
            self.ptt.forget()
            self.state.pttButton = self.ptt.buttonState
            self.emitStateLocked()
        }
    }

    // MARK: - Emission

    private func emitStateLocked() {
        notifyLocked(.stateChanged(state))
    }

    private func failLocked(_ error: RadioError, fatal: Bool) {
        log.error("\(error.code, privacy: .public): \(error.message, privacy: .public)")
        if fatal {
            state.status = .error
            emitStateLocked()
        }
        notifyLocked(.error(error))
    }

    private func notifyLocked(_ event: RadioEvent) {
        for handler in observers.values {
            handler(event)
        }
    }
}

// MARK: - RadioTransportDelegate

extension RadioEngine: RadioTransportDelegate {

    public func transport(_ transport: RadioTransport, peerCountDidChange count: Int) {
        queue.async {
            guard self.state.nearbyCount != count else { return }
            self.state.nearbyCount = count
            self.emitStateLocked()
        }
    }

    public func transport(
        _ transport: RadioTransport,
        didStartIncomingAudio peerId: String
    ) {
        queue.async {
            let wasSilent = self.receivingPeers.isEmpty
            self.receivingPeers.insert(peerId)
            self.audio.beginIncoming(peerId: peerId)
            if wasSilent {
                self.background.setReceiving(true)
            }
            guard !self.state.receiving else { return }
            self.state.receiving = true
            self.emitStateLocked()
        }
    }

    public func transport(
        _ transport: RadioTransport,
        didReceiveAudioFrame frame: Data,
        from peerId: String
    ) {
        queue.async {
            guard self.receivingPeers.contains(peerId) else { return }
            self.audio.enqueue(frame: frame, from: peerId)
        }
    }

    public func transport(
        _ transport: RadioTransport,
        didStopIncomingAudio peerId: String
    ) {
        queue.async {
            guard self.receivingPeers.remove(peerId) != nil else { return }
            self.audio.endIncoming(peerId: peerId)
            guard self.receivingPeers.isEmpty else { return }
            self.background.setReceiving(false)
            self.state.receiving = false
            self.emitStateLocked()
        }
    }

    public func transport(_ transport: RadioTransport, didFail error: RadioError) {
        queue.async { self.failLocked(error, fatal: true) }
    }
}

// MARK: - AudioIODelegate

extension RadioEngine: AudioIODelegate {

    public func audioIO(_ audio: AudioIO, didEncodeFrame frame: Data) {
        queue.async {
            guard self.state.transmitting else { return }
            self.sink?.write(frame: frame)
        }
    }

    public func audioIO(_ audio: AudioIO, didFail error: RadioError) {
        queue.async {
            self.stopTransmitLocked()
            self.failLocked(error, fatal: false)
        }
    }
}

// MARK: - PttSourceDelegate

extension RadioEngine: PttSourceDelegate {

    public func pttSourceDidPress(_ source: PttSource) {
        startTransmit()
    }

    public func pttSourceDidRelease(_ source: PttSource) {
        stopTransmit()
    }

    public func pttSource(_ source: PttSource, buttonStateDidChange state: PttButtonState) {
        queue.async {
            guard self.state.pttButton != state else { return }
            self.state.pttButton = state
            self.emitStateLocked()
        }
    }

    public func pttSource(_ source: PttSource, pairingStateDidChange state: PttPairingState?) {
        queue.async {
            guard self.state.pttPairing != state else { return }
            self.state.pttPairing = state
            self.emitStateLocked()
        }
    }
}

// MARK: - BackgroundSessionDelegate

extension RadioEngine: BackgroundSessionDelegate {

    public func backgroundSessionDidActivateAudio(_ session: BackgroundSession) {
        queue.async { self.beginTransmitLocked() }
    }

    public func backgroundSessionDidDeactivateAudio(_ session: BackgroundSession) {
        queue.async { self.stopTransmitLocked() }
    }

    public func backgroundSessionDidRequestTransmitStart(_ session: BackgroundSession) {
        startTransmit()
    }

    public func backgroundSessionDidRequestTransmitStop(_ session: BackgroundSession) {
        stopTransmit()
    }

    public func backgroundSession(
        _ session: BackgroundSession,
        didFail error: RadioError
    ) {
        queue.async { self.failLocked(error, fatal: false) }
    }
}
```

- [ ] **Step 4: Write the fakes**

Create `ios/Radio/Tests/RadioKitTests/Fakes.swift`:

```swift
import Foundation
@testable import RadioKit

final class FakeSink: AudioStreamSink {
    private(set) var frames: [Data] = []
    private(set) var isClosed = false

    func write(frame: Data) {
        frames.append(frame)
    }

    func close() {
        isClosed = true
    }
}

final class FakeTransport: RadioTransport {
    weak var delegate: RadioTransportDelegate?
    var connectedPeerCount = 0

    var startError: Error?
    private(set) var isStarted = false
    private(set) var sentControl: [ControlMessage] = []
    private(set) var openedStreamIds: [String] = []
    private(set) var endedStreams = 0
    private(set) var sink = FakeSink()

    func start() throws {
        if let startError { throw startError }
        isStarted = true
    }

    func stop() {
        isStarted = false
    }

    func broadcastControl(_ message: ControlMessage) {
        sentControl.append(message)
    }

    func beginAudioStream(streamId: String) -> AudioStreamSink? {
        openedStreamIds.append(streamId)
        sink = FakeSink()
        return sink
    }

    func endAudioStream() {
        endedStreams += 1
    }
}

final class FakeAudio: AudioIO {
    weak var delegate: AudioIODelegate?

    var captureError: Error?
    private(set) var isCapturing = false
    private(set) var isPlaying = false
    private(set) var incoming: [String] = []
    private(set) var enqueued: [(String, Data)] = []

    func startPlayback() throws {
        isPlaying = true
    }

    func stopPlayback() {
        isPlaying = false
    }

    func startCapture() throws {
        if let captureError { throw captureError }
        isCapturing = true
    }

    func stopCapture() {
        isCapturing = false
    }

    func beginIncoming(peerId: String) {
        incoming.append(peerId)
    }

    func enqueue(frame: Data, from peerId: String) {
        enqueued.append((peerId, frame))
    }

    func endIncoming(peerId: String) {
        incoming.removeAll { $0 == peerId }
    }
}

final class FakePtt: PttSource {
    weak var delegate: PttSourceDelegate?
    var buttonState = PttButtonState()
    private(set) var isStarted = false
    private(set) var didForget = false
    private(set) var selectedDeviceIds: [String] = []
    private var learningCompletion: ((Result<PttConfiguration, RadioError>) -> Void)?

    func start() {
        isStarted = true
    }

    func stop() {
        isStarted = false
    }

    func beginLearning(completion: @escaping (Result<PttConfiguration, RadioError>) -> Void) {
        learningCompletion = completion
        delegate?.pttSource(self, pairingStateDidChange: PttPairingState(phase: .scanning))
    }

    func selectCandidate(deviceId: String) {
        selectedDeviceIds.append(deviceId)
        delegate?.pttSource(self, pairingStateDidChange: PttPairingState(phase: .learning))
    }

    func forget() {
        didForget = true
        buttonState = PttButtonState()
    }

    /// Stands in for the button being learned and the binding saved.
    func finishLearning(_ result: Result<PttConfiguration, RadioError>) {
        if case let .success(configuration) = result {
            buttonState = PttButtonState(
                configured: true,
                connected: true,
                name: configuration.name
            )
            delegate?.pttSource(self, pairingStateDidChange: PttPairingState(phase: .saved))
        }
        let completion = learningCompletion
        learningCompletion = nil
        completion?(result)
    }
}

final class FakeBackground: BackgroundSession {
    weak var delegate: BackgroundSessionDelegate?
    private(set) var isActive = false
    private(set) var transmitRequests = 0
    private(set) var transmitStops = 0
    private(set) var receivingFlags: [Bool] = []

    func activate() {
        isActive = true
    }

    func deactivate() {
        isActive = false
    }

    func requestBeginTransmitting() {
        transmitRequests += 1
    }

    func stopTransmitting() {
        transmitStops += 1
    }

    func setReceiving(_ receiving: Bool) {
        receivingFlags.append(receiving)
    }

    /// Stands in for the system handing us an active audio session.
    func grantAudioSession() {
        delegate?.backgroundSessionDidActivateAudio(self)
    }
}

final class ManualClock: RadioClock {
    private var pending: [(id: Int, seconds: TimeInterval, block: () -> Void)] = []
    private var nextId = 0
    private(set) var scheduledDelays: [TimeInterval] = []

    func schedule(
        after seconds: TimeInterval,
        _ block: @escaping () -> Void
    ) -> RadioCancellable {
        nextId += 1
        let id = nextId
        scheduledDelays.append(seconds)
        pending.append((id, seconds, block))
        return Token(clock: self, id: id)
    }

    func fireAll() {
        let due = pending
        pending.removeAll()
        for entry in due {
            entry.block()
        }
    }

    fileprivate func cancel(id: Int) {
        pending.removeAll { $0.id == id }
    }

    private final class Token: RadioCancellable {
        private weak var clock: ManualClock?
        private let id: Int

        init(clock: ManualClock, id: Int) {
            self.clock = clock
            self.id = id
        }

        func cancel() {
            clock?.cancel(id: id)
        }
    }
}
```

- [ ] **Step 5: Write the engine tests**

Create `ios/Radio/Tests/RadioKitTests/RadioEngineTests.swift`:

```swift
import XCTest
@testable import RadioKit

final class RadioEngineTests: XCTestCase {

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
        queue = DispatchQueue(label: "radio.engine.tests")
        engine = RadioEngine(
            transport: transport,
            audio: audio,
            ptt: ptt,
            background: background,
            clock: clock,
            queue: queue
        )
    }

    /// The engine is asynchronous by design; drain its queue before asserting.
    private func flush() {
        queue.sync {}
    }

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

    func testStartRadioBringsUpEveryPortAndReportsReady() {
        engine.startRadio()
        flush()

        XCTAssertTrue(transport.isStarted)
        XCTAssertTrue(audio.isPlaying)
        XCTAssertTrue(background.isActive)
        XCTAssertTrue(ptt.isStarted)
        XCTAssertEqual(currentState().status, .ready)
    }

    func testStartFailureIsFatal() {
        transport.startError = RadioError.transportFailed("no wifi")
        engine.startRadio()
        flush()

        XCTAssertEqual(currentState().status, .error)
    }

    func testPressAsksPushToTalkAndDoesNotOpenTheMicrophoneYet() {
        engine.startRadio()
        flush()

        ptt.delegate?.pttSourceDidPress(ptt)
        flush()

        XCTAssertEqual(background.transmitRequests, 1)
        XCTAssertFalse(audio.isCapturing)
        XCTAssertFalse(currentState().transmitting)
    }

    func testAudioSessionActivationStartsTheTransmission() {
        engine.startRadio()
        flush()
        ptt.delegate?.pttSourceDidPress(ptt)
        flush()

        background.grantAudioSession()
        flush()

        XCTAssertTrue(audio.isCapturing)
        XCTAssertEqual(transport.openedStreamIds.count, 1)
        XCTAssertTrue(currentState().transmitting)

        guard case let .txStart(streamId) = transport.sentControl.last else {
            return XCTFail("expected a tx-start control message")
        }
        XCTAssertEqual(streamId, transport.openedStreamIds[0])
    }

    func testReleaseStopsEverythingAndAnnouncesTxStop() {
        engine.startRadio()
        flush()
        ptt.delegate?.pttSourceDidPress(ptt)
        flush()
        background.grantAudioSession()
        flush()

        ptt.delegate?.pttSourceDidRelease(ptt)
        flush()

        XCTAssertFalse(audio.isCapturing)
        XCTAssertEqual(transport.endedStreams, 1)
        XCTAssertEqual(background.transmitStops, 1)
        XCTAssertFalse(currentState().transmitting)

        guard case .txStop = transport.sentControl.last else {
            return XCTFail("expected a tx-stop control message")
        }
    }

    func testEncodedFramesReachTheStreamOnlyWhileTransmitting() {
        engine.startRadio()
        flush()
        audio.delegate?.audioIO(audio, didEncodeFrame: Data([9]))
        flush()

        ptt.delegate?.pttSourceDidPress(ptt)
        flush()
        background.grantAudioSession()
        flush()
        audio.delegate?.audioIO(audio, didEncodeFrame: Data([1, 2]))
        flush()

        XCTAssertEqual(transport.sink.frames, [Data([1, 2])])
    }

    func testSafetyCapStopsTransmissionAfter120Seconds() {
        engine.startRadio()
        flush()
        ptt.delegate?.pttSourceDidPress(ptt)
        flush()
        background.grantAudioSession()
        flush()

        XCTAssertEqual(clock.scheduledDelays, [120])

        clock.fireAll()
        flush()

        XCTAssertFalse(currentState().transmitting)
        XCTAssertFalse(audio.isCapturing)
    }

    func testPeerCountAndIncomingAudioAreMirroredInState() {
        engine.startRadio()
        flush()

        transport.delegate?.transport(transport, peerCountDidChange: 2)
        transport.delegate?.transport(transport, didStartIncomingAudio: "peer-a")
        flush()

        XCTAssertEqual(currentState().nearbyCount, 2)
        XCTAssertTrue(currentState().receiving)
        XCTAssertEqual(background.receivingFlags, [true])

        transport.delegate?.transport(
            transport,
            didReceiveAudioFrame: Data([4]),
            from: "peer-a"
        )
        transport.delegate?.transport(transport, didStopIncomingAudio: "peer-a")
        flush()

        XCTAssertEqual(audio.enqueued.count, 1)
        XCTAssertFalse(currentState().receiving)
        XCTAssertEqual(background.receivingFlags, [true, false])
    }

    func testTwoTransmittersKeepReceivingUntilBothStop() {
        engine.startRadio()
        flush()

        transport.delegate?.transport(transport, didStartIncomingAudio: "a")
        transport.delegate?.transport(transport, didStartIncomingAudio: "b")
        transport.delegate?.transport(transport, didStopIncomingAudio: "a")
        flush()

        XCTAssertTrue(currentState().receiving)

        transport.delegate?.transport(transport, didStopIncomingAudio: "b")
        flush()

        XCTAssertFalse(currentState().receiving)
    }

    func testPairingSessionIsMirroredIntoStateAndClearedWhenItEnds() {
        engine.startRadio()
        flush()

        var snapshots: [PttPairingState?] = []
        engine.addObserver("pairing") { event in
            if case let .stateChanged(state) = event {
                snapshots.append(state.pttPairing)
            }
        }
        flush()

        var resolved: PttConfiguration?
        engine.configurePtt { result in
            if case let .success(configuration) = result {
                resolved = configuration
            }
        }
        flush()

        engine.selectPttCandidate(deviceId: "device-1")
        flush()
        XCTAssertEqual(ptt.selectedDeviceIds, ["device-1"])

        let configuration = PttConfiguration(
            name: "PTT-1",
            binding: .ble(
                deviceId: "device-1",
                serviceUuid: "1812",
                characteristicUuid: "2A4D",
                pressedValue: "01",
                releasedValue: "00"
            )
        )
        ptt.finishLearning(.success(configuration))
        flush()

        XCTAssertEqual(resolved, configuration)
        XCTAssertEqual(
            snapshots.compactMap { $0?.phase },
            [.scanning, .learning, .saved]
        )
        XCTAssertNil(currentState().pttPairing)
        XCTAssertEqual(currentState().pttButton.name, "PTT-1")
    }

    func testFailedPairingClearsTheSessionAndReportsAnError() {
        engine.startRadio()
        flush()

        var errors: [RadioError] = []
        engine.addObserver("errors") { event in
            if case let .error(error) = event {
                errors.append(error)
            }
        }
        engine.configurePtt { _ in }
        flush()

        ptt.finishLearning(.failure(.pairingFailed("nothing was pressed")))
        flush()

        XCTAssertNil(currentState().pttPairing)
        XCTAssertEqual(errors.map(\.code), ["pairing_failed"])
        XCTAssertEqual(currentState().status, .ready)
    }

    func testObserversReceiveTheCurrentStateImmediately() {
        var events: [RadioEvent] = []
        engine.addObserver("test") { events.append($0) }
        flush()

        XCTAssertEqual(events.count, 1)
        engine.removeObserver("test")
        engine.startRadio()
        flush()

        XCTAssertEqual(events.count, 1)
    }
}
```

- [ ] **Step 6: Run the test and confirm it passes**

Run: `pnpm test ios-radio-sources`
Expected: PASS.

- [ ] **Step 7: Run the full task gate**

Run: `pnpm typecheck && pnpm lint && pnpm test ios-radio-sources`
Expected: all green.

- [ ] **Step 8: Commit**

```bash
rtk git add ios/Radio __tests__/ios-radio-sources.test.ts
rtk git commit -m "feat(ios): add the RadioEngine state machine with a 120s safety cap"
```

---

### Task 4: NearbyManager — the transport

**Files:**
- Create: `ios/Radio/Sources/RadioKit/NearbyManager.swift`
- Modify: `__tests__/ios-radio-sources.test.ts` (append one describe block)

**Interfaces:**
- Consumes: `RadioTransport`, `RadioTransportDelegate`, `AudioStreamSink`, `ControlMessage`, `AudioFraming`, `AudioFrameParser`, `RadioError`, `RadioConfig.serviceId`, `RadioConfig.protocolVersion`, `RadioConfig.Reconnect.*`.
- Produces: `NearbyManager` — `init(queue: DispatchQueue)`, conforms to `RadioTransport`. **The only file in the package permitted to `import NearbyConnections`.**

**This is the file the Phase 0 Go/No-Go decision is really about.** Everything vendor-specific lives here: strategy, auto-accept, the version handshake, one STREAM per transmission fanned out to every peer, and reconnect with backoff. If Phase 0 comes back No-Go and the transport is replaced, this file and `Package.swift` are what get rewritten — nothing above them.

- [ ] **Step 1: Write the failing test**

Append to `__tests__/ios-radio-sources.test.ts`:

```ts
describe('NearbyManager (spec section 7)', () => {
  const nearby = source('NearbyManager.swift');

  it.each([
    'public final class NearbyManager',
    'extension NearbyManager: AdvertiserDelegate',
    'extension NearbyManager: DiscovererDelegate',
    'extension NearbyManager: ConnectionManagerDelegate',
  ])('declares %s', declaration => {
    expect(nearby).toContain(declaration);
  });

  it('advertises and discovers on the shared service id', () => {
    expect(nearby).toContain('RadioConfig.serviceId');
    expect(nearby).toContain('startAdvertising');
    expect(nearby).toContain('startDiscovery');
  });

  it('uses the P2P_CLUSTER strategy', () => {
    expect(nearby).toContain('strategy: .cluster');
  });

  it('accepts every connection without a peer-selection UI', () => {
    expect(nearby).toContain('connectionRequestHandler(true)');
    expect(nearby).toContain('verificationHandler(true)');
  });

  it('gates peers behind the hello version handshake', () => {
    expect(nearby).toContain('.hello(version: RadioConfig.protocolVersion)');
    expect(nearby).toContain('RadioConfig.protocolVersion');
    expect(nearby).toContain('disconnect(from:');
  });

  it('frames audio with the shared framing helpers', () => {
    expect(nearby).toContain('AudioFraming.frame(');
    expect(nearby).toContain('AudioFrameParser()');
  });

  it('reconnects with backoff from config', () => {
    expect(nearby).toContain('RadioConfig.Reconnect.initialDelay');
    expect(nearby).toContain('RadioConfig.Reconnect.maxDelay');
    expect(nearby).toContain('RadioConfig.Reconnect.multiplier');
  });

  it('is the only file that imports NearbyConnections', () => {
    const importers = swiftFiles().filter(name =>
      source(name).includes('import NearbyConnections'),
    );
    expect(importers).toEqual(['NearbyManager.swift']);
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `pnpm test ios-radio-sources`
Expected: FAIL — the `NearbyManager` block fails; earlier blocks stay green.

- [ ] **Step 3: Write the outgoing and incoming stream helpers**

Create `ios/Radio/Sources/RadioKit/NearbyManager.swift` and start it with the file header and the two stream helpers:

```swift
import Foundation
import NearbyConnections
import os

/// One outgoing transmission. Nearby wants an `InputStream`, so a bound pair is
/// created and Opus frames are written into the output end as they are encoded.
///
/// Writes never block the audio path: if the pipe has no space the frame is
/// dropped. Dropping a 20 ms frame of live speech is correct; stalling the
/// capture callback is not.
final class OutgoingAudioStream: AudioStreamSink {
    private let output: OutputStream
    private let queue: DispatchQueue
    private let log: Logger
    private var isClosed = false
    private var droppedFrames = 0

    init(output: OutputStream, queue: DispatchQueue, log: Logger) {
        self.output = output
        self.queue = queue
        self.log = log
        output.open()
    }

    func write(frame: Data) {
        queue.async { [self] in
            guard !isClosed else { return }
            guard output.hasSpaceAvailable else {
                droppedFrames += 1
                return
            }
            let framed = AudioFraming.frame(frame)
            _ = framed.withUnsafeBytes { raw -> Int in
                guard let base = raw.bindMemory(to: UInt8.self).baseAddress else {
                    return 0
                }
                return output.write(base, maxLength: framed.count)
            }
        }
    }

    func close() {
        queue.async { [self] in
            guard !isClosed else { return }
            isClosed = true
            output.close()
            if droppedFrames > 0 {
                log.info("dropped \(self.droppedFrames, privacy: .public) audio frames")
            }
        }
    }
}

/// One incoming transmission. Read on its own thread with blocking reads — no
/// run loop is available on the queues the engine uses.
final class IncomingAudioStream {
    let peerId: String
    private let stream: InputStream
    private let parser = AudioFrameParser()
    private let onFrame: (Data, String) -> Void
    private let onEnd: (String) -> Void
    private var thread: Thread?
    private var isCancelled = false

    init(
        peerId: String,
        stream: InputStream,
        onFrame: @escaping (Data, String) -> Void,
        onEnd: @escaping (String) -> Void
    ) {
        self.peerId = peerId
        self.stream = stream
        self.onFrame = onFrame
        self.onEnd = onEnd
    }

    func start() {
        let thread = Thread { [weak self] in self?.readLoop() }
        thread.name = "radio.incoming.\(peerId)"
        thread.qualityOfService = .userInteractive
        self.thread = thread
        thread.start()
    }

    func cancel() {
        isCancelled = true
    }

    private func readLoop() {
        stream.open()
        var buffer = [UInt8](repeating: 0, count: 4_096)

        while !isCancelled {
            let read = stream.read(&buffer, maxLength: buffer.count)
            guard read > 0 else { break }
            for frame in parser.append(Data(buffer[0..<read])) {
                onFrame(frame, peerId)
            }
            if parser.isDesynchronised { break }
        }

        stream.close()
        onEnd(peerId)
    }
}
```

- [ ] **Step 4: Write the peer table and the transport itself**

Append to `ios/Radio/Sources/RadioKit/NearbyManager.swift`:

```swift
/// Everything known about one endpoint. A peer only counts once its `hello`
/// has been seen and accepted (cross-platform wire contract).
private struct Peer {
    var isConnected = false
    var didHandshake = false
    var retryDelay: TimeInterval = RadioConfig.Reconnect.initialDelay
    var isVisible = false
}

public final class NearbyManager: RadioTransport {

    public weak var delegate: RadioTransportDelegate?

    private let queue: DispatchQueue
    private let log = Logger(
        subsystem: RadioConfig.Logging.subsystem,
        category: "nearby"
    )

    private var connectionManager: ConnectionManager?
    private var advertiser: Advertiser?
    private var discoverer: Discoverer?

    private var peers: [EndpointID: Peer] = [:]
    private var incoming: [EndpointID: IncomingAudioStream] = [:]
    private var outgoing: OutgoingAudioStream?
    private var outgoingTokens: [CancellationToken] = []

    public init(queue: DispatchQueue) {
        self.queue = queue
    }

    public var connectedPeerCount: Int {
        queue.sync { handshakenPeerIds().count }
    }

    // MARK: - RadioTransport

    public func start() throws {
        let manager = ConnectionManager(
            serviceID: RadioConfig.serviceId,
            strategy: .cluster
        )
        manager.delegate = self

        let advertiser = Advertiser(connectionManager: manager)
        advertiser.delegate = self
        let discoverer = Discoverer(connectionManager: manager)
        discoverer.delegate = self

        connectionManager = manager
        self.advertiser = advertiser
        self.discoverer = discoverer

        let endpointInfo = Data(ProcessInfo.processInfo.hostName.utf8)
        advertiser.startAdvertising(using: endpointInfo) { [weak self] error in
            guard let self, let error else { return }
            self.report(.transportFailed("advertising: \(error)"))
        }
        discoverer.startDiscovery { [weak self] error in
            guard let self, let error else { return }
            self.report(.transportFailed("discovery: \(error)"))
        }
        log.info("nearby started on \(RadioConfig.serviceId, privacy: .public)")
    }

    public func stop() {
        queue.sync {
            endAudioStreamLocked()
            for (endpointID, _) in peers {
                connectionManager?.disconnect(from: endpointID)
                incoming[endpointID]?.cancel()
            }
            peers.removeAll()
            incoming.removeAll()
        }
        advertiser?.stopAdvertising { _ in }
        discoverer?.stopDiscovery { _ in }
        advertiser = nil
        discoverer = nil
        connectionManager = nil
        log.info("nearby stopped")
    }

    public func broadcastControl(_ message: ControlMessage) {
        queue.async { [self] in
            let targets = handshakenPeerIds()
            guard !targets.isEmpty, let manager = connectionManager else { return }
            _ = manager.send(message.encoded(), to: targets) { _ in }
        }
    }

    public func beginAudioStream(streamId: String) -> AudioStreamSink? {
        queue.sync { [self] in
            endAudioStreamLocked()
            let targets = handshakenPeerIds()
            guard !targets.isEmpty, let manager = connectionManager else { return nil }

            // One STREAM per transmission, fanned out to every peer (spec section 7).
            var input: InputStream?
            var output: OutputStream?
            Stream.getBoundStreams(
                with: 64 * 1_024,
                inputStream: &input,
                outputStream: &output
            )
            guard let input, let output else {
                report(.transportFailed("could not open an audio stream"))
                return nil
            }

            outgoingTokens = [manager.send(input, to: targets) { _ in }]
            let sink = OutgoingAudioStream(output: output, queue: queue, log: log)
            outgoing = sink
            log.info("outgoing stream \(streamId, privacy: .public) to \(targets.count)")
            return sink
        }
    }

    public func endAudioStream() {
        queue.async { [self] in endAudioStreamLocked() }
    }

    // MARK: - Internals

    private func endAudioStreamLocked() {
        outgoing?.close()
        outgoing = nil
        for token in outgoingTokens {
            token.cancel()
        }
        outgoingTokens.removeAll()
    }

    private func handshakenPeerIds() -> [EndpointID] {
        peers.filter { $0.value.isConnected && $0.value.didHandshake }.map(\.key)
    }

    private func publishPeerCountLocked() {
        let count = handshakenPeerIds().count
        delegate?.transport(self, peerCountDidChange: count)
    }

    private func report(_ error: RadioError) {
        log.error("\(error.message, privacy: .public)")
        delegate?.transport(self, didFail: error)
    }

    /// Discovery never stops, so a lost peer comes back on its own; this only
    /// paces the connection requests after a failure.
    private func scheduleRetryLocked(_ endpointID: EndpointID) {
        var peer = peers[endpointID] ?? Peer()
        let delay = peer.retryDelay
        peer.retryDelay = min(
            peer.retryDelay * RadioConfig.Reconnect.multiplier,
            RadioConfig.Reconnect.maxDelay
        )
        peers[endpointID] = peer

        queue.asyncAfter(deadline: .now() + delay) { [weak self] in
            guard let self, let peer = self.peers[endpointID] else { return }
            guard peer.isVisible, !peer.isConnected else { return }
            self.requestConnectionLocked(endpointID)
        }
    }

    private func requestConnectionLocked(_ endpointID: EndpointID) {
        let endpointInfo = Data(ProcessInfo.processInfo.hostName.utf8)
        discoverer?.requestConnection(
            to: endpointID,
            using: endpointInfo
        ) { [weak self] error in
            guard let self, error != nil else { return }
            self.queue.async { self.scheduleRetryLocked(endpointID) }
        }
    }
}
```

- [ ] **Step 5: Write the three delegate conformances**

Append to `ios/Radio/Sources/RadioKit/NearbyManager.swift`:

```swift
// MARK: - AdvertiserDelegate

extension NearbyManager: AdvertiserDelegate {

    public func advertiser(
        _ advertiser: Advertiser,
        didReceiveConnectionRequestFrom endpointID: EndpointID,
        with context: Data,
        connectionRequestHandler: @escaping (Bool) -> Void
    ) {
        // Spec section 7: connections are accepted automatically, no peer picker.
        connectionRequestHandler(true)
    }
}

// MARK: - DiscovererDelegate

extension NearbyManager: DiscovererDelegate {

    public func discoverer(
        _ discoverer: Discoverer,
        didFind endpointID: EndpointID,
        with context: Data
    ) {
        queue.async { [self] in
            var peer = peers[endpointID] ?? Peer()
            peer.isVisible = true
            peers[endpointID] = peer
            guard !peer.isConnected else { return }
            requestConnectionLocked(endpointID)
        }
    }

    public func discoverer(_ discoverer: Discoverer, didLose endpointID: EndpointID) {
        queue.async { [self] in
            guard var peer = peers[endpointID] else { return }
            peer.isVisible = false
            peers[endpointID] = peer
        }
    }
}

// MARK: - ConnectionManagerDelegate

extension NearbyManager: ConnectionManagerDelegate {

    public func connectionManager(
        _ connectionManager: ConnectionManager,
        didReceive verificationCode: String,
        from endpointID: EndpointID,
        verificationHandler: @escaping (Bool) -> Void
    ) {
        // No out-of-band verification: the air is open by design (spec section 7).
        verificationHandler(true)
    }

    public func connectionManager(
        _ connectionManager: ConnectionManager,
        didChangeTo state: ConnectionState,
        for endpointID: EndpointID
    ) {
        queue.async { [self] in
            var peer = peers[endpointID] ?? Peer()
            switch state {
            case .connected:
                peer.isConnected = true
                peer.didHandshake = false
                peer.retryDelay = RadioConfig.Reconnect.initialDelay
                peers[endpointID] = peer
                _ = connectionManager.send(
                    ControlMessage.hello(version: RadioConfig.protocolVersion).encoded(),
                    to: [endpointID]
                ) { _ in }
                log.info("connected \(endpointID, privacy: .public)")
            case .disconnected, .rejected:
                peer.isConnected = false
                peer.didHandshake = false
                peers[endpointID] = peer
                incoming[endpointID]?.cancel()
                incoming.removeValue(forKey: endpointID)
                delegate?.transport(self, didStopIncomingAudio: endpointID)
                publishPeerCountLocked()
                scheduleRetryLocked(endpointID)
                log.info("disconnected \(endpointID, privacy: .public)")
            default:
                peers[endpointID] = peer
            }
        }
    }

    public func connectionManager(
        _ connectionManager: ConnectionManager,
        didReceive data: Data,
        withID payloadID: PayloadID,
        from endpointID: EndpointID
    ) {
        queue.async { [self] in
            guard let message = ControlMessage.decode(data) else { return }
            switch message {
            case let .hello(version):
                guard version == RadioConfig.protocolVersion else {
                    log.error("hello version \(version) rejected")
                    connectionManager.disconnect(from: endpointID)
                    peers.removeValue(forKey: endpointID)
                    publishPeerCountLocked()
                    return
                }
                var peer = peers[endpointID] ?? Peer()
                peer.didHandshake = true
                peers[endpointID] = peer
                publishPeerCountLocked()
            case let .txStart(streamId):
                log.info("peer tx-start \(streamId, privacy: .public)")
            case .txStop:
                incoming[endpointID]?.cancel()
            }
        }
    }

    public func connectionManager(
        _ connectionManager: ConnectionManager,
        didReceive stream: InputStream,
        withID payloadID: PayloadID,
        from endpointID: EndpointID,
        cancellationToken token: CancellationToken
    ) {
        queue.async { [self] in
            guard peers[endpointID]?.didHandshake == true else {
                token.cancel()
                return
            }
            incoming[endpointID]?.cancel()

            let reader = IncomingAudioStream(
                peerId: endpointID,
                stream: stream,
                onFrame: { [weak self] frame, peerId in
                    guard let self else { return }
                    self.queue.async {
                        self.delegate?.transport(
                            self,
                            didReceiveAudioFrame: frame,
                            from: peerId
                        )
                    }
                },
                onEnd: { [weak self] peerId in
                    guard let self else { return }
                    self.queue.async {
                        self.incoming.removeValue(forKey: peerId)
                        self.delegate?.transport(self, didStopIncomingAudio: peerId)
                    }
                }
            )
            incoming[endpointID] = reader
            delegate?.transport(self, didStartIncomingAudio: endpointID)
            reader.start()
        }
    }

    public func connectionManager(
        _ connectionManager: ConnectionManager,
        didStartReceivingResourceWithID payloadID: PayloadID,
        from endpointID: EndpointID,
        at localURL: URL,
        withName name: String,
        cancellationToken token: CancellationToken
    ) {
        // The radio never sends FILE payloads.
        token.cancel()
    }

    public func connectionManager(
        _ connectionManager: ConnectionManager,
        didReceiveTransferUpdate update: TransferUpdate,
        from endpointID: EndpointID,
        forPayload payloadID: PayloadID
    ) {
        // Realtime audio needs no transfer progress.
    }
}
```

- [ ] **Step 6: Run the test and confirm it passes**

Run: `pnpm test ios-radio-sources`
Expected: PASS.

- [ ] **Step 7: Run the full task gate**

Run: `pnpm typecheck && pnpm lint && pnpm test ios-radio-sources`
Expected: all green.

- [ ] **Step 8: Commit**

```bash
rtk git add ios/Radio/Sources/RadioKit/NearbyManager.swift __tests__/ios-radio-sources.test.ts
rtk git commit -m "feat(ios): add the Nearby Connections transport"
```

---

### Task 5: The Opus codec wrapper and the jitter buffer

**Files:**
- Create: `ios/Radio/Sources/RadioKit/OpusCodec.swift`
- Create: `ios/Radio/Sources/RadioKit/JitterBuffer.swift`
- Create: `ios/Radio/Tests/RadioKitTests/JitterBufferTests.swift`
- Modify: `__tests__/ios-radio-sources.test.ts` (append one describe block)

**Interfaces:**
- Consumes: `RadioConfig.Audio.*`, `RadioError`.
- Produces: `OpusEncoding` (`encode(_ pcm: Data) throws -> Data`), `OpusDecoding` (`decode(_ packet: Data) throws -> Data`), `LibopusEncoder`, `LibopusDecoder`, `OpusFormat.pcm` (`AVAudioFormat`), `OpusFormat.buffer(from:)`, `OpusFormat.data(from:)`, and `JitterBuffer` (`push(_:)`, `pop() -> Data?`, `reset()`, `count`, `isPrimed`). Task 6 consumes all of them.

**PCM convention, used everywhere below:** `Data` holding **16-bit little-endian mono samples at 16 kHz**, exactly `RadioConfig.Audio.samplesPerFrame` (320) samples per frame — 640 bytes. Encoded frames are raw Opus packets with no framing; `AudioFraming` adds the length prefix at the transport boundary, not here.

- [ ] **Step 1: Write the failing test**

Append to `__tests__/ios-radio-sources.test.ts`:

```ts
describe('Opus codec and jitter buffer (spec section 8)', () => {
  const codec = source('OpusCodec.swift');
  const jitter = source('JitterBuffer.swift');

  it.each([
    'public protocol OpusEncoding',
    'public protocol OpusDecoding',
    'func encode(_ pcm: Data) throws -> Data',
    'func decode(_ packet: Data) throws -> Data',
    'final class LibopusEncoder',
    'final class LibopusDecoder',
    'enum OpusFormat',
  ])('OpusCodec.swift declares %s', declaration => {
    expect(codec).toContain(declaration);
  });

  it('configures the codec from RadioConfig only', () => {
    expect(codec).toContain('RadioConfig.Audio.sampleRate');
    expect(codec).toContain('RadioConfig.Audio.channelCount');
    expect(codec).toContain('RadioConfig.Audio.bitrate');
    expect(codec).toContain('RadioConfig.Audio.maxEncodedFrameBytes');
    expect(codec).not.toMatch(/16_?000/);
  });

  it('is the only file that imports Opus', () => {
    const importers = swiftFiles().filter(name =>
      /^import Opus$/m.test(source(name)),
    );
    expect(importers).toEqual(['OpusCodec.swift']);
  });

  it.each([
    'public final class JitterBuffer',
    'public func push(_ frame: Data)',
    'public func pop() -> Data?',
    'public func reset()',
    'public private(set) var isPrimed',
  ])('JitterBuffer.swift declares %s', declaration => {
    expect(jitter).toContain(declaration);
  });

  it('takes its depth from config', () => {
    expect(jitter).toContain('RadioConfig.Audio.jitterTargetFrames');
    expect(jitter).toContain('RadioConfig.Audio.jitterMaxFrames');
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `pnpm test ios-radio-sources`
Expected: FAIL on the new block.

- [ ] **Step 3: Write the codec wrapper**

Create `ios/Radio/Sources/RadioKit/OpusCodec.swift`:

```swift
import AVFoundation
import Foundation
import Opus

/// Embedded libopus, wrapped behind two one-method protocols (spec section 8:
/// platform codecs are not used). This file and `Package.swift` are the entire
/// surface the Opus dependency touches.
public protocol OpusEncoding: AnyObject {
    /// 16-bit little-endian mono PCM in, one Opus packet out.
    func encode(_ pcm: Data) throws -> Data
}

public protocol OpusDecoding: AnyObject {
    /// One Opus packet in, 16-bit little-endian mono PCM out.
    func decode(_ packet: Data) throws -> Data
}

/// The single PCM format the whole engine speaks.
public enum OpusFormat {
    public static let pcm = AVAudioFormat(
        commonFormat: .pcmFormatInt16,
        sampleRate: RadioConfig.Audio.sampleRate,
        channels: AVAudioChannelCount(RadioConfig.Audio.channelCount),
        interleaved: true
    )!

    public static func buffer(from pcmBytes: Data) -> AVAudioPCMBuffer? {
        let frames = AVAudioFrameCount(pcmBytes.count / 2)
        guard
            frames > 0,
            let buffer = AVAudioPCMBuffer(pcmFormat: pcm, frameCapacity: frames),
            let channel = buffer.int16ChannelData
        else {
            return nil
        }
        buffer.frameLength = frames
        pcmBytes.withUnsafeBytes { raw in
            guard let base = raw.bindMemory(to: Int16.self).baseAddress else { return }
            channel[0].update(from: base, count: Int(frames))
        }
        return buffer
    }

    public static func data(from buffer: AVAudioPCMBuffer) -> Data {
        guard let channel = buffer.int16ChannelData else { return Data() }
        return Data(
            bytes: channel[0],
            count: Int(buffer.frameLength) * MemoryLayout<Int16>.size
        )
    }
}

public final class LibopusEncoder: OpusEncoding {
    private let encoder: Opus.Encoder

    public init() throws {
        encoder = try Opus.Encoder(format: OpusFormat.pcm, application: .voip)
        encoder.bitrate = .bitrate(RadioConfig.Audio.bitrate)
    }

    public func encode(_ pcm: Data) throws -> Data {
        guard let buffer = OpusFormat.buffer(from: pcm) else {
            throw RadioError.audioFailed("bad pcm frame of \(pcm.count) bytes")
        }
        var packet = Data(count: RadioConfig.Audio.maxEncodedFrameBytes)
        let written = try encoder.encode(buffer, to: &packet)
        return Data(packet.prefix(written))
    }
}

public final class LibopusDecoder: OpusDecoding {
    private let decoder: Opus.Decoder

    public init() throws {
        decoder = try Opus.Decoder(format: OpusFormat.pcm)
    }

    public func decode(_ packet: Data) throws -> Data {
        guard
            let buffer = AVAudioPCMBuffer(
                pcmFormat: OpusFormat.pcm,
                frameCapacity: AVAudioFrameCount(RadioConfig.Audio.samplesPerFrame)
            )
        else {
            throw RadioError.audioFailed("could not allocate a decode buffer")
        }
        try decoder.decode(packet, to: buffer)
        return OpusFormat.data(from: buffer)
    }
}
```

**Closeout note for this file:** `Opus.Encoder(format:application:)`, `encoder.bitrate`, `encode(_:to:)`, `Opus.Decoder(format:)` and `decode(_:to:)` are the resolved package's API, and this host cannot check them. If the closeout build rejects any of these five lines, fix them here — the rest of the engine only ever sees `OpusEncoding` / `OpusDecoding`.

- [ ] **Step 4: Write the jitter buffer**

Create `ios/Radio/Sources/RadioKit/JitterBuffer.swift`:

```swift
import Foundation

/// A 2-3 frame cushion per incoming transmission (spec section 8). The Nearby
/// STREAM is ordered and reliable, so this absorbs bursty delivery only — it
/// never reorders.
///
/// Not thread-safe by design: it is owned by the audio queue.
public final class JitterBuffer {
    private var frames: [Data] = []
    private let targetFrames: Int
    private let maxFrames: Int

    public private(set) var isPrimed = false
    public private(set) var droppedFrames = 0

    public init(
        targetFrames: Int = RadioConfig.Audio.jitterTargetFrames,
        maxFrames: Int = RadioConfig.Audio.jitterMaxFrames
    ) {
        self.targetFrames = targetFrames
        self.maxFrames = maxFrames
    }

    public var count: Int { frames.count }

    public func push(_ frame: Data) {
        frames.append(frame)
        while frames.count > maxFrames {
            frames.removeFirst()
            droppedFrames += 1
        }
        if frames.count >= targetFrames {
            isPrimed = true
        }
    }

    /// Returns nil until the cushion has filled; an underrun re-primes.
    public func pop() -> Data? {
        guard isPrimed else { return nil }
        guard !frames.isEmpty else {
            isPrimed = false
            return nil
        }
        return frames.removeFirst()
    }

    public func reset() {
        frames.removeAll(keepingCapacity: true)
        isPrimed = false
        droppedFrames = 0
    }
}
```

- [ ] **Step 5: Write the jitter buffer tests**

Create `ios/Radio/Tests/RadioKitTests/JitterBufferTests.swift`:

```swift
import XCTest
@testable import RadioKit

final class JitterBufferTests: XCTestCase {

    private func frame(_ byte: UInt8) -> Data {
        Data([byte])
    }

    func testStaysSilentUntilPrimed() {
        let buffer = JitterBuffer(targetFrames: 3, maxFrames: 10)

        buffer.push(frame(1))
        XCTAssertNil(buffer.pop())
        buffer.push(frame(2))
        XCTAssertNil(buffer.pop())
        buffer.push(frame(3))

        XCTAssertTrue(buffer.isPrimed)
        XCTAssertEqual(buffer.pop(), frame(1))
    }

    func testDeliversInOrder() {
        let buffer = JitterBuffer(targetFrames: 2, maxFrames: 10)
        buffer.push(frame(1))
        buffer.push(frame(2))
        buffer.push(frame(3))

        XCTAssertEqual(buffer.pop(), frame(1))
        XCTAssertEqual(buffer.pop(), frame(2))
        XCTAssertEqual(buffer.pop(), frame(3))
    }

    func testDropsOldestBeyondTheBacklogLimit() {
        let buffer = JitterBuffer(targetFrames: 2, maxFrames: 3)
        for byte in UInt8(1)...UInt8(5) {
            buffer.push(frame(byte))
        }

        XCTAssertEqual(buffer.count, 3)
        XCTAssertEqual(buffer.droppedFrames, 2)
        XCTAssertEqual(buffer.pop(), frame(3))
    }

    func testUnderrunRePrimes() {
        let buffer = JitterBuffer(targetFrames: 2, maxFrames: 10)
        buffer.push(frame(1))
        buffer.push(frame(2))
        _ = buffer.pop()
        _ = buffer.pop()

        XCTAssertNil(buffer.pop())
        XCTAssertFalse(buffer.isPrimed)

        buffer.push(frame(3))
        XCTAssertNil(buffer.pop())
        buffer.push(frame(4))
        XCTAssertEqual(buffer.pop(), frame(3))
    }

    func testResetClearsEverything() {
        let buffer = JitterBuffer(targetFrames: 1, maxFrames: 2)
        buffer.push(frame(1))
        buffer.reset()

        XCTAssertEqual(buffer.count, 0)
        XCTAssertFalse(buffer.isPrimed)
        XCTAssertNil(buffer.pop())
    }

    func testDefaultsComeFromConfig() {
        let buffer = JitterBuffer()
        for byte in 0..<UInt8(RadioConfig.Audio.jitterTargetFrames) {
            XCTAssertNil(buffer.pop())
            buffer.push(frame(byte))
        }
        XCTAssertTrue(buffer.isPrimed)
    }
}
```

- [ ] **Step 6: Run the test and confirm it passes**

Run: `pnpm test ios-radio-sources`
Expected: PASS.

- [ ] **Step 7: Run the full task gate**

Run: `pnpm typecheck && pnpm lint && pnpm test ios-radio-sources`
Expected: all green.

- [ ] **Step 8: Commit**

```bash
rtk git add ios/Radio __tests__/ios-radio-sources.test.ts
rtk git commit -m "feat(ios): add the opus codec wrapper and the jitter buffer"
```

---

### Task 6: AudioEngine — capture, playback and mixing

**Files:**
- Create: `ios/Radio/Sources/RadioKit/AudioEngine.swift`
- Modify: `__tests__/ios-radio-sources.test.ts` (append one describe block)

**Interfaces:**
- Consumes: `AudioIO`, `AudioIODelegate`, `OpusEncoding`, `OpusDecoding`, `LibopusEncoder`, `LibopusDecoder`, `OpusFormat`, `JitterBuffer`, `RadioConfig.Audio.*`, `RadioError`.
- Produces: `AudioEngine` — `init(queue: DispatchQueue, makeEncoder:makeDecoder:)` with defaults `{ try LibopusEncoder() }` / `{ try LibopusDecoder() }`, conforming to `AudioIO`.

**Two rules this file must not break.** (1) It configures the `AVAudioSession` **category** and never calls `setActive(true)` — activation belongs to PushToTalk (spec §8, §10.2); calling it here is exactly what breaks locked-screen audio. (2) Concurrent transmitters are mixed, not arbitrated (spec §7): one `AVAudioPlayerNode` per peer, all connected to the main mixer, which is what makes two simultaneous speakers audible at once for free.

- [ ] **Step 1: Write the failing test**

Append to `__tests__/ios-radio-sources.test.ts`:

```ts
describe('AudioEngine (spec section 8)', () => {
  const audio = source('AudioEngine.swift');

  it.each([
    'public final class AudioEngine: AudioIO',
    'public func startPlayback() throws',
    'public func startCapture() throws',
    'public func beginIncoming(peerId: String)',
    'public func enqueue(frame: Data, from peerId: String)',
    'public func endIncoming(peerId: String)',
  ])('declares %s', declaration => {
    expect(audio).toContain(declaration);
  });

  it('captures through a tap and resamples to the codec format', () => {
    expect(audio).toContain('installTap(');
    expect(audio).toContain('AVAudioConverter(');
    expect(audio).toContain('OpusFormat.pcm');
  });

  it('mixes one player node per peer into the main mixer', () => {
    expect(audio).toContain('AVAudioPlayerNode()');
    expect(audio).toContain('mainMixerNode');
  });

  it('uses the shared codec and jitter buffer', () => {
    expect(audio).toContain('LibopusEncoder()');
    expect(audio).toContain('LibopusDecoder()');
    expect(audio).toContain('JitterBuffer()');
  });

  it('configures a voice-chat session for play and record', () => {
    expect(audio).toContain('.playAndRecord');
    expect(audio).toContain('.voiceChat');
  });

  it('leaves audio-session activation to PushToTalk', () => {
    expect(audio).not.toContain('setActive(true');
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `pnpm test ios-radio-sources`
Expected: FAIL on the new block.

- [ ] **Step 3: Write the playback half**

Create `ios/Radio/Sources/RadioKit/AudioEngine.swift`:

```swift
import AVFoundation
import Foundation
import os

/// One incoming transmission being played back.
private final class PeerPlayback {
    let player = AVAudioPlayerNode()
    let jitter = JitterBuffer()
    let decoder: OpusDecoding

    init(decoder: OpusDecoding) {
        self.decoder = decoder
    }
}

/// Microphone in, speaker out (spec section 8). Everything happens on `queue`
/// except the capture tap, which hops onto it.
public final class AudioEngine: AudioIO {

    public weak var delegate: AudioIODelegate?

    private let queue: DispatchQueue
    private let makeEncoder: () throws -> OpusEncoding
    private let makeDecoder: () throws -> OpusDecoding
    private let engine = AVAudioEngine()
    private let log = Logger(
        subsystem: RadioConfig.Logging.subsystem,
        category: "audio"
    )

    private var playbacks: [String: PeerPlayback] = [:]
    private var encoder: OpusEncoding?
    private var converter: AVAudioConverter?
    private var captureResidue = Data()
    private var isCapturing = false

    private var frameByteCount: Int {
        RadioConfig.Audio.samplesPerFrame * MemoryLayout<Int16>.size
    }

    public init(
        queue: DispatchQueue,
        makeEncoder: @escaping () throws -> OpusEncoding = { try LibopusEncoder() },
        makeDecoder: @escaping () throws -> OpusDecoding = { try LibopusDecoder() }
    ) {
        self.queue = queue
        self.makeEncoder = makeEncoder
        self.makeDecoder = makeDecoder
    }

    // MARK: - Session

    public func startPlayback() throws {
        // Category only. PushToTalk activates the session, here and in the
        // background; activating it from the app is what kills locked playback.
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(
            .playAndRecord,
            mode: .voiceChat,
            options: [.allowBluetooth, .allowBluetoothA2DP, .defaultToSpeaker]
        )
        engine.prepare()
        log.info("audio session configured")
    }

    public func stopPlayback() {
        queue.sync {
            for (peerId, _) in playbacks {
                tearDownPlaybackLocked(peerId: peerId)
            }
            playbacks.removeAll()
            if engine.isRunning {
                engine.stop()
            }
        }
    }

    /// The AVAudioEngine can only run while the session is active, and the
    /// system activates it around the moment audio actually starts — so it is
    /// started lazily rather than at `startRadio`.
    private func ensureEngineRunningLocked() throws {
        guard !engine.isRunning else { return }
        try engine.start()
    }

    // MARK: - Playback

    public func beginIncoming(peerId: String) {
        queue.async { [self] in
            guard playbacks[peerId] == nil else { return }
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
                log.info("playback opened for \(peerId, privacy: .public)")
            } catch {
                delegate?.audioIO(self, didFail: .audioFailed("playback: \(error)"))
            }
        }
    }

    public func enqueue(frame: Data, from peerId: String) {
        queue.async { [self] in
            guard let playback = playbacks[peerId] else { return }
            playback.jitter.push(frame)
            drainLocked(playback)
        }
    }

    public func endIncoming(peerId: String) {
        queue.async { [self] in
            tearDownPlaybackLocked(peerId: peerId)
            playbacks.removeValue(forKey: peerId)
        }
    }

    private func drainLocked(_ playback: PeerPlayback) {
        var scheduled = 0
        while let packet = playback.jitter.pop() {
            do {
                let pcm = try playback.decoder.decode(packet)
                guard let buffer = OpusFormat.buffer(from: pcm) else { continue }
                playback.player.scheduleBuffer(buffer, completionHandler: nil)
                scheduled += 1
            } catch {
                delegate?.audioIO(self, didFail: .audioFailed("decode: \(error)"))
                return
            }
        }
        if scheduled > 0, !playback.player.isPlaying {
            playback.player.play()
        }
    }

    private func tearDownPlaybackLocked(peerId: String) {
        guard let playback = playbacks[peerId] else { return }
        playback.player.stop()
        engine.detach(playback.player)
        playback.jitter.reset()
        log.info("playback closed for \(peerId, privacy: .public)")
    }
}
```

- [ ] **Step 4: Write the capture half**

Append to `ios/Radio/Sources/RadioKit/AudioEngine.swift`:

```swift
// MARK: - Capture

extension AudioEngine {

    public func startCapture() throws {
        try queue.sync {
            guard !isCapturing else { return }

            let input = engine.inputNode
            let inputFormat = input.outputFormat(forBus: 0)
            guard
                inputFormat.sampleRate > 0,
                let converter = AVAudioConverter(from: inputFormat, to: OpusFormat.pcm)
            else {
                throw RadioError.audioFailed("no usable microphone format")
            }

            self.converter = converter
            encoder = try makeEncoder()
            captureResidue.removeAll(keepingCapacity: true)

            input.installTap(onBus: 0, bufferSize: 1_024, format: inputFormat) {
                [weak self] buffer, _ in
                guard let self else { return }
                self.queue.async { self.handleCaptureLocked(buffer) }
            }

            try ensureEngineRunningLocked()
            isCapturing = true
            log.info("capture started at \(inputFormat.sampleRate, privacy: .public) Hz")
        }
    }

    public func stopCapture() {
        queue.sync {
            guard isCapturing else { return }
            engine.inputNode.removeTap(onBus: 0)
            isCapturing = false
            encoder = nil
            converter = nil
            captureResidue.removeAll(keepingCapacity: true)
            log.info("capture stopped")
        }
    }

    private func handleCaptureLocked(_ buffer: AVAudioPCMBuffer) {
        guard isCapturing, let converter, let encoder else { return }

        let ratio = OpusFormat.pcm.sampleRate / buffer.format.sampleRate
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 1_024
        guard
            let converted = AVAudioPCMBuffer(
                pcmFormat: OpusFormat.pcm,
                frameCapacity: capacity
            )
        else {
            return
        }

        var consumed = false
        var conversionError: NSError?
        converter.convert(to: converted, error: &conversionError) { _, status in
            if consumed {
                status.pointee = .noDataNow
                return nil
            }
            consumed = true
            status.pointee = .haveData
            return buffer
        }
        if let conversionError {
            delegate?.audioIO(self, didFail: .audioFailed("resample: \(conversionError)"))
            return
        }

        captureResidue.append(OpusFormat.data(from: converted))
        while captureResidue.count >= frameByteCount {
            let frame = Data(captureResidue.prefix(frameByteCount))
            captureResidue.removeFirst(frameByteCount)
            do {
                let packet = try encoder.encode(frame)
                guard !packet.isEmpty else { continue }
                delegate?.audioIO(self, didEncodeFrame: packet)
            } catch {
                delegate?.audioIO(self, didFail: .audioFailed("encode: \(error)"))
                return
            }
        }
    }
}
```

- [ ] **Step 5: Run the test and confirm it passes**

Run: `pnpm test ios-radio-sources`
Expected: PASS.

- [ ] **Step 6: Run the full task gate**

Run: `pnpm typecheck && pnpm lint && pnpm test ios-radio-sources`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
rtk git add ios/Radio/Sources/RadioKit/AudioEngine.swift __tests__/ios-radio-sources.test.ts
rtk git commit -m "feat(ios): add AVAudioEngine capture, playback and mixing"
```

---

### Task 7: BackgroundManager — PushToTalk

**Files:**
- Create: `ios/Radio/Sources/RadioKit/BackgroundManager.swift`
- Modify: `__tests__/ios-radio-sources.test.ts` (append one describe block)

**Interfaces:**
- Consumes: `BackgroundSession`, `BackgroundSessionDelegate`, `RadioError`, `RadioConfig.Background.channelUUID`.
- Produces: `BackgroundManager` — `init()`, conforming to `BackgroundSession`. Localization keys `ptt.channel.name` and `ptt.participant.nearby` are read here and created in Task 9.

**This file is the reason a locked iPhone can be a radio (spec §10.2).** Three system interactions matter and each maps to one method: joining the channel puts a talk affordance in the system UI even when the app is suspended; `requestBeginTransmitting()` makes the system activate the audio session so the microphone may open; `setActiveRemoteParticipant(_:)` is the incoming half — it tells the system a remote party is speaking, which is what activates the session for *playback*. Risk R1 in the spec is precisely whether that last one holds up while suspended, and Phase 0 scenario A is its test.

- [ ] **Step 1: Write the failing test**

Append to `__tests__/ios-radio-sources.test.ts`:

```ts
describe('BackgroundManager (spec section 10.2)', () => {
  const background = source('BackgroundManager.swift');

  it.each([
    'public final class BackgroundManager',
    'BackgroundSession',
    'extension BackgroundManager: PTChannelManagerDelegate',
    'extension BackgroundManager: PTChannelRestorationDelegate',
  ])('declares %s', declaration => {
    expect(background).toContain(declaration);
  });

  it('joins a stable channel from config', () => {
    expect(background).toContain('RadioConfig.Background.channelUUID');
    expect(background).toContain('requestJoinChannel(');
    expect(background).toContain('leaveChannel(');
  });

  it('drives transmission through the framework', () => {
    expect(background).toContain('requestBeginTransmitting(');
    expect(background).toContain('stopTransmitting(');
  });

  it('announces incoming speech as an active remote participant', () => {
    expect(background).toContain('setActiveRemoteParticipant(');
  });

  it('reports audio-session activation to the engine', () => {
    expect(background).toContain('didActivate audioSession');
    expect(background).toContain('backgroundSessionDidActivateAudio(self)');
  });

  it('takes its system-visible names from the localized bundle', () => {
    expect(background).toContain('ptt.channel.name');
    expect(background).toContain('ptt.participant.nearby');
    expect(background).toContain('bundle: .module');
  });

  it('is the only file that imports PushToTalk', () => {
    const importers = swiftFiles().filter(name =>
      source(name).includes('import PushToTalk'),
    );
    expect(importers).toEqual(['BackgroundManager.swift']);
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `pnpm test ios-radio-sources`
Expected: FAIL on the new block.

- [ ] **Step 3: Write the manager**

Create `ios/Radio/Sources/RadioKit/BackgroundManager.swift`:

```swift
import AVFoundation
import Foundation
import PushToTalk
import os

/// The system PushToTalk channel (spec section 10.2). PushToTalk is not the
/// transport — the app still encodes and streams audio itself over Nearby. What
/// the framework provides is the right to run the microphone and the speaker
/// while the app is suspended and the screen is locked.
public final class BackgroundManager: NSObject, BackgroundSession {

    public weak var delegate: BackgroundSessionDelegate?

    private var manager: PTChannelManager?
    private let channelUUID = RadioConfig.Background.channelUUID
    private let log = Logger(
        subsystem: RadioConfig.Logging.subsystem,
        category: "background"
    )

    public override init() {
        super.init()
    }

    private var channelName: String {
        NSLocalizedString(
            "ptt.channel.name",
            bundle: .module,
            comment: "Name of the push-to-talk channel in system UI"
        )
    }

    private var participantName: String {
        NSLocalizedString(
            "ptt.participant.nearby",
            bundle: .module,
            comment: "Name shown while a nearby device is speaking"
        )
    }

    private var descriptor: PTChannelDescriptor {
        PTChannelDescriptor(name: channelName, image: nil)
    }

    // MARK: - BackgroundSession

    public func activate() {
        Task { [weak self] in
            guard let self else { return }
            do {
                let manager = try await PTChannelManager.channelManager(
                    delegate: self,
                    restorationDelegate: self
                )
                self.manager = manager
                manager.requestJoinChannel(
                    channelUUID: self.channelUUID,
                    descriptor: self.descriptor
                )
            } catch {
                self.delegate?.backgroundSession(
                    self,
                    didFail: .backgroundFailed("channel manager: \(error)")
                )
            }
        }
    }

    public func deactivate() {
        manager?.leaveChannel(channelUUID: channelUUID)
    }

    public func requestBeginTransmitting() {
        guard let manager else {
            delegate?.backgroundSession(
                self,
                didFail: .backgroundFailed("no push-to-talk channel yet")
            )
            return
        }
        manager.requestBeginTransmitting(channelUUID: channelUUID)
    }

    public func stopTransmitting() {
        manager?.stopTransmitting(channelUUID: channelUUID)
    }

    public func setReceiving(_ receiving: Bool) {
        let participant = receiving
            ? PTParticipant(name: participantName, image: nil)
            : nil
        manager?.setActiveRemoteParticipant(
            participant,
            channelUUID: channelUUID,
            completionHandler: nil
        )
    }
}

// MARK: - PTChannelManagerDelegate

extension BackgroundManager: PTChannelManagerDelegate {

    public func channelManager(
        _ channelManager: PTChannelManager,
        didJoinChannel channelUUID: UUID,
        reason: PTChannelJoinReason
    ) {
        log.info("joined the push-to-talk channel")
    }

    public func channelManager(
        _ channelManager: PTChannelManager,
        didLeaveChannel channelUUID: UUID,
        reason: PTChannelLeaveReason
    ) {
        log.info("left the push-to-talk channel")
    }

    public func channelManager(
        _ channelManager: PTChannelManager,
        channelUUID: UUID,
        didBeginTransmittingFrom source: PTChannelTransmitRequestSource
    ) {
        // Covers both our own request and the system talk button on the lock screen.
        delegate?.backgroundSessionDidRequestTransmitStart(self)
    }

    public func channelManager(
        _ channelManager: PTChannelManager,
        channelUUID: UUID,
        didEndTransmittingFrom source: PTChannelTransmitRequestSource
    ) {
        delegate?.backgroundSessionDidRequestTransmitStop(self)
    }

    public func channelManager(
        _ channelManager: PTChannelManager,
        didActivate audioSession: AVAudioSession
    ) {
        log.info("system activated the audio session")
        delegate?.backgroundSessionDidActivateAudio(self)
    }

    public func channelManager(
        _ channelManager: PTChannelManager,
        didDeactivate audioSession: AVAudioSession
    ) {
        log.info("system deactivated the audio session")
        delegate?.backgroundSessionDidDeactivateAudio(self)
    }

    public func channelManager(
        _ channelManager: PTChannelManager,
        failedToJoinChannel channelUUID: UUID,
        error: Error
    ) {
        delegate?.backgroundSession(self, didFail: .backgroundFailed("join: \(error)"))
    }

    public func channelManager(
        _ channelManager: PTChannelManager,
        failedToBeginTransmittingInChannel channelUUID: UUID,
        error: Error
    ) {
        delegate?.backgroundSession(
            self,
            didFail: .backgroundFailed("begin transmitting: \(error)")
        )
    }

    public func channelManager(
        _ channelManager: PTChannelManager,
        receivedEphemeralPushToken pushToken: Data
    ) {
        // The MVP has no server, so no push token is ever registered anywhere.
    }

    public func incomingPushResult(
        channelManager: PTChannelManager,
        channelUUID: UUID,
        pushPayload: [String: Any]
    ) -> PTPushResult {
        // Unreachable without a server; leaving is the only harmless answer.
        .leaveChannel
    }
}

// MARK: - PTChannelRestorationDelegate

extension BackgroundManager: PTChannelRestorationDelegate {

    public func channelDescriptor(restoredChannelUUID channelUUID: UUID) -> PTChannelDescriptor {
        descriptor
    }
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `pnpm test ios-radio-sources`
Expected: PASS.

- [ ] **Step 5: Run the full task gate**

Run: `pnpm typecheck && pnpm lint && pnpm test ios-radio-sources`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
rtk git add ios/Radio/Sources/RadioKit/BackgroundManager.swift __tests__/ios-radio-sources.test.ts
rtk git commit -m "feat(ios): add the PushToTalk background session"
```

---

### Task 8: The PTT subsystem — binding, BLE driver, manager

**Files:**
- Create: `ios/Radio/Sources/RadioKit/PttBinding.swift`
- Create: `ios/Radio/Sources/RadioKit/BleGattPttDriver.swift`
- Create: `ios/Radio/Sources/RadioKit/PttManager.swift`
- Create: `ios/Radio/Tests/RadioKitTests/PttBindingTests.swift`
- Modify: `__tests__/ios-radio-sources.test.ts` (append one describe block)

**Interfaces:**
- Consumes: `PttSource`, `PttSourceDelegate`, `PttButtonState`, `PttPairingState`, `PttCandidate`, `RadioError`, `RadioConfig.Ptt.*` (including `autoSelectFallback`). `PttCandidate` and `PttPairingState` are Task 2's domain types — do not redeclare them here.
- Produces: `PttBinding` (`.ble(deviceId:serviceUuid:characteristicUuid:pressedValue:releasedValue:)`, `.hid(keyCode:)`), `PttConfiguration(name:binding:)` with `asDictionary`, `PttHex`, `PttBindingStore` (`load()`, `save(_:)`, `clear()`), `BleGattPttDriver`, and `PttManager` — `init(queue:defaults:)` conforming to `PttSource`, including `selectCandidate(deviceId:)`. `PttBinding` and `PttConfiguration` were forward-referenced by `RadioPorts.swift` in Task 2; this is where they come into existence.

**Only the BLE driver exists on iOS.** Spec §9.1 marks `HidPttDriver` and `MediaButtonPttDriver` as realistically Android-only — building them here would be building something that cannot drive background PTT on this platform. `PttBinding.hid` is still decoded (an Android-written binding must not crash the parser) and reported as unsupported.

**The pairing session, per the §6.1 amendment in Global Constraints.** `beginLearning` opens a session and publishes it as state: `phase: .scanning` with the candidate list republished as devices are found, then `.learning` once a device is chosen, then `.saved`. The pick is the user's, delivered by `selectCandidate(deviceId:)` — the engine's `selectPttCandidate`, P6's tap on the `03 Pairing` list. The strongest-signal auto-pick is a **safety net**, not the product path: it fires only after `RadioConfig.Ptt.autoSelectFallback` seconds with no selection, which is what lets Phase 0 pair a button from the debugger console with no UI in the build.

- [ ] **Step 1: Write the failing test**

Append to `__tests__/ios-radio-sources.test.ts`:

```ts
describe('PTT subsystem (spec section 9)', () => {
  const binding = source('PttBinding.swift');
  const driver = source('BleGattPttDriver.swift');
  const manager = source('PttManager.swift');

  it.each([
    'public enum PttBinding',
    'case ble(',
    'case hid(keyCode: Int)',
    'public struct PttConfiguration',
    'public final class PttBindingStore',
    'public func load() -> PttConfiguration?',
    'public func save(_ configuration: PttConfiguration)',
    'public func clear()',
  ])('PttBinding.swift declares %s', declaration => {
    expect(binding).toContain(declaration);
  });

  it.each([
    'deviceId',
    'serviceUuid',
    'characteristicUuid',
    'pressedValue',
    'releasedValue',
  ])('keeps the spec 9.2 field name %s', field => {
    expect(binding).toContain(field);
  });

  it('persists to UserDefaults under the configured key', () => {
    expect(binding).toContain('RadioConfig.Ptt.bindingDefaultsKey');
    expect(binding).toContain('UserDefaults');
  });

  it.each([
    'public final class BleGattPttDriver',
    'extension BleGattPttDriver: CBCentralManagerDelegate',
    'extension BleGattPttDriver: CBPeripheralDelegate',
    'func selectCandidate(deviceId: String)',
  ])('BleGattPttDriver.swift declares %s', declaration => {
    expect(driver).toContain(declaration);
  });

  it('treats the strongest-signal pick as a timed fallback, not the path', () => {
    expect(driver).toContain('RadioConfig.Ptt.autoSelectFallback');
  });

  it('survives background relaunch with a restore identifier', () => {
    expect(driver).toContain('CBCentralManagerOptionRestoreIdentifierKey');
    expect(driver).toContain('willRestoreState');
  });

  it('learns by subscribing to notifying characteristics', () => {
    expect(driver).toContain('setNotifyValue(true');
    expect(driver).toContain('RadioConfig.Ptt.learningTimeout');
  });

  it.each([
    'public final class PttManager: PttSource',
    'public func beginLearning(',
    'public func selectCandidate(deviceId: String)',
    'public func forget()',
    'pttSourceDidPress(self)',
    'pttSourceDidRelease(self)',
  ])('PttManager.swift declares %s', declaration => {
    expect(manager).toContain(declaration);
  });

  it.each(['.scanning', '.learning', '.saved'])(
    'publishes the pairing phase %s',
    phase => {
      expect(manager).toContain(`phase: ${phase}`);
    },
  );

  it('publishes pairing progress as state, not as an event', () => {
    expect(manager).toContain('pairingStateDidChange: state');
    expect(manager).toContain('PttPairingState');
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `pnpm test ios-radio-sources`
Expected: FAIL on the new block.

- [ ] **Step 3: Write the binding and its store**

Create `ios/Radio/Sources/RadioKit/PttBinding.swift`:

```swift
import Foundation

/// Spec section 9.2, field for field. The `hid` case exists so a binding written
/// by the Android engine parses here; iOS cannot drive background PTT from HID.
public enum PttBinding: Equatable {
    case ble(
        deviceId: String,
        serviceUuid: String,
        characteristicUuid: String,
        pressedValue: String,
        releasedValue: String
    )
    case hid(keyCode: Int)

    public var asDictionary: [String: Any] {
        switch self {
        case let .ble(deviceId, serviceUuid, characteristicUuid, pressed, released):
            return [
                "type": "ble",
                "deviceId": deviceId,
                "serviceUuid": serviceUuid,
                "characteristicUuid": characteristicUuid,
                "pressedValue": pressed,
                "releasedValue": released
            ]
        case let .hid(keyCode):
            return ["type": "hid", "keyCode": keyCode]
        }
    }

    public static func from(dictionary: [String: Any]) -> PttBinding? {
        switch dictionary["type"] as? String {
        case "ble":
            guard
                let deviceId = dictionary["deviceId"] as? String,
                let serviceUuid = dictionary["serviceUuid"] as? String,
                let characteristicUuid = dictionary["characteristicUuid"] as? String,
                let pressed = dictionary["pressedValue"] as? String,
                let released = dictionary["releasedValue"] as? String
            else {
                return nil
            }
            return .ble(
                deviceId: deviceId,
                serviceUuid: serviceUuid,
                characteristicUuid: characteristicUuid,
                pressedValue: pressed,
                releasedValue: released
            )
        case "hid":
            guard let keyCode = dictionary["keyCode"] as? Int else { return nil }
            return .hid(keyCode: keyCode)
        default:
            return nil
        }
    }
}

/// What the learning flow produces (spec section 6.1 `PttConfiguration`).
public struct PttConfiguration: Equatable {
    public let name: String
    public let binding: PttBinding

    public init(name: String, binding: PttBinding) {
        self.name = name
        self.binding = binding
    }

    public var asDictionary: [String: Any] {
        ["name": name, "binding": binding.asDictionary]
    }

    public static func from(dictionary: [String: Any]) -> PttConfiguration? {
        guard
            let name = dictionary["name"] as? String,
            let bindingDictionary = dictionary["binding"] as? [String: Any],
            let binding = PttBinding.from(dictionary: bindingDictionary)
        else {
            return nil
        }
        return PttConfiguration(name: name, binding: binding)
    }
}

/// Characteristic values travel as lowercase hex with no separators.
public enum PttHex {
    public static func string(from data: Data) -> String {
        data.map { String(format: "%02x", $0) }.joined()
    }

    public static func data(from string: String) -> Data? {
        let characters = Array(string.lowercased())
        guard characters.count % 2 == 0 else { return nil }
        var bytes = Data(capacity: characters.count / 2)
        for index in stride(from: 0, to: characters.count, by: 2) {
            guard let byte = UInt8(String(characters[index...index + 1]), radix: 16) else {
                return nil
            }
            bytes.append(byte)
        }
        return bytes
    }
}

/// The binding outlives radio restarts and app launches (spec section 9.2).
public final class PttBindingStore {
    private let defaults: UserDefaults

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    public func load() -> PttConfiguration? {
        guard
            let data = defaults.data(forKey: RadioConfig.Ptt.bindingDefaultsKey),
            let object = try? JSONSerialization.jsonObject(with: data),
            let dictionary = object as? [String: Any]
        else {
            return nil
        }
        return PttConfiguration.from(dictionary: dictionary)
    }

    public func save(_ configuration: PttConfiguration) {
        guard
            let data = try? JSONSerialization.data(
                withJSONObject: configuration.asDictionary
            )
        else {
            return
        }
        defaults.set(data, forKey: RadioConfig.Ptt.bindingDefaultsKey)
    }

    public func clear() {
        defaults.removeObject(forKey: RadioConfig.Ptt.bindingDefaultsKey)
    }
}
```

- [ ] **Step 4: Write the binding tests**

Create `ios/Radio/Tests/RadioKitTests/PttBindingTests.swift`:

```swift
import XCTest
@testable import RadioKit

final class PttBindingTests: XCTestCase {

    private let bleBinding = PttBinding.ble(
        deviceId: "1D6F4B0A-0000-4000-8000-000000000001",
        serviceUuid: "1812",
        characteristicUuid: "2A4D",
        pressedValue: "01",
        releasedValue: "00"
    )

    private func makeDefaults() throws -> UserDefaults {
        let name = "radio.tests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: name))
        defaults.removePersistentDomain(forName: name)
        return defaults
    }

    func testBleBindingKeepsTheSpecFieldNames() {
        let dictionary = bleBinding.asDictionary
        XCTAssertEqual(dictionary["type"] as? String, "ble")
        XCTAssertEqual(dictionary["serviceUuid"] as? String, "1812")
        XCTAssertEqual(dictionary["characteristicUuid"] as? String, "2A4D")
        XCTAssertEqual(dictionary["pressedValue"] as? String, "01")
        XCTAssertEqual(dictionary["releasedValue"] as? String, "00")
    }

    func testBindingRoundTripsThroughItsDictionary() {
        XCTAssertEqual(PttBinding.from(dictionary: bleBinding.asDictionary), bleBinding)

        let hid = PttBinding.hid(keyCode: 85)
        XCTAssertEqual(PttBinding.from(dictionary: hid.asDictionary), hid)
    }

    func testMalformedBindingsAreRejected() {
        XCTAssertNil(PttBinding.from(dictionary: [:]))
        XCTAssertNil(PttBinding.from(dictionary: ["type": "ble"]))
        XCTAssertNil(PttBinding.from(dictionary: ["type": "carrier-pigeon"]))
        XCTAssertNil(PttBinding.from(dictionary: ["type": "hid", "keyCode": "85"]))
    }

    func testStoreSurvivesARestart() throws {
        let defaults = try makeDefaults()
        let configuration = PttConfiguration(name: "PTT-1", binding: bleBinding)

        PttBindingStore(defaults: defaults).save(configuration)
        let reloaded = PttBindingStore(defaults: defaults).load()

        XCTAssertEqual(reloaded, configuration)
    }

    func testClearForgetsTheButton() throws {
        let defaults = try makeDefaults()
        let store = PttBindingStore(defaults: defaults)
        store.save(PttConfiguration(name: "PTT-1", binding: bleBinding))
        store.clear()

        XCTAssertNil(store.load())
    }

    func testHexHelpersRoundTrip() {
        XCTAssertEqual(PttHex.string(from: Data([0x00, 0x0F, 0xA1])), "000fa1")
        XCTAssertEqual(PttHex.data(from: "000FA1"), Data([0x00, 0x0F, 0xA1]))
        XCTAssertNil(PttHex.data(from: "abc"))
        XCTAssertNil(PttHex.data(from: "zz"))
    }
}
```

- [ ] **Step 5: Write the BLE driver**

Create `ios/Radio/Sources/RadioKit/BleGattPttDriver.swift`:

```swift
import CoreBluetooth
import Foundation
import os

protocol BleGattPttDriverDelegate: AnyObject {
    func driverDidPress(_ driver: BleGattPttDriver)
    func driverDidRelease(_ driver: BleGattPttDriver)
    func driver(_ driver: BleGattPttDriver, connectionDidChange isConnected: Bool)
    func driver(_ driver: BleGattPttDriver, didFail error: RadioError)
}

/// The GATT push-to-talk button (spec section 9.1). Background-capable: the
/// central is created with a restore identifier, so iOS relaunches the app on a
/// characteristic change with the screen locked.
public final class BleGattPttDriver: NSObject {

    private enum Mode {
        case idle
        case bound(PttBinding)
        case scanning
        case learning
    }

    weak var delegate: BleGattPttDriverDelegate?

    /// Every device seen during a learning scan, republished as the list grows.
    var onCandidates: (([PttCandidate]) -> Void)?

    /// A device has been chosen and the session moved on to capturing a press.
    var onLearningStarted: (() -> Void)?

    private let queue: DispatchQueue
    private let log = Logger(
        subsystem: RadioConfig.Logging.subsystem,
        category: "ptt.ble"
    )

    private var central: CBCentralManager?
    private var peripheral: CBPeripheral?
    private var mode: Mode = .idle
    private var candidates: [String: PttCandidate] = [:]
    private var discovered: [String: CBPeripheral] = [:]
    private var learningCompletion: ((Result<PttConfiguration, RadioError>) -> Void)?
    private var learnedPressed: (characteristic: CBCharacteristic, value: String)?
    private var learningDeadline: DispatchWorkItem?
    private var autoSelectFallback: DispatchWorkItem?
    private var isPressed = false

    public init(queue: DispatchQueue) {
        self.queue = queue
        super.init()
    }

    private func ensureCentral() {
        guard central == nil else { return }
        central = CBCentralManager(
            delegate: self,
            queue: queue,
            options: [
                CBCentralManagerOptionRestoreIdentifierKey:
                    RadioConfig.Ptt.centralRestoreIdentifier
            ]
        )
    }

    // MARK: - Bound mode

    func bind(to binding: PttBinding) {
        ensureCentral()
        guard case let .ble(deviceId, _, _, _, _) = binding else {
            delegate?.driver(self, didFail: .pttFailed("iOS supports GATT buttons only"))
            return
        }
        mode = .bound(binding)
        guard central?.state == .poweredOn else { return }
        connectBound(deviceId: deviceId)
    }

    func unbind() {
        cancelTimers()
        if let peripheral {
            central?.cancelPeripheralConnection(peripheral)
        }
        peripheral = nil
        mode = .idle
        isPressed = false
        delegate?.driver(self, connectionDidChange: false)
    }

    private func connectBound(deviceId: String) {
        guard let uuid = UUID(uuidString: deviceId), let central else { return }
        if let known = central.retrievePeripherals(withIdentifiers: [uuid]).first {
            peripheral = known
            known.delegate = self
            // No timeout: iOS keeps this pending and connects the moment the
            // button is back in range, which is the reconnect requirement.
            central.connect(known, options: nil)
        } else {
            central.scanForPeripherals(withServices: nil, options: nil)
        }
    }

    // MARK: - Learning (spec section 9.3)

    func beginLearning(completion: @escaping (Result<PttConfiguration, RadioError>) -> Void) {
        ensureCentral()
        cancelTimers()
        learningCompletion = completion
        learnedPressed = nil
        candidates.removeAll()
        discovered.removeAll()
        mode = .scanning

        let deadline = DispatchWorkItem { [weak self] in
            self?.finishLearning(
                .failure(.pairingFailed("no button press was captured in time"))
            )
        }
        learningDeadline = deadline
        queue.asyncAfter(
            deadline: .now() + RadioConfig.Ptt.learningTimeout,
            execute: deadline
        )

        // Safety net only: the product path is `selectCandidate(deviceId:)`
        // from the UI. This exists so a build with no UI can still pair.
        let fallback = DispatchWorkItem { [weak self] in self?.pickStrongestCandidate() }
        autoSelectFallback = fallback
        queue.asyncAfter(
            deadline: .now() + RadioConfig.Ptt.autoSelectFallback,
            execute: fallback
        )

        guard central?.state == .poweredOn else { return }
        central?.scanForPeripherals(withServices: nil, options: nil)
    }

    /// The user's pick, published to the engine as `pttPairing.candidates`.
    public func selectCandidate(deviceId: String) {
        queue.async { [self] in
            guard case .scanning = mode, let target = discovered[deviceId] else { return }
            autoSelectFallback?.cancel()
            connectForLearning(target)
        }
    }

    private func pickStrongestCandidate() {
        guard case .scanning = mode else { return }
        let strongest = candidates.values.max { $0.rssi < $1.rssi }
        guard
            let strongest,
            let target = discovered[strongest.deviceId]
        else {
            finishLearning(.failure(.pairingFailed("no Bluetooth devices found")))
            return
        }
        connectForLearning(target)
    }

    private func connectForLearning(_ target: CBPeripheral) {
        mode = .learning
        autoSelectFallback?.cancel()
        central?.stopScan()
        peripheral = target
        target.delegate = self
        central?.connect(target, options: nil)
        onLearningStarted?()
        log.info("learning from \(target.name ?? "unnamed", privacy: .public)")
    }

    private func finishLearning(_ result: Result<PttConfiguration, RadioError>) {
        cancelTimers()
        central?.stopScan()
        let completion = learningCompletion
        learningCompletion = nil
        learnedPressed = nil
        if case .success = result {
            // The manager rebinds immediately; nothing to unwind here.
        } else if case .learning = mode, let peripheral {
            central?.cancelPeripheralConnection(peripheral)
            mode = .idle
        } else {
            mode = .idle
        }
        completion?(result)
    }

    private func cancelTimers() {
        learningDeadline?.cancel()
        learningDeadline = nil
        autoSelectFallback?.cancel()
        autoSelectFallback = nil
    }

    fileprivate func handleValue(_ data: Data, from characteristic: CBCharacteristic) {
        let hex = PttHex.string(from: data)

        switch mode {
        case .learning:
            guard let pressed = learnedPressed else {
                learnedPressed = (characteristic, hex)
                log.info("captured pressed value \(hex, privacy: .public)")
                return
            }
            guard
                pressed.characteristic.uuid == characteristic.uuid,
                pressed.value != hex
            else {
                return
            }
            guard
                let serviceUuid = characteristic.service?.uuid.uuidString,
                let deviceId = peripheral?.identifier.uuidString
            else {
                finishLearning(.failure(.pairingFailed("incomplete GATT description")))
                return
            }
            let configuration = PttConfiguration(
                name: peripheral?.name ?? "PTT button",
                binding: .ble(
                    deviceId: deviceId,
                    serviceUuid: serviceUuid,
                    characteristicUuid: characteristic.uuid.uuidString,
                    pressedValue: pressed.value,
                    releasedValue: hex
                )
            )
            mode = .bound(configuration.binding)
            finishLearning(.success(configuration))

        case let .bound(binding):
            guard
                case let .ble(_, _, characteristicUuid, pressedValue, releasedValue) = binding,
                characteristic.uuid.uuidString.caseInsensitiveCompare(characteristicUuid)
                    == .orderedSame
            else {
                return
            }
            if hex == pressedValue, !isPressed {
                isPressed = true
                delegate?.driverDidPress(self)
            } else if hex == releasedValue, isPressed {
                isPressed = false
                delegate?.driverDidRelease(self)
            }

        case .idle, .scanning:
            break
        }
    }
}
```

- [ ] **Step 6: Write the driver's CoreBluetooth conformances**

Append to `ios/Radio/Sources/RadioKit/BleGattPttDriver.swift`:

```swift
// MARK: - CBCentralManagerDelegate

extension BleGattPttDriver: CBCentralManagerDelegate {

    public func centralManagerDidUpdateState(_ central: CBCentralManager) {
        guard central.state == .poweredOn else {
            delegate?.driver(self, connectionDidChange: false)
            return
        }
        switch mode {
        case let .bound(binding):
            if case let .ble(deviceId, _, _, _, _) = binding {
                connectBound(deviceId: deviceId)
            }
        case .scanning:
            central.scanForPeripherals(withServices: nil, options: nil)
        case .idle, .learning:
            break
        }
    }

    public func centralManager(
        _ central: CBCentralManager,
        willRestoreState state: [String: Any]
    ) {
        let restored = state[CBCentralManagerRestoredStatePeripheralsKey] as? [CBPeripheral]
        guard let peripheral = restored?.first else { return }
        self.peripheral = peripheral
        peripheral.delegate = self
        log.info("restored \(peripheral.identifier.uuidString, privacy: .public)")
    }

    public func centralManager(
        _ central: CBCentralManager,
        didDiscover peripheral: CBPeripheral,
        advertisementData: [String: Any],
        rssi RSSI: NSNumber
    ) {
        let deviceId = peripheral.identifier.uuidString

        if case let .bound(binding) = mode,
           case let .ble(boundId, _, _, _, _) = binding,
           boundId == deviceId {
            central.stopScan()
            self.peripheral = peripheral
            peripheral.delegate = self
            central.connect(peripheral, options: nil)
            return
        }

        guard case .scanning = mode else { return }
        let name = peripheral.name
            ?? advertisementData[CBAdvertisementDataLocalNameKey] as? String
            ?? "Unnamed device"
        discovered[deviceId] = peripheral
        candidates[deviceId] = PttCandidate(
            deviceId: deviceId,
            name: name,
            rssi: RSSI.intValue
        )
        onCandidates?(Array(candidates.values).sorted { $0.rssi > $1.rssi })
    }

    public func centralManager(
        _ central: CBCentralManager,
        didConnect peripheral: CBPeripheral
    ) {
        peripheral.discoverServices(nil)
        if case .bound = mode {
            delegate?.driver(self, connectionDidChange: true)
        }
    }

    public func centralManager(
        _ central: CBCentralManager,
        didFailToConnect peripheral: CBPeripheral,
        error: Error?
    ) {
        if case .learning = mode {
            finishLearning(.failure(.pairingFailed("could not connect to the button")))
        } else {
            central.connect(peripheral, options: nil)
        }
    }

    public func centralManager(
        _ central: CBCentralManager,
        didDisconnectPeripheral peripheral: CBPeripheral,
        error: Error?
    ) {
        isPressed = false
        delegate?.driver(self, connectionDidChange: false)
        guard case .bound = mode else { return }
        // Pending indefinitely: this is the button half of "reconnects
        // automatically after signal loss" (spec section 2).
        central.connect(peripheral, options: nil)
    }
}

// MARK: - CBPeripheralDelegate

extension BleGattPttDriver: CBPeripheralDelegate {

    public func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
        for service in peripheral.services ?? [] {
            peripheral.discoverCharacteristics(nil, for: service)
        }
    }

    public func peripheral(
        _ peripheral: CBPeripheral,
        didDiscoverCharacteristicsFor service: CBService,
        error: Error?
    ) {
        for characteristic in service.characteristics ?? [] {
            let notifies = characteristic.properties.contains(.notify)
                || characteristic.properties.contains(.indicate)
            guard notifies else { continue }

            if case let .bound(binding) = mode,
               case let .ble(_, _, characteristicUuid, _, _) = binding {
                guard
                    characteristic.uuid.uuidString.caseInsensitiveCompare(characteristicUuid)
                        == .orderedSame
                else {
                    continue
                }
            }
            // In learning mode every notifying characteristic is subscribed to;
            // the one the button actually uses reveals itself on the first press.
            peripheral.setNotifyValue(true, for: characteristic)
        }
    }

    public func peripheral(
        _ peripheral: CBPeripheral,
        didUpdateValueFor characteristic: CBCharacteristic,
        error: Error?
    ) {
        guard let value = characteristic.value else { return }
        handleValue(value, from: characteristic)
    }
}
```

- [ ] **Step 7: Write the PttManager**

Create `ios/Radio/Sources/RadioKit/PttManager.swift`:

```swift
import Foundation
import os

/// Owns the button: persistence, the driver, and the press semantics the engine
/// consumes (spec section 9). Strictly hold-to-talk — a press starts the
/// transmission, a release ends it, and nothing else is inferred.
public final class PttManager: PttSource {

    public weak var delegate: PttSourceDelegate?
    public private(set) var buttonState = PttButtonState()

    private let queue: DispatchQueue
    private let store: PttBindingStore
    private let driver: BleGattPttDriver
    private let log = Logger(
        subsystem: RadioConfig.Logging.subsystem,
        category: "ptt"
    )

    private var configuration: PttConfiguration?
    private var pairing: PttPairingState?

    public init(queue: DispatchQueue, defaults: UserDefaults = .standard) {
        self.queue = queue
        self.store = PttBindingStore(defaults: defaults)
        self.driver = BleGattPttDriver(queue: queue)
        self.driver.delegate = self

        configuration = store.load()
        buttonState = PttButtonState(
            configured: configuration != nil,
            connected: false,
            name: configuration?.name
        )

        driver.onCandidates = { [weak self] candidates in
            guard let self, let pairing = self.pairing, pairing.phase == .scanning else {
                return
            }
            self.publish(PttPairingState(phase: .scanning, candidates: candidates))
        }
        driver.onLearningStarted = { [weak self] in
            guard let self else { return }
            self.publish(
                PttPairingState(phase: .learning, candidates: self.pairing?.candidates ?? [])
            )
        }
    }

    public func start() {
        queue.async { [self] in
            guard let configuration else { return }
            driver.bind(to: configuration.binding)
            log.info("binding to \(configuration.name, privacy: .public)")
        }
    }

    public func stop() {
        queue.async { [self] in driver.unbind() }
    }

    public func beginLearning(
        completion: @escaping (Result<PttConfiguration, RadioError>) -> Void
    ) {
        queue.async { [self] in
            publish(PttPairingState(phase: .scanning))
            driver.beginLearning { [weak self] result in
                guard let self else { return }
                if case let .success(configuration) = result {
                    self.configuration = configuration
                    self.store.save(configuration)
                    self.publish(
                        PttPairingState(
                            phase: .saved,
                            candidates: self.pairing?.candidates ?? []
                        )
                    )
                    self.updateState(configured: true, connected: true, name: configuration.name)
                    self.log.info("learned \(configuration.name, privacy: .public)")
                }
                // The engine clears `pttPairing` once the promise resolves; the
                // `.saved` snapshot above is delivered first.
                self.pairing = nil
                completion(result)
            }
        }
    }

    public func selectCandidate(deviceId: String) {
        queue.async { [self] in driver.selectCandidate(deviceId: deviceId) }
    }

    public func forget() {
        queue.async { [self] in
            driver.unbind()
            store.clear()
            configuration = nil
            updateState(configured: false, connected: false, name: nil)
        }
    }

    private func publish(_ state: PttPairingState?) {
        guard pairing != state else { return }
        pairing = state
        delegate?.pttSource(self, pairingStateDidChange: state)
    }

    private func updateState(configured: Bool, connected: Bool, name: String?) {
        let next = PttButtonState(configured: configured, connected: connected, name: name)
        guard next != buttonState else { return }
        buttonState = next
        delegate?.pttSource(self, buttonStateDidChange: next)
    }
}

// MARK: - BleGattPttDriverDelegate

extension PttManager: BleGattPttDriverDelegate {

    func driverDidPress(_ driver: BleGattPttDriver) {
        delegate?.pttSourceDidPress(self)
    }

    func driverDidRelease(_ driver: BleGattPttDriver) {
        delegate?.pttSourceDidRelease(self)
    }

    func driver(_ driver: BleGattPttDriver, connectionDidChange isConnected: Bool) {
        updateState(
            configured: configuration != nil,
            connected: isConnected,
            name: configuration?.name
        )
    }

    func driver(_ driver: BleGattPttDriver, didFail error: RadioError) {
        log.error("\(error.message, privacy: .public)")
    }
}
```

- [ ] **Step 8: Run the test and confirm it passes**

Run: `pnpm test ios-radio-sources`
Expected: PASS.

- [ ] **Step 9: Run the full task gate**

Run: `pnpm typecheck && pnpm lint && pnpm test ios-radio-sources`
Expected: all green.

- [ ] **Step 10: Commit**

```bash
rtk git add ios/Radio __tests__/ios-radio-sources.test.ts
rtk git commit -m "feat(ios): add the BLE PTT driver, binding store and manager"
```

---

### Task 9: Native localization — en and ru

**Files:**
- Create: `ios/Radio/Sources/RadioKit/Resources/en.lproj/Localizable.strings`
- Create: `ios/Radio/Sources/RadioKit/Resources/ru.lproj/Localizable.strings`
- Create: `ios/Oru/en.lproj/InfoPlist.strings`
- Create: `ios/Oru/ru.lproj/InfoPlist.strings`
- Modify: `ios/Oru/Info.plist`
- Modify: `ios/Oru.xcodeproj/project.pbxproj`
- Test: `__tests__/ios-localization.test.ts`

**Interfaces:**
- Consumes: the keys `ptt.channel.name` and `ptt.participant.nearby` read by `BackgroundManager` in Task 7 through `Bundle.module`.
- Produces: nothing other plans call. Lingui `.po` catalogs are the JS layer's (P4/P6); nothing in this task touches `src/`.

**Two bundles, two mechanisms** (spec §12.2). Strings the app shows *through system UI at runtime* — the PushToTalk channel name and the speaking-participant name — ship inside the package and resolve via `Bundle.module`. Strings the *system* reads out of the app bundle before any code runs — the three permission prompts — must be `InfoPlist.strings` in the app target, which is the one place in this plan that needs a variant group in the Xcode project. Write every `.strings` file as **UTF-8**.

- [ ] **Step 1: Write the failing test**

Create `__tests__/ios-localization.test.ts`:

```ts
import {existsSync, readFileSync} from 'fs';
import {join} from 'path';

const IOS_DIR = join(__dirname, '..', 'ios');
const RESOURCES = join(IOS_DIR, 'Radio', 'Sources', 'RadioKit', 'Resources');

function read(...segments: string[]): string {
  const path = join(...segments);
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

function keysOf(strings: string): string[] {
  return [...strings.matchAll(/^"([^"]+)"\s*=\s*"([^"]*)";$/gm)]
    .map(match => match[1])
    .sort();
}

function valueOf(strings: string, key: string): string | undefined {
  const match = strings.match(
    new RegExp(`^"${key}"\\s*=\\s*"([^"]*)";$`, 'm'),
  );
  return match ? match[1] : undefined;
}

const packageEn = read(RESOURCES, 'en.lproj', 'Localizable.strings');
const packageRu = read(RESOURCES, 'ru.lproj', 'Localizable.strings');
const plistEn = read(IOS_DIR, 'Oru', 'en.lproj', 'InfoPlist.strings');
const plistRu = read(IOS_DIR, 'Oru', 'ru.lproj', 'InfoPlist.strings');
const infoPlist = read(IOS_DIR, 'Oru', 'Info.plist');
const pbxproj = read(IOS_DIR, 'Oru.xcodeproj', 'project.pbxproj');

const USAGE_KEYS = [
  'NSMicrophoneUsageDescription',
  'NSBluetoothAlwaysUsageDescription',
  'NSLocalNetworkUsageDescription',
];

describe('package strings (spec section 12.2)', () => {
  it.each(['ptt.channel.name', 'ptt.participant.nearby'])(
    'defines %s in english',
    key => {
      expect(valueOf(packageEn, key)).toBeTruthy();
    },
  );

  it('has the same key set in both locales', () => {
    expect(keysOf(packageRu)).toEqual(keysOf(packageEn));
    expect(keysOf(packageEn).length).toBeGreaterThan(0);
  });

  it('actually translates every russian value', () => {
    for (const key of keysOf(packageEn)) {
      expect(valueOf(packageRu, key)).toBeTruthy();
      expect(valueOf(packageRu, key)).not.toEqual(valueOf(packageEn, key));
    }
  });
});

describe('InfoPlist.strings (spec sections 11, 12.2)', () => {
  it.each(USAGE_KEYS)('localizes %s in both locales', key => {
    expect(valueOf(plistEn, key)).toBeTruthy();
    expect(valueOf(plistRu, key)).toBeTruthy();
    expect(valueOf(plistRu, key)).not.toEqual(valueOf(plistEn, key));
  });

  it('has the same key set in both locales', () => {
    expect(keysOf(plistRu)).toEqual(keysOf(plistEn));
  });

  it('localizes exactly the keys Info.plist declares', () => {
    for (const key of keysOf(plistEn)) {
      expect(infoPlist).toContain(`<key>${key}</key>`);
    }
  });
});

describe('app bundle localization wiring', () => {
  it('declares both locales in CFBundleLocalizations', () => {
    const index = infoPlist.indexOf('<key>CFBundleLocalizations</key>');
    expect(index).toBeGreaterThan(-1);
    const array = infoPlist.slice(index, index + 200);
    expect(array).toContain('<string>en</string>');
    expect(array).toContain('<string>ru</string>');
  });

  it('adds the InfoPlist.strings variant group to the project', () => {
    expect(pbxproj).toContain('PBXVariantGroup');
    expect(pbxproj).toContain('Oru/en.lproj/InfoPlist.strings');
    expect(pbxproj).toContain('Oru/ru.lproj/InfoPlist.strings');
    expect(pbxproj).toContain('InfoPlist.strings in Resources');
  });

  it('registers ru as a known region', () => {
    const index = pbxproj.indexOf('knownRegions = (');
    expect(index).toBeGreaterThan(-1);
    expect(pbxproj.slice(index, index + 120)).toContain('ru,');
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `pnpm test ios-localization`
Expected: FAIL — every block fails; `keysOf('')` returns `[]`, so the parity assertions fail on the length check and the value lookups return `undefined`.

- [ ] **Step 3: Write the package strings**

Create `ios/Radio/Sources/RadioKit/Resources/en.lproj/Localizable.strings`:

```
/* Name of the push-to-talk channel shown in system UI */
"ptt.channel.name" = "Oru Radio";

/* Shown while a nearby device is speaking */
"ptt.participant.nearby" = "Nearby device";
```

Create `ios/Radio/Sources/RadioKit/Resources/ru.lproj/Localizable.strings`:

```
/* Name of the push-to-talk channel shown in system UI */
"ptt.channel.name" = "Рация Oru";

/* Shown while a nearby device is speaking */
"ptt.participant.nearby" = "Устройство рядом";
```

- [ ] **Step 4: Write the permission strings**

Create `ios/Oru/en.lproj/InfoPlist.strings` — the English values must be identical to the ones already in `Info.plist`:

```
"NSMicrophoneUsageDescription" = "Oru uses the microphone to transmit your voice to nearby devices.";
"NSBluetoothAlwaysUsageDescription" = "Oru connects to your Bluetooth push-to-talk button, including while the screen is locked.";
"NSLocalNetworkUsageDescription" = "Oru discovers and connects to nearby devices over the local network.";
```

Create `ios/Oru/ru.lproj/InfoPlist.strings`:

```
"NSMicrophoneUsageDescription" = "Oru использует микрофон, чтобы передавать ваш голос на устройства рядом.";
"NSBluetoothAlwaysUsageDescription" = "Oru подключается к Bluetooth-кнопке рации, в том числе при заблокированном экране.";
"NSLocalNetworkUsageDescription" = "Oru находит устройства рядом и соединяется с ними по локальной сети.";
```

- [ ] **Step 5: Declare both locales in Info.plist**

In `ios/Oru/Info.plist`, insert immediately **before** the `<key>CFBundleName</key>` line (the file is ordered alphabetically):

```xml
	<key>CFBundleLocalizations</key>
	<array>
		<string>en</string>
		<string>ru</string>
	</array>
```

- [ ] **Step 6: Add the variant group to the Xcode project**

Four edits in `ios/Oru.xcodeproj/project.pbxproj`, tab-indented like the rest of the file.

Edit 1 — in `/* Begin PBXBuildFile section */`:

```
		9A1E0001AAAA0000BBBB0001 /* InfoPlist.strings in Resources */ = {isa = PBXBuildFile; fileRef = 9A1E0002AAAA0000BBBB0002 /* InfoPlist.strings */; };
```

Edit 2 — in `/* Begin PBXFileReference section */`:

```
		9A1E0003AAAA0000BBBB0003 /* en */ = {isa = PBXFileReference; lastKnownFileType = text.plist.strings; name = en; path = Oru/en.lproj/InfoPlist.strings; sourceTree = "<group>"; };
		9A1E0004AAAA0000BBBB0004 /* ru */ = {isa = PBXFileReference; lastKnownFileType = text.plist.strings; name = ru; path = Oru/ru.lproj/InfoPlist.strings; sourceTree = "<group>"; };
```

Edit 3 — in the `Oru` group `13B07FAE1A68108700A75B9A`, add the variant group to `children` after the `Info.plist` entry:

```
					13B07FB61A68108700A75B9A /* Info.plist */,
					9A1E0002AAAA0000BBBB0002 /* InfoPlist.strings */,
```

Edit 4 — in the Resources build phase `13B07F8E1A680F5B00A75B9A`, add to `files`:

```
					13B07FBF1A68108700A75B9A /* Images.xcassets in Resources */,
					9A1E0001AAAA0000BBBB0001 /* InfoPlist.strings in Resources */,
```

- [ ] **Step 7: Add the variant group section and the region**

Edit 5 — add `ru,` to `knownRegions` in the `PBXProject` object:

```
			knownRegions = (
				en,
				ru,
				Base,
			);
```

Edit 6 — append a new section immediately after the `/* End PBXSourcesBuildPhase section */` line:

```

/* Begin PBXVariantGroup section */
		9A1E0002AAAA0000BBBB0002 /* InfoPlist.strings */ = {
			isa = PBXVariantGroup;
			children = (
				9A1E0003AAAA0000BBBB0003 /* en */,
				9A1E0004AAAA0000BBBB0004 /* ru */,
			);
			name = InfoPlist.strings;
			sourceTree = "<group>";
		};
/* End PBXVariantGroup section */
```

- [ ] **Step 8: Run the test and confirm it passes**

Run: `pnpm test ios-localization`
Expected: PASS, 11 tests.

- [ ] **Step 9: Run the full task gate**

Run: `pnpm typecheck && pnpm lint && pnpm test ios-`
Expected: all green — the trailing `ios-` runs all three iOS test files at once.

- [ ] **Step 10: Commit**

```bash
rtk git add ios __tests__/ios-localization.test.ts
rtk git commit -m "feat(ios): localize native strings for en and ru"
```

---

### Task 10: Composition root, Phase 0 spike hooks, runbook

**Files:**
- Create: `ios/Radio/Sources/RadioKit/RadioAssembly.swift`
- Create: `ios/Radio/Sources/RadioKit/RadioSpike.swift`
- Create: `ios/Radio/README.md`
- Modify: `ios/Oru/AppDelegate.swift`
- Modify: `__tests__/ios-radio-sources.test.ts` (append one describe block)

**Interfaces:**
- Consumes: every component built in Tasks 3–8.
- Produces: `RadioAssembly.shared` (`.engine: RadioEngine`, `.ptt: PttManager`) — **the entry point P5's Turbo Module uses** — and `RadioSpike.bootstrap()`, `RadioSpike.startTransmit()`, `RadioSpike.stopTransmit()`, `RadioSpike.configurePtt()`.

**How Phase 0 is actually driven, with no UI and no React Native.** The DEBUG build starts the engine at launch, which joins the PushToTalk channel — and a joined channel puts a system talk button on the lock screen and in the Dynamic Island. That is the manual transmit affordance for scenarios B and C; no app UI is needed or wanted. Everything else is read from the device log: every event is one `[spike]` line under subsystem `com.oru.radio`, visible in Console.app with the phone attached, which is how the operator evidences A–D.

- [ ] **Step 1: Write the failing test**

Append to `__tests__/ios-radio-sources.test.ts`:

```ts
describe('assembly and spike hooks (spec section 15, phase 0)', () => {
  const assembly = source('RadioAssembly.swift');
  const spike = source('RadioSpike.swift');
  const appDelegate = existsSync(
    join(__dirname, '..', 'ios', 'Oru', 'AppDelegate.swift'),
  )
    ? readFileSync(join(__dirname, '..', 'ios', 'Oru', 'AppDelegate.swift'), 'utf8')
    : '';

  it.each([
    'public final class RadioAssembly',
    'public static let shared',
    'public let engine: RadioEngine',
  ])('RadioAssembly.swift declares %s', declaration => {
    expect(assembly).toContain(declaration);
  });

  it('builds every production port exactly once', () => {
    expect(assembly).toContain('NearbyManager(');
    expect(assembly).toContain('AudioEngine(');
    expect(assembly).toContain('PttManager(');
    expect(assembly).toContain('BackgroundManager()');
    expect(assembly).toContain('DispatchRadioClock(');
  });

  it.each([
    'public static func bootstrap()',
    'public static func startTransmit()',
    'public static func stopTransmit()',
    'public static func configurePtt(',
    'public static func selectPttCandidate(',
  ])('RadioSpike.swift declares %s', declaration => {
    expect(spike).toContain(declaration);
  });

  it('logs pairing candidates so a headless run can pick one', () => {
    expect(spike).toContain('state.pttPairing');
  });

  it('logs every engine event under one greppable prefix', () => {
    expect(spike).toContain('[spike]');
    expect(spike).toContain('addObserver(');
  });

  it('is bootstrapped from the app delegate in debug builds only', () => {
    expect(appDelegate).toContain('import RadioKit');
    expect(appDelegate).toContain('RadioSpike.bootstrap()');
    const guardIndex = appDelegate.indexOf('#if DEBUG');
    const callIndex = appDelegate.indexOf('RadioSpike.bootstrap()');
    expect(guardIndex).toBeGreaterThan(-1);
    expect(guardIndex).toBeLessThan(callIndex);
  });

  it('ships a phase 0 runbook covering all four scenarios', () => {
    const readme = existsSync(join(__dirname, '..', 'ios', 'Radio', 'README.md'))
      ? readFileSync(join(__dirname, '..', 'ios', 'Radio', 'README.md'), 'utf8')
      : '';
    for (const scenario of ['Scenario A', 'Scenario B', 'Scenario C', 'Scenario D']) {
      expect(readme).toContain(scenario);
    }
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `pnpm test ios-radio-sources`
Expected: FAIL on the new block.

- [ ] **Step 3: Write the composition root**

Create `ios/Radio/Sources/RadioKit/RadioAssembly.swift`:

```swift
import Foundation

/// The one place production objects are wired together. Everything above the
/// engine — the Turbo Module in wave 3, the spike hooks below — goes through
/// `RadioAssembly.shared.engine` and never constructs a port itself.
public final class RadioAssembly {

    public static let shared = RadioAssembly()

    public let engine: RadioEngine
    public let ptt: PttManager

    private init() {
        let engineQueue = DispatchQueue(label: "com.oru.radio.engine")
        let transport = NearbyManager(
            queue: DispatchQueue(label: "com.oru.radio.transport")
        )
        let audio = AudioEngine(queue: DispatchQueue(label: "com.oru.radio.audio"))
        let ptt = PttManager(queue: DispatchQueue(label: "com.oru.radio.ptt"))
        let background = BackgroundManager()

        self.ptt = ptt
        engine = RadioEngine(
            transport: transport,
            audio: audio,
            ptt: ptt,
            background: background,
            clock: DispatchRadioClock(queue: engineQueue),
            queue: engineQueue
        )
    }
}
```

- [ ] **Step 4: Write the spike hooks**

Create `ios/Radio/Sources/RadioKit/RadioSpike.swift`:

```swift
import Foundation
import os

/// Phase 0 lives here (spec section 15). No UI: the engine starts with the app,
/// the PushToTalk channel supplies a system talk button on the lock screen, and
/// every state change lands in the device log as one `[spike]` line.
public enum RadioSpike {

    private static let log = Logger(
        subsystem: RadioConfig.Logging.subsystem,
        category: "spike"
    )
    private static var isBootstrapped = false

    public static func bootstrap() {
        guard !isBootstrapped else { return }
        isBootstrapped = true

        let engine = RadioAssembly.shared.engine
        engine.addObserver("spike") { event in
            switch event {
            case let .stateChanged(state):
                log.notice(
                    """
                    [spike] state status=\(state.status.rawValue, privacy: .public) \
                    nearby=\(state.nearbyCount, privacy: .public) \
                    tx=\(state.transmitting, privacy: .public) \
                    rx=\(state.receiving, privacy: .public) \
                    button=\(state.pttButton.configured, privacy: .public)/\
                    \(state.pttButton.connected, privacy: .public)
                    """
                )
                if let pairing = state.pttPairing {
                    let candidates = pairing.candidates
                        .map { "\($0.deviceId) \($0.name) \($0.rssi)" }
                        .joined(separator: " | ")
                    log.notice(
                        """
                        [spike] pairing phase=\(pairing.phase.rawValue, privacy: .public) \
                        candidates=[\(candidates, privacy: .public)]
                        """
                    )
                }
            case let .error(error):
                log.error(
                    """
                    [spike] error code=\(error.code, privacy: .public) \
                    message=\(error.message, privacy: .public)
                    """
                )
            }
        }

        engine.startRadio()
        log.notice("[spike] radio started")
    }

    public static func startTransmit() {
        log.notice("[spike] startTransmit")
        RadioAssembly.shared.engine.startTransmit()
    }

    public static func stopTransmit() {
        log.notice("[spike] stopTransmit")
        RadioAssembly.shared.engine.stopTransmit()
    }

    /// The user's pick. Phase 0 has no UI, so either call this with a deviceId
    /// read from the `[spike] pairing` log line, or wait out
    /// `RadioConfig.Ptt.autoSelectFallback` and let the strongest signal win.
    public static func selectPttCandidate(_ deviceId: String) {
        log.notice("[spike] selectPttCandidate \(deviceId, privacy: .public)")
        RadioAssembly.shared.engine.selectPttCandidate(deviceId: deviceId)
    }

    public static func configurePtt() {
        log.notice("[spike] configurePtt: pick a candidate, then press the button twice")
        RadioAssembly.shared.engine.configurePtt { result in
            switch result {
            case let .success(configuration):
                log.notice(
                    "[spike] learned \(configuration.name, privacy: .public)"
                )
            case let .failure(error):
                log.error("[spike] pairing failed: \(error.message, privacy: .public)")
            }
        }
    }
}
```

- [ ] **Step 5: Bootstrap the spike from the app delegate**

In `ios/Oru/AppDelegate.swift`, add the import after `import ReactAppDependencyProvider`:

```swift
import RadioKit
```

and insert the bootstrap as the first statement of `application(_:didFinishLaunchingWithOptions:)`, before `let delegate = ReactNativeDelegate()`:

```swift
    // Phase 0: the radio runs without React Native. Debug builds only; wave 4
    // replaces this with the real app-entry wiring.
#if DEBUG
    RadioSpike.bootstrap()
#endif

```

- [ ] **Step 6: Write the runbook**

Create `ios/Radio/README.md`:

````markdown
# RadioKit — the iOS radio

A local Swift package holding the whole iOS radio: transport, audio, PTT and
background execution. It does not depend on React Native, and nothing in it
imports React or UIKit. React Native calls into it from wave 3 through
`RadioAssembly.shared.engine`.

## Layout

| File | Responsibility |
|---|---|
| `RadioConfig.swift` | every tunable: codec, jitter depth, safety cap, service id |
| `RadioEngine.swift` | the state machine (start/stop, transmit, peers, incoming) |
| `NearbyManager.swift` | Nearby Connections: advertise, discover, control, streams |
| `AudioEngine.swift` | AVAudioEngine capture and playback, mixing per peer |
| `OpusCodec.swift` | libopus encode/decode |
| `BackgroundManager.swift` | PushToTalk channel, audio-session activation |
| `PttManager.swift`, `BleGattPttDriver.swift` | the Bluetooth button |
| `RadioSpike.swift` | Phase 0 hooks |

## Building it the first time

This package has never been compiled: it was written on a Windows host with no
Swift toolchain. The first build is the closeout macOS build.

```bash
cd ios && pod install
xcodebuild -workspace Oru.xcworkspace -scheme Oru \
  -destination 'generic/platform=iOS' -resolvePackageDependencies
open Oru.xcworkspace
```

Then, in order:

1. Resolve the two remote packages (`google/nearby`, `alta/swift-opus`) and
   commit the resulting `Package.resolved`. Both are declared on `branch: "main"`
   precisely because no release tag could be verified from the planning host.
2. Set a development team and provisioning profile carrying the
   `com.apple.developer.push-to-talk` entitlement. Without it the app cannot
   join a PT channel, and every background scenario fails at once.
3. Fix compile fallout. Third-party API drift is confined by design to
   `NearbyManager.swift` and `OpusCodec.swift`.
4. Run the package tests: `xcodebuild test -scheme Oru -destination
   'platform=iOS Simulator,name=iPhone 15'`. They cover the control-message
   codec, stream framing, the engine state machine, the jitter buffer and
   binding persistence — everything that does not need real hardware.

## Phase 0 runbook (spec section 15)

Two physical devices: one Android, one iPhone. **Both must be on the same local
Wi-Fi network** — Google's Nearby implementation supports only the Wi-Fi LAN
medium on iOS, so "internet off" means a router or hotspot with no uplink, not
Wi-Fi switched off. Bluetooth on. Install the DEBUG build; the radio starts at
launch and keeps running with the app backgrounded and the screen locked.

Watch the log in Console.app, filtered to subsystem `com.oru.radio`; every line
of interest starts with `[spike]`.

- **Scenario A — Android PTT, locked iPhone plays audio.** Lock the iPhone.
  Transmit from Android. Expect `[spike] state ... rx=true` within a second, the
  system PTT UI showing an active remote participant, and audible speech.
- **Scenario B — iPhone PTT, locked Android plays audio.** With the iPhone
  locked, press the system talk button on the lock screen (the PT channel puts
  it there). Expect `[spike] state ... tx=true` and audio on Android.
- **Scenario C — locked iPhone, Bluetooth button.** Pair the button first: run
  `RadioSpike.configurePtt()` from the Xcode debugger console. Watch the
  `[spike] pairing phase=scanning candidates=[...]` lines, then either call
  `RadioSpike.selectPttCandidate("<deviceId>")` with the button's id or simply
  wait — after `RadioConfig.Ptt.autoSelectFallback` seconds the strongest signal
  is chosen, which with the button in your hand is the button. At
  `phase=learning`, press and release it once; `phase=saved` means the binding
  is stored. Then lock the phone, press the button, and expect `tx=true` while
  locked and audio on Android.
- **Scenario D — reconnect.** Carry the devices out of range until
  `nearby=0`, return, and expect `nearby=1` again with no user action, followed
  by working audio.

Record the outcome and an explicit **Go** or **No-Go** in
`docs/superpowers/specs/2026-08-13-phase0-spike-report.md`. A No-Go means the
transport is replaced before anything else is built — which is why every
Nearby call in this package sits behind `RadioTransport` in one file.
````

- [ ] **Step 7: Run the test and confirm it passes**

Run: `pnpm test ios-radio-sources`
Expected: PASS.

- [ ] **Step 8: Run the full task gate**

Run: `pnpm typecheck && pnpm lint && pnpm test ios-`
Expected: all green across all three iOS test files.

- [ ] **Step 9: Commit**

```bash
rtk git add ios __tests__/ios-radio-sources.test.ts
rtk git commit -m "feat(ios): add the composition root, phase 0 spike hooks and runbook"
```

---

## What this plan deliberately does not do

- **Android anything** → P2. Not one file under `android/` is touched.
- **The TypeScript layer** — `radio.types.ts`, `ptt.types.ts`, `specs/NativeRadio.ts`, the
  Reatom model, the TS control-message codec → P4. Nothing under `src/` or `specs/` is touched.
- **The Turbo Module itself** — codegen config, module registration, the JS event stream →
  P5, which calls `RadioAssembly.shared.engine`.
- **Screens, onboarding, the pairing UI** → P6.
- **The concrete purchased button's protocol** → closeout Stage 5. The *generic* GATT
  learning flow is here; the specific button's service and characteristic UUIDs are
  discovered on hardware.
- **Any claim that this compiles.** See Global Constraints.

## Handoff to closeout

Three things must happen on macOS before this code has ever run, and they are already in the
schedule's Closeout block. In priority order:

1. **`pod install` + Xcode build with the push-to-talk entitlement.** First compile of every
   Swift file here. Commit `ios/Radio/Package.resolved`.
2. **Package tests.** `xcodebuild test` runs the five XCTest files this plan delivers.
3. **Phase 0 A–D** per `ios/Radio/README.md`, then the Go/No-Go write-up the sync-2 pause
   waits on.
