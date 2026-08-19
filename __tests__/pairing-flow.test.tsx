import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import {I18nProvider} from '@lingui/react';
import {i18n} from '@lingui/core';
import {context} from '@reatom/core';
import type {ReactTestInstance} from 'react-test-renderer';

import {PairingFlow} from '../src/screens/PairingFlow';
import {radio, radioEventListener} from '../src/radio/radio.model';
import {NativeRadioUnavailableError, RadioNative} from '../src/radio/radio.native';
import {pairingError} from '../src/ptt/ptt.pairing.model';
import {scanHintInset, testIds} from '../src/ui/theme';
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
    expect(screen.hasText('SCANNING FOR BLE DEVICES...')).toBe(true);
    expect(screen.findAll('pairing-pings')).toHaveLength(1);

    await screen.advance(1000);
    expect(screen.hasText('Found')).toBe(true);
    expect(screen.hasText('ORU-PTT-01')).toBe(true);
    expect(screen.hasText('BT-REMOTE')).toBe(true);

    await screen.press(`${testIds.pairingCandidate}-mock-ptt-01`);
    expect(screen.hasText('PRESS THE PTT BUTTON')).toBe(true);

    await screen.advance(1300);
    expect(screen.hasText('BUTTON CONNECTED')).toBe(true);
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

    expect(screen.hasText('SCANNING FOR BLE DEVICES...')).toBe(true);

    await screen.advance(2600);

    expect(screen.hasText('No buttons found')).toBe(true);
    expect(screen.findAll(testIds.pairingRetry)).toHaveLength(1);

    await screen.press(testIds.pairingRetry);
    expect(screen.hasText('SCANNING FOR BLE DEVICES...')).toBe(true);

    await screen.advance(2600);
    expect(screen.hasText('No buttons found')).toBe(true);

    screen.unmount();
  });

  it('shows a generic failure with the diagnostic verbatim for a non-scan failure', async () => {
    const screen = await renderScreen(<PairingFlow onClose={jest.fn()} />, {
      scenario: 'pairing-success',
    });

    expect(screen.hasText('SCANNING FOR BLE DEVICES...')).toBe(true);

    // A failure `configurePtt()` can return that is not the empty-scan
    // timeout -- the Turbo Module itself missing, say -- must not be
    // described as "no buttons found".
    const failure = new NativeRadioUnavailableError({moduleName: 'NativeRadio'});
    await screen.act(() => {
      pairingError.set(failure);
    });

    expect(screen.hasText('No buttons found')).toBe(false);
    expect(screen.hasText('Pairing failed')).toBe(true);
    expect(screen.hasText(failure.message)).toBe(true);
    expect(screen.findAll(testIds.pairingRetry)).toHaveLength(1);

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

    expect(screen.hasText('ИЩЕМ BLE-УСТРОЙСТВА...')).toBe(true);

    await screen.advance(1000);
    expect(screen.hasText('Найдено')).toBe(true);

    await screen.press(`${testIds.pairingCandidate}-mock-ptt-01`);
    expect(screen.hasText('НАЖМИТЕ КНОПКУ PTT')).toBe(true);

    await screen.advance(1300);
    expect(screen.hasText('КНОПКА ПОДКЛЮЧЕНА')).toBe(true);

    screen.unmount();
  });

  it('does not let an abandoned session clobber a freshly reopened one', async () => {
    const abandoned = await renderScreen(<PairingFlow onClose={jest.fn()} />, {
      scenario: 'pairing-success',
    });

    // Well under `pairing-success`'s scanMs (900ms): the session is still
    // pending underneath -- its `configurePtt()` promise has not settled.
    await abandoned.advance(200);
    expect(abandoned.hasText('SCANNING FOR BLE DEVICES...')).toBe(true);

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
    expect(text).toContain('SCANNING FOR BLE DEVICES...');
    expect(text).not.toContain('No buttons found');

    subscription.remove();
    ReactTestRenderer.act(() => {
      tree.unmount();
    });
  });
});

