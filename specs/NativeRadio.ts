import type {CodegenTypes, TurboModule} from 'react-native';
import {TurboModuleRegistry} from 'react-native';

/**
 * Spec section 6.1, as React Native's Codegen can express it. Read by Codegen
 * (P5 wires it up) and, types only, by `src/radio/radio.native.ts`.
 *
 * Do not import this module for its value anywhere: the default export calls
 * `getEnforcing`, which throws whenever the native module is absent — under
 * Jest, always. `radio.native.ts` uses `TurboModuleRegistry.get` instead and
 * imports from here with `import type`, which erases at build time.
 */

export type NativePttButtonState = {
  configured: boolean;
  connected: boolean;
  name?: string;
};

export type NativePttCandidate = {
  deviceId: string;
  name: string;
  rssi: number;
};

export type NativePttPairingState = {
  phase: 'scanning' | 'learning' | 'saved';
  candidates: Array<NativePttCandidate>;
};

/**
 * Spec section 8. Codegen handles a typed alias whose fields are string-literal
 * unions and one optional string, exactly as `NativePttPairingState` above
 * proves, so this shape crosses the bridge intact.
 *
 * `mode` is the *effective* audio profile the engine is running — never the
 * user's `audioMode` pin, which is a separate field because `auto` is not a
 * profile. The UI renders this; it never computes it (section 7 is the
 * platforms' pure policy).
 */
export type NativeAudioRoute = {
  kind: 'speaker' | 'wired' | 'bluetooth' | 'usb';
  /**
   * The accessory's own name, as the platform reports it, for Bluetooth
   * routes. Absent for every other kind, and absent rather than empty when a
   * Bluetooth device reports no name.
   */
  label?: string;
  mode: 'voice' | 'media';
};

export type NativeRadioState = {
  status: 'off' | 'starting' | 'ready' | 'error';
  nearbyCount: number;
  transmitting: boolean;
  receiving: boolean;
  pttButton: NativePttButtonState;
  /** Spec section 8. Always present: there is always a route in use. */
  audioRoute: NativeAudioRoute;
  /**
   * Spec section 8's persisted setting, published back so JavaScript mirrors
   * the engine rather than guessing. `auto` runs the section 7 policy;
   * `voice`/`media` pin the profile.
   */
  audioMode: 'auto' | 'voice' | 'media';
  /**
   * Present only while a pairing session is running. Codegen handles an
   * optional alias, a string-literal union and an array of a typed alias, so
   * this shape crosses the bridge intact — unlike `NativePttBinding` below.
   */
  pttPairing?: NativePttPairingState;
};

export type NativeRadioErrorPayload = {
  code: string;
  message: string;
};

/**
 * Flat on purpose: Codegen supports unions of string literals only, so the
 * section 9.2 discriminated union cannot cross the bridge. `parsePttBinding`
 * in `src/ptt/ptt.binding.ts` narrows this into that union.
 */
export type NativePttBinding = {
  type: 'ble' | 'hid';
  deviceId?: string;
  serviceUuid?: string;
  characteristicUuid?: string;
  pressedValue?: string;
  releasedValue?: string;
  keyCode?: number;
};

export type NativePttConfiguration = {
  name: string;
  binding: NativePttBinding;
};

export interface Spec extends TurboModule {
  /**
   * Implementation requirement, not enforceable by this type: `start`,
   * `stop`, `pressPtt`, `releasePtt` and `forgetPtt` (below) must each emit
   * `onStateChanged` with the state the call produced *before* the returned
   * promise resolves. `src/radio/radio.model.ts`'s mirror of these five never
   * writes itself from the call's own return value — only from that event —
   * because section 6 makes the engine, not the TypeScript layer, the source
   * of truth. A method that resolves without emitting leaves the mirror
   * (and the screen reading it) frozen on stale state, silently: the promise
   * still resolves, nothing throws, and Jest cannot catch this, because the
   * mock implementation (`src/radio/radio.native.mock.ts`) always calls
   * `publishState()` before resolving. Every test that presses PTT or powers
   * the radio off passes because the mock is a good citizen, not because
   * anything checks that a real implementation is.
   */
  start(): Promise<void>;
  stop(): Promise<void>;

  pressPtt(): Promise<void>;
  releasePtt(): Promise<void>;

  getState(): Promise<NativeRadioState>;

  /**
   * Opens the native pairing session and resolves when the binding is saved.
   * Progress is published through `onStateChanged` as `pttPairing`; a cancelled
   * or timed-out session surfaces through `onError`.
   */
  configurePtt(): Promise<NativePttConfiguration>;
  /** The user's choice from `pttPairing.candidates` during the `scanning` phase. */
  selectPttCandidate(deviceId: string): Promise<void>;
  /** Must emit `onStateChanged` before resolving — see the note on `start()` above. */
  forgetPtt(): Promise<void>;

  /**
   * Spec section 8. Stores the setting natively (UserDefaults /
   * SharedPreferences, the `PttBindingStore` pattern) and applies it. Must
   * emit `onStateChanged` before resolving — see the note on `start()` above:
   * the model never writes its mirror from this call's return value.
   *
   * Typed `string` and not the union because Codegen accepts string-literal
   * unions in *type aliases*, not in method parameters. `radio.native.ts`
   * narrows it on the way in.
   */
  setAudioMode(mode: string): Promise<void>;

  /**
   * Amended section 12.2 (2026-08-19): the in-app language override. Stored
   * natively (UserDefaults `com.oru.appLocale` / SharedPreferences — the
   * `setAudioMode` persistence pattern, because no JS storage layer exists)
   * and read back at bootstrap, where a stored value beats the system locale.
   *
   * Purely a store: unlike `setAudioMode` there is no engine to apply this to
   * and no `onStateChanged` echo — JavaScript owns activating the catalog.
   * `null` means no override was ever stored: the app follows the system
   * locale. Typed `string`, not the `AppLocale` union, for the same Codegen
   * reason as `setAudioMode`; `src/app/locale.model.ts` narrows on the way in.
   */
  getAppLocale(): Promise<string | null>;
  setAppLocale(locale: string): Promise<void>;

  /**
   * Section 6.1's `RadioNativeEvent` union, split in two: Codegen generates a
   * union of object types as an untyped map, which would erase every field.
   * `radio.native.ts` re-tags these back into the single union. There is no
   * third emitter for pairing — it rides on `NativeRadioState.pttPairing`.
   */
  readonly onStateChanged: CodegenTypes.EventEmitter<NativeRadioState>;
  readonly onError: CodegenTypes.EventEmitter<NativeRadioErrorPayload>;
}

export default TurboModuleRegistry.getEnforcing<Spec>('NativeRadio');
