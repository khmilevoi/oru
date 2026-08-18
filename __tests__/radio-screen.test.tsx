import React from 'react';
import {context} from '@reatom/core';

import {RadioScreen} from '../src/screens/RadioScreen';
import {motion, testIds, washes} from '../src/ui/theme';
import {renderScreen} from '../jest/renderScreen';
import type {MockScenarioName} from '../src/mock/mock.scenario';

jest.useFakeTimers({doNotFake: ['queueMicrotask']});

beforeEach(() => context.reset());

const openRadio = async (scenario: MockScenarioName) =>
  renderScreen(<RadioScreen onSettingsPress={jest.fn()} />, {scenario});

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
    expect(screen.hasText('HOLD TO TALK')).toBe(true);

    await screen.advance(6000);
    expect(screen.hasText('RECEIVING...')).toBe(true);

    await screen.advance(3100);
    expect(screen.hasText('HOLD TO TALK')).toBe(true);

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
    expect(screen.hasText('HOLD TO TALK')).toBe(true);

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
    expect(screen.hasText('HOLD TO TALK')).toBe(true);

    screen.unmount();
  });

  it('recedes the corner controls while transmitting', async () => {
    const screen = await openRadio('happy');
    await screen.press(testIds.powerOnArea);
    await screen.advance(2100);

    const before = screen.find('corner-controls').props.style;
    await screen.pressIn(testIds.pttArea);
    const during = screen.find('corner-controls').props.style;

    expect(JSON.stringify(during)).toContain(String(motion.recededOpacity));
    expect(JSON.stringify(before)).not.toEqual(JSON.stringify(during));

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
    expect(screen.hasText('УДЕРЖИВАЙТЕ ЧТОБЫ ГОВОРИТЬ')).toBe(true);

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
    expect(screen.hasText('HOLD TO TALK')).toBe(true);

    screen.unmount();
  });
});
