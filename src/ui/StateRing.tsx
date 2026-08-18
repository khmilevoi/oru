import React from 'react';
import {StyleSheet, View} from 'react-native';

import {colors, glows, sizes, spacing} from './theme';

/**
 * The canvas's central `.ring` (`design/01 Radio.dc.html`, and `.learnring` in
 * `design/03 Pairing.dc.html`) -- one circle whose border, fill and glow carry
 * the state, with the state's own copy centred inside it.
 *
 * The glows are RN `boxShadow` strings, supported natively from React Native
 * 0.76 on the New Architecture; `design/theme.css` states them in CSS and they
 * transfer literally.
 */
export type StateRingTone = 'idle' | 'tx' | 'rx' | 'learning';

export function StateRing({
  tone,
  children,
}: {
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
}) {
  const size = tone === 'learning' ? sizes.ringLearning : sizes.ring;

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
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  ring: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.gutter,
    paddingHorizontal: spacing.lg,
  },
  idle: {borderWidth: 2, borderColor: colors.hairlineRaised},
  tx: {
    borderWidth: 2,
    borderColor: colors.txBorder,
    backgroundColor: colors.tx,
    boxShadow: glows.tx,
  },
  rx: {borderWidth: 3, borderColor: colors.rx, boxShadow: glows.rx},
  learning: {borderWidth: 2, borderColor: colors.learning},
});
