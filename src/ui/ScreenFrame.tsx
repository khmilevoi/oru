import React from 'react';
import {StyleSheet, Text, View} from 'react-native';

import {ActionButton} from './ActionButton';
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
          {title === undefined ? null : (
            <Text style={[type.label, styles.title]}>{title}</Text>
          )}
          {onBack === undefined || backLabel === undefined ? null : (
            <ActionButton
              label={backLabel}
              onPress={onBack}
              testID={backTestID}
            />
          )}
        </View>
      )}
      <View style={styles.body}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.xxl,
    paddingBottom: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.hairline,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  title: {color: colors.textMuted},
  body: {flex: 1, padding: spacing.lg},
});
