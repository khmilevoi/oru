import type {EventSubscription} from 'react-native';

import {
  NATIVE_RADIO_MODULE_NAME,
  NativeRadioCallError,
  NativeRadioUnavailableError,
  RadioNative,
  createRadioNative,
} from '../src/radio/radio.native';
import {PttBindingParseError} from '../src/ptt/ptt.binding';
import type {
  NativePttConfiguration,
  NativeRadioErrorPayload,
  NativeRadioState,
  Spec,
} from '../specs/NativeRadio';
import type {RadioNativeEvent} from '../src/radio/radio.types';

const nativeState: NativeRadioState = {
  status: 'ready',
  nearbyCount: 3,
  transmitting: false,
  receiving: true,
  pttButton: {configured: true, connected: true, name: 'PTT Button'},
};

const pairingState: NativeRadioState = {
  ...nativeState,
  pttPairing: {
    phase: 'scanning',
    candidates: [{deviceId: 'C4:2B:19:07:AA:31', name: 'PTT-687266', rssi: -61}],
  },
};

const nativeConfiguration: NativePttConfiguration = {
  name: 'PTT Button',
  binding: {
    type: 'ble',
    deviceId: 'C4:2B:19:07:AA:31',
    serviceUuid: '0000fff0-0000-1000-8000-00805f9b34fb',
    characteristicUuid: '0000fff1-0000-1000-8000-00805f9b34fb',
    pressedValue: '01',
    releasedValue: '00',
  },
};

/**
 * `EventSubscription` is React Native's fat legacy interface; a test double
 * only ever needs `remove`, so the cast is deliberate and contained.
 */
function fakeSubscription() {
  const remove = jest.fn();
  return {subscription: {remove} as unknown as EventSubscription, remove};
}

function fakeModule(overrides: Partial<Spec> = {}): Spec {
  return {
    start: jest.fn(async () => undefined),
    stop: jest.fn(async () => undefined),
    pressPtt: jest.fn(async () => undefined),
    releasePtt: jest.fn(async () => undefined),
    getState: jest.fn(async () => nativeState),
    configurePtt: jest.fn(async () => nativeConfiguration),
    selectPttCandidate: jest.fn(async () => undefined),
    forgetPtt: jest.fn(async () => undefined),
    onStateChanged: jest.fn(() => fakeSubscription().subscription),
    onError: jest.fn(() => fakeSubscription().subscription),
    ...overrides,
  };
}

describe('RadioNative when the Turbo Module is missing', () => {
  const radio = createRadioNative(
    () => new NativeRadioUnavailableError({moduleName: NATIVE_RADIO_MODULE_NAME}),
  );

  it('returns an unavailable error from every call instead of throwing', async () => {
    await expect(radio.start()).resolves.toBeInstanceOf(NativeRadioUnavailableError);
    await expect(radio.stop()).resolves.toBeInstanceOf(NativeRadioUnavailableError);
    await expect(radio.pressPtt()).resolves.toBeInstanceOf(NativeRadioUnavailableError);
    await expect(radio.releasePtt()).resolves.toBeInstanceOf(
      NativeRadioUnavailableError,
    );
    await expect(radio.getState()).resolves.toBeInstanceOf(
      NativeRadioUnavailableError,
    );
    await expect(radio.configurePtt()).resolves.toBeInstanceOf(
      NativeRadioUnavailableError,
    );
    await expect(radio.selectPttCandidate('C4:2B:19:07:AA:31')).resolves.toBeInstanceOf(
      NativeRadioUnavailableError,
    );
    await expect(radio.forgetPtt()).resolves.toBeInstanceOf(
      NativeRadioUnavailableError,
    );
  });

  it('returns an unavailable error from subscribe', () => {
    expect(radio.subscribe(() => {})).toBeInstanceOf(NativeRadioUnavailableError);
  });

  it('is what the real singleton does under Jest, where no module is registered', async () => {
    await expect(RadioNative.start()).resolves.toBeInstanceOf(
      NativeRadioUnavailableError,
    );
  });
});

