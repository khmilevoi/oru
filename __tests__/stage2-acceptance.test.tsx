import React from 'react';
import {context} from '@reatom/core';

import {OnboardingFlow} from '../src/screens/OnboardingFlow';
import {PairingFlow} from '../src/screens/PairingFlow';
import {RadioScreen} from '../src/screens/RadioScreen';
import {SettingsScreen} from '../src/screens/SettingsScreen';
import {MOCK_SCENARIOS} from '../src/mock/mock.scenario';
import {radio} from '../src/radio/radio.model';
import {motion, testIds} from '../src/ui/theme';
import {renderScreen} from '../jest/renderScreen';

jest.useFakeTimers({doNotFake: ['queueMicrotask']});

beforeEach(() => context.reset());

const LOCALES = ['en', 'ru'] as const;

const COPY = {
  en: {
    off: 'RADIO OFF',
    searching: 'SEARCHING FOR DEVICES...',
    ready: 'HOLD TO TALK',
    transmitting: 'TRANSMITTING...',
    receiving: 'RECEIVING...',
    error: 'RADIO ERROR',
    restart: 'RESTART RADIO',
    pairingSaved: 'Button saved',
    pairingEmpty: 'No buttons found',
    onboardingDenied: 'Permission denied',
    onboardingReady: 'Ready',
  },
  ru: {
    off: 'РАЦИЯ ВЫКЛЮЧЕНА',
    searching: 'ИЩЕМ УСТРОЙСТВА...',
    ready: 'УДЕРЖИВАЙТЕ ЧТОБЫ ГОВОРИТЬ',
    transmitting: 'ПЕРЕДАЧА...',
    receiving: 'ПРИЁМ...',
    error: 'ОШИБКА РАЦИИ',
    restart: 'ПЕРЕЗАПУСТИТЬ',
    pairingSaved: 'Кнопка сохранена',
    pairingEmpty: 'Кнопки не найдены',
    onboardingDenied: 'Разрешение отклонено',
    onboardingReady: 'Готово',
  },
} as const;

