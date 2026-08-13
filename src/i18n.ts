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
 * Spec section 12.2: the app language follows the system locale, and anything
 * other than Russian falls back to English. There is no in-app picker.
 */
export function resolveLocale(systemLocale: string | undefined): AppLocale {
  const tag = (systemLocale ?? '').toLowerCase();
  const language = tag.split(/[-_]/)[0];

  return language === 'ru' ? 'ru' : defaultLocale;
}

/**
 * Activates a catalog and returns the locale that was activated. The caller
 * supplies the system locale; reading it is an app-entry concern (P7).
 */
export function initI18n(systemLocale?: string): AppLocale {
  const locale = resolveLocale(systemLocale);

  i18n.loadAndActivate({locale, messages: catalogs[locale]});

  return locale;
}
