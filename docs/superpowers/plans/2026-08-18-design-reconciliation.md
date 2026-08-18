# Design Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the implemented React Native UI into line with the Claude Design canvas now exported into `design/`, closing the reconciliation item the P6 UI plan left open.

**Architecture:** `src/ui/theme.ts` stays the single source of truth and is retuned to the canvas's own values first; four new presentational primitives (`StateRing`, `LevelBars`, `PingRings`, `PeerRow`) carry the shapes the canvas has and the app never grew; each screen is then restructured onto them. The canvas's CSS-only effects — radial-gradient washes and coloured glows — map directly onto React Native 0.87 New Architecture style props (`backgroundImage`, `boxShadow`), so no new dependency is needed. Behaviour, the Reatom model and the §6.1 contract are untouched throughout: this is a visual change only.

**Tech Stack:** React Native 0.87.0 (New Architecture, `newArchEnabled=true`), React 19.2.3, TypeScript, Reatom v1001 (`@reatom/core` 1001.3.0, `@reatom/react` 1001.0.1), Lingui 6.6.0, `react-native-safe-area-context` ^5.5.2, Jest + `react-test-renderer` via `jest/renderScreen.tsx`.

**Spec:** `docs/superpowers/specs/2026-08-13-offline-nearby-ptt-design.md` §12 and §12.1, and the canvas it names, exported verbatim to `design/` (commit `29be0c2`). Read `design/README.md` first. Where this plan and the canvas disagree, the canvas wins; where the canvas and the spec's prose disagree, see "Conflicts" below.

## Global Constraints

- **The canvas is the visual authority.** `design/theme.css` carries the shared tokens; each `design/NN *.dc.html` carries its screen's own styles, layout and both locales' copy. Every value in this plan was read off those files.
- **`src/ui/theme.ts` is the only place a colour, font face, radius, duration or size is written down.** A screen that hardcodes one is a bug. If reconciliation needs a value the theme lacks, add the token — do not inline it.
- **Never pair a bundled font family with `fontWeight`.** Android would synthesise a weight and iOS would fail to find the face. `__tests__/theme-and-fonts.test.ts` enforces this over every entry in `type`.
- **The `testIds` map in `theme.ts` is the acceptance suite's contract.** No task in this plan renames or removes an id. New elements get new ids appended.
- **No screen may import `radio.native.ts`, `TurboModuleRegistry`, or any API that only behaves correctly on a device** (§6.4). Screens read the Reatom model and call its actions, nothing else.
- **No model, contract or native change.** A fact a screen needs that `RadioState` does not carry is out of scope for this plan — see Conflict C3.
- **Gate:** `npx jest` must be green at the end of every task. Also run `npx tsc --noEmit` before each commit; several tasks change shared types.
- **Locales:** every user-visible string goes through Lingui macros (`Trans` / `t`). Both `en` and `ru` catalogs stay complete — `__tests__/locale-coverage.test.ts` enforces this.

---

## Decisions

Each was a real fork. The chosen option is stated first, with the rationale and the alternative that was rejected.

**D1 — Adopt the canvas colours exactly, converting oklch to sRGB hex.**
The canvas states its status colours in oklch, which React Native cannot parse. Every one of them converts into sRGB **without gamut clamping**, so the hex values in Task 1 are exact, not approximations: `oklch(0.72 0.17 152)` → `#35c26d`, `oklch(0.63 0.21 27)` → `#ed413b`, `oklch(0.78 0.14 75)` → `#eba941`. The one exception is the transmitting ring's border, `oklch(0.7 0.21 27)`, which is **out of sRGB gamut** and clamps to `#ff5a51`; that is recorded in the theme as a clamped value so nobody later "corrects" it. *Alternative rejected:* keeping the app's punchier `#ff3b30` / `#2fd65b` / `#ffb020`. They are not the design, and the canvas's slightly desaturated set is what the rest of its palette was balanced against.

**D2 — Move the corner controls to the bottom and swap them: gear bottom-left, power bottom-right.**
The canvas puts `.gear` at `left: 22px; bottom: 22px` and `.pwr` at `right: 22px; bottom: 22px`. The app currently has both at the *top* (`top: spacing.xxl`) with power left and gear right — so this is a move and a swap. Bottom corners are also the reachable ones on a 390×844 phone whose entire middle is a PTT target. `react-native-safe-area-context` is already a dependency and `SafeAreaProvider` is already mounted in `App.tsx`, but no screen consumes insets yet; Task 5 adds `useSafeAreaInsets` so the controls clear the home indicator. *Alternative rejected:* keeping them at the top to preserve muscle memory. The app has not shipped; there is no muscle memory to preserve.

**D3 — Keep Oswald-Bold as the display face; do not bundle Oswald-SemiBold.**
The canvas loads Oswald at weights 500 and 600 and uses 600 for `.display` and `.obtitle`. The app bundles Regular/Medium/Bold, so 600 has no exact face. Bundling a fourth Oswald static adds ~50 KB per platform and needs registration in the Android assets dir, `Info.plist`'s `UIAppFonts` **and** iOS Xcode project membership — which the P6 plan already flagged as a fiddly manual step. At 34–40 px uppercase the 600→700 difference is barely perceptible. *Alternative rejected:* bundling `Oswald-SemiBold.ttf` for exactness. Recorded as an accepted delta, not an oversight. Weight 500 (`.stitle`) maps to the already-bundled `Oswald-Medium` exactly.

**D4 — Realise the canvas's washes and glows with RN 0.87's `backgroundImage` and `boxShadow`, not a library.**
Verified against the installed typings (`node_modules/react-native/Libraries/StyleSheet/StyleSheetTypes.d.ts`): `boxShadow`, `filter` and `backgroundImage` — including `radial-gradient` — are all present in this version's `ViewStyle`, and the project runs the New Architecture (`android/gradle.properties:35`). So `radial-gradient(circle at 50% 42%, …)` and the TX ring's `0 0 110px 14px` glow transfer literally. *Alternative rejected:* adding `react-native-svg` or approximating with stacked translucent views. Both are strictly worse now that the platform does it.

**D5 — Map the canvas's `.btn solid` / `.btn ghost` onto `ActionButton`'s existing `tone` prop rather than renaming it.**
`tone="primary"` becomes the canvas's solid key (ink background, `#0c0e10` label) and `tone="default"` becomes the ghost key (1 px `--line2` border, ink label). `tone="danger"` has no canvas equivalent and stays a ghost key with a danger-coloured border, used only by the error state. This keeps every existing call site compiling. *Alternative rejected:* renaming the prop to `variant: 'solid' | 'ghost'`, which would touch nine call sites for no behavioural gain.

**D6 — Replace `PulseDot` at its two call sites but keep the component.**
The canvas has no pulsing dot on the searching screen or the pairing scan; it has the `.pingset` — three expanding rings around a static centre dot. `PingRings` (Task 4) takes over both. `PulseDot` survives because the canvas *does* use a pulsing element for the pairing "still scanning" row (`.scandot.pulse`) and the peer dot's glow, and `__tests__/ui-primitives.test.tsx` covers it. *Alternative rejected:* deleting `PulseDot` outright.

## Conflicts and blocked items

**C1 — The off state has its own background.** `.phone.off { background: #070809 }` is darker than the normal chassis `#0b0d0f`. The spec's prose says nothing about this. Treated as intentional (dead air reads as deader) and implemented as a distinct `colors.backgroundOff` token. This matters mechanically too: `PowerKey` fakes the ring's gap by painting a chassis-coloured notch over it, so the hero variant must be told which background it is sitting on. Task 2 adds a `notchColor` prop for exactly this.

**C2 — The canvas's phone chrome is not app UI.** Every frame draws a `.sbar` with `14:32` and a battery glyph, and a 390×844 rounded `.phone` body. That is the mock's simulated device, not something to build — the real OS status bar occupies that space. Ignore `.sbar`, `.batt`, `.phone`'s border/radius/shadow, `.frame`, `.flabel` and `.canvasnote` throughout.

**C3 — BLOCKED: the pairing "saved" screen shows data the contract does not publish.** `design/03 Pairing.dc.html` renders a binding card with `service 0x1812`, `characteristic 0x2A4D` and `press / release 0x01 / 0x00`. Those fields exist on `BlePttBinding` (`src/ptt/ptt.types.ts:7-14`) but `RadioState.pttButton` (`src/radio/radio.types.ts:17-21`) publishes only `configured`, `connected` and `name?`. Per §6.4, a fact a screen needs that the contract does not carry means **the contract is extended, not reached around** — and contract changes are out of this plan's scope. Task 8 therefore renders the card with the device name only and leaves the three GATT rows out. **Report this rather than working around it;** extending `PttButtonState` is a separate, model-owning change.

**C4 — `BackgroundStep` has no canvas frame.** `src/screens/BackgroundStep.tsx` (the Android background-location step added in P7) postdates the canvas. Task 9 restyles it to match the onboarding chrome so it does not look foreign, but its layout is this plan's decision, not the canvas's.

**C5 — Onboarding copy diverges in substance, not just wording.** The canvas's permission bodies are privacy-first ("Nothing is recorded — the air is never stored"); the app's are mechanical ("Oru uses the microphone to transmit your voice to nearby devices"). The canvas copy is better and is adopted in Task 10. The canvas has no Skip control; the app's Skip is behaviour required by the permission flow and stays.

## File Structure

**Created**

| File | Responsibility |
|---|---|
| `src/ui/StateRing.tsx` | The canvas's central `.ring` — one circle, four tones (idle / tx / rx / learning), children centred inside |
| `src/ui/LevelBars.tsx` | The five animated `.bars` shown inside the ring while transmitting or receiving |
| `src/ui/PingRings.tsx` | The `.pingset` — three outward-expanding rings around a static centre dot, for searching and pairing scan |
| `src/ui/PeerRow.tsx` | The `.peer` header row — glowing green dot plus nearby count |
| `src/ui/StepDots.tsx` | The onboarding `.obdots` progress indicator |
| `src/ui/PermissionMark.tsx` | The four onboarding `.obmark` glyphs (microphone, bluetooth, nearby, done) |
| `__tests__/ui-state-ring.test.tsx` | Covers `StateRing` and `LevelBars` |
| `__tests__/ui-ping-rings.test.tsx` | Covers `PingRings` and `PeerRow` |

