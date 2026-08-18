import {existsSync, readFileSync, readdirSync} from 'fs';
import {join} from 'path';

const SOURCES = join(
  __dirname,
  '..',
  'ios',
  'Radio',
  'Sources',
  'RadioKit',
);

function source(name: string): string {
  const path = join(SOURCES, name);
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

function swiftFiles(): string[] {
  return existsSync(SOURCES)
    ? readdirSync(SOURCES).filter(name => name.endsWith('.swift'))
    : [];
}

/// Every `AVAudioSession.setActive` call in `swift` that is not inside a
/// `#if DEBUG` region, as trimmed source lines. Conditional-compilation blocks
/// nest, so the scan tracks the depth of the innermost `#if DEBUG` rather than
/// a boolean.
function unguardedSetActiveLines(swift: string): string[] {
  const offenders: string[] = [];
  let depth = 0;
  let debugDepth = 0;
  for (const raw of swift.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('#if')) {
      depth += 1;
      if (debugDepth === 0 && line.startsWith('#if DEBUG')) {
        debugDepth = depth;
      }
    } else if (line.startsWith('#endif')) {
      if (debugDepth === depth) {
        debugDepth = 0;
      }
      depth = Math.max(0, depth - 1);
    } else if (line.includes('setActive(') && debugDepth === 0) {
      offenders.push(line);
    }
  }
  return offenders;
}

describe('domain types (spec section 6.1)', () => {
  const state = source('RadioState.swift');

  it.each([
    'public struct RadioState',
    'public enum Status: String',
    'case starting',
    'case ready',
    'case error',
    'public var nearbyCount: Int',
    'public var transmitting: Bool',
    'public var receiving: Bool',
    'public var pttButton: PttButtonState',
    'public struct PttButtonState',
    'public struct RadioError',
    'public enum RadioEvent',
    'case stateChanged(RadioState)',
    'var asDictionary: [String: Any]',
  ])('RadioState.swift declares %s', declaration => {
    expect(state).toContain(declaration);
  });

  it.each([
    'public struct PttCandidate',
    'public let deviceId: String',
    'public let rssi: Int',
    'public struct PttPairingState',
    'public enum Phase: String',
    'case scanning',
    'case learning',
    'case saved',
    'public var candidates: [PttCandidate]',
    'public var pttPairing: PttPairingState?',
  ])('declares the amended pairing state %s', declaration => {
    expect(state).toContain(declaration);
  });

  it('omits pttPairing from the snapshot when no session is running', () => {
    expect(state).toContain('if let pttPairing');
  });
});

describe('control protocol (spec section 7)', () => {
  const control = source('ControlMessage.swift');

  it.each([
    'public enum ControlMessage',
    'case hello(version: Int)',
    'case txStart(streamId: String)',
    'case txStop(streamId: String)',
    'public func encoded() -> Data',
    'public static func decode(_ data: Data) -> ControlMessage?',
  ])('ControlMessage.swift declares %s', declaration => {
    expect(control).toContain(declaration);
  });

  it.each(['"hello"', '"tx-start"', '"tx-stop"', '"streamId"', '"version"'])(
    'uses the wire token %s verbatim',
    token => {
      expect(control).toContain(token);
    },
  );
});

describe('stream framing (cross-platform wire contract)', () => {
  const framing = source('AudioFraming.swift');

  it.each([
    'public enum AudioFraming',
    'public static func frame(_ payload: Data) -> Data',
    'public final class AudioFrameParser',
    'public func append(_ bytes: Data) -> [Data]',
    'public private(set) var isDesynchronised',
  ])('AudioFraming.swift declares %s', declaration => {
    expect(framing).toContain(declaration);
  });

  it('uses a two-byte big-endian length prefix', () => {
    expect(framing).toContain('UInt16');
    expect(framing).toContain('bigEndian');
  });
});

