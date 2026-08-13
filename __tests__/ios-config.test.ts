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

  it('declares the push-to-talk and bluetooth-central background modes', () => {
    const modes = arrayValues(infoPlist, 'UIBackgroundModes');
    expect(modes).toContain('push-to-talk');
    expect(modes).toContain('bluetooth-central');
  });
});

describe('push-to-talk entitlement (spec section 11)', () => {
  it('declares com.apple.developer.push-to-talk as true', () => {
    const keyIndex = entitlements.indexOf(
      '<key>com.apple.developer.push-to-talk</key>',
    );
    expect(keyIndex).not.toBe(-1);
    const afterKey = entitlements.slice(
      keyIndex + '<key>com.apple.developer.push-to-talk</key>'.length,
    );
    expect(afterKey.trimStart().startsWith('<true/>')).toBe(true);
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
