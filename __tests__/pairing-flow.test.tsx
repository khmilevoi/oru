import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import {I18nProvider} from '@lingui/react';
import {i18n} from '@lingui/core';
import {context} from '@reatom/core';
import type {ReactTestInstance} from 'react-test-renderer';

import {PairingFlow} from '../src/screens/PairingFlow';
import {radio, radioEventListener} from '../src/radio/radio.model';
import {RadioNative} from '../src/radio/radio.native';
import {testIds} from '../src/ui/theme';
import {renderScreen} from '../jest/renderScreen';

/** Same walk `renderScreen` does internally over the rendered tree. */
const collectText = (node: ReactTestInstance | string): string[] =>
  typeof node === 'string' ? [node] : node.children.flatMap(collectText);

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

  it('does not let an abandoned session clobber a freshly reopened one', async () => {
    const abandoned = await renderScreen(<PairingFlow onClose={jest.fn()} />, {
      scenario: 'pairing-success',
    });

    // Well under `pairing-success`'s scanMs (900ms): the session is still
    // pending underneath -- its `configurePtt()` promise has not settled.
    await abandoned.advance(200);
    expect(abandoned.hasText('Searching for Bluetooth buttons...')).toBe(true);

    // Back out before the scan settles. `resetPairing` only clears the local
    // `pairingError` atom; it never touches the engine session, so the
    // suspended `startPairing()` continuation is left dangling rather than
    // aborted.
    abandoned.unmount();

    // Reopen: a fresh mount in the *same* reatom context -- no
    // `context.reset()` in between, exactly like a real screen remount --
    // which is what lets a superseded session's continuation reach a live one.
    const subscription = RadioNative.subscribe(radioEventListener);
    if (subscription instanceof Error) throw subscription;

    let renderer: ReactTestRenderer.ReactTestRenderer | undefined;
    await ReactTestRenderer.act(async () => {
      renderer = ReactTestRenderer.create(
        <I18nProvider i18n={i18n}>
          <PairingFlow onClose={jest.fn()} />
        </I18nProvider>,
      );
    });
    const tree = renderer as ReactTestRenderer.ReactTestRenderer;

    // Flush the microtask chain the abandoned session's now-rejected
    // `configurePtt()` promise resolves through (`invoke` -> `RadioNative` ->
    // `radio.configurePtt()` -> `startPairing()`), without advancing the
    // fresh session's own scan timer.
    await ReactTestRenderer.act(async () => {
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
    });

    const text = collectText(tree.root).join('');
    expect(text).toContain('Searching for Bluetooth buttons...');
    expect(text).not.toContain('No buttons found');

    subscription.remove();
    ReactTestRenderer.act(() => {
      tree.unmount();
    });
  });
});
