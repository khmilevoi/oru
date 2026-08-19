import React from 'react';
import {Animated, Easing, StyleSheet} from 'react-native';
import {context} from '@reatom/core';
import type {ReactTestInstance} from 'react-test-renderer';

import {RadioScreen} from '../src/screens/RadioScreen';
import {mockRadio} from '../src/radio/radio.native.mock';
import {radio} from '../src/radio/radio.model';
import {HAPTIC_EFFECTS} from '../src/app/haptics';
import {colors, motion, seal, testIds} from '../src/ui/theme';
import {renderScreen} from '../jest/renderScreen';
import type {RenderedScreen, RenderOptions} from '../jest/renderScreen';

jest.useFakeTimers({doNotFake: ['queueMicrotask']});

beforeEach(() => context.reset());

let opened: RenderedScreen[] = [];
afterEach(() => {
  opened.forEach(screen => screen.unmount());
  opened = [];
  jest.restoreAllMocks();
});

/**
 * The power-off hold, drawn across the whole screen as an amber perimeter seal.
 * `design/01 Radio.dc.html` frames 09-13 and their `canvasnote hold` are the
 * contract; this file is that note, executable.
 *
 * The old treatment filled a 3pt bar inside the 56pt corner key -- directly
 * under the thumb doing the holding, so nobody ever saw it. Every assertion
 * below exists because some part of that redesign can regress silently.
 */

/**
 * The frame every test renders against: `__mocks__/reactNativeSafeAreaContext`
 * supplies it, and `renderScreen`'s own `insets` option keeps the same 320x640
 * frame while changing the insets. Written down here rather than imported from
 * the component, so the geometry below is asserted against the canvas's
 * arithmetic and not against whatever the implementation happens to compute.
 */
const FRAME = {width: 320, height: 640};

/** The canvas's rails: the screen minus `--seal-inset` on each side. */
const railsFor = (topInset = 0) => {
  const railW = FRAME.width - seal.inset * 2;
  const railH = FRAME.height - topInset - seal.inset * 2;
  const total = railW + railH;
  return {railW, railH, total, kx: railW / total, ky: railH / total};
};

type Interpolation = {
  _parent: unknown;
  _config: {
    inputRange: number[];
    outputRange: number[] | string[];
    extrapolate?: string;
  };
  __getValue(): number | string;
};

const asInterpolation = (value: unknown): Interpolation => {
  const node = value as Partial<Interpolation>;
  if (!node || typeof node.__getValue !== 'function' || !node._config) {
    throw new Error(`not an Animated interpolation: ${JSON.stringify(value)}`);
  }
  return node as Interpolation;
};

const styleOf = (screen: RenderedScreen, testID: string) =>
  (StyleSheet.flatten(screen.find(testID).props.style) ?? {}) as Record<
    string,
    unknown
  >;

/** The rails, by the axis each one grows along. */
const RAILS = {
  bottom: {id: 'seal-rail-bottom', extent: 'width'},
  left: {id: 'seal-rail-left', extent: 'height'},
  right: {id: 'seal-rail-right', extent: 'height'},
  top: {id: 'seal-rail-top', extent: 'width'},
} as const;

const railExtent = (screen: RenderedScreen, rail: keyof typeof RAILS) =>
  styleOf(screen, RAILS[rail].id)[RAILS[rail].extent];

const railConfig = (screen: RenderedScreen, rail: keyof typeof RAILS) =>
  asInterpolation(railExtent(screen, rail))._config;

/** The rail's full length -- the far end of its output range. */
const railLength = (screen: RenderedScreen, rail: keyof typeof RAILS) =>
  Number(railConfig(screen, rail).outputRange[1]);

/** Depth-first render order, which is paint order: later nodes sit on top. */
const paintOrder = (screen: RenderedScreen) =>
  screen.root
    .findAll(node => typeof node.props.testID === 'string')
    .map(node => node.props.testID as string);

const watchHaptics = () =>
  jest.spyOn(mockRadio, 'performHaptic').mockResolvedValue(undefined);
const effects = (spy: jest.SpyInstance) =>
  spy.mock.calls.map(call => call[0] as string);

