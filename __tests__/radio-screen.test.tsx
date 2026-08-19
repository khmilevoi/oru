import React from 'react';
import {StyleSheet} from 'react-native';
import {context} from '@reatom/core';

import {RadioScreen} from '../src/screens/RadioScreen';
import {icon, motion, testIds, washes} from '../src/ui/theme';
import {renderScreen} from '../jest/renderScreen';
import type {RenderedScreen} from '../jest/renderScreen';
import type {MockScenarioName} from '../src/mock/mock.scenario';

jest.useFakeTimers({doNotFake: ['queueMicrotask']});

beforeEach(() => context.reset());

const openRadio = async (scenario: MockScenarioName) =>
  renderScreen(<RadioScreen onSettingsPress={jest.fn()} />, {scenario});

/**
 * "Is the screen in READY?", asked of the glyph instead of the words.
 *
 * Every assertion below used to ask `hasText('HOLD TO TALK')`. That headline
 * was replaced by the microphone on 2026-08-19 (`design/01 Radio.dc.html`
 * frames 03 / 07 and the ICON SYSTEM note), so the state has no headline left
 * to match on -- and that is the point of the change, since the glyph is the
 * same in every locale while the string never was. The cradle arc belongs to
 * no other glyph on this screen, so its presence IS the ready state.
 *
 * The demoted one-word caption is asserted separately, where the copy itself is
 * the subject rather than a proxy for the state.
 */
const isReady = (screen: RenderedScreen) =>
  screen.findAll('mic-cradle').length === 1;

