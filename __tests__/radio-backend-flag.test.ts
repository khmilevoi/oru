import {
  DEFAULT_MOCK_SCENARIO,
  MOCK_SCENARIOS,
  getMockScenario,
  setMockScenario,
} from '../src/mock/mock.scenario';
import {registerMockScenarioDevMenu} from '../src/dev/mockScenarioDevMenu';
import {RadioNative} from '../src/radio/radio.native';
import {mockRadio} from '../src/radio/radio.native.mock';

describe('the RADIO_BACKEND flag — spec section 6.5', () => {
  afterEach(() => {
    setMockScenario(DEFAULT_MOCK_SCENARIO);
    mockRadio.reset();
  });

  it('binds RadioNative to the mock under the dev default', async () => {
    mockRadio.reset({scenario: 'happy'});

    await expect(RadioNative.getState()).resolves.toMatchObject({
      status: 'off',
      nearbyCount: 0,
    });

    await RadioNative.start();

    await expect(RadioNative.getState()).resolves.toMatchObject({
      status: 'starting',
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
