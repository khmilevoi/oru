import React from 'react';
import {Animated, StyleSheet, View} from 'react-native';
import {reatomComponent} from '@reatom/react';
import {
  useSafeAreaFrame,
  useSafeAreaInsets,
} from 'react-native-safe-area-context';

import {colors, glows, seal, washes} from './theme';
import {reducedMotion} from './reducedMotion';
import type {HoldPhase} from './useHoldToConfirm';

/**
 * The power-off hold, drawn across the whole screen as an amber perimeter seal
 * -- `design/01 Radio.dc.html` frames 09-13 and the `canvasnote hold` under
 * them, which is the contract this file implements.
 *
 * It replaces a 3pt bar that filled inside the 56pt corner power key: directly
 * under the thumb doing the holding, so nobody ever saw it. A hold is a
 * progress bar the user cannot look away from, and it has to be drawn where
 * the finger is not.
 *
 * ## The geometry, and why it needs no per-device constant
 *
 * Four rails, `--seal-w` thick, inset `--seal-inset` from the screen edge.
 * Both paths start at the power key's own corner (bottom right) and race in
 * opposite directions: one along the bottom then up the left, the other up the
 * right then along the top. Each path is exactly `railW + railH` long on ANY
 * rectangle, so the two arrive at the far corner together on every screen size
 * without a single measured constant. The breakpoints follow from that and are
 * derived here, never written down: `kx = railW / (railW + railH)` is the
 * fraction of the hold the bottom rail takes, `ky = railH / (railW + railH)`
 * the fraction the right rail takes, and `kx + ky === 1`.
 *
 * ## Where the 16pt is measured from
 *
 * THREE SIDES FROM THE PHYSICAL EDGE, THE TOP FROM THE SAFE AREA. A perimeter
 * seal wants to hug the screen's own edge, and on the left, right and bottom
 * it does: nothing there occludes paint. The bottom inset holds the home
 * indicator or the gesture pill, which are thin, centred and translucent, and
 * a 3pt rail 16pt up from the edge clears them -- while insetting the bottom
 * rail by the whole safe area would float the seal 50pt off the edge and put
 * it inside the corner controls' own row.
 *
 * The top is the one edge with an OPAQUE system overlay: the status bar, and
 * on most devices a notch or an island cut out of the display. A top rail
 * 16pt from the physical top would be drawn underneath it and simply not
 * exist to the user -- and worse, the top-left corner where the two paths
 * close, the payoff of the entire animation, is exactly what would be
 * swallowed. So the top rail takes the safe area and then the same 16.
 *
 * Mechanically that inset arrives for free: `RadioScreen`'s chassis already
 * pads itself by `insets.top`, and an absolutely positioned child is laid out
 * against its parent's PADDING box, so this overlay's own `top: 0` is already
 * below the status bar. `railH` subtracts the same inset so the arithmetic
 * above still describes the rails that are actually drawn. The uneven frame
 * costs nothing: `kx` and `ky` are computed from these two lengths, so the
 * two paths still close together.
 *
 * ## One value, and `useNativeDriver: false`
 *
 * Every layer here is a width, a height or an opacity interpolated off the one
 * `Animated.Value` the caller drives. Width and height cannot be driven
 * natively, so nothing else may be either -- a layer on a native-driven value
 * would run on a different clock and visibly lead or lag the rails.
 */
export type HoldSealProps = {
  /** The hold's progress, 0 -> 1. See `useHoldToConfirm`. */
  progress: Animated.Value;
  phase: HoldPhase;
};

