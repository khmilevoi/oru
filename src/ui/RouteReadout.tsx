import React from 'react';
import {StyleSheet, Text, View} from 'react-native';
import {useLingui} from '@lingui/react/macro';

import {RouteIcon} from './RouteIcon';
import {colors, routeReadout, type} from './theme';
import type {AudioRoute} from '../radio/radio.types';

/**
 * The canvas's `.routeline` (`design/01 Radio.dc.html`, frame 08 shows every
 * state): route glyph, then the line -- one uppercase row.
 *
 * THE GENERIC DEVICE WORD IS GONE (2026-08-19). "Speaker" and "Headphones" were
 * saying in one language what the glyph beside them already said in every
 * language at once, so speaker and wired now read as the mode alone and differ
 * by their GLYPH. Only a Bluetooth route still adds text of its own: the headset
 * name exactly as the OS reports it, never translated -- and a headset that
 * reports no name falls back to the mode alone, like every other route.
 *
 * The MODE stays a word, deliberately. "radio" / "music, phone mic" is a policy
 * statement about what the headset is being used for, not a state, and no glyph
 * says it; a speaker-versus-note glyph would read as "output device", which is
 * the exact wrong mental model.
 *
 * `mode` is rendered, never computed -- section 7's policy lives on the
 * platforms. And this is an indicator: the canvas says "INDICATOR ONLY -- NEVER
 * A PICKER, NO TAP TARGET", so nothing here is pressable.
 */
export function RouteReadout({
  route,
  testID,
}: {
  route: AudioRoute;
  testID?: string;
}) {
  const {t} = useLingui();

  const mode = route.mode === 'voice' ? t`radio` : t`music, phone mic`;
  const name = route.kind === 'bluetooth' ? route.label : undefined;

  return (
    <View testID={testID} style={styles.line}>
      <RouteIcon kind={route.kind} color={colors.textFaint} />
      <Text numberOfLines={1} style={styles.label}>
        {name ? `${name} · ${mode}` : mode}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  line: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: routeReadout.gap,
  },
  label: {...type.routeLabel, color: colors.textFaint},
});
