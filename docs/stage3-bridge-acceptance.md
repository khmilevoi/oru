# Stage 3 — RadioNative bridge: manual acceptance

Spec §16: every transport-dependent stage from Stage 3 onwards carries a short written manual
acceptance checklist executed on real Android + iPhone hardware. This is Stage 3's. The automated
gates cannot stand in for it: `pnpm test` runs against the mock engine by design, and no gate on
the planning host compiles Swift at all.

**Spec §15 Stage 3 acceptance:** JS drives a full session against the real engines, and the
Stage 2 screens do it **unmodified**. A UI change needed to make the real binding work is a §6.4
violation and is reported as one.

## Prerequisites

- One Android device and one iPhone, both with the app installed from a **debug** build.
- Internet off on both (§15 Phase 0 conditions).
- Android permissions granted; the foreground service is refused without them and the radio
  reports `foreground_service_denied`:
  `adb shell pm grant com.oru android.permission.RECORD_AUDIO`
  (plus the Bluetooth and location grants listed in `docs/phase0-android-spike-hooks.md`).
- The dev default is now `native`. To run any of this against the mock instead, build with
  `RADIO_BACKEND=mock`.

## Known state of the tree at this stage

- **App entry is P7's and is not wired yet.** Nothing subscribes `radioEventListener` into the
  Reatom model and nothing calls `radio.start()` at launch, so drive the module from the Dev
  Menu / a debug entry point rather than expecting the app to do it on its own.
- **On iOS, `AppDelegate.swift` still calls `RadioSpike.bootstrap()` under `#if DEBUG`**, which
  starts the engine at launch. JS still reports `off` until `start()` is called — the bridge, not
  the engine, owns `off` — but the radio really is live before the user powers it on, and a JS
  `stop()` will stop the spike's radio too. P7 owns removing the spike.
- **Pairing while the radio is off differs by platform, by construction.** On Android the PTT
  drivers live inside the foreground service, so `configurePtt()` with the radio off rejects with
  `radio_off`; the merged pairing screen renders that as a pairing failure. On iOS `PttManager`
  outlives `startRadio()`/`stopRadio()`, so pairing works in either power state. Pair with the
  radio **on** when running this checklist.

## Checklist

Record pass/fail and the device for each row.

| # | Step | Expected |
|---|---|---|
| 1 | Fresh launch, before pressing anything: read `getState()` | `status: 'off'`, `nearbyCount: 0`, `transmitting: false`, `receiving: false`; `pttButton.configured` reflects any previously saved button and `connected` is `false`; no `pttPairing` key |
| 2 | Power the radio on | a `stateChanged` with `status: 'starting'` arrives **before** the `start()` promise resolves, then the engine's own `starting` / `ready` follow |
| 3 | With both devices on, wait for discovery | `nearbyCount` rises on both; the main screen leaves `searching` for `ready` |
| 4 | Hold the on-screen PTT area on Android | `transmitting: true` arrives; the iPhone reports `receiving: true` and plays audio |
| 5 | Release | `transmitting: false` on the sender, `receiving: false` on the receiver |
| 6 | Repeat 4–5 in the other direction | same, mirrored |
| 7 | Power the radio off | a single `stateChanged` with `status: 'off'` and `nearbyCount: 0`; **no `starting` flash on the way down**; the engine's own post-stop snapshot never reaches the screen |
| 8 | Read `getState()` while off | the same off state as row 1, with the button still `configured` and `connected: false` |
| 9 | Power on again | back to `starting` → `ready` and peers rediscovered |
| 10 | Open pairing with the radio **on**, pick a candidate, let it learn | `pttPairing.phase` moves `scanning` → `learning` → `saved`; `configurePtt()` resolves with `{name, binding}` and the binding's fields match what the device advertises |
| 11 | Cancel or let a pairing scan time out | an `error` event arrives and `configurePtt()` rejects with the same code; `status` does **not** become `error` — a failed pairing leaves the radio healthy (§13) |
| 12 | Forget the button with the radio on, then off | `pttButton.configured` becomes `false` in both power states |
| 13 | Force an engine failure (deny the microphone permission, then power on, on Android) | an `error` event **and** `status: 'error'`; the error screen's restart action returns the UI to `starting` |
| 14 | Throughout | **no screen file was edited to make any of the above work.** `git diff --name-only <merge-base>..HEAD -- src/screens src/ui` is empty |

## If row 14 is not empty

Stop. That is a §6.4 violation and is reported as one rather than absorbed: the design-first
order's whole claim is that swapping the mock for the real module is a one-line binding change.
Record what the screen needed and which fact of the §6.1 contract failed to carry it.
