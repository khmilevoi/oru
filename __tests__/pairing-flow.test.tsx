import React from 'react';
import {context} from '@reatom/core';

import {PairingFlow} from '../src/screens/PairingFlow';
import {radio} from '../src/radio/radio.model';
import {testIds} from '../src/ui/theme';
import {renderScreen} from '../jest/renderScreen';

jest.useFakeTimers({doNotFake: ['queueMicrotask']});

beforeEach(() => context.reset());

describe('the pairing flow — spec sections 9.3 and 12.1', () => {
  it('walks scan -> pick -> learn -> saved on pairing-success', async () => {
    const onClose = jest.fn();
    const screen = await renderScreen(<PairingFlow onClose={onClose} />, {
      scenario: 'pairing-success',
    });

    // No `radio.start()` anywhere in this suite: the flow opens its own session
    // on mount, and starting the radio afterwards would cancel it -- `start()`
    // cancels every pending timer and aborts an in-flight pairing by design.
    expect(screen.hasText('Searching for Bluetooth buttons...')).toBe(true);
    expect(screen.findAll('pulse-dot')).toHaveLength(1);

    await screen.advance(1000);
    expect(screen.hasText('Select your button')).toBe(true);
    expect(screen.hasText('ORU-PTT-01')).toBe(true);
    expect(screen.hasText('BT-REMOTE')).toBe(true);

    await screen.press(`${testIds.pairingCandidate}-mock-ptt-01`);
    expect(screen.hasText('Press the PTT button')).toBe(true);

    await screen.advance(1300);
    expect(screen.hasText('Button saved')).toBe(true);
    expect(radio().pttButton).toEqual({
      configured: true,
      connected: true,
      name: 'ORU-PTT-01',
    });

    await screen.press(testIds.pairingDone);
    expect(onClose).toHaveBeenCalledTimes(1);

    screen.unmount();
  });

  it('offers the retry path on pairing-empty', async () => {
    const screen = await renderScreen(<PairingFlow onClose={jest.fn()} />, {
      scenario: 'pairing-empty',
    });

    expect(screen.hasText('Searching for Bluetooth buttons...')).toBe(true);

    await screen.advance(2600);

    expect(screen.hasText('No buttons found')).toBe(true);
    expect(screen.findAll(testIds.pairingRetry)).toHaveLength(1);

    await screen.press(testIds.pairingRetry);
    expect(screen.hasText('Searching for Bluetooth buttons...')).toBe(true);

    await screen.advance(2600);
    expect(screen.hasText('No buttons found')).toBe(true);

    screen.unmount();
  });

  it('cancels back to the caller from any step', async () => {
    const onClose = jest.fn();
    const screen = await renderScreen(<PairingFlow onClose={onClose} />, {
      scenario: 'pairing-success',
    });

    await screen.advance(1000);
    await screen.press(testIds.pairingCancel);

    expect(onClose).toHaveBeenCalledTimes(1);
    screen.unmount();
  });

  it('renders every step in Russian', async () => {
    const screen = await renderScreen(<PairingFlow onClose={jest.fn()} />, {
      scenario: 'pairing-success',
      locale: 'ru',
    });

    expect(screen.hasText('Ищем Bluetooth-кнопки...')).toBe(true);

    await screen.advance(1000);
    expect(screen.hasText('Выберите вашу кнопку')).toBe(true);

    await screen.press(`${testIds.pairingCandidate}-mock-ptt-01`);
    expect(screen.hasText('Нажмите кнопку PTT')).toBe(true);

    await screen.advance(1300);
    expect(screen.hasText('Кнопка сохранена')).toBe(true);

    screen.unmount();
  });
});
