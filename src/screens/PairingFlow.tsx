import React, {useEffect} from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';
import {Trans, useLingui} from '@lingui/react/macro';
import {reatomComponent} from '@reatom/react';
import {wrap} from '@reatom/core';

import {ActionButton} from '../ui/ActionButton';
import {PingRings} from '../ui/PingRings';
import {PulseDot} from '../ui/PulseDot';
import {ScreenFrame} from '../ui/ScreenFrame';
import {StateRing} from '../ui/StateRing';
import {
  chrome,
  colors,
  glows,
  radii,
  sizes,
  spacing,
  testIds,
  type,
} from '../ui/theme';
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
          <View style={styles.stage}>
            <PingRings size="small" testID="pairing-pings" />
            <Text style={[type.scan, styles.scanText]}>
              <Trans>SCANNING FOR BLE DEVICES...</Trans>
            </Text>
            <Text style={[type.caption, styles.scanHint]}>
              <Trans>
                Make sure the button is turned on and close to the phone.
              </Trans>
            </Text>
          </View>
        ) : null}

        {step === 'picking' ? (
          <View>
            <View style={styles.scanRow}>
              <PulseDot active color={colors.learning} size={8} />
              <Text style={[type.label, styles.scanRowLabel]}>
                <Trans>still scanning</Trans>
              </Text>
            </View>
            <Text style={[type.label, styles.sectionLabel]}>
              <Trans>Found</Trans>
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
                <View>
                  <Text style={[type.devName, styles.rowName]}>
                    {candidate.name}
                  </Text>
                  <Text style={[type.caption, styles.rowMeta]}>
                    <Trans>BLE · {candidate.rssi} dBm</Trans>
                  </Text>
                </View>
                <Text style={styles.chevron}>›</Text>
              </Pressable>
            ))}
          </View>
        ) : null}

        {step === 'learning' ? (
          <View style={styles.stage}>
            <StateRing tone="learning" testID="pairing-ring">
              <Text style={[type.state, styles.learning]}>
                <Trans>PRESS THE PTT BUTTON</Trans>
              </Text>
            </StateRing>
            <Text style={[type.caption, styles.learnSub]}>
              <Trans>Listening for a signal from {buttonName}...</Trans>
            </Text>
          </View>
        ) : null}

        {step === 'saved' ? (
          <View style={styles.stage}>
            <View testID="pairing-tick" style={styles.tick}>
              <View style={styles.tickMark} />
            </View>
            <Text style={[type.state, styles.saved]}>
              <Trans>BUTTON CONNECTED</Trans>
            </Text>
            <View style={styles.bindCard}>
              <View style={styles.bindRow}>
                <Text style={[type.caption, styles.bindKey]}>
                  <Trans>device</Trans>
                </Text>
                <Text style={[type.caption, styles.bindValue]}>{buttonName}</Text>
              </View>
            </View>
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
  // `ScreenFrame`'s body carries no padding of its own any more -- each rebuilt
  // screen states its own gutters -- so the `failed` step, which is the one
  // branch here that was left on its pre-canvas layout, has to state its side
  // inset itself. Without it the retry copy, and the unbounded native
  // `failure.message` diagnostic under it, run edge to edge.
  centre: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.lg,
    paddingHorizontal: spacing.gutter,
  },
  headline: {color: colors.text, textAlign: 'center'},
  hint: {color: colors.textMuted, textAlign: 'center'},
  tick: {
    width: sizes.tick,
    height: sizes.tick,
    borderRadius: sizes.tick / 2,
    borderWidth: 2,
    borderColor: colors.rx,
    boxShadow: glows.ok,
  },
  tickMark: {
    position: 'absolute',
    left: 26,
    top: 30,
    width: 40,
    height: 20,
    borderLeftWidth: 3,
    borderBottomWidth: 3,
    borderColor: colors.rx,
    transform: [{rotate: '-45deg'}],
  },
  stage: {flex: 1, alignItems: 'center', justifyContent: 'center', gap: 30},
  scanText: {color: colors.textMuted, textAlign: 'center'},
  scanHint: {color: colors.textFaint, textAlign: 'center', paddingHorizontal: 40},
  scanRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingTop: 30,
    paddingHorizontal: 28,
  },
  scanRowLabel: {color: colors.textFaint},
  sectionLabel: {...chrome.sectionLabel, color: colors.textFaint},
  row: {
    marginHorizontal: spacing.gutter,
    marginBottom: 12,
    paddingVertical: 20,
    paddingHorizontal: spacing.gutter,
    borderWidth: 1,
    borderColor: colors.hairline,
    borderRadius: radii.row,
    backgroundColor: colors.surface,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  rowName: {color: colors.text},
  rowMeta: {color: colors.textFaint},
  chevron: {fontSize: 20, color: colors.textFaint},
  learning: {color: colors.learning, textAlign: 'center'},
  learnSub: {color: colors.textMuted, textAlign: 'center', maxWidth: 300},
  saved: {color: colors.text, textAlign: 'center'},
  bindCard: {
    width: sizes.ring,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.hairline,
    borderRadius: radii.lg,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.gutter,
  },
  bindRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: spacing.sm,
  },
  bindKey: {color: colors.textFaint},
  bindValue: {color: colors.text},
});
