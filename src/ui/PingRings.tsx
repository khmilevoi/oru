import React, {useEffect, useRef} from 'react';
import {Animated, StyleSheet, View} from 'react-native';
import {reatomComponent} from '@reatom/react';

import {colors, motion, sizes} from './theme';
import {reducedMotion} from './reducedMotion';

/**
 * The canvas's `.pingset` -- three rings travelling outward from a static
 * centre dot, used by the radio screen's `searching` state and by the pairing
 * scan (`design/03 Pairing.dc.html` uses the `.sm` variant).
 *
 * `@keyframes ping` runs scale 0.25 -> 1 while opacity falls 0.85 -> 0, on a
 * 3s cycle with the three rings 1s apart. Under reduced motion the canvas
 * falls back to the three static scales its stylesheet declares -- 0.35, 0.65
 * and 0.95 at opacity 0.3 -- rather than freezing all three on top of one
 * another.
 */
const STATIC_SCALES = [0.35, 0.65, 0.95] as const;
const STATIC_OPACITY = 0.3;

export const PingRings = reatomComponent<{
  size?: 'default' | 'small';
  testID?: string;
}>(({size = 'default', testID}) => {
  const still = reducedMotion();
  const box = size === 'small' ? sizes.pingSetSmall : sizes.pingSet;
  const progress = useRef(
    STATIC_SCALES.map(() => new Animated.Value(0)),
  ).current;

  useEffect(() => {
    if (still) return;

    // The stagger sits OUTSIDE the loop, and has to: `Animated.loop` defaults
    // to `resetBeforeIteration: true`, so a delay *inside* it would be replayed
    // on every lap -- giving ring `i` a period of 3s + i*1s and freezing it at
    // its start scale in between, rather than the canvas's one-time phase
    // offset between three rings that then travel at a single shared period.
    const runs = progress.map((value, index) =>
      Animated.sequence([
        Animated.delay(index * motion.pingStaggerMs),
        Animated.loop(
          Animated.timing(value, {
            toValue: 1,
            duration: motion.pingMs,
            useNativeDriver: true,
          }),
        ),
      ]),
    );
    runs.forEach(run => run.start());

    // `Animated.sequence`'s own `stop()` stops whichever leg is currently
    // running -- the delay if the ring has not entered its loop yet, the loop
    // once it has -- so unmounting mid-stagger cancels cleanly either way.
    return () => runs.forEach(run => run.stop());
  }, [still, progress]);

  return (
    // Fixed literal testID, not the caller's `testID` prop: `jest/renderScreen.tsx`'s
    // `find` dedups matches down to the outermost node sharing a testID value, and
    // this component's own composite fiber already carries whatever `testID` the
    // caller passed -- so forwarding that same value onto this View would make it
    // the *inner*, and therefore discarded, match, leaving `find(callerTestID)`
    // return the composite fiber (whose props never include the `style` array this
    // View computes). `src/ui/StateRing.tsx` and `src/ui/PowerKey.tsx` solve the
    // identical problem the same way, with `state-ring` / `power-key-ring`.
    <View testID="ping-set" style={[styles.set, {width: box, height: box}]}>
      {STATIC_SCALES.map((staticScale, index) => (
        <Animated.View
          key={staticScale}
          testID={testID === undefined ? undefined : `${testID}-ring`}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={[
            styles.ring,
            {borderRadius: box / 2},
            still
              ? {opacity: STATIC_OPACITY, transform: [{scale: staticScale}]}
              : {
                  opacity: progress[index].interpolate({
                    inputRange: [0, 0.7, 1],
                    outputRange: [0.85, 0.25, 0],
                  }),
                  transform: [
                    {
                      scale: progress[index].interpolate({
                        inputRange: [0, 1],
                        outputRange: [0.25, 1],
                      }),
                    },
                  ],
                },
          ]}
        />
      ))}
      <View
        testID={testID === undefined ? undefined : `${testID}-dot`}
        style={styles.dot}
      />
    </View>
  );
}, 'PingRings');

const styles = StyleSheet.create({
  set: {alignItems: 'center', justifyContent: 'center'},
  ring: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    borderWidth: 1,
    borderColor: colors.textFaint,
  },
  dot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: colors.text,
  },
});
