# P7 `integration` — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Assemble the merged pieces into a running app — app entry, navigation, first-launch permission sequencing against the real OS prompts, the §11 declaration cross-check, smoke tests of the whole assembly, a README, and the operator-run Stage 4 on-device acceptance.

**Architecture:** Everything below wave 5 is already merged and green: two native engines, the `RadioNative` Turbo Module, the TypeScript domain (`radio.model.ts`, `app.model.ts`, the permission port), and every screen of §12/§12.1 built against the mock engine. Nothing mounts them. This plan writes the thin layer that does: a bootstrap module that activates i18n, subscribes the engine's event stream into the Reatom mirror, feeds `AppState` into `applyAppLifecycle` and takes the §6.2 boot snapshot; a hand-rolled route atom with a root component that mounts the four merged screens with their callbacks; a real `PermissionsBackend` behind the merged port; and one new P7-owned screen for the `ACCESS_BACKGROUND_LOCATION` step §11 records as open work.

**Tech Stack:** React Native 0.87 (New Architecture, TypeScript), Reatom v1001 (`@reatom/core`, `@reatom/react`), Lingui 6.6 (`@lingui/core` + `@lingui/react` + macros), errore 0.14, Jest + `react-test-renderer`. No navigation library and no permissions library are installed, and none may be added (see Global Constraints).

**Spec:** `docs/superpowers/specs/2026-08-13-offline-nearby-ptt-design.md` — §4, §6.2, §11, §12, §15 Stage 4.

**Schedule:** `docs/superpowers/execution/2026-08-13-offline-nearby-ptt.md`, block `### P7 integration — wave 5, track A`.

---

## Global Constraints

Every task's requirements implicitly include this section.

- **Task gate — the command every task's verification step runs:**
  `pnpm typecheck && pnpm lint && pnpm test <paths>`
  plus `pnpm build:android` **when the task touched `android/`**. No task in this plan is
  expected to touch `android/`; if one ends up doing so, that task's gate grows the Android
  build.
- **Known flakes:** none known — greenfield repository. Two standing environment caveats:
  (1) the first Gradle / NDK / CMake / dependency downloads are slow and can time out — a
  download failure or timeout is infrastructure, not a regression; re-run once before
  reporting. (2) No gate on this host compiles Swift — a green gate is **not** evidence of
  iOS health.
- **No new dependencies.** P1 pre-installed every runtime dependency the spec names so that
  P2–P7 never edit `package.json`'s `dependencies` or `devDependencies`. That rule still
  holds here: no navigation library, no `react-native-permissions`, no
  `@react-native-async-storage/async-storage`. Everything below uses React Native core
  (`AppState`, `PermissionsAndroid`, `Linking`, `Settings`, `BackHandler`, `Platform`,
  `DevSettings`) and what is already installed.
- **Fix wiring only.** Engines (`android/app/src/main/java/com/oru/radio/`,
  `ios/Radio/Sources/RadioKit/`), the bridge (`specs/NativeRadio.ts`, `com.oru.bridge`,
  `ios/Oru/RadioBridge.swift`, `ios/Oru/NativeRadioModule.mm`) and the merged screens
  (`src/screens/RadioScreen.tsx`, `SettingsScreen.tsx`, `PairingFlow.tsx`,
  `OnboardingFlow.tsx`, `src/ui/`) are merged and accepted. A behavioural defect found in
  any of them is **reported in the task report, not silently repaired here**. The one
  exception the spec itself authorises is the new `ACCESS_BACKGROUND_LOCATION` step, and
  Task 7 builds it as a **new** screen file rather than by editing `OnboardingFlow.tsx`.
- **`src/screens/` and `src/ui/` are policed by `__tests__/ui-independence.test.ts`:** no
  file under them may match `radio.native`, `TurboModuleRegistry`, `NativeModules`,
  `specs/NativeRadio`, `PermissionsAndroid`, or `react-native/Libraries`. The new screen in
  Task 7 lives under `src/screens/` and therefore reaches the platform only through a model.
- **Localization (§12.2):** two locales, English default, Russian for a `ru` system locale,
  no in-app picker. All new JS copy goes through Lingui macros (`Trans` / `t`), is extracted
  with `pnpm lingui:extract`, and **must** be translated in `src/locales/ru/messages.po` —
  `__tests__/locale-coverage.test.ts` fails the gate on an untranslated source message.
- **§13 error convention:** fallible functions return `Error | T` and never throw. New code
  follows it.
- **Reatom conventions in this repository:** the global `context` from `@reatom/core`; tests
  call `context.reset()` in `beforeEach`; a callback that crosses a non-Reatom boundary
  (a native event emitter, an `AppState` listener) is wrapped in `bind`; every reactive read
  inside an async action happens **before** the first `await`; promises inside actions are
  awaited through `wrap`.
- **Ownership for this wave:** P7 is the only plan in wave 5, so there is no intra-wave
  shared-file rule. Every file this plan writes is listed in the File Structure section.

---

## Two rulings this plan makes, and why

An implementer must not "correct" either of these; both are load-bearing.

### 1. App entry calls `radio.sync()`, never `radio.start()`

The schedule's `Owns` line lists "`radio.start()`" among app-entry concerns. That phrasing
predates the 2026-08-18 power-control design and is **not** followed here, because three
spec statements contradict it:

- §6.2: "On UI start or resume: `getState()` → Reatom sync, then live `stateChanged` events
  keep the mirror current." `sync()`, not `start()`.
- §12: `off` is a full main-screen state — "RADIO OFF" / "TAP TO TURN ON" — reachable at
  launch. Auto-starting at entry makes it unreachable and turns a first-class designed state
  into dead code.
- §5/§12: the power toggle is "the one deliberate way to turn the always-hot radio, **and its
  battery cost**, on and off", and §6.2 says it drives the model's existing `start()`/`stop()`.
  `RadioScreen` (merged) already calls `radio.start()` from the toggle. A second call site at
  app entry would fight it.

So: app entry takes one `sync()` snapshot at boot, `applyAppLifecycle` takes another on every
resume, and `start()` has exactly one caller — the power key. This is recorded in the plan
report as a deliberate departure from the schedule's summary phrasing.

### 2. The iOS permission backend reports `granted` and does not prompt

iOS exposes no JavaScript API to request or query the three permissions §11 lists for it, and
for local network Apple exposes **no** request or query API at all, in any language. What iOS
does provide is the model §11's iOS column is written for: `Info.plist` usage descriptions
plus a prompt raised by the OS at first use. Every one of those first uses already exists in
merged code — `AudioEngine.swift` awaits record permission when the session opens the
microphone, `BleGattPttDriver.swift` instantiates `CBCentralManager`, and NearbyConnections
browses Bonjour — so on iOS the prompts arrive when the user powers the radio on.

The iOS backend therefore answers `request()` with `'granted'`, meaning *"nothing in this app
blocks this step; the OS will ask when it needs to"*, and onboarding on iOS is the explanation
sequence §11 asks for, immediately ahead of the real prompts. `openSettings()` is real on both
platforms (`Linking.openSettings()`).

The alternative — a new iOS Turbo Module wrapping `AVAudioApplication.requestRecordPermission`
and `CBManager.authorization` — would add Swift and Objective-C++ that no gate on this host
compiles, could still not answer for local network, and is exactly the kind of new native
work this plan's `Not here` line excludes. It is named as a possible follow-up in the plan
report; **do not build it here.**

---

## File Structure

**Created**

| File | Responsibility |
|---|---|
| `src/app/appEntry.ts` | The boot sequence: system locale → `initI18n`, dev-menu registration, `RadioNative.subscribe(radioEventListener)`, the `AppState` → `applyAppLifecycle` bridge, the §6.2 boot `sync()`. Returns a teardown. |
| `src/app/navigation.model.ts` | The route atom and the four navigation actions. Pure Reatom, no React, no platform. |
| `src/app/AppRoot.tsx` | Mounts one merged screen per route and wires their callbacks; owns the Android hardware back button. |
| `src/permissions/permissions.native.ts` | The real `PermissionsBackend` for each platform: `PermissionsAndroid` groups per §11 on Android, the explain-only backend on iOS, `Linking.openSettings()` on both. |
| `src/permissions/platform.gateway.ts` | The one seam for every remaining platform question first-launch sequencing asks (has-permissions, onboarding-completed flag, background-location state). An atom, so tests swap it. |
| `src/permissions/sequencing.model.ts` | §11's first-launch sequence as Reatom state: which route to open on, the background step's status, and its two actions. |
| `src/screens/BackgroundStep.tsx` | §11's still-open `ACCESS_BACKGROUND_LOCATION` step, as its own screen. New file — `OnboardingFlow.tsx` is not edited. |
| `jest/renderApp.tsx` | Renders the assembled `<App />` against the mock stack, without the per-render event subscription `renderScreen` does (app entry owns that now). |
| `docs/section-11-permission-crosscheck.md` | The §11 cross-check: every declaration, the merged code that uses it, and the verdict. |
| `docs/stage4-integration-acceptance.md` | The operator-run §15 Stage 4 checklist: full flow on both platforms, install to talking. |
| `__tests__/app-entry.test.ts`, `__tests__/navigation.test.tsx`, `__tests__/permissions-native.test.ts`, `__tests__/sequencing.test.ts`, `__tests__/background-step.test.tsx`, `__tests__/ios-app-entry.test.ts`, `__tests__/permission-crosscheck.test.ts`, `__tests__/app-smoke.test.tsx` | One suite per task. |

**Modified**

| File | Change |
|---|---|
| `App.tsx` | Replaced: the RN template screen becomes providers + `AppRoot` + the initial-route resolve. |
| `index.js` | Calls `bootstrapApp()` before registering the component. |
| `src/permissions/permissions.port.ts` | `resolveNativePermissions` delegates to the real backends; the dev default flips from `mock` to `native`, matching `radio.native.ts`. |
| `__tests__/App.test.tsx` | The template smoke test becomes an assertion about the real root. |
| `README.md` | Replaced with run instructions for both platforms. |
| `ios/Oru/AppDelegate.swift` | The Phase 0 spike bootstrap and its full-screen debug panel are removed. |

**Not modified by any task here:** anything under `android/`, `src/radio/`, `src/ptt/`,
`src/mock/`, `src/ui/`, `specs/`, the four merged screens, `src/i18n.ts`,
`src/permissions/permissions.types.ts`, `src/permissions/permissions.mock.ts`,
`src/permissions/onboarding.model.ts`, `src/app/app.model.ts`, `package.json`.

---

## Interfaces this plan consumes

Exact names and types from merged code. An implementer sees only their own task; this is the
whole vocabulary the tasks below draw on.

```ts
// src/i18n.ts
export const locales: readonly ['en', 'ru'];
export type AppLocale = 'en' | 'ru';
export const defaultLocale: AppLocale;              // 'en'
export function resolveLocale(systemLocale: string | undefined): AppLocale;
export function initI18n(systemLocale?: string): AppLocale;   // calls i18n.loadAndActivate

// src/radio/radio.types.ts
export type RadioStatus = 'off' | 'starting' | 'ready' | 'error';
export type ScreenState = 'off' | 'searching' | 'ready' | 'transmitting' | 'receiving';
export type RadioNativeEvent =
  | {type: 'stateChanged'; state: RadioState}
  | {type: 'error'; code: string; message: string};
export const initialRadioState: RadioState;

// src/radio/radio.native.ts
export type RadioNativeSubscription = {remove: () => void};
export const RadioNative: RadioNativeApi;           // .subscribe(listener) => Error | RadioNativeSubscription
export class NativeRadioUnavailableError extends Error {}
export class NativeRadioCallError extends Error {}

// src/radio/radio.model.ts
export const radio: Atom<RadioState> & {
  sync(): Promise<Error | RadioState>;
  start(): Promise<Error | RadioState>;
  stop(): Promise<Error | null>;
  pressPtt(): Promise<Error | null>;
  releasePtt(): Promise<Error | null>;
  configurePtt(): Promise<Error | PttConfiguration>;
  selectPttCandidate(deviceId: string): Promise<Error | null>;
  forgetPtt(): Promise<Error | RadioState>;
  applyEvent(event: RadioNativeEvent): void;
};
export const lastRadioError: Atom<Error | null>;
export const screenState: Atom<ScreenState>;
export const radioEventListener: (event: RadioNativeEvent) => void;   // already `bind`-wrapped

// src/app/app.model.ts
export type AppLifecycle = 'active' | 'background' | 'inactive';
export const appLifecycle: Atom<AppLifecycle>;
export const applyAppLifecycle: (next: AppLifecycle) => Promise<Error | RadioState | null>;

// src/permissions/permissions.types.ts
export type AppPermission = 'microphone' | 'bluetooth' | 'nearbyDevices';
export const APP_PERMISSIONS: readonly AppPermission[];
export type PermissionStatus = 'granted' | 'denied' | 'blocked';
export type PermissionsBackend = {
  request(permission: AppPermission): Promise<PermissionStatus>;
  openSettings(): Promise<void>;
};

// src/permissions/permissions.port.ts
export class PermissionsUnavailableError extends Error {}   // ctor arg {platform: string}
export type ResolvePermissions = () => PermissionsUnavailableError | PermissionsBackend;
export const Permissions: PermissionsPort;

// src/permissions/onboarding.model.ts
export const onboardingIndex, onboardingAnswers, onboardingPermission,
             onboardingFinished, onboardingStatus: Atom<...>;
export const advanceOnboarding, requestOnboardingPermission,
             openPermissionSettings, resetOnboarding: Action<...>;

// src/dev/mockScenarioDevMenu.ts
export type DevMenuHost = {addMenuItem(title: string, handler: () => void): void};
export function registerMockScenarioDevMenu(host?: DevMenuHost): void;

// The four merged screens
export const RadioScreen:    Component<{onSettingsPress: () => void}>;
export const SettingsScreen: Component<{onBack: () => void; onConnectPress: () => void}>;
export const PairingFlow:    Component<{onClose: () => void}>;
export const OnboardingFlow: Component<{onDone: () => void}>;

// src/ui/ — used by the one new screen
export function ScreenFrame(props: {title?: string; onBack?: () => void; backLabel?: string;
  backTestID?: string; testID?: string; children: React.ReactNode}): JSX.Element;
export function ActionButton(props: {label: string; onPress?: () => void;
  onPressIn?: () => void; onPressOut?: () => void;
  tone?: 'default' | 'primary' | 'danger'; disabled?: boolean;
  testID?: string; accessibilityLabel?: string}): JSX.Element;
export const colors, spacing, type, testIds, chassis;    // src/ui/theme.ts

// jest/renderScreen.tsx — the merged test harness
export async function renderScreen(element: React.ReactElement,
  options?: {locale?: 'en' | 'ru'; scenario?: MockScenarioName; reducedMotion?: boolean},
): Promise<RenderedScreen>;   // .press/.pressIn/.pressOut/.advance/.act/.find/.findAll/
                              // .texts/.hasText/.unmount
```

