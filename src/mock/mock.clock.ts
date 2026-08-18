/**
 * Spec section 6.5: "All timing goes through an injectable clock, so tests
 * advance it instead of waiting and two runs are identical."
 *
 * Two implementations, both used:
 * - `createRealClock` backs the `mockRadio` singleton a dev build and a screen
 *   test share. Under Jest, `jest.useFakeTimers()` takes over the same global
 *   `setTimeout`, so a screen test drives the mock's timeline and a component's
 *   own timers through one mechanism.
 * - `createManualClock` backs the mock engine's own unit tests, where no React
 *   tree exists and Jest's timer semantics would only be noise.
 */

export type MockClock = {
  now(): number;
  /** Returns the cancel function for the scheduled callback. */
  schedule(delayMs: number, callback: () => void): () => void;
};

export type ManualClock = MockClock & {
  advance(ms: number): void;
  pending(): number;
};

export function createRealClock(): MockClock {
  return {
    now: () => Date.now(),
    schedule(delayMs, callback) {
      const handle = setTimeout(callback, delayMs);
      return () => clearTimeout(handle);
    },
  };
}

type ManualTask = {due: number; seq: number; callback: () => void};

export function createManualClock(): ManualClock {
  let current = 0;
  let serial = 0;
  let tasks: ManualTask[] = [];

  /**
   * Due time first, insertion order second. Two callbacks scheduled for the
   * same instant must run in the order they were scheduled, or the mock's
   * scripts would not be reproducible.
   */
  const nextDue = (limit: number): ManualTask | undefined =>
    tasks
      .filter(task => task.due <= limit)
      .sort((left, right) => left.due - right.due || left.seq - right.seq)[0];

  return {
    now: () => current,

    schedule(delayMs, callback) {
      const task: ManualTask = {
        due: current + delayMs,
        seq: serial++,
        callback,
      };
      tasks.push(task);

      return () => {
        tasks = tasks.filter(candidate => candidate !== task);
      };
    },

    /**
     * A callback scheduled *during* an advance and due inside the same window
     * runs in that window — the loop re-reads the queue every iteration, so a
     * scripted chain plays out in one call.
     */
    advance(ms) {
      const target = current + ms;

      for (;;) {
        const task = nextDue(target);
        if (!task) break;

        tasks = tasks.filter(candidate => candidate !== task);
        current = task.due;
        task.callback();
      }

      current = target;
    },

    pending: () => tasks.length,
  };
}
