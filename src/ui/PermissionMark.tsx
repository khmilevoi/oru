import React from 'react';
import {StyleSheet, View} from 'react-native';

import {MicMark} from './MicMark';
import {SuccessMark} from './SuccessMark';
import {colors, glows, icon, sizes} from './theme';

/**
 * The canvas's `.obmark` glyphs (`design/04 Onboarding.dc.html`) -- one page
 * mark per onboarding step, 176 box at the page-mark idiom.
 *
 * Two of the four are no longer drawn here. The microphone is `MicMark`, the
 * SAME component the talk ring carries, at the page-mark idiom instead of the
 * control idiom: the canvas moved that glyph into `design/theme.css` on
 * 2026-08-19 precisely so the product has one microphone form. What it replaced
 * was a two-tone capsule with a `--faint` stem and base and no cradle at all --
 * a second, differently drawn microphone, and one that broke the system's rule
 * that a glyph carries exactly one colour token. And `done` is `SuccessMark`,
 * the shared `.okbig` the pairing flow's saved step now ends on too.
 *
 * The whole mark is decorative: `.obmark` is `aria-hidden` on the canvas, and
 * the step's own title and body carry the words.
 */
export function PermissionMark({
  kind,
}: {
  kind: 'microphone' | 'bluetooth' | 'nearbyDevices' | 'done';
}) {
  return (
    <View
      testID="permission-mark"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={styles.box}>
      {kind === 'microphone' ? <MicMark idiom="pagemark" /> : null}

      {kind === 'bluetooth' ? <View style={styles.bt} /> : null}

      {kind === 'nearbyDevices' ? (
        <>
          <View style={[styles.circle, styles.circle1]} />
          <View style={[styles.circle, styles.circle2]} />
          <View style={[styles.circle, styles.circle3]} />
          <View style={styles.nearbyDot} />
        </>
      ) : null}

      {kind === 'done' ? <SuccessMark /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  box: {
    width: sizes.mark,
    height: sizes.mark,
    alignItems: 'center',
    justifyContent: 'center',
  },
  /** `.mkbt` -- a rounded square on its corner. */
  bt: {
    width: 76,
    height: 76,
    borderRadius: 10,
    borderWidth: icon.heroStroke,
    borderColor: colors.text,
    transform: [{rotate: '45deg'}],
  },
  /** `.nc` -- the three rings, each at the inline stroke. */
  circle: {
    position: 'absolute',
    borderRadius: sizes.mark / 2,
    borderWidth: icon.smallStroke,
  },
  circle1: {top: 0, left: 0, right: 0, bottom: 0, borderColor: colors.hairlineRaised},
  circle2: {top: 30, left: 30, right: 30, bottom: 30, borderColor: colors.textFaint},
  circle3: {top: 60, left: 60, right: 60, bottom: 60, borderColor: colors.textMuted},
  nearbyDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: colors.rx,
    boxShadow: glows.peer,
  },
});
