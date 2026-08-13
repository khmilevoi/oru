import {existsSync, readFileSync} from 'fs';
import {join} from 'path';

const REPO_ROOT = join(__dirname, '..');
const RADIO_DIR = 'android/app/src/main/java/com/oru/radio';

const read = (relative: string): string =>
  readFileSync(join(REPO_ROOT, relative), 'utf8');

describe('android radio audio parameters (spec section 8)', () => {
  const config = () => read(`${RADIO_DIR}/RadioConfig.kt`);

  it('keeps every codec parameter in one config file', () => {
    expect(existsSync(join(REPO_ROOT, RADIO_DIR, 'RadioConfig.kt'))).toBe(true);
  });

  it.each([
    ['SAMPLE_RATE_HZ', '16_000'],
    ['CHANNEL_COUNT', '1'],
    ['FRAME_MS', '20'],
    ['BITRATE_BPS', '24_000'],
    ['JITTER_TARGET_FRAMES', '3'],
    ['JITTER_MIN_FRAMES', '2'],
    ['MAX_TRANSMIT_MS', '120_000L'],
    ['PROTOCOL_VERSION', '1'],
  ])('pins %s to %s', (name, value) => {
    expect(config()).toMatch(
      new RegExp(`const val ${name} = ${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`),
    );
  });

  it('advertises the shared nearby service id', () => {
    expect(config()).toMatch(/const val SERVICE_ID = "com\.oru\.radio"/);
  });
});

describe('android engine build wiring', () => {
  const appGradle = () => read('android/app/build.gradle');

  it('runs Kotlin unit tests from the app module', () => {
    expect(appGradle()).toMatch(/testImplementation\("junit:junit:4\.13\.2"\)/);
    expect(appGradle()).toMatch(/testImplementation\("org\.json:json:\d+"\)/);
    expect(appGradle()).toMatch(/returnDefaultValues = true/);
  });
});
