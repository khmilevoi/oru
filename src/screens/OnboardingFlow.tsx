import React from 'react';
import {StyleSheet, Text, View} from 'react-native';
import {Trans, useLingui} from '@lingui/react/macro';
import {reatomComponent} from '@reatom/react';
import {wrap} from '@reatom/core';

import {ActionButton} from '../ui/ActionButton';
import {PermissionMark} from '../ui/PermissionMark';
import {ScreenFrame} from '../ui/ScreenFrame';
import {StepDots} from '../ui/StepDots';
import {chrome, colors, spacing, testIds, type} from '../ui/theme';
import {APP_PERMISSIONS} from '../permissions/permissions.types';
import {
  advanceOnboarding,
  onboardingFinished,
  onboardingPermission,
  onboardingStatus,
  openPermissionSettings,
  requestOnboardingPermission,
} from '../permissions/onboarding.model';

/** Spec section 12.1's `04 Onboarding`: three permission screens and a done screen. */
export const OnboardingFlow = reatomComponent<{onDone: () => void}>(
  ({onDone}) => {
    const {t} = useLingui();

    if (onboardingFinished()) {
      return (
        <ScreenFrame
          testID={testIds.onboardingScreen}
          scrollable
          footer={
            <View style={styles.foot}>
              <View style={styles.actions}>
                <ActionButton
                  label={t`Go on air`}
                  tone="primary"
                  onPress={onDone}
                  testID={testIds.onboardingStart}
                />
              </View>
            </View>
          }>
          <StepDots total={APP_PERMISSIONS.length} current={APP_PERMISSIONS.length} />
          <View style={styles.mark}>
            <PermissionMark kind="done" />
          </View>
          <View testID="onboarding-copy" style={styles.copy}>
            <Text style={[type.obTitle, styles.title]}>
              <Trans>All set</Trans>
            </Text>
            <Text style={[type.body, styles.body]}>
              <Trans>
                Whoever is nearby is connected — and hears you. Lock the
                phone and put it in your pocket.
              </Trans>
            </Text>
          </View>
        </ScreenFrame>
      );
    }

    const permission = onboardingPermission();
    const status = onboardingStatus();
    const step = APP_PERMISSIONS.indexOf(permission ?? 'microphone') + 1;

    const copy = {
      microphone: {
        title: <Trans>Microphone</Trans>,
        body: (
          <Trans>
            Your voice is transmitted only while the button is held. Nothing
            is recorded — the air is never stored.
          </Trans>
        ),
      },
      bluetooth: {
        title: <Trans>Bluetooth</Trans>,
        body: (
          <Trans>
            Connects nearby phones and pairs the external PTT button. No
            internet involved.
          </Trans>
        ),
      },
      nearbyDevices: {
        title: <Trans>Nearby devices</Trans>,
        body: (
          <Trans>
            Phones find each other and connect directly — no servers, no
            accounts. On iOS this is the “Local Network” permission.
          </Trans>
        ),
      },
    }[permission ?? 'microphone'];

    return (
      <ScreenFrame
        testID={testIds.onboardingScreen}
        scrollable
        footer={
          <View style={styles.foot}>
            <View style={styles.actions}>
              {status === 'blocked' ? (
                <ActionButton
                  label={t`Open settings`}
                  tone="primary"
                  onPress={wrap(() => {
                    void openPermissionSettings();
                  })}
                  testID={testIds.onboardingOpenSettings}
                />
              ) : (
                <ActionButton
                  label={status === 'denied' ? t`Try again` : t`Allow`}
                  tone="primary"
                  onPress={wrap(() => {
                    void requestOnboardingPermission();
                  })}
                  testID={
                    status === 'denied'
                      ? testIds.onboardingRetry
                      : testIds.onboardingAllow
                  }
                />
              )}

              {status === null ? null : (
                <ActionButton
                  label={t`Skip`}
                  onPress={wrap(() => {
                    void advanceOnboarding();
                  })}
                  testID={testIds.onboardingSkip}
                />
              )}
            </View>
          </View>
        }>
        <StepDots total={APP_PERMISSIONS.length} current={step - 1} />
        <View style={styles.mark}>
          <PermissionMark kind={permission ?? 'microphone'} />
        </View>
        <View testID="onboarding-copy" style={styles.copy}>
          <Text style={[type.obStep, styles.step]}>
            <Trans>
              STEP {step} OF {APP_PERMISSIONS.length}
            </Trans>
          </Text>
          <Text style={[type.obTitle, styles.title]}>{copy.title}</Text>
          <Text style={[type.body, styles.body]}>{copy.body}</Text>

          {status === 'denied' ? (
            <Text style={[type.body, styles.warning]}>
              <Trans>Permission denied. Oru cannot work without it.</Trans>
            </Text>
          ) : null}

          {status === 'blocked' ? (
            <Text style={[type.body, styles.warning]}>
              <Trans>
                Permission is blocked. Grant it in the system settings.
              </Trans>
            </Text>
          ) : null}
        </View>
      </ScreenFrame>
    );
  },
  'OnboardingFlow',
);

const styles = StyleSheet.create({
  /**
   * `flexGrow` rather than `flex: 1`. Inside a scroll content container the
   * two differ where it matters: `flex: 1` is `flexBasis: 0` plus
   * `flexShrink: 1`, so once the copy and the pinned actions no longer fit,
   * this spacer is the first thing squeezed and the permission mark is clipped
   * to nothing. `flexGrow: 1` keeps RN's default `flexBasis: auto` and
   * `flexShrink: 0`: it still absorbs all the slack on a screen the content
   * fits -- the centred composition the canvas drew is unchanged -- and simply
   * keeps its natural height once there is no slack, letting the whole column
   * scroll instead.
   */
  mark: {flexGrow: 1, alignItems: 'center', justifyContent: 'center'},
  /**
   * `.obfoot`, split in two by the scroll boundary. The copy block scrolls
   * (it is the part that grows with the locale, the warning states and the OS
   * font scale); the actions stay pinned. `foot`'s `paddingTop` restates the
   * 18pt `.obfoot` gap that used to fall between the last copy row and the
   * buttons, so with content that fits the two halves compose back into
   * exactly the block the canvas draws.
   */
  copy: {
    paddingHorizontal: chrome.footer.paddingHorizontal,
    gap: chrome.footer.gap,
  },
  foot: {
    paddingHorizontal: chrome.footer.paddingHorizontal,
    paddingTop: chrome.footer.gap,
    paddingBottom: chrome.footer.paddingBottom,
  },
  step: {color: colors.textFaint},
  title: {color: colors.text},
  body: {color: colors.textMuted, maxWidth: 320},
  warning: {color: colors.learning},
  actions: {gap: spacing.md, alignSelf: 'stretch'},
});
