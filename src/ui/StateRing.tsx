import React, {useEffect, useRef} from 'react';
import {Animated, StyleSheet, View} from 'react-native';
import {reatomComponent} from '@reatom/react';

import {colors, glows, motion, sizes, spacing} from './theme';
import {reducedMotion} from './reducedMotion';

/**
 * The canvas's central `.ring` (`design/01 Radio.dc.html`, and `.learnring` in
 * `design/03 Pairing.dc.html`) -- one circle whose border, fill and glow carry
 * the state, with the state's own copy centred inside it.
 *
 * It is GEOMETRICALLY INVARIANT: same diameter, same border box, same centre in
 * every state, with only colour, fill and glow changing -- the canvas's GEOMETRY
 * note states the rule and `__tests__/radio-ring-geometry.test.tsx` enforces it.
 * Its caller owes the other half: the ring is centred in a column, so a sibling
 * that appears in one state alone moves the ring just as surely as resizing it
 * would (`src/screens/RadioScreen.tsx`'s reserved hint slot).
 *
 * The glows are RN `boxShadow` strings, supported natively from React Native
 * 0.76 on the New Architecture; `design/theme.css` states them in CSS and they
 * transfer literally.
 *
 * `.learnring` alone carries the canvas `pulse` class: a 1.6s amber halo
 * spreading 26px and back (`@keyframes pulse`). A `boxShadow` string cannot be
 * driven by `Animated`, so the halo is its own ring-shaped view scaling out
 * while it fades -- the same loop `PulseDot` runs, on the same
 * `motion.pulseMs`. The canvas declares `pulse` motion-safe only, so reduced
 * motion drops it entirely.
 */
export type StateRingTone = 'idle' | 'tx' | 'rx' | 'learning';

export const StateRing = reatomComponent<{
  tone: StateRingTone;
  children: React.ReactNode;
  /**
   * Accepted so callers (and their own tests) can address a particular
   * `StateRing` instance in a screen with more than one -- the value itself
   * is never read here. The ring's actual style-bearing node carries its own
   * fixed `state-ring` testID instead: `jest/renderScreen.tsx`'s `find` dedups
   * `testID` matches down to the outermost node sharing a value, and a
   * function component's own fiber "carries" every prop it received
   * (including `testID`) whether or not the body uses it -- so forwarding the
   * caller's `testID` onto this View as well would make it the *inner*, and
   * therefore discarded, match. `src/ui/PowerKey.tsx` solves the identical
   * problem the same way, with `testID="power-key-ring"`.
   */
  testID?: string;
}>(({tone, children}) => {
  const still = reducedMotion();
  const size = tone === 'learning' ? sizes.ringLearning : sizes.ring;
  const pulsing = tone === 'learning' && !still;
  const phase = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!pulsing) {
      phase.setValue(0);
      return;
    }

    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(phase, {
          toValue: 1,
          duration: motion.pulseMs / 2,
          useNativeDriver: true,
        }),
        Animated.timing(phase, {
          toValue: 0,
          duration: motion.pulseMs / 2,
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();

    return () => loop.stop();
  }, [pulsing, phase]);

  return (
    <View
      testID="state-ring"
      style={[
        styles.ring,
        {width: size, height: size, borderRadius: size / 2},
        tone === 'idle' && styles.idle,
        tone === 'tx' && styles.tx,
        tone === 'rx' && styles.rx,
        tone === 'learning' && styles.learning,
      ]}>
      {tone === 'rx' ? (
        <View
          testID="state-ring-edge"
          pointerEvents="none"
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={[styles.edge, {borderRadius: size / 2}]}
        />
      ) : null}
      {pulsing ? (
        <Animated.View
          testID="state-ring-pulse"
          pointerEvents="none"
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={[
            styles.halo,
            {
              borderRadius: size / 2,
              opacity: phase.interpolate({
                inputRange: [0, 1],
                outputRange: [0.25, 0],
              }),
              transform: [
                {
                  scale: phase.interpolate({
                    inputRange: [0, 1],
                    outputRange: [1, (size + motion.pulseSpread * 2) / size],
                  }),
                },
              ],
            },
          ]}
        />
      ) : null}
      {children}
    </View>
  );
}, 'StateRing');

const styles = StyleSheet.create({
  /**
   * `borderWidth` lives HERE and not on any tone, deliberately. The ring is
   * geometrically invariant: same diameter, same border box, same centre in
   * every state, with only colour, fill and glow changing. A per-tone border
   * width breaks that twice over -- it shrinks the content box, so the label
   * and the bars inside step in by the difference on every edge, and on any
   * platform sizing a circle by its content it would change the diameter too.
   * Tones below therefore set colour, fill and shadow and nothing else.
   */
  ring: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.gutter,
    paddingHorizontal: spacing.lg,
    borderWidth: sizes.ringBorder,
  },
  idle: {borderColor: colors.hairlineRaised},
  tx: {
    borderColor: colors.txBorder,
    backgroundColor: colors.tx,
    boxShadow: glows.tx,
  },
  rx: {borderColor: colors.rx, boxShadow: glows.rx},
  learning: {borderColor: colors.learning},
  /**
   * The canvas draws receiving one point heavier than every other state. That
   * weight is real design intent and is kept -- but as paint, not as layout: an
   * absolutely positioned ring pulled back out to the border box by
   * `-sizes.ringBorder` on each side, so it covers the 2pt border with a 3pt one
   * drawn inward from the same outer edge. Same trick as `halo` below, and like
   * `halo` it costs the column nothing. `design/01 Radio.dc.html`'s `.ringrx`
   * reaches the identical result with `inset 0 0 0 1px` and no border-width of
   * its own; the two were reconciled together.
   */
  edge: {
    position: 'absolute',
    top: -sizes.ringBorder,
    right: -sizes.ringBorder,
    bottom: -sizes.ringBorder,
    left: -sizes.ringBorder,
    borderWidth: sizes.ringEdgeRx,
    borderColor: colors.rx,
  },
  halo: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    borderWidth: 2,
    borderColor: colors.learningHalo,
  },
});