describe('PairingFlow — design/03 Pairing.dc.html', () => {
  it('scans behind the small ping set', async () => {
    const screen = await renderScreen(<PairingFlow onClose={jest.fn()} />, {
      scenario: 'happy',
    });

    expect(screen.findAll('pairing-pings')).toHaveLength(1);

    // `.scanhint` is absolutely positioned at the foot of the frame
    // (design/03 Pairing.dc.html: `position: absolute; bottom: 40px`), not a
    // third row of the centred stage.
    const hint = JSON.stringify(screen.find('pairing-scan-hint').props.style);
    expect(hint).toContain('"position":"absolute"');
    expect(hint).toContain(`"bottom":${scanHintInset.bottom}`);

    // Settle the in-flight scan (`SUCCESSFUL_PAIRING.scanMs`) before
    // unmounting: `jest.useFakeTimers()` is set up once for the whole file, so
    // its clock -- and any `setTimeout` the mock engine scheduled -- outlives
    // this test. Unmounting with `configurePtt()` still pending leaves a
    // dangling continuation that a *later* test's `renderScreen()` (which
    // calls `context.reset()`) can walk into once its own `advance()` crosses
    // this timer's threshold, throwing deep inside Reatom on an unrelated
    // test. Same root cause as `ui-state-ring.test.tsx`'s
    // reduced-motion-overlap bug, one layer further down the stack: settle
    // before unmount rather than leave it dangling across a test boundary.
    await screen.advance(1000);
    screen.unmount();
  });

  it('learns inside the amber ring', async () => {
    const screen = await renderScreen(<PairingFlow onClose={jest.fn()} />, {
      scenario: 'happy',
    });
    await screen.advance(1000);
    await screen.press(`${testIds.pairingCandidate}-mock-ptt-01`);

    expect(screen.findAll('pairing-ring')).toHaveLength(1);

    // Same reason as above: settle the in-flight learn step
    // (`SUCCESSFUL_PAIRING.learnMs`) before unmounting.
    await screen.advance(1300);
    screen.unmount();
  });

  it('confirms with the canvas tick', async () => {
    const screen = await renderScreen(<PairingFlow onClose={jest.fn()} />, {
      scenario: 'happy',
    });
    await screen.advance(1000);
    await screen.press(`${testIds.pairingCandidate}-mock-ptt-01`);
    await screen.advance(1300);

    expect(screen.findAll('pairing-tick')).toHaveLength(1);
    expect(screen.findAll(testIds.pairingDone)).toHaveLength(1);

    screen.unmount();
  });

  it('pulses the learning ring, motion-safe only', async () => {
    // `.learnring` carries the canvas `pulse` class (design/03 Pairing.dc.html),
    // declared under `@media (prefers-reduced-motion: no-preference)`.
    const learn = async (reducedMotion: boolean) => {
      const screen = await renderScreen(<PairingFlow onClose={jest.fn()} />, {
        scenario: 'happy',
        reducedMotion,
      });
      await screen.advance(1000);
      await screen.press(`${testIds.pairingCandidate}-mock-ptt-01`);
      const halos = screen.findAll('state-ring-pulse').length;
      await screen.advance(1300);
      screen.unmount();
      return halos;
    };

    expect(await learn(false)).toBe(1);
    expect(await learn(true)).toBe(0);
  });

  it('offers a ghost Cancel in the learn step footer', async () => {
    const onClose = jest.fn();
    const screen = await renderScreen(<PairingFlow onClose={onClose} />, {
      scenario: 'happy',
    });
    await screen.advance(1000);
    await screen.press(`${testIds.pairingCandidate}-mock-ptt-01`);

    // A `.pfoot` Cancel below the stage, on top of the header chevron
    // (design/03 Pairing.dc.html frame 03).
    const foot = screen.find('pairing-foot');
    expect(
      foot.findAll(node => node.props.testID === testIds.pairingCancelFooter),
    ).not.toHaveLength(0);

    await screen.press(testIds.pairingCancelFooter);
    expect(onClose).toHaveBeenCalledTimes(1);

    await screen.advance(1300);
    screen.unmount();
  });

  it('sits Done in the saved step footer, not the centred stage', async () => {
    const screen = await renderScreen(<PairingFlow onClose={jest.fn()} />, {
      scenario: 'happy',
    });
    await screen.advance(1000);
    await screen.press(`${testIds.pairingCandidate}-mock-ptt-01`);
    await screen.advance(1300);

    // design/03 Pairing.dc.html frame 04: the solid Done lives in `.pfoot`.
    const foot = screen.find('pairing-foot');
    expect(
      foot.findAll(node => node.props.testID === testIds.pairingDone),
    ).not.toHaveLength(0);

    screen.unmount();
  });
});
