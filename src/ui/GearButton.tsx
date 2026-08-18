import React from 'react';
import {Pressable, StyleSheet, View} from 'react-native';

import {colors} from './theme';

/**
 * The settings gear of spec section 12: a ring with six teeth, drawn from views.
 *
 * It sits beside `PowerKey` in the radio screen's corner controls and is painted
 * to match: the canvas's `.gear` is `color: var(--faint)`, the same token the
 * key's ring and bar take (`colors.textFaint`), not the full-strength body text.
 */
export function GearButton({
  onPress,
  notchColor = colors.background,
  accessibilityLabel,
  testID,
}: {
  onPress: () => void;
  /**
   * The colour the gear's hub is punched out in. Like `PowerKey`'s notch it has
   * to match whatever the control is sitting on, and the canvas gives the `off`
   * screen its own darker chassis (`.phone.off`), so it is told rather than
   * assuming.
   */
  notchColor?: string;
  accessibilityLabel: string;
  testID?: string;
}) {
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      hitSlop={12}
      style={styles.hit}>
      {[0, 30, 60, 90, 120, 150].map(angle => (
        <View
          key={angle}
          style={[styles.tooth, {transform: [{rotate: `${angle}deg`}]}]}
        />
      ))}
      <View testID="gear-ring" style={styles.ring} />
      <View testID="gear-hub" style={[styles.hub, {backgroundColor: notchColor}]} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  hit: {width: 34, height: 34, alignItems: 'center', justifyContent: 'center'},
  tooth: {
    position: 'absolute',
    width: 5,
    height: 32,
    borderRadius: 2,
    backgroundColor: colors.textFaint,
  },
  ring: {
    position: 'absolute',
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: colors.textFaint,
  },
  hub: {
    position: 'absolute',
    width: 10,
    height: 10,
    borderRadius: 5,
  },
});
