import React, {useCallback, useEffect, useRef, useState} from 'react';
import {Animated, Pressable, StyleSheet, View} from 'react-native';
import {reatomComponent} from '@reatom/react';

import {colors, motion, radii} from './theme';
import {reducedMotion} from './reducedMotion';

/**
 * The hardware-style IEC power key of spec section 12.1 -- a ring broken at the
 * top with a bar rising through the gap. Drawn from plain views rather than an
 * SVG, so it needs no dependency and scales with `variant`.
 *
 * `hero` is the whole-screen on-switch of the `off` state; `corner` is the
 * small key that mirrors the settings gear once the radio is on. Turning the
 * radio *off* is a press-and-hold (`holdToConfirm`), a guard against an
 * accidental shut-off on a screen that is one giant touch area.
 */
export type PowerKeyProps = {
  variant: 'hero' | 'corner';
  onActivate: () => void;
  holdToConfirm?: boolean;
  disabled?: boolean;
  accessibilityLabel: string;
  testID?: string;
};

const SIZES = {
  hero: {box: 128, border: 8, bar: 8, barHeight: 46, notch: 26},
  corner: {box: 34, border: 3, bar: 3, barHeight: 13, notch: 9},
} as const;

export const PowerKey = reatomComponent<PowerKeyProps>(
  ({variant, onActivate, holdToConfirm = false, disabled = false, accessibilityLabel, testID}) => {
    const still = reducedMotion();
    const size = SIZES[variant];
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const [holding, setHolding] = useState(false);
    const progress = useRef(new Animated.Value(0)).current;

    const clear = useCallback(() => {
      if (timer.current !== null) {
        clearTimeout(timer.current);
        timer.current = null;
      }
      progress.stopAnimation();
      progress.setValue(0);
      setHolding(false);
    }, [progress]);

    useEffect(() => clear, [clear]);

    const onPressIn = () => {
      if (disabled || !holdToConfirm) return;

      setHolding(true);
      if (!still) {
        Animated.timing(progress, {
          toValue: 1,
          duration: motion.powerHoldMs,
          useNativeDriver: false,
        }).start();
      }
      timer.current = setTimeout(() => {
        clear();
        onActivate();
      }, motion.powerHoldMs);
    };

    const onPressOut = () => {
      if (!holdToConfirm) return;
      clear();
    };

    const onPress = () => {
      if (disabled || holdToConfirm) return;
      onActivate();
    };

    return (
      <Pressable
        testID={testID}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        accessibilityState={{disabled}}
        onPress={onPress}
        onPressIn={onPressIn}
        onPressOut={onPressOut}
        hitSlop={variant === 'corner' ? 12 : 0}
        style={[styles.hit, {width: size.box, height: size.box}]}>
        <View
          style={[
            styles.ring,
            {
              width: size.box,
              height: size.box,
              borderRadius: size.box / 2,
              borderWidth: size.border,
              borderColor: holding ? colors.tx : colors.text,
              opacity: disabled ? 0.35 : 1,
            },
          ]}
        />
        {/* The gap the bar rises through: chassis-coloured, so it reads as a
            break in the ring rather than a shape sitting on top of it. */}
        <View
          style={[
            styles.notch,
            {
              width: size.notch,
              height: size.border * 2,
              backgroundColor: colors.background,
              top: -size.border / 2,
            },
          ]}
        />
        <View
          style={[
            styles.bar,
            {
              width: size.bar,
              height: size.barHeight,
              borderRadius: size.bar / 2,
              backgroundColor: holding ? colors.tx : colors.text,
              top: size.box / 2 - size.barHeight + size.border,
              opacity: disabled ? 0.35 : 1,
            },
          ]}
        />
        {holdToConfirm && holding ? (
          <Animated.View
            testID="power-key-progress"
            style={[
              styles.progress,
              {
                backgroundColor: colors.tx,
                width: still
                  ? size.box
                  : progress.interpolate({
                      inputRange: [0, 1],
                      outputRange: [0, size.box],
                    }),
              },
            ]}
          />
        ) : null}
      </Pressable>
    );
  },
  'PowerKey',
);

const styles = StyleSheet.create({
  hit: {alignItems: 'center', justifyContent: 'center'},
  ring: {position: 'absolute'},
  notch: {position: 'absolute'},
  bar: {position: 'absolute'},
  progress: {
    position: 'absolute',
    bottom: -6,
    left: 0,
    height: 3,
    borderRadius: radii.sm,
  },
});
