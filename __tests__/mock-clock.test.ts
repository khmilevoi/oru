import {createManualClock} from '../src/mock/mock.clock';
import {
  DEFAULT_MOCK_SCENARIO,
  MOCK_SCENARIOS,
  getMockScenario,
  onMockScenarioChange,
  setMockScenario,
} from '../src/mock/mock.scenario';

describe('manual clock', () => {
  it('runs nothing until it is advanced', () => {
    const clock = createManualClock();
    const calls: string[] = [];

    clock.schedule(100, () => calls.push('a'));

    expect(calls).toEqual([]);
    expect(clock.pending()).toBe(1);
  });

  it('runs due callbacks in due order, then insertion order', () => {
    const clock = createManualClock();
    const calls: string[] = [];

    clock.schedule(200, () => calls.push('late'));
    clock.schedule(100, () => calls.push('early-1'));
    clock.schedule(100, () => calls.push('early-2'));

    clock.advance(200);

    expect(calls).toEqual(['early-1', 'early-2', 'late']);
    expect(clock.now()).toBe(200);
  });

  it('runs callbacks scheduled during an advance that fall inside the window', () => {
    const clock = createManualClock();
    const calls: number[] = [];

    clock.schedule(10, () => {
      calls.push(clock.now());
      clock.schedule(10, () => calls.push(clock.now()));
    });

    clock.advance(25);

    expect(calls).toEqual([10, 20]);
    expect(clock.now()).toBe(25);
  });

  it('does not run a cancelled callback', () => {
    const clock = createManualClock();
    const calls: string[] = [];

    const cancel = clock.schedule(50, () => calls.push('gone'));
    cancel();
    clock.advance(1000);

    expect(calls).toEqual([]);
    expect(clock.pending()).toBe(0);
  });

  it('is identical across two runs — no randomness anywhere', () => {
    const run = () => {
      const clock = createManualClock();
      const trace: number[] = [];
      [30, 10, 20].forEach(delay =>
        clock.schedule(delay, () => trace.push(clock.now())),
      );
      clock.advance(100);
      return trace;
    };

    expect(run()).toEqual(run());
  });
});

describe('scenario registry', () => {
  afterEach(() => setMockScenario(DEFAULT_MOCK_SCENARIO));

  it('names exactly the seven scenarios of spec section 6.5', () => {
    expect([...MOCK_SCENARIOS]).toEqual([
      'happy',
      'solo',
      'pairing-success',
      'pairing-empty',
      'button-lost',
      'engine-error',
      'onboarding',
    ]);
  });

  it('starts on the default scenario', () => {
    expect(getMockScenario()).toBe('happy');
  });

  it('notifies listeners until they unsubscribe', () => {
    const seen: string[] = [];
    const off = onMockScenarioChange(name => seen.push(name));

    setMockScenario('solo');
    expect(getMockScenario()).toBe('solo');

    off();
    setMockScenario('engine-error');

    expect(seen).toEqual(['solo']);
    expect(getMockScenario()).toBe('engine-error');
  });
});
