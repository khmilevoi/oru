import {existsSync, readFileSync} from 'fs';
import {join} from 'path';

const IOS_DIR = join(__dirname, '..', 'ios');
const RESOURCES = join(IOS_DIR, 'Radio', 'Sources', 'RadioKit', 'Resources');

function read(...segments: string[]): string {
  const path = join(...segments);
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

function keysOf(strings: string): string[] {
  return [...strings.matchAll(/^"([^"]+)"\s*=\s*"([^"]*)";$/gm)]
    .map(match => match[1])
    .sort();
}

function valueOf(strings: string, key: string): string | undefined {
  const match = strings.match(
    new RegExp(`^"${key}"\\s*=\\s*"([^"]*)";$`, 'm'),
  );
  return match ? match[1] : undefined;
}

const packageEn = read(RESOURCES, 'en.lproj', 'Localizable.strings');
const packageRu = read(RESOURCES, 'ru.lproj', 'Localizable.strings');
const plistEn = read(IOS_DIR, 'Oru', 'en.lproj', 'InfoPlist.strings');
const plistRu = read(IOS_DIR, 'Oru', 'ru.lproj', 'InfoPlist.strings');
const infoPlist = read(IOS_DIR, 'Oru', 'Info.plist');
const pbxproj = read(IOS_DIR, 'Oru.xcodeproj', 'project.pbxproj');

const USAGE_KEYS = [
  'NSMicrophoneUsageDescription',
  'NSBluetoothAlwaysUsageDescription',
  'NSLocalNetworkUsageDescription',
];

describe('package strings (spec section 12.2)', () => {
  it.each(['ptt.channel.name', 'ptt.participant.nearby'])(
    'defines %s in english',
    key => {
      expect(valueOf(packageEn, key)).toBeTruthy();
    },
  );

  it('has the same key set in both locales', () => {
    expect(keysOf(packageRu)).toEqual(keysOf(packageEn));
    expect(keysOf(packageEn).length).toBeGreaterThan(0);
  });

  it('actually translates every russian value', () => {
    for (const key of keysOf(packageEn)) {
      expect(valueOf(packageRu, key)).toBeTruthy();
      expect(valueOf(packageRu, key)).not.toEqual(valueOf(packageEn, key));
    }
  });
});

describe('InfoPlist.strings (spec sections 11, 12.2)', () => {
  it.each(USAGE_KEYS)('localizes %s in both locales', key => {
    expect(valueOf(plistEn, key)).toBeTruthy();
    expect(valueOf(plistRu, key)).toBeTruthy();
    expect(valueOf(plistRu, key)).not.toEqual(valueOf(plistEn, key));
  });

  it('has the same key set in both locales', () => {
    expect(keysOf(plistRu)).toEqual(keysOf(plistEn));
  });

  it('localizes exactly the keys Info.plist declares', () => {
    for (const key of keysOf(plistEn)) {
      expect(infoPlist).toContain(`<key>${key}</key>`);
    }
  });
});

describe('app bundle localization wiring', () => {
  it('declares both locales in CFBundleLocalizations', () => {
    const index = infoPlist.indexOf('<key>CFBundleLocalizations</key>');
    expect(index).toBeGreaterThan(-1);
    const array = infoPlist.slice(index, index + 200);
    expect(array).toContain('<string>en</string>');
    expect(array).toContain('<string>ru</string>');
  });

  it('adds the InfoPlist.strings variant group to the project', () => {
    expect(pbxproj).toContain('PBXVariantGroup');
    expect(pbxproj).toContain('Oru/en.lproj/InfoPlist.strings');
    expect(pbxproj).toContain('Oru/ru.lproj/InfoPlist.strings');
    expect(pbxproj).toContain('InfoPlist.strings in Resources');
  });

  it('registers ru as a known region', () => {
    const index = pbxproj.indexOf('knownRegions = (');
    expect(index).toBeGreaterThan(-1);
    expect(pbxproj.slice(index, index + 120)).toContain('ru,');
  });
});