/** The happy scenario, driven to `ready` -- the state the user holds from. */
const openReady = async (options: RenderOptions = {}) => {
  const screen = await renderScreen(<RadioScreen onSettingsPress={jest.fn()} />, {
    scenario: 'happy',
    ...options,
  });
  opened.push(screen);
  await screen.press(testIds.powerOnArea);
  await screen.advance(2100);
  return screen;
};

describe('where the seal may run', () => {
  it('is not on screen until the key is actually held', async () => {
    const screen = await openReady();

    expect(screen.findAll('hold-seal')).toHaveLength(0);

    await screen.pressIn(testIds.powerKey);
    expect(screen.findAll('hold-seal')).toHaveLength(1);
  });

  it('runs in searching too, where the key is just as live', async () => {
    const screen = await renderScreen(
      <RadioScreen onSettingsPress={jest.fn()} />,
      {scenario: 'solo'},
    );
    opened.push(screen);
    await screen.press(testIds.powerOnArea);
    expect(screen.hasText('SEARCHING FOR DEVICES...')).toBe(true);

    await screen.pressIn(testIds.powerKey);
    expect(screen.findAll('hold-seal')).toHaveLength(1);
  });

  it('never runs over the red or the green wash', async () => {
    // "THE KEY IS RECEDED AND UNTAPPABLE WHILE TRANSMITTING / RECEIVING, SO THE
    // SEAL CAN NEVER RUN OVER THE RED OR GREEN WASH." A hold that was already
    // running when the state changes under it would do exactly that -- and its
    // commit timer would go on to power the radio off mid-transmission, with
    // no release ever reaching the key to cancel it.
    const screen = await openReady();

    await screen.pressIn(testIds.powerKey);
    await screen.advance(400);
    expect(screen.findAll('hold-seal')).toHaveLength(1);

    await screen.act(() => radio.pressPtt());
    expect(screen.hasText('TRANSMITTING...')).toBe(true);
    expect(screen.findAll('hold-seal')).toHaveLength(0);

    await screen.advance(5000);
    expect(screen.hasText('RADIO OFF')).toBe(false);
  });

  it('leaves nothing of the old bar under the thumb', async () => {
    // The whole reason for the redesign: `power-key-progress` lived inside the
    // 56pt key, under the finger doing the holding.
    const screen = await openReady();
    await screen.pressIn(testIds.powerKey);

    expect(screen.findAll('power-key-progress')).toHaveLength(0);
  });
});

