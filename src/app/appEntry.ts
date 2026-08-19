import {AppState, DevSettings, NativeModules} from 'react-native';
import {bind} from '@reatom/core';

import {initI18n} from '../i18n';
import {lastRadioError, radio, radioEventListener} from '../radio/radio.model';
import {localeOverride} from './locale.model';
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
 * 1. activate a catalog, so the first frame is already localized — the system
 *    locale synchronously, then the stored amended-12.2 override on top the
 *    moment the bridge answers;
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

  // Amended section 12.2: a natively stored override beats the system locale.
  // The bridge read is async, so the synchronous activation above is the
  // system fallback the first frame would use, and the override — when one is
  // stored — re-activates the catalog in place within the bootstrap
  // microtasks. Fire-and-forget on purpose: `restore()` returns absence and
  // failure as values, and either one simply leaves the system choice standing.
  void localeOverride.restore();

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
