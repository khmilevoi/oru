import React from 'react';
import {Pressable, ScrollView, StyleSheet, Text, View} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import type {StyleProp, ViewStyle} from 'react-native';

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
 *
 * The frame also owns *scrolling*, as one opt-in capability rather than five
 * bespoke `ScrollView`s, because the scroll boundary is a property of the
 * chassis and not of any one screen: the header bar and whatever a screen pins
 * at its foot must stay put while only the body between them moves. The canvas
 * was drawn inside a fixed 390x844 `.phone` with `overflow: hidden`, so it can
 * never show what happens when content does not fit -- and the app has no such
 * clip. Content exceeds the viewport for four reasons the canvas never
 * modelled: OS font scaling (nothing here sets `allowFontScaling`, so every
 * `Text` and every explicit `lineHeight` scales without a cap), locales whose
 * longest strings run past the English ones, small devices, and lists whose
 * length comes from the world rather than from the design.
 */
export function ScreenFrame({
  title,
  onBack,
  backLabel,
  backTestID = 'screen-frame-back',
  testID,
  edges = ALL_EDGES,
  scrollable = false,
  scrollTestID = 'screen-frame-scroll',
  scrollContentStyle,
  footer,
  overlay,
  children,
}: {
  title?: string;
  onBack?: () => void;
  backLabel?: string;
  /** Each screen names its own back key, so the acceptance suite can address it. */
  backTestID?: string;
  testID?: string;
  /**
   * Which safe-area edges the frame pads, all four by default -- which is what
   * every screen currently takes. The escape hatch is for a screen that anchors
   * something absolutely against one edge and adds that inset to its own offset:
   * it excludes the edge here so the inset is never applied twice.
   */
  edges?: readonly Edge[];
  /**
   * Turns the body into a `ScrollView`. Off by default, and deliberately not
   * on for `RadioScreen`, which does not use this frame at all: the main screen
   * is one full-bleed `Pressable` PTT target, and a scroll responder would
   * claim a hold with any finger movement as a scroll gesture and cancel the
   * press -- scrolling there would break push-to-talk itself.
   */
  scrollable?: boolean;
  scrollTestID?: string;
  /** Merged onto the content container, after the frame's own defaults. */
  scrollContentStyle?: StyleProp<ViewStyle>;
  /**
   * Chrome pinned below the scrolling body, in flow: the action buttons a
   * screen must keep reachable. A button that scrolls out of reach is the bug
   * being fixed, not a fix, so this never enters the scroll container.
   */
  footer?: React.ReactNode;
  /**
   * Chrome pinned *over* the frame, absolutely positioned and contributing no
   * flow height -- the pairing scan hint, which the canvas draws against the
   * frame's foot rather than as a row of the stage. Rendered last so it paints
   * above the body. A screen passing this owes its scroll content enough bottom
   * padding to keep the last row from sliding underneath it.
   *
   * Reach for it only when the canvas really does anchor something to the frame.
   * The settings version nameplate was built this way and read as hovering over
   * the list; it is an ordinary last element of the content now.
   */
  overlay?: React.ReactNode;
  children: React.ReactNode;
}) {
  const insets = useSafeAreaInsets();
  const bottomInset = edges.includes('bottom') ? insets.bottom : 0;

  /**
   * Where the bottom inset goes, and the one decision a `ScrollView` changes.
   *
   * Spent as padding on the frame, a bottom inset shortens the scroll viewport:
   * the list stops short of the gesture bar and the last row is cut off at that
   * line instead of scrolling clear of it. Spent on the content container it
   * insets the content instead of clipping it, which is what an inset means.
   *
   * So the inset follows whatever is actually against the frame's bottom edge.
   * With something pinned there it stays on the frame, which is what lifts that
   * pinned block off the gesture bar; with the scroll container itself as the
   * last child in flow, it moves to the content. `overlay` counts as pinned
   * even though it takes no flow height: it measures its own `bottom` against
   * the frame, so the frame's padding box has to be the safe area.
   */
  const scrollOwnsBottomInset =
    scrollable && footer === undefined && overlay === undefined;

  const insetPadding = {
    paddingTop: edges.includes('top') ? insets.top : 0,
    paddingBottom: scrollOwnsBottomInset ? 0 : bottomInset,
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
      {scrollable ? (
        <ScrollView
          testID={scrollTestID}
          style={styles.body}
          contentContainerStyle={[
            // `flexGrow` and not `flex`: several screens centre their stage
            // with a `flexGrow: 1` spacer, and the content container has to be
            // at least a viewport tall for that to have anything to grow into.
            // Without it a short screen collapses to its content height and
            // every centred composition the canvas drew slides to the top.
            styles.scrollContent,
            scrollOwnsBottomInset ? {paddingBottom: bottomInset} : null,
            scrollContentStyle,
          ]}
          // Kept on. The indicator is the only affordance that says there is
          // more below, and these screens overflow only in the degraded cases
          // -- long locale, large system font, small device -- where the user
          // has no other way to know. It shows while scrolling and is invisible
          // at rest, so the engraved panel is undisturbed the rest of the time.
          showsVerticalScrollIndicator
          // No rubber band on a screen that fits. The chassis reads as a solid
          // machined panel; bouncing it when there is nothing to scroll makes
          // it feel like a web page. iOS still bounces once content overflows,
          // which is then honest feedback that the list has ended.
          alwaysBounceVertical={false}
          // The frame states every inset itself, above. Letting iOS add its own
          // automatic content inset on top would double the top one.
          contentInsetAdjustmentBehavior="never">
          {children}
        </ScrollView>
      ) : (
        <View style={styles.body}>{children}</View>
      )}
      {footer}
      {overlay}
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
  scrollContent: {flexGrow: 1},
});