describe('the geometry, derived and not hardcoded', () => {
  it('grows four rails off one animated value', async () => {
    const screen = await openReady();
    await screen.pressIn(testIds.powerKey);

    const parents = (Object.keys(RAILS) as (keyof typeof RAILS)[]).map(
      rail => asInterpolation(railExtent(screen, rail))._parent,
    );
    const wash = asInterpolation(styleOf(screen, 'seal-wash').opacity);

    // Width and height interpolation force `useNativeDriver: false`, so every
    // layer has to hang off the SAME non-native value; splitting any of them
    // onto a second value is how they drift apart mid-hold.
    expect(new Set([...parents, wash._parent]).size).toBe(1);
  });

  it('derives each breakpoint from the rail lengths', async () => {
    const screen = await openReady();
    const {railW, railH, kx, ky} = railsFor();
    await screen.pressIn(testIds.powerKey);

    // KX = RAILW / (RAILW + RAILH); KY = RAILH / (RAILW + RAILH).
    expect(kx + ky).toBeCloseTo(1, 10);

    const bottom = railConfig(screen, 'bottom');
    expect(bottom.inputRange[0]).toBe(0);
    expect(bottom.inputRange[1]).toBeCloseTo(kx, 10);
    expect(bottom.outputRange).toEqual([0, railW]);
    expect(bottom.extrapolate).toBe('clamp');

    const left = railConfig(screen, 'left');
    expect(left.inputRange[0]).toBeCloseTo(kx, 10);
    expect(left.inputRange[1]).toBe(1);
    expect(left.outputRange).toEqual([0, railH]);
    expect(left.extrapolate).toBe('clamp');

    const right = railConfig(screen, 'right');
    expect(right.inputRange[0]).toBe(0);
    expect(right.inputRange[1]).toBeCloseTo(ky, 10);
    expect(right.outputRange).toEqual([0, railH]);
    expect(right.extrapolate).toBe('clamp');

    const top = railConfig(screen, 'top');
    expect(top.inputRange[0]).toBeCloseTo(ky, 10);
    expect(top.inputRange[1]).toBe(1);
    expect(top.outputRange).toEqual([0, railW]);
    expect(top.extrapolate).toBe('clamp');
  });

  it('runs both paths the same distance, so they close together', async () => {
    const screen = await openReady();
    const {railW, railH} = railsFor();
    await screen.pressIn(testIds.powerKey);

    // "EACH PATH IS EXACTLY (RAILW + RAILH) LONG FOR ANY RECTANGLE, SO BOTH
    // CLOSE ON THE TOP-LEFT CORNER TOGETHER WITH NO PER-DEVICE CONSTANT."
    const bottomThenLeft =
      railLength(screen, 'bottom') + railLength(screen, 'left');
    const rightThenTop = railLength(screen, 'right') + railLength(screen, 'top');

    expect(bottomThenLeft).toBe(railW + railH);
    expect(rightThenTop).toBe(railW + railH);
  });

  it('anchors both paths at the power key’s own corner', async () => {
    const screen = await openReady();
    await screen.pressIn(testIds.powerKey);

    // Bottom and top are anchored RIGHT and grow left; left and right are
    // anchored BOTTOM and grow up. Every rail is `--seal-w` thick with a 2pt
    // end radius, inset `--seal-inset` from the edge it runs along.
    const bottom = styleOf(screen, 'seal-rail-bottom');
    expect(bottom).toMatchObject({
      position: 'absolute',
      right: seal.inset,
      bottom: seal.inset,
      height: seal.railWidth,
      borderRadius: seal.radius,
    });

    const right = styleOf(screen, 'seal-rail-right');
    expect(right).toMatchObject({
      right: seal.inset,
      bottom: seal.inset,
      width: seal.railWidth,
    });

    const left = styleOf(screen, 'seal-rail-left');
    expect(left).toMatchObject({
      left: seal.inset,
      bottom: seal.inset,
      width: seal.railWidth,
    });

    const top = styleOf(screen, 'seal-rail-top');
    expect(top).toMatchObject({
      right: seal.inset,
      top: seal.inset,
      height: seal.railWidth,
    });
  });

  it('clears the notch by measuring the top rail from the safe area', async () => {
    // The one edge that carries an OCCLUDING system overlay. The other three
    // hug the physical edge, so the seal still reads as the screen's perimeter.
    const insets = {top: 59, right: 0, bottom: 34, left: 0};
    const screen = await openReady({insets});
    const flush = railsFor(0);
    const safe = railsFor(insets.top);
    await screen.pressIn(testIds.powerKey);

    expect(railLength(screen, 'right')).toBe(safe.railH);
    expect(safe.railH).toBe(flush.railH - insets.top);
    // The bottom rail is unmoved by the home indicator: only the top edge
    // occludes paint.
    expect(railLength(screen, 'bottom')).toBe(flush.railW);
    expect(styleOf(screen, 'seal-rail-bottom').bottom).toBe(seal.inset);

    // The breakpoints follow the uneven frame without a per-device constant.
    expect(railConfig(screen, 'bottom').inputRange[1]).toBeCloseTo(safe.kx, 10);
    expect(railConfig(screen, 'right').inputRange[1]).toBeCloseTo(safe.ky, 10);
  });

  it('reaches each corner exactly when the canvas says it does', async () => {
    const screen = await openReady();
    const {railW, railH, kx, ky} = railsFor();
    await screen.pressIn(testIds.powerKey);
    const at = (rail: keyof typeof RAILS) =>
      asInterpolation(railExtent(screen, rail)).__getValue() as number;
    const value = asInterpolation(railExtent(screen, 'bottom'))
      ._parent as Animated.Value;

    await screen.act(() => value.setValue(kx));
    expect(at('bottom')).toBeCloseTo(railW, 6);
    expect(at('left')).toBeCloseTo(0, 6);
    expect(at('right')).toBeCloseTo((railH * kx) / ky, 6);
    expect(at('top')).toBe(0);

    await screen.act(() => value.setValue(ky));
    expect(at('right')).toBeCloseTo(railH, 6);
    expect(at('top')).toBeCloseTo(0, 6);

    await screen.act(() => value.setValue(1));
    // The closed loop: every rail full, both paths on the far corner.
    expect(at('bottom')).toBeCloseTo(railW, 6);
    expect(at('left')).toBeCloseTo(railH, 6);
    expect(at('right')).toBeCloseTo(railH, 6);
    expect(at('top')).toBeCloseTo(railW, 6);
  });
});

