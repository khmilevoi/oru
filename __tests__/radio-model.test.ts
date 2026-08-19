import {context} from '@reatom/core';

// Only `RadioNative` is replaced. The error classes stay real, because the model
// constructs `RadioEngineError` and every assertion below uses `instanceof`.
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
    setAudioMode: jest.fn(),
    subscribe: jest.fn(),
  },
}));

import {
  NativeRadioCallError,
  RadioEngineError,
  RadioNative,
} from '../src/radio/radio.native';
import {
  lastRadioError,
  radio,
  radioEventListener,
  screenState,
} from '../src/radio/radio.model';
import {initialRadioState} from '../src/radio/radio.types';
import type {PttConfiguration} from '../src/ptt/ptt.types';
import type {RadioNativeEvent, RadioState, ScreenState} from '../src/radio/radio.types';

const native = RadioNative as jest.Mocked<typeof RadioNative>;

const readyState: RadioState = {
  status: 'ready',
  nearbyCount: 2,
  transmitting: false,
  receiving: false,
  pttButton: {configured: true, connected: true, name: 'PTT Button'},
  audioRoute: {kind: 'speaker', mode: 'voice'},
  audioMode: 'auto',
};

const scanningState: RadioState = {
  ...readyState,
  pttButton: {configured: false, connected: false},
  pttPairing: {
    phase: 'scanning',
    candidates: [{deviceId: 'C4:2B:19:07:AA:31', name: 'PTT-687266', rssi: -61}],
  },
};

const configuration: PttConfiguration = {
  name: 'PTT Button',
  binding: {type: 'hid', keyCode: 85},
};

beforeEach(() => {
  context.reset();
  jest.clearAllMocks();
});

describe('the radio mirror (spec section 6.2)', () => {
  it('starts empty and off', () => {
    expect(radio()).toEqual(initialRadioState);
    expect(screenState()).toBe('off');
    expect(lastRadioError()).toBeNull();
  });

  it('sync() copies the engine snapshot into the mirror', async () => {
    native.getState.mockResolvedValue(readyState);

    await expect(radio.sync()).resolves.toEqual(readyState);

    expect(radio()).toEqual(readyState);
    expect(screenState()).toBe('ready');
  });

  it('sync() leaves the mirror alone and records the failure', async () => {
    const failure = new NativeRadioCallError({method: 'getState'});
    native.getState.mockResolvedValue(failure);

    await expect(radio.sync()).resolves.toBe(failure);

    expect(radio()).toEqual(initialRadioState);
    expect(lastRadioError()).toBe(failure);
  });

  it('start() starts the engine and then re-syncs', async () => {
    native.start.mockResolvedValue(null);
    native.getState.mockResolvedValue(readyState);

    await expect(radio.start()).resolves.toEqual(readyState);

    expect(native.start).toHaveBeenCalledTimes(1);
    expect(native.getState).toHaveBeenCalledTimes(1);
    expect(radio()).toEqual(readyState);
  });

  it('start() does not sync when the engine refused to start', async () => {
    const failure = new NativeRadioCallError({method: 'start'});
    native.start.mockResolvedValue(failure);

    await expect(radio.start()).resolves.toBe(failure);

    expect(native.getState).not.toHaveBeenCalled();
    expect(lastRadioError()).toBe(failure);
  });

  it('start() clears a previous failure before retrying, which is the section 13 restart', async () => {
    lastRadioError.set(new NativeRadioCallError({method: 'getState'}));
    native.start.mockResolvedValue(null);
    native.getState.mockResolvedValue(readyState);

    await radio.start();

    expect(lastRadioError()).toBeNull();
  });

  it('pressPtt() and releasePtt() forward to the engine and never touch the mirror', async () => {
    native.getState.mockResolvedValue(readyState);
    await radio.sync();
    native.pressPtt.mockResolvedValue(null);
    native.releasePtt.mockResolvedValue(null);

    await expect(radio.pressPtt()).resolves.toBeNull();
    await expect(radio.releasePtt()).resolves.toBeNull();

    expect(native.pressPtt).toHaveBeenCalledTimes(1);
    expect(native.releasePtt).toHaveBeenCalledTimes(1);
    expect(radio()).toEqual(readyState);
  });

  it('records a failed pressPtt', async () => {
    const failure = new NativeRadioCallError({method: 'pressPtt'});
    native.pressPtt.mockResolvedValue(failure);

    await expect(radio.pressPtt()).resolves.toBe(failure);

    expect(lastRadioError()).toBe(failure);
  });

  it('stop() forwards to the engine', async () => {
    native.stop.mockResolvedValue(null);

    await expect(radio.stop()).resolves.toBeNull();

    expect(native.stop).toHaveBeenCalledTimes(1);
  });
});

