import {action, atom, wrap} from '@reatom/core';

import {navigate} from '../app/navigation.model';
import {platformGateway} from './platform.gateway';

/** Where the first-launch sequence currently is. */
export type SequencingStep = 'onboarding' | 'background' | 'radio';

/**
 * Spec section 11's `ACCESS_BACKGROUND_LOCATION` step. `needsSettings` is the
 * two-step redirect: from API 30 the runtime dialog cannot grant "Allow all the
 * time" at all, so the only route through is the app's settings page.
 */
export const backgroundStatus = atom<'idle' | 'needsSettings' | 'granted'>(
  'idle',
  'backgroundStatus',
);

/**
 * Spec section 11's onboarding is a *first-launch* sequence, and this repository
 * has no key-value store on Android (P1's dependency rule) -- so "first launch"
 * is answered from the truth instead of from a flag: if the three groups are
 * granted, the sequence has served its purpose and is skipped. On iOS, where
 * nothing is queryable, the `Settings` flag is the record.
 *
 * Both reactive reads happen before the first `await`.
 */
export const resolveInitialRoute = action(async (): Promise<SequencingStep> => {
  const gateway = platformGateway();

  const completed = gateway.onboardingCompleted();
  const granted = await wrap(gateway.hasOnboardingPermissions());

  const step: SequencingStep = completed && granted ? 'radio' : 'onboarding';
  navigate(step === 'radio' ? 'radio' : 'onboarding');
  return step;
}, 'resolveInitialRoute');

/** `OnboardingFlow`'s `onDone`: record the sequence, then decide what follows. */
export const completeOnboarding = action(async (): Promise<SequencingStep> => {
  const gateway = platformGateway();
  gateway.markOnboardingCompleted();

  // POST_NOTIFICATIONS is an ordinary dialog belonging to the end of
  // onboarding, not to background location. Asking for it from the background
  // step's "Allow" instead missed it on every other way out of onboarding --
  // "Not now", an already-granted background permission, a platform with no
  // background step, and iOS -- and on API 33+ that silently suppresses the
  // foreground-service notification, which is what keeps the radio alive with
  // the screen locked (sections 10.1 and 11). The reactive read above is
  // already captured, so this `await` is safe to sit before the branch.
  await wrap(gateway.requestNotifications());

  if (!gateway.backgroundStepSupported()) {
    navigate('radio');
    return 'radio';
  }

  const held = await wrap(gateway.hasBackgroundLocation());
  if (held) {
    navigate('radio');
    return 'radio';
  }

  backgroundStatus.set('idle');
  navigate('background');
  return 'background';
}, 'completeOnboarding');

/**
 * The background step's primary action: background location alone, whose grant
 * is re-read from the system rather than inferred, because on API 30+ the
 * dialog cannot grant it. Notifications are asked for in `completeOnboarding`,
 * which every path out of onboarding goes through.
 */
export const requestBackgroundPermissions = action(async () => {
  const gateway = platformGateway();

  const granted = await wrap(gateway.requestBackgroundLocation());

  if (granted) {
    backgroundStatus.set('granted');
    navigate('radio');
    return 'granted' as const;
  }

  backgroundStatus.set('needsSettings');
  return 'needsSettings' as const;
}, 'requestBackgroundPermissions');

export const openBackgroundSettings = action(async () => {
  await wrap(platformGateway().openSettings());
}, 'openBackgroundSettings');

/** "Not now": the radio still works, it just rediscovers worse when pocketed. */
export const completeBackgroundStep = action(() => {
  navigate('radio');
}, 'completeBackgroundStep');
