import React from 'react';
import {StyleSheet, View} from 'react-native';

import {colors} from './theme';

/**
 * The canvas's `.obdots` (`design/theme.css`, drawn on the glyph sheet in
 * `design/01 Radio.dc.html` frame 14).
 *
 * These dots are now the ONLY step indicator on the onboarding screen -- the
 * "STEP n OF m" line that duplicated them was deleted on 2026-08-19 -- so the
 * three states differ by SHAPE and not merely by hue: pending is a hollow 6
 * ring at 1pt, current is an 18 x 6 pill, done is a filled 6. Wherever a glyph
 * becomes the only carrier of a state, form has to carry what hue carries.
 *
 * The counter's words were not dropped either. They moved here, onto the row's
 * accessible name -- which is why `accessibilityLabel` is a real parameter and
 * not decoration.
 */
export function StepDots({
  total,
  current,
  accessibilityLabel,
  testID,
}: {
  total: number;
  current: number;
  /**
   * "Step n of m", relocated from the deleted visible line. Omitted where there
   * is no step left to announce -- the done frame, whose own title says it --
   * and the row then leaves the accessibility tree entirely rather than reading
   * as three nameless views.
   */
  accessibilityLabel?: string;
  testID?: string;
}) {
  const named = accessibilityLabel !== undefined;

  return (
    <View
      testID={testID}
      accessibilityRole={named ? 'image' : undefined}
      accessibilityLabel={accessibilityLabel}
      accessibilityElementsHidden={named ? undefined : true}
      importantForAccessibility={named ? undefined : 'no-hide-descendants'}
      style={styles.row}>
      {Array.from({length: total}, (_, index) => (
        <View
          key={index}
          testID="step-dot"
          style={[
            styles.dot,
            index < current && styles.done,
            index === current && styles.on,
          ]}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {flexDirection: 'row', justifyContent: 'center', gap: 8, paddingTop: 28},
  /** Pending -- a HOLLOW ring, so it is not merely a dimmer `done`. */
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    borderWidth: 1,
    borderColor: colors.hairlineRaised,
  },
  /** Current -- an 18 x 6 pill. The same radius; only the width changes. */
  on: {width: 18, backgroundColor: colors.text, borderColor: colors.text},
  /** Done -- filled. */
  done: {backgroundColor: colors.rx, borderColor: colors.rx},
});
