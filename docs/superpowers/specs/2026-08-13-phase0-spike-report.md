# Phase 0 Spike Report — 2026-08-14

## Status

**No Go/No-Go decision has been made.** This section was accurate as of 2026-08-14; see
"## Status (repeated)" at the end of this document for the current state as of 2026-08-15 —
hardware availability and the actual blocker have both changed since this was first written
(an iPhone is now on hand and RadioKit has run on it; the live blocker is a paid Apple Developer
Program enrollment, not a missing iPhone). Nothing in this report should be read as satisfying
Sync 2's Go/No-Go requirement (spec §15 scenarios A–D, per
`docs/superpowers/execution/2026-08-13-offline-nearby-ptt.md` Sync 2) — that is still open.

Scope actually exercised: `docs/phase0-android-spike-hooks.md` sections 1–3 (permissions,
start/stop, drive-while-running) in full, plus the scanning half of section 4 (BLE PTT-button
pairing — `ptt-scan`/`ptt-cancel`, which surfaced Bug found #3 below). The rest of section 4
(`ptt-pick`/learning against a real button) and all of section 5 (scenarios A–D) were out of
scope for this pass — no physical BLE PTT button and no second/iOS device were available.

## 1. Preliminary single-device Android smoke test

**Device:** physical OPPO CPH2747, Android 16, connected via wireless ADB. Debug build already
installed. Test plan followed: `docs/phase0-android-spike-hooks.md` §§1–3 only.

### Permissions (§1)

`adb shell pm grant` failed with a `SecurityException` — a ColorOS/OEM restriction on
shell-granted runtime permissions without "USB debugging (Security settings)" enabled. Worked
around by granting manually via Settings → App info → Oru → Permissions (Microphone,
Notifications, and "Nearby devices" — which on ColorOS bundles
`BLUETOOTH_SCAN`/`BLUETOOTH_CONNECT`/`BLUETOOTH_ADVERTISE` + `NEARBY_WIFI_DEVICES`). Confirmed
via `dumpsys package com.oru` that all target permissions ended up `granted=true`.

### Start/stop via SpikeActivity (§2)

Worked cleanly both times. Logcat showed the expected sequence:

```
spike: radio starting
state={status=starting,...}
radio service started
state={status=ready,...}
```

`RadioForegroundService` came up as a real foreground service with a persistent notification
(channel `oru.radio`). `cmd stop` cleanly tore it down — service record and notification both
disappeared — reproduced twice.

### Bug found #1 — missing Wi-Fi permissions (real code defect)

`android/app/src/main/AndroidManifest.xml` was missing `android.permission.ACCESS_WIFI_STATE`
(and `CHANGE_WIFI_STATE`), which Nearby Connections' Wi-Fi-based advertising/discovery mediums
require. Without it, the engine failed on **every** start with:

```
advertising_failed / discovery_failed 8032: MISSING_PERMISSION_ACCESS_WIFI_STATE
```

and dropped straight from `ready` into `error`. This meant `nearbyCount` could never become
non-zero — this was not "no peers nearby," it was a broken discovery layer that would have
made scenario D unrunnable regardless of peer availability.

### Bug found #2 — non-exported SpikeReceiver (real code defect)

`android/app/src/debug/AndroidManifest.xml` declared `SpikeReceiver` as `android:exported="false"`,
with a comment claiming `adb shell am broadcast` (shell uid 2000) can still reach a
non-exported receiver on a debug build. On this device/Android version that assumption was
false — broadcasts were rejected with a Permission Denial; `dumpsys activity broadcasts
com.oru` showed:

```
is not exported from uid 10600
```

This silently broke every broadcast-driven command from §3 and §4 of the spike hooks doc
(`state`, `ptt-down`, `ptt-up`, `ptt-scan`, `ptt-pick`, `ptt-cancel`, `ptt-forget`, and
`stop`-via-broadcast) — only `SpikeActivity`'s `start`/`stop` (which is `exported="true"`)
worked at all.

### Bug found #3 — BLUETOOTH_SCAN's `neverForLocation` cannot substitute for the location
permission Nearby Connections' BLE medium needs unconditionally (real code defect)

A later pass at the same session (still 2026-08-14) exercised
`docs/phase0-android-spike-hooks.md` §4, the BLE PTT-button pairing flow. Broadcasting
`ptt-scan` was followed shortly after by the whole radio dropping into `status=error`:

```
spike: error discovery_failed 8034: MISSING_PERMISSION_ACCESS_COARSE_LOCATION
```

`dumpsys package com.oru` showed `NEARBY_WIFI_DEVICES`, `BLUETOOTH_SCAN`,
`BLUETOOTH_CONNECT`, `BLUETOOTH_ADVERTISE` and the rest all `granted=true` — no location
permission was granted, or even listed, at all.

**Root cause.** `NearbyManager.kt`'s `start()` calls `client.startDiscovery(...)` (Nearby
Connections, `play-services-nearby:19.4.0`, P2P_CLUSTER strategy) during `cmd start`, and the
`.addOnFailureListener` on that call is what reported `discovery_failed`. The timing that made
it look like `ptt-scan` caused it was a red herring: `RadioEngine.startRadio()` sets
`status=READY` synchronously right after issuing `transport.start()`, without waiting for
Nearby's async advertise/discover `Task`s to resolve — the failure was always coming, it just
surfaced a couple of seconds later, coincidentally close to when `ptt-scan` was broadcast.
`ptt-scan`'s own BLE path (`BleLearningSession.startScan()` in `AndroidPttDriverFactory.kt`)
is a separate, raw `BluetoothLeScanner` call that reports failures through a different channel
(`PttListener.onPttPairingFailed`, never through `RadioEngine.fail()`), and was not implicated.

The manifest declared `BLUETOOTH_SCAN` without `android:usesPermissionFlags="neverForLocation"`,
and capped `ACCESS_FINE_LOCATION` at `android:maxSdkVersion="32"` — matching the design spec's
stated intent (§11: `NEARBY_WIFI_DEVICES` 13+, `ACCESS_FINE_LOCATION` pre-13) but wrong in
practice. Checked against Google's own Nearby Connections Android manifest sample
(developers.google.com/nearby/connections/android/get-started): it declares
`ACCESS_FINE_LOCATION` for the API range where the BLE medium is used and never sets
`neverForLocation` on `BLUETOOTH_SCAN` at all. That is the tell: `ConnectionsStatusCodes 8034`
is a status the Nearby Connections SDK throws itself (its own internal
`checkSelfPermission`-style guard ahead of `startAdvertising()`/`startDiscovery()`), not a
`SecurityException` from the OS's own `BLUETOOTH_SCAN` enforcement. A manifest flag that only
changes what the *OS* requires cannot suppress a permission check the *library* performs on its
own — confirmed directly on this Android 16 (API 36) device, where `NEARBY_WIFI_DEVICES` was
granted and discovery still failed for want of location. `NEARBY_WIFI_DEVICES` covers the
Wi-Fi-based mediums; it does not stand in for what the BLE medium demands.

**Fix applied.** `android/app/src/main/AndroidManifest.xml`: removed the
`android:maxSdkVersion="32"` cap from `ACCESS_FINE_LOCATION` so it is declared (and grantable)
on every API level, not just pre-13, with a comment explaining why. `NEARBY_WIFI_DEVICES` was
left in place. `docs/phase0-android-spike-hooks.md` §1 and
`docs/superpowers/specs/2026-08-13-offline-nearby-ptt-design.md` §11's permission table were
both updated to match: `ACCESS_FINE_LOCATION` is granted unconditionally now, alongside (not
instead of) `NEARBY_WIFI_DEVICES` on 13+.

**Verification.** Rebuilt (`pnpm build:android`), reinstalled on the same physical device.
`adb shell pm grant ... ACCESS_FINE_LOCATION` hit the same ColorOS shell-grant restriction Bug
#1's writeup already flagged, so it was granted by hand via Settings → App info → Oru →
Permissions → Location → "Allow only while using the app" (precise location already on).
`dumpsys package com.oru` then showed `ACCESS_FINE_LOCATION: granted=true`. A fresh `start`
stayed at `status=ready` with no `discovery_failed`/`MISSING_PERMISSION` error, including after
several seconds' wait for the async advertise/discover callbacks to resolve. `ptt-scan` then
produced `pttPairing={phase=scanning, candidates=[...]}` with real nearby BLE devices filling
in over several seconds while `status` stayed `ready` throughout — the exact failure this bug
produced before did not recur. `ptt-cancel` cleared the pairing session and `stop` tore the
radio down cleanly (`dumpsys activity services com.oru` empty afterward, process left idle).

### Bugs #1 and #2 fixed and verified today

- `ACCESS_WIFI_STATE` + `CHANGE_WIFI_STATE` added to `android/app/src/main/AndroidManifest.xml`.
- `SpikeReceiver` flipped to `exported="true"` in `android/app/src/debug/AndroidManifest.xml`
  (the misleading comment was corrected).
- Rebuilt (`:app:assembleDebug`), reinstalled on the same physical device, and re-verified
  directly:
  - `dumpsys package com.oru` now shows both Wi-Fi permissions `granted=true`.
  - A fresh `start` now stays at `status=ready` — no more `advertising_failed`/`discovery_failed`.
  - A `state` broadcast now reaches `SpikeReceiver` and logs a response (`Broadcast completed:
    result=0` plus a corresponding state log line), where before the fix it silently did
    nothing.
  - Radio was stopped cleanly afterward; device left in a clean state.

### Screen-lock survival (§3)

Confirmed indirectly — this check was run before the `SpikeReceiver` fix, so `state` broadcasts
weren't usable at the time. Started the radio, locked the screen (confirmed via a black-screen
check), waited ~8s, and confirmed via `dumpsys activity services` / `ps` that
`RadioForegroundService` and the `com.oru` process (stable pid) survived without crash, ANR, or
service death. Screen was woken and `stop` worked normally afterward.

### Overall read on this pass

The Android engine's basic lifecycle (start → foreground service → screen-lock survival →
clean stop) looks healthy — zero crashes/ANRs across the whole session. Three real
manifest-level defects were caught and fixed: two would otherwise have silently broken the
actual Phase 0 scenario 3 commands (`state`/`ptt-down`/`ptt-up`) even once an iPhone becomes
available, and the third (Bug #3) would have broken discovery/advertising outright on this and
any other Android 13+ device, regardless of peers or an iPhone — so this smoke test had genuine
value beyond "looks fine."

## 2. Native 16 KB page-size alignment fix (adjacent build-health note)

Not a Phase 0 scenario result — noted briefly so future readers understand the build
environment. While setting up an emulator to test against, discovered and fixed a
Play-Store-compliance issue: the vendored `liboru_opus.so` (built via CMake/NDK under
`android/opus/`) wasn't linked with 16 KB ELF page alignment, causing Android's
`PageSizeMismatchDialog` on 16 KB-page-size system images (e.g. the "Medium Phone" AVD, Android
15+/Play Store requirement).

Root-caused via `llvm-readelf -l` on the built `.so` files — 11 of 12 native libraries,
including React Native core, Hermes, and react-native-safe-area-context, were already 16
KB-aligned out of the box; only the project's own opus build wasn't. Fixed with:

```cmake
target_link_options(oru_opus PRIVATE "-Wl,-z,max-page-size=16384")
```

in `android/opus/src/main/cpp/CMakeLists.txt`. Verified via rebuild + re-check of ELF alignment
+ reinstall on the 16 KB emulator (dialog no longer appears).

## 3. What remains explicitly blocked, and why

**Update, 2026-08-15 (later the same day):** iOS build/tooling readiness — the blocker this
section originally pointed to — is now fully resolved: RadioKit compiles end-to-end, its unit
tests pass, and it has run on the physical iPhone. The live blocker for every scenario below is
now a **paid Apple Developer Program enrollment** (the free Personal Team on hand, `J5SLP58ZB6`,
is explicitly refused the `com.apple.developer.push-to-talk` capability by Apple), which turned
out to gate not just background/locked-screen operation but *all* audio, even in the foreground —
see "Foreground smoke test blocked too" further down. Scenario detail kept below for the
BLE-button dependency, which is still accurate.

- **Scenario A** (Android PTT → locked iPhone plays audio) — does not need a physical BLE PTT
  button (driven entirely from the Android side via `adb`, per
  `docs/phase0-android-spike-hooks.md` §5). Blocked solely on the paid account now.
- **Scenario B** (iPhone BLE PTT → locked Android plays audio) — also does not need the
  physical button: it is driven by the iPhone's native PushToTalk lock-screen talk button, per
  `ios/Radio/README.md`'s scenario description. Blocked solely on the paid account (this is the
  entitlement it depends on directly).
- **Scenario C** (locked iPhone BLE PTT → Android receives) — the one scenario that strictly
  requires a physical Bluetooth PTT button (for the `RadioSpike.configurePtt()` pairing/learning
  flow), on top of the paid-account blocker shared with A/B. No physical BLE PTT button available
  yet either (procurement/reverse-engineering is separately scheduled as closeout Stage 5 per the
  execution schedule).
- **Scenario D** (out of range and back, `nearbyCount` 1→0→1) — does not need the physical
  button; a second peer device (the iPhone) is now on hand. Blocked solely on the paid account.
