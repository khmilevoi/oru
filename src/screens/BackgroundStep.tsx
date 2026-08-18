import React from 'react';
import {StyleSheet, Text, View} from 'react-native';
import {Trans, useLingui} from '@lingui/react/macro';
import {reatomComponent} from '@reatom/react';
import {wrap} from '@reatom/core';

import {ActionButton} from '../ui/ActionButton';
import {PermissionMark} from '../ui/PermissionMark';
import {ScreenFrame} from '../ui/ScreenFrame';
import {chrome, colors, spacing, type} from '../ui/theme';
import {
  backgroundStatus,
  completeBackgroundStep,
  openBackgroundSettings,
  requestBackgroundPermissions,
} from '../permissions/sequencing.model';

/**
 * Spec section 11's still-open step: `ACCESS_BACKGROUND_LOCATION`, without which
 * Nearby's rediscovery of a lost peer stalls permanently a few minutes after the
 * app has no visible Activity -- which is exactly the locked, pocketed phone the
 * whole product is for (Bug #5 of the phase 0 spike report).
 *
 * It is a screen of its own rather than a fourth `OnboardingFlow` step because
 * it is Android-only, it cannot be granted from a normal dialog on API 30+, and
 * `OnboardingFlow` is merged, accepted work.
 */
export const backgroundStepTestIds = {
  screen: 'background-step',
  allow: 'background-allow',
  openSettings: 'background-open-settings',
  skip: 'background-skip',
} as const;

export const BackgroundStep = reatomComponent(() => {
  const {t} = useLingui();
  const status = backgroundStatus();

  return (
    <ScreenFrame testID={backgroundStepTestIds.screen}>
      <View style={styles.mark}>
        <PermissionMark kind="nearbyDevices" />
      </View>
      <View style={styles.foot}>
        <Text style={[type.hero, styles.title]}>
          <Trans>Keep the radio working</Trans>
        </Text>
        <Text style={[type.body, styles.body]}>
          <Trans>
            Oru needs background location to keep finding nearby radios while
            your phone is locked and in a pocket.
          </Trans>
        </Text>

        {status === 'needsSettings' ? (
          <Text style={[type.body, styles.warning]}>
            <Trans>
              Android grants this only from the app settings. Open them, choose
              Permissions, then Location, then "Allow all the time".
            </Trans>
          </Text>
        ) : null}

        <View style={styles.actions}>
          {status === 'needsSettings' ? (
            <ActionButton
              label={t`Open settings`}
              tone="primary"
              onPress={wrap(() => {
                void openBackgroundSettings();
              })}
              testID={backgroundStepTestIds.openSettings}
            />
          ) : null}

          {/*
            "Allow" survives `needsSettings` rather than being replaced by
            "Open settings": nothing here re-reads the grant on its own, so a
            user who followed the redirect, chose "Allow all the time" and came
            back would otherwise still be facing the warning with "Not now" as
            the only way out -- the success half of section 11's two-step
            redirect, unreachable. Pressing it re-runs
            `requestBackgroundPermissions`, whose `requestBackgroundLocation`
            re-reads the grant from the system and then navigates on.
          */}
          <ActionButton
            label={t`Allow`}
            tone={status === 'needsSettings' ? 'default' : 'primary'}
            onPress={wrap(() => {
              void requestBackgroundPermissions();
            })}
            testID={backgroundStepTestIds.allow}
          />

          <ActionButton
            label={t`Not now`}
            onPress={wrap(() => {
              void completeBackgroundStep();
            })}
            testID={backgroundStepTestIds.skip}
          />
        </View>
      </View>
    </ScreenFrame>
  );
}, 'BackgroundStep');

const styles = StyleSheet.create({
  mark: {flex: 1, alignItems: 'center', justifyContent: 'center'},
  foot: {...chrome.footer},
  title: {color: colors.text},
  body: {color: colors.textMuted, maxWidth: 320},
  warning: {color: colors.learning},
  actions: {gap: spacing.md, alignSelf: 'stretch'},
});