describe('engine ports', () => {
  const ports = source('RadioPorts.swift');

  it.each([
    'public protocol RadioTransport',
    'public protocol RadioTransportDelegate',
    'public protocol AudioStreamSink',
    'public protocol AudioIO',
    'public protocol AudioIODelegate',
    'public protocol PttSource',
    'public protocol PttSourceDelegate',
    'public protocol BackgroundSession',
    'public protocol BackgroundSessionDelegate',
    'public protocol RadioClock',
    'public protocol RadioCancellable',
    'func selectCandidate(deviceId: String)',
    'pairingStateDidChange state: PttPairingState?',
  ])('RadioPorts.swift declares %s', declaration => {
    expect(ports).toContain(declaration);
  });

  it('keeps every third-party and UI import out of the ports', () => {
    expect(ports).not.toContain('import NearbyConnections');
    expect(ports).not.toContain('import UIKit');
    expect(ports).not.toContain('import React');
  });
});

describe('layering (spec section 6)', () => {
  // Spec section 6 draws the line at React Native / JS: the engine is a plain
  // Swift package that knows nothing about the bridge. UIKit is a different
  // question -- it is platform, not JS -- so it is allowed, but only where it
  // cannot leak into a release build of the engine proper: behind `#if DEBUG`
  // (the spike control panel) or behind `#if canImport(UIKit)` (the heartbeat
  // logger's app-state read, which must still compile off-device).
  it('never imports React anywhere in the engine', () => {
    const offenders = swiftFiles().filter(name =>
      source(name).includes('import React'),
    );
    expect(offenders).toEqual([]);
  });

  it('imports UIKit only behind a DEBUG or canImport guard', () => {
    const offenders = swiftFiles().filter(name => {
      const text = source(name);
      if (!text.includes('import UIKit')) {
        return false;
      }
      return !text.includes('#if DEBUG') && !text.includes('#if canImport(UIKit)');
    });
    expect(offenders).toEqual([]);
  });
});

describe('RadioEngine (spec sections 6.3, 9.4, 13)', () => {
  const engine = source('RadioEngine.swift');

  it.each([
    'public final class RadioEngine',
    'public func startRadio()',
    'public func stopRadio()',
    'public func startTransmit()',
    'public func stopTransmit()',
    'public func getState(completion: @escaping (RadioState) -> Void)',
    'public func selectPttCandidate(deviceId: String)',
    'public func forgetPtt()',
    'public func addObserver(',
    'public func removeObserver(',
  ])('declares %s', declaration => {
    expect(engine).toContain(declaration);
  });

  it('mirrors the pairing session into state and clears it when it ends', () => {
    expect(engine).toContain('pairingStateDidChange state: PttPairingState?');
    expect(engine).toContain('state.pttPairing = nil');
  });

  it.each([
    'RadioTransportDelegate',
    'AudioIODelegate',
    'PttSourceDelegate',
    'BackgroundSessionDelegate',
  ])('conforms to %s', protocolName => {
    expect(engine).toContain(`extension RadioEngine: ${protocolName}`);
  });

  it('arms the safety cap from config, never from a literal', () => {
    expect(engine).toContain('RadioConfig.Transmit.safetyCapSeconds');
    expect(engine).not.toMatch(/=\s*120\b/);
  });

  it('asks the background session before it opens the microphone', () => {
    const request = engine.indexOf('background.requestBeginTransmitting()');
    const capture = engine.indexOf('audio.startCapture()');
    expect(request).toBeGreaterThan(-1);
    expect(capture).toBeGreaterThan(-1);
    expect(request).toBeLessThan(capture);
  });

  it('announces transmissions with the control protocol', () => {
    expect(engine).toContain('broadcastControl(.txStart(streamId:');
    expect(engine).toContain('broadcastControl(.txStop(streamId:');
  });

  it('serialises all state on one queue', () => {
    expect(engine).toContain('private let queue: DispatchQueue');
  });
});