**Modified**

| File | Change |
|---|---|
| `src/ui/theme.ts` | Retuned to canvas values; new colour, type, size and motion tokens |
| `src/ui/PowerKey.tsx` | Canvas geometry and colour; `notchColor` prop |
| `src/ui/ActionButton.tsx` | Canvas `.btn` solid/ghost keys |
| `src/ui/ScreenFrame.tsx` | Canvas `.shead` chrome — chevron back, Oswald title |
| `src/screens/RadioScreen.tsx` | Canvas layout: peer row, state ring, gradient washes, bottom corner controls |
| `src/screens/SettingsScreen.tsx` | Canvas card layout, two-up button row, version footer |
| `src/screens/PairingFlow.tsx` | Canvas's four steps with device rows and the amber learn ring |
| `src/screens/OnboardingFlow.tsx` | Canvas dots, marks and footer |
| `src/screens/BackgroundStep.tsx` | Restyled to match onboarding chrome (C4) |
| `src/locales/{en,ru}/messages.po` | Regenerated after the copy change in Task 10 |
| `__tests__/theme-and-fonts.test.ts` | Asserts the canvas colours |
| `__tests__/ui-primitives.test.tsx` | Power key geometry |

---

### Task 1: Retune the design tokens to the canvas

Everything downstream reads these values, so they land first. This task also renames one token (`colors.off` → `colors.deadAir`) and updates its two call sites in the same commit, so the tree compiles.

**Files:**
- Modify: `src/ui/theme.ts`
- Modify: `src/screens/RadioScreen.tsx:215` (the `deadAir` style only)
- Test: `__tests__/theme-and-fonts.test.ts:16-43`

**Interfaces:**
- Consumes: nothing.
- Produces: `colors` (adds `backgroundOff`, `hairlineRaised`, `textFaint`, `textGhost`, `deadAir`, `txBorder`, `txGlow`, `txHint`, `rxGlow`; removes `off`, `txWash`, `rxWash`), `washes.{tx,rx}`, `glows.{peer,tx,rx,ok}`, `sizes`, retuned `type`, `radii`, `spacing.gutter`, `motion`.

- [ ] **Step 1: Write the failing test**

Replace the `theme tokens — spec section 12.1` describe block in `__tests__/theme-and-fonts.test.ts` with:

```ts
import {
  colors,
  fonts,
  glows,
  motion,
  radii,
  sizes,
  spacing,
  testIds,
  type,
  washes,
} from '../src/ui/theme';

describe('theme tokens — design/theme.css', () => {
  it('carries the canvas chassis greys', () => {
    expect(colors.background).toBe('#0b0d0f');
    expect(colors.backgroundOff).toBe('#070809');
    expect(colors.surface).toBe('#13161a');
    expect(colors.hairline).toBe('#242b32');
    expect(colors.hairlineRaised).toBe('#2e363e');
    expect(colors.text).toBe('#f2f4f2');
    expect(colors.textMuted).toBe('#8b959d');
    expect(colors.textFaint).toBe('#57626c');
  });

  it('carries the canvas status colors, converted from oklch', () => {
    expect(colors.tx).toBe('#ed413b');
    expect(colors.rx).toBe('#35c26d');
    expect(colors.learning).toBe('#eba941');
  });

  it('washes the transmitting and receiving screens with radial gradients', () => {
    expect(washes.tx).toBe(
      'radial-gradient(circle at 50% 42%, #2a0e11 0%, #150608 78%)',
    );
    expect(washes.rx).toBe(
      'radial-gradient(circle at 50% 42%, #0f2318 0%, #060f09 78%)',
    );
  });

  it('states the canvas glows as boxShadow strings', () => {
    expect(glows.tx).toContain('110px');
    expect(glows.rx).toContain('90px');
    expect(glows.peer).toContain('14px');
  });

  it('names only bundled font faces', () => {
    Object.values(fonts).forEach(family => {
      expect(FONT_FILES).toContain(`${family}.ttf`);
    });
  });

  it('never pairs a bundled family with a synthesised weight', () => {
    Object.values(type).forEach(style => {
      expect(style).not.toHaveProperty('fontWeight');
      expect(FONT_FILES).toContain(`${style.fontFamily}.ttf`);
    });
  });

  it('exposes the canvas geometry the screens use', () => {
    expect(sizes.ring).toBe(302);
    expect(sizes.ringLearning).toBe(272);
    expect(sizes.pingSet).toBe(230);
    expect(sizes.cornerControl).toBe(56);
    expect(spacing.md).toBe(16);
    expect(spacing.gutter).toBe(22);
    expect(radii.md).toBe(14);
    expect(radii.lg).toBe(18);
    expect(radii.pill).toBeGreaterThan(100);
    expect(motion.powerHoldMs).toBe(1200);
    expect(motion.recededOpacity).toBe(0.34);
    expect(testIds.pttArea).toBe('ptt-area');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest __tests__/theme-and-fonts.test.ts`
Expected: FAIL — `washes`, `glows` and `sizes` are not exported from `../src/ui/theme`.

- [ ] **Step 3: Write the implementation**

Rewrite `src/ui/theme.ts`'s token blocks. Keep the file's existing doc-comment style; every value below is read off `design/theme.css` and the per-screen `<style>` blocks.

```ts
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
  /**
   * No canvas equivalent -- the canvas has no raised surface, only filled and
   * outlined keys. Retained ONLY so `ActionButton` keeps compiling until Task 6
   * rewrites it; Task 6 deletes this token. Do not reach for it in new code.
   */
  surfaceRaised: '#13161a',
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
```

Leave `testIds` and `chassis` exactly as they are; `chassis.screen` still reads `colors.background`.

Then update the one renamed usage in `src/screens/RadioScreen.tsx:215`:

```ts
  deadAir: {color: colors.deadAir},
```

- [ ] **Step 4: Run the whole suite**

Run: `npx tsc --noEmit && npx jest`
Expected: PASS. Any other failure is a screen that read a token this task removed (`colors.off`, `colors.txWash`, `colors.rxWash`); fix it by pointing at the replacement, not by re-adding the token. `RadioScreen`'s `txWash`/`rxWash` styles are rebuilt in Task 5 — until then, point them at `colors.surface` so the tree compiles and the five states stay distinct.

The three call sites in `src/ui/ActionButton.tsx:64-66` read `colors.surfaceRaised`, which is why that token survives this task rather than being deleted with the rest. Leave them alone here; Task 6 rewrites that stylesheet and drops the token with it.

- [ ] **Step 5: Commit**

```bash
git add src/ui/theme.ts src/screens/RadioScreen.tsx __tests__/theme-and-fonts.test.ts
git commit -m "feat(ui): retune the design tokens to the exported canvas"
```

---

### Task 2: Rebuild the power key to the canvas geometry

The app's key is already the right idea — a broken ring with a bar through the gap, drawn from plain views. The canvas fixes its proportions, its colour and its two sizes.

**Files:**
- Modify: `src/ui/PowerKey.tsx`
- Test: `__tests__/ui-primitives.test.tsx`

**Interfaces:**
- Consumes: `sizes.powerKeyHero`, `sizes.powerKeyCorner`, `colors.textFaint`, `colors.backgroundOff`, `colors.background` from Task 1.
- Produces: `PowerKeyProps` gains `notchColor?: string` (defaults to `colors.background`). `variant`, `onActivate`, `holdToConfirm`, `disabled`, `accessibilityLabel`, `testID` are unchanged.

- [ ] **Step 1: Write the failing test**

Append to `__tests__/ui-primitives.test.tsx`:

```tsx
import {colors, sizes} from '../src/ui/theme';

describe('PowerKey — design/01 Radio.dc.html', () => {
  it('draws the hero key at the canvas size in the faint chassis colour', async () => {
    const screen = await renderScreen(
      <PowerKey
        variant="hero"
        onActivate={jest.fn()}
        accessibilityLabel="Turn the radio on"
        testID="power-key"
      />,
    );

    const flat = JSON.stringify(screen.find('power-key').props.style);
    expect(flat).toContain(String(sizes.powerKeyHero));
    expect(flat).toContain(colors.textFaint.slice(1));

    screen.unmount();
  });

  it('paints the notch in the background it is told it sits on', async () => {
    const screen = await renderScreen(
      <PowerKey
        variant="hero"
        notchColor={colors.backgroundOff}
        onActivate={jest.fn()}
        accessibilityLabel="Turn the radio on"
        testID="power-key"
      />,
    );

    expect(JSON.stringify(screen.find('power-key-notch').props.style)).toContain(
      colors.backgroundOff.slice(1),
    );

    screen.unmount();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest __tests__/ui-primitives.test.tsx -t "design/01 Radio"`
Expected: FAIL — no node with testID `power-key-notch`, and the hero box is still 128.

- [ ] **Step 3: Write the implementation**

In `src/ui/PowerKey.tsx`, replace the `SIZES` table and the colour choices. The canvas's `.pwrmark` is `--s` square with `--b` thickness and a stem `s * 0.66` tall starting at `s * -0.16`; the ring's gap is the 40° break `conic-gradient(from 20deg, … 320deg)` leaves at the top, which the notch view fakes.

```ts
import {colors, motion, radii, sizes} from './theme';

const SIZES = {
  hero: {
    box: sizes.powerKeyHero,
    border: 5,
    bar: 5,
    barHeight: Math.round(sizes.powerKeyHero * 0.66),
    notch: Math.round(sizes.powerKeyHero * 0.34),
  },
  corner: {
    box: sizes.powerKeyCorner,
    border: 2,
    bar: 2,
    barHeight: Math.round(sizes.powerKeyCorner * 0.66),
    notch: Math.round(sizes.powerKeyCorner * 0.34),
  },
} as const;
```

