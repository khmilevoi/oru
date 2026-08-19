import React from 'react';
import {ScrollView, StyleSheet} from 'react-native';
import {context} from '@reatom/core';

import {BackgroundStep, backgroundStepTestIds} from '../src/screens/BackgroundStep';
import {OnboardingFlow} from '../src/screens/OnboardingFlow';
import {PairingFlow} from '../src/screens/PairingFlow';
import {RadioScreen} from '../src/screens/RadioScreen';
import {SettingsScreen} from '../src/screens/SettingsScreen';
import {spacing, testIds} from '../src/ui/theme';
import {renderScreen} from '../jest/renderScreen';
import type {RenderedScreen} from '../jest/renderScreen';

jest.useFakeTimers({doNotFake: ['queueMicrotask']});

beforeEach(() => context.reset());

/**
 * Real-device numbers (an iPhone with a Dynamic Island), not zeros: the mock
 * safe-area module defaults to all-zero insets, under which a screen that
 * ignores the notch entirely renders pixel-identically to one that handles
 * it -- which is exactly how the status-bar overlap shipped unnoticed.
 */
const INSETS = {top: 59, right: 0, bottom: 34, left: 0};

/**
 * The flattened style of the outermost *styled* node carrying `testID`. The
 * outermost match is usually a composite (`ScreenFrame` itself, or an RN
 * `View` wrapper) and only the layer that actually declares `style` can be
 * asserted against, so the walk skips styleless pass-through layers.
 */
function flatStyle(screen: RenderedScreen, testID: string) {
  const styled = screen.root
    .findAllByProps({testID})
    .find(node => node.props.style != null);
  if (!styled) {
    throw new Error(`No styled node carries testID "${testID}"`);
  }
  return StyleSheet.flatten(styled.props.style) as {
    paddingTop?: number;
    paddingBottom?: number;
    marginBottom?: number;
    bottom?: number;
  };
}

const topOf = (screen: RenderedScreen, testID: string) =>
  flatStyle(screen, testID).paddingTop ?? 0;
const bottomPadOf = (screen: RenderedScreen, testID: string) =>
  flatStyle(screen, testID).paddingBottom ?? 0;

describe('the chassis clears the status bar and the display cutout', () => {
  it('radio, off', async () => {
    const screen = await renderScreen(
      <RadioScreen onSettingsPress={jest.fn()} />,
      {insets: INSETS},
    );

    expect(topOf(screen, testIds.radioScreen)).toBeGreaterThanOrEqual(
      INSETS.top,
    );

    screen.unmount();
  });

  it('radio, live', async () => {
    const screen = await renderScreen(
      <RadioScreen onSettingsPress={jest.fn()} />,
      {insets: INSETS},
    );

    await screen.press(testIds.powerOnArea);
    await screen.advance(2100);
    // Ready is named by the microphone glyph now, not by the deleted
    // "HOLD TO TALK" headline (2026-08-19 icon change).
    expect(screen.findAll('mic-cradle')).toHaveLength(1);

    expect(topOf(screen, testIds.radioScreen)).toBeGreaterThanOrEqual(
      INSETS.top,
    );

    screen.unmount();
  });

  it('radio, error', async () => {
    const screen = await renderScreen(
      <RadioScreen onSettingsPress={jest.fn()} />,
      {scenario: 'engine-error', insets: INSETS},
    );

    await screen.press(testIds.powerOnArea);
    await screen.advance(3100);
    expect(screen.findAll(testIds.errorState)).toHaveLength(1);

    expect(topOf(screen, testIds.errorState)).toBeGreaterThanOrEqual(
      INSETS.top,
    );

    screen.unmount();
  });

  it('settings', async () => {
    const screen = await renderScreen(
      <SettingsScreen onBack={jest.fn()} onConnectPress={jest.fn()} />,
      {insets: INSETS},
    );

    expect(topOf(screen, testIds.settingsScreen)).toBeGreaterThanOrEqual(
      INSETS.top,
    );

    screen.unmount();
  });

  it('pairing', async () => {
    const screen = await renderScreen(<PairingFlow onClose={jest.fn()} />, {
      scenario: 'pairing-success',
      insets: INSETS,
    });

    expect(topOf(screen, testIds.pairingScreen)).toBeGreaterThanOrEqual(
      INSETS.top,
    );

    screen.unmount();
  });

  it('onboarding', async () => {
    const screen = await renderScreen(<OnboardingFlow onDone={jest.fn()} />, {
      scenario: 'onboarding',
      insets: INSETS,
    });

    expect(topOf(screen, testIds.onboardingScreen)).toBeGreaterThanOrEqual(
      INSETS.top,
    );

    screen.unmount();
  });

  it('background step', async () => {
    const screen = await renderScreen(<BackgroundStep />, {insets: INSETS});

    expect(topOf(screen, backgroundStepTestIds.screen)).toBeGreaterThanOrEqual(
      INSETS.top,
    );

    screen.unmount();
  });
});

describe('the chassis clears the home indicator / gesture bar', () => {
  it('onboarding footer sits above the gesture bar', async () => {
    const screen = await renderScreen(<OnboardingFlow onDone={jest.fn()} />, {
      scenario: 'onboarding',
      insets: INSETS,
    });

    expect(
      bottomPadOf(screen, testIds.onboardingScreen),
    ).toBeGreaterThanOrEqual(INSETS.bottom);

    screen.unmount();
  });

  it('background step footer sits above the gesture bar', async () => {
    const screen = await renderScreen(<BackgroundStep />, {insets: INSETS});

    expect(
      bottomPadOf(screen, backgroundStepTestIds.screen),
    ).toBeGreaterThanOrEqual(INSETS.bottom);

    screen.unmount();
  });

  it('the settings version nameplate clears the gesture bar', async () => {
    const screen = await renderScreen(
      <SettingsScreen onBack={jest.fn()} onConnectPress={jest.fn()} />,
      {insets: INSETS},
    );

    // The `.vers` row used to be absolutely positioned against the frame and
    // state `24 + insets.bottom` as its own `bottom`. It is now the last
    // element *inside* the scroll content, so the same clearance is spelled in
    // two parts: its own bottom margin (the canvas's 24) plus the bottom inset
    // the frame hands to the content container. The guarantee is unchanged --
    // at least 24 + the gesture bar below the nameplate -- so this asserts the
    // sum rather than one absolute offset.
    const scroll = screen.root.findByType(ScrollView);
    const contentPadding =
      (
        StyleSheet.flatten(scroll.props.contentContainerStyle) as {
          paddingBottom?: number;
        }
      ).paddingBottom ?? 0;

    expect(
      (flatStyle(screen, testIds.settingsVersion).marginBottom ?? 0) +
        contentPadding,
    ).toBeGreaterThanOrEqual(spacing.lg + INSETS.bottom);

    screen.unmount();
  });
});