describe('NearbyManager (spec section 7)', () => {
  const nearby = source('NearbyManager.swift');

  it.each([
    'public final class NearbyManager',
    'extension NearbyManager: AdvertiserDelegate',
    'extension NearbyManager: DiscovererDelegate',
    'extension NearbyManager: ConnectionManagerDelegate',
  ])('declares %s', declaration => {
    expect(nearby).toContain(declaration);
  });

  it('advertises and discovers on the shared service id', () => {
    expect(nearby).toContain('RadioConfig.serviceId');
    expect(nearby).toContain('startAdvertising');
    expect(nearby).toContain('startDiscovery');
  });

  it('uses the P2P_CLUSTER strategy', () => {
    expect(nearby).toContain('strategy: .cluster');
  });

  it('accepts every connection without a peer-selection UI', () => {
    expect(nearby).toContain('connectionRequestHandler(true)');
    expect(nearby).toContain('verificationHandler(true)');
  });

  it('gates peers behind the hello version handshake', () => {
    expect(nearby).toContain('.hello(version: RadioConfig.protocolVersion)');
    expect(nearby).toContain('RadioConfig.protocolVersion');
    expect(nearby).toContain('disconnect(from:');
  });

  it('frames audio with the shared framing helpers', () => {
    expect(nearby).toContain('AudioFraming.frame(');
    expect(nearby).toContain('AudioFrameParser()');
  });

  it('reconnects with backoff from config', () => {
    expect(nearby).toContain('RadioConfig.Reconnect.initialDelay');
    expect(nearby).toContain('RadioConfig.Reconnect.maxDelay');
    expect(nearby).toContain('RadioConfig.Reconnect.multiplier');
  });

  it('is the only file that imports NearbyConnections', () => {
    const importers = swiftFiles().filter(name =>
      source(name).includes('import NearbyConnections'),
    );
    expect(importers).toEqual(['NearbyManager.swift']);
  });
});

describe('Opus codec and jitter buffer (spec section 8)', () => {
  const codec = source('OpusCodec.swift');
  const jitter = source('JitterBuffer.swift');

  it.each([
    'public protocol OpusEncoding',
    'public protocol OpusDecoding',
    'func encode(_ pcm: Data) throws -> Data',
    'func decode(_ packet: Data) throws -> Data',
    'final class LibopusEncoder',
    'final class LibopusDecoder',
    'enum OpusFormat',
  ])('OpusCodec.swift declares %s', declaration => {
    expect(codec).toContain(declaration);
  });

  it('configures the codec from RadioConfig only', () => {
    expect(codec).toContain('RadioConfig.Audio.sampleRate');
    expect(codec).toContain('RadioConfig.Audio.channelCount');
    expect(codec).toContain('RadioConfig.Audio.bitrate');
    expect(codec).toContain('RadioConfig.Audio.maxEncodedFrameBytes');
    expect(codec).not.toMatch(/16_?000/);
  });

  it('is the only file that imports Opus', () => {
    const importers = swiftFiles().filter(name =>
      /^import Opus$/m.test(source(name)),
    );
    expect(importers).toEqual(['OpusCodec.swift']);
  });

  it.each([
    'public final class JitterBuffer',
    'public func push(_ frame: Data)',
    'public func pop() -> Data?',
    'public func reset()',
    'public private(set) var isPrimed',
  ])('JitterBuffer.swift declares %s', declaration => {
    expect(jitter).toContain(declaration);
  });

  it('takes its depth from config', () => {
    expect(jitter).toContain('RadioConfig.Audio.jitterTargetFrames');
    expect(jitter).toContain('RadioConfig.Audio.jitterMaxFrames');
  });
});

describe('AudioEngine (spec section 8)', () => {
  const audio = source('AudioEngine.swift');

  it.each([
    'public final class AudioEngine: AudioIO',
    'public func startPlayback() throws',
    'public func startCapture() throws',
    'public func beginIncoming(peerId: String)',
    'public func enqueue(frame: Data, from peerId: String)',
    'public func endIncoming(peerId: String)',
  ])('declares %s', declaration => {
    expect(audio).toContain(declaration);
  });

  it('captures through a tap and resamples to the codec format', () => {
    expect(audio).toContain('installTap(');
    expect(audio).toContain('AVAudioConverter(');
    expect(audio).toContain('OpusFormat.pcm');
  });

  it('mixes one player node per peer into the main mixer', () => {
    expect(audio).toContain('AVAudioPlayerNode()');
    expect(audio).toContain('mainMixerNode');
  });

  it('uses the shared codec and jitter buffer', () => {
    expect(audio).toContain('LibopusEncoder()');
    expect(audio).toContain('LibopusDecoder()');
    expect(audio).toContain('JitterBuffer()');
  });

  // Audio-session activation belongs to the `BackgroundSession` port -- today
  // `AlwaysHotBackgroundManager`, which activates once and keeps the session
  // hot -- because only it knows the route-detection order that activation
  // depends on. `AudioEngine` may activate in local-test builds (nothing else
  // does there), and nowhere else: an un-guarded `setActive` from here
  // re-activates mid-session and collapses the resolved route.
  it('leaves audio-session activation to the background session', () => {
    expect(unguardedSetActiveLines(audio)).toEqual([]);
  });
});

