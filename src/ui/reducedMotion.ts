import {AccessibilityInfo} from 'react-native';
import {atom, bind, withConnectHook} from '@reatom/core';

/**
 * Spec section 12.1: "animations respect `prefers-reduced-motion`". React
 * Native surfaces the platform setting as `AccessibilityInfo`'s reduce-motion
 * flag.
 *
 * The subscription hangs off `withConnectHook`, so its lifetime is the atom's
 * connection and it is torn down with the last subscriber -- a bare
 * module-level listener would never stop.
 *
 * `AccessibilityInfo.isReduceMotionEnabled()` is a one-shot read kicked off
 * when the atom *connects* -- but the render harness (and any test) sets the
 * atom directly *before* that first connection, while composing the screen
 * it is about to render. If the one-shot answer always won, it would race
 * that explicit value and silently overwrite it once the promise settles,
 * even though nothing on the platform actually changed. So the one-shot
 * answer only ever fills in a value nothing has set yet; a genuine
 * `reduceMotionChanged` event -- which only fires on an actual change --
 * always wins, and also re-arms the guard for the connection's next initial
 * read.
 *
 * `target.set` is wrapped once here, at module scope, rather than inside the
 * connect hook below: an explicit `.set()` made before the atom ever
 * connects has to be visible by the time the one-shot promise resolves, and
 * a flag raised only from inside the connect hook would already be too late
 * to see that earlier call. `rawSet` is the trapdoor this file's own
 * one-shot/`reduceMotionChanged` writes use so they never mark themselves as
 * the "explicit" caller they are guarding against.
 */
const target = atom(false, 'reducedMotion');
/**
 * `@reatom/core@1001.3.0`-specific: `.set` is not in `AtomMut`'s public type,
 * but exists at runtime as an own property of every atom instance (not a
 * shared prototype method), and `target.extend(...)` below returns the very
 * same object rather than a copy -- both of which this cast relies on to let
 * `rawSet`/the wrapped `.set` reach the atom this module actually exports. A
 * version upgrade that changes either fact needs this re-verified; if it
 * silently breaks, the failure is loud and local -- the reduced-motion tests
 * in `__tests__/ui-primitives.test.tsx` go red -- never a corrupted app.
 */
const mutableTarget = target as unknown as {set: (value: boolean) => boolean};

const rawSet = mutableTarget.set.bind(target);
let hasExplicitValue = false;
mutableTarget.set = value => {
  hasExplicitValue = true;
  return rawSet(value);
};

export const reducedMotion = target.extend(
  withConnectHook(() => {
    let live = true;

    void AccessibilityInfo.isReduceMotionEnabled().then(
      bind(enabled => {
        if (live && !hasExplicitValue) rawSet(enabled);
        hasExplicitValue = false;
      }),
    );

    const subscription = AccessibilityInfo.addEventListener(
      'reduceMotionChanged',
      bind(enabled => {
        hasExplicitValue = false;
        rawSet(enabled);
      }),
    );

    return () => {
      live = false;
      subscription.remove();
    };
  }),
);
