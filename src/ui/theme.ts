import {StyleSheet} from 'react-native';
import type {TextStyle} from 'react-native';

/**
 * Spec section 12.1's visual direction, resolved to values: a dark,
 * high-contrast "radio hardware" chassis with TX red, RX green and amber for
 * button learning. This file is the only place a colour, a font face or a
 * duration is written down; a screen that hardcodes one is a bug.
 */

export const colors = {
  /** Anodised body: the screen behind everything. */
  background: '#0a0c0d',
  /** A recessed panel: cards, list rows, the settings sections. */
  surface: '#14181a',
  /** A raised key face: buttons, the power key, the gear. */
  surfaceRaised: '#1e2427',
  /** An engraved seam between panels. */
  hairline: '#2a3236',

  text: '#e7ecee',
  textMuted: '#7c8b92',
  textInverse: '#0a0c0d',

  /** Transmitting. */
  tx: '#ff3b30',
  txWash: '#2a0f0d',
  /** Receiving. */
  rx: '#2fd65b',
  rxWash: '#0c2b16',
  /** Button learning. */
  learning: '#ffb020',
  learningWash: '#2e2007',
  /** Dead air: the `off` state's only accent. */
  off: '#3a4348',
  danger: '#ff5a4d',
} as const;

/**
 * PostScript names, which for these six faces equal their filenames -- so the
 * same string resolves on iOS (by PostScript name) and Android (by asset
 * filename). Never pair one of these with `fontWeight`: Android would
 * synthesise a weight and iOS would fail to find a face.
 */
export const fonts = {
  display: 'Oswald-Bold',
  displayMedium: 'Oswald-Medium',
  displayRegular: 'Oswald-Regular',
  mono: 'IBMPlexMono-Regular',
  monoMedium: 'IBMPlexMono-Medium',
  monoStrong: 'IBMPlexMono-SemiBold',
} as const;

export const type = {
  /** The main screen's state headline. */
  hero: {
    fontFamily: fonts.display,
    fontSize: 40,
    lineHeight: 46,
    letterSpacing: 2,
  },
  title: {
    fontFamily: fonts.displayMedium,
    fontSize: 24,
    lineHeight: 30,
    letterSpacing: 1.5,
  },
  /** Engraved panel labels and button captions. */
  label: {
    fontFamily: fonts.monoStrong,
    fontSize: 13,
    lineHeight: 18,
    letterSpacing: 2,
  },
  body: {fontFamily: fonts.mono, fontSize: 15, lineHeight: 22},
  caption: {
    fontFamily: fonts.mono,
    fontSize: 12,
    lineHeight: 16,
    letterSpacing: 1,
  },
} as const satisfies Record<string, TextStyle>;

export const spacing = {xs: 4, sm: 8, md: 16, lg: 24, xl: 32, xxl: 48} as const;

export const radii = {sm: 4, md: 8, lg: 16, pill: 999} as const;

export const motion = {
  /**
   * Press-and-hold to power the radio off (section 12.1): a guard against an
   * accidental shut-off on a screen that is one giant touch area.
   */
  powerHoldMs: 1200,
  /** One breath of the scanning cue. */
  pulseMs: 1400,
  fadeMs: 220,
  /** Opacity the corner controls recede to while transmitting or receiving. */
  recededOpacity: 0.15,
} as const;

/** Stable hooks for the acceptance suite. Screens must use these, not literals. */
export const testIds = {
  radioScreen: 'radio-screen',
  radioStateLabel: 'radio-state-label',
  pttArea: 'ptt-area',
  powerOnArea: 'power-on-area',
  powerKey: 'power-key',
  settingsGear: 'settings-gear',
  errorState: 'error-state',
  errorRestart: 'error-restart',

  settingsScreen: 'settings-screen',
  pttStatus: 'ptt-status',
  pttConnect: 'ptt-connect',
  pttTest: 'ptt-test',
  pttReplace: 'ptt-replace',
  settingsBack: 'settings-back',

  pairingScreen: 'pairing-screen',
  pairingCandidate: 'pairing-candidate',
  pairingRetry: 'pairing-retry',
  pairingCancel: 'pairing-cancel',
  pairingDone: 'pairing-done',

  onboardingScreen: 'onboarding-screen',
  onboardingAllow: 'onboarding-allow',
  onboardingRetry: 'onboarding-retry',
  onboardingOpenSettings: 'onboarding-open-settings',
  onboardingSkip: 'onboarding-skip',
  onboardingStart: 'onboarding-start',
} as const;

/** Every screen sits on the chassis. */
export const chassis = StyleSheet.create({
  screen: {flex: 1, backgroundColor: colors.background},
});
