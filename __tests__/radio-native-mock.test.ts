import {createManualClock} from '../src/mock/mock.clock';
import {MOCK_SCRIPTS, createMockRadio} from '../src/radio/radio.native.mock';
import type {MockRadio} from '../src/radio/radio.native.mock';
import type {ManualClock} from '../src/mock/mock.clock';
import type {MockScenarioName} from '../src/mock/mock.scenario';
import type {
  NativeRadioErrorPayload,
  NativeRadioState,
} from '../specs/NativeRadio';

type Harness = {
  radio: MockRadio;
  clock: ManualClock;
  states: NativeRadioState[];
  errors: NativeRadioErrorPayload[];
};

const harness = (scenario: MockScenarioName): Harness => {
  const clock = createManualClock();
  const radio = createMockRadio({scenario, clock});
  const states: NativeRadioState[] = [];
  const errors: NativeRadioErrorPayload[] = [];

  radio.onStateChanged(state => {
    states.push(state);
  });
  radio.onError(error => {
    errors.push(error);
  });

  return {radio, clock, states, errors};
};

describe('the mock engine — spec section 6.5', () => {
  it('reports off before the first start, in every scenario', async () => {
    for (const scenario of Object.keys(MOCK_SCRIPTS) as MockScenarioName[]) {
      const {radio} = harness(scenario);
      const state = await radio.getState();

      expect(state.status).toBe('off');
      expect(state.nearbyCount).toBe(0);
      expect(state.transmitting).toBe(false);
      expect(state.receiving).toBe(false);
    }
  });

  it('plays the happy script: starting, ready, peers, inbound audio', async () => {
    const {radio, clock} = harness('happy');

    await radio.start();
    expect((await radio.getState()).status).toBe('starting');

    clock.advance(800);
    expect((await radio.getState()).status).toBe('ready');

    clock.advance(1200);
    expect((await radio.getState()).nearbyCount).toBe(1);

    clock.advance(3000);
    expect((await radio.getState()).nearbyCount).toBe(2);

    clock.advance(3000);
    expect((await radio.getState()).receiving).toBe(true);

    clock.advance(3000);
    expect((await radio.getState()).receiving).toBe(false);
  });

  it('transmits on press and stops on release, once the engine is ready', async () => {
    const {radio, clock} = harness('happy');

    await radio.start();
    await radio.pressPtt();
    expect((await radio.getState()).transmitting).toBe(false);

    clock.advance(800);
    await radio.pressPtt();
    expect((await radio.getState()).transmitting).toBe(true);

    await radio.releasePtt();
    expect((await radio.getState()).transmitting).toBe(false);
  });

  it('never finds a peer in solo', async () => {
    const {radio, clock} = harness('solo');

    await radio.start();
    clock.advance(60_000);

    const state = await radio.getState();
    expect(state.status).toBe('ready');
    expect(state.nearbyCount).toBe(0);
  });

  it('stops from any point to off, with peers cleared, and restarts', async () => {
    const {radio, clock} = harness('happy');

    await radio.start();
    clock.advance(8000);
    expect((await radio.getState()).receiving).toBe(true);

    await radio.stop();
    const stopped = await radio.getState();
    expect(stopped.status).toBe('off');
    expect(stopped.nearbyCount).toBe(0);
    expect(stopped.receiving).toBe(false);
    expect(stopped.transmitting).toBe(false);

    clock.advance(60_000);
    expect((await radio.getState()).status).toBe('off');

    await radio.start();
    expect((await radio.getState()).status).toBe('starting');
    clock.advance(2000);
    expect((await radio.getState()).nearbyCount).toBe(1);
  });

  it('completes the pairing flow on pairing-success', async () => {
    const {radio, clock} = harness('pairing-success');
    await radio.start();
    clock.advance(2000);

    const configured = radio.configurePtt();

    expect((await radio.getState()).pttPairing).toEqual({
      phase: 'scanning',
      candidates: [],
    });

    clock.advance(900);
    const scanning = await radio.getState();
    expect(scanning.pttPairing?.phase).toBe('scanning');
    expect(scanning.pttPairing?.candidates).toHaveLength(2);

    await radio.selectPttCandidate('mock-ptt-01');
    expect((await radio.getState()).pttPairing?.phase).toBe('learning');

    clock.advance(1200);
    const result = await configured;

    expect(result.name).toBe('ORU-PTT-01');
    expect(result.binding.type).toBe('ble');

    const saved = await radio.getState();
    expect(saved.pttPairing?.phase).toBe('saved');
    expect(saved.pttButton).toEqual({
      configured: true,
      connected: true,
      name: 'ORU-PTT-01',
    });
  });

  it('fails the pairing flow on pairing-empty and emits an error', async () => {
    const {radio, clock, errors} = harness('pairing-empty');
    await radio.start();
    clock.advance(2000);

    const configured = radio.configurePtt();
    const rejection = configured.then(
      () => 'resolved',
      (error: Error) => error.message,
    );

    clock.advance(900);
    expect((await radio.getState()).pttPairing?.candidates).toEqual([]);

    clock.advance(1500);

    await expect(rejection).resolves.toContain('No push-to-talk buttons');
    expect(errors.map(error => error.code)).toContain('PTT_SCAN_EMPTY');
    expect((await radio.getState()).pttPairing).toBeUndefined();
  });

  it('flips a configured button to disconnected and back, without an error', async () => {
    const {radio, clock, errors} = harness('button-lost');
    await radio.start();

    clock.advance(1200);
    expect((await radio.getState()).pttButton).toEqual({
      configured: true,
      connected: true,
      name: 'ORU-PTT-01',
    });

    clock.advance(2800);
    expect((await radio.getState()).pttButton.connected).toBe(false);

    clock.advance(5000);
    expect((await radio.getState()).pttButton.connected).toBe(true);

    expect(errors).toEqual([]);
  });

  it('raises an engine error and recovers on restart', async () => {
    const {radio, clock, errors} = harness('engine-error');
    await radio.start();

    clock.advance(3000);
    expect((await radio.getState()).status).toBe('error');
    expect(errors).toEqual([
      {
        code: 'NEARBY_UNAVAILABLE',
        message: 'Nearby Connections is unavailable on this device',
      },
    ]);

    await radio.start();
    expect((await radio.getState()).status).toBe('starting');

    clock.advance(800);
    expect((await radio.getState()).status).toBe('ready');
  });

  it('keeps a saved binding across a power cycle, and forgets it on request', async () => {
    const {radio, clock} = harness('pairing-success');
    await radio.start();
    clock.advance(2000);

    const configured = radio.configurePtt();
    clock.advance(900);
    await radio.selectPttCandidate('mock-ptt-01');
    clock.advance(1200);
    await configured;

    await radio.stop();
    const stopped = await radio.getState();
    expect(stopped.pttButton.configured).toBe(true);
    expect(stopped.pttButton.connected).toBe(false);

    await radio.start();
    expect((await radio.getState()).pttButton.configured).toBe(true);

    await radio.forgetPtt();
    expect((await radio.getState()).pttButton).toEqual({
      configured: false,
      connected: false,
    });
  });

  it('hands out copies, so a caller cannot mutate the engine', async () => {
    const {radio} = harness('happy');

    const first = await radio.getState();
    first.nearbyCount = 99;

    expect((await radio.getState()).nearbyCount).toBe(0);
  });

  it('does not let an orphaned pairing timer corrupt a superseding session', async () => {
    const {radio, clock} = harness('pairing-success');
    await radio.start();
    clock.advance(2000);

    const firstConfigured = radio.configurePtt();
    let firstRejection: string | undefined;
    firstConfigured.then(
      () => {
        firstRejection = 'resolved';
      },
      (error: Error) => {
        firstRejection = error.message;
      },
    );

    // Advance past scanMs, so the first session's scan callback has already
    // fired and published its two candidates.
    clock.advance(900);
    expect((await radio.getState()).pttPairing?.candidates).toHaveLength(2);

    // Move the first session on to `learning`. This schedules its own
    // learnMs timer — the one this regression guards against surviving past
    // a superseding session.
    await radio.selectPttCandidate('mock-ptt-01');
    expect((await radio.getState()).pttPairing?.phase).toBe('learning');

    // Open a second session before the first session's learnMs timer fires.
    const secondConfigured = radio.configurePtt();
    let secondSettled = false;
    secondConfigured.then(
      () => {
        secondSettled = true;
      },
      () => {
        secondSettled = true;
      },
    );

    expect((await radio.getState()).pttPairing).toEqual({
      phase: 'scanning',
      candidates: [],
    });

    // Advance past both the second session's scanMs (900ms out) and the
    // first session's orphaned learnMs (1200ms out from its own
    // selectPttCandidate call). The orphaned timer must not fire against the
    // second session: it must neither move it backwards to `learning`/`saved`
    // nor settle its promise.
    clock.advance(1200);

    const state = await radio.getState();
    expect(state.pttPairing?.phase).toBe('scanning');
    expect(state.pttPairing?.candidates).toHaveLength(2);
    expect(state.pttButton.configured).toBe(false);

    expect(firstRejection).toContain('new session started');
    expect(secondSettled).toBe(false);
  });

  it('stops notifying a removed listener', async () => {
    const {radio, clock} = harness('happy');
    const seen: string[] = [];
    const subscription = radio.onStateChanged(state => {
      seen.push(state.status);
    });

    await radio.start();
    subscription.remove();
    clock.advance(800);

    expect(seen).toEqual(['starting']);
  });
});
