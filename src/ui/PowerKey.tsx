import React from 'react';
import {Pressable, StyleSheet, View} from 'react-native';
import {reatomComponent} from '@reatom/react';

import {colors, glows, sizes} from './theme';
import type {HoldHandle} from './useHoldToConfirm';

/**
 * The hardware-style IEC power key of spec section 12.1 -- a ring broken at the
 * top with a bar rising through the gap. Drawn from plain views rather than an
 * SVG, so it needs no dependency and scales with `variant`.
 *
 * `hero` is the whole-screen on-switch of the `off` state, a plain TAP; `corner`
 * is the small key that mirrors the settings gear once the radio is on, and
 * turning the radio off is a press-and-hold -- a guard against an accidental
 * shut-off on a screen that is one giant touch area.
 *
 * The key does not own that hold. It used to, along with a 3pt progress bar
 * drawn inside its own 56pt box -- under the very thumb doing the holding,
 * where it could not be seen. The canvas now runs that progress across the
 * whole screen as an amber perimeter seal (`design/01 Radio.dc.html` frames
 * 09-13), so the gesture belongs to the screen: it passes a `hold` handle from
 * `useHoldToConfirm` and this key drives it and reports it. All that is left
 * here is `.pwr.arm` -- the key goes amber while the hold runs.
 */
export type PowerKeyProps = {
  variant: 'hero' | 'corner';
  /** A tap key's action. Mutually exclusive with `hold` in practice. */
  onActivate?: () => void;
  /**
   * A hold key's gesture, owned by the screen because its progress is painted
   * across the screen. `undefined` makes this a tap key.
   */
  hold?: HoldHandle;
  disabled?: boolean;
  /**
   * The colour the ring's gap is painted in. The notch has to match whatever
   * the key is sitting on, and the canvas gives the `off` screen its own,
   * darker chassis (`.phone.off`), so the hero variant is told rather than
   * assuming.
   */
  notchColor?: string;
  accessibilityLabel: string;
  testID?: string;
};

const SIZES = {
  hero: {
    box: sizes.powerKeyHero,
    border: 5,
    bar: 5,
    barHeight: Math.round(sizes.powerKeyHero * 0.66),
    notch: Math.round(sizes.powerKeyHero * 0.34),
  },
  corner: {
    box: sizes.powerKeyCorner,
    border: 2,
    bar: 2,
    barHeight: Math.round(sizes.powerKeyCorner * 0.66),
    notch: Math.round(sizes.powerKeyCorner * 0.34),
  },
} as const;

export const PowerKey = reatomComponent<PowerKeyProps>(
  ({variant, onActivate, hold, disabled = false, notchColor = colors.background, accessibilityLabel, testID}) => {
    const size = SIZES[variant];
    /**
     * `.pwr.arm`: amber from the first instant of the hold until it commits,
     * and released the moment the finger leaves -- frame 12 shows an aborted
     * hold with the key already back to its resting colour, while the rails
     * are still retracting. Amber, not the red this key used to take: red is
     * TRANSMITTING and owns a full-screen wash of its own.
     */
    const armed = hold?.phase === 'holding' || hold?.phase === 'closing';
    const mark = armed ? colors.seal : colors.textFaint;

    const onPress = () => {
      if (disabled || hold) return;
      onActivate?.();
    };

    return (
      <Pressable
        testID={testID}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        accessibilityState={{disabled}}
        onPress={onPress}
        onPressIn={hold && !disabled ? hold.onPressIn : undefined}
        onPressOut={hold ? hold.onPressOut : undefined}
        hitSlop={variant === 'corner' ? (sizes.cornerControl - SIZES.corner.box) / 2 : 0}
        style={[styles.hit, {width: size.box, height: size.box}]}>
        <View
          testID="power-key-ring"
          style={[
            styles.ring,
            {
              width: size.box,
              height: size.box,
              borderRadius: size.box / 2,
              borderWidth: size.border,
              borderColor: mark,
              opacity: disabled ? 0.35 : 1,
            },
            armed && styles.armed,
          ]}
        />
        {/* The gap the bar rises through: chassis-coloured, so it reads as a
            break in the ring rather than a shape sitting on top of it. */}
        <View
          testID="power-key-notch"
          style={[
            styles.notch,
            {
              width: size.notch,
              height: size.border * 2,
              backgroundColor: notchColor,
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
              backgroundColor: mark,
              top: size.box / 2 - size.barHeight + size.border,
              opacity: disabled ? 0.35 : 1,
            },
          ]}
        />
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
  /** `.pwr.arm .pwrmark`'s amber drop-shadow. */
  armed: {boxShadow: glows.sealKey},
});
