import React from 'react';
import {Pressable, StyleSheet, Text} from 'react-native';

import {colors, radii, sizes, spacing, type} from './theme';

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
      <Text style={[type.button, tone === 'primary' ? styles.labelSolid : styles.label]}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  key: {
    height: sizes.button,
    paddingHorizontal: spacing.lg,
    borderRadius: radii.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  /** `.btn.ghost` */
  neutral: {borderWidth: 1, borderColor: colors.hairlineRaised},
  /** `.btn.solid` */
  primary: {backgroundColor: colors.text},
  /** No canvas equivalent -- a ghost key in the danger colour (decision D5). */
  danger: {borderWidth: 1, borderColor: colors.danger},
  pressed: {opacity: 0.7},
  disabled: {opacity: 0.4},
  label: {color: colors.text},
  labelSolid: {color: colors.textInverse},
});
