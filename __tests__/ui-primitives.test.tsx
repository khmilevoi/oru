import React from 'react';
import {StyleSheet, Text} from 'react-native';
import {context} from '@reatom/core';
import {reatomComponent} from '@reatom/react';

import {ActionButton} from '../src/ui/ActionButton';
import {GearButton} from '../src/ui/GearButton';
import {PowerKey} from '../src/ui/PowerKey';
import {useHoldToConfirm} from '../src/ui/useHoldToConfirm';
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

/**
 * The corner key as its screen composes it: the press-and-hold is owned by the
 * caller now, because its progress is painted across the whole screen rather
 * than inside the key (`src/ui/HoldSeal.tsx`). A `reatomComponent`, like every
 * real caller, so the hook's `reducedMotion()` read is a tracked one.
 */
const HeldKey = reatomComponent<{onConfirm: () => void}>(({onConfirm}) => {
  const hold = useHoldToConfirm(onConfirm);
  return (
    <PowerKey
      variant="corner"
      hold={hold}
      testID="power"
      accessibilityLabel="Turn radio off"
    />
  );
}, 'HeldKey');

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

  it('only fires after the full hold, and after its close, when it guards a shut-off', async () => {
    const onConfirm = jest.fn();
    const screen = await renderScreen(<HeldKey onConfirm={onConfirm} />);

    await screen.pressIn('power');
    await screen.advance(motion.powerHoldMs - 100);
    expect(onConfirm).not.toHaveBeenCalled();

    // 100 to reach 100%, then the closed loop is held for `sealCloseMs` before
    // the radio actually goes off -- the canvas's completion clause.
    await screen.advance(100);
    expect(onConfirm).not.toHaveBeenCalled();

    await screen.advance(motion.sealCloseMs + 1);
    expect(onConfirm).toHaveBeenCalledTimes(1);
    screen.unmount();
  });

  it('cancels the hold when the finger leaves early', async () => {
    const onConfirm = jest.fn();
    const screen = await renderScreen(<HeldKey onConfirm={onConfirm} />);

    await screen.pressIn('power');
    await screen.advance(400);
    await screen.pressOut('power');
    await screen.advance(5000);

    expect(onConfirm).not.toHaveBeenCalled();
    screen.unmount();
  });

  it('draws no progress inside its own box any more', async () => {
    // The hold's progress is the whole screen's amber perimeter seal now
    // (`src/ui/HoldSeal.tsx`). The 3pt bar this key used to fill lived under
    // the very thumb doing the holding, which is the entire reason for the
    // redesign -- so nothing of it may survive here.
    const onConfirm = jest.fn();
    const screen = await renderScreen(<HeldKey onConfirm={onConfirm} />);

    await screen.pressIn('power');
    await screen.advance(600);

    expect(screen.findAll('power-key-progress')).toHaveLength(0);
    screen.unmount();
  });

  it('arms in amber while the hold runs, and lets go the instant it ends', async () => {
    const onConfirm = jest.fn();
    const screen = await renderScreen(<HeldKey onConfirm={onConfirm} />);
    const ringColor = () =>
      (
        StyleSheet.flatten(screen.find('power-key-ring').props.style) as {
          borderColor: string;
        }
      ).borderColor;

    expect(ringColor()).toBe(colors.textFaint);

    await screen.pressIn('power');
    // `.pwr.arm` is amber. Red belongs to TRANSMITTING and to nothing else.
    expect(ringColor()).toBe(colors.seal);
    expect(ringColor()).not.toBe(colors.tx);

    await screen.pressOut('power');
    expect(ringColor()).toBe(colors.textFaint);
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

describe('GearButton — design/theme.css .gear', () => {
  it('draws the gear in the faint chassis colour, like the key beside it', async () => {
    const screen = await renderScreen(
      <GearButton
        onPress={jest.fn()}
        accessibilityLabel="Settings"
        testID="gear"
      />,
    );

    const flat = JSON.stringify(screen.find('gear-ring').props.style);
    expect(flat).toContain(colors.textFaint.slice(1));
    expect(flat).not.toContain(colors.text.slice(1));

    screen.unmount();
  });

  /**
   * This test used to assert the OPPOSITE: that the gear's hub was painted in
   * whatever chassis colour it was told it sat on. The canvas's `.gearmark`
   * (`design/01 Radio.dc.html` frame 14) forbids exactly that -- "NO PUNCH-OUT:
   * THREE OF THIS SCREEN'S FIVE STATES HAVE A GRADIENT CHASSIS AND A HOLE
   * PAINTED IN THE CHASSIS COLOUR WOULD NOT SURVIVE THERE." The hub is a RING
   * now, so there is no hole, and `notchColor` is gone with it. The full
   * construction is pinned in `__tests__/icon-system.test.tsx`.
   */
  it('punches no hole in the chassis, because a gradient would show through it', async () => {
    const screen = await renderScreen(
      <GearButton
        onPress={jest.fn()}
        accessibilityLabel="Settings"
        testID="gear"
      />,
    );

    expect(screen.findAll('gear-hub')).toHaveLength(0);
    expect(JSON.stringify(screen.find('gear-ring').props.style)).not.toContain(
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
