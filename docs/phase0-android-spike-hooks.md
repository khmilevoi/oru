# Phase 0 — driving the Android radio without React Native

The debug build carries two hooks (`android/app/src/debug/`) that run the whole engine over
`adb`. They exist for spec §15 Phase 0 scenarios A–D and disappear from release builds.

Install first: `pnpm build:android && adb install -r android/app/build/outputs/apk/debug/app-debug.apk`

`build-android.js` defaults to `RN_ARCHS=arm64-v8a` (the physical test devices used so far are all
arm64). An x86_64 emulator (e.g. Android Studio's default AVDs) needs
`RN_ARCHS=x86_64 pnpm build:android` instead, or the installed app crashes on launch with
`SoLoaderDSONotFoundError: couldn't find DSO to load: libreactnative.so` — the APK simply has no
native libraries for the emulator's ABI. See the 2026-08-17 entry in the spike report.

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
# All API levels, not just 12 and below: Nearby Connections' BLE medium needs this granted
# unconditionally (its own internal check, independent of NEARBY_WIFI_DEVICES) or
# startAdvertising()/startDiscovery() fail with ConnectionsStatusCodes 8034
# MISSING_PERMISSION_ACCESS_COARSE_LOCATION -- see Bug found #3 in the spike report.
adb shell pm grant com.oru android.permission.ACCESS_FINE_LOCATION
# Without this, Nearby's rediscovery of a lost peer silently and permanently stalls a few
# minutes after the app has no visible Activity (locked/pocketed-phone use case) -- see Bug
# found #5 in the spike report. Plain `pm grant` was sufficient to fully grant it in testing.
adb shell pm grant com.oru android.permission.ACCESS_BACKGROUND_LOCATION
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
| B — iPhone BLE PTT → locked Android plays audio | start both, lock the Android, press the iPhone's button; the Android must play without any command from here. Confirm it objectively rather than by ear: run `state` while the button is held and read `receiving=true`, then again after the release and read `receiving=false` |
| C — locked iPhone BLE PTT → Android receives | the mirror of B, driven from iOS; here you only confirm reception — again with `state` (`receiving=true` while the iPhone transmits), not by ear alone |
| D — out of range and back | `state` shows `nearbyCount` 1, walk out of range until it reads 0, return, and `state` must return to 1 with no restart |

Record the outcome and an explicit **Go** or **No-Go** in
`docs/superpowers/specs/2026-08-13-phase0-spike-report.md`.