---

## Task 1: App entry — i18n, the engine event stream, `AppState`, the boot snapshot

**Files:**
- Create: `src/app/appEntry.ts`
- Test: `__tests__/app-entry.test.ts`

**Interfaces:**
- Consumes: `initI18n`, `AppLocale` (`src/i18n.ts`); `RadioNative`, `RadioNativeSubscription`
  (`src/radio/radio.native.ts`); `radio`, `radioEventListener`, `lastRadioError`
  (`src/radio/radio.model.ts`); `applyAppLifecycle`, `AppLifecycle` (`src/app/app.model.ts`);
  `registerMockScenarioDevMenu` (`src/dev/mockScenarioDevMenu.ts`).
- Produces:
  ```ts
  export type AppStateHost = {
    addEventListener(
      type: 'change',
      handler: (state: string) => void,
    ): {remove: () => void};
  };
  export type BootstrapHost = {
    appState?: AppStateHost;
    systemLocale?: string;
    devMenu?: DevMenuHost;
  };
  export type Bootstrapped = {locale: AppLocale; teardown: () => void};
  export function readSystemLocale(): string | undefined;
  export function toAppLifecycle(state: string): AppLifecycle;
  export function bootstrapApp(host?: BootstrapHost): Bootstrapped;
  ```
  Task 2 calls `bootstrapApp()` from `index.js`; Task 9's harness calls it per render.

- [ ] **Step 1: Write the failing test**

Create `__tests__/app-entry.test.ts`:

```ts
import {context} from '@reatom/core';
import {i18n} from '@lingui/core';

import {bootstrapApp, toAppLifecycle} from '../src/app/appEntry';
import {mockRadio} from '../src/radio/radio.native.mock';
import {radio} from '../src/radio/radio.model';
import {setMockScenario} from '../src/mock/mock.scenario';

jest.useFakeTimers({doNotFake: ['queueMicrotask']});

type Listener = (state: string) => void;

function fakeAppState() {
  const listeners: Listener[] = [];
  return {
    host: {
      addEventListener(_type: 'change', handler: Listener) {
        listeners.push(handler);
        return {
          remove() {
            listeners.splice(listeners.indexOf(handler), 1);
          },
        };
      },
    },
    listeners,
  };
}

beforeEach(() => {
  context.reset();
  setMockScenario('happy');
  mockRadio.reset({scenario: 'happy'});
});

describe('app entry — spec sections 6.2 and 12.2', () => {
  it('activates the system locale with an English fallback', () => {
    const russian = bootstrapApp({systemLocale: 'ru-RU', appState: fakeAppState().host});
    expect(russian.locale).toBe('ru');
    expect(i18n.locale).toBe('ru');
    russian.teardown();

    const other = bootstrapApp({systemLocale: 'de-DE', appState: fakeAppState().host});
    expect(other.locale).toBe('en');
    expect(i18n.locale).toBe('en');
    other.teardown();
  });

  it('takes the section 6.2 boot snapshot instead of starting the radio', async () => {
    const {teardown} = bootstrapApp({appState: fakeAppState().host});
    await Promise.resolve();

    // The engine is off until the power key says otherwise: app entry must not
    // call start(), or section 12's `off` state becomes unreachable.
    expect(radio().status).toBe('off');
    expect(mockRadio.startCalls()).toBe(0);
    teardown();
  });

  it('feeds engine events into the mirror', async () => {
    const {teardown} = bootstrapApp({appState: fakeAppState().host});

    await radio.start();
    jest.advanceTimersByTime(5000);
    await Promise.resolve();

    // `start()` only syncs once; `nearbyCount` rising is delivered by the
    // stateChanged stream, which only app entry subscribes.
    expect(radio().nearbyCount).toBeGreaterThan(0);
    teardown();
  });

  it('stops feeding the mirror after teardown', async () => {
    const {teardown} = bootstrapApp({appState: fakeAppState().host});
    await radio.start();
    teardown();

    const before = radio().nearbyCount;
    jest.advanceTimersByTime(10000);
    await Promise.resolve();
    expect(radio().nearbyCount).toBe(before);
  });

  it('re-syncs the mirror when the app returns to the foreground', async () => {
    const appState = fakeAppState();
    const {teardown} = bootstrapApp({appState: appState.host});
    await Promise.resolve();

    await radio.start();
    jest.advanceTimersByTime(5000);

    appState.listeners[0]('background');
    await Promise.resolve();
    appState.listeners[0]('active');
    await Promise.resolve();
    await Promise.resolve();

    expect(radio().status).not.toBe('off');
    teardown();
    expect(appState.listeners).toHaveLength(0);
  });

  it('registers one dev-menu entry per mock scenario', () => {
    const entries: string[] = [];
    const {teardown} = bootstrapApp({
      appState: fakeAppState().host,
      devMenu: {addMenuItem: title => entries.push(title)},
    });
    // `registerMockScenarioDevMenu` is a no-op outside __DEV__ and registers
    // once per process; asserting "no throw" is the contract app entry owns.
    expect(Array.isArray(entries)).toBe(true);
    teardown();
  });

  it('maps every AppState string onto the three lifecycle values', () => {
    expect(toAppLifecycle('active')).toBe('active');
    expect(toAppLifecycle('background')).toBe('background');
    expect(toAppLifecycle('inactive')).toBe('inactive');
    expect(toAppLifecycle('unknown')).toBe('inactive');
    expect(toAppLifecycle('extension')).toBe('inactive');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test __tests__/app-entry.test.ts`
Expected: FAIL — `Cannot find module '../src/app/appEntry'`.

If `mockRadio.startCalls()` does not exist on the merged mock, replace that one assertion
with `expect(radio().status).toBe('off')` alone and note the substitution in the task report
— do **not** add a counter to `src/radio/radio.native.mock.ts`, which is merged P6 code.

- [ ] **Step 3: Write the implementation**

Create `src/app/appEntry.ts`:

```ts
import {AppState, DevSettings, NativeModules} from 'react-native';
import {bind} from '@reatom/core';

import {initI18n} from '../i18n';
import {lastRadioError, radio, radioEventListener} from '../radio/radio.model';
import {registerMockScenarioDevMenu} from '../dev/mockScenarioDevMenu';
import {RadioNative} from '../radio/radio.native';
import {applyAppLifecycle} from './app.model';
import type {AppLocale} from '../i18n';
import type {AppLifecycle} from './app.model';
import type {DevMenuHost} from '../dev/mockScenarioDevMenu';

/**
 * Only the two members app entry uses, so a test can hand in a plain object
 * instead of React Native's real `AppState` -- the same shape of seam
 * `registerMockScenarioDevMenu(host)` already uses.
 */
export type AppStateHost = {
  addEventListener(
    type: 'change',
    handler: (state: string) => void,
  ): {remove: () => void};
};

export type BootstrapHost = {
  appState?: AppStateHost;
  systemLocale?: string;
  devMenu?: DevMenuHost;
};

export type Bootstrapped = {locale: AppLocale; teardown: () => void};

/**
 * Spec section 12.2: "On startup `i18n.loadAndActivate()` selects the system
 * locale with `en` fallback." Reading the locale is app entry's job (`src/i18n.ts`
 * takes it as an argument and detects nothing itself).
 *
 * `Intl` is present in Hermes on both platforms and is the only cross-platform
 * answer; the `NativeModules` paths below are the historical fallbacks, and both
 * are guarded because neither is guaranteed under Jest or a stripped runtime.
 */
export function readSystemLocale(): string | undefined {
  try {
    const resolved = Intl.DateTimeFormat().resolvedOptions().locale;
    if (typeof resolved === 'string' && resolved.length > 0) return resolved;
  } catch {
    // fall through to the native modules below
  }

  try {
    const settings = NativeModules.SettingsManager?.settings;
    const apple =
      settings?.AppleLocale ??
      (Array.isArray(settings?.AppleLanguages)
        ? settings?.AppleLanguages[0]
        : undefined);
    if (typeof apple === 'string' && apple.length > 0) return apple;

    const android = NativeModules.I18nManager?.localeIdentifier;
    if (typeof android === 'string' && android.length > 0) return android;
  } catch {
    // no locale is discoverable; `initI18n` falls back to English
  }

  return undefined;
}

/**
 * React Native reports five `AppState` values; `app.model.ts` models three.
 * Anything that is neither foreground nor backgrounded is `inactive`, which is
 * the value that does *not* trigger a re-sync on its own but does arm the next
 * transition into `active` to do so (section 6.2).
 */
export function toAppLifecycle(state: string): AppLifecycle {
  if (state === 'active') return 'active';
  if (state === 'background') return 'background';
  return 'inactive';
}

/**
 * The whole of app entry, in the order section 6.2 and section 12.2 require:
 *
 * 1. activate a catalog, so the first frame is already localized;
 * 2. register the section 6.5 dev-menu scenarios (a no-op outside `__DEV__`);
 * 3. subscribe the engine's event stream into the mirror -- without this
 *    nothing but `start()`/`sync()` ever writes `radio()`, because
 *    `radio.model.ts` is fed by `stateChanged`;
 * 4. bridge `AppState` into `applyAppLifecycle`, which re-syncs on every
 *    transition back into `active`;
 * 5. take one snapshot: section 6.2's "on UI start ... `getState()` -> Reatom
 *    sync". Deliberately **not** `start()` -- section 12 makes `off` a full
 *    main-screen state and section 5 makes the power key the only thing that
 *    leaves it. `RadioScreen` already owns the single `start()` call site.
 */
export function bootstrapApp(host: BootstrapHost = {}): Bootstrapped {
  const locale = initI18n(host.systemLocale ?? readSystemLocale());

  registerMockScenarioDevMenu(host.devMenu ?? DevSettings);

  const subscription = RadioNative.subscribe(radioEventListener);
  if (subscription instanceof Error) {
    // Section 13: nothing throws. A radio the app cannot hear from is a
    // failure the user is entitled to see, so it lands where the error state
    // reads it.
    lastRadioError.set(subscription);
  }

  const appState = host.appState ?? AppState;
  const lifecycle = appState.addEventListener(
    'change',
    bind((state: string) => {
      void applyAppLifecycle(toAppLifecycle(state));
    }),
  );

  void radio.sync();

  return {
    locale,
    teardown() {
      lifecycle.remove();
      if (!(subscription instanceof Error)) subscription.remove();
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test __tests__/app-entry.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Run the task gate**

Run: `pnpm typecheck && pnpm lint && pnpm test __tests__/app-entry.test.ts`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add src/app/appEntry.ts __tests__/app-entry.test.ts
git commit -m "feat(app): wire i18n, the engine event stream and AppState at app entry"
```

---

## Task 2: Navigation glue — the route atom, `AppRoot`, and the real `App.tsx`

**Files:**
- Create: `src/app/navigation.model.ts`, `src/app/AppRoot.tsx`
- Modify: `App.tsx` (replace entirely), `index.js`, `__tests__/App.test.tsx` (replace entirely)
- Test: `__tests__/navigation.test.tsx`

**Interfaces:**
- Consumes: `bootstrapApp` (Task 1); `RadioScreen`, `SettingsScreen`, `PairingFlow`,
  `OnboardingFlow`; `chassis`, `colors` from `src/ui/theme.ts`; `i18n` from `@lingui/core`;
  `I18nProvider` from `@lingui/react`; `reatomComponent` from `@reatom/react`.
- Produces:
  ```ts
  // src/app/navigation.model.ts
  export type Route = 'onboarding' | 'background' | 'radio' | 'settings' | 'pairing';
  export const route: Atom<Route | null>;          // null = the root is not resolved yet
  export const navigate: (next: Route) => void;
  export const goBack: () => boolean;              // true when it consumed the press
  // src/app/AppRoot.tsx
  export const AppRoot: React.ComponentType<{}>;
  // App.tsx
  export default function App(): JSX.Element;
  ```
  Task 5 sets the initial route through `navigate`; Task 7 adds the `'background'` screen to
  `AppRoot`'s switch.

