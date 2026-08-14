import * as errore from 'errore';
import {TurboModuleRegistry} from 'react-native';

import {parsePttConfiguration} from '../ptt/ptt.binding';
import type {PttBindingParseError} from '../ptt/ptt.binding';
import type {PttConfiguration} from '../ptt/ptt.types';
import type {Spec} from '../../specs/NativeRadio';
import type {RadioNativeEvent, RadioState} from './radio.types';

/**
 * Spec section 6.1. The single place in the TypeScript layer that knows a
 * Turbo Module exists. Above this file the app only ever sees domain types and
 * returned error values; nothing here throws.
 *
 * The name both platforms must register under. P5 wires the Kotlin and
 * Objective-C++ modules to exactly this string.
 */
export const NATIVE_RADIO_MODULE_NAME = 'NativeRadio';

export class NativeRadioUnavailableError extends errore.createTaggedError({
  name: 'NativeRadioUnavailableError',
  message: 'Turbo Module $moduleName is not registered on this platform',
}) {}

export class NativeRadioCallError extends errore.createTaggedError({
  name: 'NativeRadioCallError',
  message: 'RadioNative.$method rejected',
}) {}

/**
 * Spec section 13: the engine reports failures as `error { code, message }`
 * events. This is that event once it has become a value the app can carry.
 * `$message` is errore's own built-in placeholder, so the engine's text is
 * carried as `$detail`.
 */
export class RadioEngineError extends errore.createTaggedError({
  name: 'RadioEngineError',
  message: 'Radio engine reported $code: $detail',
}) {}

export type NativeRadioError = NativeRadioUnavailableError | NativeRadioCallError;

/** Only `remove` is ever needed, and it is all a test double has to provide. */
export type RadioNativeSubscription = {remove: () => void};

export type ResolveNativeRadio = () => NativeRadioUnavailableError | Spec;

export type RadioNativeApi = {
  start(): Promise<NativeRadioError | null>;
  stop(): Promise<NativeRadioError | null>;
  pressPtt(): Promise<NativeRadioError | null>;
  releasePtt(): Promise<NativeRadioError | null>;
  getState(): Promise<NativeRadioError | RadioState>;
  /** Resolves when the pairing session has saved a binding. */
  configurePtt(): Promise<
    NativeRadioError | PttBindingParseError | PttConfiguration
  >;
  selectPttCandidate(deviceId: string): Promise<NativeRadioError | null>;
  forgetPtt(): Promise<NativeRadioError | null>;
  subscribe(
    listener: (event: RadioNativeEvent) => void,
  ): NativeRadioUnavailableError | RadioNativeSubscription;
};

/**
 * `RadioNativeApi.getState` is annotated with the *domain* `RadioState` while
 * the implementation returns the spec file's `NativeRadioState`. That is the
 * compile-time proof that the two shapes have not drifted apart; if they ever
 * do, `pnpm typecheck` fails right here. Do not relax this annotation.
 */
export function createRadioNative(resolve: ResolveNativeRadio): RadioNativeApi {
  const invoke = async <T>(method: string, call: (native: Spec) => Promise<T>) => {
    const native = resolve();
    if (native instanceof Error) return native;

    return await call(native).catch(
      cause => new NativeRadioCallError({method, cause}),
    );
  };

  const invokeVoid = async (method: string, call: (native: Spec) => Promise<void>) => {
    const result = await invoke(method, call);
    if (result instanceof Error) return result;
    return null;
  };

  return {
    start: () => invokeVoid('start', native => native.start()),
    stop: () => invokeVoid('stop', native => native.stop()),
    pressPtt: () => invokeVoid('pressPtt', native => native.pressPtt()),
    releasePtt: () => invokeVoid('releasePtt', native => native.releasePtt()),
    forgetPtt: () => invokeVoid('forgetPtt', native => native.forgetPtt()),

    selectPttCandidate: deviceId =>
      invokeVoid('selectPttCandidate', native =>
        native.selectPttCandidate(deviceId),
      ),

    getState: () => invoke('getState', native => native.getState()),

    async configurePtt() {
      const raw = await invoke('configurePtt', native => native.configurePtt());
      if (raw instanceof Error) return raw;

      return parsePttConfiguration(raw);
    },

    subscribe(listener) {
      const native = resolve();
      if (native instanceof Error) return native;

      const subscriptions: RadioNativeSubscription[] = [
        native.onStateChanged(state => listener({type: 'stateChanged', state})),
        native.onError(payload =>
          listener({type: 'error', code: payload.code, message: payload.message}),
        ),
      ];

      return {
        remove() {
          subscriptions.forEach(subscription => subscription.remove());
        },
      };
    },
  };
}

/**
 * `get` (not `getEnforcing`) returns `null` instead of throwing when the module
 * is absent, which is the normal state under Jest and before P5 lands.
 * Resolution happens per call, so importing this module is always safe.
 */
export const resolveRadioNativeModule: ResolveNativeRadio = () => {
  const native = TurboModuleRegistry.get<Spec>(NATIVE_RADIO_MODULE_NAME);
  if (native == null) {
    return new NativeRadioUnavailableError({moduleName: NATIVE_RADIO_MODULE_NAME});
  }

  return native;
};

/** Spec section 6.2 calls this object `RadioNative`. */
export const RadioNative = createRadioNative(resolveRadioNativeModule);
