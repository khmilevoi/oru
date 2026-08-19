import React, {useEffect, useRef} from 'react';
import {Animated, StyleSheet} from 'react-native';
import {reatomComponent} from '@reatom/react';

import {motion} from './theme';
import {reducedMotion} from './reducedMotion';

/** The subtle scanning cue of spec section 12's `searching` state. */
export const PulseDot = reatomComponent<{
  active: boolean;
  color: string;
  size?: number;
  /**
   * A word this dot REPLACED, where one was deleted and nothing else on the
   * screen carries it -- the pairing list's "still scanning" row, whose whole
   * content is now this dot on the "Found" label. Given one, the dot becomes
   * that announcement; given none it stays decorative, which is what it is
   * everywhere a visible label already sits beside it.
   */
  accessibilityLabel?: string;
}>(({active, color, size = 10, accessibilityLabel}) => {
  const still = reducedMotion();
  const opacity = useRef(new Animated.Value(still ? 0.6 : 0.25)).current;

  useEffect(() => {
    if (!active || still) {
      opacity.setValue(still ? 0.6 : 1);
      return;
    }

    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, {
          toValue: 1,
          duration: motion.pulseMs / 2,
          useNativeDriver: true,
        }),
        Animated.timing(opacity, {
          toValue: 0.25,
          duration: motion.pulseMs / 2,
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();

    return () => loop.stop();
  }, [active, still, opacity]);

  return (
    <Animated.View
      testID="pulse-dot"
      accessibilityRole={accessibilityLabel === undefined ? undefined : 'image'}
      accessibilityLabel={accessibilityLabel}
      accessibilityElementsHidden={
        accessibilityLabel === undefined ? true : undefined
      }
      importantForAccessibility={
        accessibilityLabel === undefined ? 'no-hide-descendants' : undefined
      }
      style={[
        styles.dot,
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: color,
          opacity,
        },
      ]}
    />
  );
}, 'PulseDot');

const styles = StyleSheet.create({
  dot: {},
});
