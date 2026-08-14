import {action, atom, wrap} from '@reatom/core';

import {radio} from '../radio/radio.model';

/**
 * The three states React Native's `AppState` reports. P7 subscribes to
 * `AppState` and feeds `applyAppLifecycle`; this module deliberately does not
 * import React Native, so the rule below is testable on its own.
 */
export type AppLifecycle = 'active' | 'background' | 'inactive';

export const appLifecycle = atom<AppLifecycle>('active', 'appLifecycle');

/**
 * Spec section 6.2: "If the UI was suspended, the native radio kept working;
 * resume only re-syncs." A re-sync therefore happens on the transition *into*
 * `active`, and never while the app was already there.
 *
 * Returns the fresh snapshot, the failure that stopped it, or `null` when no
 * re-sync was due.
 */
export const applyAppLifecycle = action(async (next: AppLifecycle) => {
  const previous = appLifecycle();
  appLifecycle.set(next);

  if (next !== 'active' || previous === 'active') return null;

  return await wrap(radio.sync());
}, 'applyAppLifecycle');