Add the prop and default:

```ts
export type PowerKeyProps = {
  variant: 'hero' | 'corner';
  onActivate: () => void;
  holdToConfirm?: boolean;
  disabled?: boolean;
  /**
   * The colour the ring's gap is painted in. The notch has to match whatever
   * the key is sitting on, and the canvas gives the `off` screen its own,
   * darker chassis (`.phone.off`), so the hero variant is told rather than
   * assuming.
   */
  notchColor?: string;
  accessibilityLabel: string;
  testID?: string;
};
```

In the component signature add `notchColor = colors.background`, and change the three colour choices from `colors.text` to `colors.textFaint` (the canvas's `.pwr { color: var(--faint) }` and `.pwrmark.big { color: var(--faint) }`):

```tsx
              borderColor: holding ? colors.tx : colors.textFaint,
```

```tsx
        <View
          testID="power-key-notch"
          style={[
            styles.notch,
            {
              width: size.notch,
              height: size.border * 2,
              backgroundColor: notchColor,
              top: -size.border / 2,
            },
          ]}
        />
```

```tsx
              backgroundColor: holding ? colors.tx : colors.textFaint,
```

Also update the corner variant's `hitSlop` so the 21 pt mark still hits the canvas's 56 pt target:

```tsx
        hitSlop={variant === 'corner' ? (sizes.cornerControl - SIZES.corner.box) / 2 : 0}
```

- [ ] **Step 4: Run the tests**

Run: `npx tsc --noEmit && npx jest __tests__/ui-primitives.test.tsx __tests__/radio-screen.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui/PowerKey.tsx __tests__/ui-primitives.test.tsx
git commit -m "feat(ui): rebuild the power key to the canvas geometry"
```

---

### Task 3: Add the state ring and the level bars

**Files:**
- Create: `src/ui/StateRing.tsx`
- Create: `src/ui/LevelBars.tsx`
- Create: `__tests__/ui-state-ring.test.tsx`

**Interfaces:**
- Consumes: `colors`, `glows`, `sizes`, `motion`, `spacing` from Task 1; `reducedMotion` from `src/ui/reducedMotion`.
- Produces:
  - `StateRing({tone, children, testID}: {tone: 'idle' | 'tx' | 'rx' | 'learning'; children: React.ReactNode; testID?: string})`
  - `LevelBars({color, testID}: {color: string; testID?: string})`

- [ ] **Step 1: Write the failing test**

Create `__tests__/ui-state-ring.test.tsx`:

```tsx
import React from 'react';

import {renderScreen} from '../jest/renderScreen';
import {LevelBars} from '../src/ui/LevelBars';
import {StateRing} from '../src/ui/StateRing';
import {colors, sizes} from '../src/ui/theme';

describe('StateRing — design/01 Radio.dc.html', () => {
  it('is the canvas circle at rest', async () => {
    const screen = await renderScreen(
      <StateRing tone="idle" testID="ring">
        <></>
      </StateRing>,
    );

    const flat = JSON.stringify(screen.find('ring').props.style);
    expect(flat).toContain(String(sizes.ring));
    expect(flat).toContain(colors.hairlineRaised.slice(1));

    screen.unmount();
  });

  it('fills and glows while transmitting', async () => {
    const screen = await renderScreen(
      <StateRing tone="tx" testID="ring">
        <></>
      </StateRing>,
    );

    const flat = JSON.stringify(screen.find('ring').props.style);
    expect(flat).toContain(colors.tx.slice(1));
    expect(flat).toContain('110px');

    screen.unmount();
  });

  it('outlines and glows while receiving, without filling', async () => {
    const screen = await renderScreen(
      <StateRing tone="rx" testID="ring">
        <></>
      </StateRing>,
    );

    const flat = JSON.stringify(screen.find('ring').props.style);
    expect(flat).toContain(colors.rx.slice(1));
    expect(flat).toContain('90px');
    expect(flat).not.toContain(`"backgroundColor":"${colors.rx}"`);

    screen.unmount();
  });

  it('is the smaller amber ring while learning a button', async () => {
    const screen = await renderScreen(
      <StateRing tone="learning" testID="ring">
        <></>
      </StateRing>,
    );

    const flat = JSON.stringify(screen.find('ring').props.style);
    expect(flat).toContain(String(sizes.ringLearning));
    expect(flat).toContain(colors.learning.slice(1));

    screen.unmount();
  });
});

describe('LevelBars — design/01 Radio.dc.html', () => {
  it('draws the canvas five bars', async () => {
    const screen = await renderScreen(
      <LevelBars color={colors.text} testID="bars" />,
    );

    expect(screen.findAll('bars-bar')).toHaveLength(5);

    screen.unmount();
  });

  it('holds the bars still when the platform asks for reduced motion', async () => {
    const still = await renderScreen(
      <LevelBars color={colors.text} testID="bars" />,
      {reducedMotion: true},
    );
    const stillStyle = JSON.stringify(still.find('bars-bar').props.style);

    const moving = await renderScreen(
      <LevelBars color={colors.text} testID="bars" />,
      {reducedMotion: false},
    );
    const movingStyle = JSON.stringify(moving.find('bars-bar').props.style);

    expect(stillStyle).not.toBe(movingStyle);

    still.unmount();
    moving.unmount();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest __tests__/ui-state-ring.test.tsx`
Expected: FAIL — cannot resolve `../src/ui/StateRing`.

- [ ] **Step 3: Write the implementation**

Create `src/ui/StateRing.tsx`:

```tsx
import React from 'react';
import {StyleSheet, View} from 'react-native';

import {colors, glows, sizes, spacing} from './theme';

/**
 * The canvas's central `.ring` (`design/01 Radio.dc.html`, and `.learnring` in
 * `design/03 Pairing.dc.html`) -- one circle whose border, fill and glow carry
 * the state, with the state's own copy centred inside it.
 *
 * The glows are RN `boxShadow` strings, supported natively from React Native
 * 0.76 on the New Architecture; `design/theme.css` states them in CSS and they
 * transfer literally.
 */
export type StateRingTone = 'idle' | 'tx' | 'rx' | 'learning';

export function StateRing({
  tone,
  children,
  testID,
}: {
  tone: StateRingTone;
  children: React.ReactNode;
  testID?: string;
}) {
  const size = tone === 'learning' ? sizes.ringLearning : sizes.ring;

  return (
    <View
      testID={testID}
      style={[
        styles.ring,
        {width: size, height: size, borderRadius: size / 2},
        tone === 'idle' && styles.idle,
        tone === 'tx' && styles.tx,
        tone === 'rx' && styles.rx,
        tone === 'learning' && styles.learning,
      ]}>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  ring: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.gutter,
    paddingHorizontal: spacing.lg,
  },
  idle: {borderWidth: 2, borderColor: colors.hairlineRaised},
  tx: {
    borderWidth: 2,
    borderColor: colors.txBorder,
    backgroundColor: colors.tx,
    boxShadow: glows.tx,
  },
  rx: {borderWidth: 3, borderColor: colors.rx, boxShadow: glows.rx},
  learning: {borderWidth: 2, borderColor: colors.learning},
});
```

Create `src/ui/LevelBars.tsx`:

```tsx
import React, {useEffect, useRef} from 'react';
import {Animated, StyleSheet, View} from 'react-native';
import {reatomComponent} from '@reatom/react';

import {motion, radii} from './theme';
import {reducedMotion} from './reducedMotion';

/** `.bars span` heights, in canvas order. */
const HEIGHTS = [12, 24, 34, 18, 27] as const;
const ROW_HEIGHT = 34;
/** `@keyframes lvl` scales between these two. */
const MIN_SCALE = 0.45;

/**
 * The canvas's `.bars` -- five bars breathing inside the ring while the radio
 * is transmitting or receiving.
 *
 * CSS anchors the scale at the bar's foot with `transform-origin: bottom`,
 * which React Native has no equivalent for: it always scales about the centre.
 * Translating by half the height the scale removes puts the foot back where CSS
 * would have left it, which is what the `translateY` below is for.
 */
export const LevelBars = reatomComponent<{color: string; testID?: string}>(
  ({color, testID}) => {
    const still = reducedMotion();
    const scales = useRef(HEIGHTS.map(() => new Animated.Value(1))).current;

    useEffect(() => {
      if (still) return;

      const loops = scales.map((scale, index) =>
        Animated.loop(
          Animated.sequence([
            Animated.delay(index * motion.levelStaggerMs),
            Animated.timing(scale, {
              toValue: MIN_SCALE,
              duration: motion.levelMs / 2,
              useNativeDriver: true,
            }),
            Animated.timing(scale, {
              toValue: 1,
              duration: motion.levelMs / 2,
              useNativeDriver: true,
            }),
          ]),
        ),
      );
      loops.forEach(loop => loop.start());

      return () => loops.forEach(loop => loop.stop());
    }, [still, scales]);

    return (
      <View testID={testID} style={styles.row}>
        {HEIGHTS.map((height, index) => (
          <Animated.View
            key={height}
            testID="bars-bar"
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            style={[
              styles.bar,
              {
                height,
                backgroundColor: color,
                transform: still
                  ? []
                  : [
                      {
                        translateY: scales[index].interpolate({
                          inputRange: [MIN_SCALE, 1],
                          outputRange: [(height * (1 - MIN_SCALE)) / 2, 0],
                        }),
                      },
                      {scaleY: scales[index]},
                    ],
              },
            ]}
          />
        ))}
      </View>
    );
  },
  'LevelBars',
);

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 6,
    height: ROW_HEIGHT,
  },
  bar: {width: 5, borderRadius: radii.sm},
});
```

- [ ] **Step 4: Run the tests**

Run: `npx tsc --noEmit && npx jest __tests__/ui-state-ring.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui/StateRing.tsx src/ui/LevelBars.tsx __tests__/ui-state-ring.test.tsx
git commit -m "feat(ui): add the canvas state ring and level bars"
```

---

### Task 4: Add the ping rings and the peer row

**Files:**
- Create: `src/ui/PingRings.tsx`
- Create: `src/ui/PeerRow.tsx`
- Create: `__tests__/ui-ping-rings.test.tsx`

**Interfaces:**
- Consumes: `colors`, `glows`, `sizes`, `motion`, `type` from Task 1; `reducedMotion`.
- Produces:
  - `PingRings({size, testID}: {size?: 'default' | 'small'; testID?: string})`
  - `PeerRow({label, testID}: {label: React.ReactNode; testID?: string})`

- [ ] **Step 1: Write the failing test**

Create `__tests__/ui-ping-rings.test.tsx`:

```tsx
import React from 'react';
import {Text} from 'react-native';

import {renderScreen} from '../jest/renderScreen';
import {PeerRow} from '../src/ui/PeerRow';
import {PingRings} from '../src/ui/PingRings';
import {sizes} from '../src/ui/theme';

describe('PingRings — design/01 Radio.dc.html', () => {
  it('draws three rings around a centre dot', async () => {
    const screen = await renderScreen(<PingRings testID="pings" />);

    expect(screen.findAll('pings-ring')).toHaveLength(3);
    expect(screen.findAll('pings-dot')).toHaveLength(1);

    screen.unmount();
  });

  it('uses the canvas small set for the pairing scan', async () => {
    const screen = await renderScreen(
      <PingRings size="small" testID="pings" />,
    );

    expect(JSON.stringify(screen.find('pings').props.style)).toContain(
      String(sizes.pingSetSmall),
    );

    screen.unmount();
  });

  it('holds the rings at their static scales under reduced motion', async () => {
    const still = await renderScreen(<PingRings testID="pings" />, {
      reducedMotion: true,
    });
    const stillStyle = JSON.stringify(still.find('pings-ring').props.style);

    const moving = await renderScreen(<PingRings testID="pings" />, {
      reducedMotion: false,
    });
    const movingStyle = JSON.stringify(moving.find('pings-ring').props.style);

    expect(stillStyle).not.toBe(movingStyle);

    still.unmount();
    moving.unmount();
  });
});

describe('PeerRow — design/01 Radio.dc.html', () => {
  it('shows the nearby label beside a glowing dot', async () => {
    const screen = await renderScreen(
      <PeerRow label={<Text>2 nearby</Text>} testID="peer" />,
    );

    expect(screen.hasText('2 nearby')).toBe(true);
    expect(JSON.stringify(screen.find('peer-dot').props.style)).toContain(
      '14px',
    );

    screen.unmount();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest __tests__/ui-ping-rings.test.tsx`
Expected: FAIL — cannot resolve `../src/ui/PingRings`.

- [ ] **Step 3: Write the implementation**

Create `src/ui/PingRings.tsx`:

```tsx
import React, {useEffect, useRef} from 'react';
import {Animated, StyleSheet, View} from 'react-native';
import {reatomComponent} from '@reatom/react';

import {colors, motion, sizes} from './theme';
import {reducedMotion} from './reducedMotion';

/**
 * The canvas's `.pingset` -- three rings travelling outward from a static
 * centre dot, used by the radio screen's `searching` state and by the pairing
 * scan (`design/03 Pairing.dc.html` uses the `.sm` variant).
 *
 * `@keyframes ping` runs scale 0.25 -> 1 while opacity falls 0.85 -> 0, on a
 * 3s cycle with the three rings 1s apart. Under reduced motion the canvas
 * falls back to the three static scales its stylesheet declares -- 0.35, 0.65
 * and 0.95 at opacity 0.3 -- rather than freezing all three on top of one
 * another.
 */
const STATIC_SCALES = [0.35, 0.65, 0.95] as const;
const STATIC_OPACITY = 0.3;

export const PingRings = reatomComponent<{
  size?: 'default' | 'small';
  testID?: string;
}>(({size = 'default', testID}) => {
  const still = reducedMotion();
  const box = size === 'small' ? sizes.pingSetSmall : sizes.pingSet;
  const progress = useRef(STATIC_SCALES.map(() => new Animated.Value(0))).current;

  useEffect(() => {
    if (still) return;

    const loops = progress.map((value, index) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(index * motion.pingStaggerMs),
          Animated.timing(value, {
            toValue: 1,
            duration: motion.pingMs,
            useNativeDriver: true,
          }),
        ]),
      ),
    );
    loops.forEach(loop => loop.start());

    return () => loops.forEach(loop => loop.stop());
  }, [still, progress]);

  return (
    <View testID={testID} style={[styles.set, {width: box, height: box}]}>
      {STATIC_SCALES.map((staticScale, index) => (
        <Animated.View
          key={staticScale}
          testID={testID === undefined ? undefined : `${testID}-ring`}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={[
            styles.ring,
            {borderRadius: box / 2},
            still
              ? {opacity: STATIC_OPACITY, transform: [{scale: staticScale}]}
              : {
                  opacity: progress[index].interpolate({
                    inputRange: [0, 0.7, 1],
                    outputRange: [0.85, 0.25, 0],
                  }),
                  transform: [
                    {
                      scale: progress[index].interpolate({
                        inputRange: [0, 1],
                        outputRange: [0.25, 1],
                      }),
                    },
                  ],
                },
          ]}
        />
      ))}
      <View
        testID={testID === undefined ? undefined : `${testID}-dot`}
        style={styles.dot}
      />
    </View>
  );
}, 'PingRings');

const styles = StyleSheet.create({
  set: {alignItems: 'center', justifyContent: 'center'},
  ring: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    borderWidth: 1,
    borderColor: colors.textFaint,
  },
  dot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: colors.text,
  },
});
```

Create `src/ui/PeerRow.tsx`:

```tsx
import React from 'react';
import {StyleSheet, Text, View} from 'react-native';

import {colors, glows, sizes, type} from './theme';

/**
 * The canvas's `.peer` header row: a glowing green dot and the nearby count,
 * held at a fixed height so the ring below it does not shift between the states
 * that show the row and the ones that leave it empty.
 */
export function PeerRow({
  label,
  testID,
}: {
  label?: React.ReactNode;
  testID?: string;
}) {
  return (
    <View testID={testID} style={styles.row}>
      {label === undefined ? null : (
        <>
          <View
            testID={testID === undefined ? undefined : `${testID}-dot`}
            style={styles.dot}
          />
          <Text style={[type.peer, styles.label]}>{label}</Text>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    height: sizes.peerRow,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
  },
  dot: {
    width: 9,
    height: 9,
    borderRadius: 4.5,
    backgroundColor: colors.rx,
    boxShadow: glows.peer,
  },
  label: {color: colors.textMuted},
});
```

- [ ] **Step 4: Run the tests**

Run: `npx tsc --noEmit && npx jest __tests__/ui-ping-rings.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui/PingRings.tsx src/ui/PeerRow.tsx __tests__/ui-ping-rings.test.tsx
git commit -m "feat(ui): add the canvas ping rings and peer row"
```

---

### Task 5: Restructure the radio screen onto the canvas layout

The largest task. The canvas's main screen is a peer row, a central ring and two bottom corner controls; the app currently centres bare text with the controls at the top. Copy is left exactly as it is — Task 10 owns copy.

**Files:**
- Modify: `src/screens/RadioScreen.tsx`
- Test: `__tests__/radio-screen.test.tsx`, `__tests__/stage2-acceptance.test.tsx` (both should pass unchanged; see Step 4)

**Interfaces:**
- Consumes: `StateRing`, `LevelBars` (Task 3), `PingRings`, `PeerRow` (Task 4), `PowerKey`'s `notchColor` (Task 2), `washes`, `glows`, `sizes`, `spacing` (Task 1), `useSafeAreaInsets` from `react-native-safe-area-context`.
- Produces: no new exports. `testIds` used are unchanged: `radioScreen`, `radioStateLabel`, `pttArea`, `powerOnArea`, `powerKey`, `settingsGear`, plus the existing `corner-controls`.

- [ ] **Step 1: Write the failing test**

Append to `__tests__/radio-screen.test.tsx`:

```tsx
import {sizes, washes} from '../src/ui/theme';

describe('RadioScreen — design/01 Radio.dc.html', () => {
  it('sits the corner controls at the foot of the screen', async () => {
    const screen = await renderScreen(
      <RadioScreen onSettingsPress={jest.fn()} />,
      {scenario: 'happy'},
    );
    await screen.press(testIds.powerOnArea);

    const style = JSON.stringify(screen.find('corner-controls').props.style);
    expect(style).toContain('bottom');
    expect(style).not.toContain('"top"');

    screen.unmount();
  });

  it('shows the ping rings while searching and the ring once ready', async () => {
    const screen = await renderScreen(
      <RadioScreen onSettingsPress={jest.fn()} />,
      {scenario: 'happy'},
    );

    await screen.press(testIds.powerOnArea);
    expect(screen.findAll('radio-pings')).toHaveLength(1);
    expect(screen.findAll('radio-ring')).toHaveLength(0);

    await screen.advance(2100);
    expect(screen.findAll('radio-ring')).toHaveLength(1);
    expect(screen.findAll('radio-pings')).toHaveLength(0);

    screen.unmount();
  });

  it('washes the screen with the canvas gradient while transmitting', async () => {
    const screen = await renderScreen(
      <RadioScreen onSettingsPress={jest.fn()} />,
      {scenario: 'happy'},
    );

    await screen.press(testIds.powerOnArea);
    await screen.advance(2100);
    await screen.pressIn(testIds.pttArea);

    expect(JSON.stringify(screen.find(testIds.radioScreen).props.style)).toContain(
      washes.tx,
    );
    expect(screen.findAll('radio-bars')).toHaveLength(1);

    screen.unmount();
  });

  it('moves the nearby count out of the headline and into the peer row', async () => {
    const screen = await renderScreen(
      <RadioScreen onSettingsPress={jest.fn()} />,
      {scenario: 'happy'},
    );

    await screen.press(testIds.powerOnArea);
    await screen.advance(2100);

    expect(screen.findAll('radio-peer')).toHaveLength(1);
    expect(screen.find(testIds.radioStateLabel).props.testID).toBe(
      testIds.radioStateLabel,
    );
    expect(screen.hasText('HOLD TO TALK')).toBe(true);

    screen.unmount();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest __tests__/radio-screen.test.tsx -t "design/01 Radio"`
Expected: FAIL — no node with testID `radio-pings`; `corner-controls` still carries `top`.

- [ ] **Step 3: Write the implementation**

Rewrite the body of `src/screens/RadioScreen.tsx`. The `off` branch first — note it uses its own chassis and passes that colour down to the key's notch (Conflict C1):

```tsx
import {useSafeAreaInsets} from 'react-native-safe-area-context';

import {LevelBars} from '../ui/LevelBars';
import {PeerRow} from '../ui/PeerRow';
import {PingRings} from '../ui/PingRings';
import {StateRing} from '../ui/StateRing';
import {
  chassis,
  colors,
  glows,
  motion,
  sizes,
  spacing,
  testIds,
  type,
  washes,
} from '../ui/theme';
```

```tsx
    const insets = useSafeAreaInsets();
    const cornerStyle = {
      bottom: insets.bottom + spacing.gutter,
      left: spacing.gutter,
      right: spacing.gutter,
    };

    if (state === 'off') {
      const startRadio = wrap(() => {
        void radio.start();
      });

      return (
        <View testID={testIds.radioScreen} style={[chassis.screen, styles.offChassis]}>
          <Pressable
            testID={testIds.powerOnArea}
            accessibilityRole="button"
            accessibilityLabel={t`Turn the radio on`}
            onPress={startRadio}
            style={styles.fill}>
            <PeerRow />
            <View style={styles.stage}>
              <PowerKey
                variant="hero"
                notchColor={colors.backgroundOff}
                onActivate={startRadio}
                accessibilityLabel={t`Turn the radio on`}
                testID={testIds.powerKey}
              />
              <View style={styles.offCopy}>
                <Text
                  testID={testIds.radioStateLabel}
                  style={[type.state, styles.headline, styles.deadAir]}>
                  <Trans>RADIO OFF</Trans>
                </Text>
                <Text style={[type.subhint, styles.hint]}>
                  <Trans>TAP TO TURN ON</Trans>
                </Text>
              </View>
            </View>
          </Pressable>
          <View style={[styles.gearOnly, cornerStyle]}>
            <GearButton
              onPress={onSettingsPress}
              accessibilityLabel={t`Settings`}
              testID={testIds.settingsGear}
            />
          </View>
        </View>
      );
    }
```

Then the live branch. The peer row appears from `ready` onward, the ring replaces the centred text, and the wash is a gradient rather than a border:

```tsx
    const live = state === 'transmitting' || state === 'receiving';
    const wash =
      state === 'transmitting'
        ? styles.txWash
        : state === 'receiving'
          ? styles.rxWash
          : null;

    return (
      <View testID={testIds.radioScreen} style={[chassis.screen, wash]}>
        <Pressable
          testID={testIds.pttArea}
          accessibilityRole="button"
          accessibilityLabel={t`Push to talk`}
          onPressIn={wrap(() => {
            void radio.pressPtt();
          })}
          onPressOut={wrap(() => {
            void radio.releasePtt();
          })}
          style={styles.fill}>
          <PeerRow
            testID={state === 'searching' ? undefined : 'radio-peer'}
            label={
              state === 'searching' ? undefined : (
                <Trans>{radio().nearbyCount} nearby</Trans>
              )
            }
          />

          <View style={styles.stage}>
            {state === 'searching' ? (
              <>
                <PingRings testID="radio-pings" />
                <Text
                  testID={testIds.radioStateLabel}
                  style={[type.scan, styles.hint]}>
                  <Trans>SEARCHING FOR DEVICES...</Trans>
                </Text>
              </>
            ) : null}

            {state === 'ready' ? (
              <StateRing tone="idle" testID="radio-ring">
                <Text
                  testID={testIds.radioStateLabel}
                  style={[type.hero, styles.headline]}>
                  <Trans>HOLD TO TALK</Trans>
                </Text>
              </StateRing>
            ) : null}

            {state === 'transmitting' ? (
              <>
                <StateRing tone="tx" testID="radio-ring">
                  <Text
                    testID={testIds.radioStateLabel}
                    style={[type.state, styles.onTx]}>
                    <Trans>TRANSMITTING...</Trans>
                  </Text>
                  <LevelBars color={colors.text} testID="radio-bars" />
                </StateRing>
                <Text style={[type.subhint, styles.txHint]}>
                  <Trans>RELEASE TO FINISH</Trans>
                </Text>
              </>
            ) : null}

            {state === 'receiving' ? (
              <StateRing tone="rx" testID="radio-ring">
                <Text
                  testID={testIds.radioStateLabel}
                  style={[type.state, styles.rxText]}>
                  <Trans>RECEIVING...</Trans>
                </Text>
                <LevelBars color={colors.rx} testID="radio-bars" />
              </StateRing>
            ) : null}
          </View>
        </Pressable>

        <View
          testID="corner-controls"
          pointerEvents={live ? 'none' : 'auto'}
          style={[styles.corners, cornerStyle, live && styles.receded]}>
          <GearButton
            onPress={onSettingsPress}
            accessibilityLabel={t`Settings`}
            testID={testIds.settingsGear}
          />
          <PowerKey
            variant="corner"
            holdToConfirm
            onActivate={wrap(() => {
              void radio.stop();
            })}
            accessibilityLabel={t`Hold to turn the radio off`}
            testID={testIds.powerKey}
          />
        </View>
      </View>
    );
```

Note the child order in `corner-controls`: gear first, power key second, so `justifyContent: 'space-between'` puts the gear on the left and the key on the right — decision D2.

And the stylesheet:

```ts
const styles = StyleSheet.create({
  fill: {flex: 1},
  offChassis: {backgroundColor: colors.backgroundOff},
  stage: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xl,
    paddingBottom: spacing.xl,
  },
  offCopy: {alignItems: 'center', gap: spacing.md},
  headline: {color: colors.text, textAlign: 'center'},
  hint: {color: colors.textFaint, textAlign: 'center'},
  deadAir: {color: colors.deadAir},
  txWash: {backgroundImage: washes.tx},
  rxWash: {backgroundImage: washes.rx},
  onTx: {color: '#ffffff', textAlign: 'center'},
  txHint: {color: colors.txHint, textAlign: 'center'},
  rxText: {color: colors.rx, textAlign: 'center'},
  errorWash: {borderWidth: 3, borderColor: colors.danger},
  errorText: {color: colors.danger},
  corners: {
    position: 'absolute',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  gearOnly: {position: 'absolute', alignItems: 'flex-start'},
  receded: {opacity: motion.recededOpacity},
  centre: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.lg,
    padding: spacing.xl,
  },
});
```

`styles.centre` is kept because `RadioErrorState` still uses it.

The canvas's `.onTx` white is the one literal colour in this file — `.ringtx { color: #ffffff }` is the only place the canvas uses pure white, and it is a property of the filled red ring rather than a theme-wide token. If a reviewer objects, add `colors.onTx: '#ffffff'` to the theme; do not leave it inline in more than this one place.

- [ ] **Step 4: Run the whole suite**

Run: `npx tsc --noEmit && npx jest`
Expected: PASS, including `__tests__/stage2-acceptance.test.tsx` unchanged.

Two things to check rather than assume if that acceptance test goes red:
- It asserts the five states have **distinct style signatures**, built from the screen's style plus the headline's style array. `searching` and `ready` now differ by `type.scan` vs `type.hero` and by their hint colour, and `transmitting`/`receiving` differ by their washes — so the signature stays 5-way distinct. If it does not, do **not** weaken the assertion; find which two states collapsed and give the canvas's own difference back to them.
- It drives `testIds.powerOnArea` and `testIds.powerKey`. Both still exist and are unmoved.

- [ ] **Step 5: Commit**

```bash
git add src/screens/RadioScreen.tsx __tests__/radio-screen.test.tsx
git commit -m "feat(ui): restructure the radio screen onto the canvas layout"
```

---

### Task 6: Reshape the shared chrome — buttons and screen frame

**Files:**
- Modify: `src/ui/ActionButton.tsx`
- Modify: `src/ui/ScreenFrame.tsx`
- Test: `__tests__/ui-primitives.test.tsx`

**Interfaces:**
- Consumes: `sizes.button`, `radii.md`, `type.button`, `type.title`, `colors.hairlineRaised`, `colors.textInverse` from Task 1.
- Produces: `ActionButton`'s props are unchanged (decision D5). `ScreenFrame` gains nothing; its back control becomes a chevron `Pressable` rather than an `ActionButton`.

- [ ] **Step 1: Write the failing test**

Append to `__tests__/ui-primitives.test.tsx`:

```tsx
describe('ActionButton — design/theme.css .btn', () => {
  it('draws the solid key at the canvas height', async () => {
    const screen = await renderScreen(
      <ActionButton label="Connect" tone="primary" onPress={jest.fn()} testID="key" />,
    );

    const flat = JSON.stringify(screen.find('key').props.style);
    expect(flat).toContain(String(sizes.button));
    expect(flat).toContain(colors.text.slice(1));

    screen.unmount();
  });

  it('draws the ghost key as an outline', async () => {
    const screen = await renderScreen(
      <ActionButton label="Test" onPress={jest.fn()} testID="key" />,
    );

    const flat = JSON.stringify(screen.find('key').props.style);
    expect(flat).toContain(colors.hairlineRaised.slice(1));
    expect(flat).not.toContain(`"backgroundColor":"${colors.text}"`);

    screen.unmount();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest __tests__/ui-primitives.test.tsx -t "design/theme.css"`
Expected: FAIL — the key is still `minHeight: 48` with a `surfaceRaised` background.

- [ ] **Step 3: Write the implementation**

Replace `ActionButton`'s stylesheet and label style. The canvas's `.btn` is a 54 pt key with a 14 pt radius; `.solid` fills with ink and inverts the label, `.ghost` is a 1 pt `--line2` outline.

```tsx
      <Text style={[type.button, tone === 'primary' ? styles.labelSolid : styles.label]}>
        {label}
      </Text>
```

```ts
const styles = StyleSheet.create({
  key: {
    height: sizes.button,
    paddingHorizontal: spacing.lg,
    borderRadius: radii.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  /** `.btn.ghost` */
  neutral: {borderWidth: 1, borderColor: colors.hairlineRaised},
  /** `.btn.solid` */
  primary: {backgroundColor: colors.text},
  /** No canvas equivalent -- a ghost key in the danger colour (decision D5). */
  danger: {borderWidth: 1, borderColor: colors.danger},
  pressed: {opacity: 0.7},
  disabled: {opacity: 0.4},
  label: {color: colors.text},
  labelSolid: {color: colors.textInverse},
});
```

Then `ScreenFrame`. The canvas's `.shead` is a chevron and an Oswald title on the same line, with no rule beneath and no button:

```tsx
      {title === undefined && onBack === undefined ? null : (
        <View style={styles.bar}>
          {onBack === undefined || backLabel === undefined ? null : (
            <Pressable
              testID={backTestID}
              accessibilityRole="button"
              accessibilityLabel={backLabel}
              onPress={onBack}
              hitSlop={12}
              style={styles.back}>
              <Text style={styles.backGlyph}>←</Text>
            </Pressable>
          )}
          {title === undefined ? null : (
            <Text style={[type.title, styles.title]}>{title}</Text>
          )}
        </View>
      )}
```

```ts
const styles = StyleSheet.create({
  bar: {
    paddingHorizontal: 26,
    paddingTop: spacing.gutter,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  back: {width: 32},
  backGlyph: {fontSize: 22, color: colors.textMuted},
  title: {color: colors.text},
  body: {flex: 1},
});
```

`ScreenFrame` no longer imports `ActionButton`; drop that import. `styles.body` loses its padding because the canvas's cards carry their own gutter — the screens in Tasks 7–9 supply it.

Finally, delete `colors.surfaceRaised` from `src/ui/theme.ts`. Task 1 kept it alive only for the three `ActionButton` call sites this task has just rewritten, and it has no canvas equivalent. `npx tsc --noEmit` is what proves nothing else still reads it.

- [ ] **Step 4: Run the whole suite**

Run: `npx tsc --noEmit && npx jest`
Expected: PASS. `__tests__/settings-screen.test.tsx` and `__tests__/pairing-flow.test.tsx` address the back control by `testID`, which is preserved, so they should not need changes. If either asserted on the back control's *label text*, update it to the chevron.

- [ ] **Step 5: Commit**

```bash
git add src/ui/theme.ts src/ui/ActionButton.tsx src/ui/ScreenFrame.tsx __tests__/ui-primitives.test.tsx
git commit -m "feat(ui): reshape the shared button and screen chrome to the canvas"
```

---

### Task 7: Rebuild the settings screen as the canvas card

**Files:**
- Modify: `src/screens/SettingsScreen.tsx`
- Test: `__tests__/settings-screen.test.tsx`

**Interfaces:**
- Consumes: `PeerRow`'s dot styling is *not* reused here; the canvas's `.devrow` has its own. Uses `radii.lg`, `spacing.gutter`, `type.devName`, `type.caption`, `type.version`, `colors.surface`, `colors.hairline` from Task 1.
- Produces: no new exports. Adds `testIds.settingsVersion` — append to the `testIds` map in `theme.ts`.

- [ ] **Step 1: Write the failing test**

Append to `__tests__/settings-screen.test.tsx`:

```tsx
describe('SettingsScreen — design/02 Settings.dc.html', () => {
  it('puts the button in a card with a two-up action row', async () => {
    const screen = await renderScreen(
      <SettingsScreen onBack={jest.fn()} onConnectPress={jest.fn()} />,
      {scenario: 'happy'},
    );
    await screen.act(() => radio.start());

    expect(screen.findAll('settings-card')).toHaveLength(1);
    expect(screen.findAll(testIds.pttTest)).toHaveLength(1);
    expect(screen.findAll(testIds.pttReplace)).toHaveLength(1);

    screen.unmount();
  });

  it('explains the button and shows a version footer when nothing is paired', async () => {
    const screen = await renderScreen(
      <SettingsScreen onBack={jest.fn()} onConnectPress={jest.fn()} />,
    );

    expect(screen.hasText('without taking the phone out')).toBe(true);
    expect(screen.findAll(testIds.settingsVersion)).toHaveLength(1);

    screen.unmount();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest __tests__/settings-screen.test.tsx -t "design/02 Settings"`
Expected: FAIL — no node with testID `settings-card`; the explanatory note does not exist.

- [ ] **Step 3: Write the implementation**

Add to `testIds` in `src/ui/theme.ts`:

```ts
  settingsVersion: 'settings-version',
```

Then rewrite `SettingsScreen`'s body. The canvas's configured state is a green-dotted device row above a two-up ghost-button row; the unconfigured state is a muted name, an explanatory note and one solid key.

```tsx
      <Text style={[type.label, styles.sectionLabel]}>
        <Trans>PTT BUTTON</Trans>
      </Text>

      <View testID="settings-card" style={styles.card}>
        {button.configured ? (
          <>
            <View style={styles.deviceRow}>
              <View style={styles.dot} />
              <View style={styles.deviceText}>
                <Text style={[type.devName, styles.name]}>{button.name}</Text>
                <Text
                  testID={testIds.pttStatus}
                  style={[
                    type.caption,
                    button.connected ? styles.connected : styles.disconnected,
                  ]}>
                  {button.connected ? (
                    <Trans>Connected</Trans>
                  ) : (
                    <Trans>Disconnected</Trans>
                  )}
                </Text>
              </View>
            </View>
            <View style={styles.actions}>
              <View style={styles.action}>
                <ActionButton
                  label={t`Test`}
                  accessibilityLabel={t`Hold to transmit`}
                  onPressIn={wrap(() => {
                    void radio.pressPtt();
                  })}
                  onPressOut={wrap(() => {
                    void radio.releasePtt();
                  })}
                  testID={testIds.pttTest}
                />
              </View>
              <View style={styles.action}>
                <ActionButton
                  label={t`Replace`}
                  onPress={onConnectPress}
                  testID={testIds.pttReplace}
                />
              </View>
            </View>
          </>
        ) : (
          <>
            <Text
              testID={testIds.pttStatus}
              style={[type.devName, styles.disconnected]}>
              <Trans>Not connected</Trans>
            </Text>
            <Text style={[type.caption, styles.note]}>
              <Trans>
                An external button lets you talk without taking the phone out of
                your pocket.
              </Trans>
            </Text>
            <View style={styles.connect}>
              <ActionButton
                label={t`Connect`}
                tone="primary"
                onPress={onConnectPress}
                testID={testIds.pttConnect}
              />
            </View>
          </>
        )}
      </View>

      <Text testID={testIds.settingsVersion} style={[type.version, styles.version]}>
        OFFLINE NEARBY PTT · V0.1
      </Text>
```

The version string is deliberately **not** wrapped in `Trans`: it is a product identifier, and the canvas shows the same literal in both locales.

```ts
const styles = StyleSheet.create({
  sectionLabel: {
    paddingTop: 34,
    paddingHorizontal: 28,
    paddingBottom: 12,
    color: colors.textFaint,
  },
  card: {
    marginHorizontal: spacing.gutter,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.hairline,
    borderRadius: radii.lg,
    paddingVertical: spacing.lg,
    paddingHorizontal: spacing.gutter,
  },
  deviceRow: {flexDirection: 'row', alignItems: 'flex-start', gap: 14},
  dot: {
    width: 9,
    height: 9,
    borderRadius: 4.5,
    marginTop: spacing.sm,
    backgroundColor: colors.rx,
    boxShadow: glows.peer,
  },
  deviceText: {flex: 1},
  name: {color: colors.text},
  connected: {color: colors.rx, marginTop: 5},
  disconnected: {color: colors.textMuted, marginTop: 5},
  note: {marginTop: spacing.md, color: colors.textFaint},
  actions: {flexDirection: 'row', gap: 12, marginTop: spacing.gutter},
  action: {flex: 1},
  connect: {marginTop: spacing.gutter},
  version: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: spacing.lg,
    textAlign: 'center',
    color: colors.textGhost,
  },
});
```

- [ ] **Step 4: Run the tests**

Run: `npx tsc --noEmit && npx jest __tests__/settings-screen.test.tsx __tests__/navigation.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui/theme.ts src/screens/SettingsScreen.tsx __tests__/settings-screen.test.tsx
git commit -m "feat(ui): rebuild the settings screen as the canvas card"
```

---

### Task 8: Rebuild the pairing flow onto the canvas's four steps

**Files:**
- Modify: `src/screens/PairingFlow.tsx`
- Test: `__tests__/pairing-flow.test.tsx`

**Interfaces:**
- Consumes: `PingRings` (`size="small"`), `StateRing` (`tone="learning"`), `PulseDot` (the `.scandot`), `radii.row`, `sizes.tick`, `glows.ok` from earlier tasks.
- Produces: no new exports.

- [ ] **Step 1: Write the failing test**

Append to `__tests__/pairing-flow.test.tsx`:

```tsx
describe('PairingFlow — design/03 Pairing.dc.html', () => {
  it('scans behind the small ping set', async () => {
    const screen = await renderScreen(<PairingFlow onClose={jest.fn()} />, {
      scenario: 'happy',
    });

    expect(screen.findAll('pairing-pings')).toHaveLength(1);

    screen.unmount();
  });

  it('learns inside the amber ring', async () => {
    const screen = await renderScreen(<PairingFlow onClose={jest.fn()} />, {
      scenario: 'happy',
    });
    await screen.advance(1200);
    await screen.press(`${testIds.pairingCandidate}-ble-1`);

    expect(screen.findAll('pairing-ring')).toHaveLength(1);

    screen.unmount();
  });

  it('confirms with the canvas tick', async () => {
    const screen = await renderScreen(<PairingFlow onClose={jest.fn()} />, {
      scenario: 'happy',
    });
    await screen.advance(1200);
    await screen.press(`${testIds.pairingCandidate}-ble-1`);
    await screen.advance(3000);

    expect(screen.findAll('pairing-tick')).toHaveLength(1);
    expect(screen.findAll(testIds.pairingDone)).toHaveLength(1);

    screen.unmount();
  });
});
```

Before running, confirm the candidate id `ble-1` and the two `advance` durations against `src/radio/radio.mock.scripts.ts` and the existing assertions in this file; use whatever the existing passing tests already use rather than the placeholders above.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest __tests__/pairing-flow.test.tsx -t "design/03 Pairing"`
Expected: FAIL — no node with testID `pairing-pings`.

- [ ] **Step 3: Write the implementation**

Replace each step's body in `src/screens/PairingFlow.tsx`. The scanning step drops `PulseDot` for the small ping set; the picking step gains the canvas's `.scanrow` and device rows; learning moves into the amber ring; saved gains the tick.

```tsx
        {step === 'scanning' ? (
          <View style={styles.stage}>
            <PingRings size="small" testID="pairing-pings" />
            <Text style={[type.scan, styles.scanText]}>
              <Trans>SCANNING FOR BLE DEVICES...</Trans>
            </Text>
            <Text style={[type.caption, styles.scanHint]}>
              <Trans>
                Make sure the button is turned on and close to the phone.
              </Trans>
            </Text>
          </View>
        ) : null}

        {step === 'picking' ? (
          <View>
            <View style={styles.scanRow}>
              <PulseDot active color={colors.learning} size={8} />
              <Text style={[type.label, styles.scanRowLabel]}>
                <Trans>still scanning</Trans>
              </Text>
            </View>
            <Text style={[type.label, styles.sectionLabel]}>
              <Trans>Found</Trans>
            </Text>
            {candidates.map(candidate => (
              <Pressable
                key={candidate.deviceId}
                testID={`${testIds.pairingCandidate}-${candidate.deviceId}`}
                accessibilityRole="button"
                accessibilityLabel={candidate.name}
                onPress={wrap(() => {
                  void pickPttCandidate(candidate.deviceId);
                })}
                style={styles.row}>
                <View>
                  <Text style={[type.devName, styles.rowName]}>
                    {candidate.name}
                  </Text>
                  <Text style={[type.caption, styles.rowMeta]}>
                    <Trans>BLE · {candidate.rssi} dBm</Trans>
                  </Text>
                </View>
                <Text style={styles.chevron}>›</Text>
              </Pressable>
            ))}
          </View>
        ) : null}

        {step === 'learning' ? (
          <View style={styles.stage}>
            <StateRing tone="learning" testID="pairing-ring">
              <Text style={[type.state, styles.learning]}>
                <Trans>PRESS THE PTT BUTTON</Trans>
              </Text>
            </StateRing>
            <Text style={[type.caption, styles.learnSub]}>
              <Trans>Listening for a signal from {buttonName}...</Trans>
            </Text>
          </View>
        ) : null}

        {step === 'saved' ? (
          <View style={styles.stage}>
            <View testID="pairing-tick" style={styles.tick}>
              <View style={styles.tickMark} />
            </View>
            <Text style={[type.state, styles.saved]}>
              <Trans>BUTTON CONNECTED</Trans>
            </Text>
            <View style={styles.bindCard}>
              <View style={styles.bindRow}>
                <Text style={[type.caption, styles.bindKey]}>
                  <Trans>device</Trans>
                </Text>
                <Text style={[type.caption, styles.bindValue]}>{buttonName}</Text>
              </View>
            </View>
            <ActionButton
              label={t`Done`}
              tone="primary"
              onPress={close}
              testID={testIds.pairingDone}
            />
          </View>
        ) : null}
```

The bind card carries **one** row, not the canvas's four: the GATT service, characteristic and press/release values are not on `RadioState.pttButton` and reaching for them would breach §6.4. See Conflict C3 — report it, do not work around it.

The tick is the canvas's `.oktick`: a bordered circle with a rotated, two-sided box for the check.

```ts
  tick: {
    width: sizes.tick,
    height: sizes.tick,
    borderRadius: sizes.tick / 2,
    borderWidth: 2,
    borderColor: colors.rx,
    boxShadow: glows.ok,
  },
  tickMark: {
    position: 'absolute',
    left: 26,
    top: 30,
    width: 40,
    height: 20,
    borderLeftWidth: 3,
    borderBottomWidth: 3,
    borderColor: colors.rx,
    transform: [{rotate: '-45deg'}],
  },
  stage: {flex: 1, alignItems: 'center', justifyContent: 'center', gap: 30},
  scanText: {color: colors.textMuted, textAlign: 'center'},
  scanHint: {color: colors.textFaint, textAlign: 'center', paddingHorizontal: 40},
  scanRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingTop: 30,
    paddingHorizontal: 28,
  },
  scanRowLabel: {color: colors.textFaint},
  sectionLabel: {
    paddingTop: 34,
    paddingHorizontal: 28,
    paddingBottom: 12,
    color: colors.textFaint,
  },
  row: {
    marginHorizontal: spacing.gutter,
    marginBottom: 12,
    paddingVertical: 20,
    paddingHorizontal: spacing.gutter,
    borderWidth: 1,
    borderColor: colors.hairline,
    borderRadius: radii.row,
    backgroundColor: colors.surface,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  rowName: {color: colors.text},
  rowMeta: {color: colors.textFaint},
  chevron: {fontSize: 20, color: colors.textFaint},
  learning: {color: colors.learning, textAlign: 'center'},
  learnSub: {color: colors.textMuted, textAlign: 'center', maxWidth: 300},
  saved: {color: colors.text, textAlign: 'center'},
  bindCard: {
    width: sizes.ring,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.hairline,
    borderRadius: radii.lg,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.gutter,
  },
  bindRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: spacing.sm,
  },
  bindKey: {color: colors.textFaint},
  bindValue: {color: colors.text},
