import React from 'react';
import {StyleSheet, Text, View} from 'react-native';
import {Trans, useLingui} from '@lingui/react/macro';
import {reatomComponent} from '@reatom/react';
import {wrap} from '@reatom/core';

import {ActionButton} from '../ui/ActionButton';
import {ScreenFrame} from '../ui/ScreenFrame';
import {SegmentedControl} from '../ui/SegmentedControl';
import {chrome, colors, glows, radii, spacing, testIds, type} from '../ui/theme';
import {localeOverride} from '../app/locale.model';
import {radio} from '../radio/radio.model';
import {resolveLocale} from '../i18n';
import type {AppLocale} from '../i18n';
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
  const {t, i18n} = useLingui();
  const button = radio().pttButton;

  const audioModes: ReadonlyArray<{value: AudioMode; label: string}> = [
    {value: 'auto', label: t`Auto`},
    {value: 'voice', label: t`Radio`},
    {value: 'media', label: t`Music`},
  ];

  // Endonyms on purpose, never through `t`/`Trans`: each option must read in
  // its own language, whatever locale is active (amended section 12.2).
  const appLocales: ReadonlyArray<{value: AppLocale; label: string}> = [
    {value: 'en', label: 'English'},
    {value: 'ru', label: 'Русский'},
  ];

  return (
    <ScreenFrame
      testID={testIds.settingsScreen}
      title={t`Settings`}
      backLabel={t`Back`}
      backTestID={testIds.settingsBack}
      // All four edges, the frame's default. Nothing on this screen is pinned
      // against the bottom any more, so the frame takes its scroll-content
      // branch for the bottom inset: it spends the gesture-bar inset on the
      // content container, where it lands under the version nameplate that
      // closes the content rather than shortening the viewport above it.
      //
      // Three stacked sections, two of them carrying multi-line notes, is
      // already more than a small device shows at the system font size, and
      // nothing in the app caps font scaling. The header bar stays pinned; the
      // sections scroll under it.
      scrollable
      scrollTestID={testIds.settingsScroll}
      onBack={onBack}>
      <Text style={[type.label, styles.sectionLabel]}>
        <Trans>PTT button</Trans>
      </Text>

      <View testID="settings-card" style={styles.card}>
        {button.configured ? (
          <>
            <View style={styles.deviceRow}>
              <ConnectionDot live={button.connected} />
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
                {/* Deliberately no haptic, even though this drives the very
                    same pressPtt/releasePtt as the main talk area. Its job is
                    to prove the *external* button works, and it is pressed
                    while looking at this screen -- a phone buzz would be a
                    second sensation competing with the one under test, and the
                    eyes-free confirmation the talk area's haptic exists for
                    does not apply here. Nothing else on this screen buzzes
                    either; see src/app/haptics.ts for the full policy and
                    __tests__/haptics.test.tsx for the pin that keeps it so. */}
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
            {/* The same row and the same dot as the configured branch, unlit.
                This branch used to have no dot at all while the other had a
                permanently green one, which is exactly how a green dot came to
                sit beside "Not connected". */}
            <View style={styles.deviceRow}>
              <ConnectionDot live={false} />
              <Text
                testID={testIds.pttStatus}
                style={[type.devNameOff, styles.offName]}>
                <Trans>Not connected</Trans>
              </Text>
            </View>
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

      <Text style={[type.label, styles.sectionLabel]}>
        <Trans>Language</Trans>
      </Text>

      <View style={styles.card}>
        <SegmentedControl
          options={appLocales}
          // The effective locale, not the override: with nothing stored the
          // system choice is what the user is reading right now.
          value={resolveLocale(i18n.locale)}
          onChange={wrap((locale: AppLocale) => {
            void localeOverride.select(locale);
          })}
          testID={testIds.appLocale}
        />
      </View>

      <Text testID={testIds.settingsVersion} style={styles.version}>
        OFFLINE NEARBY PTT · V0.1
      </Text>
    </ScreenFrame>
  );
}, 'SettingsScreen');

/**
 * `design/theme.css`'s `.pdot` / `.pdot.off` -- the connection dot, STATE-
 * COLOURED and never decoratively green.
 *
 * A green dot beside "Not connected" is the one thing on a screen that can
 * contradict its own label, and this screen used to ship exactly that: one
 * always-green dot in the configured branch, sitting beside a status line free
 * to read "Disconnected". Green with its glow when the button is live,
 * `--faint` and unlit when it is not.
 *
 * Hue is never load-bearing here: the word beside it always says which, so the
 * dot only ever agrees with a label that is already there. It is decorative for
 * that reason.
 */
function ConnectionDot({live}: {live: boolean}) {
  return (
    <View
      testID="settings-connection-dot"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[styles.dot, live ? styles.dotLive : styles.dotOff]}
    />
  );
}

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
  dot: {width: 9, height: 9, borderRadius: 4.5, marginTop: spacing.sm},
  /** `.pdot` -- live: green, with its 14 glow. */
  dotLive: {backgroundColor: colors.rx, boxShadow: glows.peer},
  /** `.pdot.off` -- not live: faint, and NO glow. */
  dotOff: {backgroundColor: colors.textFaint, boxShadow: 'none'},
  deviceText: {flex: 1},
  name: {color: colors.text},
  connected: {color: colors.rx, marginTop: 5},
  disconnected: {color: colors.textMuted, marginTop: 5},
  /**
   * `.offname` -- the "Not connected" line, which now sits in a `.devrow`
   * beside the dot instead of alone in the card, so it does not carry
   * `disconnected`'s 5pt top margin: the dot's own 8 already sets the row's
   * optical baseline against this 19/24 face.
   */
  offName: {color: colors.textMuted},
  note: {marginTop: spacing.md, color: colors.textFaint},
  actions: {flexDirection: 'row', gap: 12, marginTop: spacing.gutter},
  action: {flex: 1},
  connect: {marginTop: spacing.gutter},
  /**
   * The build nameplate, the last element of the scrolled content.
   *
   * The canvas draws `.vers` absolutely against `.phone` at `bottom: 24`, and
   * the app copied that as a `ScreenFrame` overlay -- a row hovering above the
   * list, which the product owner rejected on sight. In flow instead:
   *
   * - `marginTop: 'auto'` is the whole of "nailed to the bottom". The frame's
   *   content container is `flexGrow: 1`, so it is at least a viewport tall;
   *   the auto margin eats whatever of that the sections leave over and drops
   *   the nameplate onto the bottom edge. Once the content does overflow there
   *   is no free space, the auto margin resolves to 0, and the nameplate simply
   *   trails the last card instead of floating over it.
   * - `paddingTop` and not a second margin, because an auto margin cannot also
   *   carry a number: this is the minimum breathing room below the last card,
   *   for the overflowing case where the auto margin has collapsed away.
   * - `marginBottom` is the canvas's own 24 under the nameplate. The gesture
   *   bar inset goes *below* that, added by the frame to the content
   *   container, which reproduces the old `bottom: 24 + insets.bottom` exactly.
   */
  version: {
    ...type.version,
    marginTop: 'auto',
    paddingTop: spacing.md,
    marginBottom: spacing.lg,
    textAlign: 'center',
    color: colors.textGhost,
  },
});
