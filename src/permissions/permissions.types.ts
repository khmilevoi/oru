/**
 * Spec section 6.4: the runtime permission prompts are what the OS owns rather
 * than the engine, so they go through a port of the same shape as the section
 * 6.1 contract -- which is what lets a mock answer them and the onboarding
 * screens be accepted with no device in the loop.
 *
 * The three permissions are the three onboarding steps of section 12.1's
 * `04 Onboarding`. Each maps to a platform group at the P7 boundary:
 * `microphone` -> RECORD_AUDIO / NSMicrophoneUsageDescription;
 * `bluetooth`  -> BLUETOOTH_SCAN + BLUETOOTH_CONNECT + BLUETOOTH_ADVERTISE /
 *                 NSBluetoothAlwaysUsageDescription;
 * `nearbyDevices` -> NEARBY_WIFI_DEVICES + ACCESS_FINE_LOCATION /
 *                 NSLocalNetworkUsageDescription.
 */

export type AppPermission = 'microphone' | 'bluetooth' | 'nearbyDevices';

export const APP_PERMISSIONS: readonly AppPermission[] = [
  'microphone',
  'bluetooth',
  'nearbyDevices',
];

/**
 * `blocked` is Android's permanently-denied and iOS's "denied, change it in
 * Settings": the system will not prompt again, so the UI offers a jump to
 * Settings rather than a retry.
 */
export type PermissionStatus = 'granted' | 'denied' | 'blocked';

/** What a platform implementation provides. May throw; the port catches. */
export type PermissionsBackend = {
  request(permission: AppPermission): Promise<PermissionStatus>;
  openSettings(): Promise<void>;
};
