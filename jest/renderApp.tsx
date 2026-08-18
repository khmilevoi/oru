import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import {context} from '@reatom/core';
import {i18n} from '@lingui/core';
import type {ReactTestInstance} from 'react-test-renderer';

import App from '../App';
import {bootstrapApp} from '../src/app/appEntry';
import {mockPermissions} from '../src/permissions/permissions.mock';
import {mockRadio} from '../src/radio/radio.native.mock';
import {platformGateway, realPlatformGateway} from '../src/permissions/platform.gateway';
import {reducedMotion} from '../src/ui/reducedMotion';
import {DEFAULT_MOCK_SCENARIO, setMockScenario} from '../src/mock/mock.scenario';
import type {MockScenarioName} from '../src/mock/mock.scenario';
import type {PlatformPermissionsGateway} from '../src/permissions/platform.gateway';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {loadPoCatalog} = require('./loadPoCatalog');

export type RenderAppOptions = {
  locale?: 'en' | 'ru';
  scenario?: MockScenarioName;
  gateway?: Partial<PlatformPermissionsGateway>;
};

const collectText = (node: ReactTestInstance | string): string[] =>
  typeof node === 'string' ? [node] : node.children.flatMap(collectText);

export async function renderApp(options: RenderAppOptions = {}) {
  context.reset();

  setMockScenario(options.scenario ?? DEFAULT_MOCK_SCENARIO);
  mockPermissions.reset();
  mockRadio.reset(options.scenario ? {scenario: options.scenario} : {});
  reducedMotion.set(false);
  platformGateway.set({...realPlatformGateway, ...options.gateway});

  // `bootstrapApp` activates the locale from the real catalog path; the .po
  // moduleNameMapper stubs those out under Jest, so the catalog is reloaded
  // from disk afterwards exactly as `renderScreen` does.
  const {teardown} = bootstrapApp({
    systemLocale: options.locale ?? 'en',
    appState: {addEventListener: () => ({remove: () => {}})},
    devMenu: {addMenuItem: () => {}},
  });
  i18n.loadAndActivate({
    locale: options.locale ?? 'en',
    messages: loadPoCatalog(options.locale ?? 'en'),
  });

  let renderer: ReactTestRenderer.ReactTestRenderer | undefined;
  await ReactTestRenderer.act(async () => {
    renderer = ReactTestRenderer.create(<App />);
  });
  // `App`'s mount effect -- flushed only once the `act` above settles -- fires
  // `resolveInitialRoute()`, an async action chained through `wrap(...)` over
  // the (possibly async) gateway calls; one microtask turn is not enough to
  // drain that chain, so several are taken here, inside their own `act`, the
  // same way `pairing-flow.test.tsx` drains a comparable chain elsewhere in
  // this repository.
  await ReactTestRenderer.act(async () => {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  });

  const tree = renderer as ReactTestRenderer.ReactTestRenderer;
  const root = tree.root;
  const rawFindAll = (testID: string) => root.findAllByProps({testID});
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

  const fire = async (testID: string, handler: string) => {
    await ReactTestRenderer.act(async () => {
      const target = rawFindAll(testID).find(
        node => typeof node.props[handler] === 'function',
      );
      if (!target) throw new Error(`testID "${testID}" has no ${handler} handler`);
      (target.props[handler] as (event: unknown) => void)({nativeEvent: {}});
    });
  };

  return {
    root,
    texts: () => collectText(root),
    hasText: (value: string) => collectText(root).join('').includes(value),
    findAll,
    press: (testID: string) => fire(testID, 'onPress'),
    pressIn: (testID: string) => fire(testID, 'onPressIn'),
    pressOut: (testID: string) => fire(testID, 'onPressOut'),
    advance: async (ms: number) => {
      await ReactTestRenderer.act(async () => {
        jest.advanceTimersByTime(ms);
      });
    },
    act: async (body: () => Promise<unknown> | unknown) => {
      await ReactTestRenderer.act(async () => {
        await body();
      });
    },
    unmount: () => {
      teardown();
      ReactTestRenderer.act(() => tree.unmount());
    },
  };
}
