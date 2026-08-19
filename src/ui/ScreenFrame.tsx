import React from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';

import {chassis, colors, spacing, type} from './theme';

type Edge = 'top' | 'bottom' | 'left' | 'right';

const ALL_EDGES: readonly Edge[] = ['top', 'bottom', 'left', 'right'];

/**
 * The dark panel every non-main screen sits in.
 *
 * The frame owns the safe-area insets. The design canvas renders its own
 * `.sbar` status-bar row as a real flex child at the top of every frame; the
 * app deleted that row, and both platforms lay the root view out edge to edge
 * (Android forces it -- `edgeToEdgeEnabled` plus targetSdk 36 -- and an iOS
 * RN root view is always full-screen), so without these paddings the OS
 * status bar, the cutout and the gesture bar all sit on top of app content.
 * Every hardcoded `paddingTop` inside a screen is a canvas measurement taken
 * *below* `.sbar` and stays as it is; the inset is added ahead of it here.
 */
export function ScreenFrame({
  title,
  onBack,
  backLabel,
  backTestID = 'screen-frame-back',
  testID,
  edges = ALL_EDGES,
  children,
}: {
  title?: string;
  onBack?: () => void;
  backLabel?: string;
  /** Each screen names its own back key, so the acceptance suite can address it. */
  backTestID?: string;
  testID?: string;
  /**
   * Which safe-area edges the frame pads, all four by default. A screen that
   * anchors something absolutely against one edge (the settings version
   * footer) excludes that edge and states the inset itself, so the inset is
   * never applied twice.
   */
  edges?: readonly Edge[];
  children: React.ReactNode;
}) {
  const insets = useSafeAreaInsets();
  const insetPadding = {
    paddingTop: edges.includes('top') ? insets.top : 0,
    paddingBottom: edges.includes('bottom') ? insets.bottom : 0,
    paddingLeft: edges.includes('left') ? insets.left : 0,
    paddingRight: edges.includes('right') ? insets.right : 0,
  };

  return (
    <View testID={testID} style={[chassis.screen, insetPadding]}>
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
