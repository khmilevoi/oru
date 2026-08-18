import {readFileSync} from 'fs';
import {join} from 'path';

const repoRoot = join(__dirname, '..');
const manifest = readFileSync(
  join(repoRoot, 'android', 'app', 'src', 'main', 'AndroidManifest.xml'),
  'utf8',
);
const infoPlist = readFileSync(
  join(repoRoot, 'ios', 'Oru', 'Info.plist'),
  'utf8',
);
const crosscheck = readFileSync(
  join(repoRoot, 'docs', 'section-11-permission-crosscheck.md'),
  'utf8',
);

const declaredPermissions = [
  ...manifest.matchAll(/<uses-permission[^>]*android:name="([^"]+)"/g),
]
  .map(match => match[1])
  .sort();

/**
 * Spec section 11, plus the four declarations that are not in section 11's table
 * and are justified one by one in docs/section-11-permission-crosscheck.md.
 * This list is the cross-check: a permission added to the manifest without a
 * line in that document fails here.
 */
const EXPECTED_ANDROID = [
  'android.permission.ACCESS_BACKGROUND_LOCATION',
  'android.permission.ACCESS_FINE_LOCATION',
  'android.permission.ACCESS_WIFI_STATE',
  'android.permission.BLUETOOTH_ADVERTISE',
  'android.permission.BLUETOOTH_CONNECT',
  'android.permission.BLUETOOTH_SCAN',
  'android.permission.CHANGE_WIFI_STATE',
  'android.permission.FOREGROUND_SERVICE',
  'android.permission.FOREGROUND_SERVICE_CONNECTED_DEVICE',
  'android.permission.FOREGROUND_SERVICE_MICROPHONE',
  'android.permission.INTERNET',
  'android.permission.MODIFY_AUDIO_SETTINGS',
  'android.permission.NEARBY_WIFI_DEVICES',
  'android.permission.POST_NOTIFICATIONS',
  'android.permission.RECORD_AUDIO',
].sort();

describe('the section 11 cross-check — Android', () => {
  it('declares exactly the reconciled set', () => {
    expect(declaredPermissions).toEqual(EXPECTED_ANDROID);
  });

  it('justifies every declaration in the cross-check document', () => {
    for (const permission of EXPECTED_ANDROID) {
      expect(crosscheck).toContain(permission.replace('android.permission.', ''));
    }
  });

  it('never caps fine location by API level', () => {
    // Spike bug #3: Nearby's BLE medium needs it on every level.
    expect(manifest).not.toMatch(
      /ACCESS_FINE_LOCATION"[^>]*android:maxSdkVersion/,
    );
  });

  it('types the foreground service for both of its jobs', () => {
    expect(manifest).toMatch(
      /android:foregroundServiceType="microphone\|connectedDevice"/,
    );
  });
});

describe('the section 11 cross-check — iOS', () => {
  it('declares every usage description section 11 lists', () => {
    for (const key of [
      'NSMicrophoneUsageDescription',
      'NSBluetoothAlwaysUsageDescription',
      'NSLocalNetworkUsageDescription',
      'NSBonjourServices',
    ]) {
      expect(infoPlist).toContain(key);
    }
  });

  it('declares both background modes and no others', () => {
    const modes = infoPlist
      .split('<key>UIBackgroundModes</key>')[1]
      .split('</array>')[0];
    expect(modes).toContain('<string>audio</string>');
    expect(modes).toContain('<string>bluetooth-central</string>');
    expect(modes.match(/<string>/g)).toHaveLength(2);
  });

  it('claims no push-to-talk entitlement anywhere', () => {
    // Removed with PushToTalk on 2026-08-18 (section 10.2): the entitlement no
    // longer exists to be claimed.
    const entitlements = readFileSync(
      join(repoRoot, 'ios', 'Oru', 'Oru.entitlements'),
      'utf8',
    );
    expect(entitlements).not.toContain('push-to-talk');
    expect(infoPlist).not.toContain('com.apple.developer.push-to-talk');
  });
});
