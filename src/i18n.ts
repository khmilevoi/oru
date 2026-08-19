import {i18n} from '@lingui/core';

import {messages as enMessages} from './locales/en/messages.po';
import {messages as ruMessages} from './locales/ru/messages.po';

export const locales = ['en', 'ru'] as const;

export type AppLocale = (typeof locales)[number];

export const defaultLocale: AppLocale = 'en';

const catalogs: Record<AppLocale, typeof enMessages> = {
  en: enMessages,
  ru: ruMessages,
};

/**
 * Amended spec section 12.2 (2026-08-19): a stored in-app override wins; with
 * no override the app language follows the system locale, and anything other
 * than Russian falls back to English. This function is the system half of that
 * rule — the override half lives in `src/app/locale.model.ts`, which calls
 * `activateLocale` below directly.
 */
export function resolveLocale(systemLocale: string | undefined): AppLocale {
  const tag = (systemLocale ?? '').toLowerCase();
  const language = tag.split(/[-_]/)[0];

  return language === 'ru' ? 'ru' : defaultLocale;
}

/**
 * Activates one catalog, in place. `I18nProvider` subscribes to `i18n`'s
 * change event, so every `Trans`/`useLingui` consumer re-renders in the same
 * tick — switching the language never reloads anything.
 */
export function activateLocale(locale: AppLocale): void {
  i18n.loadAndActivate({locale, messages: catalogs[locale]});
}

/**
 * Activates a catalog for the system locale and returns what was activated.
 * The caller supplies the system locale; reading it is an app-entry concern
 * (P7), and so is applying the stored override on top (amended section 12.2).
 */
export function initI18n(systemLocale?: string): AppLocale {
  const locale = resolveLocale(systemLocale);

  activateLocale(locale);

  return locale;
}
