# P2 — JS contract, audio route UI, and compile-keeping bridge stubs — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the section 6.1 radio contract with the audio route and the `audioMode`
setting, render both to the design canvas on the reconciled UI, and add the minimal native
bridge stubs that keep both platforms compiling.

**Architecture:** Contract-first, exactly as the prior run did it. The TypeScript contract
(`specs/NativeRadio.ts` + `src/radio/radio.types.ts`) grows two fields on the published
state and one setter method; the mock engine becomes the first complete implementation of
that extension, so every screen and model test runs against a real behaviour rather than a
fixture; the two screens then render it. The two native bridges get mechanical stubs — a
constant placeholder route and a setter that stores nothing — whose only job is to keep the
regenerated Codegen spec compiling until wave 2 replaces them with real routing.

**Tech Stack:** TypeScript 5 · React Native 0.87 (New Architecture, Turbo Modules +
Codegen) · Reatom v1001 (`@reatom/core`, `@reatom/react`) · Lingui 6 (`@lingui/react/macro`,
`.po` catalogs) · Jest + `react-test-renderer` · Kotlin (JUnit) · Swift / Objective-C++
(XCTest).

**Spec:** `docs/superpowers/specs/2026-08-18-seamless-headphone-audio-design.md` — sections
§2 G5, §8, §9 (state shapes), §10 (JS).

**Schedule:** `docs/superpowers/execution/2026-08-18-seamless-headphone-audio.md`, block
`### P2 js-contract-ui — wave 1, track B`.

---

## Global Constraints

Every task's requirements implicitly include this section.

### Where this plan runs

- **This plan executes on the post-merge trunk.** Two external branches must be merged into
  `feature/offline-nearby-ptt` before the executor starts: `design/seamless-headphone-audio`
  (the canvas refresh, touching only `design/`) and `worktree-design-reconciliation` (the
  rebuilt `src/ui/theme.ts`, the UI primitives and the screens). The runner does not
  dispatch the executor before both merges. Every file excerpt in this plan was read off
  those branches at planning time; where the merged trunk differs from an excerpt, **the
  merged trunk wins** and the task's instructions say how to adapt.
- **No new JavaScript dependency.** `package.json` and `pnpm-lock.yaml` must not move. React
  Native ships no SVG renderer and `react-native-svg` is not installed, so the canvas's three
  route icons are transcribed to `View` compositions (Task 5). Sync 1 declares "no new JS
  dependency is expected"; adding one is a reported violation, not a decision.

### The design canvas is the visual authority

`design/01 Radio.dc.html` and `design/02 Settings.dc.html`, as refreshed by the merged
`design/seamless-headphone-audio` branch. A value the canvas states is read off it, never
invented. The values this plan uses, verbatim:

| Canvas | Value | Theme token this plan uses |
|---|---|---|
| `.routeline` font-size | `11px` | `type.routeLabel.fontSize` |
| `.routeline` letter-spacing | `0.14em` → 11 × 0.14 = **1.54** | `type.routeLabel.letterSpacing` |
| `.routeline` colour | `var(--faint)` = `#57626c` | `colors.textFaint` |
| `.routeline` gap | `9px` | `routeReadout.gap` |
| `.routeline svg` box | `14 × 14`, stroke-width `1.5` | `routeReadout.iconSize` / `routeReadout.strokeWidth` |
| `.route` position | `left: 90px; right: 90px; bottom: 44px` | `routeReadout.sideInset` / `routeReadout.bottomInset` |
| `.routeline` transform | `text-transform: uppercase` | `textTransform: 'uppercase'` |
| `.seg` border | `1px solid var(--line2)` = `#2e363e` | `colors.hairlineRaised` |
| `.seg` radius | `14px` | `radii.md` |
| `.seg span` padding | `14px 0` | `segmented.paddingVertical` |
| `.seg span` font-size | `13.5px` | `type.segment.fontSize` |
| `.seg span` letter-spacing | `0.04em` → 13.5 × 0.04 = **0.54** | `type.segment.letterSpacing` |
| `.seg span` colour | `var(--dim)` = `#8b959d` | `colors.textMuted` |
| `.seg .on` | `background: var(--ink)` `#f2f4f2`, `color: #0c0e10`, `font-weight: 500` | `colors.text` / `colors.textInverse` / `fonts.monoMedium` |
| `.slabel` | `11px`, `0.2em`, `var(--faint)`, uppercase | `type.label` + `colors.textFaint` |
| `.card` | `margin 0 22px`, `--bg2` `#13161a`, `1px --line` `#242b32`, radius `18px`, padding `24px 22px` | `spacing.gutter` / `colors.surface` / `colors.hairline` / `radii.lg` |
| `.note` | `12px`, line-height `1.7`, `var(--faint)` | `type.caption` + `colors.textFaint` |

The canvas's two governing notes, quoted:

> `AUDIO ROUTE READOUT · BOTTOM CENTRE BETWEEN GEAR AND POWER · ROUTE ICON + DEVICE + MODE ·
> INDICATOR ONLY — NEVER A PICKER, NO TAP TARGET · HIDDEN WHILE OFF · STAYS PUT WHILE
> TRANSMITTING / RECEIVING — IT NAMES THE LIVE MIC`

> `USB ROUTES RENDER LIKE WIRED · BLUETOOTH SHOWS THE HEADSET NAME AS REPORTED, OTHER KINDS
> A GENERIC LABEL · VOICE MODE READS "RADIO", MEDIA READS "MUSIC, PHONE MIC"`

> `AUDIO · ONE SETTING — AUDIOMODE: AUTO | VOICE | MEDIA · DEFAULT AUTO (SELECTED IN BOTH
> FRAMES) · LABELS: AUTO = AUTO / АВТО, VOICE = RADIO / РАЦИЯ, MEDIA = MUSIC / МУЗЫКА · NO
> DEVICE PICKER — ROUTING IS AUTOMATIC, THIS PIN IS THE ESCAPE HATCH`

Two rules follow from those notes and are applied throughout, so no task re-derives them:

1. **`usb` renders exactly like `wired`** — same icon, same generic device word.
2. **A `bluetooth` route with no `label`** falls back to the same generic accessory word the
   canvas gives for a non-speaker route (`Headphones` / `Наушники`). The canvas states no
   third generic word, and inventing one would be the violation.

### The reconciled UI is the structural authority

- Colours, font faces, sizes and durations are written down **only** in `src/ui/theme.ts`.
  A screen or primitive that hardcodes one is a bug. New tokens are **appended** to
  `theme.ts`; nothing existing is renamed or retuned.
  - One deliberate exception, stated in the icon module's own doc comment: the three route
    icons transcribe the canvas's `viewBox` path coordinates as literals inside
    `src/ui/RouteIcon.tsx`. Those are artwork geometry, not design tokens; the icon's
    **box size** and **stroke width** are tokens.
- `testIds` in `src/ui/theme.ts` is **appended to, never renamed**.
- The reconciliation's primitives are reused, never duplicated.
- `__tests__/theme-and-fonts.test.ts` iterates `Object.values(type)` and asserts every entry
  has **no `fontWeight`** and a `fontFamily` that exists as a bundled `.ttf`. New `type`
  entries must therefore name a face from `fonts` and never set `fontWeight`.
- `__tests__/ui-independence.test.ts` forbids every file under `src/ui` and `src/screens`
  from importing `radio.native*`, `specs/NativeRadio`, `TurboModuleRegistry`,
  `NativeModules`, `PermissionsAndroid`, or `react-native/Libraries/*`. Importing **types**
  from `src/radio/radio.types` and values from `src/radio/radio.model` is allowed and is
  what the existing screens already do.

### Copy

- All copy goes through Lingui with **both** `en` and `ru` catalogs filled.
  `__tests__/locale-coverage.test.ts` fails on any `en` message id missing or empty in `ru`.
- The project's convention, which this plan follows: **an uppercase section label is an
  uppercase literal in the source string** (`<Trans>PTT BUTTON</Trans>`, ru `КНОПКА PTT`),
  because `type.label` carries no `textTransform`. The route readout is the one place that
  uses `textTransform: 'uppercase'` instead — its device word can be a device name that
  arrives from native and cannot be a translated literal.
- After adding or changing any message, run `pnpm lingui:extract` and fill the new `ru`
  entries by hand. Known flake (6): the extract rewrites two stale source-line references in
  the `.po` files. That churn is harmless — commit it with the catalog change that caused it.

### Contract discipline (section 6 of the prior spec, still binding)

- Reatom holds a **mirror** of engine state and is never the source of truth. Every write to
  `radio()` originates from the engine — a `getState()` snapshot or a `stateChanged` event.
- Every mutating contract method must emit `onStateChanged` with the state it produced
  **before** the returned promise resolves. `radio.model.ts` never writes its mirror from a
  call's own return value. This applies to the new `setAudioMode` exactly as it applies to
  `start`/`stop`/`pressPtt`/`releasePtt`/`forgetPtt`.
- The indicator **renders** `audioRoute.mode`; it never computes it. Mode policy is P1's.

### Recorded decision — how JavaScript learns the persisted `audioMode`

§8 says `audioMode` is "persisted … passed to native"; the schedule assigns the *store* to
the native side (UserDefaults / SharedPreferences, P3/P4) and gives P2 "the setting's
contract surface and UI". It does not name the **read-back** path, and the settings row
cannot render a selected segment without one.

**This plan publishes `audioMode` on `RadioState` alongside `audioRoute`, through the
existing `stateChanged` event.** The alternatives were a `getAudioMode()` getter and a
JS-local mirror; both were rejected because they contradict the contract discipline quoted
above — a getter is a second read path that goes stale the moment native changes the value,
and a JS-local mirror makes Reatom the source of truth for a natively-persisted value. This
is recorded here so it is reviewable: if the operator prefers a different shape, correct it
before wave 2 is planned. The cost of the correction is one field on two types and two map
entries on each bridge.

### Gates

**Every task's final verification step runs the task gate**, which is:

```
pnpm typecheck && pnpm lint && pnpm test <paths>
```

plus, **when the task touched `android/`**:

```
node scripts/build-android.js :app:testDebugUnitTest
pnpm build:android
```

plus, **when the task touched `ios/`**:

```
cd ios/Radio && DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild test -scheme RadioKit -destination 'platform=iOS Simulator,name=iPhone 17'
```

Each task below names its own `<paths>`.

**Acceptance beyond the gates (once, in Task 10):** the sync-1 merge gate's iOS *app* leg
must compile the stub, and the task gate's RadioKit leg does not compile the bridge. Before
reporting GREEN the executor runs, in its own worktree:

```
cd ios && pod install
cd ios && DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild -workspace Oru.xcworkspace -scheme Oru -destination 'platform=iOS Simulator,name=iPhone 17' build
```

**Known flakes — re-run once before reporting any of these as a regression:**

1. First Gradle / NDK / CMake / dependency downloads are slow and can time out. A download
   failure or timeout is infrastructure, not a regression.
2. `xcode-select` on this host points at CommandLineTools, so a *bare* `xcodebuild` fails
   with a tools error. That is environment, not a regression; every xcodebuild above already
   carries the `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer` prefix.
3. The `Oru` app scheme has no test action ("no test bundles available"). The RadioKit tests
   run **only** from `ios/Radio`'s own package workspace; the app build and the package
   tests are two separate commands, never one.
4. The simulator destination `iPhone 17` is the recorded-working one from the 2026-08-13
   spike report. If xcodebuild reports the device missing, substitute any available iPhone
   simulator — device-list drift, not a regression.
5. The first xcodebuild in a fresh worktree resolves SPM packages (google/nearby,
   alta/swift-opus). A slow first run or a transient network failure there is infrastructure.
