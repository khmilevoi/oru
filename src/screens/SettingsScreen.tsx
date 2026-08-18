import React from 'react';
import {StyleSheet, Text, View} from 'react-native';
import {Trans, useLingui} from '@lingui/react/macro';
import {reatomComponent} from '@reatom/react';
import {wrap} from '@reatom/core';

import {ActionButton} from '../ui/ActionButton';
import {ScreenFrame} from '../ui/ScreenFrame';
import {colors, radii, spacing, testIds, type} from '../ui/theme';
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
      <View style={styles.section}>
        <Text style={[type.label, styles.sectionTitle]}>
          <Trans>PTT BUTTON</Trans>
        </Text>

        {button.configured ? (
          <>
            <Text style={[type.title, styles.name]}>{button.name}</Text>
            <Text
              testID={testIds.pttStatus}
              style={[
                type.body,
                button.connected ? styles.connected : styles.disconnected,
              ]}>
              {button.connected ? (
                <Trans>Connected</Trans>
              ) : (
                <Trans>Disconnected</Trans>
              )}
            </Text>
            <View style={styles.actions}>
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
              <ActionButton
                label={t`Replace`}
                onPress={onConnectPress}
                testID={testIds.pttReplace}
              />
            </View>
          </>
        ) : (
          <>
            <Text
              testID={testIds.pttStatus}
              style={[type.body, styles.disconnected]}>
              <Trans>Not connected</Trans>
            </Text>
            <View style={styles.actions}>
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
    </ScreenFrame>
  );
}, 'SettingsScreen');

const styles = StyleSheet.create({
  section: {
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.hairline,
    padding: spacing.lg,
    gap: spacing.sm,
  },
  sectionTitle: {color: colors.textMuted},
  name: {color: colors.text},
  connected: {color: colors.rx},
  disconnected: {color: colors.textMuted},
  actions: {flexDirection: 'row', gap: spacing.md, marginTop: spacing.md},
});
