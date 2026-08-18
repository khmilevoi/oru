# Stage 4 — Integration: on-device acceptance checklist

Written: 2026-08-18.

Spec §15 Stage 4 acceptance: *"full flow on both platforms from install to talking"* — the
on-device acceptance the design stage (Stage 2, mock-engine only) deliberately does not carry.
Spec §4 is the MVP's Definition of Done in full; every bullet there is mapped onto a row of this
checklist below.

**No gate on the planning host runs this.** `pnpm typecheck`, `pnpm lint` and `pnpm test` prove
the TypeScript wiring compiles and the model behaves correctly against the mock engine; none of
them presses a button, discovers a peer, or plays audio. This document has not been executed.
Every Pass/Fail cell below is blank until an operator runs it, once, on the two physical devices
this checklist names — record the result on the copy actually used for the run, not here.

## Prerequisites

- One Android device and one iPhone.
- Both devices: **uninstall any existing build first**, then install a fresh **debug** build.
  This checklist starts at first launch, so a prior install's onboarding state must not linger.
- Internet off on both devices for the whole session (§15 Phase 0 conditions, §4).
- Bluetooth on on both devices.
- The default backend on both platforms, i.e. **not** built with `RADIO_BACKEND=mock`. The dev
  default and the release default are both the real native backend; `RADIO_BACKEND=mock` is an
  opt-in and must not be set for this run.

## Known state of the tree at this stage

- **iOS compiles nowhere in CI.** The first iOS build of this branch is also the first time its
  Swift is compiled at all. Expect build errors that no automated gate could have caught; they
  are not necessarily regressions in the sense a CI failure would be, but they do need fixing
  before this checklist can proceed on the iPhone.
- **iOS raises its microphone, Bluetooth and local-network prompts when the radio starts, not
  during onboarding.** iOS exposes no pre-request API for microphone or Bluetooth, and none at
  all for local network, so the three onboarding screens on iOS are an explanation sequence that
  precedes the OS's own dialogs rather than triggering them directly. Seeing the system prompts
  appear later — at the first PTT press, row 10 below — is deliberate (this plan's ruling 2), not
  a defect.
- **Android pairing with the radio off rejects with `radio_off`** (P5's finding: the PTT drivers
  live inside the Android foreground service). Pair with the radio **on** — see row 13.
- **`__DEV__` builds carry the mock-scenario Dev Menu entries.** They must **not** be opened or
  used anywhere in this checklist. The entire point of Stage 4 is exercising the real backend;
  touching a mock scenario partway through invalidates every row after it.

## Checklist

Record pass/fail and the device for each row.

| # | Step | Expected |
|---|---|---|
| 1 | Fresh install, first launch, Android | The onboarding sequence appears in the system language (English or Russian), microphone step first |
| 2 | Walk the three steps, allowing each | Each explanation appears *before* its system dialog; the sequence advances on each grant |
| 3 | Deny one step, then use "Try again" | The denied copy appears; the retry re-raises the dialog |
| 4 | Deny permanently, then "Open settings" | The app's settings page opens |
| 5 | Finish onboarding, Android | The background-location step appears; "Allow" leads either to a grant or to the settings redirect described on screen |
| 6 | Choose "Not now" on the background step | The main screen appears in `off` — "RADIO OFF" / "TAP TO TURN ON", dead air, no scanning cue |
| 7 | Fresh install, first launch, iPhone | The same three explanation screens appear; no system dialog is raised by them |
| 8 | Relaunch each app | Onboarding does **not** reappear |
| 9 | Power the radio on, both devices | `searching` then `ready`; the peer count rises on both (§4: automatic mutual discovery) |
| 10 | Hold the PTT area on Android | Android shows `transmitting`; the iPhone shows `receiving` and plays the audio. On iOS this is where the microphone / local-network prompts appear on a first run — allow them |
| 11 | The same in the other direction | Mirrored (§4: PTT works from the screen) |
| 12 | Lock both phones, transmit again | Audio still passes both ways (§4: the phone can be locked; the other locked phone automatically plays the received speech) |
| 13 | Open Settings → Connect, pair a button with the radio **on** | The four-step pairing flow completes and the button's name appears in Settings |
| 14 | Press the physical button with the phone locked | Transmission starts (§4: the Bluetooth PTT button works; the physical button starts transmission while the phone is locked) |
| 15 | Walk out of range and back | The connection restores automatically without touching either app (§4: the connection recovers after a brief signal loss; §15 Phase 0 scenario D) |
| 16 | Kill the React Native process (Android: `adb shell am kill com.oru`), keep the service running | Radio functionality continues; relaunching the UI re-syncs to the live state rather than to `off` (§4: React Native can be inactive while radio functionality continues to work; §6.2) |
| 17 | Background the app for a minute, then return | The main screen shows the state the engine actually holds, not a stale one (§6.2 resume re-sync) |
| 18 | Power the radio off with the press-and-hold | A single transition to `off`, no `starting` flash, peer count cleared |
| 19 | Switch the system language to Russian and relaunch | Every screen in this checklist is Russian (§12.2) |
| 20 | Throughout the whole session | No crash, and no screen file was edited to make any of the above work (§6.4) |
| 21 | Throughout the whole session — pairing, discovery, and every talking exchange above — confirm neither device ever shows a connectivity path to the internet (airplane mode, or Wi-Fi and cellular data both off; re-check after several minutes of use, not only at first launch) | Discovery, pairing and audio exchange all continue to work with zero internet connectivity throughout, not only at the moment of install (§4: the internet is completely absent) |
| 22 | Throughout onboarding, pairing and the main flow, confirm no login screen, account-creation prompt, room-code entry or backend/server configuration is ever presented | None appears at any point: talking starts directly from discovery and pairing, with no account, no rooms and no backend (§4) |

## When a row fails

Record the row, the device, the platform and the observed behaviour. A failure in a merged
engine, bridge or screen is reported against *that* plan, not against this one — this plan's
boundary is wiring, and repairing an engine here would hide which stage actually broke.