6. `pnpm lingui:extract` rewrites two stale source-line references in the `*.po` catalogs —
   harmless churn; commit it with whatever catalog change triggered it.

---

## File Structure

**Created**

| File | Responsibility |
|---|---|
| `src/ui/RouteIcon.tsx` | The canvas's three 14×14 route glyphs (speaker, headphones, bluetooth), transcribed from SVG paths to `View` compositions. Presentational; no state, no lingui. |
| `src/ui/RouteReadout.tsx` | The `.routeline` element: icon + one uppercase line. Takes an `AudioRoute` and owns the canvas's device-word / mode-word composition. |
| `src/ui/SegmentedControl.tsx` | The canvas's `.seg` — a generic 3-up segmented control. Knows nothing about audio. |
| `__tests__/audio-route-ui.test.tsx` | Unit tests for the two new primitives. A new file rather than an append to `__tests__/ui-primitives.test.tsx`, which the reconciliation branch also rewrites. |

**Modified**

| File | Change |
|---|---|
| `specs/NativeRadio.ts` | `NativeAudioRoute`; `audioRoute` + `audioMode` on `NativeRadioState`; `setAudioMode`. |
| `src/radio/radio.types.ts` | Domain twins of the above + `initialRadioState`. |
| `src/radio/radio.native.ts` | `setAudioMode` on `RadioNativeApi` and its implementation. |
| `src/radio/radio.native.mock.ts` | `audioRoute`/`audioMode` through `clone`, the initialiser, `abortPairing`, `toOffState`, `reset`; a real `setAudioMode`. |
| `src/radio/radio.mock.scripts.ts` | Timelines that exercise route changes and both modes. |
| `src/radio/radio.model.ts` | The `setAudioMode` action. |
| `src/ui/theme.ts` | Appended: `type.routeLabel`, `type.segment`, `type.segmentSelected`, `routeReadout`, `segmented`, two `testIds`. |
| `src/screens/RadioScreen.tsx` | One `<RouteReadout />` element. |
| `src/screens/SettingsScreen.tsx` | The AUDIO section. |
| `src/locales/{en,ru}/messages.po` | New copy, both locales. |
| `android/app/src/main/java/com/oru/bridge/RadioBridgeCore.kt` | Placeholder `audioRoute` + constant `audioMode` in the projection. |
| `android/app/src/main/java/com/oru/bridge/NativeRadioModule.kt` | `override fun setAudioMode`. |
| `android/app/src/test/java/com/oru/bridge/RadioBridgeCoreTest.kt` | Assertions for the placeholder. |
| `ios/Oru/RadioBridge.swift` | Placeholder `audioRoute` + constant `audioMode`; `setAudioMode`. |
| `ios/Oru/NativeRadioModule.mm` | The `setAudioMode` selector. |
| `__tests__/native-radio-spec.test.ts` | The method list grows to nine. |
| `__tests__/native-radio-bridge.test.ts` | Both platforms' method lists grow to nine. |
| `__tests__/radio-native.test.ts`, `radio-model.test.ts`, `app-model.test.ts` | Fixture literals gain the two fields. |
| `__tests__/radio-native-mock.test.ts` | Mock route/mode behaviour. |
| `__tests__/radio-screen.test.tsx`, `settings-screen.test.tsx` | Screen tests for the new surfaces. |

