import {Linking, PermissionsAndroid, Platform, Settings} from 'react-native';
import {atom} from '@reatom/core';

import {androidPermissionNames} from './permissions.native';
import {APP_PERMISSIONS} from './permissions.types';

/**
 * Everything first-launch sequencing needs to ask the platform, in one object.
 *
 * It exists because spec section 11's sequence is not answerable through the
 * section 6.4 permission port: the port asks "prompt for this and tell me what
 * the user said", and sequencing asks "has this already been granted, and has
 * this user seen the sequence before" -- questions with no prompt attached.
 * Keeping them here rather than widening the merged `PermissionsBackend` leaves
 * every merged screen, model and mock untouched.
 */
export type PlatformPermissionsGateway = {
  /** Android: are all three onboarding groups already granted? */
  hasOnboardingPermissions(): Promise<boolean>;
  /** iOS: has this install finished the sequence before? */
  onboardingCompleted(): boolean;
  markOnboardingCompleted(): void;
  /** Android 29+: is there an `ACCESS_BACKGROUND_LOCATION` step to show at all? */
  backgroundStepSupported(): boolean;
  hasBackgroundLocation(): Promise<boolean>;
  requestNotifications(): Promise<void>;
  /** Resolves `true` only when the permission is actually held afterwards. */
  requestBackgroundLocation(): Promise<boolean>;
  openSettings(): Promise<void>;
};

export const ONBOARDING_COMPLETED_KEY = 'com.oru.onboardingCompleted';

const androidApiLevel = (): number =>
  Platform.OS === 'android' && typeof Platform.Version === 'number'
    ? Platform.Version
    : 0;

/**
 * `Settings` is React Native core's iOS-only `NSUserDefaults` wrapper -- the one
 * persistent store available without adding a dependency, which P1's rule
 * forbids. On Android nothing is persisted: the permission grants *are* the
 * record, and reading them is both truthful and free (`check` never prompts).
 * Every access is guarded, because no native module answers under Jest.
 */
const readOnboardingFlag = (): boolean => {
  // Android keeps no flag, so there is nothing here to answer with: the grants
  // themselves are the record, and `hasOnboardingPermissions()` is the half of
  // `resolveInitialRoute`'s `completed && granted` that carries the answer
  // there. Returning `false` would make that conjunction permanently false and
  // re-run the whole sequence on every launch.
  if (Platform.OS !== 'ios') return true;
  try {
    return Settings.get(ONBOARDING_COMPLETED_KEY) === true;
  } catch {
    return false;
  }
};

export const realPlatformGateway: PlatformPermissionsGateway = {
  async hasOnboardingPermissions() {
    if (Platform.OS !== 'android') return true;

    const names = APP_PERMISSIONS.flatMap(permission =>
      androidPermissionNames(permission, androidApiLevel()),
    );
    try {
      const held = await Promise.all(
        names.map(name => PermissionsAndroid.check(name)),
      );
      return held.every(Boolean);
    } catch {
      // "Cannot tell" is answered as "not granted": the cost is one explanation
      // sequence the user may not have needed, against silently skipping a
      // permission they never gave. Throwing is not an option -- section 13,
      // and `resolveInitialRoute` is the only thing that ever leaves `route()`
      // at `null`, so a rejection here is a permanently blank app.
      return false;
    }
  },

  onboardingCompleted: readOnboardingFlag,

  markOnboardingCompleted() {
    if (Platform.OS !== 'ios') return;
    try {
      Settings.set({[ONBOARDING_COMPLETED_KEY]: true});
    } catch {
      // A missing settings module costs the user one extra explanation
      // sequence, which is a better failure than a crash at first launch.
    }
  },

  /**
   * `ACCESS_BACKGROUND_LOCATION` exists from API 29 and is what keeps Nearby
   * rediscovering a lost peer once the app has no visible Activity (Bug #5 of
   * the phase 0 spike report). It has no iOS counterpart.
   */
  backgroundStepSupported: () => androidApiLevel() >= 29,

  async hasBackgroundLocation() {
    if (Platform.OS !== 'android') return true;
    try {
      return await PermissionsAndroid.check(
        PermissionsAndroid.PERMISSIONS.ACCESS_BACKGROUND_LOCATION,
      );
    } catch {
      // As above: an unanswerable check shows the background step rather than
      // skipping it, so the worst case is a screen the user taps past.
      return false;
    }
  },

  async requestNotifications() {
    // Section 11 lists POST_NOTIFICATIONS under the foreground service, and the
    // service is what keeps the radio alive with the screen locked. It became a
    // runtime permission in API 33.
    if (Platform.OS !== 'android' || androidApiLevel() < 33) return;
    try {
      await PermissionsAndroid.request(
        PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS,
      );
    } catch {
      // A prompt that could not be raised is the same outcome as a prompt the
      // user declined, and neither blocks onboarding: the radio still runs, it
      // just posts no notification. Swallowing keeps that off the app's only
      // route out of a blank first frame.
    }
  },

  /**
   * From API 30 the "Allow all the time" choice was removed from the runtime
   * dialog: an app must send the user to its settings page instead. So the
   * request is attempted once -- it succeeds on API 29 and is a no-op answer
   * above it -- and the result is re-read from the system rather than trusted.
   */
  async requestBackgroundLocation() {
    if (Platform.OS !== 'android') return true;

    try {
      await PermissionsAndroid.request(
        PermissionsAndroid.PERMISSIONS.ACCESS_BACKGROUND_LOCATION,
      );
      return await PermissionsAndroid.check(
        PermissionsAndroid.PERMISSIONS.ACCESS_BACKGROUND_LOCATION,
      );
    } catch {
      // `false` keeps the user on the background step with the settings
      // redirect in front of them, which is the recoverable answer; `true`
      // would navigate away on a grant that was never confirmed.
      return false;
    }
  },

  async openSettings() {
    try {
      await Linking.openSettings();
    } catch {
      // The step's own `needsSettings` copy already spells out the route by
      // hand ("Permissions, then Location, then 'Allow all the time'"), so a
      // settings intent the OS refuses costs the user a manual detour rather
      // than an unhandled rejection.
    }
  },
};

/**
 * An atom rather than a module constant so a test can swap the whole platform
 * out with `platformGateway.set(fake)` and `context.reset()` puts it back --
 * the same discipline every other model test in this repository follows.
 */
export const platformGateway = atom<PlatformPermissionsGateway>(
  realPlatformGateway,
  'platformGateway',
);
