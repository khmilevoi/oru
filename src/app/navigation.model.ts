import {action, atom} from '@reatom/core';

/**
 * The app has five destinations and no navigation library (P1 installed the
 * spec's dependencies and nothing else), so the "navigator" is one atom and a
 * switch in `AppRoot`. That is enough for spec section 12: the screens are a
 * main screen, a settings screen and two flows, none of them stacked more than
 * one level deep.
 *
 * `null` is the state before the first-launch gate has answered. `AppRoot`
 * renders nothing then, so the user never sees the main screen flash by on the
 * way to onboarding.
 */
export type Route = 'onboarding' | 'background' | 'radio' | 'settings' | 'pairing';

export const route = atom<Route | null>(null, 'route');

export const navigate = action((next: Route) => {
  route.set(next);
}, 'navigate');

/**
 * Android's hardware back button. Returns `true` when it moved somewhere, which
 * is what `BackHandler` reads as "handled"; `false` lets Android close the app,
 * which is the right behaviour on the main screen and inside the first-launch
 * sequence -- backing out of onboarding into a radio the user has not granted
 * anything to would be worse than leaving.
 */
export const goBack = action((): boolean => {
  const current = route();

  if (current === 'settings') {
    route.set('radio');
    return true;
  }

  if (current === 'pairing') {
    route.set('settings');
    return true;
  }

  return false;
}, 'goBack');
