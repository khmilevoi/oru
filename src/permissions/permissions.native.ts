import {Linking, PermissionsAndroid, Platform} from 'react-native';

import type {
  AppPermission,
  PermissionStatus,
  PermissionsBackend,
} from './permissions.types';

/**
 * React Native's own union of manifest permission strings. Taken off
 * `PermissionsAndroid.check` rather than imported, because the type is not part
 * of the package's public export surface.
 */
export type AndroidPermissionName = Parameters<
  typeof PermissionsAndroid.check
>[0];

/**
 * Spec section 11's Android column, split into the three groups the onboarding
 * steps explain (`permissions.types.ts` records the same mapping).
 *
 * The API-level splits are the platform's, not a preference:
 * - the three `BLUETOOTH_*` permissions became runtime permissions in API 31;
 *   below that the legacy `BLUETOOTH`/`BLUETOOTH_ADMIN` grants are install-time
 *   and there is nothing to ask for.
 * - `NEARBY_WIFI_DEVICES` exists from API 33.
 * - `ACCESS_FINE_LOCATION` is asked for on **every** API level. That is Bug
 *   found #3 in `docs/superpowers/specs/2026-08-13-phase0-spike-report.md`:
 *   Nearby Connections' BLE medium requires it regardless of
 *   `NEARBY_WIFI_DEVICES`. Making it conditional silently breaks discovery.
 */
export function androidPermissionNames(
  permission: AppPermission,
  apiLevel: number,
): AndroidPermissionName[] {
  if (permission === 'microphone') {
    return [PermissionsAndroid.PERMISSIONS.RECORD_AUDIO];
  }

  if (permission === 'bluetooth') {
    return apiLevel >= 31
      ? [
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_ADVERTISE,
        ]
      : [];
  }

  return apiLevel >= 33
    ? [
        PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
        PermissionsAndroid.PERMISSIONS.NEARBY_WIFI_DEVICES,
      ]
    : [PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION];
}

/**
 * A group is granted only when every member is. `never_ask_again` anywhere in
 * the group makes the whole group `blocked`, which is what tells the merged
 * onboarding screen to offer "Open settings" instead of "Try again".
 */
export function summariseAndroidResults(
  results: Record<string, string>,
): PermissionStatus {
  const values = Object.values(results);
  if (values.length === 0) return 'granted';
  if (values.every(value => value === PermissionsAndroid.RESULTS.GRANTED)) {
    return 'granted';
  }
  return values.some(value => value === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN)
    ? 'blocked'
    : 'denied';
}

const androidApiLevel = (): number =>
  typeof Platform.Version === 'number' ? Platform.Version : 0;

export const androidPermissionsBackend: PermissionsBackend = {
  async request(permission) {
    const names = androidPermissionNames(permission, androidApiLevel());
    if (names.length === 0) return 'granted';

    const results = await PermissionsAndroid.requestMultiple(names);
    return summariseAndroidResults(results as Record<string, string>);
  },

  openSettings: () => Linking.openSettings(),
};

/**
 * iOS exposes no way to request or query these three permissions ahead of use,
 * and for the local network there is no such API in any language. Spec section
 * 11's iOS column is therefore what it is: `Info.plist` usage descriptions, and
 * a prompt the OS raises the first time the app touches the resource. Every one
 * of those first uses is already in merged code -- `AudioEngine.swift` awaits
 * record permission when the session opens the microphone,
 * `BleGattPttDriver.swift` instantiates `CBCentralManager`, and
 * NearbyConnections browses Bonjour -- so on iOS the prompts follow the user
 * pressing the power key.
 *
 * `request()` therefore means "nothing in this app blocks this step", which is
 * the only true thing iOS lets the app say here, and section 11's onboarding
 * sequence does its real job: explaining each permission in the app language
 * immediately before the OS asks for it.
 *
 * See the plan document's ruling 2 before changing this to a native module.
 */
export const iosPermissionsBackend: PermissionsBackend = {
  request: async () => 'granted',
  openSettings: () => Linking.openSettings(),
};
