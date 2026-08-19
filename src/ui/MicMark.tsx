import React from 'react';
import {Animated, StyleSheet, View} from 'react-native';
import type {ViewStyle} from 'react-native';

import {colors, icon} from './theme';

/**
 * The microphone of `design/theme.css`'s `.micmark`, drawn at size on the glyph
 * sheet in `design/01 Radio.dc.html` frame 14.
 *
 * ONE glyph at two idioms. It is the talk ring's hero affordance at the control
 * idiom (160 box / 3.5 stroke, `design/01 Radio.dc.html` frames 03 / 07 / 12)
 * and the onboarding microphone page mark at the page-mark idiom (176 / 2.5,
 * `design/04 Onboarding.dc.html` frame 01). Every part below is a FRACTION of
 * the box, so the two differ by nothing but `box` and `stroke` -- which is why
 * this is one component and not two drawings that have to be kept in step. The
 * onboarding mark's old two-tone capsule (a `--faint` stem and base under an
 * `--ink` capsule, and no cradle at all) is retired: a glyph in this system
 * carries exactly one colour token, and the product has one microphone form.
 *
 * Four parts, all primitives -- there is no SVG renderer here and the
 * dependency freeze means there may not be. The cradle is the partial-border
 * arc trick this codebase already uses in `RouteIcon` and `PermissionMark`: a
 * box with NO top border and both bottom radii set to its own height, which at
 * 96 x 48 collapses to a pure semicircle opening upward.
 *
 * React Native's box model is border-box, exactly as the canvas states its
 * figures, so every number the sheet gives is an OUTER dimension and
 * transcribes directly.
 */
export type MicMarkIdiom = 'control' | 'pagemark';

const IDIOMS = {
  /** `--icon-control` / `--icon-control-stroke` -- inside the talk ring. */
  control: {box: icon.control, stroke: icon.controlStroke},
  /** `--icon-hero` / `--icon-hero-stroke` -- the onboarding page mark. */
  pagemark: {box: icon.hero, stroke: icon.heroStroke},
} as const satisfies Record<MicMarkIdiom, {box: number; stroke: number}>;

/**
 * The canvas's percentages, kept as the fractions they are rather than resolved
 * to one idiom's pixels. At `box = 160` these give the glyph sheet's own
 * figures exactly: capsule 60 x 92 at (50, 13) radius 30, cradle 96 x 48 at
 * (32, 81), stem 3.5 x 14 at (78.25, 129), base 50 x 3.5 at (55, 143).
 */
const FRACTIONS = {
  capsule: {left: 0.3125, top: 0.08125, width: 0.375, height: 0.575, radius: 0.1875},
  cradle: {left: 0.2, top: 0.50625, width: 0.6, height: 0.3, radius: 0.3},
  stem: {left: 0.5, top: 0.80625, height: 0.0875},
  base: {left: 0.34375, top: 0.89375, width: 0.3125},
} as const;

export function MicMark({
  idiom,
  color = colors.text,
  opacity,
  testID,
}: {
  idiom: MicMarkIdiom;
  /**
   * `currentColor`. Defaults to `--ink`, which is what BOTH idioms take: a
   * ready-state glyph inside the talk ring is never an accent -- an accent
   * there would read as a live state before anyone has pressed anything.
   */
  color?: string;
  /**
   * The ring's power-off cross-fade, which rides an `Animated` value owned by
   * the screen. Typed the same way `StateRing`'s `borderColor` is, for the same
   * reason: the value belongs to the one non-native driver the whole seal hangs
   * off, and it may not be split onto a second clock here.
   *
   * The root is an `Animated.View` whether or not this is passed, because
   * swapping the component type at the start of a hold would remount the glyph
   * and flash it -- the same reason the headline it replaced was always an
   * `Animated.Text`.
   */
  opacity?: ViewStyle['opacity'] | Animated.AnimatedInterpolation<number>;
  testID?: string;
}) {
  const {box, stroke} = IDIOMS[idiom];
  const f = FRACTIONS;

  return (
    <Animated.View
      testID={testID}
      // Decorative, always. On the talk ring the surrounding `Pressable`
      // already declares the name "Push to talk", so a second name here would
      // only make the button announce itself twice; on the onboarding page the
      // title beside it carries the word. Four nameless views is what a screen
      // reader would otherwise walk for one microphone.
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[{width: box, height: box}, opacity === undefined ? null : {opacity}]}>
      {/* Capsule -- radius is half its own width, so a true capsule. */}
      <View
        testID="mic-capsule"
        style={[
          styles.part,
          {
            left: box * f.capsule.left,
            top: box * f.capsule.top,
            width: box * f.capsule.width,
            height: box * f.capsule.height,
            borderWidth: stroke,
            borderColor: color,
            borderRadius: box * f.capsule.radius,
          },
        ]}
      />
      {/* Cradle -- three borders and no top, both bottom radii = its own
          height. Its arms flank the capsule's sides and wrap below it. */}
      <View
        testID="mic-cradle"
        style={[
          styles.part,
          {
            left: box * f.cradle.left,
            top: box * f.cradle.top,
            width: box * f.cradle.width,
            height: box * f.cradle.height,
            borderWidth: stroke,
            borderTopWidth: 0,
            borderColor: color,
            borderBottomLeftRadius: box * f.cradle.radius,
            borderBottomRightRadius: box * f.cradle.radius,
          },
        ]}
      />
      {/* Stem -- stroke-wide, starting exactly at the cradle's foot. Centred
          on the box, so it carries the only offset that is not a fraction. */}
      <View
        testID="mic-stem"
        style={[
          styles.part,
          {
            left: box * f.stem.left - stroke / 2,
            top: box * f.stem.top,
            width: stroke,
            height: box * f.stem.height,
            backgroundColor: color,
          },
        ]}
      />
      <View
        testID="mic-base"
        style={[
          styles.part,
          {
            left: box * f.base.left,
            top: box * f.base.top,
            width: box * f.base.width,
            height: stroke,
            borderRadius: stroke / 2,
            backgroundColor: color,
          },
        ]}
      />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  part: {position: 'absolute'},
});
