import React from 'react';
import {StyleSheet, Text, View} from 'react-native';
import {Trans, useLingui} from '@lingui/react/macro';
import {reatomComponent} from '@reatom/react';
import {wrap} from '@reatom/core';

import {ActionButton} from '../ui/ActionButton';
import {ScreenFrame} from '../ui/ScreenFrame';
import {SegmentedControl} from '../ui/SegmentedControl';
import {chrome, colors, glows, radii, spacing, testIds, type} from '../ui/theme';
import {radio} from '../radio/radio.model';
import type {AudioMode} from '../radio/radio.types';

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

  const audioModes: ReadonlyArray<{value: AudioMode; label: string}> = [
    {value: 'auto', label: t`Auto`},
    {value: 'voice', label: t`Radio`},
    {value: 'media', label: t`Music`},
  ];

  return (
    <ScreenFrame
      testID={testIds.settingsScreen}
      title={t`Settings`}
      backLabel={t`Back`}
      backTestID={testIds.settingsBack}
      onBack={onBack}>
      <Text style={[type.label, styles.sectionLabel]}>
        <Trans>PTT button</Trans>
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
                    type.devStatus,
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
              style={[type.devNameOff, styles.disconnected]}>
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

      <Text style={[type.label, styles.sectionLabel]}>
        <Trans>Audio</Trans>
      </Text>

      <View style={styles.card}>
        <SegmentedControl
          options={audioModes}
          value={radio().audioMode}
          onChange={wrap((mode: AudioMode) => {
            void radio.setAudioMode(mode);
          })}
          testID={testIds.audioMode}
        />

        <Text style={[type.caption, styles.note]}>
          <Trans>
            What a Bluetooth headset is for. Auto decides by itself: instant
            push-to-talk while nothing else is playing, full music quality when
            something is. Radio and Music pin one behavior.
          </Trans>
        </Text>
      </View>

      <Text testID={testIds.settingsVersion} style={[type.version, styles.version]}>
        OFFLINE NEARBY PTT · V0.1
      </Text>
    </ScreenFrame>
  );
}, 'SettingsScreen');

const styles = StyleSheet.create({
  sectionLabel: {...chrome.sectionLabel, color: colors.textFaint},
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