**Explicitly not touched** (they belong to P1, P3 or P4):
`ios/Radio/**` (RadioKit — including `RadioState.swift`'s `asDictionary`),
`android/app/src/main/java/com/oru/radio/**` (including `RadioState.toMap()`),
`ModePolicy.swift` / `ModePolicy.kt`, `package.json`, `pnpm-lock.yaml`.
The placeholder route is injected in the **bridge** layer of each platform, which is exactly
why no engine-side file needs editing.

---

## Task 1: The contract — `audioRoute`, `audioMode`, `setAudioMode`

Every later task depends on this one. It is the only task that makes a required field
appear, so it is also the task that repairs every object literal in the repository that
would stop type-checking.

**Files:**
- Modify: `specs/NativeRadio.ts`
- Modify: `src/radio/radio.types.ts`
- Modify: `src/radio/radio.native.ts`
- Modify: `src/radio/radio.native.mock.ts` (minimum to compile; Task 2 does the real work)
- Modify: `__tests__/native-radio-spec.test.ts`
- Modify: `__tests__/radio-native.test.ts:20-26`
- Modify: `__tests__/radio-model.test.ts:37-43`
- Modify: `__tests__/app-model.test.ts:25-31` and `:87-99`

**Interfaces:**
- Consumes: nothing (first task).
- Produces, and every later task uses exactly these names:
  - `specs/NativeRadio.ts`: `type NativeAudioRoute = {kind: 'speaker' | 'wired' | 'bluetooth' | 'usb'; label?: string; mode: 'voice' | 'media'}`; `NativeRadioState.audioRoute: NativeAudioRoute`; `NativeRadioState.audioMode: 'auto' | 'voice' | 'media'`; `Spec.setAudioMode(mode: string): Promise<void>`.
  - `src/radio/radio.types.ts`: `type AudioRouteKind = 'speaker' | 'wired' | 'bluetooth' | 'usb'`; `type AudioProfileMode = 'voice' | 'media'`; `type AudioMode = 'auto' | 'voice' | 'media'`; `type AudioRoute = {kind: AudioRouteKind; label?: string; mode: AudioProfileMode}`; `RadioState.audioRoute: AudioRoute`; `RadioState.audioMode: AudioMode`; `initialRadioState` carries `{kind: 'speaker', mode: 'voice'}` and `'auto'`.
  - `src/radio/radio.native.ts`: `RadioNativeApi.setAudioMode(mode: AudioMode): Promise<NativeRadioError | null>`.

- [ ] **Step 1: Write the failing test — the spec exposes nine methods**

In `__tests__/native-radio-spec.test.ts`, replace the body of
`it('exposes exactly the amended section 6.1 methods', ...)` with:

```ts
  it('exposes exactly the amended section 6.1 methods', () => {
    expect(radioModule.spec.methods.map(method => method.name)).toEqual([
      'start',
      'stop',
      'pressPtt',
      'releasePtt',
      'getState',
      'configurePtt',
      'selectPttCandidate',
      'forgetPtt',
      'setAudioMode',
    ]);
  });
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm test __tests__/native-radio-spec.test.ts`
Expected: FAIL — the received array has eight entries and no `setAudioMode`.

- [ ] **Step 3: Extend the Codegen spec**

In `specs/NativeRadio.ts`, insert this type immediately **above** `NativeRadioState`:

```ts
/**
 * Spec section 8. Codegen handles a typed alias whose fields are string-literal
 * unions and one optional string, exactly as `NativePttPairingState` above
 * proves, so this shape crosses the bridge intact.
 *
 * `mode` is the *effective* audio profile the engine is running — never the
 * user's `audioMode` pin, which is a separate field because `auto` is not a
 * profile. The UI renders this; it never computes it (section 7 is the
 * platforms' pure policy).
 */
export type NativeAudioRoute = {
  kind: 'speaker' | 'wired' | 'bluetooth' | 'usb';
  /**
   * The accessory's own name, as the platform reports it, for Bluetooth
   * routes. Absent for every other kind, and absent rather than empty when a
   * Bluetooth device reports no name.
   */
  label?: string;
  mode: 'voice' | 'media';
};
```

Then, in `NativeRadioState`, insert these two fields **between `pttButton` and
`pttPairing`**:

```ts
  /** Spec section 8. Always present: there is always a route in use. */
  audioRoute: NativeAudioRoute;
  /**
   * Spec section 8's persisted setting, published back so JavaScript mirrors
   * the engine rather than guessing. `auto` runs the section 7 policy;
   * `voice`/`media` pin the profile.
   */
  audioMode: 'auto' | 'voice' | 'media';
```

Then, in `interface Spec`, add the method after `forgetPtt()`:

```ts
  /**
   * Spec section 8. Stores the setting natively (UserDefaults /
   * SharedPreferences, the `PttBindingStore` pattern) and applies it. Must
   * emit `onStateChanged` before resolving — see the note on `start()` above:
   * the model never writes its mirror from this call's return value.
   *
   * Typed `string` and not the union because Codegen accepts string-literal
   * unions in *type aliases*, not in method parameters. `radio.native.ts`
   * narrows it on the way in.
   */
  setAudioMode(mode: string): Promise<void>;
```

- [ ] **Step 4: Run the spec test — it passes, and typecheck now fails loudly**

Run: `pnpm test __tests__/native-radio-spec.test.ts`
Expected: PASS.

Run: `pnpm typecheck`
Expected: FAIL — a list of `Property 'audioRoute' is missing` errors. That list is the
worklist for the next two steps.

- [ ] **Step 5: Extend the domain types**

In `src/radio/radio.types.ts`, insert above `RadioState`:

```ts
/** Spec section 8. `usb` renders like `wired`; only `bluetooth` carries a name. */
export type AudioRouteKind = 'speaker' | 'wired' | 'bluetooth' | 'usb';

/** The two audio profiles of section 7. Never `auto` — `auto` is not a profile. */
export type AudioProfileMode = 'voice' | 'media';

/** The persisted section 8 setting. `auto` runs the policy; the others pin it. */
export type AudioMode = 'auto' | 'voice' | 'media';

export type AudioRoute = {
  kind: AudioRouteKind;
  /** The accessory's own name, for Bluetooth routes only. */
  label?: string;
  /** The profile the engine is actually running. The UI renders it, never computes it. */
  mode: AudioProfileMode;
};
```

In `RadioState`, between `pttButton` and `pttPairing`:

```ts
  /** Spec section 8. Always present: there is always a route in use. */
  audioRoute: AudioRoute;
  /** Spec section 8. Persisted natively and mirrored here through `stateChanged`. */
  audioMode: AudioMode;
```

And extend `initialRadioState`:

```ts
export const initialRadioState: RadioState = {
  status: 'off',
  nearbyCount: 0,
  transmitting: false,
  receiving: false,
  pttButton: {configured: false, connected: false},
  audioRoute: {kind: 'speaker', mode: 'voice'},
  audioMode: 'auto',
};
```

- [ ] **Step 6: Add the wrapper method**

In `src/radio/radio.native.ts`, add to the `RadioNativeApi` type, after `forgetPtt`:

```ts
  /**
   * Section 8. Fire-and-forget: the engine stores the setting and republishes
   * the state, so the caller never writes the mirror from this result.
   */
  setAudioMode(mode: AudioMode): Promise<NativeRadioError | null>;
```

Extend the type import at the top of the file:

```ts
import type {AudioMode, RadioNativeEvent, RadioState} from './radio.types';
```

And add the implementation inside the object `createRadioNative` returns, next to
`selectPttCandidate`:

```ts
    setAudioMode: mode =>
      invokeVoid('setAudioMode', native => native.setAudioMode(mode)),
```

- [ ] **Step 7: Repair every literal typecheck flagged**

Add these two fields to each full-state literal. They are all `speaker`/`voice`/`auto`,
which is what `initialRadioState` says a fresh radio holds:

```ts
  audioRoute: {kind: 'speaker', mode: 'voice'},
  audioMode: 'auto',
```

Sites, all of which `pnpm typecheck` names:

- `src/radio/radio.native.mock.ts` — the initial `let state: NativeRadioState = {...}`
  (around line 81), the rebuild inside `abortPairing` (around line 125), `toOffState()`
  (around line 160), and the rebuild inside `reset()` (around line 333). Also extend
  `clone()` so the route object is copied rather than shared:

```ts
const clone = (state: NativeRadioState): NativeRadioState => ({
  status: state.status,
  nearbyCount: state.nearbyCount,
  transmitting: state.transmitting,
  receiving: state.receiving,
  pttButton: {...state.pttButton},
  audioRoute: {...state.audioRoute},
  audioMode: state.audioMode,
  ...(state.pttPairing
    ? {
        pttPairing: {
          phase: state.pttPairing.phase,
          candidates: state.pttPairing.candidates.map(candidate => ({
            ...candidate,
          })),
        },
      }
    : {}),
});
```

  `radio.native.mock.ts` also stops satisfying `Spec` because `setAudioMode` is missing. Add
  the minimal citizen for now — Task 2 gives it real behaviour:

```ts
    async setAudioMode(mode: string) {
      apply({audioMode: mode as NativeRadioState['audioMode']});
      publishState();
    },
```

- `__tests__/radio-native.test.ts` — the `nativeState` literal (around line 20).
- `__tests__/radio-model.test.ts` — the `readyState` literal (around line 37).
- `__tests__/app-model.test.ts` — the `readyState` literal (around line 25) and the
  `midPairing` literal (around line 87).

Every other construction in those files spreads one of the above, or spreads
`initialRadioState`, and needs no change.

`__tests__/radio-model.test.ts` also replaces `RadioNative` with a hand-written jest mock
object. Add one line to it so the mocked API matches the real one:

```ts
    setAudioMode: jest.fn(),
```

- [ ] **Step 8: Run the task gate**

Run:

```
pnpm typecheck && pnpm lint && pnpm test __tests__/native-radio-spec.test.ts __tests__/radio-native.test.ts __tests__/radio-model.test.ts __tests__/app-model.test.ts __tests__/radio-native-mock.test.ts
```

Expected: all green. No `android/` or `ios/` file was touched, so no native leg runs.

- [ ] **Step 9: Commit**

```bash
git add specs/NativeRadio.ts src/radio/radio.types.ts src/radio/radio.native.ts src/radio/radio.native.mock.ts __tests__/native-radio-spec.test.ts __tests__/radio-native.test.ts __tests__/radio-model.test.ts __tests__/app-model.test.ts
git commit -m "feat(contract): publish audioRoute and audioMode, add setAudioMode"
```

---

## Task 2: The mock engine and its scenarios

The mock is the only complete implementation of the contract until wave 2, so it is what the
screen and model tests actually exercise. It must be a good citizen: publish before
resolving, and preserve the persisted setting across a power cycle.

**Files:**
- Modify: `src/radio/radio.native.mock.ts`
- Modify: `src/radio/radio.mock.scripts.ts`
- Modify: `__tests__/radio-native-mock.test.ts`

**Interfaces:**
- Consumes: `NativeAudioRoute`, `NativeRadioState.audioRoute`, `NativeRadioState.audioMode`,
  `Spec.setAudioMode(mode: string): Promise<void>` (Task 1).
- Produces: mock scenarios whose timelines carry `audioRoute` patches — the `happy` scenario
  moves speaker → bluetooth `AirPods Pro` voice → media → voice → speaker, and the `solo`
  scenario moves speaker → wired → speaker. Tasks 7 and 8 assert against those timings.

- [ ] **Step 1: Write the failing tests**

Append to `__tests__/radio-native-mock.test.ts`:

```ts
describe('the mock engine — section 8 audio route and mode', () => {
  it('boots on the speaker in voice, with the setting on auto', async () => {
    const {radio} = harness('happy');
    const state = await radio.getState();

    expect(state.audioRoute).toEqual({kind: 'speaker', mode: 'voice'});
    expect(state.audioMode).toBe('auto');
  });

  it('walks the happy scenario onto a Bluetooth headset and into media', async () => {
    const {radio, clock, states} = harness('happy');
    await radio.start();

    clock.advance(3000);
    expect(states.at(-1)?.audioRoute).toEqual({
      kind: 'bluetooth',
      label: 'AirPods Pro',
      mode: 'voice',
    });

    clock.advance(3000);
    expect(states.at(-1)?.audioRoute.mode).toBe('media');

    clock.advance(9000);
    expect(states.at(-1)?.audioRoute.mode).toBe('voice');

    clock.advance(2000);
    expect(states.at(-1)?.audioRoute).toEqual({kind: 'speaker', mode: 'voice'});
  });

  it('puts the solo scenario on wired headphones and back', async () => {
    const {radio, clock, states} = harness('solo');
    await radio.start();

    clock.advance(2000);
    expect(states.at(-1)?.audioRoute).toEqual({kind: 'wired', mode: 'voice'});

    clock.advance(2000);
    expect(states.at(-1)?.audioRoute).toEqual({kind: 'speaker', mode: 'voice'});
  });

  it('publishes the pinned mode before setAudioMode resolves', async () => {
    const {radio, states} = harness('happy');
    await radio.start();
    const before = states.length;

    await radio.setAudioMode('media');

    expect(states.length).toBeGreaterThan(before);
    expect(states.at(-1)?.audioMode).toBe('media');
    expect(states.at(-1)?.audioRoute.mode).toBe('media');
  });

  it('leaves the effective mode alone when the pin goes back to auto', async () => {
    const {radio, clock, states} = harness('happy');
    await radio.start();
    clock.advance(6000);
    expect(states.at(-1)?.audioRoute.mode).toBe('media');

    await radio.setAudioMode('auto');

    expect(states.at(-1)?.audioMode).toBe('auto');
    expect(states.at(-1)?.audioRoute.mode).toBe('media');
  });

  it('keeps the setting across a power cycle, the way native storage would', async () => {
    const {radio} = harness('happy');
    await radio.start();
    await radio.setAudioMode('voice');
    await radio.stop();

    const state = await radio.getState();
    expect(state.status).toBe('off');
    expect(state.audioMode).toBe('voice');
    expect(state.audioRoute).toEqual({kind: 'speaker', mode: 'voice'});
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm test __tests__/radio-native-mock.test.ts`
Expected: FAIL — no scenario carries an `audioRoute` patch, and `setAudioMode` does not
touch `audioRoute.mode` or survive `stop()`.

- [ ] **Step 3: Give the scenarios routes**

In `src/radio/radio.mock.scripts.ts`, add the shared constants immediately below
`const NO_BUTTON`:

```ts
/**
 * Section 8. The scenarios are data: these are the route snapshots the
 * timelines below step through, named once so the two Bluetooth entries cannot
 * drift apart.
 */
const SPEAKER: NativeAudioRoute = {kind: 'speaker', mode: 'voice'};
const WIRED: NativeAudioRoute = {kind: 'wired', mode: 'voice'};
const HEADSET_VOICE: NativeAudioRoute = {
  kind: 'bluetooth',
  label: 'AirPods Pro',
  mode: 'voice',
};
const HEADSET_MEDIA: NativeAudioRoute = {...HEADSET_VOICE, mode: 'media'};
```

Extend the type import at the top of the file:

```ts
import type {
  NativeAudioRoute,
  NativePttButtonState,
  NativePttCandidate,
  NativePttConfiguration,
  NativeRadioState,
} from '../../specs/NativeRadio';
```

Replace the `happy` timeline with:

```ts
    timeline: [
      {at: 800, kind: 'state', patch: {status: 'ready'}},
      {at: 2000, kind: 'state', patch: {nearbyCount: 1}},
      // The headset connects mid-session: section 9's "BT headset connects, no
      // music" row.
      {at: 3000, kind: 'state', patch: {audioRoute: HEADSET_VOICE}},
      {at: 5000, kind: 'state', patch: {nearbyCount: 2}},
      // Music starts -- section 7's VOICE -> MEDIA switch.
      {at: 6000, kind: 'state', patch: {audioRoute: HEADSET_MEDIA}},
      {at: 8000, kind: 'state', patch: {receiving: true}},
      {at: 11000, kind: 'state', patch: {receiving: false}},
      // Music stops -- MEDIA -> VOICE after the long side of the hysteresis.
      {at: 12000, kind: 'state', patch: {audioRoute: HEADSET_VOICE}},
      // The headset walks out of range: straight back to the loudspeaker.
      {at: 14000, kind: 'state', patch: {audioRoute: SPEAKER}},
    ],
```

Replace the `solo` timeline with:

```ts
    timeline: [
      {at: 800, kind: 'state', patch: {status: 'ready'}},
      // Wired headphones: playback moves, the phone mic stays. No profile
      // conflict exists off Bluetooth Classic, so the mode never leaves voice.
      {at: 2000, kind: 'state', patch: {audioRoute: WIRED}},
      {at: 4000, kind: 'state', patch: {audioRoute: SPEAKER}},
    ],
```

Leave the other five scenarios' timelines untouched: they inherit the speaker/voice route the
mock engine boots with, which is the correct reading for a phone with nothing plugged in.

- [ ] **Step 4: Make the mock engine honour the setting**

In `src/radio/radio.native.mock.ts`, replace the placeholder `setAudioMode` from Task 1 with:

```ts
    /**
     * Section 8. Stores the pin and republishes *before* resolving, per the
     * implementation note in `specs/NativeRadio.ts`.
     *
     * A `voice`/`media` pin also moves the effective `audioRoute.mode`, because
     * that is what a real engine's profile apply does and it is the only way a
     * mock-driven screen can show a pinned mode. This is not policy: `auto`
     * deliberately leaves the effective mode exactly where the timeline put it,
     * and no hysteresis, rate limit or PTT-raise rule lives here. Section 7 is
     * P1's, on both platforms.
     */
    async setAudioMode(mode: string) {
      const pin = mode as NativeRadioState['audioMode'];
      state = {
        ...state,
        audioMode: pin,
        audioRoute:
          pin === 'auto' ? state.audioRoute : {...state.audioRoute, mode: pin},
      };
      publishState();
    },
```

Then make the setting survive a power cycle, the way native storage will. `toOffState()`
already rebuilds the state field by field; give it the preserved setting and a bare speaker
route — a stopped radio holds no accessory route:

```ts
  const toOffState = (): NativeRadioState => ({
    status: 'off',
    nearbyCount: 0,
    transmitting: false,
    receiving: false,
    pttButton: preservedButton(),
    // Section 8's setting is stored natively (UserDefaults / SharedPreferences),
    // so it outlives the engine exactly as the PTT binding does. The route does
    // not: a stopped radio is holding nothing.
    audioRoute: {kind: 'speaker', mode: 'voice'},
    audioMode: state.audioMode,
  });
```

`start()` and `stop()` both go through `toOffState()`, so both inherit this. Leave
`reset()`'s rebuild as Task 1 left it — `reset` re-arms the whole engine and a fresh engine
is on `auto`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm test __tests__/radio-native-mock.test.ts`
Expected: PASS, including the six new cases.

- [ ] **Step 6: Run the task gate**

Run:

```
pnpm typecheck && pnpm lint && pnpm test __tests__/radio-native-mock.test.ts __tests__/radio-backend-flag.test.ts
```

Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add src/radio/radio.native.mock.ts src/radio/radio.mock.scripts.ts __tests__/radio-native-mock.test.ts
git commit -m "feat(mock): drive route changes and both audio modes from the scenarios"
```

---

## Task 3: The Reatom model action and `audioRoute` propagation

§10's "JS: mock-radio tests for `audioRoute` propagation". This task proves an engine
`stateChanged` carrying a route reaches the mirror, and that the action never writes the
mirror itself.

**Files:**
- Modify: `src/radio/radio.model.ts`
- Modify: `__tests__/radio-model.test.ts`

**Interfaces:**
- Consumes: `RadioNativeApi.setAudioMode(mode: AudioMode)` (Task 1); `AudioMode`,
  `AudioRoute` from `src/radio/radio.types` (Task 1).
- Produces: `radio.setAudioMode(mode: AudioMode): Promise<Error | null>` — the action Task 8's
  settings row calls. It records a failure in `lastRadioError` and returns it; on success it
  returns `null` and writes nothing to the mirror.

- [ ] **Step 1: Write the failing tests**

Append to `__tests__/radio-model.test.ts`, inside the existing top-level `describe`:

```ts
describe('section 8 — the audio route and the audioMode setting', () => {
  it('mirrors an audioRoute arriving on a stateChanged event', () => {
    radio.applyEvent({
      type: 'stateChanged',
      state: {
        ...readyState,
        audioRoute: {kind: 'bluetooth', label: 'AirPods Pro', mode: 'media'},
        audioMode: 'auto',
      },
    });

    expect(radio().audioRoute).toEqual({
      kind: 'bluetooth',
      label: 'AirPods Pro',
      mode: 'media',
    });
    expect(radio().audioMode).toBe('auto');
  });

  it('starts on the speaker in voice, with the setting on auto', () => {
    expect(radio().audioRoute).toEqual({kind: 'speaker', mode: 'voice'});
    expect(radio().audioMode).toBe('auto');
  });

  it('passes the setting to the engine and does not touch the mirror', async () => {
    native.setAudioMode.mockResolvedValue(null);

    const result = await radio.setAudioMode('media');

    expect(native.setAudioMode).toHaveBeenCalledWith('media');
    expect(result).toBeNull();
    // The engine is the source of truth: nothing moved until it says so.
    expect(radio().audioMode).toBe('auto');
  });

  it('records a failed setAudioMode as the last error', async () => {
    const failure = new NativeRadioCallError({method: 'setAudioMode'});
    native.setAudioMode.mockResolvedValue(failure);

    const result = await radio.setAudioMode('voice');

    expect(result).toBe(failure);
    expect(lastRadioError()).toBe(failure);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm test __tests__/radio-model.test.ts`
Expected: FAIL — `radio.setAudioMode is not a function`.

- [ ] **Step 3: Add the action**

In `src/radio/radio.model.ts`, extend the type import:

```ts
import type {AudioMode, RadioNativeEvent, RadioState, ScreenState} from './radio.types';
```

and add this action inside the object returned from `.extend(...)`, immediately after
`selectPttCandidate`:

```ts
      /**
       * Spec section 8. The engine stores the setting (UserDefaults /
       * SharedPreferences) and republishes the state, so there is deliberately
       * no `sync()` and no local write here: the mirror moves when the
       * `stateChanged` event arrives, never from this call's return value.
       */
      setAudioMode(mode: AudioMode) {
        return command(() => RadioNative.setAudioMode(mode));
      },
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test __tests__/radio-model.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the task gate**

Run:

```
pnpm typecheck && pnpm lint && pnpm test __tests__/radio-model.test.ts __tests__/app-model.test.ts
```

Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add src/radio/radio.model.ts __tests__/radio-model.test.ts
git commit -m "feat(model): mirror audioRoute and pass audioMode to the engine"
```

---

## Task 4: Theme tokens for the two new surfaces

One small task on its own, because `src/ui/theme.ts` is the file the reconciliation branch
rebuilt and every value added here is read straight off the canvas. A reviewer checks these
against `design/theme.css` and the two `.dc.html` files and nothing else.

**Files:**
- Modify: `src/ui/theme.ts`
- Modify: `__tests__/audio-route-ui.test.tsx` — created here, extended by Tasks 5 and 6

**Interfaces:**
- Consumes: nothing.
- Produces, all appended to `src/ui/theme.ts`:
  - `type.routeLabel`, `type.segment`, `type.segmentSelected` (all `TextStyle`).
  - `export const routeReadout = {gap: 9, iconSize: 14, strokeWidth: 1.5, sideInset: 90, bottomInset: 44}`.
  - `export const segmented = {paddingVertical: 14}`.
  - `testIds.audioRoute = 'audio-route'`, `testIds.audioMode = 'audio-mode'`.

- [ ] **Step 1: Write the failing test**

Create `__tests__/audio-route-ui.test.tsx`:

```tsx
import {
  colors,
  fonts,
  radii,
  routeReadout,
  segmented,
  testIds,
  type,
} from '../src/ui/theme';

describe('theme tokens for the section 8 surfaces', () => {
  it('carries the canvas .routeline metrics', () => {
    // design/01 Radio.dc.html: font-size 11px, letter-spacing 0.14em, --faint.
    expect(type.routeLabel.fontSize).toBe(11);
    expect(type.routeLabel.letterSpacing).toBe(1.54);
    expect(type.routeLabel.fontFamily).toBe(fonts.mono);
    expect(colors.textFaint).toBe('#57626c');
  });

  it('carries the canvas .route geometry', () => {
    // design/01 Radio.dc.html: gap 9px, 14x14 icon at stroke-width 1.5,
    // left/right 90px, bottom 44px.
    expect(routeReadout).toEqual({
      gap: 9,
      iconSize: 14,
      strokeWidth: 1.5,
      sideInset: 90,
      bottomInset: 44,
    });
  });

  it('carries the canvas .seg metrics', () => {
    // design/02 Settings.dc.html: 13.5px, 0.04em, radius 14px, padding 14px 0,
    // selected is --ink on #0c0e10 at weight 500.
    expect(type.segment.fontSize).toBe(13.5);
    expect(type.segment.letterSpacing).toBe(0.54);
    expect(type.segment.fontFamily).toBe(fonts.mono);
    expect(type.segmentSelected.fontFamily).toBe(fonts.monoMedium);
    expect(type.segmentSelected.fontSize).toBe(type.segment.fontSize);
    expect(segmented.paddingVertical).toBe(14);
    expect(radii.md).toBe(14);
    expect(colors.hairlineRaised).toBe('#2e363e');
    expect(colors.textInverse).toBe('#0c0e10');
  });

  it('appends the two new test ids without renaming any existing one', () => {
    expect(testIds.audioRoute).toBe('audio-route');
    expect(testIds.audioMode).toBe('audio-mode');
    expect(testIds.radioScreen).toBe('radio-screen');
    expect(testIds.settingsScreen).toBe('settings-screen');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm test __tests__/audio-route-ui.test.tsx`
Expected: FAIL — `routeReadout` and `segmented` are not exported from `../src/ui/theme`.

- [ ] **Step 3: Append the tokens**

In `src/ui/theme.ts`, add three entries at the end of the `type` object, keeping the existing
entries untouched:

```ts
  /**
   * `.routeline` -- the radio screen's audio route readout. The canvas states
   * no line-height for it; 15 is `type.label`'s figure for the same 11px
   * mono face, so the two engraved lines share a metric.
   */
  routeLabel: {
    fontFamily: fonts.mono,
    fontSize: 11,
    lineHeight: 15,
    letterSpacing: 1.54,
  },
  /** `.seg span` -- an unselected audio-mode segment. */
  segment: {
    fontFamily: fonts.mono,
    fontSize: 13.5,
    lineHeight: 18,
    letterSpacing: 0.54,
  },
  /** `.seg .on` -- the selected segment, which the canvas sets at weight 500. */
  segmentSelected: {
    fontFamily: fonts.monoMedium,
    fontSize: 13.5,
    lineHeight: 18,
    letterSpacing: 0.54,
  },
```

Then add two token groups after `sizes` and before `motion`:

```ts
/**
 * `.routeline` and `.route` in `design/01 Radio.dc.html` -- the audio route
 * readout. Its own geometry group rather than entries scattered through
 * `spacing`/`sizes`, because the canvas states these five figures together and
 * none of them belongs on a shared scale.
 */
export const routeReadout = {
  /** `.routeline` gap between the glyph and the line. */
  gap: 9,
  /** The `viewBox` the three route glyphs are drawn in. */
  iconSize: 14,
  /** `stroke-width` on every route glyph. */
  strokeWidth: 1.5,
  /** `.route` left and right, clearing the gear and the power key. */
  sideInset: 90,
  /** `.route` bottom. */
  bottomInset: 44,
} as const;

/** `.seg` in `design/02 Settings.dc.html` -- the audio mode control. */
export const segmented = {
  /** `.seg span` padding: `14px 0`. */
  paddingVertical: 14,
} as const;
```

Finally, append to `testIds`, after `settingsBack` and before the pairing block:

```ts
  audioRoute: 'audio-route',
  audioMode: 'audio-mode',
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test __tests__/audio-route-ui.test.tsx __tests__/theme-and-fonts.test.ts`
Expected: PASS. `theme-and-fonts.test.ts` iterates every `type` entry asserting no
`fontWeight` and a bundled `fontFamily`; the three new entries satisfy both.

- [ ] **Step 5: Run the task gate**

Run:

```
pnpm typecheck && pnpm lint && pnpm test __tests__/audio-route-ui.test.tsx __tests__/theme-and-fonts.test.ts __tests__/ui-primitives.test.tsx
```

Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add src/ui/theme.ts __tests__/audio-route-ui.test.tsx
git commit -m "feat(theme): add the canvas tokens for the route readout and the audio mode control"
```

---

## Task 5: The route readout primitive

**Files:**
- Create: `src/ui/RouteIcon.tsx`
- Create: `src/ui/RouteReadout.tsx`
- Modify: `__tests__/audio-route-ui.test.tsx`

**Interfaces:**
- Consumes: `AudioRoute`, `AudioRouteKind` from `src/radio/radio.types` (Task 1);
  `type.routeLabel`, `routeReadout`, `colors.textFaint` from `src/ui/theme` (Task 4).
- Produces:
  - `src/ui/RouteIcon.tsx`: `export function RouteIcon({kind, color}: {kind: AudioRouteKind; color: string}): JSX.Element`.
  - `src/ui/RouteReadout.tsx`: `export function RouteReadout({route, testID}: {route: AudioRoute; testID?: string}): JSX.Element`. Task 7 renders exactly this.

- [ ] **Step 1: Write the failing test**

Append to `__tests__/audio-route-ui.test.tsx`:

```tsx
import React from 'react';
import {Text} from 'react-native';

import {RouteReadout} from '../src/ui/RouteReadout';
import {renderScreen} from '../jest/renderScreen';

describe('RouteReadout', () => {
  const read = async (
    route: Parameters<typeof RouteReadout>[0]['route'],
    locale?: 'en' | 'ru',
  ) => {
    const screen = await renderScreen(
      <RouteReadout route={route} testID={testIds.audioRoute} />,
      locale ? {locale} : {},
    );
    const text = screen.texts().join('');
    screen.unmount();
    return text;
  };

  // Every string below is read off design/01 Radio.dc.html frame 08.
  it('renders the speaker route the way the canvas states it', async () => {
    expect(await read({kind: 'speaker', mode: 'voice'})).toBe('Speaker · radio');
  });

  it('renders wired and usb identically -- "usb routes render like wired"', async () => {
    expect(await read({kind: 'wired', mode: 'voice'})).toBe('Headphones · radio');
    expect(await read({kind: 'usb', mode: 'voice'})).toBe('Headphones · radio');
  });

  it('shows the Bluetooth headset name as reported', async () => {
    expect(await read({kind: 'bluetooth', label: 'AirPods', mode: 'voice'})).toBe(
      'AirPods · radio',
    );
    expect(await read({kind: 'bluetooth', label: 'AirPods', mode: 'media'})).toBe(
      'AirPods · music, phone mic',
    );
  });

  it('falls back to the generic accessory word for a nameless headset', async () => {
    expect(await read({kind: 'bluetooth', mode: 'voice'})).toBe(
      'Headphones · radio',
    );
  });

  it('renders in Russian', async () => {
    expect(await read({kind: 'speaker', mode: 'voice'}, 'ru')).toBe(
      'Динамик · рация',
    );
    expect(await read({kind: 'wired', mode: 'voice'}, 'ru')).toBe(
      'Наушники · рация',
    );
    expect(
      await read({kind: 'bluetooth', label: 'AirPods', mode: 'media'}, 'ru'),
    ).toBe('AirPods · музыка, микрофон телефона');
  });

  it('is an indicator, never a picker: it carries no press handler', async () => {
    const screen = await renderScreen(
      <RouteReadout
        route={{kind: 'speaker', mode: 'voice'}}
        testID={testIds.audioRoute}
      />,
    );
    const node = screen.find(testIds.audioRoute);

    expect(node.props.onPress).toBeUndefined();
    expect(node.props.accessibilityRole).not.toBe('button');
    screen.unmount();
  });

  it('uppercases the line the way the canvas does', async () => {
    const screen = await renderScreen(
      <RouteReadout
        route={{kind: 'speaker', mode: 'voice'}}
        testID={testIds.audioRoute}
      />,
    );
    const label = screen.find(testIds.audioRoute).findByType(Text);

    expect(StyleSheet.flatten(label.props.style).textTransform).toBe('uppercase');
    screen.unmount();
  });
});
```

Add `StyleSheet` to the `react-native` import at the top of the file:
`import {StyleSheet, Text} from 'react-native';`

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm test __tests__/audio-route-ui.test.tsx`
Expected: FAIL — `Cannot find module '../src/ui/RouteReadout'`.

- [ ] **Step 3: Write the icons**

Create `src/ui/RouteIcon.tsx`:

```tsx
import React from 'react';
import {StyleSheet, View} from 'react-native';

import {routeReadout} from './theme';
import type {AudioRouteKind} from '../radio/radio.types';

/**
 * The three route glyphs of `design/01 Radio.dc.html`'s `.routeline`.
 *
 * The canvas draws them as inline SVG. React Native ships no SVG renderer and
 * this plan may not add a dependency, so each `<path>` is transcribed to a
 * `View` composition **at the canvas's own viewBox coordinates** -- a 14x14 box
 * with 1.5-wide strokes. Those coordinates are artwork geometry, not design
 * tokens, which is why they are literals here while the box size and the stroke
 * width come from `routeReadout` in `theme.ts`.
 *
 * One knowingly accepted delta: SVG centres a stroke on its path while React
 * Native insets a border. Every ring below is therefore sized to its *outer*
 * edge -- diameter + strokeWidth -- so the drawn shape lands where the canvas
 * puts it. At 14pt the residual difference is sub-pixel.
 *
 * `usb` deliberately falls through to the wired glyph: the canvas says "USB
 * ROUTES RENDER LIKE WIRED".
 */
export function RouteIcon({
  kind,
  color,
}: {
  kind: AudioRouteKind;
  color: string;
}) {
  return (
    <View
      style={styles.box}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants">
      {kind === 'speaker' ? <SpeakerGlyph color={color} /> : null}
      {kind === 'wired' || kind === 'usb' ? (
        <HeadphonesGlyph color={color} />
      ) : null}
      {kind === 'bluetooth' ? <BluetoothGlyph color={color} /> : null}
    </View>
  );
}

/**
 * `M2 5.2h2.6L8.4 2v10L4.6 8.8H2z` -- the filled cone, decomposed into the
 * rectangle 2,5.2..8.4,8.8 plus the two wedges the path's diagonals cut -- and
 * `M10.6 4.6a3.4 3.4 0 0 1 0 4.8`, the shallow arc, drawn as a clipped ring.
 */
function SpeakerGlyph({color}: {color: string}) {
  return (
    <>
      <View
        style={[styles.cone, {backgroundColor: color}]}
        testID="route-icon-speaker"
      />
      <View style={[styles.coneTop, {borderBottomColor: color}]} />
      <View style={[styles.coneBottom, {borderTopColor: color}]} />
      <View style={styles.waveClip}>
        <View style={[styles.wave, {borderColor: color}]} />
      </View>
    </>
  );
}

/**
 * `M2.6 10.5V7a4.4 4.4 0 0 1 8.8 0v3.5` -- the headband, whose arc plus two
 * legs is exactly a box with two rounded top corners and no bottom edge -- plus
 * the two filled earcups.
 */
function HeadphonesGlyph({color}: {color: string}) {
  return (
    <>
      <View
        style={[styles.band, {borderColor: color}]}
        testID="route-icon-headphones"
      />
      <View style={[styles.cupLeft, {backgroundColor: color}]} />
      <View style={[styles.cupRight, {backgroundColor: color}]} />
    </>
  );
}

/**
 * `M3.6 4.4 10.4 9.8 7 12.5 7 1.5 10.4 4.2 3.6 9.6` -- the rune, as its five
 * strokes: the vertical stem, two long diagonals and two short flag edges. Each
 * diagonal is a bar of the segment's own length, centred on the segment's
 * midpoint and rotated to its angle.
 */
function BluetoothGlyph({color}: {color: string}) {
  return (
    <>
      <View
        style={[styles.btStem, {backgroundColor: color}]}
        testID="route-icon-bluetooth"
      />
      <View style={[styles.btLongDown, {backgroundColor: color}]} />
      <View style={[styles.btLongUp, {backgroundColor: color}]} />
      <View style={[styles.btFlagUpper, {backgroundColor: color}]} />
      <View style={[styles.btFlagLower, {backgroundColor: color}]} />
    </>
  );
}

const S = routeReadout.strokeWidth;

/** A stroke of `length`, centred on (`x`, `y`) and rotated by `deg`. */
const bar = (x: number, y: number, length: number, deg: number) =>
  ({
    position: 'absolute',
    left: x - length / 2,
    top: y - S / 2,
    width: length,
    height: S,
    borderRadius: S / 2,
    transform: [{rotate: `${deg}deg`}],
  }) as const;

const styles = StyleSheet.create({
  box: {width: routeReadout.iconSize, height: routeReadout.iconSize},

  // ---- speaker ----
  cone: {position: 'absolute', left: 2, top: 5.2, width: 6.4, height: 3.6},
  coneTop: {
    position: 'absolute',
    left: 4.6,
    top: 2,
    width: 0,
    height: 0,
    borderLeftWidth: 3.8,
    borderLeftColor: 'transparent',
    borderBottomWidth: 3.2,
  },
  coneBottom: {
    position: 'absolute',
    left: 4.6,
    top: 8.8,
    width: 0,
    height: 0,
    borderLeftWidth: 3.8,
    borderLeftColor: 'transparent',
    borderTopWidth: 3.2,
  },
  // The arc's centre is 2.41 to the left of its chord, so the full ring is
  // drawn and clipped down to the 1.6-wide sliver the canvas actually shows.
  waveClip: {
    position: 'absolute',
    left: 10.6,
    top: 4.6,
    width: 1.6,
    height: 4.8,
    overflow: 'hidden',
  },
  wave: {
    position: 'absolute',
    left: -6.56,
    top: -1.75,
    width: 8.3,
    height: 8.3,
    borderRadius: 4.15,
    borderWidth: S,
  },

  // ---- headphones ----
  band: {
    position: 'absolute',
    left: 2.6,
    top: 2.6,
    width: 8.8,
    height: 7.9,
    borderWidth: S,
    borderBottomWidth: 0,
    borderTopLeftRadius: 4.4,
    borderTopRightRadius: 4.4,
  },
  cupLeft: {
    position: 'absolute',
    left: 1.6,
    top: 8.6,
    width: 2.4,
    height: 3.6,
    borderRadius: 1,
  },
  cupRight: {
    position: 'absolute',
    left: 10,
    top: 8.6,
    width: 2.4,
    height: 3.6,
    borderRadius: 1,
  },

  // ---- bluetooth ----
  btStem: {
    position: 'absolute',
    left: 7 - S / 2,
    top: 1.5,
    width: S,
    height: 11,
    borderRadius: S / 2,
  },
  /** (3.6,4.4) -> (10.4,9.8) */
  btLongDown: bar(7, 7.1, 8.68, 38.46),
  /** (10.4,4.2) -> (3.6,9.6) */
  btLongUp: bar(7, 6.9, 8.68, 141.54),
  /** (7,1.5) -> (10.4,4.2) */
  btFlagUpper: bar(8.7, 2.85, 4.34, 38.45),
  /** (10.4,9.8) -> (7,12.5) */
  btFlagLower: bar(8.7, 11.15, 4.34, 141.55),
});
```

- [ ] **Step 4: Write the readout**

Create `src/ui/RouteReadout.tsx`:

```tsx
import React from 'react';
import {StyleSheet, Text, View} from 'react-native';
import {useLingui} from '@lingui/react/macro';

import {RouteIcon} from './RouteIcon';
import {colors, routeReadout, type} from './theme';
import type {AudioRoute} from '../radio/radio.types';

/**
 * The canvas's `.routeline` (`design/01 Radio.dc.html`, frame 08 shows every
 * state): route glyph, device, mode -- one uppercase line.
 *
 * The canvas's own note governs the copy: "BLUETOOTH SHOWS THE HEADSET NAME AS
 * REPORTED, OTHER KINDS A GENERIC LABEL · VOICE MODE READS 'RADIO', MEDIA READS
 * 'MUSIC, PHONE MIC'". The line is composed from a device word and a mode word
 * joined by the canvas's own separator rather than translated whole, because
 * the Bluetooth device word is a name that arrives from native. Composing them
 * reproduces all four strings the canvas states, byte for byte.
 *
 * `mode` is rendered, never computed -- section 7's policy lives on the
 * platforms. And this is an indicator: the canvas says "INDICATOR ONLY -- NEVER
 * A PICKER, NO TAP TARGET", so nothing here is pressable.
 */
export function RouteReadout({
  route,
  testID,
}: {
  route: AudioRoute;
  testID?: string;
}) {
  const {t} = useLingui();

  const device =
    route.kind === 'bluetooth' && route.label
      ? route.label
      : route.kind === 'speaker'
        ? t`Speaker`
        : t`Headphones`;

  const mode = route.mode === 'voice' ? t`radio` : t`music, phone mic`;

  return (
    <View testID={testID} style={styles.line}>
      <RouteIcon kind={route.kind} color={colors.textFaint} />
      <Text numberOfLines={1} style={styles.label}>
        {`${device} · ${mode}`}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  line: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: routeReadout.gap,
  },
  label: {...type.routeLabel, color: colors.textFaint, textTransform: 'uppercase'},
});
```

- [ ] **Step 5: Fill both catalogs**

Run: `pnpm lingui:extract`

Then open `src/locales/ru/messages.po` and fill the four new entries. `en` is the source
locale and lingui fills it from the source string; verify it did.

```
msgid "Speaker"
msgstr "Динамик"

msgid "Headphones"
msgstr "Наушники"

msgid "radio"
msgstr "рация"

msgid "music, phone mic"
msgstr "музыка, микрофон телефона"
```

Every Russian string above is read off `design/01 Radio.dc.html`'s `ru` props block.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm test __tests__/audio-route-ui.test.tsx __tests__/locale-coverage.test.ts`
Expected: PASS.

- [ ] **Step 7: Run the task gate**

Run:

```
pnpm typecheck && pnpm lint && pnpm test __tests__/audio-route-ui.test.tsx __tests__/locale-coverage.test.ts __tests__/i18n.test.ts __tests__/ui-independence.test.ts
```

Expected: all green. `ui-independence.test.ts` passes because `RouteReadout` imports a
**type** from `src/radio/radio.types` and nothing from `radio.native` or `specs/`.

- [ ] **Step 8: Commit**

```bash
git add src/ui/RouteIcon.tsx src/ui/RouteReadout.tsx __tests__/audio-route-ui.test.tsx src/locales/en/messages.po src/locales/ru/messages.po
git commit -m "feat(ui): build the audio route readout to the canvas"
```

---

## Task 6: The segmented control primitive

**Files:**
- Create: `src/ui/SegmentedControl.tsx`
- Modify: `__tests__/audio-route-ui.test.tsx`

**Interfaces:**
- Consumes: `type.segment`, `type.segmentSelected`, `segmented`, `radii.md`,
  `colors.hairlineRaised`, `colors.textMuted`, `colors.text`, `colors.textInverse` (Task 4).
- Produces: `export function SegmentedControl<T extends string>({options, value, onChange, testID}: {options: ReadonlyArray<{value: T; label: string}>; value: T; onChange: (next: T) => void; testID?: string}): JSX.Element`.
  Each option is rendered with `testID={`${testID}-${option.value}`}` when `testID` is given —
  Task 8 presses `audio-mode-voice` and friends.

- [ ] **Step 1: Write the failing test**

Append to `__tests__/audio-route-ui.test.tsx`:

```tsx
import {SegmentedControl} from '../src/ui/SegmentedControl';

describe('SegmentedControl', () => {
  const options = [
    {value: 'auto', label: 'Auto'},
    {value: 'voice', label: 'Radio'},
    {value: 'media', label: 'Music'},
  ] as const;

  it('renders every option and derives an id per option', async () => {
    const screen = await renderScreen(
      <SegmentedControl
        options={options}
        value="auto"
        onChange={jest.fn()}
        testID="audio-mode"
      />,
    );

    expect(screen.hasText('Auto')).toBe(true);
    expect(screen.hasText('Radio')).toBe(true);
    expect(screen.hasText('Music')).toBe(true);
    expect(screen.findAll('audio-mode-auto')).toHaveLength(1);
    expect(screen.findAll('audio-mode-voice')).toHaveLength(1);
    expect(screen.findAll('audio-mode-media')).toHaveLength(1);

    screen.unmount();
  });

  it('reports the selected option through accessibility state', async () => {
    const screen = await renderScreen(
      <SegmentedControl
        options={options}
        value="voice"
        onChange={jest.fn()}
        testID="audio-mode"
      />,
    );

    expect(screen.find('audio-mode-voice').props.accessibilityState).toEqual({
      selected: true,
    });
    expect(screen.find('audio-mode-auto').props.accessibilityState).toEqual({
      selected: false,
    });

    screen.unmount();
  });

  it('paints the selected segment the way the canvas does', async () => {
    const screen = await renderScreen(
      <SegmentedControl
        options={options}
        value="voice"
        onChange={jest.fn()}
        testID="audio-mode"
      />,
    );

    const selected = StyleSheet.flatten(
      screen.find('audio-mode-voice').findByType(Text).props.style,
    );
    const unselected = StyleSheet.flatten(
      screen.find('audio-mode-auto').findByType(Text).props.style,
    );

    expect(selected.color).toBe(colors.textInverse);
    expect(selected.fontFamily).toBe(fonts.monoMedium);
    expect(unselected.color).toBe(colors.textMuted);
    expect(unselected.fontFamily).toBe(fonts.mono);

    screen.unmount();
  });

  it('reports the option the user pressed', async () => {
    const onChange = jest.fn();
    const screen = await renderScreen(
      <SegmentedControl
        options={options}
        value="auto"
        onChange={onChange}
        testID="audio-mode"
      />,
    );

    await screen.press('audio-mode-media');

    expect(onChange).toHaveBeenCalledWith('media');
    screen.unmount();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm test __tests__/audio-route-ui.test.tsx`
Expected: FAIL — `Cannot find module '../src/ui/SegmentedControl'`.

- [ ] **Step 3: Write the primitive**

Create `src/ui/SegmentedControl.tsx`:

```tsx
import React from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';

import {colors, radii, segmented, type} from './theme';

/**
 * The canvas's `.seg` (`design/02 Settings.dc.html`): a row of equal segments
 * inside one rounded outline, with hairline seams between them and the selected
 * one inverted.
 *
 * Generic and copy-free on purpose -- it takes finished labels, exactly as
 * `ActionButton` and `ScreenFrame` do, so the screen owns the translating.
 *
 * The seam is `border-left` on every segment but the first, matching the
 * canvas's `.seg span + span` rule; drawing it as a separate element would put
 * a node between two flex children and break the equal-width split.
 */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  testID,
}: {
  options: ReadonlyArray<{value: T; label: string}>;
  value: T;
  onChange: (next: T) => void;
  testID?: string;
}) {
  return (
    <View testID={testID} style={styles.row} accessibilityRole="radiogroup">
      {options.map((option, index) => {
        const selected = option.value === value;

        return (
          <Pressable
            key={option.value}
            testID={testID ? `${testID}-${option.value}` : undefined}
            accessibilityRole="radio"
            accessibilityState={{selected}}
            accessibilityLabel={option.label}
            onPress={() => onChange(option.value)}
            style={[
              styles.segment,
              index > 0 && styles.seam,
              selected && styles.selected,
            ]}>
            <Text style={selected ? styles.selectedLabel : styles.label}>
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    borderWidth: 1,
    borderColor: colors.hairlineRaised,
    borderRadius: radii.md,
    overflow: 'hidden',
  },
  segment: {
    flex: 1,
    paddingVertical: segmented.paddingVertical,
    alignItems: 'center',
    justifyContent: 'center',
  },
  seam: {borderLeftWidth: 1, borderLeftColor: colors.hairlineRaised},
  selected: {backgroundColor: colors.text},
  label: {...type.segment, color: colors.textMuted},
  selectedLabel: {...type.segmentSelected, color: colors.textInverse},
});
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test __tests__/audio-route-ui.test.tsx`
Expected: PASS.

- [ ] **Step 5: Run the task gate**

Run:

```
pnpm typecheck && pnpm lint && pnpm test __tests__/audio-route-ui.test.tsx __tests__/ui-primitives.test.tsx __tests__/ui-independence.test.ts
```

Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add src/ui/SegmentedControl.tsx __tests__/audio-route-ui.test.tsx
git commit -m "feat(ui): build the canvas segmented control"
```

---

## Task 7: The indicator on the radio screen

**Files:**
- Modify: `src/screens/RadioScreen.tsx`
- Modify: `__tests__/radio-screen.test.tsx`

**Interfaces:**
- Consumes: `RouteReadout` (Task 5); `testIds.audioRoute`, `routeReadout` (Task 4);
  `radio().audioRoute` (Tasks 1 and 3); the `happy` scenario's route timeline (Task 2).
- Produces: nothing later tasks read.

- [ ] **Step 1: Write the failing tests**

Append to `__tests__/radio-screen.test.tsx`, inside the top-level `describe`:

```tsx
describe('the section 8 audio route readout', () => {
  it('is hidden while the radio is off', async () => {
    const screen = await openRadio('happy');

    expect(screen.findAll(testIds.audioRoute)).toHaveLength(0);

    screen.unmount();
  });

  it('names the speaker once the radio is on', async () => {
    const screen = await openRadio('happy');
    await screen.press(testIds.powerOnArea);
    await screen.advance(1000);

    expect(screen.findAll(testIds.audioRoute)).toHaveLength(1);
    expect(screen.hasText('Speaker · radio')).toBe(true);

    screen.unmount();
  });

  it('follows the engine onto the headset and into media', async () => {
    const screen = await openRadio('happy');
    await screen.press(testIds.powerOnArea);

    await screen.advance(3500);
    expect(screen.hasText('AirPods Pro · radio')).toBe(true);

    await screen.advance(3000);
    expect(screen.hasText('AirPods Pro · music, phone mic')).toBe(true);

    screen.unmount();
  });

  it('stays put while receiving -- it names the live mic', async () => {
    const screen = await openRadio('happy');
    await screen.press(testIds.powerOnArea);
    await screen.advance(9000);

    expect(screen.hasText('RECEIVING...')).toBe(true);
    expect(screen.findAll(testIds.audioRoute)).toHaveLength(1);
    // It is a sibling of the corner controls, not a child: the corners recede
    // while live and the readout must not.
    expect(
      screen.find(testIds.audioRoute).props.style,
    ).not.toBeUndefined();
    expect(
      screen
        .find('corner-controls')
        .findAll(node => node.props.testID === testIds.audioRoute),
    ).toHaveLength(0);

    screen.unmount();
  });

  it('renders in Russian', async () => {
    const screen = await renderScreen(<RadioScreen onSettingsPress={jest.fn()} />, {
      scenario: 'happy',
      locale: 'ru',
    });
    await screen.press(testIds.powerOnArea);
    await screen.advance(1000);

    expect(screen.hasText('Динамик · рация')).toBe(true);

    screen.unmount();
  });
});
```

Add the two imports the last case needs, if the file does not already carry them:

```tsx
import {renderScreen} from '../jest/renderScreen';
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm test __tests__/radio-screen.test.tsx`
Expected: FAIL — every case that expects the readout finds no `audio-route` node.

- [ ] **Step 3: Render it**

In `src/screens/RadioScreen.tsx`:

Extend the two existing imports:

```tsx
import {RouteReadout} from '../ui/RouteReadout';
import {
  chassis,
  colors,
  motion,
  routeReadout,
  spacing,
  testIds,
  type,
} from '../ui/theme';
```

In the **live** return — the one that renders `styles.corners`, not the `off` branch and not
`RadioErrorState` — add one element as the **last child** of the root `<View>`, after the
`corner-controls` view:

```tsx
        <View style={styles.route} pointerEvents="none">
          <RouteReadout route={radio().audioRoute} testID={testIds.audioRoute} />
        </View>
```

And append the style:

```tsx
  /**
   * `.route` in `design/01 Radio.dc.html`: bottom centre, clear of the gear and
   * the power key. Deliberately a sibling of `styles.corners` rather than a
   * child -- the corners recede while transmitting or receiving and the canvas
   * says the readout "STAYS PUT ... IT NAMES THE LIVE MIC". `pointerEvents` is
   * off because the whole screen underneath is the PTT touch area and the
   * canvas says "INDICATOR ONLY -- NEVER A PICKER, NO TAP TARGET".
   */
  route: {
    position: 'absolute',
    left: routeReadout.sideInset,
    right: routeReadout.sideInset,
    bottom: routeReadout.bottomInset,
    alignItems: 'center',
  },
```

The `off` branch returns before this point and is left untouched, which is the canvas's
"HIDDEN WHILE OFF". `RadioErrorState` is likewise untouched: section 13's error screen is
not a radio state.

**If the merged trunk's `RadioScreen.tsx` differs from the excerpt this plan was written
against** — the reconciliation branch was still in flight at planning time — the rule to
apply is the invariant, not the line numbers: the readout is the last child of the root
`View` in the branch that renders a running radio, it is a sibling of whatever container
carries the receding corner controls, and it keeps the `styles.route` geometry above.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test __tests__/radio-screen.test.tsx`
Expected: PASS.

- [ ] **Step 5: Run the task gate**

Run:

```
pnpm typecheck && pnpm lint && pnpm test __tests__/radio-screen.test.tsx __tests__/app-smoke.test.tsx __tests__/navigation.test.tsx __tests__/stage2-acceptance.test.tsx __tests__/radio-error-state.test.tsx
```

Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add src/screens/RadioScreen.tsx __tests__/radio-screen.test.tsx
git commit -m "feat(radio-screen): show the audio route and mode"
```

---

## Task 8: The `audioMode` row on the settings screen

**Files:**
- Modify: `src/screens/SettingsScreen.tsx`
- Modify: `src/locales/{en,ru}/messages.po`
- Modify: `__tests__/settings-screen.test.tsx`

**Interfaces:**
- Consumes: `SegmentedControl` (Task 6); `testIds.audioMode` (Task 4);
  `radio().audioMode` and `radio.setAudioMode` (Tasks 1 and 3).
- Produces: nothing later tasks read.

- [ ] **Step 1: Write the failing tests**

Append to `__tests__/settings-screen.test.tsx`, inside the top-level `describe`:

```tsx
describe('the section 8 audio mode setting', () => {
  const openSettings = (locale?: 'en' | 'ru') =>
    renderScreen(
      <SettingsScreen onBack={jest.fn()} onConnectPress={jest.fn()} />,
      locale ? {scenario: 'happy', locale} : {scenario: 'happy'},
    );

  it('offers the three modes with auto selected by default', async () => {
    const screen = await openSettings();

    expect(screen.hasText('AUDIO')).toBe(true);
    expect(screen.hasText('Auto')).toBe(true);
    expect(screen.hasText('Radio')).toBe(true);
    expect(screen.hasText('Music')).toBe(true);
    expect(
      screen.find(`${testIds.audioMode}-auto`).props.accessibilityState,
    ).toEqual({selected: true});

    screen.unmount();
  });

  it('explains what the setting is for', async () => {
    const screen = await openSettings();

    expect(screen.hasText('What a Bluetooth headset is for.')).toBe(true);

    screen.unmount();
  });

  it('pins the mode through the engine and mirrors what comes back', async () => {
    const screen = await openSettings();

    await screen.press(`${testIds.audioMode}-media`);

    expect(radio().audioMode).toBe('media');
    expect(
      screen.find(`${testIds.audioMode}-media`).props.accessibilityState,
    ).toEqual({selected: true});
    expect(
      screen.find(`${testIds.audioMode}-auto`).props.accessibilityState,
    ).toEqual({selected: false});

    screen.unmount();
  });

  it('offers no device picker -- the pin is the only audio control', async () => {
    const screen = await openSettings();

    expect(screen.findAll('audio-device-picker')).toHaveLength(0);
    expect(screen.findAll(testIds.audioMode)).toHaveLength(1);

    screen.unmount();
  });

  it('renders in Russian', async () => {
    const screen = await openSettings('ru');

    expect(screen.hasText('ЗВУК')).toBe(true);
    expect(screen.hasText('Авто')).toBe(true);
    expect(screen.hasText('Рация')).toBe(true);
    expect(screen.hasText('Музыка')).toBe(true);

    screen.unmount();
  });
});
```

Add the model import at the top of the file, if it is not already there:

```tsx
import {radio} from '../src/radio/radio.model';
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm test __tests__/settings-screen.test.tsx`
Expected: FAIL — no `AUDIO` section is rendered.

- [ ] **Step 3: Add the section**

In `src/screens/SettingsScreen.tsx`, extend the imports:

```tsx
import {SegmentedControl} from '../ui/SegmentedControl';
import {colors, radii, spacing, testIds, type} from '../ui/theme';
import type {AudioMode} from '../radio/radio.types';
```

Inside the component, above the `return`, build the option list. The three labels are read
off `design/02 Settings.dc.html`:

```tsx
  const audioModes: ReadonlyArray<{value: AudioMode; label: string}> = [
    {value: 'auto', label: t`Auto`},
    {value: 'voice', label: t`Radio`},
    {value: 'media', label: t`Music`},
  ];
```

Add this second section immediately after the closing `</View>` of the PTT section and
before `</ScreenFrame>`:

```tsx
      <View style={styles.section}>
        <Text style={[type.label, styles.sectionTitle]}>
          <Trans>AUDIO</Trans>
        </Text>

        <SegmentedControl
          options={audioModes}
          value={radio().audioMode}
          onChange={wrap((mode: AudioMode) => {
            void radio.setAudioMode(mode);
          })}
          testID={testIds.audioMode}
        />

        <Text style={[type.caption, styles.note]}>
          <Trans>
            What a Bluetooth headset is for. Auto decides by itself: instant
            push-to-talk while nothing else is playing, full music quality when
            something is. Radio and Music pin one behavior.
          </Trans>
        </Text>
      </View>
```

And append the one new style:

```tsx
  /** `.note` in `design/02 Settings.dc.html`. */
  note: {color: colors.textFaint, marginTop: spacing.md},
```

The section reuses the existing `styles.section`, which already matches the canvas's `.card`
(surface fill, hairline border, `spacing.lg` padding). `ScreenFrame` supplies the gutter.

**Note for the executor:** if the merged trunk's `SettingsScreen.tsx` has been rebuilt by the
reconciliation branch and no longer carries `styles.section`, use whatever card primitive it
introduced instead of adding a second card style — the canvas puts this section in the same
`.card` as the PTT one, and the reconciliation's primitives are reused, never duplicated.

- [ ] **Step 4: Fill both catalogs**

Run: `pnpm lingui:extract`

Then fill the new `ru` entries. Every Russian string is read off
`design/02 Settings.dc.html`'s `ru` props block; `ЗВУК` is that block's `audioSection`
("Звук") in the uppercase the `.slabel` rule renders it in, matching how `КНОПКА PTT`
already sits in this catalog.

```
msgid "AUDIO"
msgstr "ЗВУК"

msgid "Auto"
msgstr "Авто"

msgid "Radio"
msgstr "Рация"

msgid "Music"
msgstr "Музыка"

msgid "What a Bluetooth headset is for. Auto decides by itself: instant push-to-talk while nothing else is playing, full music quality when something is. Radio and Music pin one behavior."
msgstr "Для чего используется Bluetooth-гарнитура. «Авто» решает само: мгновенная рация, пока ничего не играет, и полное качество музыки, когда она включена. «Рация» и «Музыка» закрепляют один режим."
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm test __tests__/settings-screen.test.tsx __tests__/locale-coverage.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the task gate**

Run:

```
pnpm typecheck && pnpm lint && pnpm test __tests__/settings-screen.test.tsx __tests__/locale-coverage.test.ts __tests__/i18n.test.ts __tests__/navigation.test.tsx __tests__/app-smoke.test.tsx
```

Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add src/screens/SettingsScreen.tsx src/locales/en/messages.po src/locales/ru/messages.po __tests__/settings-screen.test.tsx
git commit -m "feat(settings): add the audio mode setting to the canvas"
```

---

## Task 9: The Android bridge stub

Mechanical only. The Codegen spec regenerates from `specs/NativeRadio.ts` during the Gradle
build; `NativeRadioSpec` gains an abstract `setAudioMode`, and Kotlin will not compile until
`NativeRadioModule` overrides it. This task keeps that compile green and nothing more.

**Not here:** real route detection, mode policy, and `SharedPreferences` persistence are
P4's. This stub emits a **constant** and stores nothing. The `com.oru.bridge` glue transfers
ownership to P4 at sync 1.

**Files:**
- Modify: `android/app/src/main/java/com/oru/bridge/RadioBridgeCore.kt`
- Modify: `android/app/src/main/java/com/oru/bridge/NativeRadioModule.kt`
- Modify: `android/app/src/test/java/com/oru/bridge/RadioBridgeCoreTest.kt`
- Modify: `__tests__/native-radio-bridge.test.ts` (the Android half only)

**Interfaces:**
- Consumes: `NativeRadioState.audioRoute`, `NativeRadioState.audioMode`,
  `Spec.setAudioMode(mode: string)` (Task 1).
- Produces: a projected state map that always carries
  `"audioRoute" to mapOf("kind" to "speaker", "mode" to "voice")` and `"audioMode" to "auto"`.
  P4 replaces both.

- [ ] **Step 1: Write the failing tests**

In `__tests__/native-radio-bridge.test.ts`, extend the Android method list:

```ts
  it('implements all nine amended section 6.1 methods', () => {
    [
      'start',
      'stop',
      'pressPtt',
      'releasePtt',
      'getState',
      'configurePtt',
      'selectPttCandidate',
      'forgetPtt',
      'setAudioMode',
    ].forEach(method => {
      expect(module()).toMatch(new RegExp(`override fun ${method}\\(`));
    });
  });
```

And append to `android/app/src/test/java/com/oru/bridge/RadioBridgeCoreTest.kt`:

```kotlin
    @Suppress("UNCHECKED_CAST")
    private fun Map<String, Any?>.route(): Map<String, Any?> =
        this["audioRoute"] as Map<String, Any?>

    @Test
    fun `every projection carries the placeholder audio route and mode`() {
        val output = RecordingOutput()
        val core = core(output)

        // Off, starting, running and failed: the four branches of project().
        assertEquals("speaker", core.snapshot().route()["kind"])
        assertEquals("voice", core.snapshot().route()["mode"])
        assertEquals("auto", core.snapshot()["audioMode"])

        core.start()
        assertEquals("speaker", output.last().route()["kind"])
        assertEquals("auto", output.last()["audioMode"])

        core.onEngineState(RadioState(status = RadioStatus.READY, nearbyCount = 2))
        assertEquals("speaker", output.last().route()["kind"])
        assertEquals("voice", output.last().route()["mode"])
        assertEquals("auto", output.last()["audioMode"])

        core.startFailed("boom", "the service would not start")
        assertEquals("speaker", output.last().route()["kind"])
        assertEquals("auto", output.last()["audioMode"])
    }

    @Test
    fun `the placeholder route never carries a label`() {
        // Section 8: `label` is optional and only Bluetooth routes have one.
        // An absent key, never a null -- the same rule `pttButton.name` follows.
        assertFalse(core(RecordingOutput()).snapshot().route().containsKey("label"))
    }
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm test __tests__/native-radio-bridge.test.ts`
Expected: FAIL — `override fun setAudioMode(` is not in `NativeRadioModule.kt`.

Run: `node scripts/build-android.js :app:testDebugUnitTest`
Expected: FAIL — the Kotlin build reports `NativeRadioModule` is not abstract and does not
implement the abstract member `setAudioMode`. (If the first Gradle run instead times out
downloading, that is known flake 1: re-run once.)

- [ ] **Step 3: Project the placeholder**

In `android/app/src/main/java/com/oru/bridge/RadioBridgeCore.kt`, add the constant just
above the `class RadioBridgeCore` declaration:

```kotlin
/**
 * Spec section 8, as a compile-keeping stub.
 *
 * The Codegen spec now publishes `audioRoute` and `audioMode`, and JavaScript
 * types both as required, so every projection must carry them or the screens
 * read `undefined` through a type that promises otherwise. P4 replaces this
 * constant with the real `AudioRouteController` output and the real
 * SharedPreferences-backed setting; until then the bridge reports the honest
 * pre-routing truth -- loudspeaker, voice profile, no pin -- and stores nothing.
 *
 * `label` is deliberately absent rather than null: section 8 makes it optional
 * and only a Bluetooth route has one, the same rule `pttButton.name` follows.
 */
private val PLACEHOLDER_AUDIO_ROUTE: Map<String, Any?> = mapOf(
    "kind" to "speaker",
    "mode" to "voice",
)

private const val PLACEHOLDER_AUDIO_MODE = "auto"
```

Then wrap the projection so all four branches carry them. Replace `project()` with:

```kotlin
    private fun project(): Map<String, Any?> {
        val state = lastEngineState
        val projected = when {
            failed -> offState() + ("status" to "error")
            !running -> offState()
            state == null -> offState() + ("status" to "starting")
            else -> withoutNulls(state.toMap())
        }

        // Added here, after `withoutNulls`, rather than inside `offState()` and
        // `RadioState.toMap()`: `toMap()` lives in `com.oru.radio`, which this
        // plan does not own, and one place is one place to delete when P4
        // publishes the real route.
        return projected +
            ("audioRoute" to PLACEHOLDER_AUDIO_ROUTE) +
            ("audioMode" to PLACEHOLDER_AUDIO_MODE)
    }
```

- [ ] **Step 4: Accept the setter**

In `android/app/src/main/java/com/oru/bridge/NativeRadioModule.kt`, add after `forgetPtt`:

```kotlin
    /**
     * Spec section 8, stubbed. Accepts the call so the regenerated spec
     * compiles and resolves immediately; it stores nothing and changes nothing.
     * P4 replaces this with the SharedPreferences write and the profile apply,
     * and with the `onStateChanged` emission `specs/NativeRadio.ts` requires of
     * every mutating method.
     */
    override fun setAudioMode(mode: String, promise: Promise) {
        attach()
        promise.resolve(null)
    }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm test __tests__/native-radio-bridge.test.ts`
Expected: PASS.

Run: `node scripts/build-android.js :app:testDebugUnitTest`
Expected: PASS, including the two new `RadioBridgeCoreTest` cases.

- [ ] **Step 6: Run the task gate**

This task touched `android/`, so the gate carries both native legs:

```
pnpm typecheck && pnpm lint && pnpm test __tests__/native-radio-bridge.test.ts __tests__/android-radio.test.ts && node scripts/build-android.js :app:testDebugUnitTest && pnpm build:android
```

Expected: all green. Known flake 1 applies to both Gradle commands.

- [ ] **Step 7: Commit**

```bash
git add android/app/src/main/java/com/oru/bridge/RadioBridgeCore.kt android/app/src/main/java/com/oru/bridge/NativeRadioModule.kt android/app/src/test/java/com/oru/bridge/RadioBridgeCoreTest.kt __tests__/native-radio-bridge.test.ts
git commit -m "feat(android-bridge): stub audioRoute and setAudioMode to keep the spec compiling"
```

---

## Task 10: The iOS bridge stub

The mirror of Task 9, and the last task, because it carries this plan's acceptance beyond the
gates: the RadioKit test scheme does not compile `ios/Oru`, so the app-workspace build must be
run explicitly before this plan reports GREEN.

**Not here:** the real session configuration, route classification and UserDefaults
persistence are P3's. Nothing under `ios/Radio/` is touched — in particular
`RadioState.asDictionary` stays exactly as it is; the placeholder is injected in the app-side
bridge, which is the file P3 rewrites.

**Files:**
- Modify: `ios/Oru/RadioBridge.swift`
- Modify: `ios/Oru/NativeRadioModule.mm`
- Modify: `__tests__/native-radio-bridge.test.ts` (the iOS half only)

**Interfaces:**
- Consumes: the same Task 1 contract as Task 9.
- Produces: a projected dictionary that always carries
  `"audioRoute": ["kind": "speaker", "mode": "voice"]` and `"audioMode": "auto"`. P3 replaces
  both.

- [ ] **Step 1: Write the failing tests**

In `__tests__/native-radio-bridge.test.ts`, extend the iOS selector list:

```ts
  it('implements all nine amended section 6.1 selectors', () => {
    [
      '- (void)start:(RCTPromiseResolveBlock)resolve',
      '- (void)stop:(RCTPromiseResolveBlock)resolve',
      '- (void)pressPtt:(RCTPromiseResolveBlock)resolve',
      '- (void)releasePtt:(RCTPromiseResolveBlock)resolve',
      '- (void)getState:(RCTPromiseResolveBlock)resolve',
      '- (void)configurePtt:(RCTPromiseResolveBlock)resolve',
      '- (void)selectPttCandidate:(NSString *)deviceId',
      '- (void)forgetPtt:(RCTPromiseResolveBlock)resolve',
      '- (void)setAudioMode:(NSString *)mode',
    ].forEach(selector => expect(objcpp()).toContain(selector));
  });
```

And add, in the same iOS `describe` block:

```ts
  it('projects the section 8 placeholder route without touching RadioKit', () => {
    const swift = read('ios/Oru/RadioBridge.swift');

    expect(swift).toContain('placeholderAudioRoute');
    expect(swift).toMatch(/"kind": "speaker"/);
    expect(swift).toMatch(/"mode": "voice"/);
    expect(swift).toMatch(/"audioMode": "auto"/);
    // The real classification is P3's; the stub carries no routing logic.
    expect(swift).not.toMatch(/AVAudioSession/);
  });
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm test __tests__/native-radio-bridge.test.ts`
Expected: FAIL — neither the selector nor `placeholderAudioRoute` is present.

- [ ] **Step 3: Project the placeholder**

In `ios/Oru/RadioBridge.swift`, add these two properties in the `// MARK: - Projection`
section, immediately above `projectLocked()`:

```swift
    /// Spec section 8, as a compile-keeping stub — the twin of Android's
    /// `PLACEHOLDER_AUDIO_ROUTE`.
    ///
    /// The Codegen spec now publishes `audioRoute` and `audioMode`, and
    /// JavaScript types both as required, so every projection must carry them.
    /// P3 replaces this with the real route classification and the real
    /// UserDefaults-backed setting; until then the bridge reports the honest
    /// pre-routing truth — loudspeaker, voice profile, no pin — and stores
    /// nothing.
    ///
    /// It lives here and not in `RadioKit`'s `RadioState.asDictionary` on
    /// purpose: `ios/Radio` is P3's tree, and one place is one place to delete
    /// when the real publication lands.
    ///
    /// `label` is deliberately absent rather than `NSNull`: section 8 makes it
    /// optional and only a Bluetooth route has one — the same rule
    /// `pttButton.name` follows.
    private let placeholderAudioRoute: [String: Any] = [
        "kind": "speaker",
        "mode": "voice"
    ]

    private let placeholderAudioMode = "auto"
```

Then replace `projectLocked()` so every branch carries them:

```swift
    /// Caller holds `lock`.
    private func projectLocked() -> NSDictionary {
        if failed {
            return offDictionary(status: "error")
        }
        if !running {
            return offDictionary(status: "off")
        }
        guard let state = lastState else {
            return offDictionary(status: "starting")
        }

        var dictionary = state.asDictionary
        dictionary["audioRoute"] = placeholderAudioRoute
        dictionary["audioMode"] = placeholderAudioMode
        return dictionary as NSDictionary
    }
```

and extend `offDictionary(status:)`:

```swift
        return [
            "status": status,
            "nearbyCount": 0,
            "transmitting": false,
            "receiving": false,
            "pttButton": button.asDictionary,
            "audioRoute": placeholderAudioRoute,
            "audioMode": placeholderAudioMode
        ] as NSDictionary
```

Finally add the setter next to `forgetPtt`:

```swift
    /// Spec section 8, stubbed. Accepts the call so the regenerated spec
    /// compiles; it stores nothing and changes nothing. P3 replaces this with
    /// the UserDefaults write, the profile apply, and the `onStateChanged`
    /// emission `specs/NativeRadio.ts` requires of every mutating method.
    @objc public func setAudioMode(_ mode: String) {
    }
```

- [ ] **Step 4: Marshal the selector**

In `ios/Oru/NativeRadioModule.mm`, add after `forgetPtt:` and before `getTurboModule:`:

```objc
- (void)setAudioMode:(NSString *)mode
             resolve:(RCTPromiseResolveBlock)resolve
              reject:(RCTPromiseRejectBlock)reject
{
  [self attachIfNeeded];
  [ORURadioBridge.shared setAudioMode:mode];
  resolve(nil);
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm test __tests__/native-radio-bridge.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the task gate**

This task touched `ios/`, so the gate carries the RadioKit leg:

```
pnpm typecheck && pnpm lint && pnpm test __tests__/native-radio-bridge.test.ts __tests__/ios-radio-sources.test.ts __tests__/ios-config.test.ts && (cd ios/Radio && DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild test -scheme RadioKit -destination 'platform=iOS Simulator,name=iPhone 17')
```

Expected: all green. Known flakes 2, 4 and 5 all apply to that last command.

- [ ] **Step 7: Run this plan's acceptance beyond the gates**

The RadioKit scheme does **not** compile `ios/Oru`, so the stub this task just wrote is
still unverified. The sync-1 merge gate compiles it; run that leg here, in this worktree,
before reporting GREEN. The worktree has no `ios/Pods`, so `pod install` comes first:

```
cd ios && pod install
cd ios && DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild -workspace Oru.xcworkspace -scheme Oru -destination 'platform=iOS Simulator,name=iPhone 17' build
```

Expected: `BUILD SUCCEEDED`. This is the run that regenerates `OruSpecs` from the amended
`specs/NativeRadio.ts` and proves both `NativeRadioModule.mm` and `RadioBridge.swift`
satisfy it.

Note: `pod install` writes `ios/Pods/` and may touch `ios/Podfile.lock`. Do **not** commit
`ios/Pods/` — it is generated. Commit `ios/Podfile.lock` only if it actually changed, and say
so in the report if it did.

- [ ] **Step 8: Commit**

```bash
git add ios/Oru/RadioBridge.swift ios/Oru/NativeRadioModule.mm __tests__/native-radio-bridge.test.ts
git commit -m "feat(ios-bridge): stub audioRoute and setAudioMode to keep the spec compiling"
```

- [ ] **Step 9: Final whole-suite check before the branch is offered for merge**

```
pnpm typecheck && pnpm lint && pnpm test
```

Expected: the full suite green. Any failure here is a task that passed its own narrow
`<paths>` and broke a neighbour; fix it before reporting.

---

## Self-Review

**Spec coverage.**

| Spec requirement | Task |
|---|---|
| §2 G5 — "route + mode visible in the UI" | 5, 7 |
| §8 — `RadioState.audioRoute {kind, label?, mode}`, published through `stateChanged` | 1, 3 |
| §8 — Codegen spec regenerated accordingly | 1 (spec source); 9 and 10 run the regeneration |
| §8 — `audioMode: 'auto' \| 'voice' \| 'media'`, default `auto`, passed to native | 1 (contract), 3 (action), 8 (row) |
| §8 — compact indicator, route icon + BT device name + mode, strings via lingui | 5, 7 |
| §8 — "No picker" | 5 (no press handler), 8 (asserted absent) |
| §9 — the state shapes the behaviour table implies | 2 (the `happy` timeline walks the connect / music-start / music-stop / walk-away rows) |
| §10 JS — "mock-radio tests for `audioRoute` propagation and the indicator" | 2, 3, 7 |
| Schedule — compile-keeping native stubs, both platforms, no routing logic | 9, 10 |
| Schedule — acceptance beyond the gates: `pod install` + app-workspace build | 10, step 7 |

**Placeholder scan.** No task says "TBD", "handle edge cases", "add validation" or "similar
to Task N". Every code step carries the literal code. The one instruction that delegates
enumeration to a tool — Task 1 step 7, "repair every literal typecheck flagged" — names the
exact snippet to add, names all five files, and uses `pnpm typecheck` only to enumerate line
numbers that will have shifted after the external merges.

**Type consistency.** `AudioRoute` / `AudioRouteKind` / `AudioProfileMode` / `AudioMode` are
defined once in Task 1 and used under exactly those names in Tasks 3, 5, 6 and 8.
`NativeAudioRoute` is the Codegen twin and appears only in `specs/`, the mock and the mock
scripts. `RouteReadout({route, testID})` is produced in Task 5 and consumed with those exact
props in Task 7. `SegmentedControl({options, value, onChange, testID})` is produced in Task 6
and consumed with those exact props in Task 8, including the derived
`` `${testID}-${option.value}` `` id shape both tasks assert on. `radio.setAudioMode` is
produced in Task 3 and called in Task 8. `routeReadout` and `segmented` are produced in
Task 4 and consumed in Tasks 5, 6 and 7.
