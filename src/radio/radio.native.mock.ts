import {createRealClock} from '../mock/mock.clock';
import {getMockScenario, onMockScenarioChange} from '../mock/mock.scenario';
import {MOCK_SCRIPTS} from './radio.mock.scripts';
import type {MockClock} from '../mock/mock.clock';
import type {MockScenarioName} from '../mock/mock.scenario';
import type {MockStatePatch, MockTimelineEntry} from './radio.mock.scripts';
import type {ResolveNativeRadio} from './radio.native';
import type {
  NativePttConfiguration,
  NativeRadioErrorPayload,
  NativeRadioState,
  Spec,
} from '../../specs/NativeRadio';

export {MOCK_SCRIPTS} from './radio.mock.scripts';

/**
 * Spec section 6.5 — the second implementation of the section 6.1 contract.
 *
 * Complete (every method of `specs/NativeRadio.ts`, both event streams, and the
 * candidate-selection step the section 9.3 pairing flow needs), deterministic
 * (no randomness, no real I/O, all timing through the injectable clock), and
 * driven by the seven named scenarios.
 *
 * It is a development tool, never a fallback: it is selected because the
 * `RADIO_BACKEND` flag says so, never because the native module is missing.
 */

export type MockRadioOptions = {
  scenario?: MockScenarioName;
  clock?: MockClock;
};

export type MockRadio = Spec & {
  /**
   * Re-arms the engine: cancels every pending timer, drops to the scenario's
   * pre-start `off` state, and optionally switches scenario or clock. Mutates
   * in place so registered listeners survive — that is what lets the Dev Menu
   * switch scenarios under a running app.
   */
  reset(options?: MockRadioOptions): void;
};

const clone = (state: NativeRadioState): NativeRadioState => ({
  status: state.status,
  nearbyCount: state.nearbyCount,
  transmitting: state.transmitting,
  receiving: state.receiving,
  pttButton: {...state.pttButton},
  audioRoute: {...state.audioRoute},
  audioMode: state.audioMode,
  ...(state.pttPairing
    ? {
        pttPairing: {
          phase: state.pttPairing.phase,
          candidates: state.pttPairing.candidates.map(candidate => ({
            ...candidate,
          })),
        },
      }
    : {}),
});

