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
| `AlwaysHotBackgroundManager.swift` | the always-hot audio session: route detection, activation, interruptions |
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
2. Set a development team and provisioning profile. No special entitlement is
   needed: background execution comes from the `audio` UIBackgroundMode and the
   always-hot session (spec section 10.2), which is precisely why the
   PushToTalk framework — whose entitlement requires a paid account — was
   dropped on 2026-08-18.
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
  Transmit from Android. Expect `[spike] state ... rx=true` within a second and
  audible speech.
- **Scenario B — iPhone PTT, locked Android plays audio.** There is no
  system-provided talk button on the lock screen any more: with PushToTalk gone,
  transmit is raised only by the Bluetooth button (Scenario C) or by
  `RadioSpike.startTransmit()` from the debugger with the phone unlocked. Run it
  the second way to confirm `[spike] state ... tx=true` and audio on Android,
  then treat Scenario C as the locked-screen transmit case.
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

## Before you conclude anything

Four ways these scenarios mislead an operator, all of them seen in the log rather
than in the app:

- **`tx=true` proves the microphone is open, not that anything went on air.**
  Read `nearby=N` from the same line: with zero peers the transmission runs to
  completion and logs exactly as it does when it succeeds. A pass needs
  `nearby=1` *and* audio heard on the other device.
- **Reception on a locked iPhone only works while the process is still
  resident.** The MVP has no server, so no push token is registered anywhere,
  and `UIBackgroundModes` does not include `audio` — nothing will wake or hold a
  suspended app for an incoming transmission. A scenario A failure is more
  likely the app having been suspended than Nearby having failed; relaunch and
  retry before recording a No-Go.
- **Scenario C gives you about 15 seconds** (`RadioConfig.Ptt.autoSelectFallback`)
  between the first `phase=scanning candidates=[...]` line and the
  strongest-signal fallback firing. The scan is unfiltered, so that list will be
  full of nearby AirPods, watches and TVs: spot the button and call
  `RadioSpike.selectPttCandidate` quickly, or hold the button against the phone
  and let the fallback pick the strongest signal for you.
- **A transport error is terminal for the session.** It puts the radio in
  `.error`, and every later press is ignored in silence. After one, restart the
  radio from the debugger console — `RadioAssembly.shared.engine.stopRadio()`
  then `.startRadio()` — or relaunch the app, before you judge anything that
  follows it.

Record the outcome and an explicit **Go** or **No-Go** in
`docs/superpowers/specs/2026-08-13-phase0-spike-report.md`. A No-Go means the
transport is replaced before anything else is built — which is why every
Nearby call in this package sits behind `RadioTransport` in one file.
