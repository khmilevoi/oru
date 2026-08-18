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
