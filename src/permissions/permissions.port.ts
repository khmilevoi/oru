import * as errore from 'errore';
import {Platform} from 'react-native';

import {
  androidPermissionsBackend,
  iosPermissionsBackend,
} from './permissions.native';
import type {
  AppPermission,
  PermissionStatus,
  PermissionsBackend,
} from './permissions.types';

export class PermissionsUnavailableError extends errore.createTaggedError({
  name: 'PermissionsUnavailableError',
  message: 'No runtime permission backend is registered for $platform',
}) {}

export class PermissionsCallError extends errore.createTaggedError({
  name: 'PermissionsCallError',
  message: 'Permissions.$method failed',
}) {}

export type PermissionsError =
  | PermissionsUnavailableError
  | PermissionsCallError;

export type PermissionsPort = {
  request(
    permission: AppPermission,
  ): Promise<PermissionsError | PermissionStatus>;
  openSettings(): Promise<PermissionsError | null>;
};

export type ResolvePermissions = () =>
  | PermissionsUnavailableError
  | PermissionsBackend;

/**
 * The same seam as `createRadioNative(resolve)`: resolution happens per call,
 * so importing this module is always safe, and nothing here throws (section
 * 13 -- fallible functions return `Error | T`).
 */
export function createPermissions(
  resolve: ResolvePermissions,
): PermissionsPort {
  return {
    async request(permission) {
      const backend = resolve();
      if (backend instanceof Error) return backend;

      try {
        return await backend.request(permission);
      } catch (cause) {
        return new PermissionsCallError({method: 'request', cause});
      }
    },

    async openSettings() {
      const backend = resolve();
      if (backend instanceof Error) return backend;

      try {
        await backend.openSettings();
        return null;
      } catch (cause) {
        return new PermissionsCallError({method: 'openSettings', cause});
      }
    },
  };
}

/**
 * The real runtime prompts (spec section 11). Android goes through
 * `PermissionsAndroid`; iOS has no pre-request API and prompts at first use --
 * see `permissions.native.ts` for why its backend answers the way it does.
 */
export const resolveNativePermissions: ResolvePermissions = () => {
  if (Platform.OS === 'android') return androidPermissionsBackend;
  if (Platform.OS === 'ios') return iosPermissionsBackend;
  return new PermissionsUnavailableError({platform: Platform.OS});
};

/**
 * Spec section 6.5's flag, resolved locally. The expression is repeated here
 * rather than imported from a shared module on purpose: Babel inlines
 * `__DEV__` and `process.env.RADIO_BACKEND` per module, and Metro folds
 * constants per module, so an imported constant would not fold and the mock
 * backend would survive into a release bundle.
 *
 * The dev default is `native` as of section 15 Stage 4, matching
 * `radio.native.ts`: onboarding now reaches the real OS prompts.
 * `RADIO_BACKEND=mock` remains the way design work, demos, screenshots and the
 * Jest suite run, and `jest.config.js` pins it.
 */
const backend: 'mock' | 'native' = __DEV__
  ? process.env.RADIO_BACKEND === 'mock'
    ? 'mock'
    : 'native'
  : 'native';

export const Permissions: PermissionsPort = createPermissions(
  backend === 'mock'
    ? (require('./permissions.mock') as typeof import('./permissions.mock'))
        .resolveMockPermissions
    : resolveNativePermissions,
);
