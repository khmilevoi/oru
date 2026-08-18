/**
 * The one suite that runs as Android.
 *
 * `@react-native/jest-preset` pins `haste.defaultPlatform: 'ios'`, so every
 * other test in this repository resolves `Platform` to `Platform.ios.js` and
 * `realPlatformGateway`'s Android branches -- the ones that actually ship to
 * users -- are structurally unreachable. That is how a permanently-`false`
 * `onboardingCompleted()` on Android survived a green suite: nothing ever ran
 * the branch. Mocking the `Platform` module itself (rather than reassigning
 * `Platform.OS`, which the real module exposes through a getter) is what flips
 * the whole file, `PermissionsAndroid` included.
 */
jest.mock('react-native/Libraries/Utilities/Platform', () => ({
  __esModule: true,
  default: {
    OS: 'android',
    // API 31: the three BLUETOOTH_* permissions are runtime permissions, the
    // background-location step exists (29+), and POST_NOTIFICATIONS is not yet
    // a runtime permission (33+) -- one level that exercises three splits.
    Version: 31,
    select: (spec: Record<string, unknown>) =>
      'android' in spec
        ? spec.android
        : 'native' in spec
          ? spec.native
          : spec.default,
  },
}));

import {PermissionsAndroid, Platform} from 'react-native';
import {context} from '@reatom/core';

import {androidPermissionsBackend} from '../src/permissions/permissions.native';
import {realPlatformGateway} from '../src/permissions/platform.gateway';
import {resolveInitialRoute} from '../src/permissions/sequencing.model';
import {route} from '../src/app/navigation.model';

/**
 * `PermissionsAndroid`'s real methods reach `NativePermissionsAndroid`, which is
 * null under Jest and trips an `invariant`. Every one of them is replaced per
 * test and restored afterwards, so `PERMISSIONS` and `RESULTS` stay the real
 * frozen constants the production code indexes into.
 */
const grantedEverywhere = () =>
  jest.spyOn(PermissionsAndroid, 'check').mockResolvedValue(true);

afterEach(() => {
  jest.restoreAllMocks();
  context.reset();
});

describe('the real gateway, running as Android', () => {
  it('really is Android in here', () => {
    expect(Platform.OS).toBe('android');
    expect(realPlatformGateway.backgroundStepSupported()).toBe(true);
  });

  it('opens on the radio when every group is already granted', async () => {
    // The regression for the bug this file was written for: Android persists no
    // onboarding flag, so `onboardingCompleted()` has nothing to answer with and
    // must not veto the grants. Answering `false` made `completed && granted`
    // permanently false and re-ran the whole sequence on every cold launch.
    grantedEverywhere();

    await expect(resolveInitialRoute()).resolves.toBe('radio');
    expect(route()).toBe('radio');
  });

  it('opens on onboarding when any group is missing', async () => {
    jest
      .spyOn(PermissionsAndroid, 'check')
      .mockImplementation(async name =>
        name !== PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
      );

    await expect(resolveInitialRoute()).resolves.toBe('onboarding');
    expect(route()).toBe('onboarding');
  });

  it('checks all five onboarding permission names for API 31', async () => {
    const check = grantedEverywhere();

    await realPlatformGateway.hasOnboardingPermissions();

    expect(check.mock.calls.map(call => call[0])).toEqual([
      PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_ADVERTISE,
      PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
    ]);
  });

  it('re-reads the background grant instead of trusting the dialog', async () => {
    // From API 30 the runtime dialog cannot grant "Allow all the time" at all,
    // and still answers `granted`. Only `check` tells the truth.
    const request = jest
      .spyOn(PermissionsAndroid, 'request')
      .mockResolvedValue(PermissionsAndroid.RESULTS.GRANTED);
    const check = jest
      .spyOn(PermissionsAndroid, 'check')
      .mockResolvedValue(false);

    await expect(realPlatformGateway.requestBackgroundLocation()).resolves.toBe(
      false,
    );
    expect(request).toHaveBeenCalledWith(
      PermissionsAndroid.PERMISSIONS.ACCESS_BACKGROUND_LOCATION,
    );
    expect(check).toHaveBeenCalledWith(
      PermissionsAndroid.PERMISSIONS.ACCESS_BACKGROUND_LOCATION,
    );
  });

});

describe('the Android permissions backend, running as Android', () => {
  it('asks for the three runtime Bluetooth names in one dialog on API 31', async () => {
    const requestMultiple = jest
      .spyOn(PermissionsAndroid, 'requestMultiple')
      .mockResolvedValue({
        [PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN]:
          PermissionsAndroid.RESULTS.GRANTED,
        [PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT]:
          PermissionsAndroid.RESULTS.GRANTED,
        [PermissionsAndroid.PERMISSIONS.BLUETOOTH_ADVERTISE]:
          PermissionsAndroid.RESULTS.GRANTED,
      });

    await expect(androidPermissionsBackend.request('bluetooth')).resolves.toBe(
      'granted',
    );
    expect(requestMultiple).toHaveBeenCalledWith([
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_ADVERTISE,
    ]);
  });
});
