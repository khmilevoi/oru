import React from 'react';
import {readFileSync, readdirSync} from 'fs';
import {join} from 'path';
import {context} from '@reatom/core';

import {PairingFlow} from '../src/screens/PairingFlow';
import {RadioScreen} from '../src/screens/RadioScreen';
import {SettingsScreen} from '../src/screens/SettingsScreen';
import {createHaptics, HAPTIC_EFFECTS} from '../src/app/haptics';
import {mockRadio} from '../src/radio/radio.native.mock';
import {radio} from '../src/radio/radio.model';
import {motion, testIds} from '../src/ui/theme';
import {renderScreen} from '../jest/renderScreen';

jest.useFakeTimers({doNotFake: ['queueMicrotask']});

beforeEach(() => context.reset());

/**
 * Every assertion here goes through the *native* call rather than through a
 * spy on `src/ui/haptics.ts`, so each test proves the whole chain — call site
 * names an intent, the policy maps it to an effect, the effect crosses the
 * section 6.1 bridge. A test that stubbed the policy module would still pass
 * if the mapping table were emptied.
 */
const watchHaptics = () =>
  jest.spyOn(mockRadio, 'performHaptic').mockResolvedValue(undefined);

/** The effects seen so far, in order, so press/release can be told apart. */
const effects = (spy: jest.SpyInstance) =>
  spy.mock.calls.map(call => call[0] as string);

afterEach(() => jest.restoreAllMocks());

describe('the key controls — the ones that must buzz', () => {
  it('parts transmit start from transmit end, so a pocketed phone is readable', async () => {
    const haptic = watchHaptics();
    const screen = await renderScreen(<RadioScreen onSettingsPress={jest.fn()} />, {
      scenario: 'happy',
    });

    await screen.press(testIds.powerOnArea);
    await screen.advance(2100);
    haptic.mockClear();

    await screen.pressIn(testIds.pttArea);
    expect(screen.hasText('TRANSMITTING...')).toBe(true);
    expect(effects(haptic)).toEqual([HAPTIC_EFFECTS.transmitStart]);

    await screen.pressOut(testIds.pttArea);
    expect(effects(haptic)).toEqual([
      HAPTIC_EFFECTS.transmitStart,
      HAPTIC_EFFECTS.transmitEnd,
    ]);

    // The whole point of the pair: the same buzz twice would say nothing about
    // which edge of the transmission the user just crossed.
    expect(HAPTIC_EFFECTS.transmitStart).not.toEqual(HAPTIC_EFFECTS.transmitEnd);

    screen.unmount();
  });

  it('marks the radio coming on, from the hero key and from the whole-screen tap', async () => {
    const haptic = watchHaptics();
    const screen = await renderScreen(<RadioScreen onSettingsPress={jest.fn()} />, {
      scenario: 'happy',
    });

    await screen.press(testIds.powerKey);
    expect(effects(haptic)).toEqual([HAPTIC_EFFECTS.powerOn]);

    screen.unmount();

    const tapped = await renderScreen(<RadioScreen onSettingsPress={jest.fn()} />, {
      scenario: 'happy',
    });
    haptic.mockClear();

    await tapped.press(testIds.powerOnArea);
    expect(effects(haptic)).toEqual([HAPTIC_EFFECTS.powerOn]);

    tapped.unmount();
  });

  it('seals the power-off hold at completion, and only at completion', async () => {
    const haptic = watchHaptics();
    const screen = await renderScreen(<RadioScreen onSettingsPress={jest.fn()} />, {
      scenario: 'happy',
    });

    await screen.press(testIds.powerOnArea);
    await screen.advance(2100);
    haptic.mockClear();

    // Half a hold, then a release: an aborted shut-off must not announce
    // anything, or the guard the hold exists to be stops meaning anything.
    await screen.pressIn(testIds.powerKey);
    await screen.advance(Math.floor(motion.powerHoldMs / 2));
    expect(effects(haptic)).toEqual([]);
    await screen.pressOut(testIds.powerKey);
    expect(effects(haptic)).toEqual([]);

    // A full hold: `design/01 Radio.dc.html`'s hold note — "THE CLOSE IS
    // ANNOUNCED BY THAT FLASH AND A HAPTIC". The flash is the closed perimeter
    // seal, held at 100% for `motion.sealCloseMs`; the buzz lands with the
    // shut-off at the end of it, so both announce the same moment.
    await screen.pressIn(testIds.powerKey);
    await screen.advance(motion.powerHoldMs);
    expect(effects(haptic)).toEqual([]);

    await screen.advance(motion.sealCloseMs + 1);
    expect(effects(haptic)).toEqual([HAPTIC_EFFECTS.powerOff]);
    expect(screen.hasText('RADIO OFF')).toBe(true);

    screen.unmount();
  });

  it('confirms the pairing moment once, when the binding is saved', async () => {
    const haptic = watchHaptics();
    const screen = await renderScreen(<PairingFlow onClose={jest.fn()} />, {
      scenario: 'pairing-success',
    });

    await screen.advance(1000);
    expect(effects(haptic)).toEqual([]);

    await screen.press(`${testIds.pairingCandidate}-mock-ptt-01`);
    expect(effects(haptic)).toEqual([]);

    await screen.advance(1300);
    expect(screen.hasText('BUTTON CONNECTED')).toBe(true);
    expect(effects(haptic)).toEqual([HAPTIC_EFFECTS.paired]);

    // Still one after further renders of the same saved step: this fires on the
    // transition, not on every pass through it.
    await screen.advance(500);
    expect(effects(haptic)).toEqual([HAPTIC_EFFECTS.paired]);

    screen.unmount();
  });
});

