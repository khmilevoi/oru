import {context} from '@reatom/core';

import {
  ONBOARDING_COMPLETED_KEY,
  platformGateway,
  realPlatformGateway,
} from '../src/permissions/platform.gateway';

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
