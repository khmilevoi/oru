import React from 'react';
import {StyleSheet, Text, View} from 'react-native';
import {Trans, useLingui} from '@lingui/react/macro';
import {reatomComponent} from '@reatom/react';
import {wrap} from '@reatom/core';

import {ActionButton} from '../ui/ActionButton';
import {ScreenFrame} from '../ui/ScreenFrame';
import {colors, glows, radii, spacing, testIds, type} from '../ui/theme';
import {radio} from '../radio/radio.model';

/**
 * Spec section 12: a single "PTT button" section, configured or not.
 *
 * A disconnected but configured button is *state*, not an error (section 13) --
 * the engine retries natively and the screen simply says so.
 */
export const SettingsScreen = reatomComponent<{
  onBack: () => void;
  onConnectPress: () => void;
}>(({onBack, onConnectPress}) => {
  const {t} = useLingui();
  const button = radio().pttButton;

  return (
    <ScreenFrame
      testID={testIds.settingsScreen}
      title={t`SETTINGS`}
      backLabel={t`Back`}
      backTestID={testIds.settingsBack}
      onBack={onBack}>
      <Text style={[type.label, styles.sectionLabel]}>
        <Trans>PTT BUTTON</Trans>
      </Text>

      <View testID="settings-card" style={styles.card}>
        {button.configured ? (
          <>
            <View style={styles.deviceRow}>
              <View style={styles.dot} />
              <View style={styles.deviceText}>
                <Text style={[type.devName, styles.name]}>{button.name}</Text>
                <Text
                  testID={testIds.pttStatus}
                  style={[
                    type.caption,
                    button.connected ? styles.connected : styles.disconnected,
                  ]}>
                  {button.connected ? (
                    <Trans>Connected</Trans>
                  ) : (
                    <Trans>Disconnected</Trans>
                  )}
                </Text>
              </View>
            </View>
            <View style={styles.actions}>
              <View style={styles.action}>
                <ActionButton
                  label={t`Test`}
                  accessibilityLabel={t`Hold to transmit`}
                  onPressIn={wrap(() => {
                    void radio.pressPtt();
                  })}
                  onPressOut={wrap(() => {
                    void radio.releasePtt();
                  })}
                  testID={testIds.pttTest}
                />
              </View>
              <View style={styles.action}>
                <ActionButton
                  label={t`Replace`}
                  onPress={onConnectPress}
                  testID={testIds.pttReplace}
                />
              </View>
            </View>
          </>
        ) : (
          <>
            <Text
              testID={testIds.pttStatus}
              style={[type.devName, styles.disconnected]}>
              <Trans>Not connected</Trans>
            </Text>
            <Text style={[type.caption, styles.note]}>
              <Trans>
                An external button lets you talk without taking the phone out of
                your pocket.
              </Trans>
            </Text>
            <View style={styles.connect}>
              <ActionButton
                label={t`Connect`}
                tone="primary"
                onPress={onConnectPress}
                testID={testIds.pttConnect}
              />
            </View>
          </>
        )}
      </View>

      <Text testID={testIds.settingsVersion} style={[type.version, styles.version]}>
        OFFLINE NEARBY PTT · V0.1
      </Text>
    </ScreenFrame>
  );
}, 'SettingsScreen');

const styles = StyleSheet.create({
  sectionLabel: {
    paddingTop: 34,
    paddingHorizontal: 28,
    paddingBottom: 12,
    color: colors.textFaint,
  },
  card: {
    marginHorizontal: spacing.gutter,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.hairline,
    borderRadius: radii.lg,
    paddingVertical: spacing.lg,
    paddingHorizontal: spacing.gutter,
  },
  deviceRow: {flexDirection: 'row', alignItems: 'flex-start', gap: 14},
  dot: {
    width: 9,
    height: 9,
    borderRadius: 4.5,
    marginTop: spacing.sm,
    backgroundColor: colors.rx,
    boxShadow: glows.peer,
  },
  deviceText: {flex: 1},
  name: {color: colors.text},
  connected: {color: colors.rx, marginTop: 5},
  disconnected: {color: colors.textMuted, marginTop: 5},
  note: {marginTop: spacing.md, color: colors.textFaint},
  actions: {flexDirection: 'row', gap: 12, marginTop: spacing.gutter},
  action: {flex: 1},
  connect: {marginTop: spacing.gutter},
  version: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: spacing.lg,
    textAlign: 'center',
    color: colors.textGhost,
  },
});
