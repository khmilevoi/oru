/**
 * Spec section 9.2 verbatim. These are the shapes the app reasons about; the
 * flat shape that crosses the Turbo Module bridge lives in `ptt.binding.ts`
 * and in `specs/NativeRadio.ts`.
 */

export type BlePttBinding = {
  type: 'ble';
  deviceId: string;
  serviceUuid: string;
  characteristicUuid: string;
  pressedValue: string;
  releasedValue: string;
};

export type HidPttBinding = {
  type: 'hid';
  keyCode: number;
};

export type PttBinding = BlePttBinding | HidPttBinding;

/** Spec section 6.1: the result of the learning flow. */
export type PttConfiguration = {
  name: string;
  binding: PttBinding;
};
