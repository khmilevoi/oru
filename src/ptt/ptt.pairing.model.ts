import {action, atom, computed, wrap} from '@reatom/core';

import {radio} from '../radio/radio.model';

/**
 * The four-step learning flow of spec section 9.3, as section 12.1's `03
 * Pairing` refines it, plus the failure the empty scan produces.
 *
 * Every step but `failed` is read straight off the contract's `pttPairing`, so
 * the screen holds no flow state of its own and a resume re-sync
 * (`getState()`) lands the user back where they were.
 */
export type PairingStep =
  | 'scanning'
  | 'picking'
  | 'learning'
  | 'saved'
  | 'failed';

/**
 * Section 6.1 publishes three pairing phases and no `empty`, so an empty scan
 * arrives here as the `Error` that `radio.configurePtt()` returns (section 13:
 * fallible functions return `Error | T`). This atom is that error, and the
 * `failed` step is its only consumer.
 */
export const pairingError = atom<Error | null>(null, 'pairingError');

export const pairingStep = computed<PairingStep>(() => {
  if (pairingError()) return 'failed';

  const pairing = radio().pttPairing;
  if (!pairing) return 'scanning';
  if (pairing.phase === 'learning') return 'learning';
  if (pairing.phase === 'saved') return 'saved';

  return pairing.candidates.length === 0 ? 'scanning' : 'picking';
}, 'pairingStep');

export const pairingCandidates = computed(
  () => radio().pttPairing?.candidates ?? [],
  'pairingCandidates',
);

/** Opens a session, or re-opens one after a failure. Also the Retry action. */
export const startPairing = action(async () => {
  pairingError.set(null);

  const configuration = await wrap(radio.configurePtt());
  if (configuration instanceof Error) {
    pairingError.set(configuration);
    return configuration;
  }

  return configuration;
}, 'startPairing');

export const pickPttCandidate = action(async (deviceId: string) => {
  const result = await wrap(radio.selectPttCandidate(deviceId));
  if (result instanceof Error) pairingError.set(result);

  return result;
}, 'pickPttCandidate');

/** Called when the flow closes, so a later session starts clean. */
export const resetPairing = action(() => {
  pairingError.set(null);
}, 'resetPairing');
