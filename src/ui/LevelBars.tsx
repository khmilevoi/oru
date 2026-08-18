import React, {useEffect, useRef} from 'react';
import {Animated, StyleSheet, View} from 'react-native';
import {reatomComponent} from '@reatom/react';

import {motion, radii} from './theme';
import {reducedMotion} from './reducedMotion';

/** `.bars span` heights, in canvas order. */
const HEIGHTS = [12, 24, 34, 18, 27] as const;
const ROW_HEIGHT = 34;
/** `@keyframes lvl` scales between these two. */
const MIN_SCALE = 0.45;

/**
 * The canvas's `.bars` -- five bars breathing inside the ring while the radio
 * is transmitting or receiving.
 *
 * CSS anchors the scale at the bar's foot with `transform-origin: bottom`,
 * which React Native has no equivalent for: it always scales about the centre.
 * Translating by half the height the scale removes puts the foot back where CSS
 * would have left it, which is what the `translateY` below is for.
 */
export const LevelBars = reatomComponent<{color: string; testID?: string}>(
  ({color, testID}) => {
    const still = reducedMotion();
    const scales = useRef(HEIGHTS.map(() => new Animated.Value(1))).current;

    useEffect(() => {
      if (still) return;

      const loops = scales.map((scale, index) =>
        Animated.loop(
          Animated.sequence([
            Animated.delay(index * motion.levelStaggerMs),
            Animated.timing(scale, {
              toValue: MIN_SCALE,
              duration: motion.levelMs / 2,
              useNativeDriver: true,
            }),
            Animated.timing(scale, {
              toValue: 1,
              duration: motion.levelMs / 2,
              useNativeDriver: true,
            }),
          ]),
        ),
      );
      loops.forEach(loop => loop.start());

      return () => loops.forEach(loop => loop.stop());
    }, [still, scales]);

    return (
      <View testID={testID} style={styles.row}>
        {HEIGHTS.map((height, index) => (
          <Animated.View
            key={height}
            testID="bars-bar"
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            style={[
              styles.bar,
              {
                height,
                backgroundColor: color,
                transform: still
                  ? []
                  : [
                      {
                        translateY: scales[index].interpolate({
                          inputRange: [MIN_SCALE, 1],
                          outputRange: [(height * (1 - MIN_SCALE)) / 2, 0],
                        }),
                      },
                      {scaleY: scales[index]},
                    ],
              },
            ]}
          />
        ))}
      </View>
    );
  },
  'LevelBars',
);

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 6,
    height: ROW_HEIGHT,
  },
  bar: {width: 5, borderRadius: radii.sm},
});
