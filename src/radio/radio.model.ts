import {atom, bind, computed, wrap} from '@reatom/core';

import {NativeRadioCallError, RadioEngineError, RadioNative} from './radio.native';
import {initialRadioState} from './radio.types';
import type {AudioMode, RadioNativeEvent, RadioState, ScreenState} from './radio.types';

/**
 * Re-exported so `src/ptt/ptt.pairing.model.ts` can tell a failed pairing
 * call (`configurePtt()` rejected — the empty-scan case among others) apart
 * from the other failures `configurePtt()` can return, without a model file
 * reaching past this one into `radio.native.ts` directly.
 */
export {NativeRadioCallError};

/**
 * Spec section 6: Reatom holds a *mirror* of engine state and is never the
 * source of truth. Every write below originates from the engine — a
 * `getState()` snapshot or a `stateChanged` event.
 */

/**
 * Spec section 13. The most recent failure the TypeScript layer saw, kept as
 * state so a screen can render it. Unrecoverable engine failures additionally
 * show up as `status: 'error'` inside `radio()`; recoverable ones (peer lost,
 * button disconnected) are state, not errors, and never land here.
 *
 * Cleared only when `start()` begins — the section 13 restart action.
 */
export const lastRadioError = atom<Error | null>(null, 'lastRadioError');

export const radio = atom<RadioState>(initialRadioState, 'radio').extend(
  target => {
    const sync = async () => {
      const state = await wrap(RadioNative.getState());
      if (state instanceof Error) {
        lastRadioError.set(state);
        return state;
      }

      target.set(state);
      return state;
    };

    const command = async (call: () => Promise<Error | null>) => {
      const result = await wrap(call());
      if (result instanceof Error) {
        lastRadioError.set(result);
        return result;
      }

      return null;
    };

    return {
      /** Section 6.2: pull one snapshot from the engine into the mirror. */
      sync,

      /** Section 6.2: start the engine, then re-sync. Also the restart action. */
      async start() {
        lastRadioError.set(null);

        const started = await wrap(RadioNative.start());
        if (started instanceof Error) {
          lastRadioError.set(started);
          return started;
        }

        return await sync();
      },

      stop() {
        return command(() => RadioNative.stop());
      },

      /**
       * Section 9.4: the on-screen button uses the same engine path as the
       * external one. The mirror is not touched — the engine decides when a
       * transmission actually starts and reports it via `stateChanged`.
       */
      pressPtt() {
        return command(() => RadioNative.pressPtt());
      },

      releasePtt() {
        return command(() => RadioNative.releasePtt());
      },

      /**
       * Amended section 6.1: opens the native pairing session and resolves once
       * the binding is saved. Progress arrives meanwhile as `pttPairing` inside
       * `stateChanged` events; a cancelled or timed-out session arrives as an
       * `error` event. The closing `sync()` is belt-and-braces so the saved
       * binding is in the mirror even if no final event fired — and it records
       * its own failure in `lastRadioError`, so nothing is swallowed silently.
       */
      async configurePtt() {
        const configuration = await wrap(RadioNative.configurePtt());
        if (configuration instanceof Error) {
          lastRadioError.set(configuration);
          return configuration;
        }

        await sync();
        return configuration;
      },

      /**
       * The user's pick from `radio().pttPairing.candidates`. The engine moves
       * the phase to `learning` and says so through `stateChanged`, so there is
       * nothing to sync here.
       */
      selectPttCandidate(deviceId: string) {
        return command(() => RadioNative.selectPttCandidate(deviceId));
      },

      /**
       * Spec section 8. The engine stores the setting (UserDefaults /
       * SharedPreferences) and republishes the state, so there is deliberately
       * no `sync()` and no local write here: the mirror moves when the
       * `stateChanged` event arrives, never from this call's return value.
       */
      setAudioMode(mode: AudioMode) {
        return command(() => RadioNative.setAudioMode(mode));
      },

      async forgetPtt() {
        const forgotten = await command(() => RadioNative.forgetPtt());
        if (forgotten instanceof Error) return forgotten;

        return await sync();
      },

      /** Section 6.1: apply one `RadioNativeEvent` from the engine. */
      applyEvent(event: RadioNativeEvent) {
        if (event.type === 'stateChanged') {
          target.set(event.state);
          return;
        }

        lastRadioError.set(
          new RadioEngineError({code: event.code, detail: event.message}),
        );
      },
    };
  },
);

/** Spec section 6.2, verbatim. `off` is checked first: a stopped radio is off
 * however stale the rest of the snapshot looks. */
export const screenState = computed<ScreenState>(
  () =>
    radio().status === 'off'
      ? 'off'
      : radio().transmitting
        ? 'transmitting'
        : radio().receiving
          ? 'receiving'
          : radio().nearbyCount === 0
            ? 'searching'
            : 'ready',
  'screenState',
);

/**
 * Hand this to `RadioNative.subscribe`. `bind` keeps the Reatom context alive
 * across the native callback boundary, which a raw callback would lose.
 * P7 owns the subscribing; the model owns being safe to call.
 */
export const radioEventListener = bind((event: RadioNativeEvent) => {
  radio.applyEvent(event);
});
