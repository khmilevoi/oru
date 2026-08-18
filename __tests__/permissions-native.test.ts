import {
  androidPermissionNames,
  summariseAndroidResults,
} from '../src/permissions/permissions.native';

describe('the Android permission groups — spec section 11', () => {
  it('asks for the microphone on every API level', () => {
    expect(androidPermissionNames('microphone', 30)).toEqual([
      'android.permission.RECORD_AUDIO',
    ]);
    expect(androidPermissionNames('microphone', 34)).toEqual([
      'android.permission.RECORD_AUDIO',
    ]);
  });

  it('asks for the three runtime Bluetooth permissions from API 31', () => {
    expect(androidPermissionNames('bluetooth', 31)).toEqual([
      'android.permission.BLUETOOTH_SCAN',
      'android.permission.BLUETOOTH_CONNECT',
      'android.permission.BLUETOOTH_ADVERTISE',
    ]);
  });

  it('asks for nothing on older Bluetooth, where the grants are install-time', () => {
    expect(androidPermissionNames('bluetooth', 30)).toEqual([]);
  });

  it('asks for fine location on every API level, and adds NEARBY_WIFI_DEVICES on 33+', () => {
    // Bug #3 of the phase 0 spike report: Nearby's BLE medium needs
    // ACCESS_FINE_LOCATION unconditionally, whatever NEARBY_WIFI_DEVICES says.
    expect(androidPermissionNames('nearbyDevices', 31)).toEqual([
      'android.permission.ACCESS_FINE_LOCATION',
    ]);
    expect(androidPermissionNames('nearbyDevices', 33)).toEqual([
      'android.permission.ACCESS_FINE_LOCATION',
      'android.permission.NEARBY_WIFI_DEVICES',
    ]);
  });

  it('summarises a whole group into one status', () => {
    expect(summariseAndroidResults({a: 'granted', b: 'granted'})).toBe('granted');
    expect(summariseAndroidResults({a: 'granted', b: 'denied'})).toBe('denied');
    expect(summariseAndroidResults({a: 'denied', b: 'never_ask_again'})).toBe(
      'blocked',
    );
    expect(summariseAndroidResults({})).toBe('granted');
  });
});

describe('the iOS backend — spec section 11', () => {
  it('advances every step, because iOS prompts at first use and not on demand', async () => {
    // `require`, not a dynamic `import()`: this repo's Jest config (see
    // jest.config.js) has no ESM/`--experimental-vm-modules` support, and
    // native `import()` is left untransformed by @react-native/babel-preset
    // (it targets Metro, which handles it natively) -- so under Jest it throws
    // "A dynamic import callback was invoked without --experimental-vm-modules"
    // rather than resolving. `require` gets the identical module instance with
    // the identical semantics this test needs.
    const {
      iosPermissionsBackend,
    } = require('../src/permissions/permissions.native');
    await expect(iosPermissionsBackend.request('microphone')).resolves.toBe(
      'granted',
    );
    await expect(iosPermissionsBackend.request('bluetooth')).resolves.toBe(
      'granted',
    );
    await expect(iosPermissionsBackend.request('nearbyDevices')).resolves.toBe(
      'granted',
    );
  });
});

describe('the port after the flip — spec section 6.5', () => {
  it('still binds the mock under RADIO_BACKEND=mock, which jest.config.js pins', async () => {
    // See the comment above: `require`, not a dynamic `import()`, for the same
    // Jest/Babel reason.
    const {Permissions} = require('../src/permissions/permissions.port');
    const {
      mockPermissions,
    } = require('../src/permissions/permissions.mock');
    mockPermissions.reset();
    await expect(Permissions.request('microphone')).resolves.toBe('granted');
  });

  it('reads its dev default the same way radio.native.ts does', () => {
    const {readFileSync} = require('fs');
    const {join} = require('path');
    const source = readFileSync(
      join(__dirname, '..', 'src', 'permissions', 'permissions.port.ts'),
      'utf8',
    );
    // The flip: `mock` is now the opt-in, exactly as in radio.native.ts, so a
    // release build and a plain dev build both reach the real OS prompts.
    expect(source).toMatch(/process\.env\.RADIO_BACKEND === 'mock'/);
  });
});