```

Keep the `failed` step exactly as it is — the canvas has no failure frame, and the empty/retry path is behaviour this plan does not touch.

- [ ] **Step 4: Run the tests**

Run: `npx tsc --noEmit && npx jest __tests__/pairing-flow.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/screens/PairingFlow.tsx __tests__/pairing-flow.test.tsx
git commit -m "feat(ui): rebuild the pairing flow onto the canvas steps"
```

---

### Task 9: Rebuild onboarding onto the canvas steps

**Files:**
- Create: `src/ui/StepDots.tsx`
- Create: `src/ui/PermissionMark.tsx`
- Modify: `src/screens/OnboardingFlow.tsx`
- Modify: `src/screens/BackgroundStep.tsx`
- Test: `__tests__/onboarding-flow.test.tsx`, `__tests__/background-step.test.tsx`

**Interfaces:**
- Consumes: `sizes.mark`, `sizes.tickLarge`, `glows.okLarge`, `type.hero`, `type.label`, `type.body` from Task 1.
- Produces:
  - `StepDots({total, current, testID}: {total: number; current: number; testID?: string})` — `current` is zero-based; dots before it render `done`, the dot at it renders `on`.
  - `PermissionMark({kind}: {kind: 'microphone' | 'bluetooth' | 'nearbyDevices' | 'done'})`

- [ ] **Step 1: Write the failing test**

Append to `__tests__/onboarding-flow.test.tsx`:

```tsx
describe('OnboardingFlow — design/04 Onboarding.dc.html', () => {
  it('shows three progress dots and a mark for each permission', async () => {
    const screen = await renderScreen(<OnboardingFlow onDone={jest.fn()} />);

    expect(screen.findAll('step-dot')).toHaveLength(3);
    expect(screen.findAll('permission-mark')).toHaveLength(1);

    screen.unmount();
  });

  it('marks passed steps as done', async () => {
    const screen = await renderScreen(<OnboardingFlow onDone={jest.fn()} />);
    await screen.press(testIds.onboardingAllow);

    const dots = screen.findAll('step-dot');
    expect(JSON.stringify(dots[0].props.style)).toContain(
      colors.rx.slice(1),
    );

    screen.unmount();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest __tests__/onboarding-flow.test.tsx -t "design/04 Onboarding"`
Expected: FAIL — no node with testID `step-dot`.

- [ ] **Step 3: Write the implementation**

Create `src/ui/StepDots.tsx`:

```tsx
import React from 'react';
import {StyleSheet, View} from 'react-native';

import {colors} from './theme';

/** The canvas's `.obdots`: done dots go green, the current dot goes ink. */
export function StepDots({
  total,
  current,
  testID,
}: {
  total: number;
  current: number;
  testID?: string;
}) {
  return (
    <View testID={testID} style={styles.row}>
      {Array.from({length: total}, (_, index) => (
        <View
          key={index}
          testID="step-dot"
          style={[
            styles.dot,
            index < current && styles.done,
            index === current && styles.on,
          ]}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {flexDirection: 'row', justifyContent: 'center', gap: 8, paddingTop: 28},
  dot: {width: 6, height: 6, borderRadius: 3, backgroundColor: colors.hairlineRaised},
  on: {backgroundColor: colors.text},
  done: {backgroundColor: colors.rx},
});
```

Create `src/ui/PermissionMark.tsx` with the canvas's four glyphs — the microphone capsule, the rotated Bluetooth square, the concentric nearby rings and the large done tick:

```tsx
import React from 'react';
import {StyleSheet, View} from 'react-native';

import {colors, glows, sizes} from './theme';

/** The canvas's `.obmark` glyphs (`design/04 Onboarding.dc.html`). */
export function PermissionMark({
  kind,
}: {
  kind: 'microphone' | 'bluetooth' | 'nearbyDevices' | 'done';
}) {
  return (
    <View testID="permission-mark" style={styles.box}>
      {kind === 'microphone' ? (
        <View style={styles.micColumn}>
          <View style={styles.micCap} />
          <View style={styles.micStem} />
          <View style={styles.micBase} />
        </View>
      ) : null}

      {kind === 'bluetooth' ? <View style={styles.bt} /> : null}

      {kind === 'nearbyDevices' ? (
        <>
          <View style={[styles.circle, styles.circle1]} />
          <View style={[styles.circle, styles.circle2]} />
          <View style={[styles.circle, styles.circle3]} />
          <View style={styles.nearbyDot} />
        </>
      ) : null}

      {kind === 'done' ? (
        <View style={styles.tick}>
          <View style={styles.tickMark} />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  box: {
    width: sizes.mark,
    height: sizes.mark,
    alignItems: 'center',
    justifyContent: 'center',
  },
  micColumn: {alignItems: 'center'},
  micCap: {width: 56, height: 88, borderRadius: 28, borderWidth: 2.5, borderColor: colors.text},
  micStem: {width: 2.5, height: 18, backgroundColor: colors.textFaint},
  micBase: {width: 34, height: 2.5, backgroundColor: colors.textFaint},
  bt: {
    width: 76,
    height: 76,
    borderRadius: 10,
    borderWidth: 2.5,
    borderColor: colors.text,
    transform: [{rotate: '45deg'}],
  },
  circle: {position: 'absolute', borderRadius: sizes.mark / 2, borderWidth: 1.5},
  circle1: {top: 0, left: 0, right: 0, bottom: 0, borderColor: colors.hairlineRaised},
  circle2: {top: 30, left: 30, right: 30, bottom: 30, borderColor: colors.textFaint},
  circle3: {top: 60, left: 60, right: 60, bottom: 60, borderColor: colors.textMuted},
  nearbyDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: colors.rx,
    boxShadow: glows.peer,
  },
  tick: {
    width: sizes.tickLarge,
    height: sizes.tickLarge,
    borderRadius: sizes.tickLarge / 2,
    borderWidth: 2.5,
    borderColor: colors.rx,
    boxShadow: glows.okLarge,
  },
  tickMark: {
    position: 'absolute',
    left: 34,
    top: 40,
    width: 56,
    height: 28,
    borderLeftWidth: 3.5,
    borderBottomWidth: 3.5,
    borderColor: colors.rx,
    transform: [{rotate: '-45deg'}],
  },
});
```

Then restructure `OnboardingFlow`'s two returns onto dots / mark / footer. The canvas's footer is a step label, a 40 pt Oswald title, a body and one solid key; the app's Skip and denied/blocked messages stay because they are behaviour, not decoration (C5).

```tsx
      <ScreenFrame testID={testIds.onboardingScreen}>
        <StepDots total={APP_PERMISSIONS.length} current={step - 1} />
        <View style={styles.mark}>
          <PermissionMark kind={permission ?? 'microphone'} />
        </View>
        <View style={styles.foot}>
          <Text style={[type.label, styles.step]}>
            <Trans>
              STEP {step} OF {APP_PERMISSIONS.length}
            </Trans>
          </Text>
          <Text style={[type.hero, styles.title]}>{copy.title}</Text>
          <Text style={[type.body, styles.body]}>{copy.body}</Text>
          {/* denied / blocked warnings and the action buttons, unchanged */}
        </View>
      </ScreenFrame>
```

```ts
const styles = StyleSheet.create({
  mark: {flex: 1, alignItems: 'center', justifyContent: 'center'},
  foot: {paddingHorizontal: 26, paddingBottom: 30, gap: 18},
  step: {color: colors.textFaint},
  title: {color: colors.text},
  body: {color: colors.textMuted, maxWidth: 320},
  warning: {color: colors.learning},
  actions: {gap: spacing.md, alignSelf: 'stretch'},
});
```

Note the canvas left-aligns the onboarding footer; the app currently centres it. Follow the canvas — drop the `textAlign: 'center'` from `title` and `body`.

Finally, give `BackgroundStep` the same `foot`/`mark` chrome so it does not read as a foreign screen (C4). It has no canvas frame, so reuse `PermissionMark kind="nearbyDevices"` and the same footer styles rather than inventing a new glyph.

- [ ] **Step 4: Run the tests**

Run: `npx tsc --noEmit && npx jest __tests__/onboarding-flow.test.tsx __tests__/background-step.test.tsx __tests__/sequencing.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui/StepDots.tsx src/ui/PermissionMark.tsx src/screens/OnboardingFlow.tsx src/screens/BackgroundStep.tsx __tests__/onboarding-flow.test.tsx
git commit -m "feat(ui): rebuild onboarding onto the canvas steps"
```

---

### Task 10: Reconcile the copy with the canvas

The main-screen copy already matches the canvas almost exactly — `RADIO OFF`, `TAP TO TURN ON`, `SEARCHING FOR DEVICES...`, `HOLD TO TALK`, `TRANSMITTING...`, `RELEASE TO FINISH`, `RECEIVING...` and their Russian translations are identical modulo the canvas's line breaks. What diverges is the settings section label, the onboarding bodies and the pairing strings.

**Files:**
- Modify: `src/screens/OnboardingFlow.tsx` (the `copy` map and the done screen)
- Modify: `src/screens/SettingsScreen.tsx` (section label)
- Modify: `src/locales/en/messages.po`, `src/locales/ru/messages.po` (regenerated)
- Test: `__tests__/locale-coverage.test.ts`, `__tests__/stage2-acceptance.test.tsx`

**Interfaces:**
- Consumes: nothing new.
- Produces: nothing new.

- [ ] **Step 1: Apply the copy changes**

| Where | From | To (canvas) |
|---|---|---|
| Settings section | `PTT BUTTON` / `КНОПКА PTT` | `PTT button` / `PTT-кнопка` |
| Microphone body | "Oru uses the microphone to transmit your voice to nearby devices." | "Your voice is transmitted only while the button is held. Nothing is recorded — the air is never stored." |
| Bluetooth body | "Oru connects to your push-to-talk button over Bluetooth, including while the screen is locked." | "Connects nearby phones and pairs the external PTT button. No internet involved." |
| Nearby body | "Oru finds other radios around you without using the internet." | "Phones find each other and connect directly — no servers, no accounts. On iOS this is the “Local Network” permission." |
| Done title | `Ready` | `All set` |
| Done body | "Turn the radio on and hold anywhere to talk." | "Whoever is nearby is connected — and hears you. Lock the phone and put it in your pocket." |
| Done action | `Start` | `Go on air` |
| Onboarding step | `Step {step} of {0}` | `STEP {step} OF {0}` |

The Russian side is already written in the canvas; take it verbatim from the `ru` block of `design/04 Onboarding.dc.html` and `design/02 Settings.dc.html` rather than re-translating.

- [ ] **Step 2: Regenerate the catalogs**

Run: `npm run lingui:extract`
Then fill every new `msgstr` in `src/locales/ru/messages.po` from the canvas's `ru` strings. Leave no empty translation — `__tests__/locale-coverage.test.ts` fails on one.

- [ ] **Step 3: Update the acceptance copy fixtures**

`__tests__/stage2-acceptance.test.tsx` holds a `COPY` map of expected strings per locale (`onboardingReady: 'Готово'` and friends). Update the entries this task changed. Change the expected strings only — do not relax an assertion.

- [ ] **Step 4: Run the whole suite**

Run: `npx tsc --noEmit && npx jest`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/screens src/locales __tests__
git commit -m "feat(i18n): reconcile the app copy with the canvas"
```

---

## Self-Review

**Spec coverage.** Every canvas file maps to at least one task: `theme.css` → Task 1; `01 Radio.dc.html` → Tasks 2–5; `02 Settings.dc.html` → Tasks 6–7; `03 Pairing.dc.html` → Task 8; `04 Onboarding.dc.html` → Task 9; both locales' copy → Task 10. The `.sbar`/`.phone`/`.frame` chrome is deliberately uncovered (C2). The pairing bind card is deliberately partial (C3) and is the one place this plan knowingly does not reach the canvas.

**Placeholder scan.** No task says "TBD", "handle edge cases" or "similar to Task N". Two steps ask the executor to *verify a value against the repo before using it* rather than trusting this plan — the mock candidate id and timings in Task 8's test, and the `COPY` fixture keys in Task 10. Those are deliberate: both depend on fixtures this plan did not read line by line, and guessing them would be worse than saying so.

**Type consistency.** `StateRingTone` is `'idle' | 'tx' | 'rx' | 'learning'` in Task 3 and used with exactly those values in Tasks 5 and 8. `PingRings`'s `size` is `'default' | 'small'` in Task 4 and called with `"small"` in Task 8. `PowerKeyProps.notchColor` is added in Task 2 and passed in Task 5. `StepDots.current` is documented zero-based in Task 9 and called as `step - 1`, where `step` is the existing one-based index. `testIds.settingsVersion` is added in Task 7 and used only there.

**One risk worth naming.** Tasks 3, 4, 7 and 9 put `boxShadow` and Task 5 puts `backgroundImage` into `StyleSheet.create`. These are real RN 0.87 style props, but `react-test-renderer` does not rasterise, so **the suite proves the styles are declared, not that they render**. Nothing in this plan can substitute for opening both platforms and looking. Add that to the Stage 2 acceptance pass before calling the reconciliation done.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-08-18-design-reconciliation.md`. Two execution options:

**1. Subagent-Driven (recommended)** — a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — execute tasks in this session using `superpowers:executing-plans`, batch execution with checkpoints.
