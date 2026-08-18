import React, {useEffect} from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';
import {Trans, useLingui} from '@lingui/react/macro';
import {reatomComponent} from '@reatom/react';
import {wrap} from '@reatom/core';

import {ActionButton} from '../ui/ActionButton';
import {PulseDot} from '../ui/PulseDot';
import {ScreenFrame} from '../ui/ScreenFrame';
import {colors, radii, spacing, testIds, type} from '../ui/theme';
import {radio} from '../radio/radio.model';
import {
  pairingCandidates,
  pairingError,
  pairingFailureIsScanEmpty,
  pairingStep,
  pickPttCandidate,
  resetPairing,
  startPairing,
} from '../ptt/ptt.pairing.model';

/**
 * Spec section 9.3's learning flow in the four steps section 12.1 designed:
 * scan -> pick -> learn -> saved, plus the empty/retry path the `pairing-empty`
 * scenario drives. Amber is the learning colour (section 12.1).
 */
export const PairingFlow = reatomComponent<{onClose: () => void}>(
  ({onClose}) => {
    const {t} = useLingui();
    const step = pairingStep();
    const candidates = pairingCandidates();
    const buttonName = radio().pttButton.name;
    const failure = pairingError();
    const scanEmpty = pairingFailureIsScanEmpty();

    useEffect(() => {
      void startPairing();
      return () => {
        void resetPairing();
      };
      // Opened once per mount: the flow is a screen, and re-running it on every
      // render would restart the scan under the user's finger.
    }, []);

    const close = wrap(() => {
      void resetPairing();
      onClose();
    });

    return (
      <ScreenFrame
        testID={testIds.pairingScreen}
        title={t`CONNECT A BUTTON`}
        backLabel={t`Cancel`}
        backTestID={testIds.pairingCancel}
        onBack={close}>
        {step === 'scanning' ? (
          <View style={styles.centre}>
            <PulseDot active color={colors.learning} size={12} />
            <Text style={[type.title, styles.headline]}>
              <Trans>Searching for Bluetooth buttons...</Trans>
            </Text>
          </View>
        ) : null}

        {step === 'picking' ? (
          <View style={styles.list}>
            <Text style={[type.label, styles.label]}>
              <Trans>Select your button</Trans>
            </Text>
            {candidates.map(candidate => (
              <Pressable
                key={candidate.deviceId}
                testID={`${testIds.pairingCandidate}-${candidate.deviceId}`}
                accessibilityRole="button"
                accessibilityLabel={candidate.name}
                onPress={wrap(() => {
                  void pickPttCandidate(candidate.deviceId);
                })}
                style={styles.row}>
                <Text style={[type.body, styles.rowName]}>
                  {candidate.name}
                </Text>
                <Text style={[type.caption, styles.rowMeta]}>
                  <Trans>{candidate.rssi} dBm</Trans>
                </Text>
              </Pressable>
            ))}
          </View>
        ) : null}

        {step === 'learning' ? (
          <View style={styles.centre}>
            <PulseDot active color={colors.learning} size={16} />
            <Text style={[type.title, styles.headline, styles.learning]}>
              <Trans>Press the PTT button</Trans>
            </Text>
            <Text style={[type.body, styles.hint]}>
              <Trans>Hold it down until it is recognised</Trans>
            </Text>
          </View>
        ) : null}

        {step === 'saved' ? (
          <View style={styles.centre}>
            <Text style={[type.title, styles.headline, styles.saved]}>
              <Trans>Button saved</Trans>
            </Text>
            <Text style={[type.body, styles.hint]}>
              <Trans>{buttonName} is ready to use</Trans>
            </Text>
            <ActionButton
              label={t`Done`}
              tone="primary"
              onPress={close}
              testID={testIds.pairingDone}
            />
          </View>
        ) : null}

        {step === 'failed' ? (
          <View style={styles.centre}>
            {scanEmpty ? (
              <>
                <Text style={[type.title, styles.headline]}>
                  <Trans>No buttons found</Trans>
                </Text>
                <Text style={[type.body, styles.hint]}>
                  <Trans>
                    Make sure the button is switched on and in pairing mode.
                  </Trans>
                </Text>
              </>
            ) : (
              <>
                <Text style={[type.title, styles.headline]}>
                  <Trans>Pairing failed</Trans>
                </Text>
                {/* The engine's own diagnostic, shown verbatim -- unlocalised,
                    same as `RadioErrorState` in `RadioScreen.tsx`: it is a
                    message from native code, and translating it would be a
                    lie. */}
                {failure ? (
                  <Text style={[type.body, styles.hint]}>{failure.message}</Text>
                ) : null}
              </>
            )}
            <ActionButton
              label={t`Retry`}
              tone="primary"
              onPress={wrap(() => {
                void startPairing();
              })}
              testID={testIds.pairingRetry}
            />
          </View>
        ) : null}
      </ScreenFrame>
    );
  },
  'PairingFlow',
);

const styles = StyleSheet.create({
  centre: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.lg,
  },
  headline: {color: colors.text, textAlign: 'center'},
  hint: {color: colors.textMuted, textAlign: 'center'},
  learning: {color: colors.learning},
  saved: {color: colors.rx},
  label: {color: colors.textMuted},
  list: {gap: spacing.sm},
  row: {
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.hairline,
    padding: spacing.md,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  rowName: {color: colors.text},
  rowMeta: {color: colors.textMuted},
});
