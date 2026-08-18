import {readFileSync} from 'fs';
import {join} from 'path';

const IOS_DIR = join(__dirname, '..', 'ios');

const infoPlist = readFileSync(join(IOS_DIR, 'Oru', 'Info.plist'), 'utf8');
const entitlements = readFileSync(
  join(IOS_DIR, 'Oru', 'Oru.entitlements'),
  'utf8',
);
const pbxproj = readFileSync(
  join(IOS_DIR, 'Oru.xcodeproj', 'project.pbxproj'),
  'utf8',
);
const podfile = readFileSync(join(IOS_DIR, 'Podfile'), 'utf8');

function stringValue(source: string, key: string): string | null {
  const keyIndex = source.indexOf(`<key>${key}</key>`);
  if (keyIndex === -1) {
    return null;
  }
  const open = source.indexOf('<string>', keyIndex);
  const close = source.indexOf('</string>', open);
  if (open === -1 || close === -1) {
    return null;
  }
  return source.slice(open + '<string>'.length, close);
}

function arrayValues(source: string, key: string): string[] {
  const keyIndex = source.indexOf(`<key>${key}</key>`);
  if (keyIndex === -1) {
    return [];
  }
  const open = source.indexOf('<array>', keyIndex);
  const close = source.indexOf('</array>', open);
  if (open === -1 || close === -1) {
    return [];
  }
  return source
    .slice(open + '<array>'.length, close)
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.startsWith('<string>'))
    .map(line => line.replace('<string>', '').replace('</string>', ''));
}

describe('Info.plist usage descriptions (spec section 11)', () => {
  it.each([
    'NSMicrophoneUsageDescription',
    'NSBluetoothAlwaysUsageDescription',
    'NSLocalNetworkUsageDescription',
  ])('%s is declared with non-empty English source copy', key => {
    const value = stringValue(infoPlist, key);
    expect(value).toBeTruthy();
    expect((value as string).length).toBeGreaterThan(10);
  });

  it('declares at least one Bonjour service', () => {
    expect(arrayValues(infoPlist, 'NSBonjourServices').length).toBeGreaterThan(
      0,
    );
  });

  // `audio` is what earns background execution now: the always-hot session
  // keeps the microphone pulling while the screen is locked (spec section
  // 10.2). `push-to-talk` went with the PushToTalk framework on 2026-08-18 --
  // a background mode whose entitlement the app no longer declares is dead
  // weight at best and a signing failure at worst.
  it('declares the audio and bluetooth-central background modes', () => {
    const modes = arrayValues(infoPlist, 'UIBackgroundModes');
    expect(modes).toContain('audio');
    expect(modes).toContain('bluetooth-central');
    expect(modes).not.toContain('push-to-talk');
  });
});

describe('app entitlements (spec section 11)', () => {
  it('no longer claims the push-to-talk entitlement', () => {
    expect(entitlements).not.toContain('com.apple.developer.push-to-talk');
  });

  it('is wired to the app target', () => {
    expect(pbxproj).toContain(
      'CODE_SIGN_ENTITLEMENTS = Oru/Oru.entitlements;',
    );
  });
});

describe('iOS platform floor (spec section 5)', () => {
  it('sets the deployment target to 16.0 everywhere', () => {
    const matches = [
      ...pbxproj.matchAll(/IPHONEOS_DEPLOYMENT_TARGET = ([\d.]+);/g),
    ];
    expect(matches.length).toBe(4);
    for (const match of matches) {
      expect(match[1]).toBe('16.0');
    }
  });

  it('pins the Podfile platform to 16.0', () => {
    expect(podfile).toContain("platform :ios, '16.0'");
  });
});
