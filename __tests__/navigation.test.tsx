import React from 'react';
import {context} from '@reatom/core';

import {AppRoot} from '../src/app/AppRoot';
import {goBack, navigate, route} from '../src/app/navigation.model';
import {renderScreen} from '../jest/renderScreen';
import {testIds} from '../src/ui/theme';

jest.useFakeTimers({doNotFake: ['queueMicrotask']});

beforeEach(() => context.reset());

describe('navigation glue — spec section 12', () => {
  it('renders nothing until the initial route is resolved', async () => {
    const screen = await renderScreen(<AppRoot />, {scenario: 'happy'});
    expect(route()).toBeNull();
    expect(screen.findAll(testIds.radioScreen)).toHaveLength(0);
    screen.unmount();
  });

  it('walks radio -> settings -> pairing and back again', async () => {
    const screen = await renderScreen(<AppRoot />, {scenario: 'pairing-success'});
    await screen.act(() => navigate('radio'));
    expect(screen.findAll(testIds.radioScreen)).toHaveLength(1);

    await screen.press(testIds.settingsGear);
    expect(screen.findAll(testIds.settingsScreen)).toHaveLength(1);

    await screen.press(testIds.pttConnect);
    expect(screen.findAll(testIds.pairingScreen)).toHaveLength(1);

    await screen.press(testIds.pairingCancel);
    expect(screen.findAll(testIds.settingsScreen)).toHaveLength(1);

    await screen.press(testIds.settingsBack);
    expect(screen.findAll(testIds.radioScreen)).toHaveLength(1);
    screen.unmount();
  });

  it('leaves onboarding for the radio when it is done', async () => {
    const screen = await renderScreen(<AppRoot />, {scenario: 'happy'});
    await screen.act(() => navigate('onboarding'));
    expect(screen.findAll(testIds.onboardingScreen)).toHaveLength(1);

    await screen.press(testIds.onboardingAllow);
    await screen.press(testIds.onboardingAllow);
    await screen.press(testIds.onboardingAllow);
    await screen.press(testIds.onboardingStart);

    expect(screen.findAll(testIds.radioScreen)).toHaveLength(1);
    screen.unmount();
  });

  it('consumes the hardware back press only where there is somewhere to go', () => {
    navigate('radio');
    expect(goBack()).toBe(false);

    navigate('settings');
    expect(goBack()).toBe(true);
    expect(route()).toBe('radio');

    navigate('pairing');
    expect(goBack()).toBe(true);
    expect(route()).toBe('settings');

    navigate('onboarding');
    expect(goBack()).toBe(false);
    expect(route()).toBe('onboarding');
  });
});
