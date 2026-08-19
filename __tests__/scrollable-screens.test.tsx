import React from 'react';
import {ScrollView, StyleSheet} from 'react-native';
import {context} from '@reatom/core';
import type {ReactTestInstance} from 'react-test-renderer';

import {BackgroundStep, backgroundStepTestIds} from '../src/screens/BackgroundStep';
import {OnboardingFlow} from '../src/screens/OnboardingFlow';
import {PairingFlow} from '../src/screens/PairingFlow';
import {RadioScreen} from '../src/screens/RadioScreen';
import {SettingsScreen} from '../src/screens/SettingsScreen';
import {spacing, testIds, type} from '../src/ui/theme';
import {renderScreen} from '../jest/renderScreen';
import type {RenderedScreen} from '../jest/renderScreen';

jest.useFakeTimers({doNotFake: ['queueMicrotask']});

beforeEach(() => context.reset());

/**
 * The same real-device numbers `safe-areas.test.tsx` uses. Zero insets are the
 * case under which a screen that mishandles the gesture bar renders identically
 * to one that handles it, so every inset assertion here passes real ones.
 */
const INSETS = {top: 59, right: 0, bottom: 34, left: 0};

/**
 * Jest runs no layout engine, so nothing here can measure a real overflow.
 * These assertions are therefore *structural*: which nodes are inside the
 * scroll container and which are outside it, and what the content container
 * was told. Tree position, never a snapshot -- a snapshot would go green again
 * the moment someone re-recorded it.
 */
const scrollViewsOf = (screen: RenderedScreen) =>
  screen.root.findAllByType(ScrollView);

const theScrollView = (screen: RenderedScreen) => {
  const found = scrollViewsOf(screen);
  if (found.length !== 1) {
    throw new Error(`expected exactly one ScrollView, found ${found.length}`);
  }
  return found[0];
};

/** Walks `.parent` rather than comparing subtrees: position, not identity of shape. */
const isInside = (node: ReactTestInstance, ancestor: ReactTestInstance) => {
  for (let walk = node.parent; walk; walk = walk.parent) {
    if (walk === ancestor) return true;
  }
  return false;
};

const inScroll = (screen: RenderedScreen, testID: string) =>
  isInside(screen.find(testID), theScrollView(screen));

const contentContainer = (screen: RenderedScreen) =>
  StyleSheet.flatten(
    theScrollView(screen).props.contentContainerStyle,
  ) as {flexGrow?: number; paddingBottom?: number};

/**
 * The last *element* the screen handed to the scroll container, read off the
 * `ScrollView`'s own `children` prop rather than the rendered host tree: the
 * question "is this the last thing in the content" is about the order the
 * screen declared, and the host tree wraps each child in layers of its own.
 */
const lastScrollChild = (screen: RenderedScreen) => {
  const kids = React.Children.toArray(
    theScrollView(screen).props.children,
  ).filter(React.isValidElement) as React.ReactElement<{testID?: string}>[];
  const last = kids[kids.length - 1];
  if (!last) throw new Error('the scroll container has no element children');
  return last;
};

const versionStyle = (screen: RenderedScreen) =>
  StyleSheet.flatten(screen.find(testIds.settingsVersion).props.style) as {
    marginTop?: number | string;
    marginBottom?: number;
    position?: string;
    bottom?: number;
  };

/** The frame's own outer padding -- the padding that would shorten the viewport. */
const framePaddingBottom = (screen: RenderedScreen, testID: string) => {
  const styled = screen.root
    .findAllByProps({testID})
    .find(node => node.props.style != null);
  if (!styled) throw new Error(`No styled node carries testID "${testID}"`);
  return (
    (StyleSheet.flatten(styled.props.style) as {paddingBottom?: number})
      .paddingBottom ?? 0
  );
};

