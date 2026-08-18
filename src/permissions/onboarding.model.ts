import {action, atom, computed, wrap} from '@reatom/core';

import {APP_PERMISSIONS} from './permissions.types';
import {Permissions} from './permissions.port';
import type {AppPermission, PermissionStatus} from './permissions.types';

/**
 * Spec section 11's onboarding sequence, in the three permission steps plus a
 * final screen that section 12.1 designed. Each step explains one permission in
 * the app language before the system prompt is triggered.
 *
 * `ACCESS_BACKGROUND_LOCATION` is deliberately absent: section 11 records it as
 * still-open work for P7, because it needs a Data Safety disclosure and
 * Android's two-step "Allow all the time" redirect rather than a dialog.
 */
export const onboardingIndex = atom(0, 'onboardingIndex');

export const onboardingAnswers = atom<
  Partial<Record<AppPermission, PermissionStatus>>
>({}, 'onboardingAnswers');

export const onboardingPermission = computed<AppPermission | null>(
  () => APP_PERMISSIONS[onboardingIndex()] ?? null,
  'onboardingPermission',
);

export const onboardingFinished = computed(
  () => onboardingIndex() >= APP_PERMISSIONS.length,
  'onboardingFinished',
);

export const onboardingStatus = computed<PermissionStatus | null>(() => {
  const permission = onboardingPermission();
  return permission ? onboardingAnswers()[permission] ?? null : null;
}, 'onboardingStatus');

export const advanceOnboarding = action(() => {
  onboardingIndex.set(onboardingIndex() + 1);
}, 'advanceOnboarding');

/**
 * Triggers the system prompt for the current step. Every reactive input is read
 * before the first `await` -- a read after it never becomes a dependency, and
 * `onboardingAnswers` in particular would be a stale-write hazard.
 */
export const requestOnboardingPermission = action(async () => {
  const permission = onboardingPermission();
  if (!permission) return null;

  const answers = onboardingAnswers();
  const index = onboardingIndex();

  const result = await wrap(Permissions.request(permission));
  /**
   * Section 13: the port returns `Error | PermissionStatus`. An unavailable or
   * failing backend is treated as a denial -- the user is told the permission
   * was not granted, which is true, rather than being shown a diagnostic.
   */
  const status: PermissionStatus = result instanceof Error ? 'denied' : result;

  onboardingAnswers.set({...answers, [permission]: status});
  if (status === 'granted') onboardingIndex.set(index + 1);

  return status;
}, 'requestOnboardingPermission');

export const openPermissionSettings = action(
  async () => wrap(Permissions.openSettings()),
  'openPermissionSettings',
);

export const resetOnboarding = action(() => {
  onboardingIndex.set(0);
  onboardingAnswers.set({});
}, 'resetOnboarding');
