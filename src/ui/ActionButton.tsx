import React from 'react';
import {Pressable, StyleSheet, Text} from 'react-native';

import {colors, radii, spacing, type} from './theme';

/** The chassis-style key every screen but the main one uses. */
export function ActionButton({
  label,
  onPress,
  onPressIn,
  onPressOut,
  tone = 'default',
  disabled = false,
  testID,
  accessibilityLabel,
}: {
  label: string;
  onPress?: () => void;
  onPressIn?: () => void;
  onPressOut?: () => void;
  tone?: 'default' | 'primary' | 'danger';
  disabled?: boolean;
  testID?: string;
  accessibilityLabel?: string;
}) {
  const toneStyle =
    tone === 'primary'
      ? styles.primary
      : tone === 'danger'
        ? styles.danger
        : styles.neutral;

  return (
    <Pressable
      testID={testID}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{disabled}}
      onPress={onPress}
      onPressIn={onPressIn}
      onPressOut={onPressOut}
      style={({pressed}) => [
        styles.key,
        toneStyle,
        pressed && styles.pressed,
        disabled && styles.disabled,
      ]}>
      <Text style={[type.label, styles.label]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  key: {
    minHeight: 48,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderRadius: radii.md,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  neutral: {backgroundColor: colors.surfaceRaised, borderColor: colors.hairline},
  primary: {backgroundColor: colors.surfaceRaised, borderColor: colors.rx},
  danger: {backgroundColor: colors.surfaceRaised, borderColor: colors.danger},
  pressed: {backgroundColor: colors.surface},
  disabled: {opacity: 0.4},
  label: {color: colors.text},
});
