import {action, atom, computed, wrap} from '@reatom/core';

import {NativeRadioCallError, radio} from '../radio/radio.model';

/**
 * The four-step learning flow of spec section 9.3, as section 12.1's `03
 * Pairing` refines it, plus the failure the empty scan produces.
 *
 * Every step but `failed` is read straight off the contract's `pttPairing`, so
 * the screen holds no flow state of its own and a resume re-sync
 * (`getState()`) lands the user back where they were -- provided the write
 * that lands there is the live session's. `startPairing()` is called again on
 * every mount, and the engine aborts whatever session was still pending when
 * that happens (see `radio.native.mock.ts`'s `abortPairing`): the aborted
 * call's `RadioNative.configurePtt()` resolves, not rejects, with a returned
 * `NativeRadioCallError`, so its suspended continuation runs to completion
 * regardless of whether anything still wants its answer. `generation`, the
 * module-level counter below, is what tells that continuation it has been
 * superseded so it can skip `pairingError.set(...)` instead of clobbering a
 * freshly-opened session's genuine `scanning`/`picking` state.
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

/**
 * True when the `failed` step's error is the one kind of failure the seven
 * mock scenarios exercise today: a scan that ran and came back with nothing,
 * surfaced as a rejected `configurePtt()` call (`NativeRadioCallError` in
 * `radio.native.ts`'s vocabulary — see `radio.native.mock.ts`'s
 * `pairing-empty` script). `PairingFlow` shows this case as "no buttons
 * found".
 *
 * `NativeRadioUnavailableError` (the Turbo Module itself is not registered)
 * and `PttBindingParseError` (the call succeeded but returned a binding the
 * app cannot parse) are different problems that a real backend can also
 * return from `configurePtt()` -- neither is a report that the scan found
 * nothing, so `PairingFlow` shows those generically instead, with the
 * error's own message, the same way `RadioErrorState` in `RadioScreen.tsx`
 * shows `lastRadioError`'s message: a diagnostic from native code, verbatim,
 * because translating it would be a lie.
 */
export const pairingFailureIsScanEmpty = computed(
  () => pairingError() instanceof NativeRadioCallError,
  'pairingFailureIsScanEmpty',
);

/**
 * Bookkeeping about which `startPairing()` call is the live one, not app
 * state anything renders -- deliberately a plain module variable, not an
 * atom, and kept out of the reactive graph.
 *
 * Every mount calls `startPairing()` unconditionally, with no check for a
 * session already in flight, and the engine aborts (rather than ignores) a
 * still-pending previous session the moment a new one opens. That abort
 * surfaces to the abandoned call as a returned error, not a thrown one (see
 * this file's top comment), so its `await` resumes and its continuation runs
 * to completion. `session` lets that stale continuation recognise itself as
 * stale and skip writing.
 */
let generation = 0;

/** Opens a session, or re-opens one after a failure. Also the Retry action. */
export const startPairing = action(async () => {
  const session = (generation += 1);
  pairingError.set(null);

  const configuration = await wrap(radio.configurePtt());
  // A newer `startPairing()` call has since superseded this one -- its
  // `NativeRadioCallError` is this abandoned session's engine-level abort,
  // not a live failure, so it must not overwrite the fresh session's state.
  if (generation !== session) return configuration;

  if (configuration instanceof Error) {
    pairingError.set(configuration);
    return configuration;
  }

  return configuration;
}, 'startPairing');

export const pickPttCandidate = action(async (deviceId: string) => {
  const session = generation;
  const result = await wrap(radio.selectPttCandidate(deviceId));
  // Same guard as `startPairing()`: a pick that belonged to a session a later
  // `startPairing()` has since superseded must not report its outcome.
  if (generation !== session) return result;

  if (result instanceof Error) pairingError.set(result);

  return result;
}, 'pickPttCandidate');

/** Called when the flow closes, so a later session starts clean. */
export const resetPairing = action(() => {
  pairingError.set(null);
  // Bumps the session past whatever `startPairing()`/`pickPttCandidate()`
  // continuation is still in flight for the flow that just closed, so a late
  // resolution from that abandoned session fails the `generation === session`
  // guard those actions check and cannot write into a closed flow.
  generation += 1;
}, 'resetPairing');
