import React from 'react';
import {Pressable, StyleSheet, View} from 'react-native';

import {colors, icon, sizes} from './theme';

/**
 * The settings gear of spec section 12, rebuilt to `design/theme.css`'s
 * `.gearmark` (spec'd on the glyph sheet, `design/01 Radio.dc.html` frame 14).
 *
 * Eight teeth, 3 x 6 at radius 1, each anchored TOP-CENTRE of a wrapper that
 * fills the 24 box and is rotated k * 45deg about that box's centre -- so there
 * is no trigonometry here and no per-tooth coordinate. Over them a hub RING
 * inset 5 at the chrome stroke, which the teeth overlap by exactly 1 (a tooth
 * runs y=0..6, the hub's outer edge is at y=5) so the shape reads as one piece.
 *
 * NO PUNCH-OUT. The previous build drew a filled disc with a hole painted in
 * the chassis colour, which is why it needed to be told what it was sitting on.
 * Three of the radio screen's five states put a gradient wash behind this
 * corner, and a hole painted in a flat chassis colour does not survive a
 * gradient -- so the hub is a ring with nothing inside it, and the `notchColor`
 * prop is gone with the hole.
 *
 * The canvas's `.gear` is `color: var(--faint)`, the same token the `PowerKey`
 * beside it takes: the two corner controls have to agree.
 */
export function GearButton({
  onPress,
  accessibilityLabel,
  testID,
}: {
  onPress: () => void;
  /** Icon-only, so this is not optional -- there is no visible word to fall back on. */
  accessibilityLabel: string;
  testID?: string;
}) {
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      hitSlop={(sizes.cornerControl - icon.chrome) / 2}
      style={styles.hit}>
      <View
        // One decorative glyph, not eight nameless views: the `Pressable`
        // above already carries the name.
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={styles.mark}>
        {TEETH.map(angle => (
          <View
            key={angle}
            testID="gear-tooth"
            style={[styles.toothWrapper, {transform: [{rotate: `${angle}deg`}]}]}>
            <View testID="gear-tooth-bar" style={styles.tooth} />
          </View>
        ))}
        <View testID="gear-ring" style={styles.hub} />
      </View>
    </Pressable>
  );
}

/** `.gt:nth-child(n)` -- eight wrappers at k * 45deg. */
const TEETH = [0, 45, 90, 135, 180, 225, 270, 315] as const;

/** `.gt::after` -- 3 x 6 at radius 1. */
const TOOTH = {width: 3, height: 6, radius: 1} as const;
/** `.ghub` -- `inset: 5`. */
const HUB_INSET = 5;

const styles = StyleSheet.create({
  hit: {
    width: icon.chrome,
    height: icon.chrome,
    alignItems: 'center',
    justifyContent: 'center',
  },
  mark: {width: icon.chrome, height: icon.chrome},
  /**
   * Fills the whole box, so `rotate` -- which React Native takes about a view's
   * own centre -- turns about the BOX centre and the tooth pinned to this
   * wrapper's top edge sweeps the rim. That is the whole trick.
   */
  toothWrapper: {
    position: 'absolute',
    width: icon.chrome,
    height: icon.chrome,
  },
  tooth: {
    position: 'absolute',
    top: 0,
    left: (icon.chrome - TOOTH.width) / 2,
    width: TOOTH.width,
    height: TOOTH.height,
    borderRadius: TOOTH.radius,
    backgroundColor: colors.textFaint,
  },
  hub: {
    position: 'absolute',
    top: HUB_INSET,
    left: HUB_INSET,
    width: icon.chrome - HUB_INSET * 2,
    height: icon.chrome - HUB_INSET * 2,
    borderRadius: (icon.chrome - HUB_INSET * 2) / 2,
    borderWidth: icon.chromeStroke,
    borderColor: colors.textFaint,
  },
});
