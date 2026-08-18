import {existsSync, readFileSync, statSync} from 'fs';
import {join} from 'path';

import {
  colors,
  fonts,
  glows,
  motion,
  radii,
  sizes,
  spacing,
  testIds,
  type,
  washes,
} from '../src/ui/theme';

const ROOT = join(__dirname, '..');
const FONT_FILES = [
  'Oswald-Regular.ttf',
  'Oswald-Medium.ttf',
  'Oswald-Bold.ttf',
  'IBMPlexMono-Regular.ttf',
  'IBMPlexMono-Medium.ttf',
  'IBMPlexMono-SemiBold.ttf',
];

describe('theme tokens — design/theme.css', () => {
  it('carries the canvas chassis greys', () => {
    expect(colors.background).toBe('#0b0d0f');
    expect(colors.backgroundOff).toBe('#070809');
    expect(colors.surface).toBe('#13161a');
    expect(colors.hairline).toBe('#242b32');
    expect(colors.hairlineRaised).toBe('#2e363e');
    expect(colors.text).toBe('#f2f4f2');
    expect(colors.textMuted).toBe('#8b959d');
    expect(colors.textFaint).toBe('#57626c');
  });

  it('carries the canvas status colors, converted from oklch', () => {
    expect(colors.tx).toBe('#ed413b');
    expect(colors.rx).toBe('#35c26d');
    expect(colors.learning).toBe('#eba941');
  });

  it('washes the transmitting and receiving screens with radial gradients', () => {
    expect(washes.tx).toBe(
      'radial-gradient(circle at 50% 42%, #2a0e11 0%, #150608 78%)',
    );
    expect(washes.rx).toBe(
      'radial-gradient(circle at 50% 42%, #0f2318 0%, #060f09 78%)',
    );
  });

  it('states the canvas glows as boxShadow strings', () => {
    expect(glows.tx).toContain('110px');
    expect(glows.rx).toContain('90px');
    expect(glows.peer).toContain('14px');
  });

  it('names only bundled font faces', () => {
    Object.values(fonts).forEach(family => {
      expect(FONT_FILES).toContain(`${family}.ttf`);
    });
  });

  it('never pairs a bundled family with a synthesised weight', () => {
    Object.values(type).forEach(style => {
      expect(style).not.toHaveProperty('fontWeight');
      expect(FONT_FILES).toContain(`${style.fontFamily}.ttf`);
    });
  });

  it('exposes the canvas geometry the screens use', () => {
    expect(sizes.ring).toBe(302);
    expect(sizes.ringLearning).toBe(272);
    expect(sizes.pingSet).toBe(230);
    expect(sizes.cornerControl).toBe(56);
    expect(spacing.md).toBe(16);
    expect(spacing.gutter).toBe(22);
    expect(radii.md).toBe(14);
    expect(radii.lg).toBe(18);
    expect(radii.pill).toBeGreaterThan(100);
    expect(motion.powerHoldMs).toBe(1200);
    expect(motion.recededOpacity).toBe(0.34);
    expect(testIds.pttArea).toBe('ptt-area');
  });
});

describe('bundled fonts — spec section 12.1', () => {
  it.each(FONT_FILES)('ships %s as a real TrueType file', file => {
    const path = join(ROOT, 'assets', 'fonts', file);

    expect(existsSync(path)).toBe(true);
    expect(statSync(path).size).toBeGreaterThan(50_000);

    const magic = readFileSync(path).subarray(0, 4).toString('hex');
    expect(['00010000', '74727565']).toContain(magic);
  });

  it('ships the OFL licences the fonts are distributed under', () => {
    ['OFL-Oswald.txt', 'OFL-IBMPlexMono.txt'].forEach(file => {
      const body = readFileSync(join(ROOT, 'assets', 'fonts', file), 'utf8');
      expect(body).toContain('SIL OPEN FONT LICENSE');
    });
  });

  it('registers the repository-root assets directory with the Android build', () => {
    const gradle = readFileSync(
      join(ROOT, 'android', 'app', 'build.gradle'),
      'utf8',
    );

    expect(gradle).toContain('assets.srcDirs');
    expect(gradle).toContain('$rootDir/../assets');
  });

  it('lists every face in the iOS UIAppFonts array', () => {
    const plist = readFileSync(join(ROOT, 'ios', 'Oru', 'Info.plist'), 'utf8');
    const section = plist.split('<key>UIAppFonts</key>')[1] ?? '';
    const array = section.split('</array>')[0] ?? '';

    FONT_FILES.forEach(file => expect(array).toContain(file));
  });

  it('declares the asset directory for the React Native CLI', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const config = require('../react-native.config.js');
    expect(config.assets).toEqual(['./assets/fonts']);
  });
});
