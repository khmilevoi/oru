/**
 * @format
 */

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';

import App from '../App';
import {context} from '@reatom/core';

jest.useFakeTimers({doNotFake: ['queueMicrotask']});

beforeEach(() => context.reset());

test('the root mounts the app, not the React Native template', async () => {
  let tree: ReactTestRenderer.ReactTestRenderer | undefined;
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(<App />);
  });

  const root = tree as ReactTestRenderer.ReactTestRenderer;
  expect(root.root.findAllByProps({templateFileName: 'App.tsx'})).toHaveLength(0);

  ReactTestRenderer.act(() => root.unmount());
});
