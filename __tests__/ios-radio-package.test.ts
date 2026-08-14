import {createHash} from 'crypto';
import {existsSync, readFileSync} from 'fs';
import {join} from 'path';

const IOS_DIR = join(__dirname, '..', 'ios');
const PACKAGE_DIR = join(IOS_DIR, 'Radio');

function read(...segments: string[]): string {
  const path = join(...segments);
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
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

const manifest = read(PACKAGE_DIR, 'Package.swift');
const config = read(PACKAGE_DIR, 'Sources', 'RadioKit', 'RadioConfig.swift');
const pbxproj = read(IOS_DIR, 'Oru.xcodeproj', 'project.pbxproj');
const infoPlist = read(IOS_DIR, 'Oru', 'Info.plist');

describe('RadioKit package manifest', () => {
  it('declares the RadioKit library product', () => {
    expect(manifest).toContain('name: "RadioKit"');
    expect(manifest).toContain('.library(');
  });

  it('pins the iOS 16 floor from spec section 5', () => {
    expect(manifest).toContain('.iOS(.v16)');
  });

  it('declares english as the default localization', () => {
    expect(manifest).toContain('defaultLocalization: "en"');
  });

  it('declares the two third-party dependencies', () => {
    expect(manifest).toContain('https://github.com/google/nearby.git');
    expect(manifest).toContain('https://github.com/alta/swift-opus.git');
    expect(manifest).toContain('name: "NearbyConnections"');
    expect(manifest).toContain('name: "Opus"');
  });

  it('declares the test target', () => {
    expect(manifest).toContain('.testTarget(');
    expect(manifest).toContain('name: "RadioKitTests"');
  });

  it('processes the localized resources directory', () => {
    expect(manifest).toContain('.process("Resources")');
  });
});

describe('RadioConfig (spec sections 5, 7, 8)', () => {
  it('carries the shared Nearby service id', () => {
    expect(config).toContain('serviceId = "com.oru.radio"');
  });

  it('carries protocol version 1', () => {
    expect(config).toContain('protocolVersion = 1');
  });

  it.each([
    ['sampleRate', '16_000'],
    ['samplesPerFrame', '320'],
    ['frameDurationMs', '20'],
    ['bitrate', '24_000'],
    ['channelCount', '1'],
  ])('audio %s is %s', (name, value) => {
    expect(config).toContain(`${name}: `);
    expect(config).toMatch(new RegExp(`${name}[^=]*= ${value}`));
  });

  it('caps continuous transmission at 120 seconds', () => {
    expect(config).toMatch(/safetyCapSeconds[^=]*= 120/);
  });

  it('primes the jitter buffer with 3 frames (spec section 8)', () => {
    expect(config).toMatch(/jitterTargetFrames[^=]*= 3/);
  });
});

// Nearby Connections does not advertise a name of our choosing: it derives the
// mDNS service type from the service id, as `_<TYPE>._tcp` where `<TYPE>` is the
// first 6 bytes of SHA-256(serviceID) in uppercase hex. iOS local-network privacy
// refuses to browse any type the app has not declared in NSBonjourServices, so an
// invented entry means discovery silently finds nothing — no error, no peers, ever.
// The expected value is therefore derived here from RadioConfig rather than written
// out as a literal, so the test follows the constant if the service id ever changes.
// Do not "simplify" this back into a hard-coded string.
describe('Bonjour service type derived from the Nearby service id', () => {
  const serviceId = /serviceId = "([^"]+)"/.exec(config)?.[1] ?? '';
  const derived = `_${createHash('sha256')
    .update(serviceId)
    .digest('hex')
    .slice(0, 12)
    .toUpperCase()}._tcp`;
  const services = arrayValues(infoPlist, 'NSBonjourServices');

  it('extracts the service id from RadioConfig', () => {
    expect(serviceId).not.toBe('');
  });

  it('declares the type derived from that service id', () => {
    expect(services).toContain(derived);
  });

  it('declares no other service type', () => {
    expect(services.filter(value => value.startsWith('_'))).toEqual([derived]);
  });
});

describe('app target wiring', () => {
  it('references the local Radio package', () => {
    expect(pbxproj).toContain('/* Radio */ = {isa = PBXFileReference');
  });

  it('links the RadioKit product into the Oru target', () => {
    expect(pbxproj).toContain('XCSwiftPackageProductDependency');
    expect(pbxproj).toContain('productName = RadioKit;');
    expect(pbxproj).toContain('packageProductDependencies = (');
  });
});
