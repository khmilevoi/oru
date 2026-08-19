import React from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';
import {Trans, useLingui} from '@lingui/react/macro';
import {reatomComponent} from '@reatom/react';
import {wrap} from '@reatom/core';
import {useSafeAreaInsets} from 'react-native-safe-area-context';

import {ActionButton} from '../ui/ActionButton';
import {GearButton} from '../ui/GearButton';
import {LevelBars} from '../ui/LevelBars';
import {PeerRow} from '../ui/PeerRow';
import {PingRings} from '../ui/PingRings';
import {PowerKey} from '../ui/PowerKey';
import {RouteReadout} from '../ui/RouteReadout';
import {StateRing} from '../ui/StateRing';
import {
  chassis,
  colors,
  motion,
  routeReadout,
  spacing,
  testIds,
  type,
  washes,
} from '../ui/theme';
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
  // Its own call, not a prop from `RadioScreen`: this component is a screen
  // in its own right (it replaces the whole chassis), so it reads its own
  // insets the same way the off and live chassis do.
  const insets = useSafeAreaInsets();

  return (
    <View
      testID={testIds.errorState}
      style={[chassis.screen, styles.errorWash, {paddingTop: insets.top}]}>
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
    const {i18n, t} = useLingui();
    // Unconditional, ahead of the `status === 'error'` early return below,
    // rather than between it and `state === 'off'` as the plan's own code
    // block shows it: this component transitions in and out of `error`
    // without unmounting (see the engine-error scenario), and a Hook placed
    // after a conditional return is only called on some of that one
    // instance's renders. `useSafeAreaInsets` happens to be a thin wrapper
    // around `useContext`, which React doesn't track on the per-render Hook
    // list the way `useState`/`useEffect` are, so this specific placement
    // was verified not to throw either way -- but nothing here should depend
    // on that implementation detail of one specific Hook.
    // (`RadioErrorState` reads its own insets, so nothing computed here has
    // to survive into the error branch.)
    const insets = useSafeAreaInsets();
    // The off and live chassis are edge-to-edge on both platforms; the OS
    // status bar and any cutout sit inside `insets.top`, and `PeerRow` at the
    // top of the screen has no padding of its own to hide behind.
    const topStyle = {paddingTop: insets.top};
    const cornerStyle = {
      bottom: insets.bottom + spacing.gutter,
      left: spacing.gutter,
      right: spacing.gutter,
    };
    // `styles.route` mirrors `cornerStyle`'s own safe-area treatment: the
    // canvas states 44 and 22 in the same frame, so a flat `bottomInset`
    // would put the readout below the corner controls' own baseline on any
    // device with a bottom inset, contradicting the canvas note "BOTTOM
    // CENTRE BETWEEN GEAR AND POWER".
    const routeStyle = {bottom: insets.bottom + routeReadout.bottomInset};

    if (radio().status === 'error') return <RadioErrorState />;

    const state = screenState();

    if (state === 'off') {
      const startRadio = wrap(() => {
        void radio.start();
      });

      return (
        <View
          testID={testIds.radioScreen}
          style={[chassis.screen, styles.offChassis, topStyle]}>
          <Pressable
            testID={testIds.powerOnArea}
            accessibilityRole="button"
            accessibilityLabel={t`Turn the radio on`}
            onPress={startRadio}
            style={styles.fill}>
            <PeerRow />
            <View style={styles.stage}>
              <PowerKey
                variant="hero"
                notchColor={colors.backgroundOff}
                onActivate={startRadio}
                accessibilityLabel={t`Turn the radio on`}
                testID={testIds.powerKey}
              />
              <View style={styles.offCopy}>
                <Text
                  testID={testIds.radioStateLabel}
                  style={[type.state, styles.headline, styles.deadAir]}>
                  <Trans>RADIO OFF</Trans>
                </Text>
                <Text style={[type.subhint, styles.hint]}>
                  <Trans>TAP TO TURN ON</Trans>
                </Text>
              </View>
            </View>
          </Pressable>
          <View style={[styles.gearOnly, cornerStyle]}>
            {/* Same darker chassis the hero `PowerKey` beside it is told about:
                the two corner controls have to agree on what they sit on. */}
            <GearButton
              notchColor={colors.backgroundOff}
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
      <View testID={testIds.radioScreen} style={[chassis.screen, wash, topStyle]}>
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
          <PeerRow
            testID={state === 'searching' ? undefined : 'radio-peer'}
            label={
              state === 'searching' ? undefined : (
                <Trans>{radio().nearbyCount} nearby</Trans>
              )
            }
          />

          <View style={styles.stage}>
            {state === 'searching' ? (
              <>
                <PingRings testID="radio-pings" />
                <Text
                  testID={testIds.radioStateLabel}
                  style={[type.scan, styles.hint]}>
                  <Trans>SEARCHING FOR DEVICES...</Trans>
                </Text>
              </>
            ) : null}

            {state === 'ready' ? (
              <StateRing tone="idle" testID="radio-ring">
                {/*
                  The canvas sets this headline in `.holden` (40pt) for `en` and
                  drops to `.holdword` (33pt) for `ru`, whose translation of
                  "HOLD TO TALK" is far longer than the 302pt ring it sits in
                  (`design/01 Radio.dc.html:195-224`). Every non-`en` locale
                  takes the tighter face for the same reason.
                */}
                <Text
                  testID={testIds.radioStateLabel}
                  style={[
                    i18n.locale === 'en' ? type.hero : type.heroTight,
                    styles.headline,
                  ]}>
                  <Trans>HOLD TO TALK</Trans>
                </Text>
              </StateRing>
            ) : null}

            {state === 'transmitting' ? (
              <>
                <StateRing tone="tx" testID="radio-ring">
                  <Text
                    testID={testIds.radioStateLabel}
                    style={[type.state, styles.onTx]}>
                    <Trans>TRANSMITTING...</Trans>
                  </Text>
                  <LevelBars color={colors.text} testID="radio-bars" />
                </StateRing>
                <Text style={[type.subhint, styles.txHint]}>
                  <Trans>RELEASE TO FINISH</Trans>
                </Text>
              </>
            ) : null}

            {state === 'receiving' ? (
              <StateRing tone="rx" testID="radio-ring">
                <Text
                  testID={testIds.radioStateLabel}
                  style={[type.state, styles.rxText]}>
                  <Trans>RECEIVING...</Trans>
                </Text>
                <LevelBars color={colors.rx} testID="radio-bars" />
              </StateRing>
            ) : null}
          </View>
        </Pressable>

        <View
          testID="corner-controls"
          pointerEvents={live ? 'none' : 'auto'}
          style={[styles.corners, cornerStyle, live && styles.receded]}>
          <GearButton
            onPress={onSettingsPress}
            accessibilityLabel={t`Settings`}
            testID={testIds.settingsGear}
          />
          <PowerKey
            variant="corner"
            holdToConfirm
            onActivate={wrap(() => {
              void radio.stop();
            })}
            accessibilityLabel={t`Hold to turn the radio off`}
            testID={testIds.powerKey}
          />
        </View>

        <View style={[styles.route, routeStyle]} pointerEvents="none">
          <RouteReadout route={radio().audioRoute} testID={testIds.audioRoute} />
        </View>
      </View>
    );
  },
  'RadioScreen',
);

