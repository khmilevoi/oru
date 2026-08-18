# Seamless headphone audio — design

Date: 2026-08-18. Status: approved for planning.

Supersedes the "Audio routing: system default route … no in-app route picker" row of
[`2026-08-13-offline-nearby-ptt-design.md`](2026-08-13-offline-nearby-ptt-design.md) §Decisions and
amends its §10.2 audio-session recipe. Everything else in that document stands.

## 1. Problem

The product wants headphones to Just Work: plug in or connect a headset (wired or Bluetooth) and
all radio audio — playback of incoming voice and the microphone for outgoing voice — moves to it
immediately on both platforms; when the connection drops it falls back instantly and recovers
automatically when the device returns; background music from other apps keeps playing and is
ducked in favor of voice. The current implementation fails all of these:

**iOS** (`ios/Radio/Sources/RadioKit/`):

- Wired headphones are classified `.builtIn` and the output is then force-overridden to the
  loudspeaker (`AudioSessionProfile.afterA2DPActivation`, `wantsSpeakerOverride`,
  `AlwaysHotBackgroundManager.finishProfile`). Wired headphones do not work at all.
- The two-phase HFP/A2DP profile detection assumes `[.allowBluetoothA2DP]` excludes HFP, but the
  session mode `.voiceChat` implicitly enables `.allowBluetooth`, so phase 2 never narrows and the
  `.bluetoothA2DP` profile may be unreachable on HFP-capable headsets.
- Nothing observes `AVAudioEngineConfigurationChange`: a route change that alters the hardware
  sample rate (built-in 48 kHz ↔ HFP 8/16 kHz) stops `AVAudioEngine` silently. The always-hot
  keep-alive tap dies with it — the one thing keeping the app alive under the `audio` background
  mode — so a headset connecting while the phone is locked can suspend the whole radio.
- The capture `AVAudioConverter` is built once per transmission from the then-current input
  format; a mid-transmission route change makes conversion fail and escalates to a radio-level
  `audioFailed` error instead of a re-route.
- Interruption recovery only calls `setActive(true)`; `mediaServicesWereReset` is unhandled;
  session state is mutated from the notification thread without synchronization.

**Android** (`android/app/src/main/java/com/oru/radio/`):

- One routing failure (`setCommunicationDevice` false, one `SCO_AUDIO_STATE_ERROR`, or a 6 s
  establishment timeout) blacklists the headset until it disconnects or the radio stops. A
  transient failure at connect time silently degrades the whole session — the opposite of
  "recovers instantly".
- Route establishment can hold up to ~6.3 s of dead air (mode retries + 6 s timeout) with nothing
  playing anywhere in the meantime.
- `AudioRecord`/`AudioTrack` are not recreated on device changes; 20 consecutive read/write errors
  escalate to fatal `microphone_read_failed`/`speaker_write_failed`, so a route change mid-stream
  can kill the radio.
- No `ACTION_AUDIO_BECOMING_NOISY` receiver; permanent `AUDIOFOCUS_GAIN` kills background music
  for the whole session.

**Both**: the platforms implement contradictory policies for the same headphones, no JS/UI surface
shows where audio goes, and none of the routing logic has tests. The "Bluetooth headphones
connected; audio route switch mid-session" acceptance item has never been executed on hardware.

## 2. Goals

1. Headphones connect → playback and (where the accessory has a usable microphone) capture move to
   them automatically, no user action, both platforms.
2. Headphones disconnect → audio falls back to the loudspeaker + phone mic immediately, the radio
   keeps running; the device returning restores the previous routing automatically.
3. A route change never kills the radio: engines and streams survive it or are rebuilt; route
   errors never escalate to `status: 'error'`.
4. Background music from other apps coexists with the radio and is ducked (Android) or mixed
   (iOS) during voice, with the same headset staying at music quality while idle.
5. One behavior contract for both platforms; route + mode visible in the UI.

Non-goals: a manual device picker; per-user disconnect-behavior settings; iOS ducking of other
apps (v1 mixes; see §12); Android Telecom/ConnectionService; the iOS 17+ Push To Talk framework;
iOS 26 `.bluetoothHighQualityRecording`; simultaneous-app audio beyond mixing (the radio keeps its
own session).

