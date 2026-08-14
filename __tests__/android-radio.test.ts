import {existsSync, readdirSync, readFileSync} from 'fs';
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

describe('embedded libopus (spec section 8)', () => {
  it('builds libopus from a pinned, hash-checked release', () => {
    const cmake = read('android/opus/src/main/cpp/CMakeLists.txt');
    expect(cmake).toMatch(/opus-1\.5\.2\.tar\.gz/);
    expect(cmake).toMatch(/URL_HASH SHA256=\$\{ORU_OPUS_SHA256\}/);
    expect(cmake).toMatch(/set\(OPUS_BUILD_SHARED_LIBRARY OFF/);
    expect(cmake).toMatch(/add_library\(oru_opus SHARED opus_jni\.c\)/);
  });

  it('wires the native module into the app build', () => {
    expect(read('android/settings.gradle')).toMatch(/include ':opus'/);
    expect(read('android/app/build.gradle')).toMatch(
      /implementation project\(':opus'\)/,
    );
  });

  it('binds the codec from the com.oru.radio package, matching the JNI symbol names', () => {
    expect(read('android/opus/src/main/cpp/opus_jni.c')).toMatch(
      /Java_com_oru_radio_OpusCodec_##name/,
    );
    expect(read(`${RADIO_DIR}/OpusCodec.kt`)).toMatch(
      /System\.loadLibrary\("oru_opus"\)/,
    );
  });
});

describe('nearby transport (spec section 7)', () => {
  const nearby = () => read(`${RADIO_DIR}/NearbyManager.kt`);

  it('depends on Google Play Services Nearby', () => {
    expect(read('android/app/build.gradle')).toMatch(
      /com\.google\.android\.gms:play-services-nearby:\d+\.\d+\.\d+/,
    );
  });

  it('advertises and discovers at the same time with P2P_CLUSTER', () => {
    expect(nearby()).toMatch(/client\.startAdvertising\(/);
    expect(nearby()).toMatch(/client\.startDiscovery\(/);
    expect(nearby().match(/Strategy\.P2P_CLUSTER/g)).toHaveLength(2);
  });

  it('accepts every connection automatically', () => {
    expect(nearby()).toMatch(/client\.acceptConnection\(endpointId, payloadCallback\)/);
  });

  it('gates peers on the hello version and drops mismatches', () => {
    expect(nearby()).toMatch(/message\.version != RadioConfig\.PROTOCOL_VERSION/);
    expect(nearby()).toMatch(/client\.disconnectFromEndpoint\(peerId\)/);
  });

  it('leaves no engine file importing React Native (spec section 6)', () => {
    const files = readdirSync(join(REPO_ROOT, RADIO_DIR)).filter(name =>
      name.endsWith('.kt'),
    );
    expect(files.length).toBeGreaterThan(0);
    files.forEach(name => {
      expect(read(`${RADIO_DIR}/${name}`)).not.toMatch(/com\.facebook\./);
    });
  });
});

describe('audio pipeline (spec section 8)', () => {
  const audio = () => read(`${RADIO_DIR}/AudioEngine.kt`);

  it('captures from VOICE_COMMUNICATION at the configured rate', () => {
    expect(audio()).toMatch(/MediaRecorder\.AudioSource\.VOICE_COMMUNICATION/);
    expect(audio()).toMatch(/RadioConfig\.SAMPLE_RATE_HZ/);
    expect(audio()).toMatch(/AudioFormat\.CHANNEL_IN_MONO/);
    expect(audio()).toMatch(/AudioFormat\.ENCODING_PCM_16BIT/);
  });

  it('plays back through AudioTrack and mixes concurrent streams', () => {
    expect(audio()).toMatch(/AudioTrack\.Builder\(\)/);
    expect(audio()).toMatch(/AudioMixer\.mix\(ready, mixed\)/);
    expect(audio()).toMatch(/JitterBuffer\(\)/);
  });

  it('uses embedded libopus rather than a platform codec', () => {
    expect(audio()).toMatch(/OpusEncoder\(\)/);
    expect(audio()).toMatch(/OpusDecoder\(\)/);
    expect(audio()).not.toMatch(/MediaCodec/);
  });

  it('hard-codes no audio parameter of its own', () => {
    expect(audio()).not.toMatch(/16_?000/);
    expect(audio()).not.toMatch(/24_?000/);
  });
});

describe('foreground service (spec sections 10.1, 12.2)', () => {
  it('declares both foreground service types and is not exported', () => {
    const manifest = read('android/app/src/main/AndroidManifest.xml');
    expect(manifest).toMatch(
      /<service[^>]*android:name="com\.oru\.radio\.RadioForegroundService"/s,
    );
    expect(manifest).toMatch(
      /android:foregroundServiceType="microphone\|connectedDevice"/,
    );
    expect(manifest).toMatch(/<service[\s\S]*?android:exported="false"[\s\S]*?\/>/);
  });

  it('localizes every notification string into en and ru', () => {
    const keys = [
      'radio_notification_channel_name',
      'radio_notification_title',
      'radio_notification_text',
    ];
    const en = read('android/app/src/main/res/values/strings.xml');
    const ru = read('android/app/src/main/res/values-ru/strings.xml');

    keys.forEach(key => {
      const pattern = new RegExp(`<string name="${key}">([^<]+)</string>`);
      const enValue = en.match(pattern);
      const ruValue = ru.match(pattern);
      expect(enValue).not.toBeNull();
      expect(ruValue).not.toBeNull();
      expect(ruValue![1]).not.toEqual(enValue![1]);
      expect(ruValue![1]).toMatch(/[Ѐ-ӿ]/);
    });
  });

  it('reads every notification string from resources instead of hard-coding it', () => {
    const service = read(`${RADIO_DIR}/RadioForegroundService.kt`);
    expect(service).toMatch(/getString\(R\.string\.radio_notification_title\)/);
    expect(service).toMatch(/getString\(R\.string\.radio_notification_text\)/);
    expect(service).toMatch(/getString\(R\.string\.radio_notification_channel_name\)/);
  });
});

describe('phase 0 spike hooks (spec section 15)', () => {
  it('keeps the hooks in the debug source set only', () => {
    expect(
      existsSync(join(REPO_ROOT, 'android/app/src/debug/java/com/oru/radio/SpikeActivity.kt')),
    ).toBe(true);
    expect(
      existsSync(join(REPO_ROOT, 'android/app/src/debug/java/com/oru/radio/SpikeReceiver.kt')),
    ).toBe(true);
    expect(existsSync(join(REPO_ROOT, `${RADIO_DIR}/SpikeActivity.kt`))).toBe(false);
    expect(read('android/app/src/main/AndroidManifest.xml')).not.toMatch(/Spike/);
  });

  it('declares them as exported debug components', () => {
    const manifest = read('android/app/src/debug/AndroidManifest.xml');
    expect(manifest).toMatch(/android:name="com\.oru\.radio\.SpikeActivity"/);
    expect(manifest).toMatch(/android:name="com\.oru\.radio\.SpikeReceiver"/);
  });

  it('documents every command the operator needs for scenarios A to D', () => {
    const runbook = read('docs/phase0-android-spike-hooks.md');
    [
      'start',
      'ptt-down',
      'ptt-up',
      'state',
      'ptt-scan',
      'ptt-pick',
      'ptt-cancel',
      'ptt-forget',
    ].forEach(command => expect(runbook).toContain(command));
    expect(runbook).toMatch(/pm grant com\.oru android\.permission\.RECORD_AUDIO/);
  });
});
