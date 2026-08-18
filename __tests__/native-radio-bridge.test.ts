import {readFileSync} from 'fs';
import {join} from 'path';

const REPO_ROOT = join(__dirname, '..');

const read = (relative: string): string =>
  readFileSync(join(REPO_ROOT, relative), 'utf8');

/**
 * P5 wires React Native's Codegen over `specs/NativeRadio.ts`. The generated
 * class names the Kotlin and Objective-C++ modules extend are derived from the
 * values below, so a silent edit to any of them breaks both platforms at once
 * — on Android at compile time, on iOS on a host no gate compiles.
 */
describe('codegen configuration (spec section 6.1)', () => {
  const packageJson = () =>
    JSON.parse(read('package.json')) as {
      codegenConfig?: {
        name?: string;
        type?: string;
        jsSrcsDir?: string;
        android?: {javaPackageName?: string};
      };
    };

  it('runs codegen over the specs directory as a module library', () => {
    const codegen = packageJson().codegenConfig;
    expect(codegen).toBeDefined();
    expect(codegen?.name).toBe('OruSpecs');
    expect(codegen?.type).toBe('modules');
    expect(codegen?.jsSrcsDir).toBe('specs');
  });

  it('generates the Android spec into the bridge package, never the radio package', () => {
    // Spec section 6: no file under com/oru/radio may import com.facebook.*,
    // and the generated spec extends ReactContextBaseJavaModule.
    expect(packageJson().codegenConfig?.android?.javaPackageName).toBe(
      'com.oru.bridge',
    );
  });

  it('keeps P6 build wiring in place alongside it', () => {
    const json = JSON.parse(read('package.json')) as {
      devDependencies: Record<string, string>;
    };
    expect(
      json.devDependencies['babel-plugin-transform-inline-environment-variables'],
    ).toBeDefined();
  });
});

const ANDROID_BRIDGE = 'android/app/src/main/java/com/oru/bridge';

describe('the Android Turbo Module (spec section 6.1)', () => {
  const module = () => read(`${ANDROID_BRIDGE}/NativeRadioModule.kt`);
  const pkg = () => read(`${ANDROID_BRIDGE}/RadioBridgePackage.kt`);

  it('implements the generated spec and registers under the contract name', () => {
    expect(module()).toMatch(
      /class NativeRadioModule\([\s\S]*?\)\s*:\s*NativeRadioSpec\(reactContext\)/,
    );
    expect(pkg()).toMatch(/NativeRadioSpec\.NAME/);
    expect(read('src/radio/radio.native.ts')).toMatch(
      /NATIVE_RADIO_MODULE_NAME = 'NativeRadio'/,
    );
  });

  it('implements all eight amended section 6.1 methods', () => {
    [
      'start',
      'stop',
      'pressPtt',
      'releasePtt',
      'getState',
      'configurePtt',
      'selectPttCandidate',
      'forgetPtt',
    ].forEach(method => {
      expect(module()).toMatch(new RegExp(`override fun ${method}\\(`));
    });
  });

  it('drives both event emitters from the core', () => {
    expect(module()).toMatch(/emitOnStateChanged\(/);
    expect(module()).toMatch(/emitOnError\(/);
  });

  it('publishes off before asking the service to stop', () => {
    // Order matters: RadioEngine.stopRadio() emits a `starting` snapshot on its
    // way down, and core.stop() is what masks it.
    const stop = module().slice(module().indexOf('override fun stop('));
    expect(stop.indexOf('core.stop()')).toBeLessThan(
      stop.indexOf('RadioController.stop('),
    );
  });

  it('is registered with React Native from MainApplication', () => {
    expect(read('android/app/src/main/java/com/oru/MainApplication.kt')).toMatch(
      /add\(RadioBridgePackage\(\)\)/,
    );
  });

  it('declares itself a turbo module to the module info provider', () => {
    expect(pkg()).toMatch(/BaseReactPackage\(\)/);
    expect(pkg()).toMatch(/ReactModuleInfo\(/);
  });

  it('keeps React Native out of the engine package (spec section 6)', () => {
    // The bridge is by definition the file that imports com.facebook.*, which is
    // why it lives in com.oru.bridge. android-radio.test.ts asserts the other half.
    expect(module()).toMatch(/^package com\.oru\.bridge$/m);
  });
});
