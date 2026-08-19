import type {MockScenarioName} from '../mock/mock.scenario';
import type {
  NativeAudioRoute,
  NativePttButtonState,
  NativePttCandidate,
  NativePttConfiguration,
  NativeRadioState,
} from '../../specs/NativeRadio';

/**
 * Spec section 6.5. The scenarios are *data*: the engine in
 * `radio.native.mock.ts` holds every behavioural rule that is the same in all
 * seven, and reads only the differences from here.
 */

export type MockStatePatch = Partial<
  Omit<NativeRadioState, 'pttButton' | 'pttPairing'>
> & {
  pttButton?: Partial<NativePttButtonState>;
};

export type MockTimelineEntry =
  | {at: number; kind: 'state'; patch: MockStatePatch}
  | {at: number; kind: 'error'; code: string; message: string};

export type MockPairingScript = {
  /** Milliseconds from `configurePtt()` until the candidate list is published. */
  scanMs: number;
  candidates: readonly NativePttCandidate[];
  /** Milliseconds from `selectPttCandidate()` until the learn result. */
  learnMs: number;
  /** Published when the learn step completes. Absent when `failure` is set. */
  configuration?: NativePttConfiguration;
  /** Milliseconds from `configurePtt()` until the session fails. */
  failAtMs?: number;
  failure?: {code: string; message: string};
};

export type MockRadioScript = {
  /** The button state the scenario boots with, before the first `start()`. */
  button: NativePttButtonState;
  timeline: readonly MockTimelineEntry[];
  pairing: MockPairingScript;
};

const CANDIDATES: readonly NativePttCandidate[] = [
  {deviceId: 'mock-ptt-01', name: 'ORU-PTT-01', rssi: -52},
  {deviceId: 'mock-ptt-02', name: 'BT-REMOTE', rssi: -71},
];

const CONFIGURATION: NativePttConfiguration = {
  name: 'ORU-PTT-01',
  binding: {
    type: 'ble',
    deviceId: 'mock-ptt-01',
    serviceUuid: '0000ffe0-0000-1000-8000-00805f9b34fb',
    characteristicUuid: '0000ffe1-0000-1000-8000-00805f9b34fb',
    pressedValue: '01',
    releasedValue: '00',
  },
};

const SUCCESSFUL_PAIRING: MockPairingScript = {
  scanMs: 900,
  candidates: CANDIDATES,
  learnMs: 1200,
  configuration: CONFIGURATION,
};

const NO_BUTTON: NativePttButtonState = {configured: false, connected: false};

/**
 * Section 8. The scenarios are data: these are the route snapshots the
 * timelines below step through, named once so the two Bluetooth entries cannot
 * drift apart.
 */
const SPEAKER: NativeAudioRoute = {kind: 'speaker', mode: 'voice'};
const WIRED: NativeAudioRoute = {kind: 'wired', mode: 'voice'};
const HEADSET_VOICE: NativeAudioRoute = {
  kind: 'bluetooth',
  label: 'AirPods Pro',
  mode: 'voice',
};
const HEADSET_MEDIA: NativeAudioRoute = {...HEADSET_VOICE, mode: 'media'};

export const MOCK_SCRIPTS: Record<MockScenarioName, MockRadioScript> = {
  happy: {
    button: NO_BUTTON,
    timeline: [
      {at: 800, kind: 'state', patch: {status: 'ready'}},
      {at: 2000, kind: 'state', patch: {nearbyCount: 1}},
      // The headset connects mid-session: section 9's "BT headset connects, no
      // music" row.
      {at: 3000, kind: 'state', patch: {audioRoute: HEADSET_VOICE}},
      {at: 5000, kind: 'state', patch: {nearbyCount: 2}},
      // Music starts -- section 7's VOICE -> MEDIA switch.
      {at: 6000, kind: 'state', patch: {audioRoute: HEADSET_MEDIA}},
      {at: 8000, kind: 'state', patch: {receiving: true}},
      {at: 11000, kind: 'state', patch: {receiving: false}},
      // Music stops -- MEDIA -> VOICE after the long side of the hysteresis.
      {at: 12000, kind: 'state', patch: {audioRoute: HEADSET_VOICE}},
      // The headset walks out of range: straight back to the loudspeaker.
      {at: 14000, kind: 'state', patch: {audioRoute: SPEAKER}},
    ],
    pairing: SUCCESSFUL_PAIRING,
  },

  solo: {
    button: NO_BUTTON,
    timeline: [
      {at: 800, kind: 'state', patch: {status: 'ready'}},
      // Wired headphones: playback moves, the phone mic stays. No profile
      // conflict exists off Bluetooth Classic, so the mode never leaves voice.
      {at: 2000, kind: 'state', patch: {audioRoute: WIRED}},
      {at: 4000, kind: 'state', patch: {audioRoute: SPEAKER}},
    ],
    pairing: SUCCESSFUL_PAIRING,
  },

  'pairing-success': {
    button: NO_BUTTON,
    timeline: [
      {at: 800, kind: 'state', patch: {status: 'ready'}},
      {at: 1500, kind: 'state', patch: {nearbyCount: 1}},
    ],
    pairing: SUCCESSFUL_PAIRING,
  },

  'pairing-empty': {
    button: NO_BUTTON,
    timeline: [
      {at: 800, kind: 'state', patch: {status: 'ready'}},
      {at: 1500, kind: 'state', patch: {nearbyCount: 1}},
    ],
    pairing: {
      scanMs: 900,
      candidates: [],
      learnMs: 1200,
      failAtMs: 2400,
      failure: {
        code: 'PTT_SCAN_EMPTY',
        message: 'No push-to-talk buttons answered the scan',
      },
    },
  },

  'button-lost': {
    button: {configured: true, connected: false, name: 'ORU-PTT-01'},
    timeline: [
      {at: 800, kind: 'state', patch: {status: 'ready'}},
      {at: 1200, kind: 'state', patch: {nearbyCount: 1}},
      {at: 1200, kind: 'state', patch: {pttButton: {connected: true}}},
      {at: 4000, kind: 'state', patch: {pttButton: {connected: false}}},
      {at: 9000, kind: 'state', patch: {pttButton: {connected: true}}},
    ],
    pairing: SUCCESSFUL_PAIRING,
  },

  'engine-error': {
    button: NO_BUTTON,
    timeline: [
      {at: 800, kind: 'state', patch: {status: 'ready'}},
      {at: 1200, kind: 'state', patch: {nearbyCount: 1}},
      {
        at: 3000,
        kind: 'error',
        code: 'NEARBY_UNAVAILABLE',
        message: 'Nearby Connections is unavailable on this device',
      },
      {at: 3000, kind: 'state', patch: {status: 'error', nearbyCount: 0}},
    ],
    pairing: SUCCESSFUL_PAIRING,
  },

  onboarding: {
    button: NO_BUTTON,
    timeline: [
      {at: 800, kind: 'state', patch: {status: 'ready'}},
      {at: 2000, kind: 'state', patch: {nearbyCount: 1}},
    ],
    pairing: SUCCESSFUL_PAIRING,
  },
};
