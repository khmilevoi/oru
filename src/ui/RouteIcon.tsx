import React from 'react';
import {StyleSheet, View} from 'react-native';

import {routeReadout} from './theme';
import type {AudioRouteKind} from '../radio/radio.types';

/**
 * The three route glyphs of `design/01 Radio.dc.html`'s `.routeline`.
 *
 * The canvas draws them as inline SVG. React Native ships no SVG renderer and
 * this plan may not add a dependency, so each `<path>` is transcribed to a
 * `View` composition **at the canvas's own viewBox coordinates** -- a 14x14 box
 * with 1.5-wide strokes. Those coordinates are artwork geometry, not design
 * tokens, which is why they are literals here while the box size and the stroke
 * width come from `routeReadout` in `theme.ts`.
 *
 * One knowingly accepted delta: SVG centres a stroke on its path while React
 * Native insets a border. Every ring below is therefore sized to its *outer*
 * edge -- diameter + strokeWidth -- so the drawn shape lands where the canvas
 * puts it. At 14pt the residual difference is sub-pixel.
 *
 * `usb` deliberately falls through to the wired glyph: the canvas says "USB
 * ROUTES RENDER LIKE WIRED".
 */
export function RouteIcon({
  kind,
  color,
}: {
  kind: AudioRouteKind;
  color: string;
}) {
  return (
    <View
      style={styles.box}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants">
      {kind === 'speaker' ? <SpeakerGlyph color={color} /> : null}
      {kind === 'wired' || kind === 'usb' ? (
        <HeadphonesGlyph color={color} />
      ) : null}
      {kind === 'bluetooth' ? <BluetoothGlyph color={color} /> : null}
    </View>
  );
}

/**
 * `M2 5.2h2.6L8.4 2v10L4.6 8.8H2z` -- the filled cone, decomposed into the
 * rectangle 2,5.2..8.4,8.8 plus the two wedges the path's diagonals cut -- and
 * `M10.6 4.6a3.4 3.4 0 0 1 0 4.8`, the shallow arc, drawn as a clipped ring.
 */
function SpeakerGlyph({color}: {color: string}) {
  return (
    <>
      <View
        style={[styles.cone, {backgroundColor: color}]}
        testID="route-icon-speaker"
      />
      <View style={[styles.coneTop, {borderBottomColor: color}]} />
      <View style={[styles.coneBottom, {borderTopColor: color}]} />
      <View style={styles.waveClip}>
        <View style={[styles.wave, {borderColor: color}]} />
      </View>
    </>
  );
}

/**
 * `M2.6 10.5V7a4.4 4.4 0 0 1 8.8 0v3.5` -- the headband, whose arc plus two
 * legs is exactly a box with two rounded top corners and no bottom edge -- plus
 * the two filled earcups.
 */
function HeadphonesGlyph({color}: {color: string}) {
  return (
    <>
      <View
        style={[styles.band, {borderColor: color}]}
        testID="route-icon-headphones"
      />
      <View style={[styles.cupLeft, {backgroundColor: color}]} />
      <View style={[styles.cupRight, {backgroundColor: color}]} />
    </>
  );
}

/**
 * `M3.6 4.4 10.4 9.8 7 12.5 7 1.5 10.4 4.2 3.6 9.6` -- the rune, as its five
 * strokes: the vertical stem, two long diagonals and two short flag edges. Each
 * diagonal is a bar of the segment's own length, centred on the segment's
 * midpoint and rotated to its angle.
 */
function BluetoothGlyph({color}: {color: string}) {
  return (
    <>
      <View
        style={[styles.btStem, {backgroundColor: color}]}
        testID="route-icon-bluetooth"
      />
      <View style={[styles.btLongDown, {backgroundColor: color}]} />
      <View style={[styles.btLongUp, {backgroundColor: color}]} />
      <View style={[styles.btFlagUpper, {backgroundColor: color}]} />
      <View style={[styles.btFlagLower, {backgroundColor: color}]} />
    </>
  );
}

const S = routeReadout.strokeWidth;

/** A stroke of `length`, centred on (`x`, `y`) and rotated by `deg`. */
const bar = (x: number, y: number, length: number, deg: number) =>
  ({
    position: 'absolute',
    left: x - length / 2,
    top: y - S / 2,
    width: length,
    height: S,
    borderRadius: S / 2,
    transform: [{rotate: `${deg}deg`}],
  }) as const;

const styles = StyleSheet.create({
  box: {width: routeReadout.iconSize, height: routeReadout.iconSize},

  // ---- speaker ----
  cone: {position: 'absolute', left: 2, top: 5.2, width: 6.4, height: 3.6},
  coneTop: {
    position: 'absolute',
    left: 4.6,
    top: 2,
    width: 0,
    height: 0,
    borderLeftWidth: 3.8,
    borderLeftColor: 'transparent',
    borderBottomWidth: 3.2,
  },
  coneBottom: {
    position: 'absolute',
    left: 4.6,
    top: 8.8,
    width: 0,
    height: 0,
    borderLeftWidth: 3.8,
    borderLeftColor: 'transparent',
    borderTopWidth: 3.2,
  },
  // The arc's centre is 2.41 to the left of its chord, so the full ring is
  // drawn and clipped down to the 1.6-wide sliver the canvas actually shows.
  waveClip: {
    position: 'absolute',
    left: 10.6,
    top: 4.6,
    width: 1.6,
    height: 4.8,
    overflow: 'hidden',
  },
  wave: {
    position: 'absolute',
    left: -6.56,
    top: -1.75,
    width: 8.3,
    height: 8.3,
    borderRadius: 4.15,
    borderWidth: S,
  },

  // ---- headphones ----
  band: {
    position: 'absolute',
    left: 2.6,
    top: 2.6,
    width: 8.8,
    height: 7.9,
    borderWidth: S,
    borderBottomWidth: 0,
    borderTopLeftRadius: 4.4,
    borderTopRightRadius: 4.4,
  },
  cupLeft: {
    position: 'absolute',
    left: 1.6,
    top: 8.6,
    width: 2.4,
    height: 3.6,
    borderRadius: 1,
  },
  cupRight: {
    position: 'absolute',
    left: 10,
    top: 8.6,
    width: 2.4,
    height: 3.6,
    borderRadius: 1,
  },

  // ---- bluetooth ----
  btStem: {
    position: 'absolute',
    left: 7 - S / 2,
    top: 1.5,
    width: S,
    height: 11,
    borderRadius: S / 2,
  },
  /** (3.6,4.4) -> (10.4,9.8) */
  btLongDown: bar(7, 7.1, 8.68, 38.46),
  /** (10.4,4.2) -> (3.6,9.6) */
  btLongUp: bar(7, 6.9, 8.68, 141.54),
  /** (7,1.5) -> (10.4,4.2) */
  btFlagUpper: bar(8.7, 2.85, 4.34, 38.45),
  /** (10.4,9.8) -> (7,12.5) */
  btFlagLower: bar(8.7, 11.15, 4.34, 141.55),
});
