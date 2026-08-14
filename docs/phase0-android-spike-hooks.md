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
