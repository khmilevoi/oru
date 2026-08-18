import React from 'react';
import {StyleSheet, Text} from 'react-native';
import {context} from '@reatom/core';

import {ActionButton} from '../src/ui/ActionButton';
import {PowerKey} from '../src/ui/PowerKey';
import {PulseDot} from '../src/ui/PulseDot';
import {ScreenFrame} from '../src/ui/ScreenFrame';
import {colors, motion, sizes} from '../src/ui/theme';
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

  it('freezes the hold-to-power-off progress bar at full width under reduced motion', async () => {
    const onActivate = jest.fn();
    const screen = await renderScreen(
      <PowerKey
        variant="corner"
        holdToConfirm
        onActivate={onActivate}
        testID="power"
        accessibilityLabel="Turn radio off"
      />,
      {reducedMotion: true},
    );

    // No `screen.advance(...)` anywhere in this test: the whole point is that
    // the bar is already full the instant the hold starts, not that it
    // reaches full width -- reduced motion means it never animates there.
    await screen.pressIn('power');

    const pressable = screen.root
      .findAllByProps({testID: 'power'})
      .find(node => typeof node.props.onPressIn === 'function');
    if (!pressable) throw new Error('PowerKey Pressable not found');
    const boxWidth = (StyleSheet.flatten(pressable.props.style) as {width: number})
      .width;

    const progress = screen.find('power-key-progress');
    const progressWidth = (
      StyleSheet.flatten(progress.props.style) as {width: number}
    ).width;

    expect(typeof progressWidth).toBe('number');
    expect(progressWidth).toBe(boxWidth);

    screen.unmount();
  });
});

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

    const flat = JSON.stringify(screen.find('power-key-ring').props.style);
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

describe('PulseDot', () => {
  it('renders under both motion settings, and picks up the reduced-motion flag the harness set', async () => {
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

describe('ActionButton — design/theme.css .btn', () => {
  it('draws the solid key at the canvas height', async () => {
    const screen = await renderScreen(
      <ActionButton label="Connect" tone="primary" onPress={jest.fn()} testID="key" />,
    );

    const node = screen.root
      .findAllByProps({testID: 'key'})
      .find(n => n.props.style && typeof n.props.style !== 'function');
    if (!node) throw new Error('ActionButton style-bearing node not found');
    const flat = JSON.stringify(node.props.style);
    expect(flat).toContain(String(sizes.button));
    expect(flat).toContain(colors.text.slice(1));

    screen.unmount();
  });

  it('draws the ghost key as an outline', async () => {
    const screen = await renderScreen(
      <ActionButton label="Test" onPress={jest.fn()} testID="key" />,
    );

    const node = screen.root
      .findAllByProps({testID: 'key'})
      .find(n => n.props.style && typeof n.props.style !== 'function');
    if (!node) throw new Error('ActionButton style-bearing node not found');
    const flat = JSON.stringify(node.props.style);
    expect(flat).toContain(colors.hairlineRaised.slice(1));
    expect(flat).not.toContain(`"backgroundColor":"${colors.text}"`);

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
