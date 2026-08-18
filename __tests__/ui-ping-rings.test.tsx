import React from 'react';
import {Text} from 'react-native';

import {renderScreen} from '../jest/renderScreen';
import {PeerRow} from '../src/ui/PeerRow';
import {PingRings} from '../src/ui/PingRings';
import {sizes} from '../src/ui/theme';

describe('PingRings — design/01 Radio.dc.html', () => {
  it('draws three rings around a centre dot', async () => {
    const screen = await renderScreen(<PingRings testID="pings" />);

    expect(screen.findAll('pings-ring')).toHaveLength(3);
    expect(screen.findAll('pings-dot')).toHaveLength(1);

    screen.unmount();
  });

  it('uses the canvas small set for the pairing scan', async () => {
    const screen = await renderScreen(
      <PingRings size="small" testID="pings" />,
    );

    expect(JSON.stringify(screen.find('ping-set').props.style)).toContain(
      String(sizes.pingSetSmall),
    );

    screen.unmount();
  });

  it('holds the rings at their static scales under reduced motion', async () => {
    const still = await renderScreen(<PingRings testID="pings" />, {
      reducedMotion: true,
    });
    const stillStyle = JSON.stringify(still.find('pings-ring').props.style);
    still.unmount();

    const moving = await renderScreen(<PingRings testID="pings" />, {
      reducedMotion: false,
    });
    const movingStyle = JSON.stringify(moving.find('pings-ring').props.style);
    moving.unmount();

    expect(stillStyle).not.toBe(movingStyle);
  });
});

describe('PeerRow — design/01 Radio.dc.html', () => {
  it('shows the nearby label beside a glowing dot', async () => {
    const screen = await renderScreen(
      <PeerRow label={<Text>2 nearby</Text>} testID="peer" />,
    );

    expect(screen.hasText('2 nearby')).toBe(true);
    expect(JSON.stringify(screen.find('peer-dot').props.style)).toContain(
      '14px',
    );

    screen.unmount();
  });
});
