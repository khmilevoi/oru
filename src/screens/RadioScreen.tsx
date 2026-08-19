import React, {useEffect} from 'react';
import {Animated, Pressable, StyleSheet, Text, View} from 'react-native';
import {Trans, useLingui} from '@lingui/react/macro';
import {reatomComponent} from '@reatom/react';
import {wrap} from '@reatom/core';
import {useSafeAreaInsets} from 'react-native-safe-area-context';

import {ActionButton} from '../ui/ActionButton';
import {GearButton} from '../ui/GearButton';
import {HoldSeal} from '../ui/HoldSeal';
import {LevelBars} from '../ui/LevelBars';
import {MicMark} from '../ui/MicMark';
import {PeerRow} from '../ui/PeerRow';
import {PingRings} from '../ui/PingRings';
import {PowerKey} from '../ui/PowerKey';
import {RouteReadout} from '../ui/RouteReadout';
import {StateRing} from '../ui/StateRing';
import {useHoldToConfirm} from '../ui/useHoldToConfirm';
import {reducedMotion} from '../ui/reducedMotion';
import {
  chassis,
  colors,
  motion,
  routeReadout,
  seal,
  spacing,
  stage,
  testIds,
  type,
  washes,
} from '../ui/theme';
import {lastRadioError, radio, screenState} from '../radio/radio.model';
import {haptics} from '../app/haptics';

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

    // Read before the two early returns below, for the same reason
    // `useSafeAreaInsets` is: `useHoldToConfirm` and the effect under it are
    // Hooks, and this component transitions in and out of `error` and `off`
    // without unmounting.
    const still = reducedMotion();
    const state = screenState();
    /**
     * The power-off hold, owned HERE and not by the key, because the canvas
     * draws its progress across the whole screen -- see `src/ui/HoldSeal.tsx`.
     * `onConfirm` is reached only by a hold that ran the full 1200ms and then
     * held its closed loop, so an aborted shut-off neither stops the radio nor
     * announces anything: the canvas asks for the close to be "ANNOUNCED BY
     * THAT FLASH AND A HAPTIC", and announcing a shut-off that did not happen
     * would undo the guard the hold exists to be.
     */
    const powerHold = useHoldToConfirm(
      wrap(() => {
        haptics.powerOff();
        void radio.stop();
      }),
    );

    /**
     * Where a hold may run at all: the LIVE screen's corner key, in `searching`
     * and `ready`. The key recedes and stops taking touches while transmitting
     * or receiving, so a hold that was already running when a transmission
     * arrives would never see its release -- its commit timer would run out
     * and power the radio off mid-transmission, with the seal painted over the
     * red or green wash on the way. It is dropped instead.
     */
    const holdable = state === 'searching' || state === 'ready';
    const {cancel: cancelHold} = powerHold;
    useEffect(() => {
      if (!holdable) cancelHold();
    }, [holdable, cancelHold]);

    const sealing = holdable && powerHold.phase !== 'idle';
    /**
     * The ring's recede and its label's cross-fade, both over the first 15% of
     * the hold and both on the seal's own value -- there is no second clock
     * here. Under reduced motion the value never moves, so the same call gives
     * the end state outright: the amber copy is simply there for the whole
     * hold, which is what the canvas asks for.
     */
    const crossFade = (from: number, to: number) =>
      still
        ? to
        : powerHold.progress.interpolate({
            inputRange: [0, seal.copyFade],
            outputRange: [from, to],
            extrapolate: 'clamp',
          });

    /**
     * `.ringhold` -- the stage recedes while the seal runs, because it is not
     * the live control any more. A COLOUR change and nothing else: the ring is
     * geometrically invariant and its border is part of its box.
     */
    const ringBorder = !sealing
      ? undefined
      : still
        ? colors.hairline
        : powerHold.progress.interpolate({
            inputRange: [0, seal.copyFade],
            outputRange: [colors.hairlineRaised, colors.hairline],
            extrapolate: 'clamp',
          });

    if (radio().status === 'error') return <RadioErrorState />;

    if (state === 'off') {
      // Both the hero key and the whole-screen tap share this, so the buzz is
      // wired once here rather than at each. In production only one of them
      // ever runs for a given touch -- the inner `PowerKey` becomes the
      // responder and the outer `Pressable` never sees the press.
      const startRadio = wrap(() => {
        haptics.powerOn();
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
            <View style={[styles.stage, styles.offStage]}>
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
            {/* The gear is not told what it sits on any more: its hub is a
                RING, not a hole punched in the chassis colour, so there is
                nothing for a chassis to have to match (`.gearmark`). */}
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
      <View testID={testIds.radioScreen} style={[chassis.screen, wash, topStyle]}>
        <Pressable
          testID={testIds.pttArea}
          accessibilityRole="button"
          accessibilityLabel={t`Push to talk`}
          // The two edges of a transmission are given deliberately different
          // effects, not one shared buzz: this is the control the user works
          // without looking, so the feedback has to say *which* edge it just
          // crossed. See `src/app/haptics.ts` for the whole policy.
          onPressIn={wrap(() => {
            haptics.transmitStart();
            void radio.pressPtt();
          })}
          onPressOut={wrap(() => {
            haptics.transmitEnd();
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
              <StateRing tone="idle" borderColor={ringBorder} testID="radio-ring">
                {/*
                  The ring's headline became the MICROPHONE on 2026-08-19
                  (`design/01 Radio.dc.html` frames 03 / 07 and the ICON SYSTEM
                  note). "HOLD TO TALK" was the case that proved the change:
                  «УДЕРЖИВАЙТЕ ЧТОБЫ ГОВОРИТЬ» is so long the design had to
                  drop the type scale from 40 to 33 and pre-break it, and on a
                  real Samsung it still wrapped to three lines inside the ring.
                  A glyph is the same size in every language, so the two type
                  scales this branch used to pick between are gone with it.

                  The glyph is a CHILD of the ring, which is a fixed 302 box, so
                  it costs the geometrically invariant column nothing -- and no
                  sibling of the ring was added or removed to make room for it.

                  It keeps `testIds.radioStateLabel`: it is what this state's
                  label now IS, and the acceptance suite reads that node's style
                  to prove the five states stay five distinct signatures.

                  `Animated.View` in every state, not only while the seal runs:
                  swapping the component type at the start of a hold would
                  remount the glyph and flash it -- the same reason the headline
                  it replaced was always an `Animated.Text`.
                */}
                <MicMark
                  idiom="control"
                  testID={testIds.radioStateLabel}
                  opacity={sealing ? crossFade(1, 0) : undefined}
                />
                {/*
                  What the hold will do, in the key's own words -- the same
                  catalog message that is already its accessibility label,
                  uppercased by `type` and never re-translated. Absolutely
                  positioned so it overlays the headline instead of joining the
                  ring's own column, and one size down again because it is the
                  longest copy this circle ever holds (`.holdword` for `en`,
                  `.holdword.sm` for the rest).
                */}
                {sealing ? (
                  <Animated.Text
                    testID="seal-copy"
                    style={[
                      i18n.locale === 'en' ? type.heroTight : type.heroSmall,
                      styles.sealCopy,
                      {opacity: crossFade(0, 1)},
                    ]}>
                    <Trans>Hold to turn the radio off</Trans>
                  </Animated.Text>
                ) : null}
              </StateRing>
            ) : null}

            {state === 'transmitting' ? (
              <StateRing tone="tx" testID="radio-ring">
                <Text
                  testID={testIds.radioStateLabel}
                  style={[type.state, styles.onTx]}>
                  <Trans>TRANSMITTING...</Trans>
                </Text>
                <LevelBars color={colors.text} testID="radio-bars" />
              </StateRing>
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

            {/*
              The hint slot, reserved in every ring state and filled in one.
              `styles.stage` centres its column, so the ring's position is set
              by the whole column's height -- and the canvas gives this hint to
              `transmitting` alone (frame 04), which grew the column by
              `stage.gap` plus a line and lifted the ring 29pt at the exact
              moment of the press. That was the reported jump. Reserving the
              slot in every state costs the same 40 + `stage.hintSlot` in all
              of them, so the ring is centred identically whatever the state.
            */}
            {state === 'searching' ? null : (
              <View style={styles.hintSlot}>
                {/*
                  The one thing a static glyph cannot say, and the one real risk
                  of replacing the headline with one: tap-versus-hold is
                  invisible and unrecoverable by inspection, because a tap
                  produces a sub-100ms transmission or nothing at all, which is
                  indistinguishable from a broken app. So the verb stays -- the
                  verb ALONE, since the microphone already supplies "talk".

                  It is not removed, it is DEMOTED: from the loudest thing on
                  the screen to 13pt of passive chrome, in a slot that was
                  already reserved and sitting empty in this state, so it costs
                  exactly zero layout. It cross-fades out with the glyph when
                  the power-off seal takes the screen, leaving the slot reserved
                  and empty.
                */}
                {state === 'ready' ? (
                  <Animated.Text
                    testID="ready-hold-hint"
                    style={[
                      type.subhint,
                      styles.hint,
                      sealing && {opacity: crossFade(1, 0)},
                    ]}>
                    <Trans>HOLD</Trans>
                  </Animated.Text>
                ) : null}
                {state === 'transmitting' ? (
                  <Text style={[type.subhint, styles.txHint]}>
                    <Trans>RELEASE TO FINISH</Trans>
                  </Text>
                ) : null}
              </View>
            )}
          </View>
        </Pressable>

        {/*
          The power-off hold, painted across the whole screen. A sibling of the
          push-to-talk area and of the centred stage column inside it -- never a
          member of that column, which decides where the geometrically
          invariant talk ring lands. It is placed BEFORE the corner controls and
          the route readout so those paint on top of its wash and stay legible,
          exactly as `.sealing` sits before `.gear`, `.pwr` and `.routeline` on
          the canvas.
        */}
        {sealing ? (
          <HoldSeal progress={powerHold.progress} phase={powerHold.phase} />
        ) : null}

        <View testID="corner-controls" style={[styles.corners, cornerStyle]}>
          {/* The gear stays fully visible and tappable while live: the canvas
              dims `.pwr` alone and `.gear` never carries `dim`
              (design/01 Radio.dc.html frames 04 and 05). */}
          <GearButton
            onPress={onSettingsPress}
            accessibilityLabel={t`Settings`}
            testID={testIds.settingsGear}
          />
          <View
            testID="power-corner"
            pointerEvents={live ? 'none' : 'auto'}
            style={live && styles.receded}>
            <PowerKey
              variant="corner"
              hold={powerHold}
              accessibilityLabel={t`Hold to turn the radio off`}
              testID={testIds.powerKey}
            />
          </View>
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
    gap: stage.gap,
    paddingBottom: stage.paddingBottom,
  },
  /** `.offstage` -- the same column, opened up to the canvas's 46. */
  offStage: {gap: stage.offGap},
  offCopy: {alignItems: 'center', gap: spacing.md},
  /**
   * A fixed-height box, never a bare `<Text>`: its height must not depend on
   * whether it currently holds copy, nor on how many lines that copy takes in
   * the active locale. `stage.hintSlot` reserves the two-line worst case, and
   * the hint is centred in it so a one-line locale still reads as one line
   * under the ring. `alignSelf: 'stretch'` beats the stage's `alignItems:
   * 'center'` so a wrapping translation gets the full width to wrap in.
   */
  hintSlot: {
    height: stage.hintSlot,
    alignSelf: 'stretch',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.gutter,
  },
  headline: {color: colors.text, textAlign: 'center'},
  /**
   * `.sealcopy` -- the amber power-off line, overlaid on the headline it
   * replaces. Absolute so it costs the ring's own column nothing, and inset by
   * the ring's `paddingHorizontal` so it wraps exactly where the headline
   * does. With `top`/`bottom` left undefined it takes the ring's own
   * `justifyContent`/`alignItems`, so it lands centred like the copy it fades
   * in over.
   */
  sealCopy: {
    position: 'absolute',
    left: spacing.lg,
    right: spacing.lg,
    color: colors.seal,
    textAlign: 'center',
  },
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
