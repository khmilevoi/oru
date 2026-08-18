import React from 'react';
import {StyleSheet, View} from 'react-native';

import {colors, glows, sizes} from './theme';

/** The canvas's `.obmark` glyphs (`design/04 Onboarding.dc.html`). */
export function PermissionMark({
  kind,
}: {
  kind: 'microphone' | 'bluetooth' | 'nearbyDevices' | 'done';
}) {
  return (
    <View testID="permission-mark" style={styles.box}>
      {kind === 'microphone' ? (
        <View style={styles.micColumn}>
          <View style={styles.micCap} />
          <View style={styles.micStem} />
          <View style={styles.micBase} />
        </View>
      ) : null}

      {kind === 'bluetooth' ? <View style={styles.bt} /> : null}

      {kind === 'nearbyDevices' ? (
        <>
          <View style={[styles.circle, styles.circle1]} />
          <View style={[styles.circle, styles.circle2]} />
          <View style={[styles.circle, styles.circle3]} />
          <View style={styles.nearbyDot} />
        </>
      ) : null}

      {kind === 'done' ? (
        <View style={styles.tick}>
          <View style={styles.tickMark} />
        </View>
      ) : null}
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
  micColumn: {alignItems: 'center'},
  micCap: {width: 56, height: 88, borderRadius: 28, borderWidth: 2.5, borderColor: colors.text},
  micStem: {width: 2.5, height: 18, backgroundColor: colors.textFaint},
  micBase: {width: 34, height: 2.5, backgroundColor: colors.textFaint},
  bt: {
    width: 76,
    height: 76,
    borderRadius: 10,
    borderWidth: 2.5,
    borderColor: colors.text,
    transform: [{rotate: '45deg'}],
  },
  circle: {position: 'absolute', borderRadius: sizes.mark / 2, borderWidth: 1.5},
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
  tick: {
    width: sizes.tickLarge,
    height: sizes.tickLarge,
    borderRadius: sizes.tickLarge / 2,
    borderWidth: 2.5,
    borderColor: colors.rx,
    boxShadow: glows.okLarge,
  },
  tickMark: {
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