## 3. Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | Two audio profiles, **VOICE** (BT headset mic ready: HFP/SCO held) and **MEDIA** (headset on A2DP, playback via media path, phone mic), switched **automatically** by whether another app is playing audio. | Bluetooth Classic cannot run HFP and A2DP at once (§4). Holding HFP only while no one else plays audio gives full radio behavior when alone and full music quality when not — the invariant "hold SCO only when we would be the only audio user". |
| D2 | PTT pressed while in MEDIA: raise SCO, play a **grant tone** when the headset mic is live, then transmit through it; keep SCO for a **linger window** after release; on SCO failure, grant-tone and fall back to the phone mic. | Real LMR radios and pro PTT apps mask SCO latency with a talk-permit tone; the linger window makes only the first exchange of a conversation pay the switch cost. Chosen over instant-phone-mic and over mid-transmission mic hot-swap. |
| D3 | Headphones disconnect → immediately to loudspeaker + phone mic; return → automatically back. | Radio semantics: missing a transmission is worse than hearing it out loud. |
| D4 | UI: route + mode **indicator only**, plus one setting `audioMode: auto \| voice \| media` (default `auto`). No manual device picker. | Auto-routing is the product; the manual mode pin is the escape hatch for OEM quirks. |
| D5 | Android routing is our own state machine (extracted, testable), not a library. | We are already on the API-31 primitives; AudioSwitch is call-shaped and would fight the always-hot foreground service. Patterns are copied from Signal/AudioSwitch/WebRTC instead. |
| D6 | Ducking: Android ducks other apps for real (transient `MAY_DUCK` focus per voice burst); iOS mixes without ducking in v1. | Android auto-ducks system-side since API 26. On iOS un-ducking requires deactivating the session, which conflicts with the always-hot design; Zello and Telegram made the same choice. |
| D7 | The radio wire format stays 16 kHz mono Opus. | HFP (mSBC 16 kHz) therefore costs no perceived radio quality; A2DP's higher fidelity buys nothing for radio audio. This is why VOICE mode is not a quality sacrifice. |

## 4. Bluetooth constraints this design is built around

- **A2DP has no microphone channel; HFP is the only path to a BT Classic headset mic**, and while
  its SCO link is open A2DP must be suspended (Bluetooth spec; the radio link cannot carry both).
  "Headset mic + high-quality playback" does not exist on BT Classic. LE Audio (Android 13+,
  recent headsets) removes this; treat it as an optimization target, not the baseline.
