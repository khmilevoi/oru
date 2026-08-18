import React from 'react';
import {context} from '@reatom/core';

import {renderScreen} from '../jest/renderScreen';
import {LevelBars} from '../src/ui/LevelBars';
import {StateRing} from '../src/ui/StateRing';
import {colors, sizes} from '../src/ui/theme';

jest.useFakeTimers({doNotFake: ['queueMicrotask']});

beforeEach(() => {
  context.reset();
});

describe('StateRing — design/01 Radio.dc.html', () => {
  it('is the canvas circle at rest', async () => {
    const screen = await renderScreen(
      <StateRing tone="idle" testID="ring">
        <></>
      </StateRing>,
    );

    const flat = JSON.stringify(screen.find('state-ring').props.style);
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

    const flat = JSON.stringify(screen.find('state-ring').props.style);
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

    const flat = JSON.stringify(screen.find('state-ring').props.style);
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

    const flat = JSON.stringify(screen.find('state-ring').props.style);
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
    still.unmount();

    const moving = await renderScreen(
      <LevelBars color={colors.text} testID="bars" />,
      {reducedMotion: false},
    );
    const movingStyle = JSON.stringify(moving.find('bars-bar').props.style);
    moving.unmount();

    expect(stillStyle).not.toBe(movingStyle);
  });
});