describe.each(LOCALES)('spec section 15 Stage 2 — locale %s', locale => {
  const copy = COPY[locale];

  it('makes all five main-screen states reachable and visually distinct', async () => {
    const screen = await renderScreen(
      <RadioScreen onSettingsPress={jest.fn()} />,
      {scenario: 'happy', locale},
    );

    const seen = new Map<string, string>();
    const capture = (state: string) => {
      seen.set(
        state,
        JSON.stringify(screen.find(testIds.radioScreen).props.style) +
          screen.texts().join('|'),
      );
    };

    expect(screen.hasText(copy.off)).toBe(true);
    capture('off');

    await screen.press(testIds.powerOnArea);
    expect(screen.hasText(copy.searching)).toBe(true);
    capture('searching');

    await screen.advance(2100);
    expect(screen.hasText(copy.ready)).toBe(true);
    capture('ready');

    await screen.pressIn(testIds.pttArea);
    expect(screen.hasText(copy.transmitting)).toBe(true);
    capture('transmitting');
    await screen.pressOut(testIds.pttArea);

    await screen.advance(6000);
    expect(screen.hasText(copy.receiving)).toBe(true);
    capture('receiving');

    expect(seen.size).toBe(5);
    expect(new Set(seen.values()).size).toBe(5);

    screen.unmount();
  });

  it('turns the radio off from any scenario and back into its normal flow', async () => {
    for (const scenario of MOCK_SCENARIOS) {
      const screen = await renderScreen(
        <RadioScreen onSettingsPress={jest.fn()} />,
        {scenario, locale},
      );

      await screen.press(testIds.powerOnArea);
      await screen.advance(900);

      if (screen.findAll(testIds.powerKey).length > 0) {
        await screen.pressIn(testIds.powerKey);
        await screen.advance(motion.powerHoldMs + 100);
      } else {
        // The error state carries its own power-off key.
        await screen.press('error-power-off');
      }

      expect(screen.hasText(copy.off)).toBe(true);
      expect(screen.findAll(testIds.pttArea)).toHaveLength(0);

      await screen.press(testIds.powerOnArea);
      expect(screen.hasText(copy.searching)).toBe(true);

      screen.unmount();
    }
  });

  it('completes the pairing flow on pairing-success', async () => {
    const screen = await renderScreen(<PairingFlow onClose={jest.fn()} />, {
      scenario: 'pairing-success',
      locale,
    });

    // The flow opens its own session on mount; `radio.start()` would cancel it.
    await screen.advance(1000);
    await screen.press(`${testIds.pairingCandidate}-mock-ptt-01`);
    await screen.advance(1300);

    expect(screen.hasText(copy.pairingSaved)).toBe(true);
    screen.unmount();
  });

  it('offers the empty / retry path on pairing-empty', async () => {
    const screen = await renderScreen(<PairingFlow onClose={jest.fn()} />, {
      scenario: 'pairing-empty',
      locale,
    });

    await screen.advance(2600);

    expect(screen.hasText(copy.pairingEmpty)).toBe(true);
    expect(screen.findAll(testIds.pairingRetry)).toHaveLength(1);

    screen.unmount();
  });

  it('walks onboarding through every step, including a denied permission', async () => {
    const onDone = jest.fn();
    const screen = await renderScreen(<OnboardingFlow onDone={onDone} />, {
      scenario: 'onboarding',
      locale,
    });

    await screen.press(testIds.onboardingAllow);
    await screen.press(testIds.onboardingAllow);
    expect(screen.hasText(copy.onboardingDenied)).toBe(true);

    await screen.press(testIds.onboardingSkip);
    await screen.press(testIds.onboardingAllow);
    await screen.press(testIds.onboardingSkip);

    expect(screen.hasText(copy.onboardingReady)).toBe(true);
    await screen.press(testIds.onboardingStart);
    expect(onDone).toHaveBeenCalledTimes(1);

    screen.unmount();
  });

  it('shows the error state on engine-error and restarts into starting', async () => {
    const screen = await renderScreen(
      <RadioScreen onSettingsPress={jest.fn()} />,
      {scenario: 'engine-error', locale},
    );

    await screen.press(testIds.powerOnArea);
    await screen.advance(3100);

    expect(screen.hasText(copy.error)).toBe(true);
    expect(screen.hasText(copy.restart)).toBe(true);

    await screen.press(testIds.errorRestart);

    expect(radio().status).toBe('starting');
    expect(screen.findAll(testIds.errorState)).toHaveLength(0);
    expect(screen.hasText(copy.searching)).toBe(true);

    screen.unmount();
  });

  it('honours reduced motion everywhere the design animates', async () => {
    const screen = await renderScreen(
      <RadioScreen onSettingsPress={jest.fn()} />,
      {scenario: 'happy', locale, reducedMotion: true},
    );

    await screen.press(testIds.powerOnArea);
    const dot = screen.find('pulse-dot');
    const before = JSON.stringify(dot.props.style);

    await screen.advance(motion.pulseMs * 2);

    expect(JSON.stringify(screen.find('pulse-dot').props.style)).toEqual(before);
    screen.unmount();
  });

  it('reaches Settings from the main screen in both button states', async () => {
    const onSettingsPress = jest.fn();
    const screen = await renderScreen(
      <RadioScreen onSettingsPress={onSettingsPress} />,
      {scenario: 'button-lost', locale},
    );

    await screen.press(testIds.settingsGear);
    await screen.press(testIds.powerOnArea);
    await screen.advance(1300);
    await screen.press(testIds.settingsGear);

    expect(onSettingsPress).toHaveBeenCalledTimes(2);
    screen.unmount();
  });

  it('renders the Settings PTT section in both button states', async () => {
    const screen = await renderScreen(
      <SettingsScreen onBack={jest.fn()} onConnectPress={jest.fn()} />,
      {scenario: 'button-lost', locale},
    );

    expect(screen.find(testIds.pttStatus)).toBeDefined();

    await screen.act(() => radio.start());
    await screen.advance(1300);
    expect(screen.hasText('ORU-PTT-01')).toBe(true);

    screen.unmount();
  });
});
