import React from 'react';
import {StyleSheet} from 'react-native';
import {context} from '@reatom/core';
import type {ReactTestInstance} from 'react-test-renderer';

import {RadioScreen} from '../src/screens/RadioScreen';
import {StateRing} from '../src/ui/StateRing';
import {renderScreen} from '../jest/renderScreen';
import type {RenderedScreen} from '../jest/renderScreen';
import {sizes, stage, testIds} from '../src/ui/theme';

jest.useFakeTimers({doNotFake: ['queueMicrotask']});

beforeEach(() => context.reset());

/**
 * Every screen this file opens, unmounted whatever the test did -- a failed
 * assertion must not leave a live engine subscription behind, or the next test
 * renders on top of it and fails for a reason that has nothing to do with it.
 */
let opened: RenderedScreen[] = [];
afterEach(() => {
  opened.forEach(screen => screen.unmount());
  opened = [];
});

/**
 * The talk ring is geometrically invariant: same diameter, same border box,
 * same centre, in every live state. Only colour, fill and glow may change.
 *
 * These tests measure STRUCTURE, not styles-as-written. `.stage` is a centred
 * flex column, so where the ring lands is decided by the whole column: the
 * ring's own box, plus every sibling's box, plus the column's gap and padding.
 * Change any one of them between states and the ring re-centres and visibly
 * jumps -- which is exactly the bug this file pins down. So each assertion
 * compares the entire column of one state against the same column in another,
 * and passes only if nothing that can move the ring differs.
 */

/** Every resolved style prop that can move or resize a node in a flex column. */
const LAYOUT_PROPS = [
  'width',
  'height',
  'minHeight',
  'maxHeight',
  'minWidth',
  'maxWidth',
  'borderRadius',
  'borderWidth',
  'borderTopWidth',
  'borderBottomWidth',
  'borderLeftWidth',
  'borderRightWidth',
  'margin',
  'marginTop',
  'marginBottom',
  'marginVertical',
  'marginHorizontal',
  'padding',
  'paddingTop',
  'paddingBottom',
  'paddingVertical',
  'paddingHorizontal',
  'gap',
  'flex',
  'flexGrow',
  'flexShrink',
  'flexBasis',
  'alignSelf',
  'position',
  'top',
  'bottom',
  'transform',
] as const;

type Box = Record<string, unknown>;

const boxOf = (style: unknown): Box => {
  const flat = (StyleSheet.flatten(style as never) ?? {}) as Record<
    string,
    unknown
  >;
  return Object.fromEntries(LAYOUT_PROPS.map(key => [key, flat[key] ?? null]));
};

const isHost = (node: ReactTestInstance) => typeof node.type === 'string';

/**
 * The nodes that actually lay out inside `node` -- descending through every
 * composite wrapper (`View`, `Text`, `Trans`, `reatomComponent`) and stopping
 * at the first host element on each branch. That is the real column the
 * layout engine sees, whatever component tree produced it.
 */
const columnOf = (node: ReactTestInstance): ReactTestInstance[] =>
  node.children.flatMap(child =>
    typeof child === 'string'
      ? []
      : isHost(child)
        ? [child]
        : columnOf(child),
  );

/** The nearest `.stage` ancestor above the ring, found by its own geometry. */
const stageAbove = (ring: ReactTestInstance): ReactTestInstance => {
  for (let node = ring.parent; node; node = node.parent) {
    if (!isHost(node)) continue;
    const flat = StyleSheet.flatten(node.props.style) as Box | undefined;
    if (flat?.gap === stage.gap && flat?.justifyContent === 'center') {
      return node;
    }
  }
  throw new Error('the ring has no .stage ancestor');
};

/** Everything about the centred column that decides where the ring lands. */
const ringColumn = (screen: RenderedScreen) => {
  const node = stageAbove(screen.find('state-ring'));
  const flat = (StyleSheet.flatten(node.props.style) ?? {}) as Box;
  return {
    stage: {
      gap: flat.gap ?? null,
      paddingTop: flat.paddingTop ?? null,
      paddingBottom: flat.paddingBottom ?? null,
      justifyContent: flat.justifyContent ?? null,
    },
    children: columnOf(node).map(child => boxOf(child.props.style)),
  };
};

/** The happy scenario, driven to `ready` -- the state the user presses from. */
const openReady = async (locale: 'en' | 'ru' = 'en') => {
  const screen = await renderScreen(
    <RadioScreen onSettingsPress={jest.fn()} />,
    {scenario: 'happy', locale},
  );
  opened.push(screen);
  await screen.press(testIds.powerOnArea);
  await screen.advance(2100);
  return screen;
};

describe('the talk ring is geometrically invariant', () => {
  it.each(['en', 'ru'] as const)(
    'does not move or resize when the talk button is pressed and held (%s)',
    async locale => {
      const screen = await openReady(locale);
      const atRest = ringColumn(screen);

      await screen.pressIn(testIds.pttArea);
      const held = ringColumn(screen);
      expect(held).toEqual(atRest);

      await screen.pressOut(testIds.pttArea);
      expect(ringColumn(screen)).toEqual(atRest);
    },
  );

  it.each(['en', 'ru'] as const)(
    'does not move or resize when a transmission arrives (%s)',
    async locale => {
      const screen = await openReady(locale);
      const atRest = ringColumn(screen);

      await screen.advance(6000);
      expect(screen.hasText(locale === 'en' ? 'RECEIVING' : 'ПРИЁМ')).toBe(
        true,
      );
      expect(ringColumn(screen)).toEqual(atRest);
    },
  );

  it.each(['en', 'ru'] as const)(
    'reserves the hint area below the ring at a constant height (%s)',
    async locale => {
      const screen = await openReady(locale);
      const [ring, ...rest] = ringColumn(screen).children;

      expect(ring.width).toBe(sizes.ring);
      expect(ring.height).toBe(sizes.ring);
      // Reserved, not conditional: the hint's own copy appears only while
      // transmitting, but its slot is in the column in every state, at a
      // height that holds the longest translation without reflowing.
      expect(rest).toHaveLength(1);
      expect(rest[0].height).toBe(stage.hintSlot);
    },
  );
});

describe('StateRing border box', () => {
  it.each(['idle', 'tx', 'rx'] as const)(
    'gives the %s tone the same border box as every other tone',
    async tone => {
      const screen = await renderScreen(
        <StateRing tone={tone} testID="ring">
          <></>
        </StateRing>,
      );
      opened.push(screen);
      const box = boxOf(screen.find('state-ring').props.style);

      expect(box.width).toBe(sizes.ring);
      expect(box.height).toBe(sizes.ring);
      expect(box.borderRadius).toBe(sizes.ring / 2);
      expect(box.borderWidth).toBe(sizes.ringBorder);
    },
  );

  it('draws the receiving tone’s heavier edge without touching the box', async () => {
    const screen = await renderScreen(
      <StateRing tone="rx" testID="ring">
        <></>
      </StateRing>,
    );
    opened.push(screen);

    const edge = boxOf(screen.find('state-ring-edge').props.style);
    expect(edge.position).toBe('absolute');
    expect(edge.borderWidth).toBe(sizes.ringEdgeRx);
  });
});
