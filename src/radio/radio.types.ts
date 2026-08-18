/**
 * Spec section 6.1, as the app sees it. Every screen and the Reatom model use
 * these types; the Codegen-facing counterparts live in `specs/NativeRadio.ts`
 * and differ only where Codegen cannot express a shape.
 */

/**
 * Spec section 6.1. `'off'` is the state the radio is in **before `start()`
 * and after `stop()`**: nothing is advertising, discovering, capturing or
 * playing, and the mirror carries no peers. It exists because the main screen
 * owns a first-class power toggle (sections 5 and 12) and, by section 6.4's own
 * rule, a fact a screen needs but the contract does not carry means the
 * contract is extended rather than reached around.
 */
export type RadioStatus = 'off' | 'starting' | 'ready' | 'error';

export type PttButtonState = {
  configured: boolean;
  connected: boolean;
  name?: string;
};

/** The four-step pairing flow of section 9.3, as the amended contract publishes it. */
export type PttPairingPhase = 'scanning' | 'learning' | 'saved';

export type PttCandidate = {
  deviceId: string;
  name: string;
  rssi: number;
};

export type PttPairingState = {
  phase: PttPairingPhase;
  candidates: PttCandidate[];
};

export type RadioState = {
  status: RadioStatus;
  nearbyCount: number;
  transmitting: boolean;
  receiving: boolean;
  pttButton: PttButtonState;
  /**
   * Present only while a pairing session is running, so an absent field is the
   * normal state. Riding on `RadioState` is what makes `getState()` resume
   * re-sync cover pairing too, and what keeps `screenState` untouched.
   */
  pttPairing?: PttPairingState;
};

export type RadioNativeEvent =
  | {type: 'stateChanged'; state: RadioState}
  | {type: 'error'; code: string; message: string};

/** Spec section 6.2: the five states the main screen renders. */
export type ScreenState =
  | 'off'
  | 'searching'
  | 'ready'
  | 'transmitting'
  | 'receiving';

/**
 * What the mirror holds before the first `getState()` answers. The engine is
 * the source of truth, and before `start()` the engine is off — so the mirror
 * starts in `off` and knows nothing. `pttPairing` is deliberately omitted: no
 * pairing session is running.
 */
export const initialRadioState: RadioState = {
  status: 'off',
  nearbyCount: 0,
  transmitting: false,
  receiving: false,
  pttButton: {configured: false, connected: false},
};
