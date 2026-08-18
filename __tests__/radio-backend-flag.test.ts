import {readFileSync} from 'fs';
import {join} from 'path';

import {
  DEFAULT_MOCK_SCENARIO,
  MOCK_SCENARIOS,
  getMockScenario,
  setMockScenario,
} from '../src/mock/mock.scenario';
import {registerMockScenarioDevMenu} from '../src/dev/mockScenarioDevMenu';
import {RadioNative} from '../src/radio/radio.native';
import {mockRadio} from '../src/radio/radio.native.mock';

const REPO_ROOT = join(__dirname, '..');
const read = (relative: string): string =>
  readFileSync(join(REPO_ROOT, relative), 'utf8');

/**
 * Spec section 6.5. The dev default flipped to `native` when the Turbo Module
 * landed (section 15 Stage 3); `RADIO_BACKEND=mock` stays available for design
 * work, demos and screenshots, and is what this suite runs under.
 *
 * The default itself is asserted against the source rather than at runtime:
 * both operands are inlined by Babel at transform time, so a test cannot switch
 * them, and folding them at compile time is precisely what drops the mock module
 * from release bundles.
 */
describe('the RADIO_BACKEND flag — spec section 6.5', () => {
  afterEach(() => {
    setMockScenario(DEFAULT_MOCK_SCENARIO);
    mockRadio.reset();
  });

  it('defaults to the real Turbo Module in dev', () => {
    const source = read('src/radio/radio.native.ts');
    expect(source).toMatch(
      /const backend: 'mock' \| 'native' = __DEV__\s*\?\s*process\.env\.RADIO_BACKEND === 'mock'\s*\?\s*'mock'\s*:\s*'native'\s*:\s*'native';/,
    );
  });

  it('keeps the mock behind a foldable ternary so release bundles drop it', () => {
    const source = read('src/radio/radio.native.ts');
    expect(source).toMatch(/backend === 'mock'/);
    expect(source).toMatch(/require\('\.\/radio\.native\.mock'\)/);
    // A static import would keep the mock in Metro's graph even though nothing
    // calls it, and section 6.5 requires it absent, not merely unreachable.
    expect(source).not.toMatch(/^import .* from '\.\/radio\.native\.mock';$/m);
  });

  it('pins the test suite to the mock backend', () => {
    expect(read('jest.config.js')).toMatch(
      /process\.env\.RADIO_BACKEND = 'mock';/,
    );
  });

  it('binds RadioNative to the mock under RADIO_BACKEND=mock', () => {
    mockRadio.reset({scenario: 'happy'});

    return RadioNative.getState().then(async state => {
      expect(state).toMatchObject({status: 'off', nearbyCount: 0});

      await RadioNative.start();
      await expect(RadioNative.getState()).resolves.toMatchObject({
        status: 'starting',
      });
    });
  });

  it('re-arms the singleton when the scenario changes', async () => {
    await RadioNative.start();
    setMockScenario('button-lost');

    await expect(RadioNative.getState()).resolves.toMatchObject({
      status: 'off',
      pttButton: {configured: true, connected: false, name: 'ORU-PTT-01'},
    });
  });
});

describe('the mock scenario Dev Menu', () => {
  afterEach(() => setMockScenario(DEFAULT_MOCK_SCENARIO));

  it('registers one entry per scenario, and each entry switches to it', () => {
    const entries: Array<{title: string; handler: () => void}> = [];

    registerMockScenarioDevMenu({
      addMenuItem: (title, handler) => entries.push({title, handler}),
    });

    expect(entries).toHaveLength(MOCK_SCENARIOS.length);
    expect(entries.map(entry => entry.title)).toEqual(
      MOCK_SCENARIOS.map(scenario => `Radio scenario: ${scenario}`),
    );

    entries[4].handler();
    expect(getMockScenario()).toBe(MOCK_SCENARIOS[4]);
  });
});
