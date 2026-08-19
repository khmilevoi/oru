import React from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';

import {colors, radii, segmented, type} from './theme';

/**
 * The canvas's `.seg` (`design/02 Settings.dc.html`): a row of equal segments
 * inside one rounded outline, with hairline seams between them and the selected
 * one inverted.
 *
 * Generic and copy-free on purpose -- it takes finished labels, exactly as
 * `ActionButton` and `ScreenFrame` do, so the screen owns the translating.
 *
 * The seam is `border-left` on every segment but the first, matching the
 * canvas's `.seg span + span` rule; drawing it as a separate element would put
 * a node between two flex children and break the equal-width split.
 */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  testID,
}: {
  options: ReadonlyArray<{value: T; label: string}>;
  value: T;
  onChange: (next: T) => void;
  testID?: string;
}) {
  return (
    <View testID={testID} style={styles.row} accessibilityRole="radiogroup">
      {options.map((option, index) => {
        const selected = option.value === value;

        return (
          <Pressable
            key={option.value}
            testID={testID ? `${testID}-${option.value}` : undefined}
            accessibilityRole="radio"
            accessibilityState={{selected}}
            accessibilityLabel={option.label}
            onPress={() => onChange(option.value)}
            style={[
              styles.segment,
              index > 0 && styles.seam,
              selected && styles.selected,
            ]}>
            <Text style={selected ? styles.selectedLabel : styles.label}>
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    borderWidth: 1,
    borderColor: colors.hairlineRaised,
    borderRadius: radii.md,
    overflow: 'hidden',
  },
  segment: {
    flex: 1,
    paddingVertical: segmented.paddingVertical,
    alignItems: 'center',
    justifyContent: 'center',
  },
  seam: {borderLeftWidth: 1, borderLeftColor: colors.hairlineRaised},
  selected: {backgroundColor: colors.text},
  label: {...type.segment, color: colors.textMuted},
  selectedLabel: {...type.segmentSelected, color: colors.textInverse},
});
