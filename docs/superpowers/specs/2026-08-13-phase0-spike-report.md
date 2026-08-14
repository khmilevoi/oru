# Phase 0 Spike Report — 2026-08-14

## Status

**No Go/No-Go decision has been made.** This report documents pre-gate smoke testing and bug
fixes only. The actual Phase 0 gate (spec §15 scenarios A–D, run on physical Android + iPhone
per `docs/superpowers/execution/2026-08-13-offline-nearby-ptt.md` Sync 2) is still pending
hardware: an iPhone and a physical BLE PTT button. Nothing below should be read as satisfying
Sync 2's Go/No-Go requirement — it is single-device Android groundwork that happened first
because that hardware was on hand today.

Scope actually exercised: `docs/phase0-android-spike-hooks.md` sections 1–3 (permissions,
start/stop, drive-while-running) only. Sections 4 (BLE PTT-button pairing) and 5 (scenarios
A–D) were explicitly out of scope for this pass — no BLE button and no second/iOS device were
available.

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

### Both bugs fixed and verified today

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
clean stop) looks healthy — zero crashes/ANRs across the whole session. Two real manifest-level
defects were caught and fixed that would otherwise have silently broken the actual Phase 0
scenario 3 commands (`state`/`ptt-down`/`ptt-up`) even once an iPhone becomes available, so this
smoke test had genuine value beyond "looks fine."

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

- **Scenario A** (Android PTT → locked iPhone plays audio) — blocked: no iPhone available.
- **Scenario B** (iPhone BLE PTT → locked Android plays audio) — blocked: no iPhone available.
- **Scenario C** (locked iPhone BLE PTT → Android receives) — blocked: no iPhone available.
- **Scenario D** (out of range and back, `nearbyCount` 1→0→1) — blocked: needs a second peer
  device; none was available during this pass. An Android emulator briefly appeared over adb
  during testing and was deliberately not used as a substitute peer, since it doesn't stand in
  for the real cross-platform requirement.
- **BLE PTT-button pairing flow** (`ptt-scan`/`ptt-pick`/learning, §4 of the spike hooks doc)
  and **HID key capture** (`cmd keys`) — blocked: no physical Bluetooth PTT button available
  yet (procurement/reverse-engineering is separately scheduled as closeout Stage 5 per the
  execution schedule).

## Status (repeated)

**No Go/No-Go decision has been made.** This report documents pre-gate smoke testing and bug
fixes only. The actual Phase 0 gate (scenarios A–D on physical Android + iPhone, per the spec)
is still pending hardware (iPhone, BLE PTT button).
