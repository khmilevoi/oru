import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import {I18nProvider} from '@lingui/react';
import {i18n} from '@lingui/core';
import {context} from '@reatom/core';
import type {ReactTestInstance} from 'react-test-renderer';

import {RadioNative} from '../src/radio/radio.native';
import {mockRadio} from '../src/radio/radio.native.mock';
import {mockPermissions} from '../src/permissions/permissions.mock';
import {radioEventListener} from '../src/radio/radio.model';
import {reducedMotion} from '../src/ui/reducedMotion';
import {DEFAULT_MOCK_SCENARIO, setMockScenario} from '../src/mock/mock.scenario';
import type {MockScenarioName} from '../src/mock/mock.scenario';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {loadPoCatalog} = require('./loadPoCatalog');

/**
 * The one place a P6 screen test is set up.
 *
 * It arms the whole mock stack on a scenario -- both the mock radio engine and
 * the mock permission gateway, per spec section 6.5 -- activates a locale from
 * the real `.po` catalog, and subscribes the model to the engine's event
 * stream -- without that last step nothing but `start()` and `sync()` ever
 * reaches the mirror, because `radio.model.ts` is fed by `stateChanged`
 * events. P7 does the same subscribe once at app entry; here it is per
 * render, and removed on unmount.
 */
export type RenderOptions = {
  locale?: 'en' | 'ru';
  scenario?: MockScenarioName;
  reducedMotion?: boolean;
};

export type RenderedScreen = {
  root: ReactTestInstance;
  texts(): string[];
  hasText(value: string): boolean;
  find(testID: string): ReactTestInstance;
  findAll(testID: string): ReactTestInstance[];
  press(testID: string): Promise<void>;
  pressIn(testID: string): Promise<void>;
  pressOut(testID: string): Promise<void>;
  advance(ms: number): Promise<void>;
  /** Runs anything that touches the model inside `act`, then flushes. */
  act(body: () => Promise<unknown> | unknown): Promise<void>;
  unmount(): void;
};

/**
 * Walks `.children` -- the *rendered* tree -- and never `props.children`. The
 * distinction matters: after the Lingui macro runs, `<Trans>RADIO OFF</Trans>`
 * has no children at all, only an `id` and a `message` prop, and the copy a user
 * sees exists only once `Trans` has rendered.
 */
const collectText = (node: ReactTestInstance | string): string[] =>
  typeof node === 'string' ? [node] : node.children.flatMap(collectText);

export async function renderScreen(
  element: React.ReactElement,
  options: RenderOptions = {},
): Promise<RenderedScreen> {
  context.reset();

  const locale = options.locale ?? 'en';
  i18n.loadAndActivate({locale, messages: loadPoCatalog(locale)});

  // `setMockScenario` notifies both the mock radio and the mock permission
  // gateway, so it goes first; the explicit resets below are then idempotent
  // and make the intent at this call site obvious. A test must not inherit
  // whatever scenario the previous test left the process-wide tracker on, so
  // an unset `options.scenario` still resets it, to the default.
  setMockScenario(options.scenario ?? DEFAULT_MOCK_SCENARIO);
  mockPermissions.reset();
  mockRadio.reset(options.scenario ? {scenario: options.scenario} : {});
  reducedMotion.set(options.reducedMotion ?? false);

  const subscription = RadioNative.subscribe(radioEventListener);
  if (subscription instanceof Error) throw subscription;

  let renderer: ReactTestRenderer.ReactTestRenderer | undefined;
  await ReactTestRenderer.act(async () => {
    renderer = ReactTestRenderer.create(
      <I18nProvider i18n={i18n}>{element}</I18nProvider>,
    );
  });

  const tree = renderer as ReactTestRenderer.ReactTestRenderer;
  const root = tree.root;

  // Every test instance carrying the prop, composite and host alike -- the
  // shape `fire` below needs, since the layer with a literal `onPress`-style
  // prop is not always the outermost one that named `testID`.
  const rawFindAll = (testID: string) => root.findAllByProps({testID});

  /**
   * `findAllByProps` matches every layer that carries the prop, and a React
   * Native element is built from more than one: `<Animated.View
   * testID=.../>` is an `AnimatedComponent` wrapping a `View` wrapping a host
   * `View`, and `testID` rides straight through all three unchanged; a
   * component that forwards its own `testID` prop into a child element (every
   * primitive here does, onto its `Pressable`) adds one more. Asserting on
   * how many *elements* a screen rendered -- a pairing candidate list's
   * length, or `PulseDot`'s own single node -- needs one match per element,
   * not one per layer a component happens to be built from. So the public
   * `findAll` keeps only the outermost match for a given testID: any match
   * that is itself a descendant of another match sharing the same testID is a
   * pass-through duplicate, not a second element, and is dropped.
   */
  const findAll = (testID: string) => {
    const matches = rawFindAll(testID);
    const matchSet = new Set(matches);
    return matches.filter(node => {
      for (let ancestor = node.parent; ancestor; ancestor = ancestor.parent) {
        if (matchSet.has(ancestor)) return false;
      }
      return true;
    });
  };
  const find = (testID: string) => {
    const [first] = findAll(testID);
    if (!first) {
      throw new Error(
        `No node with testID "${testID}". Present: ${JSON.stringify(
          root
            .findAll(node => typeof node.props.testID === 'string')
            .map(node => node.props.testID as string),
        )}`,
      );
    }
    return first;
  };

  const fire = async (testID: string, handler: string) => {
    await ReactTestRenderer.act(async () => {
      // Deliberately `rawFindAll`, not the deduped public `findAll`: the
      // element actually holding `onPress`/`onPressIn`/`onPressOut` (the
      // `Pressable`) is often nested a layer under the outermost node that
      // shares this testID (the component itself, forwarding its own `testID`
      // prop down), so it would never survive the outermost-only dedup above.
      const target = rawFindAll(testID).find(
        node => typeof node.props[handler] === 'function',
      );
      if (!target) {
        throw new Error(`testID "${testID}" has no ${handler} handler`);
      }
      (target.props[handler] as (event: unknown) => void)({
        nativeEvent: {},
      });
    });
  };

  return {
    root,
    texts: () => collectText(root),
    // Joined across the whole tree, because Lingui splits an interpolated
    // message into several sibling strings -- "● ", "2", " nearby".
    hasText: value => collectText(root).join('').includes(value),
    find,
    findAll,
    press: testID => fire(testID, 'onPress'),
    pressIn: testID => fire(testID, 'onPressIn'),
    pressOut: testID => fire(testID, 'onPressOut'),

    /**
     * Advances the mock engine's timeline and every component timer together --
     * the mock singleton's real clock calls the same global `setTimeout` Jest's
     * fake timers replace. The awaited act also flushes the microtasks the
     * mock's promises and Reatom's own scheduling ride on.
     */
    advance: async ms => {
      await ReactTestRenderer.act(async () => {
        jest.advanceTimersByTime(ms);
      });
    },

    /**
     * For the handful of tests that drive the model directly -- `radio.start()`
     * to put the engine in a state a screen only observes. Writing an atom
     * outside `act` leaves React with an unflushed update and the assertion
     * that follows reads a stale tree.
     */
    act: async body => {
      await ReactTestRenderer.act(async () => {
        await body();
      });
    },

    unmount: () => {
      subscription.remove();
      ReactTestRenderer.act(() => {
        tree.unmount();
      });
    },
  };
}
