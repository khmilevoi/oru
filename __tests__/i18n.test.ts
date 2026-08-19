import {i18n} from '@lingui/core';

import {
  activateLocale,
  defaultLocale,
  initI18n,
  locales,
  resolveLocale,
} from '../src/i18n';

describe('locale resolution (spec section 12.2)', () => {
  it('defaults to English', () => {
    expect(defaultLocale).toBe('en');
    expect(locales).toEqual(['en', 'ru']);
  });

  it.each([
    ['ru', 'ru'],
    ['ru-RU', 'ru'],
    ['ru_RU', 'ru'],
    ['RU-ru', 'ru'],
  ])('resolves %s to %s', (systemLocale, expected) => {
    expect(resolveLocale(systemLocale)).toBe(expected);
  });

  it.each([['en'], ['en-US'], ['de-DE'], ['zh-Hans'], [''], [undefined]])(
    'falls back to English for %s',
    systemLocale => {
      expect(resolveLocale(systemLocale as string | undefined)).toBe('en');
    },
  );
});

describe('i18n activation', () => {
  it('activates Russian for a Russian system locale', () => {
    expect(initI18n('ru-RU')).toBe('ru');
    expect(i18n.locale).toBe('ru');
  });

  it('activates English for anything else', () => {
    expect(initI18n('fr-FR')).toBe('en');
    expect(i18n.locale).toBe('en');
  });
});

describe('activateLocale (amended section 12.2 — the in-app picker)', () => {
  it('activates the requested catalog directly, no system locale involved', () => {
    activateLocale('ru');
    expect(i18n.locale).toBe('ru');

    activateLocale('en');
    expect(i18n.locale).toBe('en');
  });

  it('carries the catalog with the activation, so copy switches in place', () => {
    activateLocale('ru');
    expect(Object.keys(i18n.messages).length).toBeGreaterThan(30);
  });
});
