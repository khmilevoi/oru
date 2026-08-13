import * as errore from 'errore';

/**
 * Spec section 7. Control messages travel as reliable Nearby BYTES payloads
 * carrying JSON. This module is the executable definition of that wire format:
 * the Kotlin and Swift codecs must produce and accept exactly these bytes.
 * JavaScript never sends one itself — the engine does — so this file has no
 * dependency on React Native, Reatom or the rest of the app.
 */

/** The only protocol version this build speaks. */
export const CONTROL_PROTOCOL_VERSION = 1;

export type HelloMessage = {type: 'hello'; version: 1};
export type TxStartMessage = {type: 'tx-start'; streamId: string};
export type TxStopMessage = {type: 'tx-stop'; streamId: string};

export type ControlMessage = HelloMessage | TxStartMessage | TxStopMessage;

/**
 * `JSON.parse` returns `any`, and casting it to `unknown` would be worse: an
 * `Error | unknown` union collapses to `unknown` and every `instanceof Error`
 * narrowing below would lose the error class. A concrete JSON type keeps the
 * union honest and removes the need for a single cast in the decoder.
 */
type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | {[key: string]: JsonValue};

export class ControlMessageDecodeError extends errore.createTaggedError({
  name: 'ControlMessageDecodeError',
  message: 'Cannot decode control message: $reason',
}) {}

/**
 * Kept separate from a plain decode failure because section 7 gives it its own
 * behaviour: on a hello version mismatch the peer is disconnected gracefully
 * and ignored, rather than treated as a corrupt payload.
 */
export class ControlProtocolVersionError extends errore.createTaggedError({
  name: 'ControlProtocolVersionError',
  message: 'Unsupported control protocol version $version, expected $expected',
}) {}

export function encodeControlMessage(message: ControlMessage): string {
  return JSON.stringify(message);
}

export function decodeControlMessage(raw: string) {
  const parsed = errore.try({
    try: () => JSON.parse(raw) as JsonValue,
    catch: cause => new ControlMessageDecodeError({reason: 'not valid JSON', cause}),
  });
  if (parsed instanceof Error) return parsed;

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return new ControlMessageDecodeError({reason: 'not a JSON object'});
  }

  if (parsed.type === 'hello') {
    if (parsed.version !== CONTROL_PROTOCOL_VERSION) {
      return new ControlProtocolVersionError({
        version: typeof parsed.version === 'number' ? parsed.version : 'none',
        expected: CONTROL_PROTOCOL_VERSION,
      });
    }

    const hello: HelloMessage = {type: 'hello', version: CONTROL_PROTOCOL_VERSION};
    return hello;
  }

  if (parsed.type === 'tx-start' || parsed.type === 'tx-stop') {
    if (typeof parsed.streamId !== 'string' || parsed.streamId.length === 0) {
      return new ControlMessageDecodeError({
        reason: `${parsed.type} without a streamId`,
      });
    }

    const message: TxStartMessage | TxStopMessage = {
      type: parsed.type,
      streamId: parsed.streamId,
    };
    return message;
  }

  return new ControlMessageDecodeError({
    reason: `unknown message type ${String(parsed.type)}`,
  });
}