describe('AlwaysHotBackgroundManager (spec section 10.2)', () => {
  const background = source('AlwaysHotBackgroundManager.swift');

  it.each([
    'public final class AlwaysHotBackgroundManager: NSObject, BackgroundSession',
    'public func activate()',
    'public func deactivate()',
    'public func requestBeginTransmitting()',
    'public func stopTransmitting()',
    'public func setReceiving(',
  ])('declares %s', declaration => {
    expect(background).toContain(declaration);
  });

  it('is the only BackgroundSession implementation', () => {
    const implementations = swiftFiles().filter(name =>
      /:\s*NSObject,\s*BackgroundSession\b/.test(source(name)),
    );
    expect(implementations).toEqual(['AlwaysHotBackgroundManager.swift']);
  });

  it('configures a voice-chat session for play and record', () => {
    expect(background).toContain('.playAndRecord');
    expect(background).toContain('.voiceChat');
  });

  it('activates the session itself and tells the engine', () => {
    expect(background).toContain('setActive(true)');
    expect(background).toContain('backgroundSessionDidActivateAudio(self)');
  });

  // The whole point of always-hot: the session is activated once and never
  // released between transmissions, which is what keeps the process alive
  // while the screen is locked. Only `deactivate()` may stand it down.
  it('releases the session only when the radio stops', () => {
    const deactivate = background.indexOf('public func deactivate()');
    const nextMember = background.indexOf('public func requestBeginTransmitting()');
    const release = background.indexOf('.notifyOthersOnDeactivation');
    expect(deactivate).toBeGreaterThan(-1);
    expect(release).toBeGreaterThan(deactivate);
    expect(release).toBeLessThan(nextMember);
    expect(background.split('.notifyOthersOnDeactivation')).toHaveLength(2);
  });

  it('logs the session state a locked-screen run is judged by', () => {
    expect(background).toContain('HeartbeatLogger.shared.sessionActive');
    expect(background).toContain('HeartbeatLogger.shared.start()');
  });

  // PushToTalk was removed on 2026-08-18: its entitlement needs a paid Apple
  // Developer account, and on-device runs confirmed always-hot works without
  // it. Nothing may import the framework back in without revisiting spec 10.2.
  it('leaves no PushToTalk framework use anywhere in the engine', () => {
    const offenders = swiftFiles().filter(name => {
      const text = source(name);
      return text.includes('import PushToTalk') || text.includes('PTChannel');
    });
    expect(offenders).toEqual([]);
  });
});