/**
 * The other half of the product decision, pinned so it cannot rot: the owner
 * asked for the *key* controls, and a set that quietly grows until every tap
 * buzzes is the same as no policy at all.
 */
describe('the controls that must stay silent', () => {
  it('says nothing for the settings gear', async () => {
    const haptic = watchHaptics();
    const screen = await renderScreen(<RadioScreen onSettingsPress={jest.fn()} />, {
      scenario: 'happy',
    });

    await screen.press(testIds.powerOnArea);
    await screen.advance(2100);
    haptic.mockClear();

    await screen.press(testIds.settingsGear);
    expect(effects(haptic)).toEqual([]);

    screen.unmount();
  });

  it('says nothing anywhere in Settings — including the Test key', async () => {
    const haptic = watchHaptics();
    const screen = await renderScreen(
      <SettingsScreen onBack={jest.fn()} onConnectPress={jest.fn()} />,
      {scenario: 'button-lost'},
    );

    await screen.act(() => radio.start());
    await screen.advance(1300);
    haptic.mockClear();

    // The Test key drives the very same `pressPtt`/`releasePtt` as the talk
    // area and still stays silent — see the comment in `SettingsScreen.tsx`.
    await screen.pressIn(testIds.pttTest);
    await screen.pressOut(testIds.pttTest);
    await screen.press(testIds.pttReplace);
    await screen.press(`${testIds.audioMode}-media`);
    await screen.press(`${testIds.appLocale}-ru`);
    await screen.press(testIds.settingsBack);

    expect(effects(haptic)).toEqual([]);

    screen.unmount();
  });

  it('says nothing for cancel, retry or done in the pairing flow', async () => {
    const haptic = watchHaptics();
    const screen = await renderScreen(<PairingFlow onClose={jest.fn()} />, {
      scenario: 'pairing-empty',
    });

    await screen.advance(2600);
    expect(screen.hasText('No buttons found')).toBe(true);

    await screen.press(testIds.pairingRetry);
    await screen.press(testIds.pairingCancel);
    expect(effects(haptic)).toEqual([]);

    screen.unmount();
  });

  /**
   * The structural half of the same pin. Pressing every excluded control on
   * every screen would be a suite of its own and would still miss the next
   * screen somebody writes; naming the only two files allowed to reach for the
   * policy module is one line to check and impossible to widen by accident.
   */
  it('is reached for by exactly two screens and nothing else', () => {
    const root = join(__dirname, '..', 'src');

    const walk = (dir: string): string[] =>
      readdirSync(dir, {withFileTypes: true}).flatMap(entry => {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) return walk(path);
        return /\.tsx?$/.test(entry.name) ? [path] : [];
      });

    const importers = walk(root)
      .filter(path => !path.endsWith(join('app', 'haptics.ts')))
      .filter(path => /from '[^']*app\/haptics'/.test(readFileSync(path, 'utf8')))
      .map(path => path.slice(root.length + 1))
      .sort();

    expect(importers).toEqual([
      join('screens', 'PairingFlow.tsx'),
      join('screens', 'RadioScreen.tsx'),
    ]);
  });
});

describe('a haptic never breaks the interaction it decorates', () => {
  it('stays silent, and synchronous, when the native side rejects', () => {
    const haptics = createHaptics(() => Promise.reject(new Error('no generator')));

    // Returns nothing at all: no call site can await it, so no call site can
    // ever be held up or thrown into by a buzz that did not happen.
    expect(haptics.transmitStart()).toBeUndefined();
  });

  it('stays silent when the native method is missing entirely', () => {
    // The realistic shape of this failure: a JS bundle newer than the native
    // binary it is running against, where `performHaptic` simply is not there.
    const absent = undefined as unknown as (effect: string) => Promise<void>;
    const haptics = createHaptics(effect => absent(effect));

    expect(() => haptics.powerOff()).not.toThrow();
  });

  it('leaves no unhandled rejection behind', async () => {
    jest.useRealTimers();
    const unhandled: unknown[] = [];
    const record = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', record);

    try {
      const haptics = createHaptics(() => Promise.reject(new Error('boom')));
      haptics.paired();
      await new Promise(resolve => setImmediate(resolve));
      await new Promise(resolve => setImmediate(resolve));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', record);
      jest.useFakeTimers({doNotFake: ['queueMicrotask']});
    }
  });

  it('still transmits when every haptic call rejects', async () => {
    jest
      .spyOn(mockRadio, 'performHaptic')
      .mockRejectedValue(new Error('no generator'));

    const screen = await renderScreen(<RadioScreen onSettingsPress={jest.fn()} />, {
      scenario: 'happy',
    });

    await screen.press(testIds.powerOnArea);
    await screen.advance(2100);

    await screen.pressIn(testIds.pttArea);
    expect(screen.hasText('TRANSMITTING...')).toBe(true);

    await screen.pressOut(testIds.pttArea);
    expect(screen.hasText('HOLD TO TALK')).toBe(true);

    screen.unmount();
  });
});