describe('RadioNative against a working module', () => {
  it('resolves void calls to null and forwards them', async () => {
    const native = fakeModule();
    const radio = createRadioNative(() => native);

    await expect(radio.start()).resolves.toBeNull();
    await expect(radio.stop()).resolves.toBeNull();
    await expect(radio.pressPtt()).resolves.toBeNull();
    await expect(radio.releasePtt()).resolves.toBeNull();
    await expect(radio.forgetPtt()).resolves.toBeNull();

    expect(native.start).toHaveBeenCalledTimes(1);
    expect(native.pressPtt).toHaveBeenCalledTimes(1);
    expect(native.releasePtt).toHaveBeenCalledTimes(1);
  });

  it('passes the engine snapshot through unchanged', async () => {
    const radio = createRadioNative(() => fakeModule());

    await expect(radio.getState()).resolves.toEqual(nativeState);
  });

  it('carries an in-progress pairing session through untouched', async () => {
    const radio = createRadioNative(() =>
      fakeModule({getState: jest.fn(async () => pairingState)}),
    );

    await expect(radio.getState()).resolves.toEqual(pairingState);
  });

  it('forwards the picked candidate to the engine', async () => {
    const native = fakeModule();
    const radio = createRadioNative(() => native);

    await expect(radio.selectPttCandidate('C4:2B:19:07:AA:31')).resolves.toBeNull();

    expect(native.selectPttCandidate).toHaveBeenCalledWith('C4:2B:19:07:AA:31');
  });

  it('converts a rejection into a call error that names the method and keeps the cause', async () => {
    const boom = new Error('engine exploded');
    const radio = createRadioNative(() =>
      fakeModule({getState: jest.fn(async () => Promise.reject(boom))}),
    );

    const result = await radio.getState();

    expect(result).toBeInstanceOf(NativeRadioCallError);
    expect((result as NativeRadioCallError).method).toBe('getState');
    expect((result as NativeRadioCallError).cause).toBe(boom);
  });

  it('narrows the configuration returned by the learning flow', async () => {
    const radio = createRadioNative(() => fakeModule());

    await expect(radio.configurePtt()).resolves.toEqual({
      name: 'PTT Button',
      binding: {
        type: 'ble',
        deviceId: 'C4:2B:19:07:AA:31',
        serviceUuid: '0000fff0-0000-1000-8000-00805f9b34fb',
        characteristicUuid: '0000fff1-0000-1000-8000-00805f9b34fb',
        pressedValue: '01',
        releasedValue: '00',
      },
    });
  });

  it('reports a malformed configuration as a parse error', async () => {
    const radio = createRadioNative(() =>
      fakeModule({
        configurePtt: jest.fn(async () => ({
          name: 'PTT Button',
          binding: {type: 'ble' as const, deviceId: 'C4:2B:19:07:AA:31'},
        })),
      }),
    );

    await expect(radio.configurePtt()).resolves.toBeInstanceOf(PttBindingParseError);
  });
});

describe('RadioNative event subscription (spec section 6.1)', () => {
  /**
   * Collect the handlers the wrapper registers in arrays rather than in `let`
   * bindings: TypeScript does not track assignments made inside a callback, so
   * a `let handler: Fn | null = null` would still read as `null` afterwards.
   */
  function subscribingModule() {
    const stateSubscription = fakeSubscription();
    const errorSubscription = fakeSubscription();
    const stateHandlers: Array<
      (state: NativeRadioState) => void | Promise<void>
    > = [];
    const errorHandlers: Array<
      (payload: NativeRadioErrorPayload) => void | Promise<void>
    > = [];

    const native = fakeModule({
      onStateChanged: handler => {
        stateHandlers.push(handler);
        return stateSubscription.subscription;
      },
      onError: handler => {
        errorHandlers.push(handler);
        return errorSubscription.subscription;
      },
    });

    return {
      native,
      stateHandlers,
      errorHandlers,
      stateSubscription,
      errorSubscription,
    };
  }

  it('re-tags both native streams into one RadioNativeEvent union', () => {
    const {native, stateHandlers, errorHandlers} = subscribingModule();
    const radio = createRadioNative(() => native);

    const seen: RadioNativeEvent[] = [];
    expect(radio.subscribe(event => seen.push(event))).not.toBeInstanceOf(Error);

    expect(stateHandlers).toHaveLength(1);
    expect(errorHandlers).toHaveLength(1);

    stateHandlers.forEach(handler => handler(nativeState));
    errorHandlers.forEach(handler =>
      handler({code: 'NEARBY_FAILED', message: 'advertising failed'}),
    );

    expect(seen).toEqual([
      {type: 'stateChanged', state: nativeState},
      {type: 'error', code: 'NEARBY_FAILED', message: 'advertising failed'},
    ]);
  });

  it('removes both native subscriptions', () => {
    const {native, stateSubscription, errorSubscription} = subscribingModule();
    const radio = createRadioNative(() => native);

    const subscription = radio.subscribe(() => {});
    if (subscription instanceof Error) throw subscription;
    subscription.remove();

    expect(stateSubscription.remove).toHaveBeenCalledTimes(1);
    expect(errorSubscription.remove).toHaveBeenCalledTimes(1);
  });
});
