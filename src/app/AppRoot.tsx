import React, {useEffect} from 'react';
import {BackHandler} from 'react-native';
import {reatomComponent} from '@reatom/react';
import {bind, wrap} from '@reatom/core';

import {completeOnboarding} from '../permissions/sequencing.model';
import {BackgroundStep} from '../screens/BackgroundStep';
import {OnboardingFlow} from '../screens/OnboardingFlow';
import {PairingFlow} from '../screens/PairingFlow';
import {RadioScreen} from '../screens/RadioScreen';
import {SettingsScreen} from '../screens/SettingsScreen';
import {goBack, navigate, route} from './navigation.model';

/**
 * One merged screen per route, with the callbacks each of them declares, plus
 * Android's hardware back button. Nothing here knows what a screen renders:
 * this file is the whole of the plan's navigation contract -- a route atom read
 * once, a branch per destination, and the `onDone`/`onBack`/`onClose` callbacks
 * the merged screens declare, bound to `navigate` and `goBack`.
 */
export const AppRoot = reatomComponent(() => {
  useEffect(() => {
    const subscription = BackHandler.addEventListener(
      'hardwareBackPress',
      // `bind`, not `wrap`: this crosses a native, non-Reatom boundary and is
      // invoked later, by Android rather than by React -- the same case
      // `src/app/appEntry.ts` binds its `AppState` listener for. The `wrap`s
      // below are React `onPress` props and are correct as they are.
      bind(() => goBack()),
    );
    return () => subscription.remove();
  }, []);

  const current = route();

  if (current === null) return null;

  if (current === 'onboarding') {
    return (
      <OnboardingFlow
        onDone={wrap(() => {
          void completeOnboarding();
        })}
      />
    );
  }

  if (current === 'settings') {
    return (
      <SettingsScreen
        onBack={wrap(() => navigate('radio'))}
        onConnectPress={wrap(() => navigate('pairing'))}
      />
    );
  }

  if (current === 'pairing') {
    return <PairingFlow onClose={wrap(() => navigate('settings'))} />;
  }

  if (current === 'background') {
    return <BackgroundStep />;
  }

  return <RadioScreen onSettingsPress={wrap(() => navigate('settings'))} />;
}, 'AppRoot');
