import React from 'react';
import {context} from '@reatom/core';

import {BackgroundStep, backgroundStepTestIds} from '../src/screens/BackgroundStep';
import {platformGateway} from '../src/permissions/platform.gateway';
import {realPlatformGateway} from '../src/permissions/platform.gateway';
import {renderScreen} from '../jest/renderScreen';
import {route} from '../src/app/navigation.model';

jest.useFakeTimers({doNotFake: ['queueMicrotask']});

beforeEach(() => context.reset());

const gateway = (granted: boolean, calls = {settings: 0}) => {
  platformGateway.set({
    ...realPlatformGateway,
    requestNotifications: async () => {},
    requestBackgroundLocation: async () => granted,
    openSettings: async () => {
      calls.settings += 1;
    },
  });
  return calls;
};

describe('the background-location step — spec section 11', () => {
  it('explains the step and offers to grant it', async () => {
    const screen = await renderScreen(<BackgroundStep />);
    gateway(true);

    expect(screen.hasText('Keep the radio working')).toBe(true);
    expect(screen.findAll(backgroundStepTestIds.allow)).toHaveLength(1);
    expect(screen.findAll(backgroundStepTestIds.openSettings)).toHaveLength(0);

    await screen.press(backgroundStepTestIds.allow);
    expect(route()).toBe('radio');
    screen.unmount();
  });

  it('falls back to the settings redirect the dialog cannot replace', async () => {
    const screen = await renderScreen(<BackgroundStep />);
    const calls = gateway(false);

    await screen.press(backgroundStepTestIds.allow);
    expect(screen.hasText('Allow all the time')).toBe(true);
    expect(screen.findAll(backgroundStepTestIds.openSettings)).toHaveLength(1);

    await screen.press(backgroundStepTestIds.openSettings);
    expect(calls.settings).toBe(1);
    screen.unmount();
  });

  it('can be skipped', async () => {
    const screen = await renderScreen(<BackgroundStep />);
    gateway(false);

    await screen.press(backgroundStepTestIds.skip);
    expect(route()).toBe('radio');
    screen.unmount();
  });

  it('renders in Russian', async () => {
    const screen = await renderScreen(<BackgroundStep />, {locale: 'ru'});
    gateway(false);

    expect(screen.hasText('Чтобы рация работала')).toBe(true);
    await screen.press(backgroundStepTestIds.allow);
    expect(screen.hasText('Разрешить всегда')).toBe(true);
    screen.unmount();
  });
});
