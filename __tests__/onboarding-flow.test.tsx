import React from 'react';
import {context} from '@reatom/core';

import {OnboardingFlow} from '../src/screens/OnboardingFlow';
import {mockPermissions} from '../src/permissions/permissions.mock';
import {colors, testIds} from '../src/ui/theme';
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
    expect(screen.hasText('All set')).toBe(true);
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

    expect(screen.hasText('All set')).toBe(true);
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

  it('announces the step position on the dot row, not in visible text', async () => {
    // The visible "STEP n OF m" line was deleted on 2026-08-19 -- `StepDots`
    // renders the same information, and two indicators of one thing is one too
    // many. The words moved to the row's accessible name, so a screen reader
    // still hears the position; this asserts the move, not just the deletion.
    const screen = await renderScreen(<OnboardingFlow onDone={jest.fn()} />, {
      scenario: 'onboarding',
    });

    const steps = () =>
      screen.find(testIds.onboardingSteps).props.accessibilityLabel;

    expect(steps()).toBe('Step 1 of 3');
    expect(screen.texts().join(' ')).not.toContain('Step 1 of 3');

    await screen.press(testIds.onboardingAllow);
    expect(steps()).toBe('Step 2 of 3');

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

describe('OnboardingFlow — design/04 Onboarding.dc.html', () => {
  it('shows three progress dots and a mark for each permission', async () => {
    const screen = await renderScreen(<OnboardingFlow onDone={jest.fn()} />);

    expect(screen.findAll('step-dot')).toHaveLength(3);
    expect(screen.findAll('permission-mark')).toHaveLength(1);

    screen.unmount();
  });

  it('marks passed steps as done', async () => {
    const screen = await renderScreen(<OnboardingFlow onDone={jest.fn()} />);
    await screen.press(testIds.onboardingAllow);

    const dots = screen.findAll('step-dot');
    expect(JSON.stringify(dots[0].props.style)).toContain(
      colors.rx.slice(1),
    );

    screen.unmount();
  });
});
