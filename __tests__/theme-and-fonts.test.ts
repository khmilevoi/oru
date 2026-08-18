import {existsSync, readFileSync, statSync} from 'fs';
import {join} from 'path';

import {colors, fonts, motion, radii, spacing, testIds, type} from '../src/ui/theme';

const ROOT = join(__dirname, '..');
const FONT_FILES = [
  'Oswald-Regular.ttf',
  'Oswald-Medium.ttf',
  'Oswald-Bold.ttf',
  'IBMPlexMono-Regular.ttf',
  'IBMPlexMono-Medium.ttf',
  'IBMPlexMono-SemiBold.ttf',
];

describe('theme tokens — spec section 12.1', () => {
  it('is a dark chassis with the three status colors', () => {
    expect(colors.background).toMatch(/^#[0-9a-f]{6}$/i);
    expect(colors.tx).toBe('#ff3b30');
    expect(colors.rx).toBe('#2fd65b');
    expect(colors.learning).toBe('#ffb020');
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

  it('exposes the scales the screens use', () => {
    expect(spacing.md).toBe(16);
    expect(radii.pill).toBeGreaterThan(100);
    expect(motion.powerHoldMs).toBe(1200);
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