export const HoldSeal = reatomComponent<HoldSealProps>(({progress, phase}) => {
  const still = reducedMotion();
  // The frame the insets were measured against, not `Dimensions`: on Android
  // the two disagree about what the system bars belong to, and a seal that
  // mixed them would inset its top rail against a height it does not have.
  const frame = useSafeAreaFrame();
  const insets = useSafeAreaInsets();

  const railW = frame.width - seal.inset * 2;
  const railH = frame.height - insets.top - seal.inset * 2;
  const total = railW + railH;
  // A frame too small to hold the inset at all (never a real device; a
  // zero-sized frame on the very first layout pass is enough to reach it).
  if (railW <= 0 || railH <= 0) return null;

  const kx = railW / total;
  const ky = railH / total;

  /**
   * One rail's extent: 0 at `from`, its full length at `to`, clamped flat
   * outside that window so a rail that has not started yet stays at 0 and one
   * that has finished stays whole.
   */
  const grow = (from: number, to: number, extent: number) =>
    still
      ? extent
      : progress.interpolate({
          inputRange: [from, to],
          outputRange: [0, extent],
          extrapolate: 'clamp',
        });

  const retreating = phase === 'aborting';

  return (
    <View
      testID="hold-seal"
      // The screen underneath is one giant push-to-talk target and this is
      // paint, not a control.
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[styles.overlay, still && styles.whole]}>
      {/*
        Anchored at the thumb's own corner and tracking progress linearly, at
        the canvas's 0.20 peak alpha -- low enough that the gear, the power key
        and the route readout, all of which paint AFTER this overlay, stay
        legible on top of it.
      */}
      <Animated.View
        testID="seal-wash"
        style={[
          styles.wash,
          {
            opacity: still
              ? 1
              : progress.interpolate({
                  inputRange: [0, 1],
                  outputRange: [0, 1],
                  extrapolate: 'clamp',
                }),
          },
        ]}
      />
      {/*
        The close: the corner wash goes full-bleed for `motion.sealCloseMs`
        while the closed loop is held. This is the flash that announces the
        shut-off, together with the haptic -- the canvas asks for exactly that
        and NOT for a visible corner join.
      */}
      {phase === 'closing' ? (
        <View testID="seal-flash" style={styles.flash} />
      ) : null}

      {/* Anchored RIGHT, growing left along the bottom edge. */}
      <Animated.View
        testID="seal-rail-bottom"
        style={[
          styles.rail,
          styles.bottomRail,
          retreating ? styles.retreating : styles.glowing,
          {width: grow(0, kx, railW)},
        ]}
      />
      {/* Anchored BOTTOM, growing up the right edge. */}
      <Animated.View
        testID="seal-rail-right"
        style={[
          styles.rail,
          styles.rightRail,
          retreating ? styles.retreating : styles.glowing,
          {height: grow(0, ky, railH)},
        ]}
      />
      {/* Anchored BOTTOM, growing up the left edge -- the bottom rail's path,
          continued past the far bottom corner. */}
      <Animated.View
        testID="seal-rail-left"
        style={[
          styles.rail,
          styles.leftRail,
          retreating ? styles.retreating : styles.glowing,
          {height: grow(kx, 1, railH)},
        ]}
      />
      {/* Anchored RIGHT, growing left along the top edge -- the right rail's
          path, continued past the top right corner. */}
      <Animated.View
        testID="seal-rail-top"
        style={[
          styles.rail,
          styles.topRail,
          retreating ? styles.retreating : styles.glowing,
          {width: grow(ky, 1, railW)},
        ]}
      />
    </View>
  );
}, 'HoldSeal');

const styles = StyleSheet.create({
  /**
   * The chassis's padding box: full width, from below the status bar to the
   * physical bottom edge. It is a SIBLING of the push-to-talk area and of the
   * centred stage column inside it, never a member of that column -- the talk
   * ring is geometrically invariant and an overlay is the only way to paint
   * over the whole screen without adding a box to it.
   */
  overlay: {position: 'absolute', top: 0, right: 0, bottom: 0, left: 0},
  /** Reduced motion: the whole perimeter at once, at half strength. */
  whole: {opacity: seal.stillOpacity},
  wash: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundImage: washes.seal,
  },
  flash: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: colors.sealWash,
  },
  rail: {
    position: 'absolute',
    backgroundColor: colors.seal,
    borderRadius: seal.radius,
  },
  glowing: {boxShadow: glows.seal},
  /**
   * `.sealing.abort .seal` -- dimmed and unglowed while it retracts, so an
   * abort reads as the seal giving the ground back rather than as an event of
   * its own. No colour change: the hue never says anything but "amber" here.
   */
  retreating: {opacity: seal.abortOpacity},
  bottomRail: {
    right: seal.inset,
    bottom: seal.inset,
    height: seal.railWidth,
  },
  topRail: {right: seal.inset, top: seal.inset, height: seal.railWidth},
  rightRail: {right: seal.inset, bottom: seal.inset, width: seal.railWidth},
  leftRail: {left: seal.inset, bottom: seal.inset, width: seal.railWidth},
});
