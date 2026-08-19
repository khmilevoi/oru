import React from 'react';
import {StyleSheet, Text} from 'react-native';

import {
  colors,
  fonts,
  radii,
  routeReadout,
  segmented,
  testIds,
  type,
} from '../src/ui/theme';
import {RouteReadout} from '../src/ui/RouteReadout';
import {renderScreen} from '../jest/renderScreen';

describe('theme tokens for the section 8 surfaces', () => {
  it('carries the canvas .routeline metrics', () => {
    // design/01 Radio.dc.html: font-size 11px, letter-spacing 0.14em, --faint.
    expect(type.routeLabel.fontSize).toBe(11);
    expect(type.routeLabel.letterSpacing).toBe(1.54);
    expect(type.routeLabel.fontFamily).toBe(fonts.mono);
    expect(colors.textFaint).toBe('#57626c');
  });

  it('carries the canvas .route geometry', () => {
    // design/01 Radio.dc.html: gap 9px, 14x14 icon at stroke-width 1.5,
    // left/right 90px, bottom 44px.
    expect(routeReadout).toEqual({
      gap: 9,
      iconSize: 14,
      strokeWidth: 1.5,
      sideInset: 90,
      bottomInset: 44,
    });
  });

  it('carries the canvas .seg metrics', () => {
    // design/02 Settings.dc.html: 13.5px, 0.04em, radius 14px, padding 14px 0,
    // selected is --ink on #0c0e10 at weight 500.
    expect(type.segment.fontSize).toBe(13.5);
    expect(type.segment.letterSpacing).toBe(0.54);
    expect(type.segment.fontFamily).toBe(fonts.mono);
    expect(type.segmentSelected.fontFamily).toBe(fonts.monoMedium);
    expect(type.segmentSelected.fontSize).toBe(type.segment.fontSize);
    expect(segmented.paddingVertical).toBe(14);
    expect(radii.md).toBe(14);
    expect(colors.hairlineRaised).toBe('#2e363e');
    expect(colors.textInverse).toBe('#0c0e10');
  });

  it('appends the two new test ids without renaming any existing one', () => {
    expect(testIds.audioRoute).toBe('audio-route');
    expect(testIds.audioMode).toBe('audio-mode');
    expect(testIds.radioScreen).toBe('radio-screen');
    expect(testIds.settingsScreen).toBe('settings-screen');
  });
});

describe('RouteReadout', () => {
  const read = async (
    route: Parameters<typeof RouteReadout>[0]['route'],
    locale?: 'en' | 'ru',
  ) => {
    const screen = await renderScreen(
      <RouteReadout route={route} testID={testIds.audioRoute} />,
      locale ? {locale} : {},
    );
    const text = screen.texts().join('');
    screen.unmount();
    return text;
  };

  // Every string below is read off design/01 Radio.dc.html frame 08.
  it('renders the speaker route the way the canvas states it', async () => {
    expect(await read({kind: 'speaker', mode: 'voice'})).toBe('Speaker · radio');
  });

  it('renders wired and usb identically -- "usb routes render like wired"', async () => {
    expect(await read({kind: 'wired', mode: 'voice'})).toBe('Headphones · radio');
    expect(await read({kind: 'usb', mode: 'voice'})).toBe('Headphones · radio');
  });

  it('shows the Bluetooth headset name as reported', async () => {
    expect(await read({kind: 'bluetooth', label: 'AirPods', mode: 'voice'})).toBe(
      'AirPods · radio',
    );
    expect(await read({kind: 'bluetooth', label: 'AirPods', mode: 'media'})).toBe(
      'AirPods · music, phone mic',
    );
  });

  it('falls back to the generic accessory word for a nameless headset', async () => {
    expect(await read({kind: 'bluetooth', mode: 'voice'})).toBe(
      'Headphones · radio',
    );
  });

  it('renders in Russian', async () => {
    expect(await read({kind: 'speaker', mode: 'voice'}, 'ru')).toBe(
      'Динамик · рация',
    );
    expect(await read({kind: 'wired', mode: 'voice'}, 'ru')).toBe(
      'Наушники · рация',
    );
    expect(
      await read({kind: 'bluetooth', label: 'AirPods', mode: 'media'}, 'ru'),
    ).toBe('AirPods · музыка, микрофон телефона');
  });

  it('is an indicator, never a picker: it carries no press handler', async () => {
    const screen = await renderScreen(
      <RouteReadout
        route={{kind: 'speaker', mode: 'voice'}}
        testID={testIds.audioRoute}
      />,
    );
    const node = screen.find(testIds.audioRoute);

    expect(node.props.onPress).toBeUndefined();
    expect(node.props.accessibilityRole).not.toBe('button');
    screen.unmount();
  });

  it('uppercases the line the way the canvas does', async () => {
    const screen = await renderScreen(
      <RouteReadout
        route={{kind: 'speaker', mode: 'voice'}}
        testID={testIds.audioRoute}
      />,
    );
    const label = screen.find(testIds.audioRoute).findByType(Text);

    expect(StyleSheet.flatten(label.props.style).textTransform).toBe('uppercase');
    screen.unmount();
  });
});
