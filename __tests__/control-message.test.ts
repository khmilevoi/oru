import {
  CONTROL_PROTOCOL_VERSION,
  ControlMessageDecodeError,
  ControlProtocolVersionError,
  decodeControlMessage,
  encodeControlMessage,
} from '../src/radio/control-message';
import type {ControlMessage} from '../src/radio/control-message';

const STREAM_ID = '8f1c9a52-3f0e-4d1a-9c2b-6f0f1d7a4e55';

const messages: ControlMessage[] = [
  {type: 'hello', version: 1},
  {type: 'tx-start', streamId: STREAM_ID},
  {type: 'tx-stop', streamId: STREAM_ID},
];

// `it.each` is typed against mutable tuple arrays; never use `as const` with it.
const roundTripCases: Array<[string, ControlMessage]> = messages.map(
  (message): [string, ControlMessage] => [message.type, message],
);

describe('control message codec (spec section 7)', () => {
  it('speaks protocol version 1', () => {
    expect(CONTROL_PROTOCOL_VERSION).toBe(1);
  });

  it.each(roundTripCases)('round-trips %s', (_type, message) => {
    expect(decodeControlMessage(encodeControlMessage(message))).toEqual(message);
  });

  it('encodes exactly the JSON the native codecs read', () => {
    expect(encodeControlMessage({type: 'tx-start', streamId: 'abc'})).toBe(
      '{"type":"tx-start","streamId":"abc"}',
    );
    expect(encodeControlMessage({type: 'hello', version: 1})).toBe(
      '{"type":"hello","version":1}',
    );
  });

  it('rejects payloads that are not JSON and keeps the cause', () => {
    const result = decodeControlMessage('definitely not json');

    expect(result).toBeInstanceOf(ControlMessageDecodeError);
    expect((result as ControlMessageDecodeError).cause).toBeDefined();
  });

  it.each([
    ['a JSON array', '[]'],
    ['a JSON string', '"hello"'],
    ['null', 'null'],
  ])('rejects %s', (_label, raw) => {
    expect(decodeControlMessage(raw)).toBeInstanceOf(ControlMessageDecodeError);
  });

  it('rejects an unknown message type', () => {
    expect(decodeControlMessage('{"type":"goodbye"}')).toBeInstanceOf(
      ControlMessageDecodeError,
    );
  });

  it.each([
    ['a missing streamId', '{"type":"tx-start"}'],
    ['an empty streamId', '{"type":"tx-stop","streamId":""}'],
    ['a non-string streamId', '{"type":"tx-start","streamId":7}'],
  ])('rejects tx messages with %s', (_label, raw) => {
    expect(decodeControlMessage(raw)).toBeInstanceOf(ControlMessageDecodeError);
  });

  it('reports a hello version mismatch as its own error, so the peer can be dropped', () => {
    const result = decodeControlMessage('{"type":"hello","version":2}');

    expect(result).toBeInstanceOf(ControlProtocolVersionError);
    expect((result as ControlProtocolVersionError).version).toBe(2);
    expect((result as ControlProtocolVersionError).expected).toBe(1);
  });

  it('rejects a hello with no version at all', () => {
    expect(decodeControlMessage('{"type":"hello"}')).toBeInstanceOf(
      ControlProtocolVersionError,
    );
  });
});
