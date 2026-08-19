import React from 'react';
import {StyleSheet} from 'react-native';
import {context} from '@reatom/core';
import type {ReactTestInstance} from 'react-test-renderer';

import {GearButton} from '../src/ui/GearButton';
import {MicMark} from '../src/ui/MicMark';
import {SignalBars, barsForRssi} from '../src/ui/SignalBars';
import {StepDots} from '../src/ui/StepDots';
import {SuccessMark} from '../src/ui/SuccessMark';
import {colors, icon, sizes} from '../src/ui/theme';
import {renderScreen} from '../jest/renderScreen';
import type {RenderedScreen} from '../jest/renderScreen';

jest.useFakeTimers({doNotFake: ['queueMicrotask']});

beforeEach(() => context.reset());

let opened: RenderedScreen[] = [];
afterEach(() => {
  opened.forEach(screen => screen.unmount());
  opened = [];
});

const open = async (element: React.ReactElement) => {
  const screen = await renderScreen(element);
  opened.push(screen);
  return screen;
};

const flat = (node: ReactTestInstance) =>
  (StyleSheet.flatten(node.props.style) ?? {}) as Record<string, unknown>;

/**
 * The HOST node carrying a testID, not the outermost one.
 *
 * `screen.find` keeps the outermost match, which is right when the testID lands
 * on an element written inline in a screen. Here the testID is a PROP of a
 * component under test (`<MicMark testID="mic" />`), so the outermost match is
 * the composite itself, whose props are the ones the test passed in -- no
 * resolved `style`, no accessibility flags. The innermost match is the host
 * element the component actually rendered, which is what these assertions are
 * about.
 */
const hostOf = (screen: RenderedScreen, testID: string) => {
  const matches = screen.root.findAllByProps({testID});
  const host = matches[matches.length - 1];
  if (!host) throw new Error(`no node with testID "${testID}"`);
  return host;
};

const styleOf = (screen: RenderedScreen, testID: string) =>
  flat(hostOf(screen, testID));

/**
 * The icon system of `design/01 Radio.dc.html` frame 14 -- the glyph sheet --
 * and the `.canvasnote icons` rules under the frames. Every figure asserted
 * here is read off that sheet or off the class it resolves in
 * `design/theme.css`; none of it is invented.
 */

