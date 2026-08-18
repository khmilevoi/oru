import React from 'react';
import {StyleSheet, Text, View} from 'react-native';

import {colors, glows, sizes, type} from './theme';

/**
 * The canvas's `.peer` header row: a glowing green dot and the nearby count,
 * held at a fixed height so the ring below it does not shift between the states
 * that show the row and the ones that leave it empty.
 */
export function PeerRow({
  label,
  testID,
}: {
  label?: React.ReactNode;
  testID?: string;
}) {
  return (
    <View testID={testID} style={styles.row}>
      {label === undefined ? null : (
        <>
          <View
            testID={testID === undefined ? undefined : `${testID}-dot`}
            style={styles.dot}
          />
          <Text style={[type.peer, styles.label]}>{label}</Text>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    height: sizes.peerRow,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
  },
  dot: {
    width: 9,
    height: 9,
    borderRadius: 4.5,
    backgroundColor: colors.rx,
    boxShadow: glows.peer,
  },
  label: {color: colors.textMuted},
});
