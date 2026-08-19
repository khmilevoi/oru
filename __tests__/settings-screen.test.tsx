import React from 'react';
import {context} from '@reatom/core';

import {SettingsScreen} from '../src/screens/SettingsScreen';
import {radio} from '../src/radio/radio.model';
import {testIds} from '../src/ui/theme';
import {renderScreen} from '../jest/renderScreen';

jest.useFakeTimers({doNotFake: ['queueMicrotask']});

beforeEach(() => context.reset());

describe('SettingsScreen — spec section 12', () => {
  it('offers Connect when no button is configured', async () => {
    const onConnectPress = jest.fn();
    const screen = await renderScreen(
      <SettingsScreen onBack={jest.fn()} onConnectPress={onConnectPress} />,
      {scenario: 'happy'},
    );

    expect(screen.hasText('PTT button')).toBe(true);
    expect(screen.hasText('Not connected')).toBe(true);
    expect(screen.findAll(testIds.pttTest)).toHaveLength(0);
    expect(screen.findAll(testIds.pttReplace)).toHaveLength(0);

    await screen.press(testIds.pttConnect);
    expect(onConnectPress).toHaveBeenCalledTimes(1);

    screen.unmount();
  });

  it('shows the name and the connection state of a configured button', async () => {
    const screen = await renderScreen(
      <SettingsScreen onBack={jest.fn()} onConnectPress={jest.fn()} />,
      {scenario: 'button-lost'},
    );

    await screen.act(() => radio.start());
    await screen.advance(1300);

    expect(screen.hasText('ORU-PTT-01')).toBe(true);
    expect(screen.hasText('Connected')).toBe(true);
    expect(screen.findAll(testIds.pttConnect)).toHaveLength(0);

    await screen.advance(3000);
    expect(screen.hasText('Disconnected')).toBe(true);

    await screen.advance(5100);
    expect(screen.hasText('Connected')).toBe(true);

    screen.unmount();
  });

  it('drives the engine transmit path from the Test key', async () => {
    const screen = await renderScreen(
      <SettingsScreen onBack={jest.fn()} onConnectPress={jest.fn()} />,
      {scenario: 'button-lost'},
    );

    await screen.act(() => radio.start());
    await screen.advance(1300);

    await screen.pressIn(testIds.pttTest);
    expect(radio().transmitting).toBe(true);

    await screen.pressOut(testIds.pttTest);
    expect(radio().transmitting).toBe(false);

    screen.unmount();
  });

  it('re-opens the learning flow from Replace', async () => {
    const onConnectPress = jest.fn();
    const screen = await renderScreen(
      <SettingsScreen onBack={jest.fn()} onConnectPress={onConnectPress} />,
      {scenario: 'button-lost'},
    );

    await screen.act(() => radio.start());
    await screen.advance(1300);
    await screen.press(testIds.pttReplace);

    expect(onConnectPress).toHaveBeenCalledTimes(1);
    screen.unmount();
  });

  it('goes back', async () => {
    const onBack = jest.fn();
    const screen = await renderScreen(
      <SettingsScreen onBack={onBack} onConnectPress={jest.fn()} />,
      {scenario: 'happy'},
    );

    await screen.press(testIds.settingsBack);

    expect(onBack).toHaveBeenCalledTimes(1);
    screen.unmount();
  });

  it('renders in Russian', async () => {
    const screen = await renderScreen(
      <SettingsScreen onBack={jest.fn()} onConnectPress={jest.fn()} />,
      {scenario: 'happy', locale: 'ru'},
    );

    expect(screen.hasText('НАСТРОЙКИ')).toBe(true);
    expect(screen.hasText('PTT-кнопка')).toBe(true);
    expect(screen.hasText('Не подключена')).toBe(true);
    expect(screen.hasText('Подключить')).toBe(true);

    screen.unmount();
  });
});

describe('SettingsScreen — design/02 Settings.dc.html', () => {
  it('puts the button in a card with a two-up action row', async () => {
    const screen = await renderScreen(
      <SettingsScreen onBack={jest.fn()} onConnectPress={jest.fn()} />,
      {scenario: 'button-lost'},
    );
    await screen.act(() => radio.start());

    expect(screen.findAll('settings-card')).toHaveLength(1);
    expect(screen.findAll(testIds.pttTest)).toHaveLength(1);
    expect(screen.findAll(testIds.pttReplace)).toHaveLength(1);

    screen.unmount();
  });

  it('explains the button and shows a version footer when nothing is paired', async () => {
    const screen = await renderScreen(
      <SettingsScreen onBack={jest.fn()} onConnectPress={jest.fn()} />,
    );

    expect(screen.hasText('without taking the phone out')).toBe(true);
    expect(screen.findAll(testIds.settingsVersion)).toHaveLength(1);

    screen.unmount();
  });
});

describe('the section 8 audio mode setting', () => {
  const openSettings = (locale?: 'en' | 'ru') =>
    renderScreen(
      <SettingsScreen onBack={jest.fn()} onConnectPress={jest.fn()} />,
      locale ? {scenario: 'happy', locale} : {scenario: 'happy'},
    );

  it('offers the three modes with auto selected by default', async () => {
    const screen = await openSettings();

    expect(screen.hasText('Audio')).toBe(true);
    expect(screen.hasText('Auto')).toBe(true);
    expect(screen.hasText('Radio')).toBe(true);
    expect(screen.hasText('Music')).toBe(true);
    expect(
      screen.find(`${testIds.audioMode}-auto`).props.accessibilityState,
    ).toEqual({selected: true});

    screen.unmount();
  });

  it('explains what the setting is for', async () => {
    const screen = await openSettings();

    expect(screen.hasText('What a Bluetooth headset is for.')).toBe(true);

    screen.unmount();
  });

  it('pins the mode through the engine and mirrors what comes back', async () => {
    const screen = await openSettings();

    await screen.press(`${testIds.audioMode}-media`);

    expect(radio().audioMode).toBe('media');
    expect(
      screen.find(`${testIds.audioMode}-media`).props.accessibilityState,
    ).toEqual({selected: true});
    expect(
      screen.find(`${testIds.audioMode}-auto`).props.accessibilityState,
    ).toEqual({selected: false});

    screen.unmount();
  });

  it('offers no device picker -- the pin is the only audio control', async () => {
    const screen = await openSettings();

    expect(screen.findAll('audio-device-picker')).toHaveLength(0);
    expect(screen.findAll(testIds.audioMode)).toHaveLength(1);

    screen.unmount();
  });

  it('renders in Russian', async () => {
    const screen = await openSettings('ru');

    expect(screen.hasText('Звук')).toBe(true);
    expect(screen.hasText('Авто')).toBe(true);
    expect(screen.hasText('Рация')).toBe(true);
    expect(screen.hasText('Музыка')).toBe(true);

    screen.unmount();
  });
});
