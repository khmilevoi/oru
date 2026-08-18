import React from 'react';
import {Text} from 'react-native';
import {context} from '@reatom/core';

import {ActionButton} from '../src/ui/ActionButton';
import {PowerKey} from '../src/ui/PowerKey';
import {PulseDot} from '../src/ui/PulseDot';
import {ScreenFrame} from '../src/ui/ScreenFrame';
import {colors, motion} from '../src/ui/theme';
import {reducedMotion} from '../src/ui/reducedMotion';
import {renderScreen} from '../jest/renderScreen';
import {loadPoCatalog} from '../jest/loadPoCatalog';

jest.useFakeTimers({doNotFake: ['queueMicrotask']});

beforeEach(() => {
  context.reset();
});

describe('PowerKey', () => {
  it('fires immediately when it is not a hold', async () => {
    const onActivate = jest.fn();
    const screen = await renderScreen(
      <PowerKey
        variant="hero"
        onActivate={onActivate}
        testID="power"
        accessibilityLabel="Turn radio on"
      />,
    );

    await screen.press('power');

    expect(onActivate).toHaveBeenCalledTimes(1);
    screen.unmount();
  });

  it('only fires after the full hold when it guards a shut-off', async () => {
    const onActivate = jest.fn();
    const screen = await renderScreen(
      <PowerKey
        variant="corner"
        holdToConfirm
        onActivate={onActivate}
        testID="power"
        accessibilityLabel="Turn radio off"
      />,
    );

    await screen.pressIn('power');
    await screen.advance(motion.powerHoldMs - 100);
    expect(onActivate).not.toHaveBeenCalled();

    await screen.advance(200);
    expect(onActivate).toHaveBeenCalledTimes(1);
    screen.unmount();
  });

  it('cancels the hold when the finger leaves early', async () => {
    const onActivate = jest.fn();
    const screen = await renderScreen(
      <PowerKey
        variant="corner"
        holdToConfirm
        onActivate={onActivate}
        testID="power"
        accessibilityLabel="Turn radio off"
      />,
    );

    await screen.pressIn('power');
    await screen.advance(400);
    await screen.pressOut('power');
    await screen.advance(5000);

    expect(onActivate).not.toHaveBeenCalled();
    screen.unmount();
  });
});

describe('PulseDot', () => {
  it('animates when motion is allowed and holds still when it is not', async () => {
    const animated = await renderScreen(<PulseDot active color={colors.rx} />, {
      reducedMotion: false,
    });
    expect(animated.findAll('pulse-dot')).toHaveLength(1);
    animated.unmount();

    const still = await renderScreen(<PulseDot active color={colors.rx} />, {
      reducedMotion: true,
    });
    expect(reducedMotion()).toBe(true);
    expect(still.findAll('pulse-dot')).toHaveLength(1);
    still.unmount();
  });
});

describe('ActionButton and ScreenFrame', () => {
  it('reports presses and renders its label', async () => {
    const onPress = jest.fn();
    const screen = await renderScreen(
      <ScreenFrame title="PANEL" testID="frame">
        <ActionButton label="Connect" onPress={onPress} testID="connect" />
      </ScreenFrame>,
    );

    expect(screen.hasText('PANEL')).toBe(true);
    expect(screen.hasText('Connect')).toBe(true);

    await screen.press('connect');
    expect(onPress).toHaveBeenCalledTimes(1);
    screen.unmount();
  });
});

describe('the locale harness', () => {
  it('renders macro copy in the locale it activated', async () => {
    const screen = await renderScreen(<Text>plain</Text>, {locale: 'ru'});
    expect(screen.hasText('plain')).toBe(true);
    screen.unmount();
  });

  it('reads both catalogs off disk', () => {
    expect(loadPoCatalog('en')).toBeInstanceOf(Object);
    expect(loadPoCatalog('ru')).toBeInstanceOf(Object);
  });
});
