import React from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';

import {chassis, colors, spacing, type} from './theme';

/** The dark panel every non-main screen sits in. */
export function ScreenFrame({
  title,
  onBack,
  backLabel,
  backTestID = 'screen-frame-back',
  testID,
  children,
}: {
  title?: string;
  onBack?: () => void;
  backLabel?: string;
  /** Each screen names its own back key, so the acceptance suite can address it. */
  backTestID?: string;
  testID?: string;
  children: React.ReactNode;
}) {
  return (
    <View testID={testID} style={chassis.screen}>
      {title === undefined && onBack === undefined ? null : (
        <View style={styles.bar}>
          {onBack === undefined || backLabel === undefined ? null : (
            <Pressable
              testID={backTestID}
              accessibilityRole="button"
              accessibilityLabel={backLabel}
              onPress={onBack}
              hitSlop={12}
              style={styles.back}>
              <Text style={styles.backGlyph}>←</Text>
            </Pressable>
          )}
          {title === undefined ? null : (
            <Text style={[type.title, styles.title]}>{title}</Text>
          )}
        </View>
      )}
      <View style={styles.body}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    paddingHorizontal: 26,
    paddingTop: spacing.gutter,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  back: {width: 32},
  backGlyph: {fontSize: 22, color: colors.textMuted},
  title: {color: colors.text},
  body: {flex: 1},
});
