import {StyleSheet} from 'react-native';
import type {TextStyle} from 'react-native';

/**
 * The Claude Design canvas, resolved to React Native values. `design/theme.css`
 * is the source; the canvas states its status colours in oklch, which RN cannot
 * parse, so they are converted to sRGB here. All three convert without gamut
 * clamping and are exact. This file is the only place a colour, a font face, a
 * size or a duration is written down; a screen that hardcodes one is a bug.
 */

export const colors = {
  /** Anodised body: the screen behind everything (canvas `--bg`). */
  background: '#0b0d0f',
  /** Dead air. The `off` state has its own, darker chassis (`.phone.off`). */
  backgroundOff: '#070809',
  /** A recessed panel: cards, list rows, settings sections (`--bg2`). */
  surface: '#13161a',
  /** An engraved seam between panels (`--line`). */
  hairline: '#242b32',
  /** The brighter seam used for ring outlines and ghost keys (`--line2`). */
  hairlineRaised: '#2e363e',

  text: '#f2f4f2',
  textMuted: '#8b959d',
  textFaint: '#57626c',
  /** The version footer, fainter still than `textFaint` (`.vers`). */
  textGhost: '#3d454d',
  /** Label colour on a solid key (`.btn.solid`). */
  textInverse: '#0c0e10',
  /** The `off` state's headline (`.offword` = `--dim`). */
  deadAir: '#8b959d',

  /** Transmitting — oklch(0.63 0.21 27). */
  tx: '#ed413b',
  /**
   * The transmitting ring's border, oklch(0.7 0.21 27). This one is OUT of the
   * sRGB gamut and is clamped; it is not a mistake and must not be "corrected"
   * back towards the unclamped conversion.
   */
  txBorder: '#ff5a51',
  /** The transmitting hint under the ring, oklch(0.78 0.12 27). */
  txHint: '#fb988d',
  /** Receiving — oklch(0.72 0.17 152). */
  rx: '#35c26d',
  /** Button learning — oklch(0.78 0.14 75). */
  learning: '#eba941',
  danger: '#ff5a4d',
} as const;

/** Full-screen washes (`.phone.tx` / `.phone.rx`), as RN `backgroundImage`. */
export const washes = {
  tx: 'radial-gradient(circle at 50% 42%, #2a0e11 0%, #150608 78%)',
  rx: 'radial-gradient(circle at 50% 42%, #0f2318 0%, #060f09 78%)',
} as const;

/**
 * Coloured glows, as RN `boxShadow` strings. Supported natively from React
 * Native 0.76 on the New Architecture, which this project runs.
 */
export const glows = {
  peer: '0 0 14px rgba(53, 194, 109, 1)',
  tx: '0 0 110px 14px rgba(237, 65, 59, 0.45)',
  rx: '0 0 90px 0 rgba(53, 194, 109, 0.28)',
  ok: '0 0 60px rgba(53, 194, 109, 0.22)',
  okLarge: '0 0 70px rgba(53, 194, 109, 0.25)',
} as const;

/**
 * PostScript names, which for these faces equal their filenames -- so the same
 * string resolves on iOS (by PostScript name) and Android (by asset filename).
 * Never pair one of these with `fontWeight`.
 *
 * The canvas asks for Oswald 600 on `.display` and `.obtitle`. The app bundles
 * Regular/Medium/Bold, so `display` maps to Bold (700) -- an accepted delta,
 * recorded in this plan's decision D3, not an oversight.
 */
export const fonts = {
  display: 'Oswald-Bold',
  displayMedium: 'Oswald-Medium',
  displayRegular: 'Oswald-Regular',
  mono: 'IBMPlexMono-Regular',
  monoMedium: 'IBMPlexMono-Medium',
  monoStrong: 'IBMPlexMono-SemiBold',
} as const;

/**
 * The canvas states letter-spacing in `em`; React Native takes points, so each
 * value below is the canvas's em figure multiplied by its own font size.
 * `lineHeight` is likewise absolute here and a ratio there.
 */