describe('RadioScreen — spec sections 12 and 12.1', () => {
  it('opens in off, with dead air and no scanning cue', async () => {
    const screen = await openRadio('happy');

    expect(screen.hasText('RADIO OFF')).toBe(true);
    expect(screen.hasText('TAP TO TURN ON')).toBe(true);
    expect(screen.findAll('pulse-dot')).toHaveLength(0);
    expect(screen.findAll(testIds.pttArea)).toHaveLength(0);

    screen.unmount();
  });

  it('walks off -> searching -> ready -> receiving on the happy scenario', async () => {
    const screen = await openRadio('happy');

    await screen.press(testIds.powerOnArea);
    expect(screen.hasText('SEARCHING FOR DEVICES...')).toBe(true);
    expect(screen.findAll('radio-pings')).toHaveLength(1);

    await screen.advance(2100);
    expect(screen.hasText('nearby')).toBe(true);
    expect(isReady(screen)).toBe(true);

    await screen.advance(6000);
    expect(screen.hasText('RECEIVING...')).toBe(true);

    await screen.advance(3100);
    expect(isReady(screen)).toBe(true);

    screen.unmount();
  });

  it('transmits while the PTT area is held', async () => {
    const screen = await openRadio('happy');
    await screen.press(testIds.powerOnArea);
    await screen.advance(2100);

    await screen.pressIn(testIds.pttArea);
    expect(screen.hasText('TRANSMITTING...')).toBe(true);
    expect(screen.hasText('RELEASE TO FINISH')).toBe(true);

    await screen.pressOut(testIds.pttArea);
    expect(isReady(screen)).toBe(true);

    screen.unmount();
  });

  it('shows the peer count as it rises', async () => {
    const screen = await openRadio('happy');
    await screen.press(testIds.powerOnArea);

    await screen.advance(2100);
    expect(screen.texts().join(' ')).toContain('1');

    await screen.advance(3000);
    expect(screen.texts().join(' ')).toContain('2');

    screen.unmount();
  });

  it('holds searching forever on solo', async () => {
    const screen = await openRadio('solo');
    await screen.press(testIds.powerOnArea);
    await screen.advance(60_000);

    expect(screen.hasText('SEARCHING FOR DEVICES...')).toBe(true);
    screen.unmount();
  });

  it('turns the radio off only after the full press-and-hold', async () => {
    const screen = await openRadio('happy');
    await screen.press(testIds.powerOnArea);
    await screen.advance(2100);

    await screen.pressIn(testIds.powerKey);
    await screen.advance(motion.powerHoldMs - 200);
    expect(screen.hasText('RADIO OFF')).toBe(false);

    await screen.pressOut(testIds.powerKey);
    await screen.advance(5000);
    expect(screen.hasText('RADIO OFF')).toBe(false);

    await screen.pressIn(testIds.powerKey);
    await screen.advance(motion.powerHoldMs + 100);

    expect(screen.hasText('RADIO OFF')).toBe(true);
    expect(screen.findAll(testIds.pttArea)).toHaveLength(0);

    screen.unmount();
  });

  it('returns to the scenario flow after the radio comes back on', async () => {
    const screen = await openRadio('happy');
    await screen.press(testIds.powerOnArea);
    await screen.advance(2100);

    await screen.pressIn(testIds.powerKey);
    await screen.advance(motion.powerHoldMs + 100);
    expect(screen.hasText('RADIO OFF')).toBe(true);

    await screen.press(testIds.powerOnArea);
    expect(screen.hasText('SEARCHING FOR DEVICES...')).toBe(true);

    await screen.advance(2100);
    expect(isReady(screen)).toBe(true);

    screen.unmount();
  });

  it('recedes only the power key while transmitting -- the gear stays live', async () => {
    // The canvas dims `.pwr` alone: `.gear` never carries `dim`
    // (design/01 Radio.dc.html frames 04 and 05).
    const screen = await openRadio('happy');
    await screen.press(testIds.powerOnArea);
    await screen.advance(2100);

    const before = screen.find('power-corner').props.style;
    await screen.pressIn(testIds.pttArea);
    const during = screen.find('power-corner').props.style;

    expect(JSON.stringify(during)).toContain(String(motion.recededOpacity));
    expect(JSON.stringify(before)).not.toEqual(JSON.stringify(during));
    expect(screen.find('power-corner').props.pointerEvents).toBe('none');

    // The whole corner container must not recede or go untappable with it.
    expect(JSON.stringify(screen.find('corner-controls').props.style)).not.toContain(
      String(motion.recededOpacity),
    );
    expect(screen.find('corner-controls').props.pointerEvents).not.toBe('none');

    screen.unmount();
  });

  it('opens settings from the gear even while transmitting', async () => {
    const onSettingsPress = jest.fn();
    const screen = await renderScreen(
      <RadioScreen onSettingsPress={onSettingsPress} />,
      {scenario: 'happy'},
    );
    await screen.press(testIds.powerOnArea);
    await screen.advance(2100);

    await screen.pressIn(testIds.pttArea);
    await screen.press(testIds.settingsGear);

    expect(onSettingsPress).toHaveBeenCalledTimes(1);
    screen.unmount();
  });

  it('opens settings from the gear', async () => {
    const onSettingsPress = jest.fn();
    const screen = await renderScreen(
      <RadioScreen onSettingsPress={onSettingsPress} />,
      {scenario: 'happy'},
    );

    await screen.press(testIds.settingsGear);

    expect(onSettingsPress).toHaveBeenCalledTimes(1);
    screen.unmount();
  });

  it('renders every state in Russian', async () => {
    const screen = await renderScreen(
      <RadioScreen onSettingsPress={jest.fn()} />,
      {scenario: 'happy', locale: 'ru'},
    );

    expect(screen.hasText('РАЦИЯ ВЫКЛЮЧЕНА')).toBe(true);
    expect(screen.hasText('НАЖМИТЕ ЧТОБЫ ВКЛЮЧИТЬ')).toBe(true);

    await screen.press(testIds.powerOnArea);
    expect(screen.hasText('ИЩЕМ УСТРОЙСТВА...')).toBe(true);

    await screen.advance(2100);
    // The locale that forced the change: «УДЕРЖИВАЙТЕ ЧТОБЫ ГОВОРИТЬ» needed
    // its own type size and its own line break, and still wrapped to three
    // lines on a real device. The glyph is identical in both locales; only the
    // one-word caption is translated.
    expect(isReady(screen)).toBe(true);
    expect(screen.hasText('УДЕРЖИВАЙТЕ')).toBe(true);

    await screen.pressIn(testIds.pttArea);
    expect(screen.hasText('ПЕРЕДАЧА...')).toBe(true);
    await screen.pressOut(testIds.pttArea);

    await screen.advance(6000);
    expect(screen.hasText('ПРИЁМ...')).toBe(true);

    screen.unmount();
  });
});

