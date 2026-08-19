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

  it('implements all eleven amended section 6.1 and 12.2 methods', () => {
    [
      'start',
      'stop',
      'pressPtt',
      'releasePtt',
      'getState',
      'configurePtt',
      'selectPttCandidate',
      'forgetPtt',
      'setAudioMode',
      'getAppLocale',
      'setAppLocale',
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
    // A false here is a silent runtime failure: TurboModuleManager simply never
    // finds the module.
    expect(pkg()).toMatch(/isTurboModule = \*\/\s*true/);
  });

  it('keeps React Native out of the engine package (spec section 6)', () => {
    // The bridge is by definition the file that imports com.facebook.*, which is
    // why it lives in com.oru.bridge. android-radio.test.ts asserts the other half.
    expect(module()).toMatch(/^package com\.oru\.bridge$/m);
  });
});

describe('the iOS Turbo Module (spec section 6.1)', () => {
  const swift = () => read('ios/Oru/RadioBridge.swift');
  const objcpp = () => read('ios/Oru/NativeRadioModule.mm');
  const pbxproj = () => read('ios/Oru.xcodeproj/project.pbxproj');

  it('exposes the bridge to Objective-C under a stable name', () => {
    expect(swift()).toMatch(/@objc\(ORURadioBridge\)/);
    expect(swift()).toMatch(/public final class RadioBridge: NSObject/);
    expect(swift()).toMatch(/import RadioKit/);
  });

  it('reaches the engine only through the merged assembly', () => {
    expect(swift()).toMatch(/RadioAssembly\.shared\.engine/);
    // Never constructs a port itself: RadioAssembly is P3's single wiring point.
    expect(swift()).not.toMatch(/NearbyManager\(|AudioEngine\(|PttManager\(/);
  });

  it('maps the stopped engine onto status off, with the stored button preserved', () => {
    expect(swift()).toMatch(/offDictionary\(status: "off"\)/);
    expect(swift()).toMatch(/offDictionary\(status: "starting"\)/);
    expect(swift()).toMatch(/RadioAssembly\.shared\.ptt\.buttonState/);
  });

  it('implements the generated spec and registers under the contract name', () => {
    expect(objcpp()).toMatch(/#import <OruSpecs\/OruSpecs\.h>/);
    expect(objcpp()).toMatch(
      /@interface NativeRadioModule : NativeRadioSpecBase <NativeRadioSpec[,>]/,
    );
    expect(objcpp()).toMatch(/RCT_EXPORT_MODULE\(NativeRadio\)/);
    expect(objcpp()).toMatch(/NativeRadioSpecJSI>\(params\)/);
  });

  it('implements all eleven amended section 6.1 and 12.2 selectors', () => {
    [
      '- (void)start:(RCTPromiseResolveBlock)resolve',
      '- (void)stop:(RCTPromiseResolveBlock)resolve',
      '- (void)pressPtt:(RCTPromiseResolveBlock)resolve',
      '- (void)releasePtt:(RCTPromiseResolveBlock)resolve',
      '- (void)getState:(RCTPromiseResolveBlock)resolve',
      '- (void)configurePtt:(RCTPromiseResolveBlock)resolve',
      '- (void)selectPttCandidate:(NSString *)deviceId',
      '- (void)forgetPtt:(RCTPromiseResolveBlock)resolve',
      '- (void)setAudioMode:(NSString *)mode',
      '- (void)getAppLocale:(RCTPromiseResolveBlock)resolve',
      '- (void)setAppLocale:(NSString *)locale',
    ].forEach(selector => expect(objcpp()).toContain(selector));
  });

  // P3 ios-routing task 6: RadioKit now classifies the route and persists the
  // mode setting for real, so the bridge's section 8 compile-keeping
  // placeholders (`placeholderAudioRoute`, `placeholderAudioMode`) are gone.
  // The invariant they protected -- the bridge carries no routing logic of
  // its own -- still holds: `projectLocked()` forwards RadioKit's own
  // `RadioState.asDictionary`, only optimistically overriding `audioMode`
  // while a `setAudioMode` call is in flight, and the off-state fallback
  // reads the real `AudioModeStore`/`AudioRoute()` rather than a literal.
  it('projects the real section 8 route/mode through RadioState, not a bridge-side stub', () => {
    const swift = read('ios/Oru/RadioBridge.swift');

    expect(swift).not.toContain('placeholderAudioRoute');
    expect(swift).not.toContain('placeholderAudioMode');

    // The happy path is RadioState.asDictionary verbatim -- audioRoute and
    // audioMode travel with it, not reconstructed here.
    expect(swift).toMatch(/var dictionary = state\.asDictionary/);

    // setAudioMode optimistically projects the new setting immediately (spec
    // section 8: onStateChanged must fire before the promise resolves), and
    // the override is cleared once the engine's own snapshot agrees.
    expect(swift).toContain('pendingAudioMode = setting');
    expect(swift).toMatch(/dictionary\["audioMode"\] = pendingAudioMode\.rawValue/);
    expect(swift).toMatch(/state\.audioMode == pendingAudioMode/);

    // The off state (radio never started, or stopped) reports the real
    // persisted setting and the real default route -- not a stub literal.
    expect(swift).toMatch(/"audioRoute": AudioRoute\(\)\.asDictionary/);
    expect(swift).toMatch(
      /"audioMode": \(pendingAudioMode \?\? audioModeStore\.load\(\)\)\.rawValue/,
    );

    // The real classification is RadioKit's; the bridge carries no routing
    // logic of its own.
    expect(swift).not.toMatch(/AVAudioSession/);
  });

  it('drives both event emitters', () => {
    expect(objcpp()).toMatch(/emitOnStateChanged:/);
    expect(objcpp()).toMatch(/emitOnError:/);
  });

  it('compiles both files into the app target', () => {
    expect(pbxproj()).toContain('RadioBridge.swift in Sources');
    expect(pbxproj()).toContain('NativeRadioModule.mm in Sources');
    expect(pbxproj()).toContain('SWIFT_OBJC_INTERFACE_HEADER_NAME = "Oru-Swift.h"');
  });

  it('leaves app entry to P7', () => {
    // AppDelegate.swift is P7's file: this plan makes the module callable and
    // does not call it from app entry.
    expect(read('ios/Oru/AppDelegate.swift')).not.toMatch(/RadioBridge/);
  });

  it('settles the pairing promise exactly once', () => {
    // failPairing() rejects from stop(), detach() and every section 13 error
    // event, any of which can land while engine.configurePtt is still in
    // flight. The engine's late completion must then be dropped rather than
    // settling an already-settled promise, and a superseded session must be
    // rejected rather than orphaned.
    expect(swift()).toMatch(/private var pairingSession = 0/);
    expect(swift()).toMatch(/guard claimed else \{ return \}/);
    expect(swift()).toMatch(/pairing_superseded/);
  });

  it('hands the event stream over safely across a reload', () => {
    // A stale module's invalidate must not mute the handlers a newer module
    // already installed on the shared bridge, and the closures are read from
    // the engine queue while written from the JS thread.
    expect(swift()).toMatch(/private weak var handlerOwner: AnyObject\?/);
    expect(swift()).toMatch(/@objc\(clearHandlersWithOwner:\)/);
    expect(swift()).not.toMatch(/@objc public var onStateChanged/);
    expect(objcpp()).toMatch(/clearHandlersWithOwner:self\]/);
  });
});
