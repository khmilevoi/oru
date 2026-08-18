import React from 'react';
import {context} from '@reatom/core';

import {OnboardingFlow} from '../src/screens/OnboardingFlow';
import {mockPermissions} from '../src/permissions/permissions.mock';
import {testIds} from '../src/ui/theme';
import {renderScreen} from '../jest/renderScreen';

jest.useFakeTimers({doNotFake: ['queueMicrotask']});

beforeEach(() => context.reset());

describe('onboarding — spec sections 11 and 12.1', () => {
  it('walks all three permissions and the done screen, including a denial', async () => {
    const onDone = jest.fn();
    const screen = await renderScreen(<OnboardingFlow onDone={onDone} />, {
      scenario: 'onboarding',
    });

    // Step 1 — microphone, granted.
    expect(screen.hasText('Microphone')).toBe(true);
    await screen.press(testIds.onboardingAllow);
    expect(screen.hasText('Bluetooth')).toBe(true);

    // Step 2 — bluetooth, denied.
    await screen.press(testIds.onboardingAllow);
    expect(screen.hasText('Permission denied')).toBe(true);
    expect(screen.findAll(testIds.onboardingRetry)).toHaveLength(1);
    expect(screen.findAll(testIds.onboardingOpenSettings)).toHaveLength(0);

    await screen.press(testIds.onboardingSkip);
    expect(screen.hasText('Nearby devices')).toBe(true);

    // Step 3 — nearby devices, permanently denied.
    await screen.press(testIds.onboardingAllow);
    expect(screen.hasText('Permission is blocked')).toBe(true);
    expect(screen.findAll(testIds.onboardingOpenSettings)).toHaveLength(1);

    await screen.press(testIds.onboardingOpenSettings);
    expect(mockPermissions.openSettingsCalls()).toBe(1);

    await screen.press(testIds.onboardingSkip);

    // Step 4 — done.
    expect(screen.hasText('Ready')).toBe(true);
    await screen.press(testIds.onboardingStart);
    expect(onDone).toHaveBeenCalledTimes(1);

    screen.unmount();
  });

  it('advances straight through when everything is granted', async () => {
    const onDone = jest.fn();
    const screen = await renderScreen(<OnboardingFlow onDone={onDone} />, {
      scenario: 'happy',
    });

    await screen.press(testIds.onboardingAllow);
    await screen.press(testIds.onboardingAllow);
    await screen.press(testIds.onboardingAllow);

    expect(screen.hasText('Ready')).toBe(true);
    screen.unmount();
  });

  it('re-requests from Try again and keeps the same answer', async () => {
    const screen = await renderScreen(<OnboardingFlow onDone={jest.fn()} />, {
      scenario: 'onboarding',
    });

    await screen.press(testIds.onboardingAllow);
    await screen.press(testIds.onboardingAllow);
    expect(screen.hasText('Permission denied')).toBe(true);

    await screen.press(testIds.onboardingRetry);
    expect(screen.hasText('Permission is blocked')).toBe(true);

    screen.unmount();
  });

  it('shows the step counter', async () => {
    const screen = await renderScreen(<OnboardingFlow onDone={jest.fn()} />, {
      scenario: 'onboarding',
    });

    expect(screen.texts().join(' ')).toContain('1');
    await screen.press(testIds.onboardingAllow);
    expect(screen.texts().join(' ')).toContain('2');

    screen.unmount();
  });

  it('renders in Russian', async () => {
    const screen = await renderScreen(<OnboardingFlow onDone={jest.fn()} />, {
      scenario: 'onboarding',
      locale: 'ru',
    });

    expect(screen.hasText('Микрофон')).toBe(true);
    expect(screen.hasText('Разрешить')).toBe(true);

    await screen.press(testIds.onboardingAllow);
    await screen.press(testIds.onboardingAllow);

    expect(screen.hasText('Разрешение отклонено')).toBe(true);
    expect(screen.hasText('Попробовать снова')).toBe(true);

    screen.unmount();
  });
});
