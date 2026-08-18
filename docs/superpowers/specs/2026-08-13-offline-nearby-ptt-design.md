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
| Minimum OS | iOS 16+ (originally the PushToTalk framework's floor; kept after PushToTalk was dropped on 2026-08-18, see §10.2); Android 8.0+ (minSdk 26) |
| Android permissions model | Implemented against Android 12+ Bluetooth permissions and Android 14 foreground-service-type rules |
| Group size | Designed for 2–8 devices; acceptance tests run with 3 |
| Audio routing | System default route (speaker or connected headset); no in-app route picker |
| TS error handling | errore convention — errors as values (`Error \| T` unions), no thrown domain errors |
| Encryption | Nearby Connections built-in only |
| Transmit safety cap | Auto-stop transmission after 120 s of continuous hold (stuck-button protection) |
| Radio power switch | An explicit radio on/off toggle is a **first-class control on the main screen, not a settings item**. Rationale: the always-hot architecture keeps the microphone and the audio session live for as long as radio mode is on, so the battery cost is inherent to the design and the user must be able to cut it in one deliberate action. Source: the product note "radio power switch is a design requirement (verbatim intent)" in `docs/superpowers/specs/2026-08-13-phase0-spike-report.md`. Goes through the design stage (§12, §12.1, §15 Stage 2) and then implementation |
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
  status: 'off' | 'starting' | 'ready' | 'error'
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

`status: 'off'` is the state the radio is in **before `start()` and after `stop()`**: nothing is
advertising, discovering, capturing or playing, and the mirror carries no peers. It exists because
the main screen owns a first-class power toggle (§5, §12) and, by §6.4's own rule, a fact a screen
needs but the contract does not carry means the contract is extended rather than reached around —
so this is a contract extension, not a UI-local flag. The TS types (`src/radio/radio.types.ts`) and
the mock engine (§6.5) pick `'off'` up in the design stage (§15 Stage 2); the real bridge maps the
engines' stopped state onto it in Stage 3.

### 6.2 Reatom model

```ts
export const radio = atom<RadioState>(initialState).extend((target) => ({
  async sync() { target.set(await RadioNative.getState()) },
  async start() { await RadioNative.start(); await this.sync() },
  async stop() { await RadioNative.stop(); await this.sync() },
  pressPtt() { void RadioNative.pressPtt() },
  releasePtt() { void RadioNative.releasePtt() },
}))

export const screenState = computed(() =>
  radio().status === 'off' ? 'off'
  : radio().transmitting ? 'transmitting'
  : radio().receiving ? 'receiving'
  : radio().nearbyCount === 0 ? 'searching'
  : 'ready')
```

The main screen's power toggle needs no new action of its own: it drives the model's existing
`start()` / `stop()`, and `off` becomes visible through `status` the same way every other state
does.

On UI start or resume: `getState()` → Reatom sync, then live `stateChanged` events keep the
mirror current. If the UI was suspended, the native radio kept working; resume only re-syncs.

### 6.3 RadioEngine internal operations

`startRadio / stopRadio`, `startTransmit / stopTransmit`, `peerConnected / peerDisconnected`,
`incomingAudioStarted / incomingAudioStopped`.

### 6.4 Design-first ordering and UI independence

**The design is implemented first; the internals are wired underneath it afterwards.**

Every screen of §12 and §12.1 — Radio with its five states and its power toggle, Settings, the
four-step pairing flow, onboarding, the error state — is built, runnable and accepted before
any further work on the bridge, the integration layer or background behaviour. §15 orders the
stages accordingly.

Ordering the work this way is only safe because of a structural rule, implied by the layering
above and made binding here:

> The UI layer depends on the `RadioNative` contract (§6.1) and on nothing else. It never
> references a Turbo Module, a transport, a platform or a device — directly or transitively.

Concretely:

- Screens read the Reatom model (§6.2) and call its actions. They do not import
  `radio.native.ts`, `TurboModuleRegistry`, or any API that only behaves correctly on a
  device.
- Everything a screen renders comes from `RadioState` plus the `stateChanged` / `error`
  event stream. If a screen needs a fact the contract does not carry, the contract is
  extended — the screen does not reach around it.
- What the OS owns rather than the engine (the runtime permission prompts behind onboarding)
  goes through a port of the same shape, so it too can be answered by a mock.

The consequences are the point of the rule:

- The UI builds and runs with **zero native code present** — no device, no entitlement, no
  pairing hardware, no Nearby session in the loop.
- The UI is acceptance-testable on its own (§15 Stage 2).
- Swapping the mock for the real Turbo Module later is a **one-line binding change** and must
  require no UI rework. Needing UI rework is a violation of this rule, not a task for the
  integration stage.
- Nothing the transport decision could still change (§10.3) can invalidate UI work.

```text
        ┌───────────────────────────────────┐
        │      Screens (§12, §12.1)         │
        └─────────────────┬─────────────────┘
                          │ Reatom model (§6.2)
                          ▼
        ┌───────────────────────────────────┐
        │      RadioNative contract (§6.1)  │  ← the only thing the UI knows
        └────────┬─────────────────┬────────┘
                 │                 │
   radio.native.mock.ts     radio.native.ts → Turbo Module → RadioEngine
   (dev / demo / UI                (production binding)
    acceptance, §6.5)
```

### 6.5 Mock engine

`src/radio/radio.native.mock.ts` is a pure TypeScript implementation of the §6.1 contract.
It is the enabler that makes the design-first order a non-problem, and the acceptance vehicle
for the design stage.

- **Complete.** It implements every method of the Turbo Module spec (`specs/NativeRadio.ts`),
  including the candidate-selection step the four-step pairing flow of §9.3 needs, and emits
  both `stateChanged` and `error` events.
- **Deterministic.** No randomness, no real I/O, no network, no BLE. All timing goes through
  an injectable clock, so tests advance it instead of waiting and two runs are identical.
- **Drives every UI surface** through named scenarios:

  | Scenario | What it drives |
  |---|---|
  | `happy` | `starting → searching → ready` as the peer count rises; scripted inbound transmission → `receiving`; `pressPtt`/`releasePtt` → `transmitting` and back |
  | `solo` | never finds a peer — `searching` holds indefinitely |
  | `pairing-success` | `configurePtt` yields a scripted candidate list → selection → scripted learn result → saved binding |
  | `pairing-empty` | the scan finds nothing; the pairing flow's empty / retry path |
  | `button-lost` | a configured button flips to `connected: false` and back — the "state, not error" path of §13 |
  | `engine-error` | an `error` event plus `status: 'error'`, so the error screen and its restart action can be exercised |
  | `onboarding` | the scripted permission gateway answers granted / denied / permanently-denied in turn |

- **Every scenario honours `start()` / `stop()`,** so the main screen's power toggle (§5, §12) is
  fully exercisable against the mock. `stop()` from any point in any script yields
  `status: 'off'` with `nearbyCount: 0`, peers cleared and transmit/receive false; `start()`
  re-enters the scenario's script from its beginning (`starting → …`). Per §6.1 the mock reports
  `'off'` until the first `start()`, in every scenario.
- **Selected by a build-time flag**, resolved once where the binding is already chosen:

  ```ts
  // src/radio/radio.native.ts
  const backend = __DEV__ ? process.env.RADIO_BACKEND ?? 'mock' : 'native'

  export const RadioNative = createRadioNative(
    backend === 'mock' ? resolveMockRadio : resolveRadioNativeModule,
  )
  ```

  `__DEV__` and `RADIO_BACKEND` are both inlined at build time (the latter by Babel's
  `babel-plugin-transform-inline-environment-variables`), so `backend` is a compile-time
  constant and the unused branch — the whole mock module with it — is dropped from release
  bundles. A release build is always `native`: the flag cannot reach it and nothing can switch
  it at runtime. While the Turbo Module does not exist yet the dev default is `mock`; once the
  bridge lands (§15 Stage 3) the dev default becomes `native`, and `RADIO_BACKEND=mock` remains
  available for design work, demos and screenshots. Switching scenarios inside a running dev
  build is one Dev Menu entry per scenario, registered with `DevSettings.addMenuItem` under
  `__DEV__`; tests set the scenario directly.
- **The real Turbo Module is the production binding.** The mock is a development tool, never
  a fallback: it is not selected because the native module is missing, only because the flag
  says so.

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
- iOS: `AVAudioEngine` for capture/playback. The app owns the `AVAudioSession` itself:
  `AlwaysHotBackgroundManager` runs the route detection, sets the category and activates
  the session once, and it stays active for as long as the radio runs (§10.2). Nothing
  else may call `setActive` or `setCategory` — re-activating mid-session collapses a
  resolved Bluetooth route.
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

**Always-hot audio session** (decided 2026-08-18). The app keeps one `.playAndRecord`
`AVAudioSession` active for the whole time the radio is on, and `AudioEngine`'s
keep-alive tap keeps the microphone delivering buffers even when nobody is transmitting.
Continuous recording is what qualifies as background audio under the `audio`
UIBackgroundMode, so the process legally keeps running while the screen is locked. No
entitlement is involved.

- **Ownership:** `AlwaysHotBackgroundManager` is the only `BackgroundSession`
  implementation. It runs the two-phase route detection (permissive category first, or
  Bluetooth ports are invisible to `availableInputs`), activates the session, and watches
  route changes and interruptions. `AudioEngine` never touches category or activation
  outside `#if DEBUG`.
- **Transmit lifecycle:** on a BLE press, `CoreBluetooth callback →
  BackgroundSession.requestBeginTransmitting() → the manager acknowledges immediately
  (the session is already active) → engine starts the microphone → Nearby transmit`. The
  port keeps its "the session became active" callback so the engine's ordering never
  depends on which implementation is behind it.
- **BLE wake-ups:** `bluetooth-central` background mode; iOS wakes the suspended app on
  characteristic changes.
- **Cost:** a permanently open microphone is a real battery and privacy cost, and the
  orange recording indicator is always lit. This is the reason the radio power toggle is a
  first-class main-screen control (§5, §12) rather than something hidden in Settings.
- **Watch item:** the session is ours, not the system's, so a phone call or Siri can take
  it, and iOS refuses re-activation from the background. Every interruption is written to
  `heartbeat.log`; a locked-screen run that fails to reactivate is the failure mode to
  look for.
- **Incoming audio while suspended is the project's #1 risk** (see R1): there is no
  documented guarantee that an active Nearby connection will keep waking a suspended iOS
  app for incoming realtime audio. This is exactly what Phase 0 must prove.

**Rejected alternative — the system PushToTalk framework** (`PTChannelManager`,
entitlement `com.apple.developer.push-to-talk`). It was the original design here, and it
is the better one on paper: the system owns the session, supplies a lock-screen talk
button, and survives interruptions the always-hot session does not. It was implemented
and then removed on **2026-08-18**, for two reasons:

1. `com.apple.developer.push-to-talk` is granted only to a **paid Apple Developer
   account**. On the free Personal Team the app cannot join a channel at all, and the
   failure is not catchable in Swift — the process exits before any `try`/`catch` around
   `PTChannelManager.channelManager(...)` runs.
2. On-device runs of the always-hot path on both an Android and an iPhone device
   confirmed it works at the basic level, so the entitlement bought nothing that was
   still missing.

Keeping the implementation behind a mode switch nothing could select would have meant
maintaining a second, untestable audio-session path forever. If a paid account is
obtained later, this section is where the decision gets revisited; the `BackgroundSession`
port was designed for exactly that substitution.

### 10.3 Go / No-Go condition

If "locked iPhone + incoming Nearby stream" cannot be made reliable with Nearby
Connections, the transport / background architecture must change **before any further
transport-dependent development**. Until the gate passes, nothing that touches the transport
is built on it: bridging the Turbo Module to the real engines (§15 Stage 3), integration
(Stage 4), and background reliability work (Stage 6) all wait.

**UI and design work is explicitly exempt from this gate.** By §6.4 the UI depends only on
the §6.1 contract, and by §6.5 it is built and accepted against the mock engine with no
device and no native code in the loop. Replacing the transport changes what fills
`RadioState`, not the shape of `RadioState` — so design work done before or during the gate
survives a No-Go unchanged, and there is no transport for it to be "built on" in the first
place. This is why the design stage runs first (§15 Stage 2) rather than waiting.

Bluetooth configuration splits along the same line: the pairing **screens** are UI and are
exempt; the native learning **drivers** and the concrete button (Stage 5) are engine work and
are not.

## 11. Permissions

| Platform | Permission / declaration | Purpose |
|---|---|---|
| Android | `RECORD_AUDIO` | microphone |
| Android | `BLUETOOTH_SCAN`, `BLUETOOTH_CONNECT`, `BLUETOOTH_ADVERTISE` | Nearby + PTT button |
| Android | `NEARBY_WIFI_DEVICES` (13+) plus `ACCESS_FINE_LOCATION` (all versions, unconditionally -- Nearby Connections' BLE medium requires it on every API level regardless of `NEARBY_WIFI_DEVICES`; see Bug found #3, `docs/superpowers/specs/2026-08-13-phase0-spike-report.md`) | Nearby discovery |
| Android | `ACCESS_BACKGROUND_LOCATION` (Bug #5, `docs/superpowers/specs/2026-08-13-phase0-spike-report.md`: without it, Nearby's rediscovery of a lost peer silently and permanently stalls a few minutes after the app has no visible Activity -- exactly the locked/pocketed-phone use case) | Nearby rediscovery while backgrounded |
| Android | `POST_NOTIFICATIONS`, `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_MICROPHONE`, `FOREGROUND_SERVICE_CONNECTED_DEVICE` | foreground service |
| iOS | `NSMicrophoneUsageDescription` | microphone |
| iOS | `NSBluetoothAlwaysUsageDescription` | PTT button |
| iOS | `NSLocalNetworkUsageDescription` + Bonjour services | Nearby discovery/transfer |
| iOS | UIBackgroundModes: `audio`, `bluetooth-central`; no entitlement (the always-hot session replaced PushToTalk on 2026-08-18, §10.2) | background operation |

Permissions onboarding: a short sequence of screens, each explaining one permission in the
app language before triggering the system prompt. `ACCESS_BACKGROUND_LOCATION` still needs its
own step here (Play Store Data Safety disclosure plus Android's two-step "Allow all the time"
Settings redirect, since it cannot be granted from a normal permission dialog on API 30+) --
not built yet, open work for P7.

## 12. UI specification

Five main-screen states driven by `screenState`; the whole screen is effectively one giant
PTT touch area with a settings gear in a corner and a **radio power toggle as a first-class
control** (§5) — the one deliberate way to turn the always-hot radio, and its battery cost, on
and off. The toggle is on the main screen and never behind Settings; it drives the model's
`start()` / `stop()` (§6.2).

| State | Content (EN / RU) |
|---|---|
| `off` | "RADIO OFF" + "TAP TO TURN ON" / «РАЦИЯ ВЫКЛЮЧЕНА» + «НАЖМИТЕ ЧТОБЫ ВКЛЮЧИТЬ» — visibly dead air: no scanning cue, PTT area inert, clearly distinct from `searching` |
| `searching` | "SEARCHING FOR DEVICES..." / «ИЩЕМ УСТРОЙСТВА...» + subtle scanning cue |
| `ready` | "● N nearby" + "HOLD TO TALK" / «● N рядом» + «УДЕРЖИВАЙТЕ ЧТОБЫ ГОВОРИТЬ» |
| `transmitting` | "TRANSMITTING..." + "RELEASE TO FINISH" / «ПЕРЕДАЧА...» + «ОТПУСТИТЕ ЧТОБЫ ЗАКОНЧИТЬ» — strong peripheral-visible change |
| `receiving` | "RECEIVING..." / «ПРИЁМ...» — clearly distinct from transmitting |

The **exact visual form** of the power control — a switch, a hardware-style power key, a long-press
on the PTT area, the copy above — is decided in the design project (§12.1). What is fixed here and
not open for the design to reinterpret: it is on the main screen, it is first-class rather than a
settings item, and `off` is a full main-screen state, not a dimmed variant of `searching`.

Settings screen: a single "PTT button" section — configured (name, "Connected", actions
"Test" / "Replace") or not configured ("Not connected", "Connect" → learning flow).

Per §6.4 every screen here is built and accepted against the mock engine (§6.5) before the
internals are wired underneath it; §15 Stage 2 is that stage and carries its acceptance.

### 12.1 Visual design

The visual design lives in the Claude Design project **"Offline Nearby PTT"**:
<https://claude.ai/design/p/d07936f3-e452-4039-bda7-bb80b599e104>

- Screens: `01 Radio` (five state frames `off → searching → ready → transmitting →
  receiving` + alternate-locale frames for `off` and `ready`), `02 Settings` (configured /
  not configured), `03 Pairing` (scan → pick → learn → saved), `04 Onboarding`
  (microphone, Bluetooth, nearby devices, done) — phone frames 390×844.
- Direction: dark, high-contrast "radio hardware" aesthetic; status colors TX = red,
  RX = green, button learning = amber; Oswald + IBM Plex Mono (Cyrillic-capable).
- Every file exposes a `lang` tweak (`en` default / `ru`) switching the whole canvas
  between locales; animations respect `prefers-reduced-motion`.
- The design refines the pairing flow to four steps and onboarding to three permission
  steps plus a final screen; both refinements are part of this spec.
- **Power control (designed 2026-08-18, closing the §5 power-switch decision):** the control
  is a hardware-style IEC power key. In `off` the whole screen is the on-switch — the key
  drawn large at center over visibly dead air ("TAP TO TURN ON"). When the radio is on, a
  small power key mirrors the settings gear in the opposite corner, receding while
  transmitting/receiving, and turning the radio off is a **press-and-hold** — a guard against
  accidental shut-off on a screen that is one giant touch area. Like the pairing and
  onboarding refinements above, these refinements are part of this spec.

### 12.2 Localization

- Two locales: **English (default)** and **Russian**. The app language follows the system
  locale; anything other than Russian falls back to English. No in-app language picker.
- JS strings are managed with **Lingui** (`@lingui/core` + `@lingui/react`, macros):
  source copy is written inline in English via the `Trans` / `t` macros; `lingui extract`
  produces `.po` catalogs for `en` and `ru`, loaded through `@lingui/metro-transformer`
  (bare React Native Metro config). On startup `i18n.loadAndActivate()` selects the system
  locale with `en` fallback.
- Native-side strings are localized through platform resources: the Android
  foreground-service notification via `strings.xml` and iOS permission texts via
  `InfoPlist.strings`. RadioKit itself ships no localized copy — its only two strings
  were the channel and participant names `PTChannelManager` showed in system UI, and they
  went with PushToTalk on 2026-08-18 (§10.2).

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
| R1 | Suspended iOS app may not reliably receive incoming Nearby audio | Phase 0 spike proves or refutes on physical devices; hard Go/No-Go gate before any further transport-dependent work (§10.3 — UI and design work is exempt, it depends only on the §6.1 contract) |
| R2 | The unbranded button may be HID-only, which cannot drive background PTT on iOS | GATT path is mandatory for iOS; if the button is HID-only, it remains Android-only and a GATT-capable button is purchased for iOS |
| R3 | Nearby Connections iOS library maturity/behavior differs from Android | Spike exercises the exact Android↔iPhone pairs; No-Go path allows transport replacement |
| R4 | OS battery optimization kills long-running background operation | Stage 6 reliability matrix (5 min / 30 min / hours locked) validates; Android battery-exemption prompt added only if the matrix fails |

## 15. Development phases

Phase 0 is a gate. Everything after it runs **design first** (§6.4): the whole design of §12
and §12.1 is implemented against the mock engine (§6.5), and only then are the internals
wired underneath it.

> **Stage numbering note (2026-08-18 revision).** Phase 0 and Stages 1, 5 and 6 keep their
> identifiers; every existing reference to **Stage 5** (concrete Bluetooth button) and
> **Stage 6** (background reliability) stays valid — see §5, §9.5, §14 R4, §16. Stages 2–4
> were re-cut for the design-first order: the former "Stage 2 — React Native bridge",
> "Stage 3 — Reatom" and "Stage 4 — Minimal UI" become **Stage 2 — design implementation**,
> **Stage 3 — React Native bridge** and **Stage 4 — integration**, with the Reatom model
> folded into Stage 1, where it was in fact built. Documents that cite the old Stage 2/3/4
> names must be updated to the new ones.

Stage 1 and the Phase 0 spike work have already happened in reality; they are kept here for
the record. The Phase 0 **decision** is a separate thing and is still open — which is precisely
why the design stage goes first: it is the one stage the gate does not hold up (§10.3). The
go-forward order is Stage 2 → 3 → 4, then 5 and 6.

### Phase 0 — Background feasibility spike (gate)

No UI. Two physical devices (Android + iPhone), internet off, screens locked. Prove:

- A: Android PTT → locked iPhone plays audio.
- B: iPhone BLE PTT → locked Android plays audio.
- C: locked iPhone BLE PTT → microphone starts → Android receives audio.
- D: devices separated beyond range and returned → connection restores automatically.

Deliverable: a written spike report
(`docs/superpowers/specs/2026-08-13-phase0-spike-report.md`) and an explicit **Go / No-Go**
decision. On No-Go this spec's transport sections (§7, §10) are revised before any further
transport-dependent stage; per §10.3 the design stage is not blocked either way.

### Stage 1 — Native RadioEngine and TypeScript domain

`start/stop`, peer connections, native audio pipeline, PTT — without React Native — plus the
TypeScript side of the contract: `RadioState` and event types, the Turbo Module spec, and the
Reatom model with `screenState` and resume re-sync (§6.2).
Acceptance: two devices exchange voice driven by native test hooks; unit tests for the model,
which mirrors the engine through suspend/resume.

### Stage 2 — Design implementation (first)

Every screen of §12 and §12.1, built against the mock engine (§6.5) and nothing else:
RadioScreen with its five `screenState` states, its first-class power toggle and full-screen PTT
area, Settings, the four-step pairing flow, the three permission steps of onboarding plus its
final screen, and the error state with its restart action — in the visual direction of the
Claude Design project, with all copy through Lingui.

Acceptance — **no devices, no native code, `RADIO_BACKEND=mock`**:

- all five main-screen states are reachable and visually distinct;
- the power toggle turns the radio off — the `off` state is reachable from any scenario and is
  visually distinct — and back on, returning to the scenario's normal flow;
- the pairing flow completes end-to-end on `pairing-success`, and its empty / retry path on
  `pairing-empty`;
- onboarding walks through every step, including a denied permission;
- the error state appears on `engine-error` and its restart action returns the UI to
  `starting`;
- all of the above in **both locales**, with `prefers-reduced-motion` honoured.

On-device end-to-end behaviour is **not** asserted here; it is Stage 4's acceptance.

### Stage 3 — React Native bridge

`RadioNative` Turbo Module: `start`, `stop`, `pressPtt`, `releasePtt`, `getState`,
`configurePtt`, `forgetPtt` + event stream, made real on both platforms; the dev default flips
to `RADIO_BACKEND=native` (§6.5). Acceptance: JS drives a full session against the real
engines, and the Stage 2 screens do it **unmodified**. Any UI change needed to make the real
binding work is a §6.4 violation and is reported as one rather than absorbed.

### Stage 4 — Integration

App entry and navigation glue, `i18n.loadAndActivate` with the system locale, engine event
subscription into the Reatom model, AppState resume re-sync, and first-launch permission
sequencing against the real OS prompts behind the onboarding screens.
Acceptance: full flow on both platforms from install to talking — the on-device acceptance
that the design stage deliberately does not carry.

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
  parsing/persistence, and screen behaviour driven by the mock engine's scenarios (§6.5) —
  deterministic and hardware-free.
- **Physical devices are the only source of truth** for Nearby, BLE, and background
  behavior — simulators cannot emulate them. Every transport-dependent stage — Stage 1, and
  Stages 3 onwards — carries a short written manual acceptance checklist executed on real
  Android + iPhone hardware; the Stage 6 matrix is the final MVP acceptance.
- **Stage 2 is the deliberate exception:** it is accepted entirely against the mock engine,
  which is exactly what lets the design be built before the internals (§6.4). It asserts
  appearance and flow, never transport, BLE or background behaviour.

## 17. Project structure

```text
src/
├── app/app.model.ts
├── radio/{radio.model.ts, radio.native.ts, radio.native.mock.ts, radio.types.ts}
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

`radio.native.mock.ts` is the §6.5 mock engine: the second implementation of the §6.1
contract, selected by `RADIO_BACKEND` and stripped from release bundles.

## 18. Guiding principle

```text
React Native  = the interface
Reatom v1001  = application/UI state
RadioEngine   = the radio itself

The UI may die. JS may sleep. The RadioEngine must keep working.

Design first: the interface is built and accepted before the internals under it exist.
It knows one contract and never a device — so the internals are swapped underneath it
without touching a single screen.
```