- **BLE PTT-button pairing flow, the `ptt-pick`/learning half** (§4 of the Android spike hooks
  doc) and **HID key capture** (`cmd keys`) — still blocked: no physical Bluetooth PTT button
  available yet. The `ptt-scan` half was exercised during the 2026-08-14 pass (see Bug found #3)
  and found real nearby BLE devices without a button being present.

## 4. iOS build attempt — 2026-08-15

Hardware on hand changed since the section above was first written: a physical iPhone (iOS 26)
is now available for testing; a physical BLE PTT button is still not. This section covers a
first attempt at getting `ios/Radio` (RadioKit) to actually compile, per `ios/Radio/README.md`'s
"Building it the first time" — the package had never been built before today (written on a
Windows host with no Swift toolchain). This is a build/tooling-readiness check only; no scenario
was run and no Go/No-Go is recorded here.

### Toolchain

A full `Xcode.app` (26.6, build 17F113) was found installed, but `xcode-select` was still
pointed at the bare Command Line Tools, and switching it system-wide needs an interactive sudo
password unavailable in this session. Worked around by invoking
`/Applications/Xcode.app/Contents/Developer/usr/bin/xcodebuild` directly with
`DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer` — equivalent for build purposes,
though anyone continuing this by hand may still want to run
`sudo xcode-select -switch /Applications/Xcode.app/Contents/Developer` once, so plain
`xcodebuild` works without the env var. CocoaPods (`pod install`) had already been run in an
earlier session (`ios/Pods/`, `Podfile.lock`, `Oru.xcworkspace` all pre-existed).

### Package resolution — succeeded

`xcodebuild -resolvePackageDependencies` against `generic/platform=iOS` resolved cleanly:

```
NearbyConnections: https://github.com/google/nearby.git @ main (30bae19)
Opus:              https://github.com/alta/swift-opus.git @ main (6f3cb6b)
BoringSSL-GRPC:    https://github.com/firebase/boringssl-SwiftPM.git @ 0.7.2
abseil:            https://github.com/bourdakos1/abseil-cpp-SwiftPM.git @ jan-lts (ecabd65)
```

One benign warning: `module alias for target 'NearbySSL' ... does not match any recursive
target dependency of product 'openssl_grpc'` — did not affect resolution or block the build.

### Build attempt — `platform=iOS Simulator,name=iPhone 17` (no device signing attempted; no
Apple Developer Team ID is available yet, see below)

First pass failed with exactly the API-drift the README predicted, and nowhere else:

```
OpusCodec.swift:58:17: error: value of type 'Opus.Encoder' has no member 'bitrate'
OpusCodec.swift:58:28: error: cannot infer contextual base in reference to member 'bitrate'
OpusCodec.swift:87:28: error: cannot convert value of type 'Data' to expected argument type 'UnsafeBufferPointer<UInt8>'
```

Checked both against the actual resolved `swift-opus @ main (6f3cb6b)` source
(`Sources/Opus/Opus.Encoder.swift`, `Opus.Decoder.swift`) rather than guessing:

- **Line 87 fixed** (mechanical, no behavior change). `Opus.Decoder` only exposes
  `decode(_ input: UnsafeBufferPointer<UInt8>, to output: AVAudioPCMBuffer)` for decoding into an
  existing (pre-sized) buffer — there is no `Data`-taking overload of that form. Changed
  `OpusCodec.swift`'s `LibopusDecoder.decode(_:)` to wrap the packet with
  `packet.withUnsafeBytes { raw in try decoder.decode(raw.bindMemory(to: UInt8.self), to: buffer) }`.
- **Line 58 left unfixed — a real capability regression, not API drift.** The resolved
  `Opus.Encoder` has no `bitrate` property, no `opus_encoder_ctl` wrapper of any kind, and its
  underlying `OpaquePointer` is not `public` — so nothing outside the `Opus` package can control
  encoder bitrate at all in this version. This is not a rename to adapt to; setting bitrate is
  simply inaccessible through the current public API. Silently deleting the line would let
  libopus fall back to its own internal default bitrate instead of the ~24kbps budget
  `RadioConfig.Audio.bitrate` encodes for the spec's low-bandwidth transport — a real behavioral
  change, not a mechanical fix, so it was left in place and the build left failing here rather
  than guessing at a workaround.

A second build pass after the decode fix confirms this is now the **only** remaining compile
error in the whole package — `grep -c "error:"` on the full build log returns exactly 2 (both on
`OpusCodec.swift:58`), and `NearbyManager.swift` — the other file the README calls out as likely
API-drift territory — compiles with **zero errors** against the resolved `google/nearby @ main`
package.

### Bitrate gap resolved — 2026-08-15 follow-up

Correction to the framing above: checked the *entire* git history of `alta/swift-opus` (both
tags, every commit back to 2022) — `Opus.Encoder.bitrate` never existed at any point. It isn't a
capability that regressed; `OpusCodec.swift` was written against an API that was never real,
unsurprising since the file had never been compiled before this pass.

The real fix doesn't touch `swift-opus` at all. The package's real, unpatched vendored libopus C
source is a second, separate product of the same dependency — `Copus` — and its actual
`opus_encoder_ctl`/`OPUS_SET_BITRATE` C API is fully intact; only the thin hand-written `Opus`
Swift convenience wrapper doesn't expose it. `LibopusEncoder` in `OpusCodec.swift` was rewritten
to talk to `Copus` directly (`opus_encoder_create` / `opus_encoder_ctl(_, OPUS_SET_BITRATE_REQUEST,
_)` / `opus_encode` / `opus_encoder_destroy`), bypassing `Opus.Encoder` for the encode path only —
`LibopusDecoder` is untouched, since decoding never needed bitrate control. No fork, patch, or
package swap; `import Copus` was added to `OpusCodec.swift` (the product is already linked
transitively — `Package.swift`'s `Opus` product bundles both the `Opus` and `Copus` targets).

Rebuilt: `OpusCodec.swift` now compiles with **zero errors**. The overall workspace build still
fails, but only on a single, unrelated pre-existing error surfaced now that compilation gets
past `OpusCodec.swift` —
`NearbyManager.swift:233:83: error: 'nil' is not compatible with closure result type 'any AudioStreamSink'`
— API drift against `google/nearby`'s `main` branch (a moving target per `Package.swift`'s own
comment; this specific line compiled clean on the first build attempt above, so upstream likely
moved between the two passes). Not investigated further today — out of scope for the bitrate fix.
Package tests were not run, since the target still doesn't build end-to-end.

### Workspace builds clean and package tests pass — 2026-08-15 follow-up

Correction to the previous entry: the claim that `OpusCodec.swift` compiled with zero errors was
wrong — the next full rebuild reproduced a real error there too,
`'opus_encoder_ctl' is unavailable: Variadic function is unavailable`. This is not API drift; the
Clang importer marks *every* C variadic function unavailable to Swift, unconditionally, so
`Copus`'s `opus_encoder_ctl(st, request, ...)` was never callable directly from Swift regardless
of which version of the package is resolved. Fix: added a new local SPM target, `OpusShim`
(`ios/Radio/Sources/OpusShim/`), a two-file C shim (`OpusShim.h`/`OpusShim.c`) exposing one
fixed-arity wrapper, `oru_opus_encoder_set_bitrate(OpusEncoder *st, opus_int32 bitrate)`, that
calls the real `opus_encoder_ctl`/`OPUS_SET_BITRATE` from C, where variadic calls are normal.
Declared in `ios/Radio/Package.swift` as a target depending on `Copus` and linked into `RadioKit`;
`OpusCodec.swift` now calls `oru_opus_encoder_set_bitrate` instead. Same rebuild also surfaced two
plain optional-pointer-unwrap errors in `LibopusEncoder.encode` (`opus_encode`'s `pcm`/`data`
parameters import as non-optional pointers; `withUnsafeBytes`'s `.baseAddress` is optional) —
fixed with a `guard let` matching this file's existing style, no behavior change.

With those fixed, the previously-reported `NearbyManager.swift:233` error turned out to be real
but was not the whole story — it was one of three separate, genuine bugs in
`beginAudioStream(streamId:)`, found one at a time as each got fixed and the next surfaced:

1. **`NearbyManager.swift:233`** — confirmed as suspected: a `queue.sync { [self] in ... }`
   closure with one `return sink` (concrete `OutgoingAudioStream`) and two `return nil` branches,
   with no explicit closure signature, was having its result type inferred from the concrete
   `return sink` rather than unified against the function's declared `AudioStreamSink?` return
   type — so `return nil` failed to type-check. Fixed by annotating the closure explicitly:
   `queue.sync { [self] () -> AudioStreamSink? in`. Plain Swift type-checking, unrelated to any
   dependency.
2. **`NearbyManager.swift:238`** — `Stream.getBoundStreams(with:inputStream:outputStream:)` isn't
   the real Foundation signature; it's `withBufferSize:inputStream:outputStream:`. One-word label
   fix, not a dependency issue at all (`Stream` is Foundation).
3. **`NearbyManager.swift:251`** — the real bug behind the original "API drift against
   `google/nearby`" framing, now precisely identified: `manager.send(input, to: targets)` was
   calling the `Data`-payload overload of `ConnectionManager.send` with an `InputStream` argument.
   `NearbyConnections`'s `ConnectionManager` (checked directly against the resolved
   `google/nearby @ main` source, `connections/swift/NearbyConnections/Sources/ConnectionManager.swift`)
   has a distinct method for stream payloads, `startStream(_ stream: InputStream, to:, id:,
   completionHandler:)`, separate from `send(_ data: Data, to:, ...)` for byte payloads. Fixed by
   calling `manager.startStream(input, to: targets) { _ in }` instead — same semantics, correct
   method for a STREAM-type Nearby payload.

Rebuilt after each fix, one error at a time, against the real compiler each time (not guessed).
**`xcodebuild -workspace Oru.xcworkspace -scheme Oru -destination 'platform=iOS
Simulator,name=iPhone 17' build` → `** BUILD SUCCEEDED **`.** The whole `Oru` workspace — app +
RadioKit + both third-party dependencies — now compiles clean end-to-end for the first time.

Package tests: the `Oru` app scheme has no test bundle wired up (`xcodebuild test -scheme Oru`
fails with "no test bundles available to test" — a scheme configuration gap, not investigated
further, out of scope here), and the auto-generated `RadioKit` scheme inside the app workspace
isn't configured for the test action either. Running them via `RadioKit`'s own package workspace
directly instead — `cd ios/Radio && xcodebuild test -scheme RadioKit -destination 'platform=iOS
Simulator,name=iPhone 17'` — works: **`** TEST SUCCEEDED **`, all 26 tests across 5 suites pass**
(`AudioFramingTests`, `ControlMessageTests`, `JitterBufferTests`, `PttBindingTests`,
`RadioEngineTests`) — control-message codec, stream framing, engine state machine, jitter buffer,
and binding persistence, exactly the coverage the README promised.

### Current build-readiness state

RadioKit compiles and its full test suite passes. Nothing left to fix in code for a Phase 0
build — the only remaining blockers are outside the codebase:

- **Apple Developer Team ID resolved, but it's the wrong tier.** After the user added an Apple ID
  in Xcode and created a Development certificate, `DEVELOPMENT_TEAM = J5SLP58ZB6` /
  `CODE_SIGN_STYLE = Automatic` are now set in `project.pbxproj` for the Oru target (Xcode wrote
  these itself on opening the project post sign-in). But `xcodebuild ... -allowProvisioningUpdates
  build` for `generic/platform=iOS` fails with: `Cannot create a iOS App Development provisioning
  profile for "com.oru". Personal development teams, including "Карина Темчур", do not support the
  Push to Talk capability.` This is not a "request the capability" step as assumed earlier — Apple
  flatly excludes Push to Talk from free Personal Team accounts, no exception path. **A paid Apple
  Developer Program enrollment (Individual or Organization, ~$99/yr) on this Apple ID is required**
  before scenarios B and C — or any locked-screen background scenario — can run on real hardware,
  regardless of code correctness. `Oru.entitlements`/`Info.plist` themselves are already correct
  (`com.apple.developer.push-to-talk`, `UIBackgroundModes` including `push-to-talk`/
  `bluetooth-central`) and need no change once the paid account is in place.
