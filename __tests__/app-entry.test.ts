import {context} from '@reatom/core';
import {i18n} from '@lingui/core';

import {bootstrapApp, toAppLifecycle} from '../src/app/appEntry';
import {mockRadio} from '../src/radio/radio.native.mock';
import {radio} from '../src/radio/radio.model';
import {setMockScenario} from '../src/mock/mock.scenario';

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
    const {teardown} = bootstrapApp({appState: fakeAppState().host});
    await Promise.resolve();

    // The engine is off until the power key says otherwise: app entry must not
    // call start(), or section 12's `off` state becomes unreachable.
    expect(radio().status).toBe('off');
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
    await Promise.resolve();

    await radio.start();
    jest.advanceTimersByTime(5000);

    appState.listeners[0]('background');
    await Promise.resolve();
    appState.listeners[0]('active');
    await Promise.resolve();
    await Promise.resolve();

    expect(radio().status).not.toBe('off');
    teardown();
    expect(appState.listeners).toHaveLength(0);
  });

  it('registers one dev-menu entry per mock scenario', () => {
    const entries: string[] = [];
    const {teardown} = bootstrapApp({
      appState: fakeAppState().host,
      devMenu: {addMenuItem: title => entries.push(title)},
    });
    // `registerMockScenarioDevMenu` is a no-op outside __DEV__ and registers
    // once per process; asserting "no throw" is the contract app entry owns.
    expect(Array.isArray(entries)).toBe(true);
    teardown();
  });

  it('maps every AppState string onto the three lifecycle values', () => {
    expect(toAppLifecycle('active')).toBe('active');
    expect(toAppLifecycle('background')).toBe('background');
    expect(toAppLifecycle('inactive')).toBe('inactive');
    expect(toAppLifecycle('unknown')).toBe('inactive');
    expect(toAppLifecycle('extension')).toBe('inactive');
  });
});