describe('MicMark — design/theme.css .micmark, glyph sheet row 1', () => {
  /**
   * "BORDER-BOX, SO EVERY FIGURE IS AN OUTER DIMENSION" -- and React Native's
   * box model is border-box, so the canvas's numbers transcribe directly.
   */
  it('draws the control idiom at the canvas figures: 160 box, 3.5 stroke', async () => {
    const screen = await open(<MicMark idiom="control" testID="mic" />);

    expect(styleOf(screen, 'mic')).toMatchObject({
      width: icon.control,
      height: icon.control,
    });

    // Capsule 60 x 92 at (50, 13), radius 30 -- half its width, a true capsule.
    expect(styleOf(screen, 'mic-capsule')).toMatchObject({
      left: 50,
      top: 13,
      width: 60,
      height: 92,
      borderWidth: icon.controlStroke,
      borderRadius: 30,
    });

    // Cradle 96 x 48 at (32, 81): left/right/bottom borders only, both bottom
    // radii 48 -- the partial-border arc trick, which at height 48 collapses
    // to a pure semicircle.
    expect(styleOf(screen, 'mic-cradle')).toMatchObject({
      left: 32,
      top: 81,
      width: 96,
      height: 48,
      borderWidth: icon.controlStroke,
      borderTopWidth: 0,
      borderBottomLeftRadius: 48,
      borderBottomRightRadius: 48,
    });

    // Stem 3.5 x 14 at (78.25, 129) -- starts exactly at the cradle's foot.
    expect(styleOf(screen, 'mic-stem')).toMatchObject({
      left: 78.25,
      top: 129,
      width: icon.controlStroke,
      height: 14,
    });

    // Base 50 x 3.5 at (55, 143), radius 1.75.
    expect(styleOf(screen, 'mic-base')).toMatchObject({
      left: 55,
      top: 143,
      width: 50,
      height: icon.controlStroke,
      borderRadius: 1.75,
    });
  });

  /**
   * The power-off seal cross-fades this glyph out over the first 15% of the
   * hold, and it does that by handing an `Animated` value down as `opacity`.
   * `radio-hold-seal.test.tsx` proves the screen passes the right value; this
   * proves the glyph puts it on its own root, so the two halves of the
   * cross-fade meet. Without it the seal's assertion would pass against a
   * component that quietly ignored the prop.
   */
  it('wears a passed opacity on its root, for the seal cross-fade', async () => {
    const screen = await open(
      <MicMark idiom="control" testID="mic" opacity={0.25} />,
    );

    // The innermost node carrying the testID is the glyph's own root; the
    // harness's `find` deliberately hands back the outermost, which here is the
    // component element rather than a host node.
    const nodes = screen.root.findAll(node => node.props.testID === 'mic');
    const root = nodes[nodes.length - 1];

    expect(StyleSheet.flatten(root.props.style)).toMatchObject({opacity: 0.25});
  });

  it('leaves opacity alone when none is passed', async () => {
    const screen = await open(<MicMark idiom="control" testID="mic" />);

    const nodes = screen.root.findAll(node => node.props.testID === 'mic');
    const flat = StyleSheet.flatten(nodes[nodes.length - 1].props.style) ?? {};

    expect('opacity' in flat).toBe(false);
  });

  /**
   * "THE SAME FRACTIONS AT 176 / 2.5 ARE THE ONBOARDING PAGE MARK -- ONE GLYPH,
   * TWO IDIOMS, ONLY THE BOX AND THE STROKE CHANGE." Proven as fractions, not
   * as a second table of magic numbers: every part is asserted to be the same
   * proportion of its own box that the control idiom is of 160.
   */
  it('is one glyph at two idioms: every part is the same fraction of the box', async () => {
    const control = await open(<MicMark idiom="control" testID="c" />);
    const page = await open(<MicMark idiom="pagemark" testID="p" />);

    expect(styleOf(page, 'p')).toMatchObject({
      width: icon.hero,
      height: icon.hero,
    });

    const ratio = icon.hero / icon.control;
    const parts = ['capsule', 'cradle', 'stem', 'base'] as const;
    const scaled = (value: unknown) =>
      typeof value === 'number' ? Number((value * ratio).toFixed(4)) : value;

    parts.forEach(part => {
      const from = styleOf(control, `mic-${part}`);
      const to = styleOf(page, `mic-${part}`);
      // Only the box-proportional figures; stroke belongs to the IDIOM and is
      // deliberately NOT scaled with the box (2.5 on 176 is thinner than 3.5
      // on 160 -- "STROKE BELONGS TO THE IDIOM, NOT TO THE GLYPH").
      (['left', 'top'] as const).forEach(key => {
        if (typeof from[key] !== 'number') return;
        // The stem's left carries a -stroke/2 centring offset, so it is the
        // one figure that is not a pure fraction of the box.
        if (part === 'stem' && key === 'left') return;
        expect({part, key, value: Number((to[key] as number).toFixed(4))}).toEqual({
          part,
          key,
          value: scaled(from[key]),
        });
      });
    });

    // The page mark takes the thinner page-mark stroke, not a scaled-up one.
    expect(styleOf(page, 'mic-capsule').borderWidth).toBe(icon.heroStroke);
    expect(styleOf(control, 'mic-capsule').borderWidth).toBe(icon.controlStroke);
    expect(icon.heroStroke).toBeLessThan(icon.controlStroke);
  });

  /**
   * "A READY-STATE GLYPH INSIDE THE TALK RING IS `--ink`, NEVER AN ACCENT" and
   * "MONOCHROME -- ONE COLOUR TOKEN PER GLYPH, `currentColor` EVERYWHERE".
   */
  it('is monochrome ink, and never an accent', async () => {
    const screen = await open(<MicMark idiom="control" testID="mic" />);

    const painted = [
      styleOf(screen, 'mic-capsule').borderColor,
      styleOf(screen, 'mic-cradle').borderColor,
      styleOf(screen, 'mic-stem').backgroundColor,
      styleOf(screen, 'mic-base').backgroundColor,
    ];

    expect(new Set(painted)).toEqual(new Set([colors.text]));
    expect(painted).not.toContain(colors.tx);
    expect(painted).not.toContain(colors.rx);
    expect(painted).not.toContain(colors.seal);
  });

  /**
   * "EVERY DECORATIVE GLYPH IS HIDDEN FROM THE TREE ... OTHERWISE A SCREEN
   * READER WALKS FOUR NAMELESS VIEWS FOR ONE MICROPHONE."
   */
  it('is decorative: hidden from the accessibility tree, and never named', async () => {
    const screen = await open(<MicMark idiom="control" testID="mic" />);
    const node = hostOf(screen, 'mic');

    expect(node.props.accessibilityElementsHidden).toBe(true);
    expect(node.props.importantForAccessibility).toBe('no-hide-descendants');
    expect(node.props.accessibilityLabel).toBeUndefined();
  });
});