describe('the layers', () => {
  it('tracks the wash off the same value and keeps the controls legible', async () => {
    const screen = await openReady();
    await screen.pressIn(testIds.powerKey);

    const wash = asInterpolation(styleOf(screen, 'seal-wash').opacity);
    expect(wash._config.inputRange).toEqual([0, 1]);
    expect(wash._config.outputRange).toEqual([0, 1]);
    expect(wash._config.extrapolate).toBe('clamp');

    // "IT SITS UNDER THE GEAR, KEY AND ROUTE READOUT, WHICH ALL STAY LEGIBLE."
    const order = paintOrder(screen);
    expect(order.indexOf('hold-seal')).toBeGreaterThan(
      order.indexOf(testIds.pttArea),
    );
    expect(order.indexOf('hold-seal')).toBeLessThan(
      order.indexOf('corner-controls'),
    );
    expect(order.indexOf('hold-seal')).toBeLessThan(
      order.indexOf(testIds.audioRoute),
    );
    expect(screen.find('hold-seal').props.pointerEvents).toBe('none');
  });

  it('runs the hold linearly, because a meter that eases lies', async () => {
    const timing = jest.spyOn(Animated, 'timing');
    const screen = await openReady();
    await screen.pressIn(testIds.powerKey);

    const value = asInterpolation(railExtent(screen, 'bottom'))._parent;
    const call = timing.mock.calls.find(([target]) => target === value);
    expect(call).toBeDefined();
    expect(call?.[1]).toMatchObject({
      toValue: 1,
      duration: motion.powerHoldMs,
      useNativeDriver: false,
    });
    expect(call?.[1].easing).toBe(Easing.linear);
  });

  it('arms the corner key in amber, never in red', async () => {
    const screen = await openReady();
    expect(styleOf(screen, 'power-key-ring').borderColor).toBe(colors.textFaint);

    await screen.pressIn(testIds.powerKey);
    // "ACCENT · AMBER, NEVER RED. RED IS TRANSMITTING."
    expect(styleOf(screen, 'power-key-ring').borderColor).toBe(colors.seal);
    expect(styleOf(screen, 'power-key-ring').borderColor).not.toBe(colors.tx);
  });

  it('recedes the ring and cross-fades its label over the first 15%', async () => {
    const screen = await openReady();
    await screen.pressIn(testIds.powerKey);

    const border = asInterpolation(styleOf(screen, 'state-ring').borderColor);
    expect(border._config.inputRange).toEqual([0, seal.copyFade]);
    expect(border._config.outputRange).toEqual([
      colors.hairlineRaised,
      colors.hairline,
    ]);

    const out = asInterpolation(styleOf(screen, testIds.radioStateLabel).opacity);
    expect(out._config.inputRange).toEqual([0, seal.copyFade]);
    expect(out._config.outputRange).toEqual([1, 0]);

    const into = asInterpolation(styleOf(screen, 'seal-copy').opacity);
    expect(into._config.inputRange).toEqual([0, seal.copyFade]);
    expect(into._config.outputRange).toEqual([0, 1]);

    // Every layer, the cross-fade included, on the one non-native value.
    expect(new Set([border._parent, out._parent, into._parent]).size).toBe(1);
  });

  it.each([
    ['en', 'Hold to turn the radio off'],
    ['ru', 'Удерживайте, чтобы выключить рацию'],
  ] as const)(
    'says what the hold will do in the key’s own words (%s)',
    async (locale, copy) => {
      const screen = await openReady({locale});
      expect(screen.hasText(copy)).toBe(false);

      await screen.pressIn(testIds.powerKey);
      // The catalog message that is already the key's accessibility label,
      // uppercased by style, never re-translated.
      expect(screen.hasText(copy)).toBe(true);
    },
  );
});

