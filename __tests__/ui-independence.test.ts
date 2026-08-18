import {readFileSync, readdirSync} from 'fs';
import {join} from 'path';

const REPO_ROOT = join(__dirname, '..');

function sourcesUnder(relative: string): Array<[string, string]> {
  const absolute = join(REPO_ROOT, relative);
  return readdirSync(absolute, {withFileTypes: true}).flatMap<[string, string]>(
    entry => {
      const child = `${relative}/${entry.name}`;
      // Recursive on purpose: a non-recursive walk drops every file in a
      // subdirectory silently, with no failing test to signal the lost
      // coverage, the moment src/ui or src/screens grows one.
      if (entry.isDirectory()) {
        return sourcesUnder(child);
      }
      return entry.isFile() && /\.tsx?$/.test(entry.name)
        ? [[child, readFileSync(join(absolute, entry.name), 'utf8')]]
        : [];
    },
  );
}

/**
 * Spec section 6.4, as a test rather than as a promise.
 *
 * "The UI layer depends on the RadioNative contract (section 6.1) and on nothing
 * else. It never references a Turbo Module, a transport, a platform or a device
 * -- directly or transitively." That rule is what made the design-first order
 * safe, and section 15 Stage 3 accepts this plan by the merged Stage 2 screens
 * surviving the mock-to-real swap unmodified. A screen that reaches around the
 * contract would break silently on a device and pass every test here, so the
 * import boundary is asserted directly.
 */
describe('UI independence (spec section 6.4)', () => {
  const uiSources = [...sourcesUnder('src/screens'), ...sourcesUnder('src/ui')];

  it('finds the screens it is supposed to be guarding', () => {
    expect(uiSources.length).toBeGreaterThan(4);
  });

  it.each(uiSources)('%s imports no native binding', (_name, source) => {
    expect(source).not.toMatch(/from '.*radio\.native/);
    expect(source).not.toMatch(/TurboModuleRegistry/);
    expect(source).not.toMatch(/NativeModules/);
    expect(source).not.toMatch(/from '.*specs\/NativeRadio/);
  });

  it.each(uiSources)('%s imports no platform or device API', (_name, source) => {
    expect(source).not.toMatch(/\bPermissionsAndroid\b/);
    expect(source).not.toMatch(/from 'react-native\/Libraries/);
  });
});