describe('SignalBars — design/theme.css .sig, glyph sheet row 3', () => {
  /**
   * "RSSI -> BARS: >= -55 IS FOUR, -55 TO -67 THREE, -67 TO -80 TWO, BELOW -80
   * ONE." The canvas fixes this mapping; the two worked examples on
   * `03 Pairing` are -52 (four bars) and -71 (two bars).
   */
  it.each([
    [-30, 4],
    [-55, 4],
    [-52, 4],
    [-56, 3],
    [-67, 3],
    [-68, 2],
    [-71, 2],
    [-80, 2],
    [-81, 1],
    [-120, 1],
  ])('maps %i dBm to %i bars', (rssi, expected) => {
    expect(barsForRssi(rssi)).toBe(expected);
  });

  it('draws four bars on one baseline at the canvas figures', async () => {
    const screen = await open(<SignalBars rssi={-52} testID="sig" />);

    expect(styleOf(screen, 'sig')).toMatchObject({
      flexDirection: 'row',
      alignItems: 'flex-end',
      gap: 1.5,
      height: 12,
    });

    const heights = [4, 6.5, 9, 11.5];
    heights.forEach((height, index) => {
      expect(styleOf(screen, `sig-bar-${index}`)).toMatchObject({
        width: 2.5,
        height,
        borderRadius: 1.25,
      });
    });
  });

  /** "FILLED `currentColor`, UNFILLED `--line2`." Bars, not strokes. */
  it('fills only as many bars as the reading earns', async () => {
    const screen = await open(
      <SignalBars rssi={-71} color={colors.textFaint} testID="sig" />,
    );

    expect(styleOf(screen, 'sig-bar-0').backgroundColor).toBe(colors.textFaint);
    expect(styleOf(screen, 'sig-bar-1').backgroundColor).toBe(colors.textFaint);
    expect(styleOf(screen, 'sig-bar-2').backgroundColor).toBe(
      colors.hairlineRaised,
    );
    expect(styleOf(screen, 'sig-bar-3').backgroundColor).toBe(
      colors.hairlineRaised,
    );
  });

  it('is decorative: the dBm figure beside it is what a reader announces', async () => {
    const screen = await open(<SignalBars rssi={-52} testID="sig" />);
    const node = hostOf(screen, 'sig');

    expect(node.props.accessibilityElementsHidden).toBe(true);
    expect(node.props.importantForAccessibility).toBe('no-hide-descendants');
  });
});