- [ ] **Step 1: Write the failing test**

Create `__tests__/navigation.test.tsx`:

```tsx
import React from 'react';
import {context} from '@reatom/core';

import {AppRoot} from '../src/app/AppRoot';
import {goBack, navigate, route} from '../src/app/navigation.model';
import {renderScreen} from '../jest/renderScreen';
import {testIds} from '../src/ui/theme';

jest.useFakeTimers({doNotFake: ['queueMicrotask']});

beforeEach(() => context.reset());

describe('navigation glue — spec section 12', () => {
  it('renders nothing until the initial route is resolved', async () => {
    const screen = await renderScreen(<AppRoot />, {scenario: 'happy'});
    expect(route()).toBeNull();
    expect(screen.findAll(testIds.radioScreen)).toHaveLength(0);
    screen.unmount();
  });

  it('walks radio -> settings -> pairing and back again', async () => {
    const screen = await renderScreen(<AppRoot />, {scenario: 'pairing-success'});
    await screen.act(() => navigate('radio'));
    expect(screen.findAll(testIds.radioScreen)).toHaveLength(1);

    await screen.press(testIds.settingsGear);
    expect(screen.findAll(testIds.settingsScreen)).toHaveLength(1);

    await screen.press(testIds.pttConnect);
    expect(screen.findAll(testIds.pairingScreen)).toHaveLength(1);

    await screen.press(testIds.pairingCancel);
    expect(screen.findAll(testIds.settingsScreen)).toHaveLength(1);

    await screen.press(testIds.settingsBack);
    expect(screen.findAll(testIds.radioScreen)).toHaveLength(1);
    screen.unmount();
  });

  it('leaves onboarding for the radio when it is done', async () => {
    const screen = await renderScreen(<AppRoot />, {scenario: 'happy'});
    await screen.act(() => navigate('onboarding'));
    expect(screen.findAll(testIds.onboardingScreen)).toHaveLength(1);

    await screen.press(testIds.onboardingAllow);
    await screen.press(testIds.onboardingAllow);
    await screen.press(testIds.onboardingAllow);
    await screen.press(testIds.onboardingStart);

    expect(screen.findAll(testIds.radioScreen)).toHaveLength(1);
    screen.unmount();
  });

  it('consumes the hardware back press only where there is somewhere to go', () => {
    navigate('radio');
    expect(goBack()).toBe(false);

    navigate('settings');
    expect(goBack()).toBe(true);
    expect(route()).toBe('radio');

    navigate('pairing');
    expect(goBack()).toBe(true);
    expect(route()).toBe('settings');

    navigate('onboarding');
    expect(goBack()).toBe(false);
    expect(route()).toBe('onboarding');
  });
});
```

Replace `__tests__/App.test.tsx` entirely:

```tsx
/**
 * @format
 */

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';

import App from '../App';
import {context} from '@reatom/core';

jest.useFakeTimers({doNotFake: ['queueMicrotask']});

beforeEach(() => context.reset());

test('the root mounts the app, not the React Native template', async () => {
  let tree: ReactTestRenderer.ReactTestRenderer | undefined;
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(<App />);
  });

  const root = tree as ReactTestRenderer.ReactTestRenderer;
  expect(root.root.findAllByProps({templateFileName: 'App.tsx'})).toHaveLength(0);

  ReactTestRenderer.act(() => root.unmount());
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test __tests__/navigation.test.tsx __tests__/App.test.tsx`
Expected: FAIL — `Cannot find module '../src/app/AppRoot'`.

- [ ] **Step 3: Write the navigation model**

Create `src/app/navigation.model.ts`:

```ts
import {action, atom} from '@reatom/core';

/**
 * The app has five destinations and no navigation library (P1 installed the
 * spec's dependencies and nothing else), so the "navigator" is one atom and a
 * switch in `AppRoot`. That is enough for spec section 12: the screens are a
 * main screen, a settings screen and two flows, none of them stacked more than
 * one level deep.
 *
 * `null` is the state before the first-launch gate has answered. `AppRoot`
 * renders nothing then, so the user never sees the main screen flash by on the
 * way to onboarding.
 */
export type Route = 'onboarding' | 'background' | 'radio' | 'settings' | 'pairing';

export const route = atom<Route | null>(null, 'route');

export const navigate = action((next: Route) => {
  route.set(next);
}, 'navigate');

/**
 * Android's hardware back button. Returns `true` when it moved somewhere, which
 * is what `BackHandler` reads as "handled"; `false` lets Android close the app,
 * which is the right behaviour on the main screen and inside the first-launch
 * sequence -- backing out of onboarding into a radio the user has not granted
 * anything to would be worse than leaving.
 */
export const goBack = action((): boolean => {
  const current = route();

  if (current === 'settings') {
    route.set('radio');
    return true;
  }

  if (current === 'pairing') {
    route.set('settings');
    return true;
  }

  return false;
}, 'goBack');
```

- [ ] **Step 4: Write the root component**

Create `src/app/AppRoot.tsx`:

```tsx
import React, {useEffect} from 'react';
import {BackHandler} from 'react-native';
import {reatomComponent} from '@reatom/react';
import {wrap} from '@reatom/core';

import {OnboardingFlow} from '../screens/OnboardingFlow';
import {PairingFlow} from '../screens/PairingFlow';
import {RadioScreen} from '../screens/RadioScreen';
import {SettingsScreen} from '../screens/SettingsScreen';
import {goBack, navigate, route} from './navigation.model';

/**
 * One merged screen per route, with the callbacks each of them declares.
 * Nothing here knows what a screen renders; the whole of this plan's navigation
 * contract is these six lines of wiring.
 */
export const AppRoot = reatomComponent(() => {
  useEffect(() => {
    const subscription = BackHandler.addEventListener(
      'hardwareBackPress',
      wrap(() => goBack()),
    );
    return () => subscription.remove();
  }, []);

  const current = route();

  if (current === null) return null;

  if (current === 'onboarding') {
    return <OnboardingFlow onDone={wrap(() => navigate('radio'))} />;
  }

  if (current === 'settings') {
    return (
      <SettingsScreen
        onBack={wrap(() => navigate('radio'))}
        onConnectPress={wrap(() => navigate('pairing'))}
      />
    );
  }

  if (current === 'pairing') {
    return <PairingFlow onClose={wrap(() => navigate('settings'))} />;
  }

  return <RadioScreen onSettingsPress={wrap(() => navigate('settings'))} />;
}, 'AppRoot');
```

Note the fallthrough: `'background'` currently renders `RadioScreen`. Task 7 adds its branch
above the final `return`; leaving a placeholder branch here would be a lie about what the app
does today.

- [ ] **Step 5: Replace `App.tsx`**

Replace the whole file:

```tsx
/**
 * @format
 */

import React from 'react';
import {StatusBar, View} from 'react-native';
import {I18nProvider} from '@lingui/react';
import {i18n} from '@lingui/core';
import {SafeAreaProvider} from 'react-native-safe-area-context';

import {AppRoot} from './src/app/AppRoot';
import {chassis, colors} from './src/ui/theme';

/**
 * The tree above every screen: the safe-area provider the chassis measures
 * against, the Lingui provider `Trans`/`useLingui` read, and the dark chassis
 * of section 12.1. `index.js` has already run `bootstrapApp()` by the time this
 * renders, so `i18n` carries an activated catalog on the first frame.
 *
 * The initial route is resolved in `App.tsx`'s sibling task (the first-launch
 * gate); until it answers, `AppRoot` renders nothing over the chassis colour.
 */
function App() {
  return (
    <SafeAreaProvider>
      <I18nProvider i18n={i18n}>
        <StatusBar
          barStyle="light-content"
          backgroundColor={colors.background}
        />
        <View style={chassis.screen}>
          <AppRoot />
        </View>
      </I18nProvider>
    </SafeAreaProvider>
  );
}

export default App;
```

- [ ] **Step 6: Replace `index.js`**

```js
/**
 * @format
 */

import { AppRegistry } from 'react-native';
import App from './App';
import { name as appName } from './app.json';
import { bootstrapApp } from './src/app/appEntry';

// Section 12.2: the catalog is activated before the first render, so no frame
// is ever drawn in the wrong language. Section 6.2: the engine event stream and
// the AppState bridge are live from the moment the bundle evaluates, whether or
// not React has mounted anything yet.
bootstrapApp();

AppRegistry.registerComponent(appName, () => App);
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `pnpm test __tests__/navigation.test.tsx __tests__/App.test.tsx`
Expected: PASS.

- [ ] **Step 8: Run the task gate**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: all green, including every merged suite. `__tests__/ui-independence.test.ts` must
still pass — `AppRoot.tsx` lives in `src/app/`, which it does not scan, and no file under
`src/screens/` or `src/ui/` was touched.

- [ ] **Step 9: Commit**

```bash
git add src/app/navigation.model.ts src/app/AppRoot.tsx App.tsx index.js \
        __tests__/navigation.test.tsx __tests__/App.test.tsx
git commit -m "feat(app): mount the merged screens behind a route atom"
```

---

## Task 3: The real permission backend for both platforms

**Files:**
- Create: `src/permissions/permissions.native.ts`
- Modify: `src/permissions/permissions.port.ts`
- Test: `__tests__/permissions-native.test.ts`

**Interfaces:**
- Consumes: `AppPermission`, `PermissionStatus`, `PermissionsBackend`
  (`src/permissions/permissions.types.ts`).
- Produces:
  ```ts
  export type AndroidPermissionName = Parameters<typeof PermissionsAndroid.check>[0];
  export function androidPermissionNames(
    permission: AppPermission,
    apiLevel: number,
  ): AndroidPermissionName[];
  export function summariseAndroidResults(
    results: Record<string, string>,
  ): PermissionStatus;
  export const androidPermissionsBackend: PermissionsBackend;
  export const iosPermissionsBackend: PermissionsBackend;
  ```
  Task 4's gateway reuses `androidPermissionNames`; `permissions.port.ts`'s
  `resolveNativePermissions` returns one of the two backends.

- [ ] **Step 1: Write the failing test**

Create `__tests__/permissions-native.test.ts`:

```ts
import {
  androidPermissionNames,
  summariseAndroidResults,
} from '../src/permissions/permissions.native';

describe('the Android permission groups — spec section 11', () => {
  it('asks for the microphone on every API level', () => {
    expect(androidPermissionNames('microphone', 30)).toEqual([
      'android.permission.RECORD_AUDIO',
    ]);
    expect(androidPermissionNames('microphone', 34)).toEqual([
      'android.permission.RECORD_AUDIO',
    ]);
  });

  it('asks for the three runtime Bluetooth permissions from API 31', () => {
    expect(androidPermissionNames('bluetooth', 31)).toEqual([
      'android.permission.BLUETOOTH_SCAN',
      'android.permission.BLUETOOTH_CONNECT',
      'android.permission.BLUETOOTH_ADVERTISE',
    ]);
  });

  it('asks for nothing on older Bluetooth, where the grants are install-time', () => {
    expect(androidPermissionNames('bluetooth', 30)).toEqual([]);
  });

  it('asks for fine location on every API level, and adds NEARBY_WIFI_DEVICES on 33+', () => {
    // Bug #3 of the phase 0 spike report: Nearby's BLE medium needs
    // ACCESS_FINE_LOCATION unconditionally, whatever NEARBY_WIFI_DEVICES says.
    expect(androidPermissionNames('nearbyDevices', 31)).toEqual([
      'android.permission.ACCESS_FINE_LOCATION',
    ]);
    expect(androidPermissionNames('nearbyDevices', 33)).toEqual([
      'android.permission.ACCESS_FINE_LOCATION',
      'android.permission.NEARBY_WIFI_DEVICES',
    ]);
  });

  it('summarises a whole group into one status', () => {
    expect(summariseAndroidResults({a: 'granted', b: 'granted'})).toBe('granted');
    expect(summariseAndroidResults({a: 'granted', b: 'denied'})).toBe('denied');
    expect(summariseAndroidResults({a: 'denied', b: 'never_ask_again'})).toBe(
      'blocked',
    );
    expect(summariseAndroidResults({})).toBe('granted');
  });
});

describe('the iOS backend — spec section 11', () => {
  it('advances every step, because iOS prompts at first use and not on demand', async () => {
    const {iosPermissionsBackend} = await import(
      '../src/permissions/permissions.native'
    );
    await expect(iosPermissionsBackend.request('microphone')).resolves.toBe(
      'granted',
    );
    await expect(iosPermissionsBackend.request('bluetooth')).resolves.toBe(
      'granted',
    );
    await expect(iosPermissionsBackend.request('nearbyDevices')).resolves.toBe(
      'granted',
    );
  });
});

