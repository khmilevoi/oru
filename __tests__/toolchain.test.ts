import {existsSync} from 'fs';
import {join} from 'path';

import packageJson from '../package.json';
import {
  resolveAndroidSdkDir,
  resolveJdkDir,
} from '../scripts/build-android';

// package.json resolves to a precise literal type, which cannot be indexed
// with an arbitrary string under `strict`.
const scripts = packageJson.scripts as Record<string, string | undefined>;

describe('gate scripts', () => {
  it.each([
    'typecheck',
    'lint',
    'test',
    'build:android',
    'bundle:android',
  ])('package.json declares the "%s" script', name => {
    expect(scripts[name]).toBeTruthy();
  });
});

describe('android build script', () => {
  it('resolves an Android SDK directory that exists', () => {
    const sdkDir = resolveAndroidSdkDir();
    expect(sdkDir).toBeTruthy();
    expect(existsSync(join(sdkDir as string, 'platform-tools'))).toBe(true);
  });

  it('resolves a JDK directory that contains a java executable', () => {
    const jdkDir = resolveJdkDir();
    expect(jdkDir).toBeTruthy();
    const hasJava =
      existsSync(join(jdkDir as string, 'bin', 'java.exe')) ||
      existsSync(join(jdkDir as string, 'bin', 'java'));
    expect(hasJava).toBe(true);
  });
});
