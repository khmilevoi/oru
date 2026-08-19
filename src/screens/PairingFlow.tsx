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
  scanHintInset,
  sizes,
  spacing,
  stage,
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
 * The canvas prints RSSI with a true minus -- `BLE · −52 dBm`, U+2212 -- where
 * a bare number renders the ASCII hyphen (design/03 Pairing.dc.html).
 */
const signedRssi = (rssi: number) => String(rssi).replace('-', '−');

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

    /**
     * `.pfoot` -- the learn and saved steps' single key -- lifted out of the
     * body and handed to the frame so it stays pinned while the stage above it
     * scrolls. Nothing else in the flow pins anything at its foot: the picking
     * step's list and the failed step's native diagnostic both run to the
     * frame's bottom edge and scroll clear of it.
     */
    const footer =
      step === 'learning' ? (
        <View testID="pairing-foot" style={styles.foot}>
          <ActionButton
            label={t`Cancel`}
            onPress={close}
            testID={testIds.pairingCancelFooter}
          />
        </View>
      ) : step === 'saved' ? (
        <View testID="pairing-foot" style={styles.foot}>
          <ActionButton
            label={t`Done`}
            tone="primary"
            onPress={close}
            testID={testIds.pairingDone}
          />
        </View>
      ) : undefined;

    return (
      <ScreenFrame
        testID={testIds.pairingScreen}
        title={t`Connect PTT button`}
        backLabel={t`Cancel`}
        backTestID={testIds.pairingCancel}
        // The picking step renders one row per BLE device in range -- a list
        // whose length comes from the room, not from the design -- and the
        // failed step renders the engine's own diagnostic, an unbounded string
        // from native code. Both would run off the bottom of a fixed frame.
        scrollable
        scrollTestID="pairing-scroll"
        footer={footer}
        overlay={
          step === 'scanning' ? (
            // `.scanhint` is pinned to the foot of the frame, not a third row
            // of the stage (design/03 Pairing.dc.html) -- so it stays outside
            // the scroll container, where its `bottom` still measures against
            // the frame's safe area rather than against the scrolled content.
            <Text
              testID="pairing-scan-hint"
              style={[type.caption, styles.scanHint]}>
              <Trans>
                Make sure the button is turned on and close to the phone.
              </Trans>
            </Text>
          ) : undefined
        }
        onBack={close}>
        {step === 'scanning' ? (
          <View style={styles.stage}>
            <PingRings size="small" testID="pairing-pings" />
            <Text style={[type.scanPairing, styles.scanText]}>
              <Trans>SCANNING FOR BLE DEVICES...</Trans>
            </Text>
          </View>
        ) : null}

        {step === 'picking' ? (
          <View>
            <View style={styles.scanRow}>
              <PulseDot active color={colors.learning} size={8} />
              <Text style={[type.scanRow, styles.scanRowLabel]}>
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
                    <Trans>BLE · {signedRssi(candidate.rssi)} dBm</Trans>
                  </Text>
                </View>
                <Text style={styles.chevron}>›</Text>
              </Pressable>
            ))}
          </View>
        ) : null}

        {/* The `.pfoot` ghost Cancel of design/03 Pairing.dc.html frame 03,
            over and above the header chevron -- both wire the same close --
            is the frame's pinned `footer` above. */}
        {step === 'learning' ? (
          <View style={[styles.stage, styles.stagePair]}>
            <StateRing tone="learning" testID="pairing-ring">
              <Text style={[type.stateSmall, styles.learning]}>
                <Trans>PRESS THE PTT BUTTON</Trans>
              </Text>
            </StateRing>
            <Text style={[type.learnSub, styles.learnSub]}>
              {/* The name is quoted -- curly in en, guillemets in ru -- and
                  the quotes live in the catalogs: they are locale copy, not
                  layout (design/03 Pairing.dc.html). */}
              <Trans>Listening for a signal from “{buttonName}”...</Trans>
            </Text>
          </View>
        ) : null}

        {/* Done sits in the `.pfoot`, not the centred stage
            (design/03 Pairing.dc.html frame 04) -- the frame's `footer`. */}
        {step === 'saved' ? (
          <View style={[styles.stage, styles.stagePair]}>
            <View testID="pairing-tick" style={styles.tick}>
              <View style={styles.tickMark} />
            </View>
            <Text style={[type.stateSmall, styles.saved]}>
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
    // `flexGrow`, not `flex: 1`: inside the scroll content container `flex: 1`
    // means `flexBasis: 0` plus `flexShrink: 1`, which collapses this column to
    // nothing as soon as the unbounded `failure.message` below makes it taller
    // than the frame. `flexGrow: 1` still absorbs the slack and centres the
    // composition when the copy fits, and simply keeps its natural height and
    // scrolls when it does not.
    flexGrow: 1,
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
  stage: {
    /** `flexGrow`, not `flex: 1` -- same reason as `centre` above. */
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: stage.gap,
    paddingBottom: stage.paddingBottom,
  },
  /** `.stage.pair` -- the learn/saved steps close the column down to 30. */
  stagePair: {gap: stage.pairGap},
  /** `.pfoot`. */
  foot: {...chrome.pairingFooter},
  scanText: {color: colors.textMuted, textAlign: 'center'},
  /** `.scanhint`. */
  scanHint: {
    position: 'absolute',
    left: scanHintInset.side,
    right: scanHintInset.side,
    bottom: scanHintInset.bottom,
    color: colors.textFaint,
    textAlign: 'center',
  },
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