describe('the pairing flow (amended section 6.1)', () => {
  it('configurePtt() resolves with the saved binding and re-syncs the mirror', async () => {
    native.configurePtt.mockResolvedValue(configuration);
    native.getState.mockResolvedValue(readyState);

    await expect(radio.configurePtt()).resolves.toEqual(configuration);

    expect(native.getState).toHaveBeenCalledTimes(1);
    expect(radio()).toEqual(readyState);
  });

  it('records a cancelled or failed pairing session', async () => {
    const failure = new NativeRadioCallError({method: 'configurePtt'});
    native.configurePtt.mockResolvedValue(failure);

    await expect(radio.configurePtt()).resolves.toBe(failure);

    expect(native.getState).not.toHaveBeenCalled();
    expect(lastRadioError()).toBe(failure);
  });

  it('selectPttCandidate() forwards the device id and waits for the engine to publish the phase', async () => {
    native.selectPttCandidate.mockResolvedValue(null);
    radio.set(scanningState);

    await expect(
      radio.selectPttCandidate('C4:2B:19:07:AA:31'),
    ).resolves.toBeNull();

    expect(native.selectPttCandidate).toHaveBeenCalledWith('C4:2B:19:07:AA:31');
    expect(radio()).toEqual(scanningState);
  });

  it('records a failed candidate selection', async () => {
    const failure = new NativeRadioCallError({method: 'selectPttCandidate'});
    native.selectPttCandidate.mockResolvedValue(failure);

    await expect(radio.selectPttCandidate('C4:2B:19:07:AA:31')).resolves.toBe(
      failure,
    );

    expect(lastRadioError()).toBe(failure);
  });

  it('forgetPtt() re-syncs so the settings screen sees the binding gone', async () => {
    native.forgetPtt.mockResolvedValue(null);
    native.getState.mockResolvedValue(initialRadioState);

    await expect(radio.forgetPtt()).resolves.toEqual(initialRadioState);

    expect(native.forgetPtt).toHaveBeenCalledTimes(1);
    expect(radio()).toEqual(initialRadioState);
  });

  it('a stateChanged event carries pairing progress into the mirror', () => {
    radio.applyEvent({type: 'stateChanged', state: scanningState});

    expect(radio().pttPairing?.phase).toBe('scanning');
    expect(radio().pttPairing?.candidates).toEqual([
      {deviceId: 'C4:2B:19:07:AA:31', name: 'PTT-687266', rssi: -61},
    ]);
  });

  it('leaves pttPairing absent when no session is running', () => {
    radio.applyEvent({type: 'stateChanged', state: readyState});

    expect(radio().pttPairing).toBeUndefined();
  });
});

describe('engine events (spec section 6.1)', () => {
  it('a stateChanged event replaces the mirror', () => {
    radio.applyEvent({type: 'stateChanged', state: readyState});

    expect(radio()).toEqual(readyState);
    expect(screenState()).toBe('ready');
  });

  it('an error event becomes a RadioEngineError carrying the code', () => {
    radio.applyEvent({
      type: 'error',
      code: 'NEARBY_FAILED',
      message: 'advertising failed',
    });

    const recorded = lastRadioError();
    expect(recorded).toBeInstanceOf(RadioEngineError);
    expect((recorded as RadioEngineError).code).toBe('NEARBY_FAILED');
    expect(recorded?.message).toContain('advertising failed');
  });

  it('radioEventListener works when called from outside a Reatom frame', () => {
    radioEventListener({type: 'stateChanged', state: readyState});

    expect(radio()).toEqual(readyState);
  });
});

describe('RadioNative.subscribe wired to radioEventListener (the P7 seam)', () => {
  it('routes a stateChanged and an error event from the subscribed engine into the mirror', () => {
    // Collected in an array, not a `let` binding: TypeScript does not track
    // assignments made inside a callback, so a `let` would still read as its
    // initial value afterwards — see radio-native.test.ts's
    // subscribingModule() for the same convention against the real module.
    const listeners: Array<(event: RadioNativeEvent) => void> = [];
    native.subscribe.mockImplementation(listener => {
      listeners.push(listener);
      return {remove: jest.fn()};
    });

    const subscription = RadioNative.subscribe(radioEventListener);
    if (subscription instanceof Error) throw subscription;

    expect(listeners).toHaveLength(1);

    listeners.forEach(listener => listener({type: 'stateChanged', state: readyState}));
    expect(radio()).toEqual(readyState);

    listeners.forEach(listener =>
      listener({type: 'error', code: 'NEARBY_FAILED', message: 'advertising failed'}),
    );
    const recorded = lastRadioError();
    expect(recorded).toBeInstanceOf(RadioEngineError);
    expect((recorded as RadioEngineError).code).toBe('NEARBY_FAILED');
    expect(recorded?.message).toContain('advertising failed');
  });
});

