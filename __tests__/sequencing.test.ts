import {context} from '@reatom/core';

import {
  ONBOARDING_COMPLETED_KEY,
  platformGateway,
  realPlatformGateway,
} from '../src/permissions/platform.gateway';
import type {PlatformPermissionsGateway} from '../src/permissions/platform.gateway';

beforeEach(() => context.reset());

describe('the platform gateway', () => {
  it('defaults to the real one', () => {
    expect(platformGateway()).toBe(realPlatformGateway);
  });

  it('is swappable, so no model test ever touches the OS', () => {
    const fake = {...realPlatformGateway, onboardingCompleted: () => true};
    platformGateway.set(fake);
    expect(platformGateway().onboardingCompleted()).toBe(true);

    context.reset();
    expect(platformGateway()).toBe(realPlatformGateway);
  });

  it('namespaces its persisted key', () => {
    expect(ONBOARDING_COMPLETED_KEY).toBe('com.oru.onboardingCompleted');
  });

  it('never throws from the real gateway under Jest, where no native module answers', () => {
    expect(() => realPlatformGateway.onboardingCompleted()).not.toThrow();
    expect(() => realPlatformGateway.markOnboardingCompleted()).not.toThrow();
    expect(realPlatformGateway.backgroundStepSupported()).toBe(false); // Platform.OS is 'ios' under the RN jest preset
  });
});

import {
  backgroundStatus,
  completeBackgroundStep,
  completeOnboarding,
  requestBackgroundPermissions,
  resolveInitialRoute,
} from '../src/permissions/sequencing.model';
import {route} from '../src/app/navigation.model';

function fakeGateway(overrides: Partial<PlatformPermissionsGateway> = {}) {
  const calls = {markCompleted: 0, notifications: 0, settings: 0};
  const gateway: PlatformPermissionsGateway = {
    hasOnboardingPermissions: async () => true,
    onboardingCompleted: () => true,
    markOnboardingCompleted: () => {
      calls.markCompleted += 1;
    },
    backgroundStepSupported: () => false,
    hasBackgroundLocation: async () => true,
    requestNotifications: async () => {
      calls.notifications += 1;
    },
    requestBackgroundLocation: async () => true,
    openSettings: async () => {
      calls.settings += 1;
    },
    ...overrides,
  };
  platformGateway.set(gateway);
  return calls;
}

describe('first-launch sequencing — spec section 11', () => {
  it('opens on the radio when everything is already granted', async () => {
    fakeGateway();
    await expect(resolveInitialRoute()).resolves.toBe('radio');
    expect(route()).toBe('radio');
  });

  it('opens on onboarding when a permission is missing', async () => {
    fakeGateway({hasOnboardingPermissions: async () => false});
    await expect(resolveInitialRoute()).resolves.toBe('onboarding');
    expect(route()).toBe('onboarding');
  });

  it('opens on onboarding when this install has never finished it', async () => {
    fakeGateway({onboardingCompleted: () => false});
    await expect(resolveInitialRoute()).resolves.toBe('onboarding');
  });

  it('goes from onboarding to the background step where the platform has one', async () => {
    const calls = fakeGateway({
      backgroundStepSupported: () => true,
      hasBackgroundLocation: async () => false,
    });
    await expect(completeOnboarding()).resolves.toBe('background');
    expect(route()).toBe('background');
    expect(calls.markCompleted).toBe(1);
    // POST_NOTIFICATIONS belongs to the end of onboarding, not to the
    // background step: it is an ordinary dialog, and the foreground-service
    // notification it enables is what keeps the radio alive with the screen
    // locked (sections 10.1 and 11). Asking only on the background step's
    // "Allow" path missed it on every other way out of onboarding.
    expect(calls.notifications).toBe(1);
  });

  it('skips the background step when it is already granted', async () => {
    const calls = fakeGateway({
      backgroundStepSupported: () => true,
      hasBackgroundLocation: async () => true,
    });
    await expect(completeOnboarding()).resolves.toBe('radio');
    expect(route()).toBe('radio');
    // The same dialog on the path that never sees the background step at all.
    expect(calls.notifications).toBe(1);
  });

  it('skips the background step on a platform without one', async () => {
    fakeGateway({backgroundStepSupported: () => false});
    await expect(completeOnboarding()).resolves.toBe('radio');
  });

  it('reports the two-step redirect when the dialog cannot grant it', async () => {
    fakeGateway({requestBackgroundLocation: async () => false});
    await expect(requestBackgroundPermissions()).resolves.toBe('needsSettings');
    expect(backgroundStatus()).toBe('needsSettings');
  });

  it('reports a grant and leaves the step', async () => {
    fakeGateway({requestBackgroundLocation: async () => true});
    await expect(requestBackgroundPermissions()).resolves.toBe('granted');
    expect(backgroundStatus()).toBe('granted');
    expect(route()).toBe('radio');
  });

  it('lets the user skip the background step', () => {
    fakeGateway();
    completeBackgroundStep();
    expect(route()).toBe('radio');
  });
});
