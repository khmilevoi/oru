import {context} from '@reatom/core';

jest.mock('../src/radio/radio.native', () => ({
  ...jest.requireActual('../src/radio/radio.native'),
  RadioNative: {
    start: jest.fn(),
    stop: jest.fn(),
    pressPtt: jest.fn(),
    releasePtt: jest.fn(),
    getState: jest.fn(),
    configurePtt: jest.fn(),
    selectPttCandidate: jest.fn(),
    forgetPtt: jest.fn(),
    subscribe: jest.fn(),
  },
}));

import {NativeRadioCallError, RadioNative} from '../src/radio/radio.native';
import {appLifecycle, applyAppLifecycle} from '../src/app/app.model';
import {lastRadioError, radio} from '../src/radio/radio.model';
import type {RadioState} from '../src/radio/radio.types';

const native = RadioNative as jest.Mocked<typeof RadioNative>;

const readyState: RadioState = {
  status: 'ready',
  nearbyCount: 2,
  transmitting: false,
  receiving: false,
  pttButton: {configured: false, connected: false},
};

beforeEach(() => {
  context.reset();
  jest.clearAllMocks();
});

describe('resume re-sync (spec section 6.2)', () => {
  it('records the lifecycle without syncing when the app leaves the foreground', async () => {
    await expect(applyAppLifecycle('background')).resolves.toBeNull();

    expect(appLifecycle()).toBe('background');
    expect(native.getState).not.toHaveBeenCalled();
  });

  it('re-syncs the mirror when the app comes back', async () => {
    native.getState.mockResolvedValue(readyState);
    await applyAppLifecycle('background');

    await expect(applyAppLifecycle('active')).resolves.toEqual(readyState);

    expect(appLifecycle()).toBe('active');
    expect(native.getState).toHaveBeenCalledTimes(1);
    expect(radio()).toEqual(readyState);
  });

  it('does not re-sync when the app was already active', async () => {
    native.getState.mockResolvedValue(readyState);

    await expect(applyAppLifecycle('active')).resolves.toBeNull();

    expect(native.getState).not.toHaveBeenCalled();
  });

  it('re-syncs after an inactive interlude too', async () => {
    native.getState.mockResolvedValue(readyState);
    await applyAppLifecycle('inactive');

    await applyAppLifecycle('active');

    expect(native.getState).toHaveBeenCalledTimes(1);
  });

  it('returns and records a failed re-sync', async () => {
    const failure = new NativeRadioCallError({method: 'getState'});
    native.getState.mockResolvedValue(failure);
    await applyAppLifecycle('background');

    await expect(applyAppLifecycle('active')).resolves.toBe(failure);

    expect(lastRadioError()).toBe(failure);
  });

  // The contract amendment puts pairing progress on RadioState precisely so that
  // resume re-sync covers it with no extra machinery. This is that claim, tested.
  it('restores a pairing session that continued while the UI was suspended', async () => {
    const midPairing: RadioState = {
      status: 'ready',
      nearbyCount: 2,
      transmitting: false,
      receiving: false,
      pttButton: {configured: false, connected: false},
      pttPairing: {
        phase: 'learning',
        candidates: [
          {deviceId: 'C4:2B:19:07:AA:31', name: 'PTT-687266', rssi: -61},
        ],
      },
    };
    native.getState.mockResolvedValue(midPairing);
    await applyAppLifecycle('background');

    await applyAppLifecycle('active');

    expect(radio().pttPairing?.phase).toBe('learning');
  });
});
