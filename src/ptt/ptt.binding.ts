import * as errore from 'errore';

import type {PttBinding, PttConfiguration} from './ptt.types';

/**
 * The flat, Codegen-expressible counterpart of `PttBinding`. React Native's
 * Codegen only supports unions of string literals, so the discriminated union
 * of section 9.2 cannot cross the bridge as such: it travels as one object
 * with a `type` discriminant and optional fields, and is narrowed here.
 *
 * `specs/NativeRadio.ts` declares the same shape for Codegen. The two are kept
 * structurally identical on purpose; `radio.native.ts` proves it at compile
 * time by feeding the spec's type into `parsePttConfiguration`.
 */
export type NativePttBinding = {
  type: 'ble' | 'hid';
  deviceId?: string;
  serviceUuid?: string;
  characteristicUuid?: string;
  pressedValue?: string;
  releasedValue?: string;
  keyCode?: number;
};

export type NativePttConfiguration = {
  name: string;
  binding: NativePttBinding;
};

export class PttBindingParseError extends errore.createTaggedError({
  name: 'PttBindingParseError',
  message: 'Cannot parse $bindingType PTT binding: $reason',
}) {}

function requireText(value: string | undefined) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function parsePttBinding(raw: NativePttBinding) {
  /**
   * `raw` crosses the Turbo Module bridge from a WritableMap (Android) or a
   * dictionary (iOS): the declared `NativePttBinding` type is not enforced at
   * runtime there, so an entirely absent or non-object binding value is
   * possible and must not reach `raw.type` below. The cast is what lets the
   * guard typecheck against a param TypeScript otherwise considers always an
   * object.
   */
  const value = raw as NativePttBinding | null | undefined;
  if (typeof value !== 'object' || value === null) {
    return new PttBindingParseError({
      bindingType: 'unknown',
      reason: 'binding payload is not an object',
    });
  }

  if (value.type === 'ble') {
    const deviceId = requireText(raw.deviceId);
    if (deviceId === null) {
      return new PttBindingParseError({bindingType: 'ble', reason: 'missing deviceId'});
    }

    const serviceUuid = requireText(raw.serviceUuid);
    if (serviceUuid === null) {
      return new PttBindingParseError({bindingType: 'ble', reason: 'missing serviceUuid'});
    }

    const characteristicUuid = requireText(raw.characteristicUuid);
    if (characteristicUuid === null) {
      return new PttBindingParseError({
        bindingType: 'ble',
        reason: 'missing characteristicUuid',
      });
    }

    const pressedValue = requireText(raw.pressedValue);
    if (pressedValue === null) {
      return new PttBindingParseError({bindingType: 'ble', reason: 'missing pressedValue'});
    }

    const releasedValue = requireText(raw.releasedValue);
    if (releasedValue === null) {
      return new PttBindingParseError({bindingType: 'ble', reason: 'missing releasedValue'});
    }

    const binding: PttBinding = {
      type: 'ble',
      deviceId,
      serviceUuid,
      characteristicUuid,
      pressedValue,
      releasedValue,
    };
    return binding;
  }

  if (raw.type === 'hid') {
    if (typeof raw.keyCode !== 'number' || !Number.isInteger(raw.keyCode)) {
      return new PttBindingParseError({
        bindingType: 'hid',
        reason: 'missing or non-integer keyCode',
      });
    }

    const binding: PttBinding = {type: 'hid', keyCode: raw.keyCode};
    return binding;
  }

  return new PttBindingParseError({
    bindingType: String(raw.type),
    reason: 'unknown binding type',
  });
}

export function serializePttBinding(binding: PttBinding): NativePttBinding {
  if (binding.type === 'ble') {
    return {
      type: 'ble',
      deviceId: binding.deviceId,
      serviceUuid: binding.serviceUuid,
      characteristicUuid: binding.characteristicUuid,
      pressedValue: binding.pressedValue,
      releasedValue: binding.releasedValue,
    };
  }

  return {type: 'hid', keyCode: binding.keyCode};
}

export function parsePttConfiguration(raw: NativePttConfiguration) {
  /**
   * As in `parsePttBinding`: `raw` crosses the native bridge, where nothing
   * enforces the declared shape at runtime. `configurePtt()` can resolve with
   * an entirely missing `binding` key, and both dereferences below —
   * `raw.binding.type` in the missing-name branch and the `raw.binding` fed to
   * `parsePttBinding` — would throw on that payload without this guard. The
   * cast is what lets the check typecheck against a param TypeScript
   * otherwise considers always a well-formed object.
   */
  const payload = raw as NativePttConfiguration | null | undefined;
  if (typeof payload !== 'object' || payload === null) {
    return new PttBindingParseError({
      bindingType: 'unknown',
      reason: 'configuration payload is not an object',
    });
  }

  const binding = payload.binding as NativePttBinding | null | undefined;
  if (typeof binding !== 'object' || binding === null) {
    return new PttBindingParseError({
      bindingType: 'unknown',
      reason: 'missing binding',
    });
  }

  const name = requireText(payload.name);
  if (name === null) {
    return new PttBindingParseError({
      bindingType: binding.type,
      reason: 'missing device name',
    });
  }

  const parsedBinding = parsePttBinding(binding);
  if (parsedBinding instanceof Error) return parsedBinding;

  const configuration: PttConfiguration = {name, binding: parsedBinding};
  return configuration;
}
