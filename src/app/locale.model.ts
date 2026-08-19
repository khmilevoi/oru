import {atom, wrap} from '@reatom/core';

import {activateLocale, locales} from '../i18n';
import {RadioNative} from '../radio/radio.native';
import type {AppLocale} from '../i18n';

/**
 * Amended spec section 12.2 (2026-08-19): the in-app language override.
 *
 * Deliberately NOT the engine-mirror pattern `radio.model.ts` uses for
 * `audioMode`: the locale is a pure-JS concern with no engine counterpart and
 * no `stateChanged` echo, so this atom is written locally and the bridge is a
 * plain store (UserDefaults / SharedPreferences) it persists into. `null`
 * means no override was ever chosen — the app follows the system locale.
 */

/** A stored string is only an `AppLocale` if it still names a catalog. */
const parseAppLocale = (value: string | null): AppLocale | null =>
  locales.find(locale => locale === value) ?? null;

export const localeOverride = atom<AppLocale | null>(
  null,
  'localeOverride',
).extend(target => ({
  /**
   * The Settings picker's action: remember the choice, switch the catalog in
   * place (Lingui re-renders every consumer — no reload), then persist it.
   * A failed persist is returned as a value, errore-style: the switch already
   * happened for this session and only the next launch would miss it.
   */
  async select(locale: AppLocale) {
    target.set(locale);
    activateLocale(locale);

    return await wrap(RadioNative.setAppLocale(locale));
  },

  /**
   * App entry's action: a stored override beats the system locale. The bridge
   * read is async, so `initI18n` has already activated the system fallback by
   * the time this lands — activating over it is exactly the no-reload switch
   * `select` performs, one bootstrap tick after the first activation.
   */
  async restore() {
    const stored = await wrap(RadioNative.getAppLocale());
    if (stored instanceof Error) return null;

    const locale = parseAppLocale(stored);
    if (locale === null) return null;

    target.set(locale);
    activateLocale(locale);
    return locale;
  },
}));