describe('GearButton — design/theme.css .gearmark, glyph sheet row 2', () => {
  /**
   * "EIGHT TEETH 3 x 6, RADIUS 1, EACH ANCHORED TOP-CENTRE OF A WRAPPER ROTATED
   * K x 45deg ABOUT THE BOX CENTRE -- NO TRIGONOMETRY, NO PER-TOOTH
   * COORDINATES."
   */
  it('builds eight teeth from rotated wrappers, not from coordinates', async () => {
    const screen = await open(
      <GearButton onPress={jest.fn()} accessibilityLabel="Settings" testID="gear" />,
    );

    const wrappers = screen.findAll('gear-tooth');
    expect(wrappers).toHaveLength(8);

    const angles = wrappers.map(node => {
      const transform = flat(node).transform as Array<{rotate: string}>;
      return transform[0].rotate;
    });
    expect(angles).toEqual([
      '0deg',
      '45deg',
      '90deg',
      '135deg',
      '180deg',
      '225deg',
      '270deg',
      '315deg',
    ]);

    // Every wrapper fills the 24 box, so the rotation is about the box centre.
    wrappers.forEach(node => {
      expect(flat(node)).toMatchObject({
        position: 'absolute',
        width: icon.chrome,
        height: icon.chrome,
      });
    });

    // Each tooth is anchored top-centre of its own wrapper: 3 x 6 at radius 1.
    const teeth = screen.findAll('gear-tooth-bar');
    expect(teeth).toHaveLength(8);
    teeth.forEach(node => {
      expect(flat(node)).toMatchObject({
        position: 'absolute',
        top: 0,
        left: (icon.chrome - 3) / 2,
        width: 3,
        height: 6,
        borderRadius: 1,
        backgroundColor: colors.textFaint,
      });
    });
  });

  /** "HUB RING INSET 5 AT 2 STROKE, WHICH THE TEETH OVERLAP BY 1." */
  it('draws the hub as a RING inset 5 at the chrome stroke', async () => {
    const screen = await open(
      <GearButton onPress={jest.fn()} accessibilityLabel="Settings" testID="gear" />,
    );

    const hub = styleOf(screen, 'gear-ring');
    expect(hub).toMatchObject({
      width: icon.chrome - 10,
      height: icon.chrome - 10,
      borderWidth: icon.chromeStroke,
      borderColor: colors.textFaint,
    });
    // A ring, not a disc: nothing is painted inside it.
    expect(hub.backgroundColor).toBeUndefined();
    // The teeth run from y=0 to y=6 and the hub's outer edge is at y=5, so the
    // two overlap by exactly 1 and the shape reads as one piece.
    expect(6 - 5).toBe(1);
  });

  /**
   * "NO PUNCH-OUT: THREE OF THIS SCREEN'S FIVE STATES HAVE A GRADIENT CHASSIS
   * AND A HOLE PAINTED IN THE CHASSIS COLOUR WOULD NOT SURVIVE THERE."
   */
  it('has no punched-out hub painted in the chassis colour', async () => {
    const screen = await open(
      <GearButton onPress={jest.fn()} accessibilityLabel="Settings" testID="gear" />,
    );

    expect(screen.findAll('gear-hub')).toHaveLength(0);
    const painted = JSON.stringify(hostOf(screen, 'gear').props.style);
    expect(painted).not.toContain(colors.background.slice(1));
    expect(painted).not.toContain(colors.backgroundOff.slice(1));
  });
});