describe('PTT subsystem (spec section 9)', () => {
  const binding = source('PttBinding.swift');
  const driver = source('BleGattPttDriver.swift');
  const manager = source('PttManager.swift');

  it.each([
    'public enum PttBinding',
    'case ble(',
    'case hid(keyCode: Int)',
    'public struct PttConfiguration',
    'public final class PttBindingStore',
    'public func load() -> PttConfiguration?',
    'public func save(_ configuration: PttConfiguration)',
    'public func clear()',
  ])('PttBinding.swift declares %s', declaration => {
    expect(binding).toContain(declaration);
  });

  it.each([
    'deviceId',
    'serviceUuid',
    'characteristicUuid',
    'pressedValue',
    'releasedValue',
  ])('keeps the spec 9.2 field name %s', field => {
    expect(binding).toContain(field);
  });

  it('persists to UserDefaults under the configured key', () => {
    expect(binding).toContain('RadioConfig.Ptt.bindingDefaultsKey');
    expect(binding).toContain('UserDefaults');
  });

  it.each([
    'public final class BleGattPttDriver',
    'extension BleGattPttDriver: CBCentralManagerDelegate',
    'extension BleGattPttDriver: CBPeripheralDelegate',
    'func selectCandidate(deviceId: String)',
  ])('BleGattPttDriver.swift declares %s', declaration => {
    expect(driver).toContain(declaration);
  });

  it('treats the strongest-signal pick as a timed fallback, not the path', () => {
    expect(driver).toContain('RadioConfig.Ptt.autoSelectFallback');
  });

  it('survives background relaunch with a restore identifier', () => {
    expect(driver).toContain('CBCentralManagerOptionRestoreIdentifierKey');
    expect(driver).toContain('willRestoreState');
  });

  it('learns by subscribing to notifying characteristics', () => {
    expect(driver).toContain('setNotifyValue(true');
    expect(driver).toContain('RadioConfig.Ptt.learningTimeout');
  });

  it.each([
    'public final class PttManager: PttSource',
    'public func beginLearning(',
    'public func selectCandidate(deviceId: String)',
    'public func forget()',
    'pttSourceDidPress(self)',
    'pttSourceDidRelease(self)',
  ])('PttManager.swift declares %s', declaration => {
    expect(manager).toContain(declaration);
  });

  it.each(['.scanning', '.learning', '.saved'])(
    'publishes the pairing phase %s',
    phase => {
      expect(manager).toContain(`phase: ${phase}`);
    },
  );

  it('publishes pairing progress as state, not as an event', () => {
    expect(manager).toContain('pairingStateDidChange: state');
    expect(manager).toContain('PttPairingState');
  });
});

describe('assembly and spike hooks (spec section 15, phase 0)', () => {
  const assembly = source('RadioAssembly.swift');
  const spike = source('RadioSpike.swift');
  const appDelegate = existsSync(
    join(__dirname, '..', 'ios', 'Oru', 'AppDelegate.swift'),
  )
    ? readFileSync(join(__dirname, '..', 'ios', 'Oru', 'AppDelegate.swift'), 'utf8')
    : '';

  it.each([
    'public final class RadioAssembly',
    'public static let shared',
    'public let engine: RadioEngine',
  ])('RadioAssembly.swift declares %s', declaration => {
    expect(assembly).toContain(declaration);
  });

  it('builds every production port exactly once', () => {
    expect(assembly).toContain('NearbyManager(');
    expect(assembly).toContain('AudioEngine(');
    expect(assembly).toContain('PttManager(');
    expect(assembly).toContain('AlwaysHotBackgroundManager()');
    expect(assembly).toContain('DispatchRadioClock(');
  });

  it.each([
    'public static func bootstrap()',
    'public static func startTransmit()',
    'public static func stopTransmit()',
    'public static func configurePtt(',
    'public static func selectPttCandidate(',
  ])('RadioSpike.swift declares %s', declaration => {
    expect(spike).toContain(declaration);
  });

  it('logs pairing candidates so a headless run can pick one', () => {
    expect(spike).toContain('state.pttPairing');
  });

  it('logs every engine event under one greppable prefix', () => {
    expect(spike).toContain('[spike]');
    expect(spike).toContain('addObserver(');
  });

  it('is bootstrapped from the app delegate in debug builds only', () => {
    expect(appDelegate).toContain('import RadioKit');
    expect(appDelegate).toContain('RadioSpike.bootstrap()');
    const guardIndex = appDelegate.indexOf('#if DEBUG');
    const callIndex = appDelegate.indexOf('RadioSpike.bootstrap()');
    expect(guardIndex).toBeGreaterThan(-1);
    expect(guardIndex).toBeLessThan(callIndex);
  });

  it('ships a phase 0 runbook covering all four scenarios', () => {
    const readme = existsSync(join(__dirname, '..', 'ios', 'Radio', 'README.md'))
      ? readFileSync(join(__dirname, '..', 'ios', 'Radio', 'README.md'), 'utf8')
      : '';
    for (const scenario of ['Scenario A', 'Scenario B', 'Scenario C', 'Scenario D']) {
      expect(readme).toContain(scenario);
    }
  });
});
