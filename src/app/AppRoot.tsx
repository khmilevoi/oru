import React, {useEffect} from 'react';
import {BackHandler} from 'react-native';
import {reatomComponent} from '@reatom/react';
import {wrap} from '@reatom/core';

import {OnboardingFlow} from '../screens/OnboardingFlow';
import {PairingFlow} from '../screens/PairingFlow';
import {RadioScreen} from '../screens/RadioScreen';
import {SettingsScreen} from '../screens/SettingsScreen';
import {goBack, navigate, route} from './navigation.model';

/**
 * One merged screen per route, with the callbacks each of them declares.
 * Nothing here knows what a screen renders; the whole of this plan's navigation
 * contract is these six lines of wiring.
 */
export const AppRoot = reatomComponent(() => {
  useEffect(() => {
    const subscription = BackHandler.addEventListener(
      'hardwareBackPress',
      wrap(() => goBack()),
    );
    return () => subscription.remove();
  }, []);

  const current = route();

  if (current === null) return null;

  if (current === 'onboarding') {
    return <OnboardingFlow onDone={wrap(() => navigate('radio'))} />;
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

  return <RadioScreen onSettingsPress={wrap(() => navigate('settings'))} />;
}, 'AppRoot');