- **The `google/nearby` and `alta/swift-opus` dependencies are pinned to floating `main`
  branches** (per `Package.swift`'s own comment, unavoidable from the Windows planning host).
  Today's session already saw one of them shift between two build passes a few hours apart. A
  fresh `xcodebuild -resolvePackageDependencies` at any future point could reintroduce drift
  requiring the same kind of fix documented above.

### Foreground-only smoke check (no PT entitlement) — 2026-08-15 attempt

Since the paid-account blocker above stops any locked-screen scenario, set up a cheaper
intermediate check: does the transport/audio core (Nearby Connections handshake + Opus
encode/decode + playback) work at all with both apps simply open in the foreground — no
push-to-talk entitlement, no background survival claim, not a Phase 0 scenario. This does **not**
satisfy the Phase 0 gate either way; it's groundwork only.

Setup, scoped to avoid disturbing the real (paid-account-ready) config: added
`ios/Oru/Oru-LocalTest.entitlements` — a copy of `Oru.entitlements` with the
`com.apple.developer.push-to-talk` key removed, everything else identical (currently nothing else
to keep, the real file only had that one key). Pointed `CODE_SIGN_ENTITLEMENTS` at this file for
the **Debug configuration only** of the Oru target in `project.pbxproj`; **Release still points at
the real `Oru/Oru.entitlements`**, untouched. To revert once a paid account is active: change
`CODE_SIGN_ENTITLEMENTS = Oru/Oru-LocalTest.entitlements` back to
`CODE_SIGN_ENTITLEMENTS = Oru/Oru.entitlements` in the Debug config block (search
`project.pbxproj` for `Oru-LocalTest`), and optionally delete the local-test entitlements file.

A physical iPhone (12, iOS 26.5.2) is connected to this Mac. First attempt (`xcodebuild
-destination 'platform=iOS,id=00008101-0012141C11FA001E' -allowProvisioningUpdates build`) failed
with `Developer Mode disabled` — the user enabled it on-device (Settings → Privacy & Security →
Developer Mode → reboot → confirm). Second attempt hit a different, unrelated error:
`Failed Registering Bundle Identifier: The app identifier "com.oru" cannot be registered to your
development team because it is not available` — `com.oru` is a globally-unique Apple identifier
already registered elsewhere (not to this Personal Team), so a free account can't claim it, wholly
separate from the Push to Talk restriction. Fixed the same way as the entitlements change: only
the **Debug** `PRODUCT_BUNDLE_IDENTIFIER` was changed, to `com.oru.localtest`; **Release still
builds as `com.oru`**, untouched. Third attempt: **`** BUILD SUCCEEDED **`** — compiled, signed
(`iOS Team Provisioning Profile: com.oru.localtest`), and `xcrun devicectl device install app`
installed it on the phone successfully.

Launch failed, though: `xcrun devicectl device process launch` returned
`Unable to launch com.oru.localtest because it has an invalid code signature, inadequate
entitlements or its profile has not been explicitly trusted by the user.` — the standard
first-run trust prompt every ad-hoc/development-signed app needs once per device, and it can only
be dismissed by the phone's owner tapping through it on-device. Stopped here for today.

**Manual steps left for the user**, in order:

**Update: the iPhone side is done.** After a device-side trust step (Settings → General → VPN &
Device Management → trust the developer certificate), the user tapped the Oru icon directly on
the home screen and the app launched — the first successful run of RadioKit on real iOS hardware
in the project's history. (Launching the same build via `xcrun devicectl device process launch`
kept failing with the same "profile has not been explicitly trusted" error even after trust was
granted in Settings; tapping the icon on-device is the reliable path, CLI launch is not.) This Mac
has no Android SDK/`adb` installed, so the Android half of the steps below runs on the user's
separate Android-configured machine.