describe('the settings screen scrolls', () => {
  const open = (insets?: typeof INSETS) =>
    renderScreen(
      <SettingsScreen onBack={jest.fn()} onConnectPress={jest.fn()} />,
      insets ? {scenario: 'happy', insets} : {scenario: 'happy'},
    );

  it('puts every stacked section inside one scroll container', async () => {
    const screen = await open();

    expect(scrollViewsOf(screen)).toHaveLength(1);
    // The three sections that grew the screen past the viewport twice today.
    expect(inScroll(screen, 'settings-card')).toBe(true);
    expect(inScroll(screen, testIds.audioMode)).toBe(true);
    expect(inScroll(screen, testIds.appLocale)).toBe(true);

    screen.unmount();
  });

  it('leaves the header bar outside the scroll container', async () => {
    const screen = await open();

    // The back chevron scrolling away is the same class of bug as an
    // unreachable footer button: the way out of the screen must stay put.
    expect(inScroll(screen, testIds.settingsBack)).toBe(false);

    screen.unmount();
  });

  it('ends the scrolled content with the version nameplate', async () => {
    const screen = await open();

    // Was pinned *outside* the scroll container as a `ScreenFrame` overlay.
    // The owner rejected that treatment -- it hovered over the list -- so the
    // nameplate is now an ordinary element, the last one, inside the content.
    expect(inScroll(screen, testIds.settingsVersion)).toBe(true);
    expect(lastScrollChild(screen).props.testID).toBe(testIds.settingsVersion);

    screen.unmount();
  });

  it('lets the nameplate rest at the bottom without pinning it', async () => {
    const screen = await open();

    const style = versionStyle(screen);
    // `marginTop: 'auto'` against the content container's `flexGrow: 1` is what
    // "nailed to the bottom" means for an element that is still in flow: the
    // auto margin eats the free space of a short screen and collapses to
    // nothing once the content overflows, so the nameplate sits at the foot of
    // the viewport when there is room and follows the content when there is
    // not. Neither of those is true of an absolutely positioned row.
    expect(style.marginTop).toBe('auto');
    expect(style.position).toBeUndefined();
    expect(style.bottom).toBeUndefined();

    screen.unmount();
  });

  it('hands the bottom inset to the content the nameplate now ends', async () => {
    const screen = await open(INSETS);

    // Nothing is pinned at the foot any more, so this screen takes the same
    // branch the pairing list does: the frame pads 0 (padding there would
    // shorten the viewport) and the inset rides the content container, where
    // it lands under the nameplate that closes it.
    expect(framePaddingBottom(screen, testIds.settingsScreen)).toBe(0);
    expect(contentContainer(screen).paddingBottom ?? 0).toBeGreaterThanOrEqual(
      INSETS.bottom,
    );
    // ...and no trace of the clearance the overlay used to need on top of it.
    // That padding paid for a row of zero flow height hovering over the list;
    // an in-flow nameplate occupies its own height and needs none of it.
    expect(contentContainer(screen).paddingBottom ?? 0).toBeLessThan(
      INSETS.bottom + spacing.lg + type.version.lineHeight,
    );

    screen.unmount();
  });

  it('grows its content container so short content still lays out', async () => {
    const screen = await open();

    expect(contentContainer(screen).flexGrow).toBe(1);

    screen.unmount();
  });
});

describe('the pairing flow scrolls', () => {
  it('scrolls the unbounded list of discovered candidates', async () => {
    const screen = await renderScreen(<PairingFlow onClose={jest.fn()} />, {
      scenario: 'pairing-success',
    });
    await screen.advance(1000);

    expect(screen.hasText('ORU-PTT-01')).toBe(true);
    expect(scrollViewsOf(screen)).toHaveLength(1);
    expect(
      inScroll(screen, `${testIds.pairingCandidate}-mock-ptt-01`),
    ).toBe(true);
    expect(inScroll(screen, testIds.pairingCancel)).toBe(false);

    await screen.advance(1000);
    screen.unmount();
  });

  it('keeps the learn step Cancel pinned below the scrolling stage', async () => {
    const screen = await renderScreen(<PairingFlow onClose={jest.fn()} />, {
      scenario: 'happy',
    });
    await screen.advance(1000);
    await screen.press(`${testIds.pairingCandidate}-mock-ptt-01`);

    expect(screen.findAll('pairing-foot')).toHaveLength(1);
    expect(inScroll(screen, testIds.pairingCancelFooter)).toBe(false);
    expect(inScroll(screen, 'pairing-ring')).toBe(true);

    await screen.advance(3000);
    screen.unmount();
  });

  it('keeps the saved step Done pinned below the scrolling stage', async () => {
    const screen = await renderScreen(<PairingFlow onClose={jest.fn()} />, {
      scenario: 'pairing-success',
    });
    await screen.advance(1000);
    await screen.press(`${testIds.pairingCandidate}-mock-ptt-01`);
    await screen.advance(3000);

    expect(screen.hasText('BUTTON CONNECTED')).toBe(true);
    expect(inScroll(screen, testIds.pairingDone)).toBe(false);
    expect(inScroll(screen, 'pairing-tick')).toBe(true);

    screen.unmount();
  });

  it('scrolls the failed step, whose native diagnostic is unbounded', async () => {
    const screen = await renderScreen(<PairingFlow onClose={jest.fn()} />, {
      scenario: 'pairing-empty',
    });
    await screen.advance(4000);

    expect(screen.hasText('No buttons found')).toBe(true);
    expect(inScroll(screen, testIds.pairingRetry)).toBe(true);
    expect(contentContainer(screen).flexGrow).toBe(1);

    screen.unmount();
  });

  it('hands the bottom inset to the scroll content when nothing is pinned', async () => {
    const screen = await renderScreen(<PairingFlow onClose={jest.fn()} />, {
      scenario: 'pairing-success',
      insets: INSETS,
    });
    await screen.advance(1000);

    // A bottom inset spent as *frame* padding shortens the viewport and cuts
    // the last candidate row off at the gesture bar; spent as content padding
    // it lets that row scroll clear of it. This step pins nothing at the foot,
    // so the inset belongs on the content.
    expect(framePaddingBottom(screen, testIds.pairingScreen)).toBe(0);
    expect(contentContainer(screen).paddingBottom ?? 0).toBeGreaterThanOrEqual(
      INSETS.bottom,
    );

    await screen.advance(1000);
    screen.unmount();
  });
});