- **SCO establishment from idle takes 1–3 s** (measured in the field: Pixel 1–2 s, Samsung 2–3 s,
  Xiaomi 5–8 s) and profile flips are the most glitch-prone BT operation ("worse in the
  background" — Apple DTS). Hence the grant tone (D2) and hysteresis (§7).
- **iOS `.voiceChat` mode implicitly enables `.allowBluetooth` (HFP)**. The MEDIA session config
  must therefore not use `.voiceChat`.
- **iOS routing is "last-in wins"** and automatic once category options are right. The design
  configures options per profile and survives changes; it never chases devices with
  `setPreferredInput` or per-connect overrides.

## 5. iOS design

### Session configurations

One static configuration per profile, applied whole (diff-only: skip if already applied):

| | VOICE | MEDIA |
|---|---|---|
| Category | `.playAndRecord` | `.playAndRecord` |
| Mode | `.voiceChat` | `.default` |
| Options | `[.allowBluetooth, .mixWithOthers]` | `[.allowBluetoothA2DP, .mixWithOthers]` |
| BT route | HFP both directions (system-picked) | A2DP out, built-in mic |

The two-phase detection state machine, `setPreferredInput` pinning, and the `AudioSessionProfile`
profile enum are removed. `.mixWithOthers` is mandatory in both profiles: it is what lets another
app start playing at all (a non-mixable Spotify would otherwise interrupt and kill the radio
session), which is also how MEDIA-mode demand is detected.

**Speaker default stays override-on-demand, not `.defaultToSpeaker`** (respecting the
hardware-confirmed iOS 17/18 route-collapse regression recorded in `AudioSessionProfile.swift`):
after activation and after every route change, if the current outputs contain only
`builtInReceiver`, apply `overrideOutputAudioPort(.speaker)`; if any external output is present
(`.headphones`, `.bluetoothHFP`, `.bluetoothA2DP`, `.bluetoothLE`, `.usbAudio`, `.carAudio`, …),
apply `.none`. The decision is a pure function of the current route — this fixes the wired-
headphones bug, because it looks at actual outputs instead of a collapsed classification.

### Observers

All handlers re-post onto the `RadioEngine` queue (closes the current data race on
`isActive`/`currentProfile`).

- `routeChangeNotification`: `.newDeviceAvailable` / `.oldDeviceUnavailable` → recompute the
  speaker override, publish the route to JS, feed the mode policy (§7). `.categoryChange` →
  re-apply our current profile configuration (someone else changed it). `.override` → log only.
- `AVAudioEngineConfigurationChange` (new): rebuild the engine graph — stop, disconnect nodes,
  re-query all formats from the hardware, reconnect, restart, reinstall the keep-alive tap.
  Formats are never cached across a rebuild. (Pattern: LiveKit `SoundPlayer.reconnectEngine`.)
- `interruptionNotification`: `.ended` → re-apply profile config, `setActive(true)` with retry on
  `isBusy` (0.5 s × 3, Signal's pattern), rebuild/restart the engine, recompute route. Because
  `.ended` is not guaranteed, app-foreground also runs the same recovery.
- `mediaServicesWereResetNotification` (new): dispose every audio object and rebuild session +
  engine from scratch (Apple QA1749).

### Engine and capture

- The capture converter is rebuilt whenever the input format changes (detected via the engine
  configuration change or a format mismatch in the tap); a mid-transmission change re-routes with
  a short glitch instead of raising `audioFailed`.
- `beginIncoming` no longer stop/starts the engine per transmission; engine restarts happen only
  on configuration change or interruption recovery.
- Mode switches (VOICE ↔ MEDIA) are a profile re-apply (`setCategory` with the other config) and
  ride the same rebuild path; they are requested only by the mode policy (§7).

### Other-audio detection

`isOtherAudioPlaying` sampled on the existing heartbeat tick and on every route change;
`silenceSecondaryAudioHintNotification` observed as an immediate edge trigger. Our own playback is
not "other audio" (the API already excludes the querying session).

## 6. Android design

### `AudioRouteController` (new, extracted from `RadioForegroundService`)

Owns mode, focus, device selection and mode policy. Runs on a dedicated
`HandlerThread("audio-route")`; every callback (device callback, broadcasts, listeners) re-posts
onto it. All events funnel into one idempotent `reevaluate()`: rebuild the device list → pick by
priority → apply only if changed → notify only if changed. `AudioManager` is accessed through an
injected facade so the controller is unit-testable. The three-row policy table survives; the
machinery around it is replaced.

### Profiles

| | VOICE | MEDIA |
|---|---|---|
| Mode | `MODE_IN_COMMUNICATION` | `MODE_NORMAL` |
| Playback | `USAGE_VOICE_COMMUNICATION` track | `USAGE_ASSISTANCE_NAVIGATION_GUIDANCE` + `CONTENT_TYPE_SPEECH` track on the media path (mixes into A2DP) |
| Capture | `VOICE_COMMUNICATION` source, routed with the comm device | `VOICE_COMMUNICATION` source, phone mic |
| BT | `setCommunicationDevice` (API 31+) / SCO (legacy) | none — headset stays on A2DP |
| Focus | transient `AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK` per voice burst (request at burst start, abandon at end) — replaces the session-long `AUDIOFOCUS_GAIN` | same |

Ducking is therefore free: the system ducks and restores other apps around each burst (API 26+).

### Device selection and recovery

- Priority (input-capable): BT SCO / BLE headset > wired headset > USB headset; output-only
  externals (wired headphones, A2DP-only devices) get playback with the phone mic; nothing
  external → loudspeaker + phone mic.
- **Bounded retries replace the blacklist**: per-device attempt counter (max 2 per episode); a
  failure demotes the device only until the next device event, never permanently; the counter
  resets on fresh connection and on detected SCO theft (Signal's `wasAudioStateInterrupted`).
  Before declaring a timeout, ground truth is re-checked via `isAudioConnected`.
- **Audio keeps flowing on the previous route while SCO/comm-device establishment is in flight**;
  BT becomes the selected output only once actually connected. Dead air during establishment is
  eliminated (the 6 s timeout becomes invisible).
- New listeners: `ACTION_AUDIO_BECOMING_NOISY` → immediate `reevaluate()` (fast path to speaker);
  `OnCommunicationDeviceChangedListener` → re-assert our selection if the platform re-routed;
  `OnModeChangedListener` replaces the 3 × 100 ms mode polling; `onAudioDevicesAdded` debounced
  ~500 ms (device lists flap during BT profile negotiation); devices whose `productName` contains
  `" Watch"` are filtered out (Galaxy Watch hijack).
- **Streams survive route changes**: the controller signals `AudioEngine` on every applied route
  or profile change; the capture loop recreates `AudioRecord` and playback recreates `AudioTrack`
  (their attributes differ per profile anyway); the consecutive-error counter resets on route
  transitions, and the fatal threshold applies only while the route is stable.

### Other-audio detection

`registerAudioPlaybackCallback` (API 26+), filtering out our own player and non-media usages;
`isMusicActive()` as fallback. Feeds the mode policy (§7).

## 7. Mode policy (shared, pure logic, identical constants on both platforms)

States: `VOICE`, `MEDIA`. Inputs: other-audio active (debounced), radio activity (receiving or
transmitting), PTT press, timers. Output: requested profile.

- `VOICE → MEDIA`: other audio detected for ≥ **2 s** → switch at the next radio-idle moment.
- `MEDIA → VOICE`: other audio silent for ≥ **30 s** → switch at the next radio-idle moment.
  (Asymmetric hysteresis: protect the user's music fast, never flap between tracks.)
- `PTT press in MEDIA`: raise the headset voice link — Android: `setCommunicationDevice`/SCO;
  iOS: apply the VOICE session config — and play the grant tone once the headset mic path is
  confirmed (route/SCO connected), then start capture. Timeout **4 s** → grant tone + phone-mic
  fallback for this transmission. After PTT release, hold the raised link for a **15 s linger**;
  further presses inside the window are instant. Linger expiry → drop the link (Android: clear
  comm device; iOS: re-apply the MEDIA config), the headset returns to A2DP and music resumes.
  This raise/drop is the same profile-apply mechanism as a §7 mode switch, driven by the PTT
  timers instead of the other-audio detector, and it is exempt from the 10 s rate limit.
- Global rate limit: at most one VOICE↔MEDIA switch per **10 s**; switches never run during
  receive or transmit (they queue for idle).
- `audioMode` setting: `auto` runs this policy; `voice`/`media` pin the profile (PTT-press SCO
  raise with grant tone still applies inside a pinned `media`).
- Transmission start is always gated on the grant tone in every mode; in VOICE and on
  wired/speaker routes the mic is already live, so the tone is immediate. One mental model: press
  → tone → talk.

Non-BT-Classic routes (speaker, wired, USB, LE Audio) have no profile conflict: the policy is
inert there and both playback and mic follow §6 selection directly.

## 8. JS / UI surface

- `RadioState` gains `audioRoute: { kind: 'speaker' | 'wired' | 'bluetooth' | 'usb', label?: string,
  mode: 'voice' | 'media' }`, published through the existing `stateChanged` event; the Codegen
  spec (`specs/NativeRadio.ts`) is regenerated accordingly.
- New persisted setting `audioMode: 'auto' | 'voice' | 'media'` (default `auto`), passed to
  native.
- UI: a compact indicator on the radio screen (route icon + BT device name + mode, e.g.
  "AirPods · radio" / "AirPods · music, phone mic"), strings via lingui. No picker.

## 9. Cross-platform behavior contract

Same hardware must produce the same behavior; this table is the acceptance oracle:

| Situation | Behavior (both platforms) |
|---|---|
| No external device, no music | Loudspeaker + phone mic, VOICE |
| BT headset connects, no music | HFP both ways within the platform's switch time; instant PTT |
| BT headset connected, user starts music | ≤ ~2 s + rate limit: headset to A2DP, music at full quality, MEDIA |
| Incoming voice during music | Voice plays into the A2DP stream; music ducks (Android) / mixes (iOS); no profile switch |
| PTT press during music | SCO raised → grant tone (~1–3 s first press) → headset mic; linger 15 s; music paused by SCO, resumes after linger |
| Music stops | After 30 s silence, back to VOICE (SCO held, instant PTT) |
| Headset battery dies / walks out of range | Immediate loudspeaker + phone mic; no error state |
| Headset returns | Automatic re-selection (retry budget refreshed) |
| Wired headphones (no mic) plug in | Playback to headphones, phone mic; unplug → loudspeaker |
| Phone call interrupts | Radio yields; on call end, session, engine and route recover automatically |

## 10. Testing

- **iOS**: every decision is a pure function with unit tests — speaker-override(route),
  route→`audioRoute` classification, mode policy (§7), (event, state)→actions reaction table.
  Side effects stay behind the existing `BackgroundSession` protocol with extended fakes. The
  simulator compile gate remains the build check.
- **Android**: `AudioRouteController` against a fake `AudioManager` facade — JUnit tests for
  connect/disconnect/reconnect, SCO timeout + bounded retries + counter resets, debounce, noisy,
  watch filter, "audio flows on old route while SCO establishes", mode-policy transitions,
  focus request/abandon pairing.
- **Shared**: the mode policy's transition table is specified once in this document and each
  platform's tests assert the same table.
- **JS**: mock-radio tests for `audioRoute` propagation and the indicator.
- **Instrumentation**: heartbeat/logcat lines carry timestamps for device-event → audio-on-new-
  route so switch latency is measured, not guessed.
- **Hardware checklist** (replaces the unticked Stage 6 route item; run on both platforms): BT
  connect mid-receive / mid-transmit / while locked; music start/stop mode switches; PTT grant
  tone during music; headset battery death and return; wired plug/unplug; phone-call interruption
  and recovery; one OEM beyond Pixel (Samsung or Xiaomi) for SCO timing.

## 11. Migration notes

- iOS deletes: two-phase detection, `AudioSessionProfile` profile enum (the route formatter
  stays), `setPreferredInput` pinning. iOS keeps: `AlwaysHotBackgroundManager` as session owner,
  the always-hot keep-alive tap, heartbeat logging.
- Android deletes: `failedHeadsetKeys` blacklist, mode-set polling, session-long focus. Android
  keeps: the three-row policy table, HFP-proxy cross-validation, foreground-service typing.
- The 2026-08-13 design doc's "no in-app route picker" stands; its "system default route" row is
  superseded by this document.

## 12. Future work (explicitly out of scope)

- iOS ducking of other apps (requires session deactivation cycles around bursts; revisit if the
  always-hot constraint ever relaxes or the PTT framework is adopted).
- LE Audio fast path (skip SCO semantics on `TYPE_BLE_HEADSET` where concurrency allows).
- iOS 26 `.bluetoothHighQualityRecording` for AirPods capture quality in VOICE mode.
- Apple Push To Talk framework adoption (system-owned ephemeral sessions).

## 13. Key references

- Bluetooth HFP/A2DP exclusivity: google/oboe TechNote "Bluetooth Audio"; Mozilla bug 847255.
- iOS: Apple Audio Session Programming Guide (route changes); QA1749 (media services reset);
  Apple forum 741513 (A2DP + built-in mic); WWDC22-10117 + DTS thread 804205 (PTT framework,
  profile-flip glitches); LiveKit `SoundPlayer.reconnectEngine` (engine rebuild).
- Android: developer.android.com "self-managed call audio" (setCommunicationDevice recipe);
  "Manage audio focus" (API 26 auto-duck); Signal-Android `FullSignalAudioManagerApi31`
  (re-assert listener, watch filter, mode listener); twilio/audioswitch (idempotent enumerate,
  SCO retry job); react-native-incall-manager (skip-BT-while-SCO-connecting re-pick).
- Product precedents: Zello iOS/Android Bluetooth settings (A2DP-first, opt-in BT mic, on-demand
  audio mode); Google Maps "Play as Bluetooth phone call" (documented HFP tradeoff).
