import {context} from '@reatom/core';
import {i18n} from '@lingui/core';

import {bootstrapApp, toAppLifecycle} from '../src/app/appEntry';
import {initialRadioState} from '../src/radio/radio.types';
import {mockRadio} from '../src/radio/radio.native.mock';
import {radio} from '../src/radio/radio.model';
import {MOCK_SCENARIOS, setMockScenario} from '../src/mock/mock.scenario';

jest.useFakeTimers({doNotFake: ['queueMicrotask']});

type Listener = (state: string) => void;

function fakeAppState() {
  const listeners: Listener[] = [];
  return {
    host: {
      addEventListener(_type: 'change', handler: Listener) {
        listeners.push(handler);
        return {
          remove() {
            listeners.splice(listeners.indexOf(handler), 1);
          },
        };
      },
    },
    listeners,
  };
}

beforeEach(() => {
  context.reset();
  setMockScenario('happy');
  mockRadio.reset({scenario: 'happy'});
});

/**
 * `radio.sync()` is `getState()` behind two `async` wrappers and a Reatom
 * `wrap`, so the mirror lands several microtask ticks after the call that asked
 * for it. Draining a fixed, generous number of ticks is deterministic; one
 * `await Promise.resolve()` is only accidentally enough.
 */
const flushMicrotasks = async () => {
  for (let tick = 0; tick < 10; tick += 1) await Promise.resolve();
};

describe('app entry — spec sections 6.2 and 12.2', () => {
  it('activates the system locale with an English fallback', () => {
    const russian = bootstrapApp({systemLocale: 'ru-RU', appState: fakeAppState().host});
    expect(russian.locale).toBe('ru');
    expect(i18n.locale).toBe('ru');
    russian.teardown();

    const other = bootstrapApp({systemLocale: 'de-DE', appState: fakeAppState().host});
    expect(other.locale).toBe('en');
    expect(i18n.locale).toBe('en');
    other.teardown();
  });

  it('takes the section 6.2 boot snapshot instead of starting the radio', async () => {
    // Nothing subscribes the engine's event stream until `bootstrapApp` runs,
    // so driving the engine directly here moves it entirely behind the
    // mirror's back -- which is the situation section 6.2's boot snapshot
    // exists for (the native radio kept running while the UI was dead).
    await mockRadio.start();
    jest.advanceTimersByTime(5000);
    const engineBefore = await mockRadio.getState();

    expect(engineBefore.status).toBe('ready');
    expect(engineBefore.nearbyCount).toBe(2);
    expect(radio().status).toBe('off'); // the mirror has heard nothing

    const {teardown} = bootstrapApp({appState: fakeAppState().host});
    await flushMicrotasks();

    // Section 6.2: "on UI start ... getState() -> Reatom sync". Delete the
    // `radio.sync()` from `bootstrapApp` and this is where it fails.
    expect(radio().status).toBe('ready');
    expect(radio().nearbyCount).toBe(2);

    // And it was a *snapshot*, not a start(): `start()` cancels the timeline
    // and drops the engine back to `starting` with no peers, so an engine that
    // still reads exactly as it did is the proof app entry only looked. Section
    // 12's `off` state and section 5's power key depend on that.
    await expect(mockRadio.getState()).resolves.toEqual(engineBefore);
    teardown();
  });

  it('feeds engine events into the mirror', async () => {
    const {teardown} = bootstrapApp({appState: fakeAppState().host});

    await radio.start();
    jest.advanceTimersByTime(5000);
    await Promise.resolve();

    // `start()` only syncs once; `nearbyCount` rising is delivered by the
    // stateChanged stream, which only app entry subscribes.
    expect(radio().nearbyCount).toBeGreaterThan(0);
    teardown();
  });

  it('stops feeding the mirror after teardown', async () => {
    const {teardown} = bootstrapApp({appState: fakeAppState().host});
    await radio.start();
    teardown();

    const before = radio().nearbyCount;
    jest.advanceTimersByTime(10000);
    await Promise.resolve();
    expect(radio().nearbyCount).toBe(before);
  });

  it('re-syncs the mirror when the app returns to the foreground', async () => {
    const appState = fakeAppState();
    const {teardown} = bootstrapApp({appState: appState.host});
    await flushMicrotasks();

    await radio.start();
    jest.advanceTimersByTime(5000);
    const engine = await mockRadio.getState();
    expect(engine.nearbyCount).toBe(2);

    // Every mutation the mock engine has publishes a `stateChanged`, and app
    // entry is subscribed by now, so the engine cannot be moved silently. The
    // mirror is put out of date instead -- which is the same situation from
    // section 6.2's point of view (mirror stale, engine truthful) and is what
    // the resume re-sync exists to repair. Nothing emits between here and the
    // transition, so only the transition can fix it.
    radio.set(initialRadioState);
    expect(radio().status).toBe('off');

    // Going *to* background must not re-sync: section 6.2 puts the re-sync on
    // the transition into `active`, and only when the app was not already.
    appState.listeners[0]('background');
    await flushMicrotasks();
    expect(radio().status).toBe('off');

    appState.listeners[0]('active');
    await flushMicrotasks();

    expect(radio()).toEqual(engine);
    expect(radio().nearbyCount).toBe(2);
    teardown();
    expect(appState.listeners).toHaveLength(0);
  });

  it('registers one dev-menu entry per mock scenario', () => {
    // `registerMockScenarioDevMenu` guards on a module-level `registered` flag
    // that no `context.reset()` clears, and this is not the first `bootstrapApp`
    // in the file -- so against the shared registry `entries` is empty by
    // construction and any assertion on it is vacuous. A fresh module registry
    // makes it the *first* registration, which is the only state in which the
    // section 6.5 contract is observable at all.
    const entries: string[] = [];
    jest.isolateModules(() => {
      const freshEntry =
        require('../src/app/appEntry') as typeof import('../src/app/appEntry');
      const {MOCK_SCENARIOS: scenarios} =
        require('../src/mock/mock.scenario') as typeof import('../src/mock/mock.scenario');

      const {teardown} = freshEntry.bootstrapApp({
        appState: fakeAppState().host,
        devMenu: {addMenuItem: title => entries.push(title)},
      });

      expect(entries).toEqual(
        scenarios.map(scenario => `Radio scenario: ${scenario}`),
      );
      expect(entries).toHaveLength(MOCK_SCENARIOS.length);
      teardown();
    });
  });

  it('maps every AppState string onto the three lifecycle values', () => {
    expect(toAppLifecycle('active')).toBe('active');
    expect(toAppLifecycle('background')).toBe('background');
    expect(toAppLifecycle('inactive')).toBe('inactive');
    expect(toAppLifecycle('unknown')).toBe('inactive');
    expect(toAppLifecycle('extension')).toBe('inactive');
  });
});