describe('an early release', () => {
  it('runs the same value back instead of snapping it to zero', async () => {
    const timing = jest.spyOn(Animated, 'timing');
    const screen = await openReady();
    const {railW} = railsFor();

    await screen.pressIn(testIds.powerKey);
    await screen.advance(600);
    const grown = asInterpolation(railExtent(screen, 'bottom')).__getValue();
    expect(grown).toBe(railW);

    await screen.pressOut(testIds.powerKey);
    // Still on screen, still where it got to: a snap to 0 would read as a
    // failure rather than as nothing having happened.
    expect(screen.findAll('hold-seal')).toHaveLength(1);
    expect(
      asInterpolation(railExtent(screen, 'bottom')).__getValue(),
    ).toBeGreaterThan(0);

    const value = asInterpolation(railExtent(screen, 'bottom'))._parent;
    const back = timing.mock.calls.filter(([target]) => target === value).pop();
    expect(back?.[1]).toMatchObject({
      toValue: 0,
      duration: motion.sealAbortMs,
      useNativeDriver: false,
    });
    const easing = back?.[1].easing as (t: number) => number;
    // Ease-out cubic: fast first, settling in.
    expect(easing(0)).toBeCloseTo(0, 6);
    expect(easing(1)).toBeCloseTo(1, 6);
    expect(easing(0.5)).toBeGreaterThan(0.5);

    await screen.advance(motion.sealAbortMs + 50);
    expect(screen.findAll('hold-seal')).toHaveLength(0);
  });

  it('never flashes a colour, and lets the key go', async () => {
    const screen = await openReady();

    await screen.pressIn(testIds.powerKey);
    await screen.advance(600);
    await screen.pressOut(testIds.powerKey);

    // `.sealing.abort .seal` -- a recede is the only thing that reads as
    // "nothing happened", so the rails dim and drop their glow.
    const rail = styleOf(screen, 'seal-rail-bottom');
    expect(rail.opacity).toBe(seal.abortOpacity);
    expect(rail.boxShadow).toBeUndefined();
    expect(rail.backgroundColor).toBe(colors.seal);

    // Frame 12: the key is no longer armed the instant the finger leaves.
    expect(styleOf(screen, 'power-key-ring').borderColor).toBe(colors.textFaint);
  });

  it('does not power off, and announces nothing', async () => {
    const haptic = watchHaptics();
    const screen = await openReady();
    haptic.mockClear();

    await screen.pressIn(testIds.powerKey);
    await screen.advance(motion.powerHoldMs - 100);
    await screen.pressOut(testIds.powerKey);
    await screen.advance(5000);

    expect(screen.hasText('RADIO OFF')).toBe(false);
    expect(effects(haptic)).toEqual([]);
  });
});

describe('the close', () => {
  it('holds the closed loop, flashes, then powers off', async () => {
    const haptic = watchHaptics();
    const screen = await openReady();
    const {railW, railH} = railsFor();
    haptic.mockClear();

    await screen.pressIn(testIds.powerKey);
    await screen.advance(motion.powerHoldMs);

    // "AT 100% HOLD THE CLOSED LOOP 90MS, TAKE THE WASH TO FULL."
    expect(asInterpolation(railExtent(screen, 'left')).__getValue()).toBeCloseTo(
      railH,
      6,
    );
    expect(asInterpolation(railExtent(screen, 'top')).__getValue()).toBeCloseTo(
      railW,
      6,
    );
    expect(screen.findAll('seal-flash')).toHaveLength(1);
    expect(screen.hasText('RADIO OFF')).toBe(false);
    expect(effects(haptic)).toEqual([]);

    await screen.advance(motion.sealCloseMs + 1);
    expect(screen.hasText('RADIO OFF')).toBe(true);
    expect(screen.findAll('hold-seal')).toHaveLength(0);
    expect(effects(haptic)).toEqual([HAPTIC_EFFECTS.powerOff]);
  });

  it('announces the close exactly once, however the finger leaves', async () => {
    const haptic = watchHaptics();
    const screen = await openReady();
    haptic.mockClear();

    await screen.pressIn(testIds.powerKey);
    await screen.advance(motion.powerHoldMs);
    // Released during the 90ms close: the commitment was made at 100%, so this
    // must neither cancel it nor announce it twice.
    await screen.pressOut(testIds.powerKey);
    await screen.advance(motion.sealCloseMs + 5000);

    expect(screen.hasText('RADIO OFF')).toBe(true);
    expect(effects(haptic)).toEqual([HAPTIC_EFFECTS.powerOff]);
  });
});

