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
  'android.permission.POST_NOTIFICATIONS',
  'android.permission.FOREGROUND_SERVICE',
  'android.permission.FOREGROUND_SERVICE_MICROPHONE',
  'android.permission.FOREGROUND_SERVICE_CONNECTED_DEVICE',
];

describe('AndroidManifest permissions (spec section 11)', () => {
  it.each(REQUIRED_PERMISSIONS)('declares %s', permission => {
    expect(manifest).toContain(`android:name="${permission}"`);
  });

  it('bounds ACCESS_FINE_LOCATION to pre-Android-13', () => {
    const line = manifest
      .split('\n')
      .find(candidate =>
        candidate.includes('android.permission.ACCESS_FINE_LOCATION'),
      );
    expect(line).toContain('android:maxSdkVersion="32"');
  });
});
