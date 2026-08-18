import React from 'react';
import {context} from '@reatom/core';

import {RadioScreen} from '../src/screens/RadioScreen';
import {testIds} from '../src/ui/theme';
import {renderScreen} from '../jest/renderScreen';

jest.useFakeTimers({doNotFake: ['queueMicrotask']});

beforeEach(() => context.reset());

describe('the error state — spec section 13', () => {
  it('replaces the five states when the engine reports it is unrecoverable', async () => {
    const screen = await renderScreen(
      <RadioScreen onSettingsPress={jest.fn()} />,
      {scenario: 'engine-error'},
    );

    await screen.press(testIds.powerOnArea);
    await screen.advance(1300);
    expect(screen.findAll(testIds.errorState)).toHaveLength(0);

    await screen.advance(2000);

    expect(screen.findAll(testIds.errorState)).toHaveLength(1);
    expect(screen.findAll(testIds.pttArea)).toHaveLength(0);
    expect(screen.hasText('RADIO ERROR')).toBe(true);
    expect(screen.hasText('NEARBY_UNAVAILABLE')).toBe(true);
    expect(
      screen.hasText('Nearby Connections is unavailable on this device'),
    ).toBe(true);

    screen.unmount();
  });

  it('returns the UI to starting when the restart action is taken', async () => {
    const screen = await renderScreen(
      <RadioScreen onSettingsPress={jest.fn()} />,
      {scenario: 'engine-error'},
    );

    await screen.press(testIds.powerOnArea);
    await screen.advance(3100);
    expect(screen.findAll(testIds.errorState)).toHaveLength(1);

    await screen.press(testIds.errorRestart);

    expect(screen.findAll(testIds.errorState)).toHaveLength(0);
    expect(screen.hasText('SEARCHING FOR DEVICES...')).toBe(true);

    await screen.advance(1300);
    expect(screen.hasText('HOLD TO TALK')).toBe(true);

    screen.unmount();
  });

  it('can still be powered off from the error state', async () => {
    const screen = await renderScreen(
      <RadioScreen onSettingsPress={jest.fn()} />,
      {scenario: 'engine-error'},
    );

    await screen.press(testIds.powerOnArea);
    await screen.advance(3100);

    await screen.press('error-power-off');

    expect(screen.hasText('RADIO OFF')).toBe(true);
    screen.unmount();
  });

  it('renders the error state in Russian', async () => {
    const screen = await renderScreen(
      <RadioScreen onSettingsPress={jest.fn()} />,
      {scenario: 'engine-error', locale: 'ru'},
    );

    await screen.press(testIds.powerOnArea);
    await screen.advance(3100);

    expect(screen.hasText('ОШИБКА РАЦИИ')).toBe(true);
    expect(screen.hasText('ПЕРЕЗАПУСТИТЬ')).toBe(true);
    // The engine's own message is native text and is never translated.
    expect(
      screen.hasText('Nearby Connections is unavailable on this device'),
    ).toBe(true);

    screen.unmount();
  });
});
