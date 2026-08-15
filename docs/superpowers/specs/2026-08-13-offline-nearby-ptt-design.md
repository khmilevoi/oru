# Offline Nearby PTT — MVP Specification

Status: approved for planning
Date: 2026-08-13
Source: "Offline Nearby PTT — Technical Design" (author's technical design document); decisions refined and approved in brainstorming session.

## 1. Product definition

An offline walkie-talkie app for Android and iOS. Devices running the app automatically
discover and connect to each other nearby, forming one shared local "air". Holding a PTT
control (on-screen button or a paired external Bluetooth button) transmits the user's voice
to every connected device. Incoming audio plays automatically, including when the phone is
locked in a pocket.

Core concept: **who is nearby → is connected → hears you.**

There are no accounts, servers, rooms, channels, contacts, recipient selection, or message
history.

## 2. Goals

1. Zero-configuration operation: launch once, devices connect automatically.
2. Hold-to-talk from the on-screen button and from one external Bluetooth PTT button.
3. Full background operation: transmit and receive with the screen locked.
4. Automatic reconnection of both peers and the PTT button after signal loss.
5. Works with the internet fully absent.

## 3. Non-goals (out of MVP scope)

- Air ownership / floor control on collisions (concurrent transmitters are mixed at the receiver).
- Support for arbitrary PTT buttons (one concrete purchased button is the target).
- iOS 26 Live Activity Bluetooth optimization (deferred; noted as a future option).
- Application-level encryption (relies on Nearby Connections' built-in connection encryption).
- Recording, history, or any persistence of audio.
- Mesh relay: only directly connected peers hear a transmission; no forwarding.

## 4. Definition of Done

The MVP is complete only if all of the following hold:

- Android and iPhone discover each other automatically.
- The internet is completely absent.
- No account is required; there are no rooms and no backend.
- PTT works from the screen.
- The Bluetooth PTT button works.
- The phone can be locked.
- The physical button starts transmission while the phone is locked.
- The other locked phone automatically plays the received speech.
- The connection recovers after a brief signal loss.
- React Native can be inactive while radio functionality continues to work.

## 5. Approved decisions and assumptions

| Topic | Decision |
|---|---|
| RN foundation | Bare React Native, New Architecture (Turbo Native Modules), TypeScript |
| UI state | Reatom v1001 (`atom`, `computed`, `effect`, `atom.extend`) |
| Minimum OS | iOS 16+ (PushToTalk framework requirement); Android 8.0+ (minSdk 26) |
| Android permissions model | Implemented against Android 12+ Bluetooth permissions and Android 14 foreground-service-type rules |
| Group size | Designed for 2–8 devices; acceptance tests run with 3 |
| Audio routing | System default route (speaker or connected headset); no in-app route picker |
| TS error handling | errore convention — errors as values (`Error \| T` unions), no thrown domain errors |
| Encryption | Nearby Connections built-in only |
| Transmit safety cap | Auto-stop transmission after 120 s of continuous hold (stuck-button protection) |
| Localization | English (default) + Russian via Lingui; language follows the system locale, English fallback |
| Target PTT button | Unbranded BLE PTT button (marketplace listing: manufacturer code 687266, EAN 4005658953957); protocol unknown, resolved in Stage 5 via reverse engineering |

## 6. Architecture

Three layers with a strict dependency rule: **radio functionality must not depend on React
Native or the JavaScript runtime.**

```text
┌──────────────────────────────────────┐
│    React Native (bare, TS, Fabric)   │
│    UI + Reatom v1001 state mirror    │
│    RadioScreen / Settings / Onboard  │
└──────────────────┬───────────────────┘
                   │ Turbo Native Module (RadioNative)
                   ▼
┌──────────────────────────────────────┐
│         Native RadioEngine           │
│  NearbyManager   AudioEngine         │
│  PttManager      BackgroundManager   │
└──────────────────────────────────────┘
```

- **React Native** renders UI and forwards user intent. It never touches audio frames,
  Opus, Nearby endpoint IDs, BLE characteristics, or background execution.
- **Reatom** holds a mirror of engine state. It is **not** the source of truth for realtime
  radio state; the native engine is. Reatom receives snapshots (`getState()`) and events.
- **RadioEngine** (Kotlin on Android, Swift on iOS) is the actual radio. The PTT path from
  a button press to the start of transmission runs entirely in native code, bypassing JS.
  JS is only notified afterwards via `stateChanged`.

### 6.1 Native API contract

One high-level Turbo Native Module:

```ts
interface RadioNative {
  start(): Promise<void>
  stop(): Promise<void>

  pressPtt(): Promise<void>
  releasePtt(): Promise<void>

  getState(): Promise<RadioState>

  configurePtt(): Promise<PttConfiguration>
  forgetPtt(): Promise<void>
}

type RadioNativeEvent =
  | { type: 'stateChanged'; state: RadioState }
  | { type: 'error'; code: string; message: string }

type PttConfiguration = { name: string; binding: PttBinding }  // result of the learning flow

type RadioState = {
  status: 'starting' | 'ready' | 'error'
  nearbyCount: number
  transmitting: boolean
  receiving: boolean
  pttButton: {
    configured: boolean
    connected: boolean
    name?: string
  }
}
```

### 6.2 Reatom model

```ts
export const radio = atom<RadioState>(initialState).extend((target) => ({
  async sync() { target.set(await RadioNative.getState()) },
  async start() { await RadioNative.start(); await this.sync() },
  pressPtt() { void RadioNative.pressPtt() },
  releasePtt() { void RadioNative.releasePtt() },
}))

export const screenState = computed(() =>
  radio().transmitting ? 'transmitting'
  : radio().receiving ? 'receiving'
  : radio().nearbyCount === 0 ? 'searching'
  : 'ready')
```

On UI start or resume: `getState()` → Reatom sync, then live `stateChanged` events keep the
mirror current. If the UI was suspended, the native radio kept working; resume only re-syncs.

### 6.3 RadioEngine internal operations

`startRadio / stopRadio`, `startTransmit / stopTransmit`, `peerConnected / peerDisconnected`,
`incomingAudioStarted / incomingAudioStopped`.

## 7. Transport and protocol

- **Transport:** Google Nearby Connections, strategy `P2P_CLUSTER` (M:N). Android uses Google
  Play Services Nearby; iOS uses Google's official NearbyConnections Swift library.
- Every device simultaneously advertises and discovers with a shared constant Service ID.
  Connections are accepted automatically; there is no peer-selection UI.
- **Control messages** (reliable BYTES payloads, JSON):

  ```ts
  type ControlMessage =
    | { type: 'hello'; version: 1 }
    | { type: 'tx-start'; streamId: string }
    | { type: 'tx-stop'; streamId: string }
  ```

  On `hello` version mismatch the peer disconnects gracefully and is ignored.
  `streamId` is a transmitter-generated UUID, unique per transmission.
- **Audio** travels as a separate Nearby STREAM payload — one stream per transmission
  (press → release). The transmitter fans out to each connected peer directly.
- **Collisions:** no floor control. A receiver mixes concurrent incoming streams; the
  practical design limit is 2 simultaneous transmitters.
- **Reconnect** is fully native: discovery continues; a lost peer is re-discovered and
  re-connected automatically with backoff. JS is not involved.

## 8. Audio pipeline

```text
Microphone → PCM 16 kHz mono → Opus (20 ms frames, ~24 kbps)
  → Nearby STREAM → Opus decode → 2–3 frame jitter buffer (40–60 ms) → playback
```

- Codec parameters live in a single native engine config so they can be tuned after field
  tests without touching logic.
- **Codec implementation: embedded libopus on both platforms** (Android via an NDK wrapper,
  iOS via a Swift module). Platform codecs are not used: Opus encoding support is
  inconsistent across Android devices and absent from public iOS APIs.
- Android: capture via `AudioRecord` with `VOICE_COMMUNICATION` source (system AEC/NS),
  playback via `AudioTrack`.
- iOS: `AVAudioEngine` for capture/playback; background audio-session activation is
  delegated to the PushToTalk framework.
- JS never receives audio frames.

## 9. PTT subsystem

### 9.1 PttManager and drivers

```text
PttManager
├── BleGattPttDriver      (preferred; background-capable on both OSes)
├── HidPttDriver          (fallback; realistically Android-only in background)
└── MediaButtonPttDriver  (fallback; Android)
```

The external button pairs with its **own** phone; the phone relays voice over Nearby.

### 9.2 Binding

```ts
type PttBinding =
  | { type: 'ble'; deviceId: string; serviceUuid: string; characteristicUuid: string;
      pressedValue: string; releasedValue: string }
  | { type: 'hid'; keyCode: number }
```

Stored natively (SharedPreferences / UserDefaults). After configuration the app
automatically reconnects to the last button, including after radio restarts.

### 9.3 Configuration (learning) flow

```text
[ Подключить ] → BLE scan → pick device → "press the PTT button"
  → capture notify characteristic + pressed/released values → save binding
```

### 9.4 Semantics

- Strictly hold-to-talk: `PRESSED → RadioEngine.startTransmit()`,
  `RELEASED → RadioEngine.stopTransmit()`.
- Safety cap: transmission auto-stops after 120 s of continuous hold.
- The on-screen button uses the same engine path via `pressPtt()` / `releasePtt()`
  (`onPressIn` / `onPressOut`).

### 9.5 Target button

The purchased button is unbranded and undocumented (listing: manufacturer code 687266,
EAN 4005658953957, model 2610230166611). Its protocol is discovered in Stage 5 by reverse
engineering (nRF Connect GATT inspection). See risk R2.

## 10. Background architecture

### 10.1 Android

Radio runs inside `RadioForegroundService` (foreground service types `microphone` +
`connectedDevice`, persistent notification). The React Native Activity may be destroyed
independently; the service and engine keep working.

### 10.2 iOS

- **Transmit lifecycle:** the system **PushToTalk framework** (`PTChannelManager`,
  entitlement `com.apple.developer.push-to-talk`). On a BLE press:
  `CoreBluetooth callback → requestBeginTransmitting() → system activates the audio
  session → engine starts the microphone → Nearby transmit`. PushToTalk is **not** the
  transport — the app encodes and streams audio itself over Nearby.
- **BLE wake-ups:** `bluetooth-central` background mode; iOS wakes the suspended app on
  characteristic changes.
- **Incoming audio while suspended is the project's #1 risk** (see R1): there is no
  documented guarantee that an active Nearby connection will keep waking a suspended iOS
  app for incoming realtime audio. This is exactly what Phase 0 must prove.

### 10.3 Go / No-Go condition

If "locked iPhone + incoming Nearby stream" cannot be made reliable with Nearby
Connections, the transport / background architecture must change **before any further
development**. No UI or Bluetooth-configuration work is built on a transport that fails
the core scenario.

## 11. Permissions

| Platform | Permission / declaration | Purpose |
|---|---|---|
| Android | `RECORD_AUDIO` | microphone |
| Android | `BLUETOOTH_SCAN`, `BLUETOOTH_CONNECT`, `BLUETOOTH_ADVERTISE` | Nearby + PTT button |
| Android | `NEARBY_WIFI_DEVICES` (13+) plus `ACCESS_FINE_LOCATION` (all versions, unconditionally -- Nearby Connections' BLE medium requires it on every API level regardless of `NEARBY_WIFI_DEVICES`; see Bug found #3, `docs/superpowers/specs/2026-08-13-phase0-spike-report.md`) | Nearby discovery |
| Android | `POST_NOTIFICATIONS`, `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_MICROPHONE`, `FOREGROUND_SERVICE_CONNECTED_DEVICE` | foreground service |
| iOS | `NSMicrophoneUsageDescription` | microphone |
| iOS | `NSBluetoothAlwaysUsageDescription` | PTT button |
| iOS | `NSLocalNetworkUsageDescription` + Bonjour services | Nearby discovery/transfer |
| iOS | UIBackgroundModes: `push-to-talk`, `bluetooth-central`; entitlement `com.apple.developer.push-to-talk` | background operation |

Permissions onboarding: a short sequence of screens, each explaining one permission in the
app language before triggering the system prompt.

## 12. UI specification

Four main-screen states driven by `screenState`; the whole screen is effectively one giant
PTT touch area with a settings gear in a corner.

| State | Content (EN / RU) |
|---|---|
| `searching` | "SEARCHING FOR DEVICES..." / «ИЩЕМ УСТРОЙСТВА...» + subtle scanning cue |
| `ready` | "● N nearby" + "HOLD TO TALK" / «● N рядом» + «УДЕРЖИВАЙТЕ ЧТОБЫ ГОВОРИТЬ» |
| `transmitting` | "TRANSMITTING..." + "RELEASE TO FINISH" / «ПЕРЕДАЧА...» + «ОТПУСТИТЕ ЧТОБЫ ЗАКОНЧИТЬ» — strong peripheral-visible change |
| `receiving` | "RECEIVING..." / «ПРИЁМ...» — clearly distinct from transmitting |

Settings screen: a single "PTT button" section — configured (name, "Connected", actions
"Test" / "Replace") or not configured ("Not connected", "Connect" → learning flow).

### 12.1 Visual design

The visual design lives in the Claude Design project **"Offline Nearby PTT"**:
<https://claude.ai/design/p/d07936f3-e452-4039-bda7-bb80b599e104>

- Screens: `01 Radio` (four states + alternate-locale frame), `02 Settings` (configured /
  not configured), `03 Pairing` (scan → pick → learn → saved), `04 Onboarding`
  (microphone, Bluetooth, nearby devices, done) — phone frames 390×844.
- Direction: dark, high-contrast "radio hardware" aesthetic; status colors TX = red,
  RX = green, button learning = amber; Oswald + IBM Plex Mono (Cyrillic-capable).
- Every file exposes a `lang` tweak (`en` default / `ru`) switching the whole canvas
  between locales; animations respect `prefers-reduced-motion`.
- The design refines the pairing flow to four steps and onboarding to three permission
  steps plus a final screen; both refinements are part of this spec.

### 12.2 Localization

- Two locales: **English (default)** and **Russian**. The app language follows the system
  locale; anything other than Russian falls back to English. No in-app language picker.
- JS strings are managed with **Lingui** (`@lingui/core` + `@lingui/react`, macros):
  source copy is written inline in English via the `Trans` / `t` macros; `lingui extract`
  produces `.po` catalogs for `en` and `ru`, loaded through `@lingui/metro-transformer`
  (bare React Native Metro config). On startup `i18n.loadAndActivate()` selects the system
  locale with `en` fallback.
- Native-side strings are localized through platform resources: the Android
  foreground-service notification via `strings.xml`, iOS permission texts via
  `InfoPlist.strings`, and the PushToTalk channel name shown in system UI via
  `Localizable.strings`.

## 13. Error handling

- The engine reports failures as `error { code, message }` events and enters
  `status: 'error'` when unrecoverable; the UI shows an error state with a restart action.
- Recoverable conditions (peer lost, button disconnected) are **state**, not errors —
  reflected in `RadioState` and retried natively.
- TypeScript layer follows the errore convention: fallible functions return
  `Error | T`; no thrown domain errors.

## 14. Risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | Suspended iOS app may not reliably receive incoming Nearby audio | Phase 0 spike proves or refutes on physical devices; hard Go/No-Go gate before any further work |
| R2 | The unbranded button may be HID-only, which cannot drive background PTT on iOS | GATT path is mandatory for iOS; if the button is HID-only, it remains Android-only and a GATT-capable button is purchased for iOS |
| R3 | Nearby Connections iOS library maturity/behavior differs from Android | Spike exercises the exact Android↔iPhone pairs; No-Go path allows transport replacement |
| R4 | OS battery optimization kills long-running background operation | Stage 6 reliability matrix (5 min / 30 min / hours locked) validates; Android battery-exemption prompt added only if the matrix fails |

## 15. Development phases

### Phase 0 — Background feasibility spike (gate)

No UI. Two physical devices (Android + iPhone), internet off, screens locked. Prove:

- A: Android PTT → locked iPhone plays audio.
- B: iPhone BLE PTT → locked Android plays audio.
- C: locked iPhone BLE PTT → microphone starts → Android receives audio.
- D: devices separated beyond range and returned → connection restores automatically.

Deliverable: a written spike report and an explicit **Go / No-Go** decision. On No-Go this
spec's transport sections are revised before any further stage.

### Stage 1 — Native RadioEngine

`start/stop`, peer connections, native audio pipeline, PTT — without React Native.
Acceptance: two devices exchange voice driven by native test hooks.

### Stage 2 — React Native bridge

`RadioNative` Turbo Module: `start`, `stop`, `pressPtt`, `releasePtt`, `getState`,
`configurePtt`, `forgetPtt` + event stream. Acceptance: JS can drive a full session.

### Stage 3 — Reatom

`radioState`, `screenState`, native event synchronization, resume re-sync.
Acceptance: unit tests for the model; state mirrors engine through suspend/resume.

### Stage 4 — Minimal UI

RadioScreen (4 states), Settings, permissions onboarding. Acceptance: full flow on both
platforms from install to talking.

### Stage 5 — The concrete Bluetooth button

Reverse engineer the purchased button (nRF Connect), implement the matching driver, wire
the learning flow end-to-end. Acceptance: button drives transmission with the phone locked
(per R2, iOS acceptance applies only if the button exposes GATT).

### Stage 6 — Background reliability

Matrix: 5 min / 30 min / multi-hour locked operation; PTT-button loss and reconnect; peer
loss and reconnect; incoming phone call; Bluetooth headphones connect; audio route switch.
Acceptance: Definition of Done (section 4) holds in full.

## 16. Testing strategy

- **Automated:** control-message codec (TS + native), Reatom model tests, `PttBinding`
  parsing/persistence.
- **Physical devices are the only source of truth** for Nearby, BLE, and background
  behavior — simulators cannot emulate them. Each stage carries a short written manual
  acceptance checklist executed on real Android + iPhone hardware; the Stage 6 matrix is
  the final MVP acceptance.

## 17. Project structure

```text
src/
├── app/app.model.ts
├── radio/{radio.model.ts, radio.native.ts, radio.types.ts}
├── screens/{RadioScreen.tsx, SettingsScreen.tsx}
└── ptt/ptt.types.ts

specs/NativeRadio.ts

android/app/radio/
├── RadioEngine.kt
├── NearbyManager.kt
├── AudioEngine.kt
├── PttManager.kt
└── RadioForegroundService.kt

ios/Radio/
├── RadioEngine.swift
├── NearbyManager.swift
├── AudioEngine.swift
├── PttManager.swift
└── BackgroundManager.swift
```

## 18. Guiding principle

```text
React Native  = the interface
Reatom v1001  = application/UI state
RadioEngine   = the radio itself

The UI may die. JS may sleep. The RadioEngine must keep working.
```
