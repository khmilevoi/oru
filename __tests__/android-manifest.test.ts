import {readFileSync} from 'fs';
import {join} from 'path';

const manifest = readFileSync(
  join(__dirname, '..', 'android', 'app', 'src', 'main', 'AndroidManifest.xml'),
  'utf8',
);

const REQUIRED_PERMISSIONS = [
  'android.permission.RECORD_AUDIO',
  'android.permission.BLUETOOTH_SCAN',
  'android.permission.BLUETOOTH_CONNECT',
  'android.permission.BLUETOOTH_ADVERTISE',
  'android.permission.NEARBY_WIFI_DEVICES',
  'android.permission.ACCESS_FINE_LOCATION',
  'android.permission.ACCESS_BACKGROUND_LOCATION',
  'android.permission.POST_NOTIFICATIONS',
  'android.permission.FOREGROUND_SERVICE',
  'android.permission.FOREGROUND_SERVICE_MICROPHONE',
  'android.permission.FOREGROUND_SERVICE_CONNECTED_DEVICE',
];

describe('AndroidManifest permissions (spec section 11)', () => {
  it.each(REQUIRED_PERMISSIONS)('declares %s', permission => {
    expect(manifest).toContain(`android:name="${permission}"`);
  });

  // Nearby Connections' BLE medium needs ACCESS_FINE_LOCATION on EVERY API
  // level, `NEARBY_WIFI_DEVICES` notwithstanding: with the permission capped at
  // `maxSdkVersion="32"`, discovery on API 36 died with Nearby status 8034 (see
  // Bug found #3 in docs/superpowers/specs/2026-08-13-phase0-spike-report.md,
  // and spec section 11, which now says "all versions, unconditionally"). The
  // cap must therefore never come back.
  it('requests ACCESS_FINE_LOCATION unconditionally, on every API level', () => {
    const line = manifest
      .split('\n')
      .find(candidate =>
        candidate.includes('android.permission.ACCESS_FINE_LOCATION'),
      );
    expect(line).toBeDefined();
    expect(line).not.toContain('android:maxSdkVersion');
  });
});
