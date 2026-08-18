import React from 'react';
import {StyleSheet, View} from 'react-native';

import {colors} from './theme';

/** The canvas's `.obdots`: done dots go green, the current dot goes ink. */
export function StepDots({
  total,
  current,
  testID,
}: {
  total: number;
  current: number;
  testID?: string;
}) {
  return (
    <View testID={testID} style={styles.row}>
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
  dot: {width: 6, height: 6, borderRadius: 3, backgroundColor: colors.hairlineRaised},
  on: {backgroundColor: colors.text},
  done: {backgroundColor: colors.rx},
});