export function createMockRadio(options: MockRadioOptions = {}): MockRadio {
  let scenario: MockScenarioName = options.scenario ?? getMockScenario();
  let clock: MockClock = options.clock ?? createRealClock();

  const stateListeners = new Set<(state: NativeRadioState) => void>();
  const errorListeners = new Set<(error: NativeRadioErrorPayload) => void>();

  let cancels: Array<() => void> = [];
  // Pairing-session timers (configurePtt()'s scanMs/failAtMs,
  // selectPttCandidate()'s learnMs) live in their own list, separate from the
  // timeline's. A pairing session that gets superseded before its timers fire
  // must never leave them scheduled: an orphaned callback would act on
  // whatever session is live when it eventually fires, corrupting or
  // resolving/rejecting a session it has nothing to do with. Cleared at the
  // top of configurePtt() and selectPttCandidate(), and by cancelTimers().
  let pairingCancels: Array<() => void> = [];
  let rejectPairing: ((reason: Error) => void) | null = null;
  let resolvePairing: ((value: NativePttConfiguration) => void) | null = null;

  let state: NativeRadioState = {
    status: 'off',
    nearbyCount: 0,
    transmitting: false,
    receiving: false,
    pttButton: {...MOCK_SCRIPTS[scenario].button, connected: false},
    audioRoute: {kind: 'speaker', mode: 'voice'},
    audioMode: 'auto',
  };

  const publishState = () => {
    const snapshot = clone(state);
    stateListeners.forEach(listener => listener(snapshot));
  };

  const publishError = (code: string, message: string) => {
    errorListeners.forEach(listener => listener({code, message}));
  };

  const apply = (patch: MockStatePatch) => {
    const {pttButton, ...rest} = patch;
    state = {
      ...state,
      ...rest,
      pttButton: {...state.pttButton, ...pttButton},
    };
  };

  const cancelPairingTimers = () => {
    pairingCancels.forEach(cancel => cancel());
    pairingCancels = [];
  };

  const cancelTimers = () => {
    cancels.forEach(cancel => cancel());
    cancels = [];
    cancelPairingTimers();
  };

  const abortPairing = (reason: Error) => {
    const reject = rejectPairing;
    rejectPairing = null;
    resolvePairing = null;
    // Rebuilt field by field rather than rest-destructured: `pttPairing` is
    // optional in the contract and an absent field is the normal state, so it
    // must be *gone*, not present-and-undefined.
    //
    // audioRoute/audioMode are carried over, not reset: this function exists
    // only to drop `pttPairing` on a cancelled pairing session, which has
    // nothing to do with audio. Unlike `toOffState()` (which does drop to a
    // bare speaker route, because a stopped radio holds no accessory), a
    // pairing abort must not discard a natively-persisted user setting over
    // an unrelated event.
    state = {
      status: state.status,
      nearbyCount: state.nearbyCount,
      transmitting: state.transmitting,
      receiving: state.receiving,
      pttButton: {...state.pttButton},
      audioRoute: {...state.audioRoute},
      audioMode: state.audioMode,
    };
    reject?.(reason);
  };

  const runTimelineEntry = (entry: MockTimelineEntry) => {
    if (entry.kind === 'error') {
      publishError(entry.code, entry.message);
      return;
    }

    apply(entry.patch);
    publishState();
  };

  const armTimeline = () => {
    MOCK_SCRIPTS[scenario].timeline.forEach(entry => {
      cancels.push(clock.schedule(entry.at, () => runTimelineEntry(entry)));
    });
  };

  /** Section 9.2: the binding is stored natively and survives radio restarts. */
  const preservedButton = () => ({
    configured: state.pttButton.configured,
    connected: false,
    ...(state.pttButton.name === undefined
      ? {}
      : {name: state.pttButton.name}),
  });

  const toOffState = (): NativeRadioState => ({
    status: 'off',
    nearbyCount: 0,
    transmitting: false,
    receiving: false,
    pttButton: preservedButton(),
    // Section 8's setting is stored natively (UserDefaults / SharedPreferences),
    // so it outlives the engine exactly as the PTT binding does. The route does
    // not: a stopped radio is holding nothing.
    audioRoute: {kind: 'speaker', mode: 'voice'},
    audioMode: state.audioMode,
  });

  const radio: MockRadio = {
    async start() {
      cancelTimers();
      abortPairing(new Error('Pairing cancelled: the radio restarted'));
      state = {...toOffState(), status: 'starting'};
      publishState();
      armTimeline();
    },

    async stop() {
      cancelTimers();
      abortPairing(new Error('Pairing cancelled: the radio stopped'));
      state = toOffState();
      publishState();
    },

    async pressPtt() {
      // The `|| state.transmitting` half of this guard is not required by the
      // brief's literal rule ("no-op unless status === 'ready'") — it is a
      // deliberate de-duplication so a repeated press while already
      // transmitting does not re-apply the same patch and re-emit a state
      // that has not changed.
      if (state.status !== 'ready' || state.transmitting) return;
      apply({transmitting: true});
      publishState();
    },

    async releasePtt() {
      if (!state.transmitting) return;
      apply({transmitting: false});
      publishState();
    },

    async getState() {
      return clone(state);
    },

    configurePtt() {
      // A previous session's scanMs/failAtMs timers must never survive into
      // this one — see the comment on `pairingCancels`'s declaration.
      cancelPairingTimers();

      const script = MOCK_SCRIPTS[scenario].pairing;

      abortPairing(new Error('Pairing cancelled: a new session started'));

      state = {...state, pttPairing: {phase: 'scanning', candidates: []}};
      publishState();

      const pending = new Promise<NativePttConfiguration>((resolve, reject) => {
        resolvePairing = resolve;
        rejectPairing = reject;
      });

      pairingCancels.push(
        clock.schedule(script.scanMs, () => {
          state = {
            ...state,
            pttPairing: {
              phase: 'scanning',
              candidates: script.candidates.map(candidate => ({...candidate})),
            },
          };
          publishState();
        }),
      );

      if (script.failAtMs !== undefined && script.failure) {
        const {code, message} = script.failure;
        pairingCancels.push(
          clock.schedule(script.failAtMs, () => {
            publishError(code, message);
            abortPairing(new Error(`${code}: ${message}`));
            publishState();
          }),
        );
      }

      return pending;
    },

    async selectPttCandidate(deviceId: string) {
      const script = MOCK_SCRIPTS[scenario].pairing;
      const chosen = script.candidates.find(
        candidate => candidate.deviceId === deviceId,
      );
      // Intentional no-op for out-of-contract misuse (an unknown `deviceId`,
      // or a script with no `configuration`): the `configurePtt()` promise is
      // left unresolved rather than resolved or rejected. The seven scripts
      // never produce this — every candidate they offer resolves to a
      // configuration. The cancel below must stay under this guard: a
      // no-op call must not cancel the pending session's own scanMs/failAtMs
      // timers, or it would silently orphan that session's `configurePtt()`
      // promise instead of leaving it to resolve or fail on its own.
      if (!chosen || !script.configuration) return;

      // A previous session's leftover learnMs timer — or this session's own,
      // if called twice — must never survive into what follows here. See the
      // comment on `pairingCancels`'s declaration.
      cancelPairingTimers();

      state = {
        ...state,
        pttPairing: {phase: 'learning', candidates: [{...chosen}]},
      };
      publishState();

      const configuration = script.configuration;
      pairingCancels.push(
        clock.schedule(script.learnMs, () => {
          state = {
            ...state,
            pttButton: {
              configured: true,
              connected: true,
              name: configuration.name,
            },
            pttPairing: {phase: 'saved', candidates: []},
          };
          publishState();

          const resolve = resolvePairing;
          resolvePairing = null;
          rejectPairing = null;
          resolve?.({
            name: configuration.name,
            binding: {...configuration.binding},
          });
        }),
      );
    },

    /**
     * Section 8. Stores the pin and republishes *before* resolving, per the
     * implementation note in `specs/NativeRadio.ts`.
     *
     * A `voice`/`media` pin also moves the effective `audioRoute.mode`, because
     * that is what a real engine's profile apply does and it is the only way a
     * mock-driven screen can show a pinned mode. This is not policy: `auto`
     * deliberately leaves the effective mode exactly where the timeline put it,
     * and no hysteresis, rate limit or PTT-raise rule lives here. Section 7 is
     * P1's, on both platforms.
     */
    async setAudioMode(mode: string) {
      const pin = mode as NativeRadioState['audioMode'];
      state = {
        ...state,
        audioMode: pin,
        audioRoute:
          pin === 'auto' ? state.audioRoute : {...state.audioRoute, mode: pin},
      };
      publishState();
    },

    async forgetPtt() {
      state = {
        ...state,
        pttButton: {configured: false, connected: false},
      };
      publishState();
    },

    onStateChanged(handler) {
      stateListeners.add(handler);
      return {
        remove() {
          stateListeners.delete(handler);
        },
      };
    },

    onError(handler) {
      errorListeners.add(handler);
      return {
        remove() {
          errorListeners.delete(handler);
        },
      };
    },

    reset(next: MockRadioOptions = {}) {
      cancelTimers();
      abortPairing(new Error('Pairing cancelled: the mock engine was reset'));

      if (next.scenario !== undefined) scenario = next.scenario;
      if (next.clock !== undefined) clock = next.clock;

      state = {
        status: 'off',
        nearbyCount: 0,
        transmitting: false,
        receiving: false,
        pttButton: {...MOCK_SCRIPTS[scenario].button, connected: false},
        audioRoute: {kind: 'speaker', mode: 'voice'},
        audioMode: 'auto',
      };
      publishState();
    },
  };

  return radio;
}

/**
 * The process-wide instance the `RADIO_BACKEND=mock` binding resolves to. It
 * re-arms itself whenever the scenario changes, which is how one Dev Menu entry
 * per scenario switches the whole app live.
 */
export const mockRadio: MockRadio = createMockRadio();

onMockScenarioChange(scenario => {
  mockRadio.reset({scenario});
});

export const resolveMockRadio: ResolveNativeRadio = () => mockRadio;