1. On the iPhone: **Settings → General → VPN & Device Management** (may show as "Device
   Management" depending on iOS version) → find the developer certificate
   (`karina.temchur@gmail.com` / Apple Development) → tap it → **Trust**. Without this the app
   icon exists on the home screen but refuses to open.
2. Launch it — either tap the Oru icon on the phone, or re-run
   `xcrun devicectl device process launch --device 6491FE1A-0DCA-5938-9781-327B85A279EC
   com.oru.localtest` from this Mac (`DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer`
   set first). If it still refuses, opening `ios/Oru.xcworkspace` in Xcode and pressing Run (▶)
   with the phone selected as destination is the more forgiving fallback for first-launch trust
   issues.
3. On Android, install and drive the DEBUG build per `docs/phase0-android-spike-hooks.md` (adb
   install, permission grants, `am start ... cmd start`) — unchanged from before.
4. Leave both screens **on**, both apps in the **foreground** (the whole point of skipping PT).
5. Watch for a Nearby Connections handshake on both sides: Android via `adb logcat -s OruRadio`
   (watch for a `state` broadcast showing `nearbyCount` go to 1, per the spike hooks doc §3/§5);
   iOS via Console.app filtered to subsystem `com.oru.radio`, `[spike]`-prefixed lines, watching
   for `nearby=1`.
6. Trigger a transmission from the Android side (`adb shell am broadcast ... --es cmd ptt-down`
   then `ptt-up`) and confirm audible playback on the iPhone; there's no BLE button and no PT
   channel to drive a transmission from the iPhone side in this local-test build, so this check is
   one-directional (Android → iPhone) — the reverse direction still needs either the paid account
   (for the PT lock-screen button) or a temporary on-screen trigger that doesn't exist yet in the
   spike hooks.

### Foreground smoke test blocked too — same PT dependency, deeper than expected

The local-test build (no `push-to-talk` entitlement) launched on the iPhone but crashed
immediately: `ERROR: Push-to-Talk API requires the "com.apple.developer.push-to-talk" capability
be added.` followed by `*** Terminating app due to uncaught exception 'com.apple.coreaudio.avfaudio',
reason: 'required condition is false: inputNode != nullptr || outputNode != nullptr'`.

Root cause, confirmed by reading the actual code: `AudioEngine.swift`'s `startPlayback()` only
sets the `AVAudioSession` category — it deliberately never calls `setActive(true)` itself (a
comment there explains why: `"activating it from the app is what kills locked playback"`).
Session activation happens **only** as a side effect of `PTChannelManager` successfully joining a
channel, in `BackgroundManager.swift`'s `channelManager(_:didActivate:)` delegate callback. With
no PT entitlement, `PTChannelManager.channelManager(delegate:restorationDelegate:)` fails, the
session is never activated, and any subsequent AVAudioEngine I/O access (attaching a player node,
starting the engine) crashes hard — uncaught.

This means the foreground-only smoke test plan doesn't actually work: it's not just the
locked-screen scenarios that need the PT entitlement, **no audio can flow at all, foreground or
not**, without it. The Nearby Connections handshake itself is unaffected by this (transport and
audio session are independent), but there's no way to hear anything without PT.

Two options were on the table: (a) wait for the paid Apple Developer Program enrollment, or
(b) add a debug-only fallback that manually activates the session when PT setup fails, scoped
tightly enough not to touch the real PT-driven path. **Decided (2026-08-16): wait for the paid
account (option a).** No debug-only audio-session workaround will be built. No workaround has
been added; `Oru-LocalTest.entitlements` / `com.oru.localtest` bundle id remain in the tree
(Debug config only, Release untouched), unused, and can be deleted once the paid account is
active and the local-test path is no longer needed.

Separately worth flagging, not fixed today: this crash is an uncaught-exception hard-crash on any
`PTChannelManager` setup failure, not just the "no entitlement" case tested here. A production
build with a real entitlement could still hit a transient PT failure (network issue during
channel join, etc.) and would crash the same way today rather than degrading gracefully. Worth
a real fix at some point, out of scope for Phase 0.

## 5. Android emulator pass — 2026-08-17

No physical devices were available for this pass (Windows host, Android Studio emulators only).
Scope: re-run `docs/phase0-android-spike-hooks.md` §§1-3 on a stock Google emulator image (the
first time these hooks ran on anything other than the physical ColorOS OPPO), plus whatever
transport validation was possible without a second physical device. **This section does not
change the Go/No-Go status** — that is still open, still gated on scenarios A-D against a real
Android + iPhone pair per the spec.

**Device:** `Medium_Phone` AVD, API 37.1 (`sdk_gphone16k_x86_64`), Google APIs PlayStore, 16KB
page size, x86_64, booted via `emulator -avd Medium_Phone`.

### Bug found #4 — debug build defaults to arm64-v8a only; crashes outright on an x86_64 emulator (build/tooling defect)

`pnpm build:android` (`scripts/build-android.js`) passes `-PreactNativeArchitectures=arm64-v8a`
unless `RN_ARCHS` is set — a sensible default for the arm64 physical devices used so far, but the
resulting APK (`android/app/build/outputs/apk/debug/app-debug.apk`, confirmed via
`unzip -l | grep lib/`) contains **only** `lib/arm64-v8a/*.so`. Installed on this x86_64 emulator,
the app force-closed on first launch:

```
FATAL EXCEPTION: main
com.facebook.soloader.SoLoaderDSONotFoundError: couldn't find DSO to load: libreactnative.so
  at com.facebook.react.internal.featureflags.ReactNativeFeatureFlagsCxxInterop.<clinit>
  at com.oru.MainApplication.onCreate(MainApplication.kt:25)
```

Root cause confirmed directly (not guessed): `gradle.properties` already lists all four ABIs
(`reactNativeArchitectures=armeabi-v7a,arm64-v8a,x86,x86_64`), but `build-android.js`'s own
`RN_ARCHS` default (`'arm64-v8a'`, used for the `-P` override that wins over `gradle.properties`)
overrides it. A stale `android/app/build/outputs`/`intermediates/merged_native_libs` from an
earlier arm64-only build also had to be removed by hand once — Gradle's up-to-date check on
`:app:mergeDebugNativeLibs`/`:app:packageDebug` did not notice that :opus had just produced fresh
x86_64 native libs in the same invocation and kept the stale arm64-only package.

**Fix applied.** Rebuilt with `RN_ARCHS=x86_64 pnpm build:android` (confirmed via `unzip -l` that
the resulting APK contains only `lib/x86_64/*.so`, including `libreactnative.so`); installed
cleanly and launched without crashing. Documented in `docs/phase0-android-spike-hooks.md` (new
paragraph under "Install first"). Not changed: `build-android.js`'s default itself, or
`RN_ARCHS`'s default value — that's a product decision (multi-ABI debug APKs build slower) out of
scope for a spike bug-fix, so this is recorded as a documented workaround, not silently patched.

### §§1-3 smoke pass — clean, no regressions

Permissions (§1) granted with plain `adb shell pm grant` with no OEM restriction this time (the
ColorOS shell-grant restriction from the original report's §1 is device-specific, not something
this stock Google image reproduces). `dumpsys package com.oru` confirmed all seven permissions
`granted=true`.

Start/stop (§2), twice: both cycles logged the same `starting`→`ready` sequence as the original
physical-device pass, `RadioForegroundService` came up with a real notification
(`dumpsys activity services com.oru` showed `isForeground=true`), and both stops tore it down
cleanly (`dumpsys activity services com.oru` → `(nothing)`).

Broadcast commands (§3): `state`/`ptt-down`/`ptt-up`/`stop` via
`adb shell am broadcast -n com.oru/com.oru.radio.SpikeReceiver` all reached `SpikeReceiver` and
logged responses — Bug #2 (`SpikeReceiver` non-exported) from the original report has not
regressed.

Screen-lock survival: `adb shell input keyevent 26` (power button) put the emulator into
`mWakefulness=Asleep`; 10s later `RadioForegroundService` and the `com.oru` process (stable pid)
were still alive per `dumpsys activity services`/`ps`, `nearbyCount` was still `1` (see below) the
whole time, and after waking the screen back up a `state` broadcast still worked normally and
`stop` tore the service down cleanly.

### Unplanned finding — a real Android-to-Android Nearby Connections handshake happened

No second device was deliberately involved in this pass, but `nearbyCount` went to `1` within 4
seconds of `start`. Logcat traced this to a real peer, not self-discovery (the local endpoint's
own advertisement is explicitly ignored: `"WIFI_LAN discovered service IlSMOUtzhKsAAA, but that's
us. Ignoring."`). The actual discovered service resolved to a real LAN address, not an emulator
NAT address:

```
NearbyMediums: WIFI_LAN discovered service name:IlZKN01zhKsAAA type:._7384AB769DDA._tcp at ip:/192.168.1.172 port:63887
NearbyConnections: Found WifiLanServiceInfo IlZKN01zhKsAAA (with EndpointId VJ7M / EndpointInfo [ 0x43 0x50 0x48 0x32 0x37 0x34 0x37 ] / AP frequency 5180)
```

`EndpointInfo` bytes `43 50 48 32 37 34 37` decode as ASCII `CPH2747` — the physical OPPO CPH2747
from the 2026-08-14/15 physical-device passes, apparently still powered on with the radio running
and reachable on the same real Wi-Fi LAN this host is on. The emulator's `WIFI_LAN` medium bridges
through to the host's real network (this is why it worked — not a general emulator capability, and
**not** the medium the real outdoor cycling deployment will actually have available, since two
riders on the road share no common Wi-Fi LAN — see the spec's group-cycling use case). This is the first
real Android-to-Android Nearby Connections handshake observed in this project, even if accidental.

A full transmit cycle was driven from the emulator side and confirmed via `state`, the same way
the spike hooks doc recommends confirming scenario B/C objectively rather than by ear:

```
state={..., transmitting=false, ...}   (before)
ptt-down
state={..., transmitting=true,  ...}   (held)
ptt-up
state={..., transmitting=false, ...}   (after)
```

`nearbyCount` stayed `1` throughout. **Not confirmed:** whether the physical OPPO actually played
audio — this session has no access to that device (screen, logs, or adb; it never appeared in
`adb devices`, since Nearby Connections' own networking is unrelated to adb-over-Wi-Fi). This
validates the local engine + transport + encode path against a real remote peer, not end-to-end
audio delivery.

### Bug found #5 — Nearby rediscovery silently and permanently stalls once the app has been backgrounded, because `ACCESS_BACKGROUND_LOCATION` is never requested (real product/code defect, directly threatens R1)

Attempted a scenario-D-like check using only the emulator (`adb shell svc wifi disable`, wait,
`adb shell svc wifi enable`), expecting `nearbyCount` to drop to `0` and recover to `1` per §5's
description of scenario D. It dropped to `0` immediately as expected — but **never recovered**,
polled for over 2.5 minutes, even though the underlying medium clearly still worked:

```
NearbyMediums: Successfully started Wifi LAN discovery for serviceID com.oru.radio.
NearbyConnections: Found WifiLanServiceInfo IlZKN01zhKsAAA (with EndpointId VJ7M ...)   <- peer re-found
NearbyConnections: ClientProxy(143174641) delaying onEndpointFound(VJ7M) because the client does not have location permission currently.
...
NearbyConnections: ClientProxy(143174641) ignoring onEndpointLost(VJ7M) because we haven't reported it
```

Root cause, confirmed via `adb shell appops get com.oru`, not guessed: `ACCESS_FINE_LOCATION`'s
op-mode is `foreground` (the normal runtime-grant mode — `AndroidManifest.xml` never declares
`ACCESS_BACKGROUND_LOCATION`, and `RadioForegroundService`'s declared
`foregroundServiceType="microphone|connectedDevice"` does not include `location`, which is what
Android's location appops enforcement actually keys "foreground" off once no Activity is visible).
`appops get` showed a live `rejectTime` timestamp once the app had been backgrounded a few
minutes:

```
FINE_LOCATION: allow; time=+6m52s253ms ago; rejectTime=+1m42s474ms ago
```

Once Nearby's own internal permission check hits that rejection, it withholds `onEndpointFound`
for that endpoint indefinitely — confirmed the withholding is not transient by polling `state`
every ~10s for 165+ seconds with no recovery, all while the WIFI_LAN medium kept successfully
re-discovering the same peer's service record in the background (proving the medium/network path
was fine; only the app-level permission gate was stuck). Confirmed the fix is a full radio
restart, not time: `cmd stop` + `cmd start` (i.e. briefly bringing `SpikeActivity` to the
foreground again) reset the appops foreground grant and `nearbyCount` recovered to `1` within 4
seconds.

**This was not fixed here** — requesting `ACCESS_BACKGROUND_LOCATION` is a real product decision
(Play Store data-safety disclosure, a "Prominent Disclosure" consent flow, an extra permission
prompt in onboarding), not a mechanical manifest tweak like Bugs #1-3, so it needs a call from
whoever owns P7's onboarding/permissions work, not a silent fix mid-spike. **Why this matters for
the Go/No-Go gate specifically:** the target use case is a locked, pocketed phone for a
ride-length session (locked, pocketed phone; see the spec's group-cycling use case) — exactly the condition that starves this app
of the foreground grant. Scenario D's "out of range and back... with no restart" requirement (§15)
may be untestable as specified without this fix, and the effect is silent: `status` stays `ready`,
no error is raised, `nearbyCount` just never comes back. Recommend adding this to the spec's open
questions for whoever runs the real scenario D pass, and treating a stuck `nearbyCount` after a
long locked-screen stretch as this bug rather than a fresh one if it recurs during real Phase 0
testing.

### Bug #5 follow-up — 2026-08-17: `ACCESS_BACKGROUND_LOCATION` added; partially verified, and a second, independent bug surfaced

**User decision (2026-08-17):** add `ACCESS_BACKGROUND_LOCATION` now, accepting the Play Store
Data Safety disclosure and "Allow all the time" consent-flow cost. Added to
`android/app/src/main/AndroidManifest.xml` with a comment pointing at this bug. Rebuilt
(`RN_ARCHS=x86_64 pnpm build:android`), reinstalled on `Medium_Phone`, granted via plain
`adb shell pm grant com.oru android.permission.ACCESS_BACKGROUND_LOCATION` — `dumpsys package
com.oru` confirmed `granted=true` immediately (no special grant path needed on this emulator/API
level).

**The specific mechanism Bug #5 described did not recur.** Started the radio (physical OPPO
CPH2747, still reachable on the same LAN, brought `nearbyCount` to `1` again), pressed HOME to
remove the last visible Activity, and polled `appops get`/`state` every 80s for 8 minutes
backgrounded. `nearbyCount` stayed `1` the entire time, and `FINE_LOCATION`'s `rejectTime` in
`appops get` never advanced from its old (pre-fix) value — no fresh rejection occurred, and no
`"delaying onEndpointFound(...) because the client does not have location permission currently"`
line appeared anywhere in logcat. That is the exact symptom the original bug produced, and it did
not happen this time.

**But the original repro (`svc wifi disable` / `svc wifi enable`) still did not recover, for a
different, confirmed reason — logged as a new bug, not this one.** `nearbyCount` dropped to `0` on
disable as before. After re-enabling Wi-Fi, it never recovered — polled for 3 minutes, then a full
`cmd stop`/`cmd start` engine restart, then another ~30s, still `0` throughout. This time there was
no location-permission log line at all. The actual cause, found in logcat right at the Wi-Fi
re-enable timestamp:

```
11:07:35.461 W NearbyMediums: MEDIUM_ERROR [DEVICE][WIFI_LAN][START_ADVERTISING][MEDIUM_NOT_AVAILABLE][WITHOUT_CONNECTED_WIFI_NETWORK], service-id=com.oru.radio
11:07:38.854 ... SUPPLICANT_STATE_CHANGE_EVENT ... state: COMPLETED   (Wi-Fi association finished 3.4s later)
```

Nearby Connections tried to restart `WIFI_LAN` advertising/discovery the instant it saw the Wi-Fi
radio come back on, lost the race against the STA interface actually finishing association, failed
with `MEDIUM_NOT_AVAILABLE`, and — as far as logcat shows for the following 3+ minutes of a fully
reconnected, pingable network (`ping 192.168.1.172` from the emulator succeeded, confirming the
physical OPPO peer was never the problem) — never retried. `grep`ing the whole session's log for
`startDiscovery`/`startAdvertising`/`NsdManager` found no matching lines at all (the library logs
these at a level/tag this build doesn't surface), so the retry-or-not conclusion rests on the
absence of any further `WifiLanServiceInfo`/discovery-related `NearbyMediums` line after the single
`MEDIUM_NOT_AVAILABLE` failure, not a direct "gave up" log line. **This means the Wi-Fi-toggle
repro is not a clean test of Bug #5 specifically** — it now fails via an unrelated race condition
before it can even exercise the location-gate path this bug was about, so this pass cannot fully
confirm or deny Bug #5 is fixed under that exact repro. The 8-minute backgrounded-idle test above
is the cleaner signal for Bug #5 itself, and it was clean.

**Not investigated further here** (out of scope for a manifest-permission follow-up, and a
one-shot fork budget): whether `NearbyManager.kt` has its own Wi-Fi-state-change listener that
should be retrying `startAdvertising()`/`startDiscovery()` on `MEDIUM_NOT_AVAILABLE` and isn't, or
whether this is entirely internal to the closed-source Nearby Connections library with no
app-level fix available. Recommend logging this as **Bug #6** for whoever picks up scenario D
work: a Wi-Fi radio bounce (real-world equivalent: airplane mode toggle, or the OS briefly tearing
down Wi-Fi to save power) can permanently kill `WIFI_LAN` rediscovery until a full engine restart —
and on this pass, not even a restart recovered it within ~30s, worth a longer post-restart
observation window before concluding restart still works as a fallback. This is a second,
independent threat to spec §15 scenario D on top of Bug #5, discovered by accident while verifying
Bug #5's fix.

### Bug #6 follow-up — 2026-08-17: root-caused, and the original root cause was wrong. `MEDIUM_NOT_AVAILABLE` self-heals in 6 s; the real mechanism is Nearby's own 300-second low-power discovery switch. No code fix written, deliberately

**Environment caveat, stated first because it bounds every claim below.** The physical OPPO
CPH2747 that played the peer in every earlier pass is off the LAN today:

```
$ ~/bin/adb shell ping -c 3 192.168.1.172
3 packets transmitted, 0 received, 100% packet loss, time 2055ms
$ ping -n 3 192.168.1.172          # from the Windows host itself
Reply from 192.168.1.88: Destination host unreachable.
```

So `nearbyCount` never left `0` in this pass and **no end-to-end "`nearbyCount` recovers to 1"
claim is made here**. Everything below is established one layer lower, at the medium layer, from
`NearbyMediums` / `NearbyConnections` / `serviceDiscovery` logcat and `dumpsys servicediscovery` —
which is where the mechanism actually lives and which needs no second device. Synthesising a peer
was attempted and failed: a Nearby-shaped mDNS record (`_7384AB769DDA._tcp`, TXT keys copied
verbatim from the emulator's own `[MdnsAdvertiser]` line) published from the host with
`bonjour-service` was visible to a host-side browse — which also saw the *emulator's real
advertisement* at `10.0.2.16`, so guest→host multicast works — but `dumpsys servicediscovery` on
the emulator only ever listed the emulator's own record (`foundServices 2` = its own, found twice),
so host→guest mDNS multicast does not reach this AVD in the current network setup.

**Finding 1 — the `MEDIUM_NOT_AVAILABLE` race is real, and it self-heals in under six seconds with
no app involvement.** Same repro as the original: `cmd start` at `13:08:30`, `adb shell svc wifi
disable` at `13:09:19`, `adb shell svc wifi enable` at `13:09:50`, one continuous `adb logcat -v
time` capture throughout:

```
13:09:20.093 I NearbyConnections: Trigger updateAdvertisingOptions per wifi status changed.
13:09:20.103 I serviceDiscovery: [MdnsDiscoveryManager] Unregistering listener for serviceType:_7384AB769DDA._tcp.local
13:09:51.151 W NearbyMediums: MEDIUM_ERROR [DEVICE][WIFI_LAN][START_ADVERTISING][MEDIUM_NOT_AVAILABLE][WITHOUT_CONNECTED_WIFI_NETWORK], service-id=com.oru.radio
13:09:51.155 W NearbyMediums: MEDIUM_ERROR [DEVICE][WIFI_LAN][START_DISCOVERING][MEDIUM_NOT_AVAILABLE][WITHOUT_CONNECTED_WIFI_NETWORK], service-id=com.oru.radio
13:09:54.699 I wpa_supplicant: wlan0: CTRL-EVENT-CONNECTED - Connection to 00:13:10:85:fe:01 completed
13:09:56.457 I NearbyMediums: WifiNetwork defaultNetworkCallback onAvailable netId:105
13:09:56.977 I NearbyMediums: WIFI_LAN registered service name:IlFSQzBzhKsAAA type:null at ip:null port:0
13:09:56.982 I NearbyMediums: Successfully started Wifi LAN discovery for serviceID com.oru.radio.
13:09:57.095 I NearbyMediums: WIFI_LAN discovered service IlFSQzBzhKsAAA, but that's us. Ignoring.
```

`WIFI_LAN` was fully back **5.83 s** after the failure and **0.52 s** after GMS's *own*
`WifiNetwork defaultNetworkCallback onAvailable` fired. The last line is the device receiving its
own freshly re-published mDNS record back off the network, i.e. both halves of the medium were
live again. No `MEDIUM_ERROR` recurred for the next six minutes. The original entry's "never
retried" was a false negative — the retry is logged under `NearbyMediums` at `I`, and it happens
after the 3.4 s association gap the original entry (correctly) measured but (incorrectly) read as
terminal.

**So the fix proposed in the previous entry — a `ConnectivityManager.NetworkCallback` in
`NearbyManager` that waits for Wi-Fi to settle and then force-cycles
`stopAdvertising()`+`startAdvertising()` / `stopDiscovery()`+`startDiscovery()` — is the wrong
fix and was not built.** It would duplicate a mechanism GMS already owns and race it, for no gain.

**Finding 2 — what actually leaves `WIFI_LAN` permanently deaf: Nearby's own low-power discovery
switch, exactly 300 s after `startDiscovery`.** It fired twice in this session, both times with
nothing else happening on the device:

```
13:08:33.710 I NearbyMediums: Successfully started Wifi LAN discovery for serviceID com.oru.radio.
   ...
13:13:33.715 I NearbyConnections: Trigger discovery switches for service id : com.oru.radio
13:13:33.722 I NearbyMediums: Stopped BLE scanning, service-id=com.oru.radio
13:13:33.724 I serviceDiscovery: [MdnsDiscoveryManager] Unregistering listener for serviceType:_7384AB769DDA._tcp.local
13:13:33.725 I NearbyMediums: Stopped Wifi LAN discovery.
13:13:33.764 I NearbyMediums: Started BLE scanning, service-id=com.oru.radio, is-extended-advert=true, power-level=1, scan-mode=low-power
```

and again after the restart in Finding 4:

```
13:16:07.271 I NearbyMediums: Successfully started Wifi LAN discovery for serviceID com.oru.radio.
13:21:07.274 I NearbyConnections: Trigger discovery switches for service id : com.oru.radio
13:21:07.284 I NearbyMediums: Stopped Wifi LAN discovery.
13:21:07.292 I NearbyMediums: Started BLE scanning, service-id=com.oru.radio, is-extended-advert=true, power-level=1, scan-mode=low-power
```

300.005 s and 300.003 s after the preceding `Successfully started Wifi LAN discovery` — a fixed
five-minute timer, not a reaction to anything the app or the network did. BLE scanning is dropped
from `power-level=3, scan-mode=low-latency` to `power-level=1, scan-mode=low-power` and restarted;
`WIFI_LAN` discovery is stopped and **not** restarted. Advertising is untouched.
`adb shell dumpsys servicediscovery` at `13:23:56`, after the second switch, shows the asymmetry
directly — one `Advertiser` and no discovery listener at all for GMS:

```
  mUid 10223, mPid 1406, mPackageName com.google.android.gms, ... mClientRequests:
    22: Advertiser: serviceFullName=IlFSQzBzhKsAAA._7384AB769DDA._tcp, net=null {26, startTime 2026-08-17T13:16:06.323834 ...}
```

(the same dump taken at `13:20:3x`, before the switch, additionally listed
`23: Discovery/DiscoveryListener: serviceType=_7384AB769DDA._tcp.local ... foundServices 2, sentQueries 7`).

This one is corroborated in the open-source implementation the GMS one derives from
(`google/nearby`, `P2pClusterPcpHandler::UpdateDiscoveryOptionsImpl`): when `low_power` is turned
on it calls `WifiLan().StopDiscovery(service_id)` and there is no branch anywhere in that method
that starts `WIFI_LAN` discovery again, so it is dropped for the remainder of the discovery
session; BLE scanning is restarted with the new low-power setting, and advertising is not touched.

**Finding 3 — once that switch has fired, a Wi-Fi bounce restores advertising only. Discovery
stays dead.** Second bounce, deliberately run *after* the `13:21:07` switch:

```
13:25:34.960 I BUG6          : R3 wifi enable
13:25:35.903 W NearbyMediums : MEDIUM_ERROR [DEVICE][WIFI_LAN][START_ADVERTISING][MEDIUM_NOT_AVAILABLE][WITHOUT_CONNECTED_WIFI_NETWORK], service-id=com.oru.radio
13:25:40.910 I serviceDiscovery: [MdnsAdvertiser] Adding service name: IlFSQzBzhKsAAA, type: _7384AB769DDA._tcp, ... with ID 28
13:25:41.131 I NearbyMediums : WifiNetwork defaultNetworkCallback onAvailable netId:106
```

Only `START_ADVERTISING` failed this time — there was no `WIFI_LAN` discovery left to fail — and
advertising self-healed again ~5 s later. Grepping the capture from the bounce to `13:36:36`
(11 minutes) for `Successfully started Wifi LAN discovery`, `[MdnsDiscoveryManager] Registering
listener for serviceType: _7384AB769DDA` and `Trigger discovery switches` returns **nothing at
all** — discovery never came back, and no further switch cycle fired either, so the degradation is
a one-way drop rather than a rotation. `dumpsys servicediscovery` at `13:32:05`, 6.4 minutes after
the bounce, shows the same one-sided state — the advertiser is the one re-registered by the bounce
(`startTime ... 13:25:40`), and there is still no discovery listener:

```
  mUid 10223, mPid 1406, mPackageName com.google.android.gms, ... mClientRequests:
    24: Advertiser: serviceFullName=IlFSQzBzhKsAAA._7384AB769DDA._tcp, net=null {28, startTime 2026-08-17T13:25:40.91061 ...}
```

BLE scanning was neither stopped nor restarted by the bounce; it is still running from `13:21:07`
at `power-level=1, scan-mode=low-power`. **The device stays findable and becomes unable to find.**

**That composition is the whole of Bug #6.** On this emulator `WIFI_LAN` is the only medium that
can physically reach the OPPO (emulated BLE does not reach a real phone), so once the 300 s switch
has fired, `nearbyCount` can never return to `1` however long you poll or however many times you
bounce Wi-Fi — exactly what the original entry observed, and mis-attributed to the
`MEDIUM_NOT_AVAILABLE` line that happened to sit next to it in the log. The original repro simply
crossed the 300 s mark before the bounce; the earlier Bug #5 pass, where the peer *was* re-found
over `WIFI_LAN` after the same bounce (`Found WifiLanServiceInfo IlZKN01zhKsAAA`), ran inside it.

**Finding 4 — a full radio restart does recover it, answering the previous entry's open question.**
`cmd stop` at `13:15:56`, `cmd start` at `13:16:04`:

```
13:15:56.613 I OruRadio     : spike: radio stopped
13:16:05.016 I OruRadio     : spike: radio starting
13:16:07.216 I NearbyMediums: Successfully advertised IlFSQzBzhKsAAA on serviceID com.oru.radio over Wifi LAN.
13:16:07.255 I NearbyMediums: Started BLE scanning, service-id=com.oru.radio, is-extended-advert=true, power-level=3, scan-mode=low-latency
13:16:07.271 I NearbyMediums: Successfully started Wifi LAN discovery for serviceID com.oru.radio.
```

Full high-power state back 2.2 s after `cmd start`, and it held for the whole five minutes until
the next switch removed `WIFI_LAN` again at `13:21:07`. So a restart is a reliable fallback, and
its effect lasts exactly one 300-second window — the previous entry's "not even a restart recovered
it within ~30 s" was measuring the wrong signal (`nearbyCount`, which needs a peer) rather than the
medium.

**Not fixed, and that is the recommendation, not an omission.** The only client-side reset for the
low-power switch is `stopDiscovery()` + `startDiscovery()`: `javap` on the pinned
`play-services-nearby:19.4.0` AAR (`~/.gradle/caches/.../play-services-nearby-19.4.0.aar`) shows
`ConnectionsClient` exposes only `startDiscovery`/`stopDiscovery`/`startAdvertising`/
`stopAdvertising` with no `updateDiscoveryOptions`, and `DiscoveryOptions.Builder` has only
`setStrategy(Strategy)` and `setLowPower(boolean)` — nothing that opts out of the switch. The
candidate fix is therefore a periodic `stopDiscovery()`+`startDiscovery()` in `NearbyManager` (say
every ~4 minutes while `handshaked` is empty) to keep resetting the 300 s window. **It was not
built**, for two reasons that both point the same way:

- **It cannot be verified here.** With no peer on the LAN, there is no `nearbyCount` to watch
  recover, so any such change would ship on a medium-layer log line and an argument — which is how
  the original wrong root cause got recorded in the first place.
- **It is a battery decision, not a bug fix.** It deliberately defeats Nearby's own power
  management on a locked, pocketed phone for a ride-length session (the group-cycling use case),
  and outdoors — where two riders share no Wi-Fi LAN — the medium it rescues is the *irrelevant*
  one. What matters on the road is BLE, and BLE keeps scanning after the switch; it only drops from
  `low-latency` to `low-power`, so rediscovery gets slower, not impossible. Whether that slowdown
  actually breaks scenario D is **unmeasured** and is precisely what the real two-device pass is
  for.

**Recommendation for whoever runs the real scenario D pass:** measure rediscovery latency after a
peer has been away for more than five minutes (the switch will have fired), and only if that
latency is unacceptable, evaluate the periodic-refresh change with battery measured alongside it.
Separately, and independently of any product decision: **emulator-based transport checks are only
valid inside a five-minute window from `cmd start`** — past that, `WIFI_LAN` discovery is gone and
the emulator will look permanently broken when nothing is wrong with the app. That is worth
knowing before anyone re-runs the Wi-Fi-toggle repro.

## Status (repeated)

**No Go/No-Go decision has been made.** This report documents pre-gate smoke testing, bug fixes,
and (as of 2026-08-15) a from-scratch iOS build/test pass — RadioKit now compiles end-to-end,
its full unit test suite passes on the simulator, and it has now run for the first time on real
iOS hardware (launch only; see below for why audio doesn't work yet). The actual Phase 0 gate
(scenarios A–D on physical Android + iPhone, per the spec) — and, it turns out, *any* audio at
all, even a same-room foreground check — is blocked on one single thing: **a paid Apple Developer
Program enrollment** (the free Personal Team on hand explicitly cannot hold the push-to-talk
entitlement, and the app's audio session is only ever activated as a side effect of PushToTalk
successfully joining a channel — see the subsection above). For scenario C specifically, a
physical BLE PTT button will also be needed, but that's secondary to the account blocker.
**Decided (2026-08-16): wait for the paid Apple Developer Program enrollment** rather than build a
debug-only audio-session workaround. **Revisited (2026-08-17): the user chose to build the
debug-only workaround after all** — see the new section immediately below. The Nearby Connections
handshake itself (transport layer, independent of audio/PT) can still be exercised and observed
between the two devices in the meantime — that part of the pipeline doesn't depend on PT, and is
being checked separately on the Android side right now.

## Local-test debug workaround, and two real crash bugs found — 2026-08-17

The 2026-08-16 decision above (wait for the paid account) was revisited and reversed: the user
chose to build the debug-only audio-session workaround instead. Iterated entirely on the physical
iPhone 12 (iOS 26.6) already on hand, via `ios/Oru/Oru-LocalTest.entitlements` /
`com.oru.localtest` (from the 2026-08-15 session).

**`BackgroundManager.swift`** now skips `PTChannelManager` entirely in `#if DEBUG` builds instead
of calling it and reacting to its failure: calling it without the push-to-talk entitlement does
not fail with a Swift-catchable error on this iOS version — several attempts at reacting to a
`catch` block around it changed nothing, because the failure exits before any `try`/`catch` in
this app ever runs. `activate()`/`deactivate()` now call the `BackgroundSessionDelegate` callbacks
directly in DEBUG without touching `AVAudioSession` themselves (that responsibility moved to
`AudioEngine`, below, to keep category-then-activate ordering correct). Mic permission
(`AVAudioSession.recordPermission`) was also `.undetermined` on this fresh bundle id;
`AudioEngine.swift` now blocks once, synchronously, on `requestRecordPermission` before touching
the engine (`awaitRecordPermissionIfUndetermined`) if so — the user granted it via the resulting
system dialog.

None of that, by itself, stopped the app from crashing at launch with `*** Terminating app due to
uncaught exception 'com.apple.coreaudio.avfaudio', reason: 'required condition is false: inputNode
!= nullptr || outputNode != nullptr'` in `-[AVAudioEngine prepare]`. Seven independent fix
attempts around session category/activation ordering and thread (main vs. background queue) all
reproduced the identical crash — confirmed via on-device `.ips` crash reports, which this iOS
version ships with real symbols for a Debug build, no `atos` needed. An Opus-model advisory pass
(not a build attempt — pure code reading) found the actual cause:

- **Bug: `AVAudioEngine` creates its I/O nodes lazily**, on first access to `inputNode`,
  `outputNode`, or `mainMixerNode` — `AVAudioEngine()`'s initializer leaves the graph empty, and
  `prepare()`/`start()` both assert at least one I/O node exists before doing anything else,
  independent of session state. Every other call path into this engine
  (`beginIncoming`→`mainMixerNode`, `startCapture`→`inputNode`) already touched a node before ever
  calling `start()` and never crashed; `AudioEngine.swift`'s `startPlayback()` was the one path
  that called `prepare()` without touching a node first. **Fixed unconditionally** (not a
  local-test-only workaround — this would crash a Release `com.oru` build identically): touch
  `engine.inputNode` and `engine.mainMixerNode` before `engine.prepare()`.

With that fixed, the app got much further — launched cleanly, set up audio, and reached Nearby
Connections, which discovered a real peer over WiFi-Lan and began a secure `UKey2Handshake` — then
died ~14s in with a different, unrelated crash: `EXC_BAD_ACCESS` / `SIGKILL` /
`KERN_PROTECTION_FAILURE`, `termination.namespace = CODESIGNING`, `indicator = "Invalid Page"`,
inside BoringSSL's `OPENSSL_free`→`sdallocx`, called from
`securemessage::CryptoOps::GenerateEcP256KeyPair()`. A second Opus-model pass root-caused this
precisely, down to fault-address arithmetic:

- **Bug: a weak-symbol collision between BoringSSL and React Native's prebuilt dependencies.**
  `firebase/boringssl-SwiftPM` (pulled in transitively via `google/nearby`) declares `sdallocx` as
  a *weak* symbol that falls back to `free()`. React Native's prebuilt
  `ReactNativeDependencies.framework` separately exports a *strong* `sdallocx` — folly's
  jemalloc-detection shim, a null `__DATA,__common` function-pointer variable, never actually
  called on Apple platforms since `folly::usingJEMalloc()` is always false there. dyld's
  weak-symbol coalescing prefers the strong definition process-wide, so BoringSSL's own internal
  `OPENSSL_free` call bound to folly's non-executable data page instead of running code; the fault
  address matched that framework's page-aligned base address exactly. The CocoaPods flavor of this
  same BoringSSL guards against exactly this class of collision by prefixing its symbols
  (`GRPC_SHADOW_*`); the SwiftPM flavor resolved here ships that defense commented out. **Fixed**
  with a new local SPM target, `ios/Radio/Sources/MallocCompatShim/` (mirrors the existing
  `OpusShim` pattern), providing a real, strong `sdallocx` definition and wired as a dependency of
  `RadioKit` in `Package.swift` — confirmed at the binary level with `nm -m` (the app image's
  `_sdallocx` moved from `weak external` in `__DATA,__common` to a plain `external` symbol in
  `__TEXT,__text`) and by a live run that survived 115+ seconds with no crash, well past the
  previous ~14s failure point.

**Current blocker, transport layer.** The run that proved the `sdallocx` fix didn't reach the
handshake again — Nearby Connections found a peer (`endpoint_id=VJ7M`, WiFi-Lan, service id
`com.oru.radio`) but `RequestConnection` failed three times with
`Error Domain=com.google.nearby.network.error Code=1`, which the resolved `google/nearby` source
decodes as `GNCNWFrameworkErrorTimedOut` — its own internal 4-second connection timeout firing, not
a distinct Apple-level error. In the same run, CoreBluetooth's peripheral manager stayed stuck at
`CBManagerStateUnknown` for a full 12 seconds (it normally resolves near-instantly) before an
internal timeout gave up, and no BLE-medium peer was ever found either. Neither result is
conclusive on its own, but both are the classic signature of an **unanswered iOS system
permission dialog** — Local Network (`NSLocalNetworkUsageDescription`) and/or Bluetooth
(`NSBluetoothAlwaysUsageDescription`), both already declared in `Info.plist` — sitting on the
device's screen with nobody there to tap it. There is no CLI/`devicectl` way to read an app's
actual TCC/privacy grant state on a non-jailbroken device to confirm this directly.

A follow-up diagnostic (uninstalling and reinstalling the app via `devicectl`, to test whether the
discovered peer was a stale/self-referential mDNS record left over from earlier crash cycles)
backfired: the app now refuses to launch at all with `"invalid code signature, inadequate
entitlements or its profile has not been explicitly trusted"` — the standard first-run
developer-certificate trust prompt (per `Settings > General > VPN & Device Management`) has to be
answered again, exactly as it did the first time this build ever ran on this phone
(2026-08-15). **Needs the user physically at the device**: re-trust the certificate, then check for
and answer the Local Network / Bluetooth permission prompts, before iOS-side investigation can
continue.

**Android, separately**: the user installed Android Studio on this same Mac (previously all
Android work happened on a separate Windows machine). SDK/NDK/build-tools resolved automatically
on first `pnpm build:android` run (NDK/CMake downloaded fresh, per the execution schedule's own
documented first-run caveat) and the build succeeded, producing a working debug APK — this Mac can
now build the Android side end-to-end. One real, general config bug was found and fixed along the
way (not Mac-specific — would break on any machine with a modern pnpm, Windows included):
`.npmrc`'s `node-linker=hoisted` is silently ignored by pnpm 11.x (`pnpm config get node-linker`
returned `undefined`), which left `@react-native/gradle-plugin` un-hoisted and broke
`android/settings.gradle`'s `includeBuild`. Fixed with a new `pnpm-workspace.yaml` declaring
`nodeLinker: hoisted` — pnpm 11.x reads linker config from there instead. No physical Android
device is connected to this Mac yet, so the Android half of Phase 0 scenarios still needs to run
on hardware, same as before.

**Net status, still No Go/No-Go.** Two real, previously-unknown crash bugs are fixed and verified
on physical iOS hardware (the `AVAudioEngine` lazy-node crash, unconditionally; the `sdallocx`
symbol collision, also unconditionally — neither is DEBUG-only or local-test-specific, both would
have hit a real `com.oru` Release build the first time it tried this code path). The local-test
audio/transport pipeline is meaningfully healthier than at the start of this session, but a
peer-to-peer connection has still not been observed completing end-to-end, and further iOS
investigation is blocked again on physical device access.

## Evening session: PushToTalk dropped for an always-hot spike; locked-screen receive verified — 2026-08-17

### Research — the PushToTalk framework can be dropped entirely (desk research, three parallel investigations)

Desk research (no device work in this part) established that the only paid-account blocker in the
whole design is the `com.apple.developer.push-to-talk` entitlement itself. The `UIBackgroundModes`
values (`audio`, `bluetooth-central`, `bluetooth-peripheral`) are plain Info.plist keys, available
on a free Personal Team. Per Apple's `UIBackgroundModes` documentation and the Audio Session
guide, with the `audio` background mode an app that is playing *or recording* audio keeps running
indefinitely in the background/locked — continuous mic capture started in the **foreground** is
the sanctioned keep-alive, with no silent-playback hack needed.

One hard system restriction shapes the whole design (iOS 12.4/13+, CoreMedia's
`CMSUtility_IsAllowedToStartRecording`, error `'!rec'` 561145187): recording cannot be *started*
from the background without CallKit/PushToTalk/special entitlements. Consequence: any
"BLE-wake then open mic" design is non-viable on the free path; the viable free design is
**always-hot** — the mic opened in the foreground and kept pulling, with samples discarded when
idle. Known interruption risk (documented behavior plus practitioner reports, including Apple
forums thread 813278, Jan 2026): after a phone call or Siri while locked, a `.playAndRecord`
session cannot restart recording from the background — the radio stays mute until the user
foregrounds the app. Accepted as the known cost of the free path; PushToTalk (paid) is the only
real fix.

On the transport side: Google Nearby Connections on iOS supports **only** the Wi-Fi LAN medium
(same infrastructure network, mDNS discovery) per Google maintainers (github.com/google/nearby
discussion #2447) — no AWDL, no BLE medium yet. So "offline with no shared network" has no Nearby
transport on iOS; BLE L2CAP (explicitly blessed by an Apple engineer for the
active-audio-session-keeps-app-alive pattern, forums thread 746286; real-world throughput 36–50
kbps, enough for Opus at 16–24 kbps) is the candidate for a true offline channel.
MultipeerConnectivity is explicitly unsupported in the background per DTS. **Decision: spike the
always-hot architecture, with the PushToTalk path preserved behind a config switch.**

### Implementation (working tree, uncommitted)

- New `AlwaysHotBackgroundManager.swift` — a `BackgroundSession` implementation that never
  imports PushToTalk: it sets the audio session category itself, then `setActive(true)`
  (category-before-activate, avoiding the documented `engine.prepare()` crash), reports
  `backgroundSessionDidActivateAudio` for RadioEngine parity, and handles interruption
  notifications with a logged reactivation attempt.
- New `HeartbeatLogger.swift` — every 10 s appends to Documents/heartbeat.log: timestamp, app
  state, session state, `engine.isRunning`, and the age of the most recent input-tap buffer; plus
  out-of-band `record()` lines.
- `AudioEngine.swift` — a keep-alive input tap in always-hot mode (engine runs continuously, idle
  samples discarded, each buffer stamps the heartbeat); the tap is swapped for the real capture
  tap during transmission.
- `RadioConfig.Background.mode` switch: `.alwaysHot` (spike default) / `.pushToTalk` (original
  path intact, one-line revert). `RadioAssembly` selects the implementation.
- `Info.plist`: `audio` added to `UIBackgroundModes` (kept `push-to-talk`,
  `bluetooth-central`).
- RadioKit built and all 38 package tests passed; the device build (Debug, Oru-LocalTest signing)
  succeeded.

### On-device results — iPhone 12 (iOS 26) + Oplus Android phone, same Wi-Fi LAN

The local-test build now **launched and ran without the PTT entitlement** — the hard crash
recorded in the previous session (PTChannelManager init failure → uncaught AVAudioEngine
exception) is gone by construction in always-hot mode. The Nearby Connections handshake succeeded
(medium: ENCRYPTED_WIFI_LAN) — the first successful iOS↔Android connection of the project.

First transmissions delivered payloads (Nearby C++ logs confirmed `onPayloadReceived
type:Stream`) but produced **silence** on the iPhone. Root cause found by inspection: in
always-hot mode the AVAudioEngine is already running when `beginIncoming` attaches the player
node, and a node attached to a running engine never joined the active render graph (engine and
player reported healthy throughout). Fixed with an `engine.stop()`/`start()` cycle in
`beginIncoming` when the engine was already running (`restarted=true` recorded in the heartbeat).
Receive-path instrumentation (rx start / rx frames / rx scheduled / decode counters) was added via
HeartbeatLogger.

After the fix, audible speech was confirmed in the foreground, and then the key result —
**locked-screen receive verified**: with the iPhone locked (`app=background` in the heartbeat), a
15 s transmission delivered 750 frames, 748 decoded, 0 decode failures, all scheduled, and the
user audibly confirmed speech playback from the locked phone. This is the Go-milestone for the
PTT-free architecture.

Diagnostic note: Opus DTX encodes silence as ~8-byte frames, while real speech runs 22–60 bytes —
frame size in the rx log is a quick content-vs-silence discriminator. A long-duration lock test
started ~18:36 local; the heartbeat was continuous at last check, with the result to be recorded
when it concludes. Still open: the iPhone→Android transmit direction (the spike build has no
iPhone-side transmit trigger), the interruption (phone-call) test, and the long-test conclusion.

### BLE PTT button (Android side) — blocked, diagnosis in progress

The app's GATT pairing scan (ptt-scan) found zero candidates across three 60 s sessions
(including one with the button actively held). After OS-level pairing the button exposed **no**
HID input device (`getevent` listed only internal devices) and no media-key events were captured.
The button demonstrably works with Zello. Working hypothesis: it is a vendor-GATT button that
Zello's background service connects to directly; a connected GATT device stops advertising,
hiding it from scans (and OS bonding may hide it further). Next step: force-stop Zello, unpair the
button, put it in pairing mode, rescan.

## Late evening session: full symmetric radio verified; buttons, UIs, and three bugs — 2026-08-17

### Reverse direction (iPhone → Android) verified, including from the locked screen

The iOS spike had no transmit trigger — no RN UI exists yet, and the PTT lock-screen button went
away with the framework. New `SpikeCommandServer.swift` filled the gap: a DEBUG-only UDP command
server in RadioKit (port from `RadioConfig.Spike.commandPort` = 47999) accepting the text commands
`ptt-down` / `ptt-up` / `ptt-scan` / `ptt-pick <id>` / `ptt-forget` / `state`, driven from the Mac
via `nc -u`; it announced its en0 IP in heartbeat.log on start.

iPhone→Android audio was confirmed audible — and transmit **while the iPhone is locked** worked.
The always-hot design keeps the mic capturing continuously, so background transmit needed no new
rights: the "cannot START recording from background" restriction is irrelevant while capture never
stops.

### Both physical PTT-Z01 buttons paired; the full chain verified both ways

Physical button → Android mic → Nearby → locked iPhone speaker was verified (the previous
section's Go-milestone) — and now the symmetric chain too: second button → locked iPhone mic →
Nearby → Android. Both directions were user-confirmed audible, and the user confirmed the buttons
now work correctly, one per phone.

The BLE-scan mystery from the previous section resolved: it was NOT Zello or the buttons. Android
8.1+ silently returns ZERO results for unfiltered BLE scans (`startScan(callback)`, no filters)
when the app has no visible activity — and every earlier scan ran while the spike had no
foreground UI. Foregrounding the (new) pairing screen instantly yielded ~25 devices, including
both PTT-Z01 units. iOS mirrors this: `scanForPeripherals(withServices: nil)` yields results only
in the foreground. Production note: the pairing UI must be a foreground screen (natural UX
anyway), or scans must filter by service UUID.

New pitfall documented: these buttons accept multiple simultaneous central connections, so BOTH
phones can silently bind the SAME physical unit. This happened — presses triggered both phones at
once, and with both transmitting, a feedback loop played audio on both devices. The units are
visually identical; disambiguation required deterministic re-pairing (Android binds by stable MAC
— A4:C1:38:44:08:C1 vs A4:C1:38:47:40:CB; iOS sees only phone-local CoreBluetooth UUIDs) plus
physically labeling the units. Production consideration: surface identifying info and/or hold an
exclusive connection.

### Bug found and fixed: inverted press/release learning (both platforms)

The PTT-Z01 (Telink-style: service 0000ffe0, characteristic 0000ffe1, 01 = down, 00 = up) pushes
its current IDLE state (00) immediately on CCCD subscription. The learning rule "first two
different values become pressed/released in arrival order" therefore latched idle as pressed on
every pairing → transmit-on-release. A stored-binding dump
(`{"pressedValue":"00","releasedValue":"01"}`) confirmed it.

Fix (mirrored on both platforms, with unit tests): when exactly one learned value is all-zero
bytes, the nonzero one is pressedValue regardless of arrival order; otherwise the arrival-order
rule stands. Android: `PttLearningStateMachine.kt` (13 tests pass). iOS: `PttBinding.swift`
(`PttLearnedValues.ordered`) + `BleGattPttDriver.swift` (RadioKit suite passes).

### Bug found and fixed: Android audio pinned to loudspeaker with earbuds connected

`RadioForegroundService.kt:156` set `AudioManager.MODE_IN_COMMUNICATION` unconditionally at radio
start; the in-call policy excludes A2DP/LE from the route and nothing started SCO, so playback
fell to the loudspeaker even with Bluetooth earbuds connected.

Fix: the mode is now applied conditionally — `MODE_IN_COMMUNICATION` only when no external
playback device is present (`getDevices(GET_DEVICES_OUTPUTS)`, checked types including
A2DP/LE/wired/USB/hearing aid), with an `AudioDeviceCallback` re-evaluating live on
connect/disconnect. This mirrors iOS's "speaker as fallback, not a pin". Known limitation: a
route change mid-reception is up to platform dynamic re-routing; the next transmission is
guaranteed correct. In-earbuds playback is still pending hardware verification.

### Debug UX: real pairing/control UIs on both platforms (agent-built)

- iOS: `SpikeControlPanel.swift` — a DEBUG-only SwiftUI panel (state header, hold-to-talk,
  scan/candidate list sorted by RSSI with named devices highlighted, learning countdown, forget),
  shown in a dedicated UIWindow at `.alert` level — a plain child VC got covered when the RN root
  finished loading asynchronously.
- Android: `SpikeActivity` was rewritten with a programmatic-views UI (same features), subscribing
  via `RadioController.addListener` — the same path the spike logger uses. Being a foreground
  screen also un-breaks the BLE scan restriction by construction.
- Debug manifest: the real `MainActivity` was removed (`tools:node="remove"`) and replaced by an
  activity-alias with the same component name targeting `SpikeActivity`, so every entry point —
  launcher icon and stale home-screen shortcuts alike — opens the panel. Release manifests were
  left untouched.

### Operational notes

- Repeated reinstalls left ghost Nearby endpoints (`nearbyCount=3` on Android with one real peer,
  duplicate streams); clearing them required restarting the radio on both ends.
  Reconnect/endpoint-hygiene logic is worth attention later.
- Android grants: `pm grant` from adb is blocked on this ColorOS device (SecurityException) —
  permissions were granted by hand on-device.
- Still open, deferred: the overnight lock-duration test (28 gap-free minutes recorded so far),
  the interruption test (incoming call while locked → expected mute-until-foregrounded), battery
  measurement of the always-hot mode, and the real RN UI + NativeRadio TurboModule (P5) — the
  spike panels are debug-only stand-ins.

### Closing addendum — 2026-08-17, night

The buttons were re-verified by the user after the deterministic re-pair: one PTT-Z01 per phone,
no cross-triggering. The units are now physically labeled.

Bluetooth-headset MICROPHONE routing was attempted and parked. A three-way routing policy was
implemented in `RadioForegroundService.kt`: input-capable headset present → `MODE_IN_COMMUNICATION`
plus `setCommunicationDevice` (SCO fallback) for both capture and playback; output-only device →
`MODE_NORMAL`, A2DP playback with the phone mic; nothing external → communication mode on the
speaker. On the ColorOS test device, switching the buds into the communication profile dropped
them from the app's audio route entirely, and without verbose route logging the failure point is
not attributable. The headset-mic path is parked behind
`RadioForegroundService.ROUTE_MIC_TO_HEADSET = false` with the code retained. Current shipped
behavior: playback follows the buds over A2DP, capture stays on the phone mic. TODO recorded: add
route-decision logging and debug on-device.

A "quiet audio from the iPhone" report arrived late in the session; the Android voice-call and
media stream volumes were raised to max via adb as the first-line fix, verdict pending. It was
left open alongside a "hearing myself in the earbuds" report that telemetry could not reproduce —
the radio path was idle at the time; most likely the nearby iPhone's loudspeaker was playing the
user's own transmission in the same room.

Session close: the free-architecture spike is functionally complete — symmetric locked-screen
radio with per-phone hardware buttons on a free Apple account. The deferred items are unchanged:
overnight duration test, interruption test, battery measurement, real RN UI/TurboModule, and the
headset-mic debug.

## Night session: Bluetooth-headset routing brought to full duplex on both platforms — 2026-08-17/18

### Research pass: how PTT apps actually do Bluetooth routing

Three parallel web investigations ran earlier in the session; a dedicated routing study followed
and settled the design. **iOS:** the option set `[.allowBluetooth, .allowBluetoothA2DP,
.defaultToSpeaker]` mixes three conflicting routing signals and was identified as the root of the
iOS route flapping (documented iOS 17/18 regressions match). The canonical recipe is one profile
per session, `setPreferredInput` re-asserted on route change, and `overrideOutputAudioPort` on
demand instead of `.defaultToSpeaker`. **Android:** the canonical pattern is WebRTC's
AppRTCBluetoothManager state machine — establishment timeout, bounded retries, a single reducer.
Production PTT apps pin HFP for the whole session because SCO setup latency makes per-transmission
switching unusable; Zello ships a "Legacy Bluetooth" toggle (the old startBluetoothSco API) as the
escape hatch for broken OEM stacks. **Cost check:** 16 kHz mono Opus matches wideband HFP exactly,
so pinning HFP costs nothing on the wire.

### iOS: profile-conditional session, and a chicken-and-egg bug found on hardware

The first implementation selected the profile by inspecting `availableInputs`/`currentRoute`
BEFORE any Bluetooth option was set — but iOS only exposes BT ports when the current options allow
them, so a connected headset was invisible forever (hardware heartbeat: `session profile builtIn`
with a headset connected). **Fix:** a two-phase flow — configure permissively
(`[.allowBluetooth]`) → check for an HFP input → pin it; else narrow to `[.allowBluetoothA2DP]`,
activate, and decide the speaker override from the resolved route. Re-detection re-runs the full
sequence on device add/remove, and `.defaultToSpeaker` is gone. 70 RadioKit tests are green, 20 of
them covering the two-phase selector.

Also landed this session: capture-level metering in the heartbeat (`tx level peak/rms` in dBFS), a
transmit-path makeup gain `RadioConfig.Audio.captureGain = 2.0` with a clamp (response to the
"quiet iPhone audio" report), and the finding that voice processing
(`setVoiceProcessingEnabled`) was never engaged on the input node — noted, not enabled.

### Android: phantom decoded, legacy SCO required, full duplex achieved

The zero-MAC phantom `TYPE_BLUETOOTH_SCO` input turned out to be ColorOS's REPRESENTATION of the
connected HFP headset — the user confirmed the buds' "Phone calls" toggle was on, and the HFP
profile proxy listed OPENEAR Bone G1 as connected. **New rule:** a zero-MAC SCO input is accepted
iff `BluetoothProfile.HEADSET.getConnectedDevices()` is non-empty (logged with the real device
name/address); otherwise it is rejected as a true phantom.

`setCommunicationDevice` alone was confirmed insufficient on this device
(`scoManagedByAudio:false` — the BT stack still owns SCO): the platform "confirmed" the selection
but no SCO link rose → total silence (the earlier "I hear nothing" failure). **Fix:** dual
establishment — `setCommunicationDevice` plus legacy `startBluetoothSco()` /
`setBluetoothScoOn(true)` — with `ACTION_SCO_AUDIO_STATE_UPDATED` as the real confirmation signal:
only SCO_AUDIO_STATE_CONNECTED cancels the 6 s establishment timeout; error or timeout →
blacklist + fallback to the output-only row instead of silence.

**Hardware verification:** SCO went CONNECTING → CONNECTED in ~200 ms and the user confirmed the
radio fully working — the Bone G1 now carries both playback and capture on Android. The earlier
hardening from this session was all retained: audio focus with USAGE_VOICE_COMMUNICATION
(previously never requested at all), mode-before-device ordering with read-back,
OnCommunicationDeviceChangedListener re-assert, HFP cross-validation, and route labels in both
debug panels.

### Open items and notes

- Two transient engine `status=error` states occurred between builds; both times the cause rotated
  out of logcat before capture. Android needs a persistent error log (iOS-heartbeat-style file) —
  recorded as a TODO. Buttons refusing to fire was the error-state guard working as designed; UX
  needs auto-recovery or a visible restart affordance on error.
- SCO playback is telephone-profile quality by design (it matches the 16 kHz wire format); the
  route label in both panels now makes the active route visible.
- Still deferred: overnight duration test, interruption test, battery, RN UI/TurboModule (P5).

## Decision log — problems met on 2026-08-17 and why each solution won

A consolidated record of the day: every problem or bug met, the solution options considered, which
one was chosen, and why the others were rejected.

1. **Problem:** the PushToTalk entitlement (`com.apple.developer.push-to-talk`) is paid-account-only
   and blocked even local API use — the hard blocker for the whole spike.
   **Options:** (a) pay $99 and use the official framework; (b) the `audio` UIBackgroundMode with an
   always-hot mic session; (c) BLE-wake + start recording on demand.
   **Decision + why:** (b) accepted and verified on hardware the same day. (c) was rejected
   outright: iOS forbids STARTING recording from the background (CoreMedia's `'!rec'` guard) —
   unfixable without entitlements, so any wake-then-record design was dead on arrival. (a) was
   deferred, not rejected on merit: it costs money, and PushToTalk provides no transport anyway —
   the transport work was needed either way. It remains the fallback if the always-hot limitations
   (no recovery after call interruptions, battery cost, permanent mic indicator) prove unacceptable.

2. **Problem:** transport under lock on iOS — Google Nearby on iOS supports only the Wi-Fi LAN
   medium (maintainer-confirmed, no AWDL, no BLE).
   **Options:** MultipeerConnectivity; AWDL via Network.framework; BLE L2CAP; same-LAN Wi-Fi via
   Nearby.
   **Decision + why:** same-LAN Wi-Fi via Nearby accepted for the spike — the test environment has
   a shared network, so it unblocked everything else. MultipeerConnectivity was rejected because
   Apple (DTS) explicitly calls it unsupported in the background. AWDL via Network.framework was
   rejected for now — undocumented and coupled to screen state. BLE L2CAP was kept as the
   true-offline candidate and deferred.

3. **Problem:** silent receive on the iPhone despite healthy telemetry — payloads arrived, engine
   and player reported fine, no sound. Root cause: an AVAudioPlayerNode attached to an
   ALREADY-RUNNING engine (always-hot starts it early) never joins the active render graph.
   **Options:** restructure the engine to pre-attach all nodes; a defensive engine stop/start cycle
   in `beginIncoming`.
   **Decision + why:** the stop/start cycle was accepted (`restarted=true` heartbeat evidence
   confirmed it fired and fixed playback); restructuring was rejected as too invasive for a spike.
   Full rx-path instrumentation (rx start / frames / scheduled / decode counters) was added so any
   future silence would be attributable in one run.

4. **Problem:** the BLE button scan always came back empty across multiple 60 s sessions.
   **Hypotheses tested and discarded in order:** Zello's service holding the button (force-stopped
   — no change); a HID-type button (keys-capture mode — no key events at all); an OS bond hiding
   the advertisement (unpaired — no change).
   **Decision + why:** the real cause was none of these — Android 8.1+ silently returns zero
   results for UNFILTERED BLE scans from apps without a visible activity (iOS behaves the same for
   `scanForPeripherals(withServices: nil)`). Accepted: run the pairing UI in the foreground during
   scans, which is the natural UX anyway; the production alternative — filtering by service UUID
   — was noted.

5. **Problem:** one physical button triggered BOTH phones (the buttons accept multiple simultaneous
   central connections; the two units are visually identical and unlabeled), producing a feedback
   loop.
   **Options:** RSSI-based guessing; deterministic assignment.
   **Decision + why:** deterministic assignment accepted — Android binds by stable MAC, the
   iPhone's unit was verified by exclusion, and the units were physically labeled. RSSI guessing
   was rejected because it had already proved wrong once during the session. Production note
   recorded: surface identifying info and/or hold exclusive connections.

6. **Problem:** inverted press/release on every pairing — the button pushes its idle state ("00")
   immediately on CCCD subscribe, and the "first two distinct values in arrival order" learning rule
   latched idle as pressed.
   **Options:** pairing choreography ("press cleanly after a pause"); hand-editing the stored
   binding; two-cycle learning; nonzero-value-wins normalization at learning completion.
   **Decision + why:** nonzero-value-wins accepted, mirrored on both platforms with unit tests for
   both arrival orders. Choreography was rejected — it failed twice on hardware. Hand-editing the
   binding was used once as a stopgap only. Two-cycle learning was rejected as more UX friction than
   the problem required.

7. **Problem:** Android playback pinned to the loudspeaker with earbuds connected. Root cause:
   unconditional `MODE_IN_COMMUNICATION` — the in-call policy excludes A2DP from the route.
   **Decision + why:** conditional mode accepted — communication mode only when no external
   playback device is present, with an `AudioDeviceCallback` re-evaluating live on
   connect/disconnect: "speaker as fallback, not a pin", mirroring the iOS behavior.

8. **Problem:** the first headset-mic attempt dropped the earbuds from the app's route entirely
   (ColorOS), with no way to attribute the failure point.
   **Options:** revert the feature; park it behind a flag until debuggable; verbose route logging +
   web research + a hardened sequence.
   **Decision + why:** the feature was briefly parked behind `ROUTE_MIC_TO_HEADSET = false` to
   restore a working state for the user, then the logging-plus-research-plus-hardening path was
   taken to completion. Reverting outright was rejected — a full-duplex headset was a hard
   requirement.

9. **Problem:** the zero-MAC phantom `TYPE_BLUETOOTH_SCO` input.
   **Evolution of the rule, each step evidence-driven:** reject by zero MAC (a half-measure — a
   phantom could carry a plausible address); cross-validate against
   `BluetoothProfile.HEADSET.getConnectedDevices()` (stronger); finally, ACCEPT the zero-MAC device
   iff the HFP proxy lists a connected headset.
   **Decision + why:** the final rule was a reversal justified by new evidence — on ColorOS the
   "phantom" turned out to BE the representation of the real headset (the user's "Phone calls"
   toggle was on; the proxy listed OPENEAR Bone G1) — and it stayed safe because the SCO fallback
   below catches the true-phantom case.

10. **Problem:** the SCO link never rose — `setCommunicationDevice` returned true and the platform
    "confirmed" the selection, yet total silence. `scoManagedByAudio:false` showed the BT stack, not
    the audio framework, owns SCO on this device.
    **Options:** trust the modern API alone; legacy `startBluetoothSco` alone; dual establishment.
    **Decision + why:** dual establishment accepted — modern plus legacy, with only
    SCO_AUDIO_STATE_CONNECTED counting as confirmation and a 6 s timeout falling back to
    A2DP-playback + phone-mic. The modern API alone was rejected by direct evidence; the legacy API
    alone was rejected as deprecated and wrong for future devices. This is the Zello "Legacy
    Bluetooth" lesson, made automatic instead of a user toggle.

11. **Problem:** iOS route flapping. Root cause: `[.allowBluetooth, .allowBluetoothA2DP,
    .defaultToSpeaker]` — three conflicting routing signals in one option set.
    **Decision + why:** one profile per session accepted. The first implementation had a
    chicken-and-egg bug — it inspected ports before allowing them, so a connected headset was
    invisible. Options there: always `[.allowBluetooth]` only (rejected — A2DP-only headphones
    like the user's bone-conduction unit would lose audio entirely) versus a two-phase
    permissive-detect-then-narrow flow (accepted, covered by 20 unit tests).

12. **Problem:** quiet iPhone transmissions.
    **Options in order:** raise the Android stream volumes via adb (tried first — insufficient);
    software makeup gain.
    **Decision + why:** +6 dB makeup gain with a clamp accepted, plus dBFS metering on the capture
    path so level problems are measurable rather than anecdotal. The work also surfaced that voice
    processing was never engaged on the input node — noted, deliberately not enabled mid-spike.

13. **Problem:** the RN template stub hijacked the app entry point on Android.
    **Decision + why:** the first fix — stripping MainActivity's launcher intent-filter in the
    debug manifest — was superseded: stale home-screen shortcuts target the component explicitly.
    Accepted fix: remove the real MainActivity in the debug manifest and install an activity-alias
    with the SAME component name targeting SpikeActivity, so every entry point lands in the panel;
    release manifests untouched.

14. **Problem:** transient engine `status=error` states blocked all transmit (the guard working as
    designed), with the cause rotating out of logcat before capture — twice.
    **Decision + why:** recorded as a TODO rather than fixed tonight — Android needs a persistent
    error log (iOS-heartbeat-style file) and an error-state recovery affordance; chasing an
    unreproducible cause without those tools was not worth the night.

15. **Tooling decisions along the way:** the iOS transmit trigger for the spike — a URL scheme was
    rejected (needs foregrounding), `devicectl` process launch was rejected (unreliable on this
    device), and a UDP command server on the LAN was accepted (headless, scriptable). Ghost Nearby
    endpoints after repeated reinstalls were cleared by restarting both radios; endpoint hygiene was
    noted for later.

## Next phase groundwork: BLE L2CAP as the true-offline transport, and a product note — 2026-08-18

Desk research (web only, no device work) de-risked the next transport spike: BLE L2CAP
connection-oriented channels as the iPhone↔Android path when no shared Wi-Fi LAN exists. Findings
are separated below into documented (platform docs / engineer answers), practitioner (forum and
project reports), and uncertain (must be measured in the spike).

### 1. Cross-platform API pairing and PSM discovery

**Documented.** The API pair exists on both sides: iOS `CBPeripheralManager.publishL2CAPChannel`
(iOS 11+) listens and yields a PSM; Android `BluetoothDevice.createL2capChannel(psm)` /
`createInsecureL2capChannel(psm)` (API 29+, Android 10) dials it
(https://developer.apple.com/documentation/corebluetooth/cbperipheralmanager/publishl2capchannel(withencryption:),
https://learn.microsoft.com/en-us/dotnet/api/android.bluetooth.bluetoothdevice.createinsecurel2capchannel).

**Practitioner.** iPhone↔Android interop over *insecure* CoC was confirmed working by multiple
independent reports (Apple forums thread 675960; JuulLabs/kable discussion 588,
https://github.com/JuulLabs/kable/discussions/588). The universal PSM-discovery pattern was a small
GATT service with a characteristic holding the PSM — iOS cannot place the PSM in advertising data,
so the GATT read is the interop-standard handshake. Kable also recorded two Android quirks: the
socket exposes only a bare `isConnected` boolean (no INIT/CONNECTED/CLOSED state), and a ~2 s
post-connect settling delay was needed before first use.

### 2. Secure vs insecure channels

**Practitioner, consistent across sources.** Secure CoC iPhone↔Android was reported broken:
bonding is triggered and completes, then the channel open fails with iOS error 104 "Unknown ATT
error"; the same developer's insecure channel worked (Apple forums thread 675960, unanswered). The
kable contributor summarized: insecure channels "fairly robust and usable," secure channels "a bit
cursed" on both platforms. The practitioner norm is therefore the insecure channel with
app-level payload encryption, which also avoids the OS bonding dialog entirely. Bonding would have
one side benefit (reconnect-by-identity through iOS's rotating random address) but was not shown to
work end-to-end cross-platform with CoC.

### 3. Throughput, roles, and radio coexistence

**Documented proof point.** Android's own ASHA hearing-aid protocol streams real-time voice over
L2CAP CoC from an Android phone: G.722 at 64 kbit/s, 20 ms connection interval, 167-byte MTU/MPS,
8-credit buffering, sequence byte per frame (https://source.android.com/docs/core/connect/bluetooth/asha).
That is 2.7× our 24 kbps budget, shipped platform-wide — CoC carries live voice.

**Practitioner.** Role choice matters asymmetrically: with the Apple device as *peripheral*
(publisher), tens of kB/s were reported reachable (DLE + large SDU; Apple supports SDU up to
2048); with the Apple device as *central*, throughput was reported poor because iOS exposes no
control over connection interval or channel parameters (Apple forums threads 723218/89644). Android
as central can call `requestConnectionPriority(CONNECTION_PRIORITY_HIGH)` (7.5–15 ms CI). So the
best-throughput arrangement — iPhone publishes, Android dials as central — is also the only
arrangement the APIs naturally allow, since iOS's publish API lives on `CBPeripheralManager`.
Counter-report: some Android handsets skipped Data Length Extension on CoC, fragmenting at the link
layer and cutting throughput (https://devzone.nordicsemi.com/f/nordic-q-a/87529/) — per-handset
variance is real.

**Uncertain.** No published iPhone↔Android CoC numbers with concurrent A2DP/SCO to a headset were
found. Coexistence is documented only at the principle level: one 2.4 GHz radio, time-division
arbitration, Classic audio prioritized (https://www.ezurio.com/resources/blog/dual-mode-bluetooth-classic-ble-coexistence).
With PTT headsets active on both phones this is the single biggest unmeasured risk — spike item.

### 4. Background behavior

**Documented (the blessed pattern, with its exact limits).** An Apple engineer stated that an
L2CAP channel neither prevents suspension nor wakes the app (unlike GATT), but that an app with an
active `AVAudioSession` stays alive in background and can then use L2CAP — naming audio streaming
as the example (https://developer.apple.com/forums/thread/746286). This matches the always-hot
architecture exactly: the mic session is genuinely active, so the keep-alive is not a pretext
(the engineer flagged App Review 2.5.4 for pretext cases).

**Practitioner pitfall found — discovery, not the channel, is the background risk.** A backgrounded
iOS peripheral moves its advertised service UUIDs into the Apple-proprietary "overflow area,"
discoverable only by iOS scanners; Android cannot see them (reverse-engineering and a hashed-bit
workaround: https://github.com/davidgyoung/ios-overflow-area,
https://davidgyoungtech.com/2020/05/07/hacking-the-overflow-area). iOS also advertises a rotating
private address, so an unbonded Android cannot reconnect by cached MAC. Consequence: the channel
must be established while the iPhone app is foreground (radio-on moment) and the ACL kept alive;
after a link drop with the iPhone locked, Android-side rediscovery may fail until the iPhone is
foregrounded. This is the likely killer failure mode and a mandatory spike measurement.

**Android side.** A foreground service holding the socket is unrestricted and survives
backgrounding; practitioner reports warn that aggressive OEM Doze can still drop BLE links when
the screen is off, with battery-optimization exemption as the standard mitigation
(https://dev.to/ble_advertiser/beyond-the-foreground-service-reliable-background-ble-connection-management-on-android-12-2n78).
ColorOS on the test device makes this a real spike item, not a footnote.

### 5. Reliability patterns for real-time audio

CoC is reliable and in-order (credit-based flow control), so head-of-line blocking is the failure
shape under stall — but at 24 kbps against even pessimistic tens-of-kbps capacity the queue stays
shallow if the sender refuses to let it grow. Practitioner patterns: length-prefixed framing (the
socket APIs surface byte streams; SDU boundaries are not reliably exposed on Android), a sequence
byte per frame (ASHA does exactly this), a drop-oldest send queue so stale audio is never
transmitted after a stall, and treating reconnect as a full re-dial (GATT connect → read PSM →
open channel); kable deliberately treated sockets as short-lived. A small receive-side jitter
buffer remains necessary — the Android-only BLE walkie-talkie project denizetkar/walkie-talkie-app
reported 300–800 ms mouth-to-ear with a conservative jitter buffer over unstable BLE
(https://github.com/denizetkar/walkie-talkie-app), a useful pessimistic anchor.

### 6. Range and coded PHY

**Practitioner consensus.** Phone-to-phone BLE at 1M PHY: roughly 30–50 m indoors, ~100 m
line-of-sight, with 3–6 dB per wall and body absorption on top
(https://sheridantech.io/2026/07/24/range-of-bluetooth-low-energy/). Throughput degrades toward the
edge, so voice-usable range is the low end of that.

**Documented.** Coded PHY (long range) is not a cross-platform option: iOS 13.4 briefly supported
it, iOS 14 removed it, and it remains absent (https://developer.apple.com/forums/thread/804458,
https://www.developer.apple.com/forums/thread/665542); Android support is per-handset. L2CAP is
therefore a same-area/short-range fallback, not a replacement for the Wi-Fi LAN path's reach.

### 7. Ready-made libraries and SDKs (build-vs-buy survey)

Candidates were assessed for: license/pricing, true serverless iPhone↔Android transfer, health,
and fit under the `RadioTransport` seam.

- **Ditto** (https://docs.ditto.live/sync/concepts/transports-overview) — commercial closed SDK;
  genuinely does iPhone↔Android BLE + LAN mesh with no servers, actively maintained, RN binding
  exists. But it is a CRDT *database sync* engine: the abstraction is replicated documents, not a
  low-latency byte stream; pricing is enterprise-opaque. Wrong shape for 20 ms voice frames.
- **Bridgefy** (https://bridgefy.me/sdk/, https://github.com/bridgefy) — commercial freemium,
  SDKs updated through 2026, real iOS↔Android BLE mesh; explicitly message-oriented, with
  practitioner guidance that continuous audio "will glitch out a lot." Voice notes yes, live PTT no.
- **Berty weshnet** (https://github.com/berty) — open source (MIT/Apache), libp2p-based; the BLE
  driver was historically Android↔Android only, iOS↔Android transport remained unstable, and the
  expo module went stale. Not dependable as a transport today.
- **HypeLabs Hype SDK** — effectively dormant (no releases or activity found in recent years);
  discarded.
- **bitchat** (https://github.com/permissionlesstech, MIT/Unlicense) — open-source BLE GATT chat
  mesh, iOS+Android, but GATT-based messaging with known iOS↔Android bridging bugs at launch;
  valuable as a protocol/discovery reference, not a voice transport.
- **Thin BLE wrappers with L2CAP:** `munim-bluetooth` (https://github.com/munimtechnologies/munim-bluetooth,
  Apache-2.0, RN Nitro modules, L2CAP on both platforms including iOS peripheral publish; young —
  22 stars, single vendor); JuulLabs **kable** (KMP; L2CAP client-side only, still at discussion
  stage); `kmp-ble` (typed L2CAP streams, very small); blue-falcon / ble.net (GATT only).

**Verdict: build.** No SDK carries real-time voice iPhone↔Android offline; every mesh SDK is
message-oriented and warns against continuous audio. The driver must live in native code next to
the audio engines anyway — bridging 20 ms frames through the RN layer would add latency for
nothing. `munim-bluetooth` is the best reference implementation to crib API shapes from, and the
kable discussion is the best catalogue of interop pitfalls. Estimated surface is small: a GATT
service, a socket, and framing.

### Recommended spike scope and Go/No-Go criteria

Shape of the driver behind the existing transport seam (`RadioTransport` on iOS, its Android
counterpart): iPhone runs `CBPeripheralManager` alongside the existing PTT-button
`CBCentralManager` (concurrent central+peripheral is supported; practitioner reports of latency
degradation under load make it a measurement, not an assumption —
https://developer.apple.com/forums/thread/107591). iPhone publishes the insecure L2CAP channel
once per radio-on and advertises a service whose GATT exposes PSM + protocol version; Android
scans, connects GATT, reads the PSM, requests `CONNECTION_PRIORITY_HIGH`, dials
`createInsecureL2capChannel`, and holds the socket in the existing foreground service. Framing:
length-prefixed Opus frames + sequence byte; drop-oldest send queue; app-level encryption deferred
past the spike. Nearby remains primary when a LAN exists; L2CAP is the no-LAN fallback, selected
by transport health, with sequence-number dedupe at the engine if both are ever live.

Go/No-Go measurements, in order of kill-likelihood:
1. Reconnect with the iPhone locked: after a forced link drop, can Android re-establish without
   the iPhone being foregrounded (overflow-area problem)? If not, is "reconnect requires a glance
   at the iPhone" acceptable? — the decisive criterion.
2. Sustained goodput ≥ 32 kbps for 10 min in both directions, iPhone↔Android, phones locked.
3. Coexistence: the same measurement with A2DP/SCO headsets active on both phones (PTT headset
   use case) — no worse than intermittent single-frame loss.
4. Mouth-to-ear latency ≤ 500 ms with the jitter buffer tuned for BLE.
5. iPhone central+peripheral concurrency: PTT button latency unaffected while the channel streams.
6. 30+ min locked-screen soak with audio flowing both ways, heartbeat-logged on both sides.

### Product note — radio power switch is a design requirement (verbatim intent)

The always-hot architecture keeps the microphone and audio session live whenever radio mode is on,
so battery cost is inherent to the design. The design must therefore include an explicit radio
on/off toggle (power switch) as a first-class control — not a settings item. This requirement goes
through the design phase and then implementation.

### Superseded item

The planned overnight duration test was superseded: extended locked-screen operation was verified
in practice across the day's sessions on 2026-08-17/18.