describe('RadioScreen — design/01 Radio.dc.html', () => {
  it('sits the corner controls at the foot of the screen', async () => {
    const screen = await renderScreen(
      <RadioScreen onSettingsPress={jest.fn()} />,
      {scenario: 'happy'},
    );
    await screen.press(testIds.powerOnArea);

    const style = JSON.stringify(screen.find('corner-controls').props.style);
    expect(style).toContain('bottom');
    expect(style).not.toContain('"top"');

    screen.unmount();
  });

  it('shows the ping rings while searching and the ring once ready', async () => {
    const screen = await renderScreen(
      <RadioScreen onSettingsPress={jest.fn()} />,
      {scenario: 'happy'},
    );

    await screen.press(testIds.powerOnArea);
    expect(screen.findAll('radio-pings')).toHaveLength(1);
    expect(screen.findAll('radio-ring')).toHaveLength(0);

    await screen.advance(2100);
    expect(screen.findAll('radio-ring')).toHaveLength(1);
    expect(screen.findAll('radio-pings')).toHaveLength(0);

    screen.unmount();
  });

  it('washes the screen with the canvas gradient while transmitting', async () => {
    const screen = await renderScreen(
      <RadioScreen onSettingsPress={jest.fn()} />,
      {scenario: 'happy'},
    );

    await screen.press(testIds.powerOnArea);
    await screen.advance(2100);
    await screen.pressIn(testIds.pttArea);

    expect(JSON.stringify(screen.find(testIds.radioScreen).props.style)).toContain(
      washes.tx,
    );
    expect(screen.findAll('radio-bars')).toHaveLength(1);

    screen.unmount();
  });

  /**
   * This test used to assert the exact opposite: that the ready headline took
   * `.holden` (40pt) in `en` and dropped to `.holdword` (33pt) everywhere else,
   * because «УДЕРЖИВАЙТЕ ЧТОБЫ ГОВОРИТЬ» did not fit the 302 ring at 40.
   *
   * That per-locale type scale is exactly what the 2026-08-19 icon change
   * deleted, and the reason it deleted it: "A GLYPH IS THE SAME SIZE IN EVERY
   * LANGUAGE." So the assertion is inverted -- the ring's content must now be
   * byte-for-byte identical across locales, which is a stronger guarantee than
   * the one it replaces and the whole payoff of the change.
   */
  it('draws the same ready glyph at the same size in every locale', async () => {
    const readyGlyph = async (locale: 'en' | 'ru') => {
      const screen = await renderScreen(
        <RadioScreen onSettingsPress={jest.fn()} />,
        {scenario: 'happy', locale},
      );
      await screen.press(testIds.powerOnArea);
      await screen.advance(2100);
      const shape = JSON.stringify(
        ['mic-capsule', 'mic-cradle', 'mic-stem', 'mic-base'].map(part =>
          StyleSheet.flatten(screen.find(part).props.style),
        ),
      );
      screen.unmount();
      return shape;
    };

    const en = await readyGlyph('en');
    expect(await readyGlyph('ru')).toEqual(en);
    // And it is drawn at the control idiom, not at some inherited type size.
    expect(en).toContain(`"borderWidth":${icon.controlStroke}`);
  });

  it('moves the nearby count out of the headline and into the peer row', async () => {
    const screen = await renderScreen(
      <RadioScreen onSettingsPress={jest.fn()} />,
      {scenario: 'happy'},
    );

    await screen.press(testIds.powerOnArea);
    await screen.advance(2100);

    expect(screen.findAll('radio-peer')).toHaveLength(1);
    expect(screen.find(testIds.radioStateLabel).props.testID).toBe(
      testIds.radioStateLabel,
    );
    expect(isReady(screen)).toBe(true);

    screen.unmount();
  });
});

describe('the section 8 audio route readout', () => {
  it('is hidden while the radio is off', async () => {
    const screen = await openRadio('happy');

    expect(screen.findAll(testIds.audioRoute)).toHaveLength(0);

    screen.unmount();
  });

  it('names the speaker once the radio is on', async () => {
    const screen = await openRadio('happy');
    await screen.press(testIds.powerOnArea);
    await screen.advance(1000);

    expect(screen.findAll(testIds.audioRoute)).toHaveLength(1);
    // The generic device word is gone -- the glyph says "speaker", in every
    // locale at once. Only a Bluetooth route adds text of its own.
    expect(screen.find(testIds.audioRoute).props.testID).toBe(testIds.audioRoute);
    expect(screen.hasText('radio')).toBe(true);
    expect(screen.hasText('Speaker')).toBe(false);

    screen.unmount();
  });

  it('follows the engine onto the headset and into media', async () => {
    const screen = await openRadio('happy');
    await screen.press(testIds.powerOnArea);

    await screen.advance(3500);
    expect(screen.hasText('AirPods Pro · radio')).toBe(true);

    await screen.advance(3000);
    expect(screen.hasText('AirPods Pro · music, phone mic')).toBe(true);

    screen.unmount();
  });

  it('stays put while receiving -- it names the live mic', async () => {
    const screen = await openRadio('happy');
    await screen.press(testIds.powerOnArea);
    await screen.advance(9000);

    expect(screen.hasText('RECEIVING...')).toBe(true);
    expect(screen.findAll(testIds.audioRoute)).toHaveLength(1);
    // It is a sibling of the corner controls, not a child: the corners
    // recede while live and the readout must not, so it must never turn up
    // among the corner controls' own descendants.
    expect(
      screen
        .find('corner-controls')
        .findAll(node => node.props.testID === testIds.audioRoute),
    ).toHaveLength(0);

    screen.unmount();
  });

  it('renders in Russian', async () => {
    const screen = await renderScreen(<RadioScreen onSettingsPress={jest.fn()} />, {
      scenario: 'happy',
      locale: 'ru',
    });
    await screen.press(testIds.powerOnArea);
    await screen.advance(1000);

    expect(screen.hasText('рация')).toBe(true);
    expect(screen.hasText('Динамик')).toBe(false);

    screen.unmount();
  });
});