describe('screenState (spec section 6.2)', () => {
  // Mutable tuple array, no `as const`: `as const` would make each state deeply
  // readonly and `radio.set(state)` would stop typechecking.
  const cases: Array<[ScreenState, RadioState]> = [
    ['searching', {...readyState, nearbyCount: 0}],
    ['ready', readyState],
    ['receiving', {...readyState, receiving: true}],
    ['transmitting', {...readyState, transmitting: true}],
    ['transmitting', {...readyState, transmitting: true, receiving: true}],
    ['transmitting', {...readyState, transmitting: true, nearbyCount: 0}],
    ['receiving', {...readyState, receiving: true, nearbyCount: 0}],
  ];

  it.each(cases)('is %s', (expected, state) => {
    radio.set(state);

    expect(screenState()).toBe(expected);
  });

  // The contract amendment's central claim: pairing rides on RadioState without
  // adding a fifth main-screen state. If someone later folds pttPairing into
  // screenState, these fail.
  const pairingCases: Array<[ScreenState, RadioState]> = [
    ['ready', scanningState],
    ['searching', {...scanningState, nearbyCount: 0}],
    ['transmitting', {...scanningState, transmitting: true}],
    [
      'receiving',
      {...readyState, receiving: true, pttPairing: {phase: 'learning', candidates: []}},
    ],
    ['ready', {...readyState, pttPairing: {phase: 'saved', candidates: []}}],
  ];

  it.each(pairingCases)('is still %s during a pairing session', (expected, state) => {
    radio.set(state);

    expect(screenState()).toBe(expected);
  });
});

describe('spec section 6.1/6.2 — the off state', () => {
  it('starts the mirror in off, because nothing has been started yet', () => {
    expect(initialRadioState.status).toBe('off');
    expect(radio().status).toBe('off');
    expect(screenState()).toBe('off');
  });

  it('renders off ahead of every other screen state', () => {
    const offWhileBusy: RadioState = {
      ...initialRadioState,
      status: 'off',
      nearbyCount: 3,
      transmitting: true,
      receiving: true,
    };

    radio.applyEvent({type: 'stateChanged', state: offWhileBusy});

    expect(screenState()).toBe('off');
  });

  it('leaves off as soon as the engine reports it is starting', () => {
    radio.applyEvent({
      type: 'stateChanged',
      state: {...initialRadioState, status: 'starting'},
    });

    expect(screenState()).toBe('searching');
  });

  it('returns to off when the engine reports a stopped radio', () => {
    radio.applyEvent({
      type: 'stateChanged',
      state: {...initialRadioState, status: 'ready', nearbyCount: 2},
    });
    expect(screenState()).toBe('ready');

    radio.applyEvent({type: 'stateChanged', state: initialRadioState});

    expect(screenState()).toBe('off');
  });
});

describe('section 8 — the audio route and the audioMode setting', () => {
  it('mirrors an audioRoute arriving on a stateChanged event', () => {
    radio.applyEvent({
      type: 'stateChanged',
      state: {
        ...readyState,
        audioRoute: {kind: 'bluetooth', label: 'AirPods Pro', mode: 'media'},
        audioMode: 'auto',
      },
    });

    expect(radio().audioRoute).toEqual({
      kind: 'bluetooth',
      label: 'AirPods Pro',
      mode: 'media',
    });
    expect(radio().audioMode).toBe('auto');
  });

  it('starts on the speaker in voice, with the setting on auto', () => {
    expect(radio().audioRoute).toEqual({kind: 'speaker', mode: 'voice'});
    expect(radio().audioMode).toBe('auto');
  });

  it('passes the setting to the engine and does not touch the mirror', async () => {
    native.setAudioMode.mockResolvedValue(null);

    const result = await radio.setAudioMode('media');

    expect(native.setAudioMode).toHaveBeenCalledWith('media');
    expect(result).toBeNull();
    // The engine is the source of truth: nothing moved until it says so.
    expect(radio().audioMode).toBe('auto');
  });

  it('records a failed setAudioMode as the last error', async () => {
    const failure = new NativeRadioCallError({method: 'setAudioMode'});
    native.setAudioMode.mockResolvedValue(failure);

    const result = await radio.setAudioMode('voice');

    expect(result).toBe(failure);
    expect(lastRadioError()).toBe(failure);
  });
});
