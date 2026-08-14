import {
  PttBindingParseError,
  parsePttBinding,
  parsePttConfiguration,
  serializePttBinding,
} from '../src/ptt/ptt.binding';
import type {NativePttBinding} from '../src/ptt/ptt.binding';
import type {PttBinding} from '../src/ptt/ptt.types';

const bleNative: NativePttBinding = {
  type: 'ble',
  deviceId: 'C4:2B:19:07:AA:31',
  serviceUuid: '0000fff0-0000-1000-8000-00805f9b34fb',
  characteristicUuid: '0000fff1-0000-1000-8000-00805f9b34fb',
  pressedValue: '01',
  releasedValue: '00',
};

const bleDomain: PttBinding = {
  type: 'ble',
  deviceId: 'C4:2B:19:07:AA:31',
  serviceUuid: '0000fff0-0000-1000-8000-00805f9b34fb',
  characteristicUuid: '0000fff1-0000-1000-8000-00805f9b34fb',
  pressedValue: '01',
  releasedValue: '00',
};

const hidNative: NativePttBinding = {type: 'hid', keyCode: 85};
const hidDomain: PttBinding = {type: 'hid', keyCode: 85};

// `it.each` is typed against mutable tuple arrays; never use `as const` with it,
// and never build cases with a computed key like `{...bleNative, [field]: undefined}`
// — a `string` computed key widens the object type and stops assigning.
const incompleteBleBindings: Array<[string, NativePttBinding]> = [
  ['deviceId', {...bleNative, deviceId: undefined}],
  ['serviceUuid', {...bleNative, serviceUuid: undefined}],
  ['characteristicUuid', {...bleNative, characteristicUuid: undefined}],
  ['pressedValue', {...bleNative, pressedValue: undefined}],
  ['releasedValue', {...bleNative, releasedValue: undefined}],
];

const invalidHidBindings: Array<[string, NativePttBinding]> = [
  ['a missing keyCode', {type: 'hid'}],
  ['a fractional keyCode', {type: 'hid', keyCode: 8.5}],
];

const roundTrips: Array<[string, PttBinding, NativePttBinding]> = [
  ['ble', bleDomain, bleNative],
  ['hid', hidDomain, hidNative],
];

describe('PttBinding parsing (spec section 9.2)', () => {
  it('narrows a BLE binding into the discriminated union', () => {
    expect(parsePttBinding(bleNative)).toEqual(bleDomain);
  });

  it('narrows a HID binding into the discriminated union', () => {
    expect(parsePttBinding(hidNative)).toEqual(hidDomain);
  });

  it.each(incompleteBleBindings)(
    'rejects a BLE binding missing %s',
    (field, raw) => {
      const result = parsePttBinding(raw);

      expect(result).toBeInstanceOf(PttBindingParseError);
      expect((result as PttBindingParseError).message).toContain(field);
    },
  );

  it('rejects a BLE binding with an empty field', () => {
    expect(parsePttBinding({...bleNative, pressedValue: ''})).toBeInstanceOf(
      PttBindingParseError,
    );
  });

  it.each(invalidHidBindings)('rejects a HID binding with %s', (_label, raw) => {
    expect(parsePttBinding(raw)).toBeInstanceOf(PttBindingParseError);
  });

  it.each(roundTrips)(
    'round-trips a %s binding through the native shape',
    (_label, domain, native) => {
      expect(serializePttBinding(domain)).toEqual(native);
      expect(parsePttBinding(serializePttBinding(domain))).toEqual(domain);
    },
  );

  it('rejects a binding whose type is neither ble nor hid', () => {
    expect(
      // The cast is the point: only a misbehaving native engine can produce this,
      // and the parser is the boundary that has to catch it.
      parsePttBinding({type: 'usb', keyCode: 85} as unknown as NativePttBinding),
    ).toBeInstanceOf(PttBindingParseError);
  });
});

describe('PttConfiguration parsing (spec section 6.1)', () => {
  it('parses a configuration produced by the learning flow', () => {
    expect(
      parsePttConfiguration({name: 'PTT Button', binding: bleNative}),
    ).toEqual({name: 'PTT Button', binding: bleDomain});
  });

  it('rejects a configuration with no device name', () => {
    expect(
      parsePttConfiguration({name: '', binding: bleNative}),
    ).toBeInstanceOf(PttBindingParseError);
  });

  it('propagates a binding failure', () => {
    expect(
      parsePttConfiguration({name: 'PTT Button', binding: {type: 'hid'}}),
    ).toBeInstanceOf(PttBindingParseError);
  });
});