export const type = {
  /** `.holden` -- the one-line headline, and `.obtitle`. */
  hero: {
    fontFamily: fonts.display,
    fontSize: 40,
    lineHeight: 42,
    letterSpacing: 2,
  },
  /** `.holdword` -- the two-line headline locales like `ru` fall back to. */
  heroTight: {
    fontFamily: fonts.display,
    fontSize: 33,
    lineHeight: 43,
    letterSpacing: 1.65,
  },
  /** `.bigword` -- TRANSMITTING / RECEIVING / RADIO OFF. */
  state: {
    fontFamily: fonts.display,
    fontSize: 34,
    lineHeight: 40,
    letterSpacing: 1.7,
  },
  /** `.stitle` -- the settings/pairing screen title. */
  title: {
    fontFamily: fonts.displayMedium,
    fontSize: 26,
    lineHeight: 32,
    letterSpacing: 0.78,
  },
  /** `.scantext` on the radio screen. */
  scan: {
    fontFamily: fonts.mono,
    fontSize: 15,
    lineHeight: 20,
    letterSpacing: 2.4,
  },
  /** `.subhint` -- the uppercase hint under a ring. */
  subhint: {
    fontFamily: fonts.mono,
    fontSize: 13,
    lineHeight: 18,
    letterSpacing: 1.56,
  },
  /** `.slabel` and `.obstep` -- engraved section labels. */
  label: {
    fontFamily: fonts.monoMedium,
    fontSize: 11,
    lineHeight: 15,
    letterSpacing: 2.2,
  },
  /** `.btn`. */
  button: {
    fontFamily: fonts.monoMedium,
    fontSize: 15,
    lineHeight: 20,
    letterSpacing: 0.3,
  },
  /** `.obbody`. */
  body: {fontFamily: fonts.mono, fontSize: 14, lineHeight: 24},
  /** `.peer`. */
  peer: {fontFamily: fonts.mono, fontSize: 15, lineHeight: 20},
  /** `.devname`. */
  devName: {fontFamily: fonts.monoMedium, fontSize: 19, lineHeight: 24},
  /** `.devmeta` and `.note`. */
  caption: {fontFamily: fonts.mono, fontSize: 12, lineHeight: 20},
  /** `.vers`. */
  version: {
    fontFamily: fonts.mono,
    fontSize: 11,
    lineHeight: 14,
    letterSpacing: 1.54,
  },
} as const satisfies Record<string, TextStyle>;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
  xxl: 48,
  /** The canvas's own side gutter: `.card` and `.dev` margin. */
  gutter: 22,
} as const;

export const radii = {
  /** `.bars span`. */
  sm: 3,
  /** `.btn`. */
  md: 14,
  /** `.dev`. */
  row: 16,
  /** `.card`. */
  lg: 18,
  pill: 999,
} as const;

/** Canvas geometry, in points. */
export const sizes = {
  /** `.ring` on the radio screen. */
  ring: 302,
  /** `.learnring` in the pairing flow. */
  ringLearning: 272,
  /** `.pingset` and `.pingset.sm`. */
  pingSet: 230,
  pingSetSmall: 170,
  /** `.gear` / `.pwr` hit target. */
  cornerControl: 56,
  /** `.pwrmark.big` and `.pwrmark`. */
  powerKeyHero: 112,
  powerKeyCorner: 21,
  /** `.peer`. */
  peerRow: 64,
  /** `.btn`. */
  button: 54,
  /** `.oktick` and `.okbig`. */
  tick: 96,
  tickLarge: 132,
  /** `.obmark` glyph box. */
  mark: 176,
} as const;

export const motion = {
  /**
   * Press-and-hold to power the radio off: a guard against an accidental
   * shut-off on a screen that is one giant touch area. The canvas does not
   * state a duration; this is the app's own and is unchanged.
   */
  powerHoldMs: 1200,
  /** One `.ping` cycle, and the 1s stagger between the three rings. */
  pingMs: 3000,
  pingStaggerMs: 1000,
  /** One `.bars` cycle, and the 0.12s stagger across the five bars. */
  levelMs: 900,
  levelStaggerMs: 120,
  /** `.pulse`. */
  pulseMs: 1600,
  fadeMs: 220,
  /** `.pwr.dim` -- what the corner controls recede to while live. */
  recededOpacity: 0.34,
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
  settingsVersion: 'settings-version',

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
