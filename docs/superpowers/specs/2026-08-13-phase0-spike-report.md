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
