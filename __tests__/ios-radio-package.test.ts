import {existsSync, readFileSync} from 'fs';
import {join} from 'path';

const IOS_DIR = join(__dirname, '..', 'ios');
const PACKAGE_DIR = join(IOS_DIR, 'Radio');

function read(...segments: string[]): string {
  const path = join(...segments);
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

const manifest = read(PACKAGE_DIR, 'Package.swift');
const config = read(PACKAGE_DIR, 'Sources', 'RadioKit', 'RadioConfig.swift');
const pbxproj = read(IOS_DIR, 'Oru.xcodeproj', 'project.pbxproj');

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