describe('the onboarding flow scrolls its copy under pinned actions', () => {
  const open = (insets?: typeof INSETS) =>
    renderScreen(<OnboardingFlow onDone={jest.fn()} />, {
      scenario: 'onboarding',
      ...(insets ? {insets} : {}),
    });

  it('scrolls the body copy', async () => {
    const screen = await open();

    expect(scrollViewsOf(screen)).toHaveLength(1);
    expect(inScroll(screen, 'onboarding-copy')).toBe(true);
    expect(contentContainer(screen).flexGrow).toBe(1);

    screen.unmount();
  });

  it('keeps the action buttons pinned and reachable', async () => {
    const screen = await open();

    // The whole point of the change: `chrome.footer` holds the copy *and* the
    // buttons, so the block that overflows is the block that carries the way
    // forward. The buttons are pinned; the copy above them scrolls.
    expect(inScroll(screen, testIds.onboardingAllow)).toBe(false);

    screen.unmount();
  });

  it('insets the pinned actions rather than the scroll content', async () => {
    const screen = await open(INSETS);

    expect(
      framePaddingBottom(screen, testIds.onboardingScreen),
    ).toBeGreaterThanOrEqual(INSETS.bottom);
    expect(contentContainer(screen).paddingBottom ?? 0).toBe(0);

    screen.unmount();
  });

  it('keeps the done step start button pinned too', async () => {
    const screen = await renderScreen(<OnboardingFlow onDone={jest.fn()} />, {
      scenario: 'happy',
    });

    // Three grants walk the flow to its done step.
    await screen.press(testIds.onboardingAllow);
    await screen.press(testIds.onboardingAllow);
    await screen.press(testIds.onboardingAllow);

    expect(screen.hasText('All set')).toBe(true);
    expect(inScroll(screen, testIds.onboardingStart)).toBe(false);
    expect(inScroll(screen, 'onboarding-copy')).toBe(true);

    screen.unmount();
  });
});

describe('the background step scrolls its copy under pinned actions', () => {
  it('scrolls the copy and pins all three buttons', async () => {
    const screen = await renderScreen(<BackgroundStep />, {insets: INSETS});

    expect(scrollViewsOf(screen)).toHaveLength(1);
    expect(inScroll(screen, 'background-copy')).toBe(true);
    expect(inScroll(screen, backgroundStepTestIds.allow)).toBe(false);
    expect(inScroll(screen, backgroundStepTestIds.skip)).toBe(false);
    expect(contentContainer(screen).flexGrow).toBe(1);

    screen.unmount();
  });

  it('insets the pinned actions rather than the scroll content', async () => {
    const screen = await renderScreen(<BackgroundStep />, {insets: INSETS});

    expect(
      framePaddingBottom(screen, backgroundStepTestIds.screen),
    ).toBeGreaterThanOrEqual(INSETS.bottom);
    expect(contentContainer(screen).paddingBottom ?? 0).toBe(0);

    screen.unmount();
  });
});

describe('the radio screen never scrolls', () => {
  /**
   * Pinned deliberately, not incidentally. The main screen is one full-bleed
   * `Pressable` PTT target: a scroll responder would claim a hold with any
   * finger movement as a scroll gesture and cancel `onPressIn`, so a
   * `ScrollView` here would not merely be redundant, it would break
   * push-to-talk. Nothing on it stacks either -- the corner controls and the
   * route readout are absolutely positioned and the stage is a single centred
   * column.
   */
  it('has no scroll container while off', async () => {
    const screen = await renderScreen(
      <RadioScreen onSettingsPress={jest.fn()} />,
      {insets: INSETS},
    );

    expect(scrollViewsOf(screen)).toHaveLength(0);

    screen.unmount();
  });

  it('has no scroll container while live', async () => {
    const screen = await renderScreen(
      <RadioScreen onSettingsPress={jest.fn()} />,
      {insets: INSETS},
    );

    await screen.press(testIds.powerOnArea);
    await screen.advance(2100);
    expect(screen.hasText('HOLD TO TALK')).toBe(true);

    expect(scrollViewsOf(screen)).toHaveLength(0);

    screen.unmount();
  });

  it('has no scroll container in the error state', async () => {
    const screen = await renderScreen(
      <RadioScreen onSettingsPress={jest.fn()} />,
      {scenario: 'engine-error', insets: INSETS},
    );

    await screen.press(testIds.powerOnArea);
    await screen.advance(3100);
    expect(screen.findAll(testIds.errorState)).toHaveLength(1);

    expect(scrollViewsOf(screen)).toHaveLength(0);

    screen.unmount();
  });
});
