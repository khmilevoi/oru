import React from 'react';
import {StyleSheet, View} from 'react-native';

import {colors} from './theme';

/**
 * Signal strength, `design/theme.css`'s `.sig` -- the glyph that replaced the
 * `BLE ·` prefix on every pairing scan row (`design/03 Pairing.dc.html` frame
 * 02, spec'd on the glyph sheet in `design/01 Radio.dc.html` frame 14).
 *
 * BARS, NOT STROKES. This is the small idiom by size, but a 1.5pt outline at
 * 12pt greys into mush, so the canvas draws four solid bars instead: 2.5 wide,
 * 1.5 apart, 4 / 6.5 / 9 / 11.5 tall on one shared baseline -- a 14.5 x 12 box.
 *
 * The dBm figure always stays beside it. Four bars cannot separate two
 * similarly named buttons lying on the same shelf, which is the whole job of
 * that row; and `BLE ·` could go without a new home precisely because it was
 * constant on every row and the screen already says it once ("SCANNING FOR BLE
 * DEVICES..."), while a glyph that carries a READING always needs the reading
 * kept.
 */

/**
 * RSSI -> filled bars, exactly as the canvas fixes it: ">= -55 IS FOUR, -55 TO
 * -67 THREE, -67 TO -80 TWO, BELOW -80 ONE". Its own exported function so the
 * mapping is testable on its own and can never be re-invented at a call site.
 * The canvas's two worked examples are -52 (four) and -71 (two).
 */
export const barsForRssi = (rssi: number): number => {
  if (rssi >= -55) return 4;
  if (rssi >= -67) return 3;
  if (rssi >= -80) return 2;
  return 1;
};

/** The canvas's four heights, on one baseline. */
const HEIGHTS = [4, 6.5, 9, 11.5] as const;

export function SignalBars({
  rssi,
  color = colors.textFaint,
  testID,
}: {
  rssi: number;
  /** `currentColor` -- what a FILLED bar takes. */
  color?: string;
  testID?: string;
}) {
  const filled = barsForRssi(rssi);

  return (
    <View
      testID={testID}
      // Decorative: the dBm figure beside it is the announcement, and it is
      // never removed.
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={styles.box}>
      {HEIGHTS.map((height, index) => (
        <View
          key={height}
          testID={`sig-bar-${index}`}
          style={[
            styles.bar,
            {
              height,
              backgroundColor:
                index < filled ? color : colors.hairlineRaised,
            },
          ]}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  box: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 1.5,
    height: 12,
  },
  bar: {width: 2.5, borderRadius: 1.25},
});
