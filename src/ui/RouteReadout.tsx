import React from 'react';
import {StyleSheet, Text, View} from 'react-native';
import {useLingui} from '@lingui/react/macro';

import {RouteIcon} from './RouteIcon';
import {colors, routeReadout, type} from './theme';
import type {AudioRoute} from '../radio/radio.types';

/**
 * The canvas's `.routeline` (`design/01 Radio.dc.html`, frame 08 shows every
 * state): route glyph, device, mode -- one uppercase line.
 *
 * The canvas's own note governs the copy: "BLUETOOTH SHOWS THE HEADSET NAME AS
 * REPORTED, OTHER KINDS A GENERIC LABEL · VOICE MODE READS 'RADIO', MEDIA READS
 * 'MUSIC, PHONE MIC'". The line is composed from a device word and a mode word
 * joined by the canvas's own separator rather than translated whole, because
 * the Bluetooth device word is a name that arrives from native. Composing them
 * reproduces all four strings the canvas states, byte for byte.
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

  const device =
    route.kind === 'bluetooth' && route.label
      ? route.label
      : route.kind === 'speaker'
        ? t`Speaker`
        : t`Headphones`;

  const mode = route.mode === 'voice' ? t`radio` : t`music, phone mic`;

  return (
    <View testID={testID} style={styles.line}>
      <RouteIcon kind={route.kind} color={colors.textFaint} />
      <Text numberOfLines={1} style={styles.label}>
        {`${device} · ${mode}`}
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