describe('reduced motion', () => {
  it('renders the whole perimeter at once and never grows it', async () => {
    const screen = await openReady({reducedMotion: true});
    const {railW, railH} = railsFor();

    // No `advance` anywhere in this test: the point is that the seal is
    // already whole the instant the hold starts.
    await screen.pressIn(testIds.powerKey);

    expect(railExtent(screen, 'bottom')).toBe(railW);
    expect(railExtent(screen, 'top')).toBe(railW);
    expect(railExtent(screen, 'left')).toBe(railH);
    expect(railExtent(screen, 'right')).toBe(railH);
    expect(styleOf(screen, 'hold-seal').opacity).toBe(seal.stillOpacity);
    expect(screen.hasText('Hold to turn the radio off')).toBe(true);
  });

  it('clears instantly on release and still powers off at 1200ms', async () => {
    const screen = await openReady({reducedMotion: true});

    await screen.pressIn(testIds.powerKey);
    await screen.pressOut(testIds.powerKey);
    // Instantly: no recede to wait out.
    expect(screen.findAll('hold-seal')).toHaveLength(0);

    await screen.pressIn(testIds.powerKey);
    await screen.advance(motion.powerHoldMs + 1);
    expect(screen.hasText('RADIO OFF')).toBe(true);
  });
});

describe('the seal changes no box', () => {
  /** Every resolved style prop that can move or resize the centred column. */
  const boxOf = (node: ReactTestInstance) => {
    const flat = (StyleSheet.flatten(node.props.style) ?? {}) as Record<
      string,
      unknown
    >;
    return {
      width: flat.width ?? null,
      height: flat.height ?? null,
      borderWidth: flat.borderWidth ?? null,
      borderRadius: flat.borderRadius ?? null,
      padding: flat.padding ?? null,
      paddingTop: flat.paddingTop ?? null,
      paddingBottom: flat.paddingBottom ?? null,
      paddingHorizontal: flat.paddingHorizontal ?? null,
      margin: flat.margin ?? null,
      gap: flat.gap ?? null,
      position: flat.position ?? null,
      top: flat.top ?? null,
      bottom: flat.bottom ?? null,
      alignSelf: flat.alignSelf ?? null,
      transform: flat.transform ?? null,
    };
  };

  const isHost = (node: ReactTestInstance) => typeof node.type === 'string';

  const stageColumn = (screen: RenderedScreen) => {
    let stage: ReactTestInstance | null = null;
    for (
      let node: ReactTestInstance | null = screen.find('state-ring').parent;
      node;
      node = node.parent
    ) {
      const flat = StyleSheet.flatten(node.props.style) as
        | Record<string, unknown>
        | undefined;
      if (isHost(node) && flat?.justifyContent === 'center' && flat?.gap) {
        stage = node;
        break;
      }
    }
    if (!stage) throw new Error('the ring has no .stage ancestor');

    const children = (node: ReactTestInstance): ReactTestInstance[] =>
      node.children.flatMap(child =>
        typeof child === 'string'
          ? []
          : isHost(child)
            ? [child]
            : children(child),
      );

    return {
      stage: boxOf(stage),
      children: children(stage).map(boxOf),
    };
  };

  it('adds no sibling to the centred column and changes no box', async () => {
    // The talk ring is geometrically invariant. The seal is an overlay on the
    // chassis, NOT a member of the stage column -- and the ring's own recede is
    // a colour change, which cannot move anything.
    const screen = await openReady();
    const atRest = stageColumn(screen);

    await screen.pressIn(testIds.powerKey);
    expect(stageColumn(screen)).toEqual(atRest);

    await screen.advance(600);
    expect(stageColumn(screen)).toEqual(atRest);

    await screen.pressOut(testIds.powerKey);
    expect(stageColumn(screen)).toEqual(atRest);
  });

  it('keeps the reserved hint slot exactly as it is', async () => {
    // `ru` deliberately: the slot reserves the two-line worst case, and the
    // seal must not spend any of it.
    const screen = await openReady({locale: 'ru'});
    const before = stageColumn(screen).children;

    await screen.pressIn(testIds.powerKey);
    const during = stageColumn(screen).children;

    expect(during).toHaveLength(before.length);
    expect(during[during.length - 1]).toEqual(before[before.length - 1]);
  });
});
