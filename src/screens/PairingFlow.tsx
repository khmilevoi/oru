import React, {useEffect} from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';
import {Trans, useLingui} from '@lingui/react/macro';
import {reatomComponent} from '@reatom/react';
import {wrap} from '@reatom/core';

import {ActionButton} from '../ui/ActionButton';
import {PingRings} from '../ui/PingRings';
import {PulseDot} from '../ui/PulseDot';
import {ScreenFrame} from '../ui/ScreenFrame';
import {SignalBars} from '../ui/SignalBars';
import {StateRing} from '../ui/StateRing';
import {SuccessMark} from '../ui/SuccessMark';
import {
  chrome,
  colors,
  icon,
  radii,
  scanHintInset,
  sizes,
  spacing,
  stage,
  testIds,
  type,
} from '../ui/theme';
import {haptics} from '../app/haptics';
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

    /**
     * The one haptic in this flow, and the one here that answers a wait rather
     * than a press: the user has been holding a button in front of a scanning
     * phone and is waiting to be told it took. Keyed on the step so it fires
     * on the *transition* into `saved` and not on every later render of it;
     * `Cancel`, `Retry`, `Done` and the candidate rows stay silent, per the
     * policy in `src/app/haptics.ts`.
     */
    useEffect(() => {
      if (step === 'saved') haptics.paired();
    }, [step]);

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
            {/*
              `.slabel.scanning` -- the "still scanning" ROW is gone
              (2026-08-19) and its pulsing amber dot moved onto the "Found"
              section label, where it has something to anchor to and means
              "this list is still filling". A whole row of chrome deleted, and
              the dot stops floating on its own. The words moved onto the dot's
              accessible name; amber because this screen already spends amber
              on "armed, finish the action".
            */}
            <View style={styles.foundLabel}>
              <PulseDot
                active
                color={colors.learning}
                size={8}
                accessibilityLabel={t`Still scanning`}
              />
              <Text style={[type.label, styles.sectionLabelText]}>
                <Trans>Found</Trans>
              </Text>
            </View>
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
                  {/*
                    `BLE ·` became four signal bars (2026-08-19) and the dBm
                    figure stayed. This is the ONE case where a deleted word
                    needs no new home: it was constant on every row and the
                    screen already says it once ("SCANNING FOR BLE DEVICES..."),
                    so it was never carrying anything a reader would miss. The
                    reading is a different matter -- four bars cannot separate
                    two similarly named buttons on the same shelf, so the number
                    is kept beside the glyph.
                  */}
                  <View style={styles.rowMetaLine}>
                    <SignalBars rssi={candidate.rssi} color={colors.textFaint} />
                    <Text style={[type.caption, styles.rowMeta]}>
                      <Trans>{signedRssi(candidate.rssi)} dBm</Trans>
                    </Text>
                  </View>
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
            {/*
              The "BUTTON CONNECTED" headline is gone (2026-08-19) and the 96
              `.oktick` under it grew to the shared 132 `.okbig` -- so both
              success moments in the product are now the same mark. A green tick
              with the words restated directly beneath it said the same thing
              twice; the mark is the whole statement, and the words moved to its
              accessible name, which is where they were doing real work all
              along. Nothing else on this step names it, so this one is not
              optional.
            */}
            <SuccessMark
              accessibilityLabel={t`Button connected`}
              testID="pairing-tick"
            />
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
  /*
    The 96 `.oktick` and its mark are gone (2026-08-19). This step draws the
    shared 132 `.okbig` through `SuccessMark` -- the same glyph the onboarding
    done frame ends on, so the product has one success mark, not two.
  */
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
  /**
   * `.slabel.scanning` -- the section label wearing the scanning dot. It keeps
   * `.slabel`'s own padding and only turns into a row, so deleting the separate
   * "still scanning" line above it cost the list no vertical rhythm.
   */
  foundLabel: {
    ...chrome.sectionLabel,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  sectionLabelText: {color: colors.textFaint},
  /** `.devmeta` -- the bars sit inline with the reading they qualify. */
  rowMetaLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: icon.smallGap,
    marginTop: 5,
  },
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
