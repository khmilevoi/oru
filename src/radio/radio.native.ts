import * as errore from 'errore';
import {TurboModuleRegistry} from 'react-native';

import {parsePttConfiguration} from '../ptt/ptt.binding';
import type {PttBindingParseError} from '../ptt/ptt.binding';
import type {PttConfiguration} from '../ptt/ptt.types';
import type {Spec} from '../../specs/NativeRadio';
import type {AudioMode, RadioNativeEvent, RadioState} from './radio.types';

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
  /**
   * Section 8. Fire-and-forget: the engine stores the setting and republishes
   * the state, so the caller never writes the mirror from this result.
   */
  setAudioMode(mode: AudioMode): Promise<NativeRadioError | null>;
  /**
   * Amended section 12.2's stored language override. A plain native store with
   * no engine behind it and no `stateChanged` echo: `src/app/locale.model.ts`
   * owns activating the catalog and narrowing the stored string.
   */
  getAppLocale(): Promise<NativeRadioError | string | null>;
  setAppLocale(locale: string): Promise<NativeRadioError | null>;
  subscribe(
    listener: (event: RadioNativeEvent) => void,
  ): NativeRadioError | RadioNativeSubscription;
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

    try {
      return await call(native);
    } catch (cause) {
      return new NativeRadioCallError({method, cause});
    }
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

    setAudioMode: mode =>
      invokeVoid('setAudioMode', native => native.setAudioMode(mode)),

    getAppLocale: () => invoke('getAppLocale', native => native.getAppLocale()),

    setAppLocale: locale =>
      invokeVoid('setAppLocale', native => native.setAppLocale(locale)),

    getState: () => invoke('getState', native => native.getState()),

    async configurePtt() {
      const raw = await invoke('configurePtt', native => native.configurePtt());
      if (raw instanceof Error) return raw;

      return parsePttConfiguration(raw);
    },

    subscribe(listener) {
      const native = resolve();
      if (native instanceof Error) return native;

      /**
       * Collected one at a time, not built as an array literal from two calls:
       * against a partially-wired native module (P5 must wire two emitters,
       * the newest part of the contract) the second registration can throw,
       * and whatever was already registered above must not leak.
       */
      const subscriptions: RadioNativeSubscription[] = [];
      try {
        subscriptions.push(
          native.onStateChanged(state => listener({type: 'stateChanged', state})),
        );
        subscriptions.push(
          native.onError(payload =>
            listener({type: 'error', code: payload.code, message: payload.message}),
          ),
        );
      } catch (cause) {
        subscriptions.forEach(subscription => subscription.remove());
        return new NativeRadioCallError({method: 'subscribe', cause});
      }

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

/**
 * Spec section 6.5. Both operands are inlined at build time -- `__DEV__` by the
 * React Native Babel preset, `process.env.RADIO_BACKEND` by
 * `babel-plugin-transform-inline-environment-variables` -- so `backend` is a
 * compile-time constant. A release build is therefore always `'native'`: the
 * flag cannot reach it and nothing can switch it at runtime.
 *
 * The dev default is `'native'` as of section 15 Stage 3: the Turbo Module is
 * real on both platforms. `RADIO_BACKEND=mock` remains the way design work,
 * demos, screenshots and the Jest suite run.
 */
const backend: 'mock' | 'native' = __DEV__
  ? process.env.RADIO_BACKEND === 'mock'
    ? 'mock'
    : 'native'
  : 'native';

/** Spec section 6.2 calls this object `RadioNative`. */
export const RadioNative = createRadioNative(
  backend === 'mock'
    ? // Deliberately a require inside the folded branch, not a top-level
      // import: Metro runs constant folding before dependency collection, so
      // this edge disappears from a release bundle entirely. A static import
      // would keep the mock module in the graph even though nothing calls it,
      // and section 6.5 requires it to be absent, not merely unreachable.
      (require('./radio.native.mock') as typeof import('./radio.native.mock'))
        .resolveMockRadio
    : resolveRadioNativeModule,
);
