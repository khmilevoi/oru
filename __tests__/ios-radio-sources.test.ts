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
  it('never imports React or UIKit anywhere in the engine', () => {
    const offenders = swiftFiles().filter(name => {
      const text = source(name);
      return text.includes('import React') || text.includes('import UIKit');
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

  it('asks PushToTalk before it opens the microphone', () => {
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
