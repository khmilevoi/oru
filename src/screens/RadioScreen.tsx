import React from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';
import {Trans, useLingui} from '@lingui/react/macro';
import {reatomComponent} from '@reatom/react';
import {wrap} from '@reatom/core';

import {ActionButton} from '../ui/ActionButton';
import {GearButton} from '../ui/GearButton';
import {PowerKey} from '../ui/PowerKey';
import {PulseDot} from '../ui/PulseDot';
import {chassis, colors, motion, spacing, testIds, type} from '../ui/theme';
import {lastRadioError, radio, screenState} from '../radio/radio.model';

/**
 * Spec section 13. Selected by `status: 'error'` rather than by `screenState`,
 * which publishes the five states of section 12 and no error among them. The
 * engine's own `message` arrives from native code and is shown verbatim: it is
 * a diagnostic, not app copy, and translating it would be a lie.
 */
const RadioErrorState = reatomComponent(() => {
  const {t} = useLingui();
  const failure = lastRadioError();

  return (
    <View testID={testIds.errorState} style={[chassis.screen, styles.errorWash]}>
      <View style={styles.centre}>
        <Text style={[type.hero, styles.headline, styles.errorText]}>
          <Trans>RADIO ERROR</Trans>
        </Text>
        {failure ? (
          <Text style={[type.body, styles.hint]}>{failure.message}</Text>
        ) : null}
        <ActionButton
          label={t`RESTART RADIO`}
          tone="primary"
          onPress={wrap(() => {
            void radio.start();
          })}
          testID={testIds.errorRestart}
        />
        <ActionButton
          label={t`TURN OFF`}
          onPress={wrap(() => {
            void radio.stop();
          })}
          testID="error-power-off"
        />
      </View>
    </View>
  );
}, 'RadioErrorState');

/**
 * Spec sections 12 and 12.1. The whole screen is one giant PTT touch area with
 * a settings gear in one corner and a first-class radio power toggle in the
 * other -- never a settings item (section 5).
 *
 * It reads the Reatom model and calls its actions, and nothing else: per
 * section 6.4 no screen may reach past the section 6.1 contract.
 */
export const RadioScreen = reatomComponent<{onSettingsPress: () => void}>(
  ({onSettingsPress}) => {
    const {t} = useLingui();

    if (radio().status === 'error') return <RadioErrorState />;

    const state = screenState();

    if (state === 'off') {
      const startRadio = wrap(() => {
        void radio.start();
      });

      return (
        <View testID={testIds.radioScreen} style={chassis.screen}>
          <Pressable
            testID={testIds.powerOnArea}
            accessibilityRole="button"
            accessibilityLabel={t`Turn the radio on`}
            onPress={startRadio}
            style={styles.fill}>
            <View style={styles.centre}>
              <PowerKey
                variant="hero"
                onActivate={startRadio}
                accessibilityLabel={t`Turn the radio on`}
                testID={testIds.powerKey}
              />
              <Text
                testID={testIds.radioStateLabel}
                style={[type.hero, styles.headline, styles.deadAir]}>
                <Trans>RADIO OFF</Trans>
              </Text>
              <Text style={[type.label, styles.hint, styles.deadAir]}>
                <Trans>TAP TO TURN ON</Trans>
              </Text>
            </View>
          </Pressable>
          <View style={styles.gearCorner}>
            <GearButton
              onPress={onSettingsPress}
              accessibilityLabel={t`Settings`}
              testID={testIds.settingsGear}
            />
          </View>
        </View>
      );
    }

    const live = state === 'transmitting' || state === 'receiving';
    const wash =
      state === 'transmitting'
        ? styles.txWash
        : state === 'receiving'
          ? styles.rxWash
          : null;

    return (
      <View testID={testIds.radioScreen} style={[chassis.screen, wash]}>
        <Pressable
          testID={testIds.pttArea}
          accessibilityRole="button"
          accessibilityLabel={t`Push to talk`}
          onPressIn={wrap(() => {
            void radio.pressPtt();
          })}
          onPressOut={wrap(() => {
            void radio.releasePtt();
          })}
          style={styles.fill}>
          <View style={styles.centre}>
            {state === 'searching' ? (
              <>
                <PulseDot active color={colors.textMuted} size={12} />
                <Text
                  testID={testIds.radioStateLabel}
                  style={[type.title, styles.headline]}>
                  <Trans>SEARCHING FOR DEVICES...</Trans>
                </Text>
              </>
            ) : null}

            {state === 'ready' ? (
              <>
                <Text
                  testID={testIds.radioStateLabel}
                  style={[type.hero, styles.headline]}>
                  <Trans>● {radio().nearbyCount} nearby</Trans>
                </Text>
                <Text style={[type.label, styles.hint]}>
                  <Trans>HOLD TO TALK</Trans>
                </Text>
              </>
            ) : null}

            {state === 'transmitting' ? (
              <>
                <Text
                  testID={testIds.radioStateLabel}
                  style={[type.hero, styles.headline, styles.txText]}>
                  <Trans>TRANSMITTING...</Trans>
                </Text>
                <Text style={[type.label, styles.hint, styles.txText]}>
                  <Trans>RELEASE TO FINISH</Trans>
                </Text>
              </>
            ) : null}

            {state === 'receiving' ? (
              <Text
                testID={testIds.radioStateLabel}
                style={[type.hero, styles.headline, styles.rxText]}>
                <Trans>RECEIVING...</Trans>
              </Text>
            ) : null}
          </View>
        </Pressable>

        <View
          testID="corner-controls"
          pointerEvents={live ? 'none' : 'auto'}
          style={[styles.corners, live && styles.receded]}>
          <PowerKey
            variant="corner"
            holdToConfirm
            onActivate={wrap(() => {
              void radio.stop();
            })}
            accessibilityLabel={t`Hold to turn the radio off`}
            testID={testIds.powerKey}
          />
          <GearButton
            onPress={onSettingsPress}
            accessibilityLabel={t`Settings`}
            testID={testIds.settingsGear}
          />
        </View>
      </View>
    );
  },
  'RadioScreen',
);

const styles = StyleSheet.create({
  fill: {flex: 1},
  centre: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.lg,
    padding: spacing.xl,
  },
  headline: {color: colors.text, textAlign: 'center'},
  hint: {color: colors.textMuted, textAlign: 'center'},
  deadAir: {color: colors.off},
  txWash: {backgroundColor: colors.txWash, borderWidth: 10, borderColor: colors.tx},
  rxWash: {backgroundColor: colors.rxWash, borderWidth: 3, borderColor: colors.rx},
  txText: {color: colors.tx},
  rxText: {color: colors.rx},
  errorWash: {borderWidth: 3, borderColor: colors.danger},
  errorText: {color: colors.danger},
  corners: {
    position: 'absolute',
    top: spacing.xxl,
    left: spacing.lg,
    right: spacing.lg,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  receded: {opacity: motion.recededOpacity},
  gearCorner: {position: 'absolute', top: spacing.xxl, right: spacing.lg},
});
