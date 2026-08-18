import React from 'react';
import {Pressable, StyleSheet, View} from 'react-native';

import {colors} from './theme';

/** The settings gear of spec section 12: a ring with six teeth, drawn from views. */
export function GearButton({
  onPress,
  accessibilityLabel,
  testID,
}: {
  onPress: () => void;
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
      <View style={styles.ring} />
      <View style={styles.hub} />
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
    backgroundColor: colors.text,
  },
  ring: {
    position: 'absolute',
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: colors.text,
  },
  hub: {
    position: 'absolute',
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: colors.background,
  },
});
