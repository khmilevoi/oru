import {context} from '@reatom/core';
import {i18n} from '@lingui/core';

import {radio} from '../src/radio/radio.model';
import {renderApp} from '../jest/renderApp';
import {testIds} from '../src/ui/theme';
import {backgroundStepTestIds} from '../src/screens/BackgroundStep';

jest.useFakeTimers({doNotFake: ['queueMicrotask']});

beforeEach(() => context.reset());

describe('the assembled app — spec section 15 Stage 4', () => {
  it('opens on the radio when the sequence is already satisfied', async () => {
    const app = await renderApp({
      gateway: {onboardingCompleted: () => true, hasOnboardingPermissions: async () => true},
    });

    expect(app.findAll(testIds.radioScreen)).toHaveLength(1);
    expect(app.hasText('RADIO OFF')).toBe(true);
    app.unmount();
  });

  it('opens on onboarding on a fresh install and lands on the radio', async () => {
    const app = await renderApp({
      gateway: {onboardingCompleted: () => false, hasOnboardingPermissions: async () => false},
    });

    expect(app.findAll(testIds.onboardingScreen)).toHaveLength(1);
    await app.press(testIds.onboardingAllow);
    await app.press(testIds.onboardingAllow);
    await app.press(testIds.onboardingAllow);
    await app.press(testIds.onboardingStart);

    expect(app.findAll(testIds.radioScreen)).toHaveLength(1);
    app.unmount();
  });

  it('shows the background step where the platform has one', async () => {
    const app = await renderApp({
      gateway: {
        onboardingCompleted: () => false,
        hasOnboardingPermissions: async () => false,
        backgroundStepSupported: () => true,
        hasBackgroundLocation: async () => false,
      },
    });

    await app.press(testIds.onboardingAllow);
    await app.press(testIds.onboardingAllow);
    await app.press(testIds.onboardingAllow);
    await app.press(testIds.onboardingStart);

    expect(app.findAll(backgroundStepTestIds.screen)).toHaveLength(1);
    await app.press(backgroundStepTestIds.skip);
    expect(app.findAll(testIds.radioScreen)).toHaveLength(1);
    app.unmount();
  });

  it('drives a whole session: power on, peers, talk, power off', async () => {
    const app = await renderApp({
      scenario: 'happy',
      gateway: {onboardingCompleted: () => true, hasOnboardingPermissions: async () => true},
    });

    await app.press(testIds.powerOnArea);
    await app.advance(5000);
    expect(radio().status).toBe('ready');
    expect(app.hasText('nearby')).toBe(true);

    await app.pressIn(testIds.pttArea);
    await app.advance(100);
    expect(radio().transmitting).toBe(true);
    expect(app.hasText('TRANSMITTING')).toBe(true);

    await app.pressOut(testIds.pttArea);
    await app.advance(100);
    expect(radio().transmitting).toBe(false);
    app.unmount();
  });

  it('reaches settings and the pairing flow from the main screen', async () => {
    const app = await renderApp({
      scenario: 'pairing-success',
      gateway: {onboardingCompleted: () => true, hasOnboardingPermissions: async () => true},
    });

    await app.press(testIds.settingsGear);
    expect(app.findAll(testIds.settingsScreen)).toHaveLength(1);

    await app.press(testIds.pttConnect);
    expect(app.findAll(testIds.pairingScreen)).toHaveLength(1);
    app.unmount();
  });

  it('boots in Russian for a Russian system locale', async () => {
    const app = await renderApp({
      locale: 'ru',
      gateway: {onboardingCompleted: () => true, hasOnboardingPermissions: async () => true},
    });

    expect(i18n.locale).toBe('ru');
    expect(app.hasText('РАЦИЯ ВЫКЛЮЧЕНА')).toBe(true);
    app.unmount();
  });
});
