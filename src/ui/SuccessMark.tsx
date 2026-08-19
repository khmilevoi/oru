import React from 'react';
import {StyleSheet, View} from 'react-native';

import {colors, glows, icon, sizes} from './theme';

/**
 * `design/theme.css`'s `.okbig` -- THE one success glyph in the product.
 *
 * A 132 circle at the page-mark stroke, and inside it a tick drawn the way this
 * codebase draws every check: a 56 x 28 box wearing only a left and a bottom
 * border, rotated -45deg. No path, no SVG, no icon font.
 *
 * It is shared deliberately. `04 Onboarding`'s done frame and `03 Pairing`'s
 * saved step used to draw two different tick marks at two different sizes (132
 * and a 96 `.oktick`), and the pairing one sat under a "BUTTON CONNECTED"
 * headline that restated it in words. On 2026-08-19 the canvas moved this class
 * into the shared theme, deleted `.oktick` and deleted the headline: the mark is
 * the whole statement wherever it appears, and the words moved into the
 * announcement.
 */
export function SuccessMark({
  accessibilityLabel,
  testID,
}: {
  /**
   * The headline this mark replaced, where one was deleted and no control
   * around it carries the word (the pairing saved step). Given one, the mark
   * becomes the announcement; given none, it is decorative -- onboarding's done
   * frame keeps its own visible "All set" title, so a name here would only make
   * a reader say it twice.
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
      style={styles.ring}>
      <View testID="ok-tick" style={styles.tick} />
    </View>
  );
}

const styles = StyleSheet.create({
  ring: {
    width: sizes.tickLarge,
    height: sizes.tickLarge,
    borderRadius: sizes.tickLarge / 2,
    borderWidth: icon.heroStroke,
    borderColor: colors.rx,
    boxShadow: glows.okLarge,
  },
  /** The two-border-plus-rotate trick, at the canvas's own coordinates. */
  tick: {
    position: 'absolute',
    left: 34,
    top: 40,
    width: 56,
    height: 28,
    borderLeftWidth: 3.5,
    borderBottomWidth: 3.5,
    borderColor: colors.rx,
    transform: [{rotate: '-45deg'}],
  },
});
