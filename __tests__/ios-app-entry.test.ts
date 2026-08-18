import {readFileSync} from 'fs';
import {join} from 'path';

const appDelegate = readFileSync(
  join(__dirname, '..', 'ios', 'Oru', 'AppDelegate.swift'),
  'utf8',
);

describe('the iOS app delegate — spec sections 6.2 and 12', () => {
  it('no longer boots the phase 0 spike', () => {
    // The spike started the engine at launch, which contradicts section 12's
    // `off` state and section 5's power key being the only way out of it.
    expect(appDelegate).not.toMatch(/RadioSpike/);
    // A bare `import RadioKit` re-adds the spike module without naming any of
    // its types, which the pattern above would not see.
    expect(appDelegate).not.toMatch(/^import RadioKit$/m);
  });

  it('no longer covers the React Native root with the spike panel', () => {
    expect(appDelegate).not.toMatch(/SpikeControlPanelPresenter/);
  });

  it('still starts React Native with the registered component name', () => {
    expect(appDelegate).toMatch(/startReactNative\(/);
    expect(appDelegate).toMatch(/withModuleName: "Oru"/);
  });

  it('keeps the debug/release bundle split', () => {
    expect(appDelegate).toMatch(/jsBundleURL\(forBundleRoot: "index"\)/);
    expect(appDelegate).toMatch(/forResource: "main", withExtension: "jsbundle"/);
  });
});
