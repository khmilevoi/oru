/**
 * @format
 */

import React, {useEffect} from 'react';
import {StatusBar, View} from 'react-native';
import {I18nProvider} from '@lingui/react';
import {i18n} from '@lingui/core';
import {
  initialWindowMetrics,
  SafeAreaProvider,
} from 'react-native-safe-area-context';

import {AppRoot} from './src/app/AppRoot';
import {resolveInitialRoute} from './src/permissions/sequencing.model';
import {chassis} from './src/ui/theme';

/**
 * The tree above every screen: the safe-area provider the chassis measures
 * against, the Lingui provider `Trans`/`useLingui` read, and the dark chassis
 * of section 12.1. `index.js` has already run `bootstrapApp()` by the time this
 * renders, so `i18n` carries an activated catalog on the first frame.
 *
 * The first-launch gate is the effect below: `resolveInitialRoute()` asks the
 * platform what has already been granted and sets `route()` to `radio` or
 * `onboarding` accordingly. Until it answers, `route()` is `null` and `AppRoot`
 * renders nothing over the chassis colour, so the main screen never flashes by
 * on the way to onboarding.
 */
function App() {
  useEffect(() => {
    void resolveInitialRoute();
  }, []);

  return (
    // `initialMetrics` seeds the provider with the insets the native side
    // measured before JS loaded; without it every inset-aware screen renders
    // one frame with zero insets and visibly jumps once the native
    // `onInsetsChange` event lands.
    <SafeAreaProvider initialMetrics={initialWindowMetrics}>
      <I18nProvider i18n={i18n}>
        {/*
          react-native@0.87 dropped `StatusBar`'s `backgroundColor` prop
          entirely (Android's edge-to-edge enforcement leaves nothing for it
          to set); `chassis.screen` below already paints the whole screen
          `colors.background`, so the status bar area shows the same colour
          through the translucent bar regardless.
        */}
        <StatusBar barStyle="light-content" />
        <View style={chassis.screen}>
          <AppRoot />
        </View>
      </I18nProvider>
    </SafeAreaProvider>
  );
}

export default App;
