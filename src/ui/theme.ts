import {StyleSheet} from 'react-native';
import type {TextStyle, ViewStyle} from 'react-native';

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
  /**
   * The learning ring's pulse halo — `@keyframes pulse` states rgb(255 190 90)
   * of its own, not `--amber`. Its 0.25 alpha is animated, not baked in here.
   */
  learningHalo: '#ffbe5a',
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
 *
 * `textTransform: 'uppercase'` is part of a token wherever the canvas class it
 * resolves reaches the same effect in CSS -- `.display` (which `.holden`,
 * `.holdword`, `.bigword`, `.learnword` and `.okword` are all composed with),
 * `.obtitle`, `.slabel`, `.subhint`, `.scantext`, `.scanrow` and `.routeline`.
 * It belongs here and not in the catalogs: a `.po` msgid is source text, and
 * shouting is a rendering decision.
 */
export const type = {
  /** `.holden` -- the one-line headline. */
  hero: {
    fontFamily: fonts.display,
    fontSize: 40,
    lineHeight: 42,
    letterSpacing: 2,
    textTransform: 'uppercase',
  },
  /** `.holdword` -- the two-line headline locales like `ru` fall back to. */
  heroTight: {
    fontFamily: fonts.display,
    fontSize: 33,
    lineHeight: 43,
    letterSpacing: 1.65,
    textTransform: 'uppercase',
  },
  /** `.bigword` -- TRANSMITTING / RECEIVING / RADIO OFF. */
  state: {
    fontFamily: fonts.display,
    fontSize: 34,
    lineHeight: 40,
    letterSpacing: 1.7,
    textTransform: 'uppercase',
  },
  /**
   * `.learnword` and `.okword` -- the pairing flow's ring words, one size down
   * from `.bigword` (30px over 1.3). Composed with `.display` on the canvas,
   * whose 0.05em is 1.5 at this size.
   */
  stateSmall: {
    fontFamily: fonts.display,
    fontSize: 30,
    lineHeight: 39,
    letterSpacing: 1.5,
    textTransform: 'uppercase',
  },
  /**
   * `.obtitle` -- the onboarding title. `.holden`'s face and size, but the
   * canvas states its own tighter 0.04em (1.6 here) against `.display`'s
   * 0.05em, and a 1.05 line (42).
   */
  obTitle: {
    fontFamily: fonts.display,
    fontSize: 40,
    lineHeight: 42,
    letterSpacing: 1.6,
    textTransform: 'uppercase',
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
    textTransform: 'uppercase',
  },
  /**
   * `.scantext` in the pairing flow, which the canvas restates one size down
   * (14px at 0.14em). No line-height there; `type.scan`'s 20 keeps the two
   * scan lines on one metric.
   */
  scanPairing: {
    fontFamily: fonts.mono,
    fontSize: 14,
    lineHeight: 20,
    letterSpacing: 1.96,
    textTransform: 'uppercase',
  },
  /** `.subhint` -- the uppercase hint under a ring. */
  subhint: {
    fontFamily: fonts.mono,
    fontSize: 13,
    lineHeight: 18,
    letterSpacing: 1.56,
    textTransform: 'uppercase',
  },
  /** `.slabel` -- the engraved section label: 11px medium at 0.2em. */
  label: {
    fontFamily: fonts.monoMedium,
    fontSize: 11,
    lineHeight: 15,
    letterSpacing: 2.2,
    textTransform: 'uppercase',
  },
  /**
   * `.scanrow` -- the pairing list's "still scanning" line: regular weight at
   * 0.14em, which lands on `.routeline`'s exact metrics; a coincidence the
   * canvas states twice, so it is written down twice. Line-height as
   * `type.label`'s, for the same reason `type.routeLabel` takes it.
   */
  scanRow: {
    fontFamily: fonts.mono,
    fontSize: 11,
    lineHeight: 15,
    letterSpacing: 1.54,
    textTransform: 'uppercase',
  },
  /**
   * `.obstep` -- the onboarding step counter: regular weight at 0.22em, and the
   * one engraved label with no `text-transform` on the canvas (its copy there
   * is already shouted). Line-height as `type.label`'s.
   */
  obStep: {
    fontFamily: fonts.mono,
    fontSize: 11,
    lineHeight: 15,
    letterSpacing: 2.42,
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
  /**
   * `.offname` -- the "Not connected" line: `.devname`'s size at weight 400.
   * Line-height as `type.devName`'s, so the card holds its height either way.
   */
  devNameOff: {fontFamily: fonts.mono, fontSize: 19, lineHeight: 24},
  /** `.devmeta` and `.note`. */
  caption: {fontFamily: fonts.mono, fontSize: 12, lineHeight: 20},
  /**
   * `.devsub` -- the connection status under a device name: 13px, one up from
   * `.devmeta`. No line-height on the canvas; `type.subhint`'s 18 is the
   * figure for the same 13px mono face.
   */
  devStatus: {fontFamily: fonts.mono, fontSize: 13, lineHeight: 18},
  /** `.learnsub` -- the pairing learn step's hint: 13px over 1.7 (22). */
  learnSub: {fontFamily: fonts.mono, fontSize: 13, lineHeight: 22},
  /** `.vers`. */
  version: {
    fontFamily: fonts.mono,
    fontSize: 11,
    lineHeight: 14,
    letterSpacing: 1.54,
  },
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
    textTransform: 'uppercase',
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

/**
 * Canvas classes that more than one screen paints. `design/theme.css` declares
 * `.slabel` and `.obfoot` once each and shares them across screens; restating
 * their padding per screen is how the two copies drift apart, so the shapes are
 * written down here and spread at the call site.
 */
export const chrome = {
  /** `.slabel` -- `padding: 34px 28px 12px` (settings and pairing labels). */
  sectionLabel: {paddingTop: 34, paddingHorizontal: 28, paddingBottom: 12},
  /** `.obfoot` -- `padding: 0 26px 30px; gap: 18px` (the onboarding footers). */
  footer: {paddingHorizontal: 26, paddingBottom: 30, gap: 18},
  /** `.pfoot` -- `padding: 0 22px 30px` (the pairing learn/saved footers). */
  pairingFooter: {paddingHorizontal: 22, paddingBottom: 30},
} as const satisfies Record<string, ViewStyle>;

/**
 * `.stage` -- the centred column every radio and pairing state sits in -- and
 * the two gap overrides screens compose onto it (`.offstage` in `design/01
 * Radio.dc.html`, `.stage.pair` in `design/03 Pairing.dc.html`). Its own group
 * rather than entries on the `spacing` scale, which is the app's own invention:
 * these figures are the canvas's, stated per class.
 */
export const stage = {
  /** `.stage` gap. */
  gap: 40,
  /** `.stage` padding-bottom. */
  paddingBottom: 40,
  /** `.offstage` gap -- the `off` state opens the column up a touch. */
  offGap: 46,
  /** `.stage.pair` gap -- the pairing learn/saved steps close it down. */
  pairGap: 30,
} as const;

/**
 * `.scanhint` in `design/03 Pairing.dc.html` -- the scan step's hint, pinned
 * to the foot of the frame rather than stacked into the stage.
 */
export const scanHintInset = {side: 40, bottom: 40} as const;

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
  /** How far `@keyframes pulse`'s halo spreads (`0 0 0 26px`). */
  pulseSpread: 26,
  fadeMs: 220,
  /**
   * `.pwr.dim` -- what the power key recedes to while transmitting or
   * receiving. The power key alone: the canvas never dims `.gear`.
   */
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
  settingsScroll: 'settings-scroll',
  audioRoute: 'audio-route',
  audioMode: 'audio-mode',
  appLocale: 'app-locale',

  pairingScreen: 'pairing-screen',
  pairingCandidate: 'pairing-candidate',
  pairingRetry: 'pairing-retry',
  pairingCancel: 'pairing-cancel',
  /** The learn step's `.pfoot` Cancel -- the header chevron keeps `pairingCancel`. */
  pairingCancelFooter: 'pairing-cancel-footer',
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