describe('StepDots — design/theme.css .obdots, glyph sheet row 5', () => {
  /**
   * "THREE SHAPES, NOT THREE HUES -- THESE DOTS ARE NOW THE ONLY STEP INDICATOR
   * ON THE SCREEN, SO COLOUR ALONE MAY NOT CARRY THEM."
   */
  it('differentiates the three states by SHAPE, not only by hue', async () => {
    const screen = await open(<StepDots total={3} current={1} testID="dots" />);
    const dots = screen.findAll('step-dot').map(flat);

    // done -- a filled 6, green.
    expect(dots[0]).toMatchObject({
      width: 6,
      height: 6,
      borderRadius: 3,
      backgroundColor: colors.rx,
    });
    // current -- an 18 x 6 pill, radius 3, ink.
    expect(dots[1]).toMatchObject({
      width: 18,
      height: 6,
      borderRadius: 3,
      backgroundColor: colors.text,
    });
    // pending -- a HOLLOW 6 ring at 1pt.
    expect(dots[2]).toMatchObject({
      width: 6,
      height: 6,
      borderRadius: 3,
      borderWidth: 1,
      borderColor: colors.hairlineRaised,
    });
    expect(dots[2].backgroundColor).toBeUndefined();

    // The three still read apart with every HUE stripped out: a narrow disc, a
    // wide disc, and a narrow ring.
    const shapes = dots.map(
      dot => `${dot.width}x${dot.height}:${dot.backgroundColor ? 'filled' : 'hollow'}`,
    );
    expect(new Set(shapes).size).toBe(3);
  });

  /**
   * "THE COUNTER'S WORDS MOVE TO THE ROW'S ACCESSIBILITY LABEL; THEY ARE NOT
   * DELETED, ONLY RELOCATED."
   */
  it('carries the deleted counter as the row’s accessible name', async () => {
    const screen = await open(
      <StepDots total={3} current={1} accessibilityLabel="Step 2 of 3" testID="dots" />,
    );
    const row = hostOf(screen, 'dots');

    expect(row.props.accessibilityLabel).toBe('Step 2 of 3');
    expect(row.props.accessibilityRole).toBe('image');
  });

  /** The done frame has no step left to announce -- "the title says it". */
  it('hides itself when there is no step to announce', async () => {
    const screen = await open(<StepDots total={3} current={3} testID="dots" />);
    const row = hostOf(screen, 'dots');

    expect(row.props.accessibilityLabel).toBeUndefined();
    expect(row.props.accessibilityElementsHidden).toBe(true);
    expect(row.props.importantForAccessibility).toBe('no-hide-descendants');
  });
});

describe('SuccessMark — design/theme.css .okbig', () => {
  /** "THE one SUCCESS GLYPH": a 132 circle at 2.5 with the rotated-border tick. */
  it('draws the shared 132 mark, and the tick as two borders rotated -45', async () => {
    const screen = await open(<SuccessMark testID="ok" />);

    expect(styleOf(screen, 'ok')).toMatchObject({
      width: sizes.tickLarge,
      height: sizes.tickLarge,
      borderRadius: sizes.tickLarge / 2,
      borderWidth: icon.heroStroke,
      borderColor: colors.rx,
    });

    expect(styleOf(screen, 'ok-tick')).toMatchObject({
      left: 34,
      top: 40,
      width: 56,
      height: 28,
      borderLeftWidth: 3.5,
      borderBottomWidth: 3.5,
      borderColor: colors.rx,
      transform: [{rotate: '-45deg'}],
    });
  });

  /**
   * "BOTH SCREENS THAT USE IT DELETED THE HEADLINE UNDERNEATH, SO THE WORDS
   * LIVE IN THE ANNOUNCEMENT."
   */
  it('takes the deleted headline as its accessible name where it has one', async () => {
    const named = await open(
      <SuccessMark accessibilityLabel="Button connected" testID="ok" />,
    );
    expect(hostOf(named, 'ok').props.accessibilityLabel).toBe('Button connected');
    expect(hostOf(named, 'ok').props.accessibilityRole).toBe('image');

    const bare = await open(<SuccessMark testID="ok2" />);
    expect(hostOf(bare, 'ok2').props.accessibilityElementsHidden).toBe(true);
    expect(hostOf(bare, 'ok2').props.importantForAccessibility).toBe(
      'no-hide-descendants',
    );
  });
});