describe('the port after the flip — spec section 6.5', () => {
  it('still binds the mock under RADIO_BACKEND=mock, which jest.config.js pins', async () => {
    const {Permissions} = await import('../src/permissions/permissions.port');
    const {mockPermissions} = await import(
      '../src/permissions/permissions.mock'
    );
    mockPermissions.reset();
    await expect(Permissions.request('microphone')).resolves.toBe('granted');
  });

  it('reads its dev default the same way radio.native.ts does', () => {
    const {readFileSync} = require('fs');
    const {join} = require('path');
    const source = readFileSync(
      join(__dirname, '..', 'src', 'permissions', 'permissions.port.ts'),
      'utf8',
    );
    // The flip: `mock` is now the opt-in, exactly as in radio.native.ts, so a
    // release build and a plain dev build both reach the real OS prompts.
    expect(source).toMatch(/process\.env\.RADIO_BACKEND === 'mock'/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test __tests__/permissions-native.test.ts`
Expected: FAIL — `Cannot find module '../src/permissions/permissions.native'`.

- [ ] **Step 3: Write the platform backends**

Create `src/permissions/permissions.native.ts`:

```ts
import {Linking, PermissionsAndroid, Platform} from 'react-native';

import type {
  AppPermission,
  PermissionStatus,
  PermissionsBackend,
} from './permissions.types';

/**
 * React Native's own union of manifest permission strings. Taken off
 * `PermissionsAndroid.check` rather than imported, because the type is not part
 * of the package's public export surface.
 */
export type AndroidPermissionName = Parameters<
  typeof PermissionsAndroid.check
>[0];

/**
 * Spec section 11's Android column, split into the three groups the onboarding
 * steps explain (`permissions.types.ts` records the same mapping).
 *
 * The API-level splits are the platform's, not a preference:
 * - the three `BLUETOOTH_*` permissions became runtime permissions in API 31;
 *   below that the legacy `BLUETOOTH`/`BLUETOOTH_ADMIN` grants are install-time
 *   and there is nothing to ask for.
 * - `NEARBY_WIFI_DEVICES` exists from API 33.
 * - `ACCESS_FINE_LOCATION` is asked for on **every** API level. That is Bug
 *   found #3 in `docs/superpowers/specs/2026-08-13-phase0-spike-report.md`:
 *   Nearby Connections' BLE medium requires it regardless of
 *   `NEARBY_WIFI_DEVICES`. Making it conditional silently breaks discovery.
 */
export function androidPermissionNames(
  permission: AppPermission,
  apiLevel: number,
): AndroidPermissionName[] {
  if (permission === 'microphone') {
    return [PermissionsAndroid.PERMISSIONS.RECORD_AUDIO];
  }

  if (permission === 'bluetooth') {
    return apiLevel >= 31
      ? [
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_ADVERTISE,
        ]
      : [];
  }

  return apiLevel >= 33
    ? [
        PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
        PermissionsAndroid.PERMISSIONS.NEARBY_WIFI_DEVICES,
      ]
    : [PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION];
}

/**
 * A group is granted only when every member is. `never_ask_again` anywhere in
 * the group makes the whole group `blocked`, which is what tells the merged
 * onboarding screen to offer "Open settings" instead of "Try again".
 */
export function summariseAndroidResults(
  results: Record<string, string>,
): PermissionStatus {
  const values = Object.values(results);
  if (values.length === 0) return 'granted';
  if (values.every(value => value === PermissionsAndroid.RESULTS.GRANTED)) {
    return 'granted';
  }
  return values.some(value => value === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN)
    ? 'blocked'
    : 'denied';
}

const androidApiLevel = (): number =>
  typeof Platform.Version === 'number' ? Platform.Version : 0;

export const androidPermissionsBackend: PermissionsBackend = {
  async request(permission) {
    const names = androidPermissionNames(permission, androidApiLevel());
    if (names.length === 0) return 'granted';

    const results = await PermissionsAndroid.requestMultiple(names);
    return summariseAndroidResults(results as Record<string, string>);
  },

  openSettings: () => Linking.openSettings(),
};

/**
 * iOS exposes no way to request or query these three permissions ahead of use,
 * and for the local network there is no such API in any language. Spec section
 * 11's iOS column is therefore what it is: `Info.plist` usage descriptions, and
 * a prompt the OS raises the first time the app touches the resource. Every one
 * of those first uses is already in merged code -- `AudioEngine.swift` awaits
 * record permission when the session opens the microphone,
 * `BleGattPttDriver.swift` instantiates `CBCentralManager`, and
 * NearbyConnections browses Bonjour -- so on iOS the prompts follow the user
 * pressing the power key.
 *
 * `request()` therefore means "nothing in this app blocks this step", which is
 * the only true thing iOS lets the app say here, and section 11's onboarding
 * sequence does its real job: explaining each permission in the app language
 * immediately before the OS asks for it.
 *
 * See the plan document's ruling 2 before changing this to a native module.
 */
export const iosPermissionsBackend: PermissionsBackend = {
  request: async () => 'granted',
  openSettings: () => Linking.openSettings(),
};
```

- [ ] **Step 4: Rewire and flip the port**

In `src/permissions/permissions.port.ts`, replace the stub `resolveNativePermissions` and its
comment block with:

```ts
import {Platform} from 'react-native';

import {
  androidPermissionsBackend,
  iosPermissionsBackend,
} from './permissions.native';
```

```ts
/**
 * The real runtime prompts (spec section 11). Android goes through
 * `PermissionsAndroid`; iOS has no pre-request API and prompts at first use --
 * see `permissions.native.ts` for why its backend answers the way it does.
 */
export const resolveNativePermissions: ResolvePermissions = () => {
  if (Platform.OS === 'android') return androidPermissionsBackend;
  if (Platform.OS === 'ios') return iosPermissionsBackend;
  return new PermissionsUnavailableError({platform: Platform.OS});
};
```

and flip the build-time default so it reads the same way `radio.native.ts` does — `mock` is
now the opt-in, not the default:

```ts
/**
 * Spec section 6.5's flag, resolved locally. The expression is repeated here
 * rather than imported from a shared module on purpose: Babel inlines
 * `__DEV__` and `process.env.RADIO_BACKEND` per module, and Metro folds
 * constants per module, so an imported constant would not fold and the mock
 * backend would survive into a release bundle.
 *
 * The dev default is `native` as of section 15 Stage 4, matching
 * `radio.native.ts`: onboarding now reaches the real OS prompts.
 * `RADIO_BACKEND=mock` remains the way design work, demos, screenshots and the
 * Jest suite run, and `jest.config.js` pins it.
 */
const backend: 'mock' | 'native' = __DEV__
  ? process.env.RADIO_BACKEND === 'mock'
    ? 'mock'
    : 'native'
  : 'native';
```

Keep the `require`-inside-the-folded-branch shape of the `Permissions` singleton exactly as it
is; only the ternary above changes.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm test __tests__/permissions-native.test.ts __tests__/permissions-port.test.ts`
Expected: PASS. `permissions-port.test.ts` is merged P6 code and must pass **unmodified** —
`jest.config.js` sets `RADIO_BACKEND = 'mock'`, so the flip does not move the suite off the
mock. If it fails, the flip is wrong; do not edit the merged test.

- [ ] **Step 6: Run the task gate**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add src/permissions/permissions.native.ts src/permissions/permissions.port.ts \
        __tests__/permissions-native.test.ts
git commit -m "feat(permissions): implement the real backends and flip the dev default"
```

---

## Task 4: The platform gateway behind first-launch sequencing

**Files:**
- Create: `src/permissions/platform.gateway.ts`
- Test: covered by Task 5's suite; this task's own verification is the gate plus a type check.

**Interfaces:**
- Consumes: `androidPermissionNames` (Task 3); `PermissionsAndroid`, `Platform`, `Settings`,
  `Linking` from `react-native`.
- Produces:
  ```ts
  export type PlatformPermissionsGateway = {
    hasOnboardingPermissions(): Promise<boolean>;
    onboardingCompleted(): boolean;
    markOnboardingCompleted(): void;
    backgroundStepSupported(): boolean;
    hasBackgroundLocation(): Promise<boolean>;
    requestNotifications(): Promise<void>;
    requestBackgroundLocation(): Promise<boolean>;
    openSettings(): Promise<void>;
  };
  export const realPlatformGateway: PlatformPermissionsGateway;
  export const platformGateway: Atom<PlatformPermissionsGateway>;
  export const ONBOARDING_COMPLETED_KEY: string;   // 'com.oru.onboardingCompleted'
  ```
  Task 5's model reads `platformGateway()` and never `react-native`; Task 5's tests replace
  the atom's value with a fake.

- [ ] **Step 1: Write the failing test**

Create the first half of `__tests__/sequencing.test.ts` — the part that pins the gateway's
shape and its default. The behavioural half is written in Task 5.

```ts
import {context} from '@reatom/core';

import {
  ONBOARDING_COMPLETED_KEY,
  platformGateway,
  realPlatformGateway,
} from '../src/permissions/platform.gateway';

beforeEach(() => context.reset());

describe('the platform gateway', () => {
  it('defaults to the real one', () => {
    expect(platformGateway()).toBe(realPlatformGateway);
  });

  it('is swappable, so no model test ever touches the OS', () => {
    const fake = {...realPlatformGateway, onboardingCompleted: () => true};
    platformGateway.set(fake);
    expect(platformGateway().onboardingCompleted()).toBe(true);

    context.reset();
    expect(platformGateway()).toBe(realPlatformGateway);
  });

  it('namespaces its persisted key', () => {
    expect(ONBOARDING_COMPLETED_KEY).toBe('com.oru.onboardingCompleted');
  });

  it('never throws from the real gateway under Jest, where no native module answers', () => {
    expect(() => realPlatformGateway.onboardingCompleted()).not.toThrow();
    expect(() => realPlatformGateway.markOnboardingCompleted()).not.toThrow();
    expect(realPlatformGateway.backgroundStepSupported()).toBe(false); // Platform.OS is 'ios' under the RN jest preset
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test __tests__/sequencing.test.ts`
Expected: FAIL — `Cannot find module '../src/permissions/platform.gateway'`.

- [ ] **Step 3: Write the gateway**

Create `src/permissions/platform.gateway.ts`:

```ts
import {Linking, PermissionsAndroid, Platform, Settings} from 'react-native';
import {atom} from '@reatom/core';

import {androidPermissionNames} from './permissions.native';
import {APP_PERMISSIONS} from './permissions.types';

/**
 * Everything first-launch sequencing needs to ask the platform, in one object.
 *
 * It exists because spec section 11's sequence is not answerable through the
 * section 6.4 permission port: the port asks "prompt for this and tell me what
 * the user said", and sequencing asks "has this already been granted, and has
 * this user seen the sequence before" -- questions with no prompt attached.
 * Keeping them here rather than widening the merged `PermissionsBackend` leaves
 * every merged screen, model and mock untouched.
 */
export type PlatformPermissionsGateway = {
  /** Android: are all three onboarding groups already granted? */
  hasOnboardingPermissions(): Promise<boolean>;
  /** iOS: has this install finished the sequence before? */
  onboardingCompleted(): boolean;
  markOnboardingCompleted(): void;
  /** Android 29+: is there an `ACCESS_BACKGROUND_LOCATION` step to show at all? */
  backgroundStepSupported(): boolean;
  hasBackgroundLocation(): Promise<boolean>;
  requestNotifications(): Promise<void>;
  /** Resolves `true` only when the permission is actually held afterwards. */
  requestBackgroundLocation(): Promise<boolean>;
  openSettings(): Promise<void>;
};

export const ONBOARDING_COMPLETED_KEY = 'com.oru.onboardingCompleted';

const androidApiLevel = (): number =>
  Platform.OS === 'android' && typeof Platform.Version === 'number'
    ? Platform.Version
    : 0;

/**
 * `Settings` is React Native core's iOS-only `NSUserDefaults` wrapper -- the one
 * persistent store available without adding a dependency, which P1's rule
 * forbids. On Android nothing is persisted: the permission grants *are* the
 * record, and reading them is both truthful and free (`check` never prompts).
 * Every access is guarded, because no native module answers under Jest.
 */
const readOnboardingFlag = (): boolean => {
  if (Platform.OS !== 'ios') return false;
  try {
    return Settings.get(ONBOARDING_COMPLETED_KEY) === true;
  } catch {
    return false;
  }
};

export const realPlatformGateway: PlatformPermissionsGateway = {
  async hasOnboardingPermissions() {
    if (Platform.OS !== 'android') return true;

    const names = APP_PERMISSIONS.flatMap(permission =>
      androidPermissionNames(permission, androidApiLevel()),
    );
    const held = await Promise.all(
      names.map(name => PermissionsAndroid.check(name)),
    );
    return held.every(Boolean);
  },

  onboardingCompleted: readOnboardingFlag,

  markOnboardingCompleted() {
    if (Platform.OS !== 'ios') return;
    try {
      Settings.set({[ONBOARDING_COMPLETED_KEY]: true});
    } catch {
      // A missing settings module costs the user one extra explanation
      // sequence, which is a better failure than a crash at first launch.
    }
  },

  /**
   * `ACCESS_BACKGROUND_LOCATION` exists from API 29 and is what keeps Nearby
   * rediscovering a lost peer once the app has no visible Activity (Bug #5 of
   * the phase 0 spike report). It has no iOS counterpart.
   */
  backgroundStepSupported: () => androidApiLevel() >= 29,

  async hasBackgroundLocation() {
    if (Platform.OS !== 'android') return true;
    return PermissionsAndroid.check(
      PermissionsAndroid.PERMISSIONS.ACCESS_BACKGROUND_LOCATION,
    );
  },

  async requestNotifications() {
    // Section 11 lists POST_NOTIFICATIONS under the foreground service, and the
    // service is what keeps the radio alive with the screen locked. It became a
    // runtime permission in API 33.
    if (Platform.OS !== 'android' || androidApiLevel() < 33) return;
    await PermissionsAndroid.request(
      PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS,
    );
  },

  /**
   * From API 30 the "Allow all the time" choice was removed from the runtime
   * dialog: an app must send the user to its settings page instead. So the
   * request is attempted once -- it succeeds on API 29 and is a no-op answer
   * above it -- and the result is re-read from the system rather than trusted.
   */
  async requestBackgroundLocation() {
    if (Platform.OS !== 'android') return true;

    await PermissionsAndroid.request(
      PermissionsAndroid.PERMISSIONS.ACCESS_BACKGROUND_LOCATION,
    );
    return PermissionsAndroid.check(
      PermissionsAndroid.PERMISSIONS.ACCESS_BACKGROUND_LOCATION,
    );
  },

  openSettings: () => Linking.openSettings(),
};

/**
 * An atom rather than a module constant so a test can swap the whole platform
 * out with `platformGateway.set(fake)` and `context.reset()` puts it back --
 * the same discipline every other model test in this repository follows.
 */
export const platformGateway = atom<PlatformPermissionsGateway>(
  realPlatformGateway,
  'platformGateway',
);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test __tests__/sequencing.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Run the task gate**

Run: `pnpm typecheck && pnpm lint && pnpm test __tests__/sequencing.test.ts`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add src/permissions/platform.gateway.ts __tests__/sequencing.test.ts
git commit -m "feat(permissions): add the platform gateway first-launch sequencing asks"
```

---

## Task 5: First-launch sequencing — which route the app opens on

**Files:**
- Create: `src/permissions/sequencing.model.ts`
- Modify: `App.tsx` (add the initial-route resolve), `__tests__/sequencing.test.ts` (extend)

**Interfaces:**
- Consumes: `platformGateway` (Task 4); `navigate`, `route` (Task 2).
- Produces:
  ```ts
  export type SequencingStep = 'onboarding' | 'background' | 'radio';
  export const backgroundStatus: Atom<'idle' | 'needsSettings' | 'granted'>;
  export const resolveInitialRoute: () => Promise<SequencingStep>;
  export const completeOnboarding: () => Promise<SequencingStep>;
  export const requestBackgroundPermissions: () => Promise<'idle' | 'needsSettings' | 'granted'>;
  export const openBackgroundSettings: () => Promise<void>;
  export const completeBackgroundStep: () => void;
  ```
  Task 7's screen renders `backgroundStatus` and calls the last four;
  `AppRoot` calls `completeOnboarding` from `OnboardingFlow`'s `onDone`.

- [ ] **Step 1: Write the failing test**

Append to `__tests__/sequencing.test.ts`:

```ts
import {
  backgroundStatus,
  completeBackgroundStep,
  completeOnboarding,
  requestBackgroundPermissions,
  resolveInitialRoute,
} from '../src/permissions/sequencing.model';
import {route} from '../src/app/navigation.model';

function fakeGateway(overrides: Partial<PlatformPermissionsGateway> = {}) {
  const calls = {markCompleted: 0, notifications: 0, settings: 0};
  const gateway: PlatformPermissionsGateway = {
    hasOnboardingPermissions: async () => true,
    onboardingCompleted: () => true,
    markOnboardingCompleted: () => {
      calls.markCompleted += 1;
    },
    backgroundStepSupported: () => false,
    hasBackgroundLocation: async () => true,
    requestNotifications: async () => {
      calls.notifications += 1;
    },
    requestBackgroundLocation: async () => true,
    openSettings: async () => {
      calls.settings += 1;
    },
    ...overrides,
  };
  platformGateway.set(gateway);
  return calls;
}

describe('first-launch sequencing — spec section 11', () => {
  it('opens on the radio when everything is already granted', async () => {
    fakeGateway();
    await expect(resolveInitialRoute()).resolves.toBe('radio');
    expect(route()).toBe('radio');
  });

  it('opens on onboarding when a permission is missing', async () => {
    fakeGateway({hasOnboardingPermissions: async () => false});
    await expect(resolveInitialRoute()).resolves.toBe('onboarding');
    expect(route()).toBe('onboarding');
  });

  it('opens on onboarding when this install has never finished it', async () => {
    fakeGateway({onboardingCompleted: () => false});
    await expect(resolveInitialRoute()).resolves.toBe('onboarding');
  });

  it('goes from onboarding to the background step where the platform has one', async () => {
    const calls = fakeGateway({
      backgroundStepSupported: () => true,
      hasBackgroundLocation: async () => false,
    });
    await expect(completeOnboarding()).resolves.toBe('background');
    expect(route()).toBe('background');
    expect(calls.markCompleted).toBe(1);
  });

  it('skips the background step when it is already granted', async () => {
    fakeGateway({
      backgroundStepSupported: () => true,
      hasBackgroundLocation: async () => true,
    });
    await expect(completeOnboarding()).resolves.toBe('radio');
    expect(route()).toBe('radio');
  });

  it('skips the background step on a platform without one', async () => {
    fakeGateway({backgroundStepSupported: () => false});
    await expect(completeOnboarding()).resolves.toBe('radio');
  });

  it('reports the two-step redirect when the dialog cannot grant it', async () => {
    const calls = fakeGateway({requestBackgroundLocation: async () => false});
    await expect(requestBackgroundPermissions()).resolves.toBe('needsSettings');
    expect(backgroundStatus()).toBe('needsSettings');
    // Section 11: POST_NOTIFICATIONS rides with this step, because the
    // foreground-service notification is what keeps the radio alive locked.
    expect(calls.notifications).toBe(1);
  });

  it('reports a grant and leaves the step', async () => {
    fakeGateway({requestBackgroundLocation: async () => true});
    await expect(requestBackgroundPermissions()).resolves.toBe('granted');
    expect(backgroundStatus()).toBe('granted');
    expect(route()).toBe('radio');
  });

  it('lets the user skip the background step', () => {
    fakeGateway();
    completeBackgroundStep();
    expect(route()).toBe('radio');
  });
});
```

Add the missing import of `PlatformPermissionsGateway` as a type at the top of the file.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test __tests__/sequencing.test.ts`
Expected: FAIL — `Cannot find module '../src/permissions/sequencing.model'`.

- [ ] **Step 3: Write the model**

Create `src/permissions/sequencing.model.ts`:

```ts
import {action, atom, wrap} from '@reatom/core';

import {navigate} from '../app/navigation.model';
import {platformGateway} from './platform.gateway';

/** Where the first-launch sequence currently is. */
export type SequencingStep = 'onboarding' | 'background' | 'radio';

/**
 * Spec section 11's `ACCESS_BACKGROUND_LOCATION` step. `needsSettings` is the
 * two-step redirect: from API 30 the runtime dialog cannot grant "Allow all the
 * time" at all, so the only route through is the app's settings page.
 */
export const backgroundStatus = atom<'idle' | 'needsSettings' | 'granted'>(
  'idle',
  'backgroundStatus',
);

/**
 * Spec section 11's onboarding is a *first-launch* sequence, and this repository
 * has no key-value store on Android (P1's dependency rule) -- so "first launch"
 * is answered from the truth instead of from a flag: if the three groups are
 * granted, the sequence has served its purpose and is skipped. On iOS, where
 * nothing is queryable, the `Settings` flag is the record.
 *
 * Both reactive reads happen before the first `await`.
 */
export const resolveInitialRoute = action(async (): Promise<SequencingStep> => {
  const gateway = platformGateway();

  const completed = gateway.onboardingCompleted();
  const granted = await wrap(gateway.hasOnboardingPermissions());

  const step: SequencingStep = completed && granted ? 'radio' : 'onboarding';
  navigate(step === 'radio' ? 'radio' : 'onboarding');
  return step;
}, 'resolveInitialRoute');

/** `OnboardingFlow`'s `onDone`: record the sequence, then decide what follows. */
export const completeOnboarding = action(async (): Promise<SequencingStep> => {
  const gateway = platformGateway();
  gateway.markOnboardingCompleted();

  if (!gateway.backgroundStepSupported()) {
    navigate('radio');
    return 'radio';
  }

  const held = await wrap(gateway.hasBackgroundLocation());
  if (held) {
    navigate('radio');
    return 'radio';
  }

  backgroundStatus.set('idle');
  navigate('background');
  return 'background';
}, 'completeOnboarding');

/**
 * The background step's primary action. Notifications first -- an ordinary
 * dialog -- then background location, whose grant is re-read from the system
 * rather than inferred, because on API 30+ the dialog cannot grant it.
 */
export const requestBackgroundPermissions = action(async () => {
  const gateway = platformGateway();

  await wrap(gateway.requestNotifications());
  const granted = await wrap(gateway.requestBackgroundLocation());

  if (granted) {
    backgroundStatus.set('granted');
    navigate('radio');
    return 'granted' as const;
  }

  backgroundStatus.set('needsSettings');
  return 'needsSettings' as const;
}, 'requestBackgroundPermissions');

export const openBackgroundSettings = action(async () => {
  await wrap(platformGateway().openSettings());
}, 'openBackgroundSettings');

/** "Not now": the radio still works, it just rediscovers worse when pocketed. */
export const completeBackgroundStep = action(() => {
  navigate('radio');
}, 'completeBackgroundStep');
```

- [ ] **Step 4: Resolve the initial route from `App.tsx`**

In `App.tsx`, add the effect that starts the sequence, keeping everything else from Task 2:

```tsx
import React, {useEffect} from 'react';
...
import {resolveInitialRoute} from './src/permissions/sequencing.model';

function App() {
  useEffect(() => {
    void resolveInitialRoute();
  }, []);

  return (
    // ... unchanged
  );
}
```

And in `src/app/AppRoot.tsx`, route `OnboardingFlow`'s `onDone` through the sequence instead
of straight to the radio:

```tsx
import {completeOnboarding} from '../permissions/sequencing.model';
...
  if (current === 'onboarding') {
    return (
      <OnboardingFlow
        onDone={wrap(() => {
          void completeOnboarding();
        })}
      />
    );
  }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm test __tests__/sequencing.test.ts __tests__/navigation.test.tsx __tests__/App.test.tsx`
Expected: PASS. `navigation.test.tsx`'s "leaves onboarding for the radio when it is done" now
goes through `completeOnboarding`; under Jest `Platform.OS` is `'ios'`, so
`backgroundStepSupported()` is `false` and the destination is still `radio`.

- [ ] **Step 6: Run the task gate**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add src/permissions/sequencing.model.ts src/app/AppRoot.tsx App.tsx \
        __tests__/sequencing.test.ts
git commit -m "feat(permissions): sequence the first launch per spec section 11"
```

---

## Task 6: Remove the iOS Phase 0 spike from app entry

**Files:**
- Modify: `ios/Oru/AppDelegate.swift`
- Test: `__tests__/ios-app-entry.test.ts`

**Interfaces:**
- Consumes: nothing. Produces: nothing importable — this task removes code.

**Why here:** P5's plan and report both assign this to P7. `RadioSpike.bootstrap()` starts the
engine at launch in DEBUG builds, which makes the §12 `off` state a lie on iOS (the radio is
live before the user powers it on, and a JS `stop()` stops the spike's radio); and
`SpikeControlPanelPresenter.attach(over: window)` covers the React Native root entirely, so
none of the merged screens are visible in an iOS debug build. Both are direct conflicts with
app entry, which is why they are removed here rather than in P3.

**Reminder:** no gate on this host compiles Swift. The test below is a text assertion, which is
how every other iOS fact in this repository is pinned (`__tests__/ios-config.test.ts`,
`__tests__/ios-radio-sources.test.ts`). Compilation is a macOS closeout step.

- [ ] **Step 1: Write the failing test**

Create `__tests__/ios-app-entry.test.ts`:

```ts
import {readFileSync} from 'fs';
import {join} from 'path';

const appDelegate = readFileSync(
  join(__dirname, '..', 'ios', 'Oru', 'AppDelegate.swift'),
  'utf8',
);

describe('the iOS app delegate — spec sections 6.2 and 12', () => {
  it('no longer boots the phase 0 spike', () => {
    // The spike started the engine at launch, which contradicts section 12's
    // `off` state and section 5's power key being the only way out of it.
    expect(appDelegate).not.toMatch(/RadioSpike/);
  });

  it('no longer covers the React Native root with the spike panel', () => {
    expect(appDelegate).not.toMatch(/SpikeControlPanelPresenter/);
  });

  it('still starts React Native with the registered component name', () => {
    expect(appDelegate).toMatch(/startReactNative\(/);
    expect(appDelegate).toMatch(/withModuleName: "Oru"/);
  });

  it('keeps the debug/release bundle split', () => {
    expect(appDelegate).toMatch(/jsBundleURL\(forBundleRoot: "index"\)/);
    expect(appDelegate).toMatch(/forResource: "main", withExtension: "jsbundle"/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test __tests__/ios-app-entry.test.ts`
Expected: FAIL — two failures, on `RadioSpike` and `SpikeControlPanelPresenter`.

- [ ] **Step 3: Edit `AppDelegate.swift`**

Delete the `import RadioKit` line, the `#if DEBUG ... RadioSpike.bootstrap() ... #endif` block
above the factory setup, and the `#if DEBUG ... SpikeControlPanelPresenter.attach(over: window)
... #endif` block below `startReactNative`. The result is:

```swift
import UIKit
import React
import React_RCTAppDelegate
import ReactAppDependencyProvider

@main
class AppDelegate: UIResponder, UIApplicationDelegate {
  var window: UIWindow?

  var reactNativeDelegate: ReactNativeDelegate?
  var reactNativeFactory: RCTReactNativeFactory?

  func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    let delegate = ReactNativeDelegate()
    let factory = RCTReactNativeFactory(delegate: delegate)
    delegate.dependencyProvider = RCTAppDependencyProvider()

    reactNativeDelegate = delegate
    reactNativeFactory = factory

    window = UIWindow(frame: UIScreen.main.bounds)

    factory.startReactNative(
      withModuleName: "Oru",
      in: window,
      launchOptions: launchOptions
    )

    return true
  }
}

class ReactNativeDelegate: RCTDefaultReactNativeFactoryDelegate {
  override func sourceURL(for bridge: RCTBridge) -> URL? {
    self.bundleURL()
  }

  override func bundleURL() -> URL? {
#if DEBUG
    RCTBundleURLProvider.sharedSettings().jsBundleURL(forBundleRoot: "index")
#else
    Bundle.main.url(forResource: "main", withExtension: "jsbundle")
#endif
  }
}
```

Do **not** delete `RadioSpike` or `SpikeControlPanelPresenter` themselves — they are P3's
Phase 0 artefacts and the spike report references them. Only app entry stops calling them. If
removing `import RadioKit` from this one file leaves an unused-import warning elsewhere, report
it rather than chasing it into `RadioKit`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test __tests__/ios-app-entry.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Run the task gate**

Run: `pnpm typecheck && pnpm lint && pnpm test __tests__/ios-app-entry.test.ts __tests__/ios-config.test.ts`
Expected: all green. Note in the task report that Swift compiles nowhere on this host, so this
change is verified by text and by review only.

- [ ] **Step 6: Commit**

```bash
git add ios/Oru/AppDelegate.swift __tests__/ios-app-entry.test.ts
git commit -m "fix(ios): stop booting the phase 0 spike from app entry"
```

---

## Task 7: The `ACCESS_BACKGROUND_LOCATION` step (§11's open work)

**Files:**
- Create: `src/screens/BackgroundStep.tsx`
- Modify: `src/app/AppRoot.tsx`, `src/locales/en/messages.po`, `src/locales/ru/messages.po`
- Test: `__tests__/background-step.test.tsx`

**Interfaces:**
- Consumes: `backgroundStatus`, `requestBackgroundPermissions`, `openBackgroundSettings`,
  `completeBackgroundStep` (Task 5); `ScreenFrame`, `ActionButton`, `colors`, `spacing`,
  `type` (`src/ui/`).
- Produces:
  ```ts
  export const backgroundStepTestIds: {
    screen: 'background-step';
    allow: 'background-allow';
    openSettings: 'background-open-settings';
    skip: 'background-skip';
  };
  export const BackgroundStep: React.ComponentType<{}>;
  ```

**Why a new file and not a fourth `OnboardingFlow` step:** §11 assigns this step to P7, and
P6's plan explicitly forbade adding it there. Adding a fourth entry to `APP_PERMISSIONS` would
also change `onboardingPermission`, `onboardingFinished` and the "Step N of 3" counter in
merged code, and would put an Android-only step in a platform-neutral constant. A separate
screen mounted by the router changes nothing merged and reads the same in the design language.

**This file lives under `src/screens/` and is scanned by `__tests__/ui-independence.test.ts`:
it must not name `PermissionsAndroid`, `NativeModules`, `TurboModuleRegistry`,
`radio.native`, `specs/NativeRadio` or `react-native/Libraries`.** All of that is behind the
Task 5 model.

- [ ] **Step 1: Write the failing test**

Create `__tests__/background-step.test.tsx`:

```tsx
import React from 'react';
import {context} from '@reatom/core';

import {BackgroundStep, backgroundStepTestIds} from '../src/screens/BackgroundStep';
import {platformGateway} from '../src/permissions/platform.gateway';
import {realPlatformGateway} from '../src/permissions/platform.gateway';
import {renderScreen} from '../jest/renderScreen';
import {route} from '../src/app/navigation.model';

jest.useFakeTimers({doNotFake: ['queueMicrotask']});

beforeEach(() => context.reset());

const gateway = (granted: boolean, calls = {settings: 0}) => {
  platformGateway.set({
    ...realPlatformGateway,
    requestNotifications: async () => {},
    requestBackgroundLocation: async () => granted,
    openSettings: async () => {
      calls.settings += 1;
    },
  });
  return calls;
};

describe('the background-location step — spec section 11', () => {
  it('explains the step and offers to grant it', async () => {
    gateway(true);
    const screen = await renderScreen(<BackgroundStep />);

    expect(screen.hasText('Keep the radio working')).toBe(true);
    expect(screen.findAll(backgroundStepTestIds.allow)).toHaveLength(1);
    expect(screen.findAll(backgroundStepTestIds.openSettings)).toHaveLength(0);

    await screen.press(backgroundStepTestIds.allow);
    expect(route()).toBe('radio');
    screen.unmount();
  });

  it('falls back to the settings redirect the dialog cannot replace', async () => {
    const calls = gateway(false);
    const screen = await renderScreen(<BackgroundStep />);

    await screen.press(backgroundStepTestIds.allow);
    expect(screen.hasText('Allow all the time')).toBe(true);
    expect(screen.findAll(backgroundStepTestIds.openSettings)).toHaveLength(1);

    await screen.press(backgroundStepTestIds.openSettings);
    expect(calls.settings).toBe(1);
    screen.unmount();
  });

  it('can be skipped', async () => {
    gateway(false);
    const screen = await renderScreen(<BackgroundStep />);

    await screen.press(backgroundStepTestIds.skip);
    expect(route()).toBe('radio');
    screen.unmount();
  });

  it('renders in Russian', async () => {
    gateway(false);
    const screen = await renderScreen(<BackgroundStep />, {locale: 'ru'});

    expect(screen.hasText('Чтобы рация работала')).toBe(true);
    await screen.press(backgroundStepTestIds.allow);
    expect(screen.hasText('Разрешить всегда')).toBe(true);
    screen.unmount();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test __tests__/background-step.test.tsx`
Expected: FAIL — `Cannot find module '../src/screens/BackgroundStep'`.

- [ ] **Step 3: Write the screen**

Create `src/screens/BackgroundStep.tsx`:

```tsx
import React from 'react';
import {StyleSheet, Text, View} from 'react-native';
import {Trans, useLingui} from '@lingui/react/macro';
import {reatomComponent} from '@reatom/react';
import {wrap} from '@reatom/core';

import {ActionButton} from '../ui/ActionButton';
import {ScreenFrame} from '../ui/ScreenFrame';
import {colors, spacing, type} from '../ui/theme';
import {
  backgroundStatus,
  completeBackgroundStep,
  openBackgroundSettings,
  requestBackgroundPermissions,
} from '../permissions/sequencing.model';

/**
 * Spec section 11's still-open step: `ACCESS_BACKGROUND_LOCATION`, without which
 * Nearby's rediscovery of a lost peer stalls permanently a few minutes after the
 * app has no visible Activity -- which is exactly the locked, pocketed phone the
 * whole product is for (Bug #5 of the phase 0 spike report).
 *
 * It is a screen of its own rather than a fourth `OnboardingFlow` step because
 * it is Android-only, it cannot be granted from a normal dialog on API 30+, and
 * `OnboardingFlow` is merged, accepted work.
 */
export const backgroundStepTestIds = {
  screen: 'background-step',
  allow: 'background-allow',
  openSettings: 'background-open-settings',
  skip: 'background-skip',
} as const;

export const BackgroundStep = reatomComponent(() => {
  const {t} = useLingui();
  const status = backgroundStatus();

  return (
    <ScreenFrame testID={backgroundStepTestIds.screen}>
      <View style={styles.centre}>
        <Text style={[type.hero, styles.headline]}>
          <Trans>Keep the radio working</Trans>
        </Text>
        <Text style={[type.body, styles.body]}>
          <Trans>
            Oru needs background location to keep finding nearby radios while
            your phone is locked and in a pocket.
          </Trans>
        </Text>

        {status === 'needsSettings' ? (
          <Text style={[type.body, styles.warning]}>
            <Trans>
              Android grants this only from the app settings. Open them, choose
              Permissions, then Location, then "Allow all the time".
            </Trans>
          </Text>
        ) : null}

        <View style={styles.actions}>
          {status === 'needsSettings' ? (
            <ActionButton
              label={t`Open settings`}
              tone="primary"
              onPress={wrap(() => {
                void openBackgroundSettings();
              })}
              testID={backgroundStepTestIds.openSettings}
            />
          ) : (
            <ActionButton
              label={t`Allow`}
              tone="primary"
              onPress={wrap(() => {
                void requestBackgroundPermissions();
              })}
              testID={backgroundStepTestIds.allow}
            />
          )}

          <ActionButton
            label={t`Not now`}
            onPress={wrap(() => {
              void completeBackgroundStep();
            })}
            testID={backgroundStepTestIds.skip}
          />
        </View>
      </View>
    </ScreenFrame>
  );
}, 'BackgroundStep');

const styles = StyleSheet.create({
  centre: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.lg,
    padding: spacing.lg,
  },
  headline: {color: colors.text, textAlign: 'center'},
  body: {color: colors.textMuted, textAlign: 'center'},
  warning: {color: colors.learning, textAlign: 'center'},
  actions: {gap: spacing.md, alignSelf: 'stretch'},
});
```

- [ ] **Step 4: Mount it**

In `src/app/AppRoot.tsx`, add the branch above the final `return`:

```tsx
import {BackgroundStep} from '../screens/BackgroundStep';
...
  if (current === 'background') {
    return <BackgroundStep />;
  }
```

- [ ] **Step 5: Extract and translate the new copy**

Run: `pnpm lingui:extract`

That rewrites `src/locales/en/messages.po` and `src/locales/ru/messages.po` with the five new
source messages. Fill each new `msgstr` in the **Russian** catalog with exactly:

| English source | Russian `msgstr` |
|---|---|
| `Keep the radio working` | `Чтобы рация работала` |
| `Oru needs background location to keep finding nearby radios while your phone is locked and in a pocket.` | `Oru нужен доступ к геолокации в фоне, чтобы находить рации рядом, пока телефон заблокирован и лежит в кармане.` |
| `Android grants this only from the app settings. Open them, choose Permissions, then Location, then "Allow all the time".` | `Android выдаёт это только в настройках приложения. Откройте их, выберите «Разрешения», затем «Геолокация», затем «Разрешить всегда».` |
| `Allow` | already translated — leave it |
| `Not now` | `Не сейчас` |

Leave the English catalog's `msgstr` values as `lingui extract` produced them.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm test __tests__/background-step.test.tsx __tests__/locale-coverage.test.ts __tests__/ui-independence.test.ts`
Expected: PASS. `locale-coverage.test.ts` fails on any untranslated new message;
`ui-independence.test.ts` fails if the new screen reached for a platform API.

- [ ] **Step 7: Run the task gate**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: all green.

- [ ] **Step 8: Commit**

```bash
git add src/screens/BackgroundStep.tsx src/app/AppRoot.tsx \
        src/locales/en/messages.po src/locales/ru/messages.po \
        __tests__/background-step.test.tsx
git commit -m "feat(permissions): add section 11's background-location step"
```

---

## Task 8: The §11 declaration cross-check

**Files:**
- Create: `docs/section-11-permission-crosscheck.md`, `__tests__/permission-crosscheck.test.ts`

**Interfaces:**
- Consumes: nothing at runtime. The test reads `android/app/src/main/AndroidManifest.xml` and
  `ios/Oru/Info.plist` off disk, the way `__tests__/android-manifest.test.ts` and
  `__tests__/ios-config.test.ts` already do.
- Produces: a gate that fails on any future declaration drift.

**What the cross-check is.** §11 is a table of declarations. This task reconciles each one
against the merged code that needs it, and each *extra* declaration against a written reason.
The verdict, established while writing this plan and to be re-verified by the implementer:

| Declared | §11? | Used by | Verdict |
|---|---|---|---|
| `RECORD_AUDIO` | yes | `AudioEngine.kt` capture; requested by the microphone onboarding step | keep |
| `BLUETOOTH_SCAN` / `_CONNECT` / `_ADVERTISE` | yes | Nearby's BLE medium and the PTT drivers; requested by the Bluetooth step | keep |
| `NEARBY_WIFI_DEVICES` | yes | Nearby on API 33+; requested by the nearby-devices step | keep |
| `ACCESS_FINE_LOCATION` | yes, unconditional | Nearby's BLE medium on every API level (spike Bug #3) | keep, never `maxSdkVersion` |
| `ACCESS_BACKGROUND_LOCATION` | yes | Nearby rediscovery with no visible Activity (spike Bug #5); requested by Task 7's step | keep |
| `POST_NOTIFICATIONS` | yes | the foreground-service notification; requested by Task 7's step on API 33+ | keep |
| `FOREGROUND_SERVICE`, `_MICROPHONE`, `_CONNECTED_DEVICE` | yes | `RadioForegroundService.kt`, `foregroundServiceType="microphone\|connectedDevice"` | keep |
| `INTERNET` | no | Metro's dev bundle and Play Services' own transport | keep, justified |
| `MODIFY_AUDIO_SETTINGS` | no | `RadioForegroundService.kt` sets `AudioManager.mode = MODE_IN_COMMUNICATION` and drives SCO routing | keep, justified |
| `ACCESS_WIFI_STATE`, `CHANGE_WIFI_STATE` | no | required by `play-services-nearby` for its Wi-Fi mediums | keep, justified |
| iOS `NSMicrophoneUsageDescription`, `NSBluetoothAlwaysUsageDescription`, `NSLocalNetworkUsageDescription`, `NSBonjourServices`, `UIBackgroundModes = audio, bluetooth-central` | yes | the merged engine | keep |
| any push-to-talk entitlement | removed 2026-08-18 (§10.2) | nothing | must stay absent |

The expected outcome is **no manifest or plist edit**. If the implementer's own verification
disagrees with a row, they change the document and the test to match reality and say so in the
task report — and if that means editing `android/`, the task gate grows `pnpm build:android`.

- [ ] **Step 1: Write the failing test**

Create `__tests__/permission-crosscheck.test.ts`:

```ts
import {readFileSync} from 'fs';
import {join} from 'path';

const repoRoot = join(__dirname, '..');
const manifest = readFileSync(
  join(repoRoot, 'android', 'app', 'src', 'main', 'AndroidManifest.xml'),
  'utf8',
);
const infoPlist = readFileSync(
  join(repoRoot, 'ios', 'Oru', 'Info.plist'),
  'utf8',
);
const crosscheck = readFileSync(
  join(repoRoot, 'docs', 'section-11-permission-crosscheck.md'),
  'utf8',
);

const declaredPermissions = [
  ...manifest.matchAll(/<uses-permission[^>]*android:name="([^"]+)"/g),
]
  .map(match => match[1])
  .sort();

/**
 * Spec section 11, plus the four declarations that are not in section 11's table
 * and are justified one by one in docs/section-11-permission-crosscheck.md.
 * This list is the cross-check: a permission added to the manifest without a
 * line in that document fails here.
 */
const EXPECTED_ANDROID = [
  'android.permission.ACCESS_BACKGROUND_LOCATION',
  'android.permission.ACCESS_FINE_LOCATION',
  'android.permission.ACCESS_WIFI_STATE',
  'android.permission.BLUETOOTH_ADVERTISE',
  'android.permission.BLUETOOTH_CONNECT',
  'android.permission.BLUETOOTH_SCAN',
  'android.permission.CHANGE_WIFI_STATE',
  'android.permission.FOREGROUND_SERVICE',
  'android.permission.FOREGROUND_SERVICE_CONNECTED_DEVICE',
  'android.permission.FOREGROUND_SERVICE_MICROPHONE',
  'android.permission.INTERNET',
  'android.permission.MODIFY_AUDIO_SETTINGS',
  'android.permission.NEARBY_WIFI_DEVICES',
  'android.permission.POST_NOTIFICATIONS',
  'android.permission.RECORD_AUDIO',
].sort();

describe('the section 11 cross-check — Android', () => {
  it('declares exactly the reconciled set', () => {
    expect(declaredPermissions).toEqual(EXPECTED_ANDROID);
  });

  it('justifies every declaration in the cross-check document', () => {
    for (const permission of EXPECTED_ANDROID) {
      expect(crosscheck).toContain(permission.replace('android.permission.', ''));
    }
  });

  it('never caps fine location by API level', () => {
    // Spike bug #3: Nearby's BLE medium needs it on every level.
    expect(manifest).not.toMatch(
      /ACCESS_FINE_LOCATION"[^>]*android:maxSdkVersion/,
    );
  });

  it('types the foreground service for both of its jobs', () => {
    expect(manifest).toMatch(
      /android:foregroundServiceType="microphone\|connectedDevice"/,
    );
  });
});

describe('the section 11 cross-check — iOS', () => {
  it('declares every usage description section 11 lists', () => {
    for (const key of [
      'NSMicrophoneUsageDescription',
      'NSBluetoothAlwaysUsageDescription',
      'NSLocalNetworkUsageDescription',
      'NSBonjourServices',
    ]) {
      expect(infoPlist).toContain(key);
    }
  });

  it('declares both background modes and no others', () => {
    const modes = infoPlist
      .split('<key>UIBackgroundModes</key>')[1]
      .split('</array>')[0];
    expect(modes).toContain('<string>audio</string>');
    expect(modes).toContain('<string>bluetooth-central</string>');
    expect(modes.match(/<string>/g)).toHaveLength(2);
  });

  it('claims no push-to-talk entitlement anywhere', () => {
    // Removed with PushToTalk on 2026-08-18 (section 10.2): the entitlement no
    // longer exists to be claimed.
    const entitlements = readFileSync(
      join(repoRoot, 'ios', 'Oru', 'Oru.entitlements'),
      'utf8',
    );
    expect(entitlements).not.toContain('push-to-talk');
    expect(infoPlist).not.toContain('com.apple.developer.push-to-talk');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test __tests__/permission-crosscheck.test.ts`
Expected: FAIL — `ENOENT` on `docs/section-11-permission-crosscheck.md`.

- [ ] **Step 3: Verify each row before writing the document**

Run each of these and keep the output for the task report:

```bash
grep -n "uses-permission" android/app/src/main/AndroidManifest.xml
grep -rn "MODE_IN_COMMUNICATION\|startBluetoothSco\|setCommunicationDevice" android/app/src/main/java/com/oru/radio/
grep -rn "play-services-nearby" android/app/build.gradle
grep -n "NSBonjourServices" -A 3 ios/Oru/Info.plist
```

If any row's justification does not hold up, correct the table below and the test's
`EXPECTED_ANDROID` list together, and report the correction.

- [ ] **Step 4: Write the cross-check document**

Create `docs/section-11-permission-crosscheck.md`, containing: a one-paragraph statement of
what the cross-check is; the full table from this task's preamble, with the `grep` evidence for
each "used by" cell; a short "Play Store Data Safety" section recording that
`ACCESS_BACKGROUND_LOCATION` requires a Data Safety disclosure and a background-location
declaration form in the Play Console before release, that this is a console task and not a
code task, and that the in-app step that precedes it is `src/screens/BackgroundStep.tsx`; and a
closing line stating the verdict — no manifest or plist change was required — with the date.

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm test __tests__/permission-crosscheck.test.ts __tests__/android-manifest.test.ts __tests__/ios-config.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the task gate**

Run: `pnpm typecheck && pnpm lint && pnpm test __tests__/permission-crosscheck.test.ts`
Expected: all green. Add `pnpm build:android` only if Step 3 forced a manifest edit.

- [ ] **Step 7: Commit**

```bash
git add docs/section-11-permission-crosscheck.md __tests__/permission-crosscheck.test.ts
git commit -m "docs: cross-check every section 11 declaration against the merged code"
```

---

## Task 9: Smoke tests of the assembled app

**Files:**
- Create: `jest/renderApp.tsx`, `__tests__/app-smoke.test.tsx`

**Interfaces:**
- Consumes: `bootstrapApp` (Task 1); `App` (Task 2); the mock stack
  (`mockRadio`, `mockPermissions`, `setMockScenario`); `platformGateway` (Task 4).
- Produces:
  ```ts
  export type RenderedApp = RenderedScreen;   // same helper surface as renderScreen
  export async function renderApp(options?: {
    locale?: 'en' | 'ru';
    scenario?: MockScenarioName;
    gateway?: Partial<PlatformPermissionsGateway>;
  }): Promise<RenderedApp>;
  ```

**Why a second harness.** `jest/renderScreen.tsx` subscribes `radioEventListener` itself,
because a lone screen has no app entry above it. The assembled app *does* — `bootstrapApp()`
subscribes — so a harness that also subscribed would deliver every event twice. `renderApp`
therefore boots the app the way `index.js` does and subscribes nothing of its own.

- [ ] **Step 1: Write the failing test**

Create `jest/renderApp.tsx`:

```tsx
import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import {context} from '@reatom/core';
import {i18n} from '@lingui/core';
import type {ReactTestInstance} from 'react-test-renderer';

import App from '../App';
import {bootstrapApp} from '../src/app/appEntry';
import {mockPermissions} from '../src/permissions/permissions.mock';
import {mockRadio} from '../src/radio/radio.native.mock';
import {platformGateway, realPlatformGateway} from '../src/permissions/platform.gateway';
import {reducedMotion} from '../src/ui/reducedMotion';
import {DEFAULT_MOCK_SCENARIO, setMockScenario} from '../src/mock/mock.scenario';
import type {MockScenarioName} from '../src/mock/mock.scenario';
import type {PlatformPermissionsGateway} from '../src/permissions/platform.gateway';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {loadPoCatalog} = require('./loadPoCatalog');

export type RenderAppOptions = {
  locale?: 'en' | 'ru';
  scenario?: MockScenarioName;
  gateway?: Partial<PlatformPermissionsGateway>;
};

const collectText = (node: ReactTestInstance | string): string[] =>
  typeof node === 'string' ? [node] : node.children.flatMap(collectText);

export async function renderApp(options: RenderAppOptions = {}) {
  context.reset();

  setMockScenario(options.scenario ?? DEFAULT_MOCK_SCENARIO);
  mockPermissions.reset();
  mockRadio.reset(options.scenario ? {scenario: options.scenario} : {});
  reducedMotion.set(false);
  platformGateway.set({...realPlatformGateway, ...options.gateway});

  // `bootstrapApp` activates the locale from the real catalog path; the .po
  // moduleNameMapper stubs those out under Jest, so the catalog is reloaded
  // from disk afterwards exactly as `renderScreen` does.
  const {teardown} = bootstrapApp({
    systemLocale: options.locale ?? 'en',
    appState: {addEventListener: () => ({remove: () => {}})},
    devMenu: {addMenuItem: () => {}},
  });
  i18n.loadAndActivate({
    locale: options.locale ?? 'en',
    messages: loadPoCatalog(options.locale ?? 'en'),
  });

  let renderer: ReactTestRenderer.ReactTestRenderer | undefined;
  await ReactTestRenderer.act(async () => {
    renderer = ReactTestRenderer.create(<App />);
  });

  const tree = renderer as ReactTestRenderer.ReactTestRenderer;
  const root = tree.root;
  const rawFindAll = (testID: string) => root.findAllByProps({testID});
  const findAll = (testID: string) => {
    const matches = rawFindAll(testID);
    const matchSet = new Set(matches);
    return matches.filter(node => {
      for (let ancestor = node.parent; ancestor; ancestor = ancestor.parent) {
        if (matchSet.has(ancestor)) return false;
      }
      return true;
    });
  };

  const fire = async (testID: string, handler: string) => {
    await ReactTestRenderer.act(async () => {
      const target = rawFindAll(testID).find(
        node => typeof node.props[handler] === 'function',
      );
      if (!target) throw new Error(`testID "${testID}" has no ${handler} handler`);
      (target.props[handler] as (event: unknown) => void)({nativeEvent: {}});
    });
  };

  return {
    root,
    texts: () => collectText(root),
    hasText: (value: string) => collectText(root).join('').includes(value),
    findAll,
    press: (testID: string) => fire(testID, 'onPress'),
    pressIn: (testID: string) => fire(testID, 'onPressIn'),
    pressOut: (testID: string) => fire(testID, 'onPressOut'),
    advance: async (ms: number) => {
      await ReactTestRenderer.act(async () => {
        jest.advanceTimersByTime(ms);
      });
    },
    act: async (body: () => Promise<unknown> | unknown) => {
      await ReactTestRenderer.act(async () => {
        await body();
      });
    },
    unmount: () => {
      teardown();
      ReactTestRenderer.act(() => tree.unmount());
    },
  };
}
```

Create `__tests__/app-smoke.test.tsx`:

```tsx
import {context} from '@reatom/core';
import {i18n} from '@lingui/core';

import {radio} from '../src/radio/radio.model';
import {renderApp} from '../jest/renderApp';
import {testIds} from '../src/ui/theme';
import {backgroundStepTestIds} from '../src/screens/BackgroundStep';

jest.useFakeTimers({doNotFake: ['queueMicrotask']});

beforeEach(() => context.reset());

describe('the assembled app — spec section 15 Stage 4', () => {
  it('opens on the radio when the sequence is already satisfied', async () => {
    const app = await renderApp({
      gateway: {onboardingCompleted: () => true, hasOnboardingPermissions: async () => true},
    });

    expect(app.findAll(testIds.radioScreen)).toHaveLength(1);
    expect(app.hasText('RADIO OFF')).toBe(true);
    app.unmount();
  });

  it('opens on onboarding on a fresh install and lands on the radio', async () => {
    const app = await renderApp({
      gateway: {onboardingCompleted: () => false, hasOnboardingPermissions: async () => false},
    });

    expect(app.findAll(testIds.onboardingScreen)).toHaveLength(1);
    await app.press(testIds.onboardingAllow);
    await app.press(testIds.onboardingAllow);
    await app.press(testIds.onboardingAllow);
    await app.press(testIds.onboardingStart);

    expect(app.findAll(testIds.radioScreen)).toHaveLength(1);
    app.unmount();
  });

  it('shows the background step where the platform has one', async () => {
    const app = await renderApp({
      gateway: {
        onboardingCompleted: () => false,
        hasOnboardingPermissions: async () => false,
        backgroundStepSupported: () => true,
        hasBackgroundLocation: async () => false,
      },
    });

    await app.press(testIds.onboardingAllow);
    await app.press(testIds.onboardingAllow);
    await app.press(testIds.onboardingAllow);
    await app.press(testIds.onboardingStart);

    expect(app.findAll(backgroundStepTestIds.screen)).toHaveLength(1);
    await app.press(backgroundStepTestIds.skip);
    expect(app.findAll(testIds.radioScreen)).toHaveLength(1);
    app.unmount();
  });

  it('drives a whole session: power on, peers, talk, power off', async () => {
    const app = await renderApp({
      scenario: 'happy',
      gateway: {onboardingCompleted: () => true, hasOnboardingPermissions: async () => true},
    });

    await app.press(testIds.powerOnArea);
    await app.advance(5000);
    expect(radio().status).toBe('ready');
    expect(app.hasText('nearby')).toBe(true);

    await app.pressIn(testIds.pttArea);
    await app.advance(100);
    expect(radio().transmitting).toBe(true);
    expect(app.hasText('TRANSMITTING')).toBe(true);

    await app.pressOut(testIds.pttArea);
    await app.advance(100);
    expect(radio().transmitting).toBe(false);
    app.unmount();
  });

  it('reaches settings and the pairing flow from the main screen', async () => {
    const app = await renderApp({
      scenario: 'pairing-success',
      gateway: {onboardingCompleted: () => true, hasOnboardingPermissions: async () => true},
    });

    await app.press(testIds.settingsGear);
    expect(app.findAll(testIds.settingsScreen)).toHaveLength(1);

    await app.press(testIds.pttConnect);
    expect(app.findAll(testIds.pairingScreen)).toHaveLength(1);
    app.unmount();
  });

  it('boots in Russian for a Russian system locale', async () => {
    const app = await renderApp({
      locale: 'ru',
      gateway: {onboardingCompleted: () => true, hasOnboardingPermissions: async () => true},
    });

    expect(i18n.locale).toBe('ru');
    expect(app.hasText('РАЦИЯ ВЫКЛЮЧЕНА')).toBe(true);
    app.unmount();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test __tests__/app-smoke.test.tsx`
Expected: FAIL — `Cannot find module '../jest/renderApp'`.

- [ ] **Step 3: Make them pass**

Both files are written in Step 1. Run the suite and fix what it finds, with two rules:

1. **A failing assertion about a merged screen's behaviour is a report, not an edit.** If, for
   example, the power-on flow does not reach `ready`, record the exact symptom in the task
   report and, if the assertion was about something outside this plan's boundary, narrow the
   assertion — do not touch `src/screens/` or `src/radio/`.
2. If a copy assertion (`'RADIO OFF'`, `'TRANSMITTING'`, `'nearby'`, `'РАЦИЯ ВЫКЛЮЧЕНА'`) does
   not match, read the actual string out of `src/locales/en/messages.po` /
   `src/locales/ru/messages.po` and use it verbatim. The catalogs are the source of truth for
   copy, not this plan.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test __tests__/app-smoke.test.tsx`
Expected: PASS, 6 tests.

- [ ] **Step 5: Run the task gate**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: all green — the whole suite, merged and new.

- [ ] **Step 6: Commit**

```bash
git add jest/renderApp.tsx __tests__/app-smoke.test.tsx
git commit -m "test(app): smoke-test the assembled app end to end against the mock"
```

---

## Task 10: README with run instructions for both platforms

**Files:**
- Modify: `README.md`

**Interfaces:** none. This task adds no code.

- [ ] **Step 1: Write the README**

Replace `README.md` entirely. It must contain, in this order and with these facts — every
command below is already real in this repository, so verify each one before writing it down:

1. **What this is.** Two sentences: an offline push-to-talk radio for Android and iPhone over
   Nearby Connections, no internet, no accounts, no backend. A link to the spec
   (`docs/superpowers/specs/2026-08-13-offline-nearby-ptt-design.md`).
2. **Requirements.** Node ≥ 22.11 (`package.json` `engines`), pnpm 10.x, the Android SDK, the
   Android Studio JBR, and — for iOS — macOS with Xcode and CocoaPods. State plainly that iOS
   is built only on macOS and that no gate in this repository compiles Swift.
3. **Install.** `pnpm install`. Note that `.npmrc` pins `node-linker=hoisted`, which React
   Native requires.
4. **Run on Android.** `pnpm start` in one shell, `pnpm android` in another. Mention
   `pnpm build:android`, which resolves the SDK and the JDK itself (`scripts/build-android.js`
   writes `android/local.properties` and pins `org.gradle.java.home`), so it works in a fresh
   shell with no environment setup, and warn that the first run downloads Gradle, the NDK and
   CMake and is slow.
5. **Run on iOS.** `bundle install && bundle exec pod install` from `ios/`, then `pnpm ios`.
   Note that the fonts folder reference in `ios/Oru.xcodeproj` is still an open Xcode step
   (recorded by P6) and that the local `Radio` Swift package builds `RadioKit`.
6. **Permissions on first launch.** The three onboarding steps, the Android-only background
   step, and the fact that on Android the microphone, Bluetooth and location grants are
   required before the foreground service will start; add the `adb shell pm grant` lines from
   `docs/stage3-bridge-acceptance.md` as the way to pre-grant them for testing.
7. **The mock backend.** `RADIO_BACKEND=mock` builds the app against the §6.5 mock engine and
   the mock permission gateway — how design work, demos and screenshots run — and under
   `__DEV__` the Dev Menu carries one entry per scenario. The default in both dev and release
   is the real native backend.
8. **Locales.** English by default, Russian for a `ru` system locale, no in-app picker; copy
   lives in `src/locales/{en,ru}/messages.po` and is regenerated with `pnpm lingui:extract`.
9. **Tests and gates.** `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build:android` —
   and that the JS suite runs entirely against the mock (`jest.config.js` pins
   `RADIO_BACKEND=mock`), so a green suite says nothing about a device.
10. **Acceptance on real hardware.** Point at `docs/stage4-integration-acceptance.md` (Task 11)
    and `docs/stage3-bridge-acceptance.md`, and state that physical devices are the only source
    of truth for Nearby, BLE and background behaviour (§16).
11. **Layout.** A short tree of `src/`, `android/app/src/main/java/com/oru/`, `ios/`, `specs/`
    and `docs/`, one line each.

- [ ] **Step 2: Verify every command in it**

Run, and fix the README rather than the repository if any of these disagree with it:

```bash
node -e "console.log(require('./package.json').scripts)"
node -e "console.log(require('./package.json').engines)"
cat .npmrc
```

- [ ] **Step 3: Run the task gate**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: all green. (`pnpm lint` covers Markdown only if configured; running the full gate
here is cheap and proves the README change broke nothing.)

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: replace the template README with real run instructions"
```

---

## Task 11: The §15 Stage 4 on-device acceptance checklist

**Files:**
- Create: `docs/stage4-integration-acceptance.md`
- Test: `__tests__/permission-crosscheck.test.ts` is not extended; this task adds no test.

**Interfaces:** none.

**Read this before starting.** §15 Stage 4's acceptance is *"full flow on both platforms from
install to talking"*, on two physical devices with the internet off. **No gate on this host runs
devices, and no implementer can assert this.** The deliverable of this task is therefore the
checklist itself — an operator-facing document, in the shape of `docs/stage3-bridge-acceptance.md`
— and nothing in this plan may claim Stage 4 passed. The run's closeout executes it.

- [ ] **Step 1: Read the precedent**

Read `docs/stage3-bridge-acceptance.md` end to end. Match its structure: preconditions, a
"known state of the tree" section, a numbered table of step/expected rows with a place to
record pass/fail and the device, and a closing section on what to do when a row fails.

- [ ] **Step 2: Write the checklist**

Create `docs/stage4-integration-acceptance.md` with:

**Preconditions.** One Android device and one iPhone, both with a **debug** build installed
from a clean install (uninstall first — the checklist starts at first launch). Internet off on
both. The default backend, i.e. **not** `RADIO_BACKEND=mock`. Both devices' Bluetooth on.

**Known state of the tree.** State, as facts the operator should not be surprised by: iOS
compiles nowhere in CI, so the first iOS build is also the first Swift compile of this branch;
iOS raises its microphone / Bluetooth / local-network prompts when the radio starts, not during
onboarding, because iOS exposes no pre-request API (see this plan's ruling 2); Android pairing
with the radio off rejects with `radio_off` (P5's finding), so pair with the radio on; and
`__DEV__` builds carry the mock-scenario Dev Menu entries, which must not be used during this
checklist.

**The checklist.** At least these rows, each with an explicit expected result:

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
| 9 | Power the radio on, both devices | `searching` then `ready`; the peer count rises on both |
| 10 | Hold the PTT area on Android | Android shows `transmitting`; the iPhone shows `receiving` and plays the audio. On iOS this is where the microphone / local-network prompts appear on a first run — allow them |
| 11 | The same in the other direction | Mirrored |
| 12 | Lock both phones, transmit again | Audio still passes both ways (§4) |
| 13 | Open Settings → Connect, pair a button with the radio **on** | The four-step pairing flow completes and the button's name appears in Settings |
| 14 | Press the physical button with the phone locked | Transmission starts (§4) |
| 15 | Walk out of range and back | The connection restores automatically without touching either app (§4, Phase 0 scenario D) |
| 16 | Kill the React Native process (Android: `adb shell am kill com.oru`), keep the service running | Radio functionality continues; relaunching the UI re-syncs to the live state rather than to `off` (§4, §6.2) |
| 17 | Background the app for a minute, then return | The main screen shows the state the engine actually holds, not a stale one |
| 18 | Power the radio off with the press-and-hold | A single transition to `off`, no `starting` flash, peer count cleared |
| 19 | Switch the system language to Russian and relaunch | Every screen in this checklist is Russian |
| 20 | Throughout | No crash, and no screen file was edited to make any of the above work |

**When a row fails.** Record the row, the device, the platform and the observed behaviour. A
failure in a merged engine, bridge or screen is reported against that plan — this plan's
boundary is wiring, and repairing an engine here would hide which stage actually broke.

- [ ] **Step 3: Verify the document is internally consistent**

Re-read it against §4's Definition of Done: every one of the eleven bullets there must map to a
row above. Add rows for any that do not.

- [ ] **Step 4: Run the task gate**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add docs/stage4-integration-acceptance.md
git commit -m "docs: write the section 15 Stage 4 on-device acceptance checklist"
```

---

## What this plan deliberately does not do

Each of these belongs to a named neighbour or to closeout; doing it here would be a scope
violation, not a favour.

- **Any change inside `android/app/src/main/java/com/oru/radio/` or
  `ios/Radio/Sources/RadioKit/`** → merged P2 / P3. If wiring appears to need one, that is a
  report.
- **Any change to `specs/NativeRadio.ts`, `com.oru.bridge`, `ios/Oru/RadioBridge.swift` or
  `ios/Oru/NativeRadioModule.mm`** → merged P5. Task 6 edits `AppDelegate.swift`, which P5
  explicitly left to P7, and nothing else under `ios/Oru/`.
- **Any behavioural change to `RadioScreen.tsx`, `SettingsScreen.tsx`, `PairingFlow.tsx`,
  `OnboardingFlow.tsx` or anything under `src/ui/`** → merged P6. Task 7 adds a new screen file
  beside them; it does not edit them.
- **An iOS native permissions module** (`AVAudioApplication.requestRecordPermission`,
  `CBManager.authorization`) → not this plan. See ruling 2: iOS cannot answer for local network
  at all, the module would be Swift that no gate here compiles, and §11's iOS column asks for
  `Info.plist` declarations rather than a request API. It is recorded in the plan report as a
  follow-up the operator can choose to take.
- **Executing the Stage 4 checklist** → closeout, on physical hardware. Task 11 writes it; no
  task in this plan may report it as passed.
- **The concrete purchased button's protocol (Stage 5) and the background reliability matrix
  (Stage 6)** → closeout.
- **A Play Console Data Safety submission** → a release task; Task 8 records that it is
  required and why.

---

## Self-review

**Spec coverage.**

| Spec requirement | Task |
|---|---|
| §4 Definition of Done, as acceptance | Task 11 (checklist rows mapped to all eleven bullets) |
| §6.2 boot `getState()` → sync, live `stateChanged` events | Task 1 |
| §6.2 resume re-sync via `AppState` | Task 1 |
| §11 Android runtime prompts, in the onboarding order | Tasks 3, 5 |
| §11 `ACCESS_BACKGROUND_LOCATION` step + two-step Settings redirect | Tasks 4, 5, 7 |
| §11 Data Safety disclosure | Task 8 (recorded as a console task) |
| §11 cross-check of every declaration against merged code | Task 8 |
| §12 five main-screen states reachable in the assembled app | Task 9 |
| §12 navigation between Radio / Settings / pairing / onboarding | Tasks 2, 5, 7 |
| §12.2 `i18n.loadAndActivate` with the system locale and `en` fallback | Task 1, asserted again in Task 9 |
| §12.2 Russian copy for all new strings | Task 7 |
| §15 Stage 4 acceptance | Task 11 |
| §6.5 dev-menu scenario switching wired at entry | Task 1 |
| README, both platforms | Task 10 |

**Placeholders.** None: every step carries the code or the exact document contents it asks
for. The two places that legitimately depend on the repository rather than on this plan —
Task 7's `lingui extract` message ids and Task 9's copy assertions — say explicitly which file
is the source of truth and how to read it.

**Type consistency.** `Route` is `'onboarding' | 'background' | 'radio' | 'settings' |
'pairing'` in Tasks 2, 5 and 7. `SequencingStep` is the three-value subset and is used only as
a return type. `backgroundStatus` is `'idle' | 'needsSettings' | 'granted'` in Tasks 5 and 7.
`PlatformPermissionsGateway`'s eight members are identical in Tasks 4, 5, 7 and 9.
`bootstrapApp(host?: BootstrapHost): Bootstrapped` is called with the same shape in Task 1's
test, Task 2's `index.js` and Task 9's harness. `PermissionStatus` and `PermissionsBackend` are
consumed exactly as merged, never redefined.