const styles = StyleSheet.create({
  fill: {flex: 1},
  offChassis: {backgroundColor: colors.backgroundOff},
  stage: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xl,
    paddingBottom: spacing.xl,
  },
  offCopy: {alignItems: 'center', gap: spacing.md},
  headline: {color: colors.text, textAlign: 'center'},
  hint: {color: colors.textFaint, textAlign: 'center'},
  deadAir: {color: colors.deadAir},
  txWash: {backgroundImage: washes.tx},
  rxWash: {backgroundImage: washes.rx},
  onTx: {color: '#ffffff', textAlign: 'center'},
  txHint: {color: colors.txHint, textAlign: 'center'},
  rxText: {color: colors.rx, textAlign: 'center'},
  errorWash: {borderWidth: 3, borderColor: colors.danger},
  errorText: {color: colors.danger},
  corners: {
    position: 'absolute',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  gearOnly: {position: 'absolute', alignItems: 'flex-start'},
  receded: {opacity: motion.recededOpacity},
  /**
   * `.route` in `design/01 Radio.dc.html`: bottom centre, clear of the gear
   * and the power key. Deliberately a sibling of `styles.corners` rather
   * than a child -- the corners recede while transmitting or receiving and
   * the canvas says the readout "STAYS PUT ... IT NAMES THE LIVE MIC".
   * `pointerEvents` is off because the whole screen underneath is the PTT
   * touch area and the canvas says "INDICATOR ONLY -- NEVER A PICKER, NO TAP
   * TARGET". `bottom` itself is supplied inline as `routeStyle`, the same
   * way `cornerStyle` supplies its own -- see the comment there.
   */
  route: {
    position: 'absolute',
    left: routeReadout.sideInset,
    right: routeReadout.sideInset,
    alignItems: 'center',
  },
  centre: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.lg,
    padding: spacing.xl,
  },
});
