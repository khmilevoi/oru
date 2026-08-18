import * as errore from 'errore';

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
 * P7 owns the real implementation: first-launch permission sequencing against
 * the actual OS prompts (spec section 11, including the two-step
 * ACCESS_BACKGROUND_LOCATION redirect). Until then the native branch reports
 * itself unavailable rather than lying about a grant -- and there is no release
 * build to reach it, because app entry is P7's too.
 */
export const resolveNativePermissions: ResolvePermissions = () =>
  new PermissionsUnavailableError({platform: 'native'});

/**
 * Spec section 6.5's flag, resolved locally. The expression is repeated here
 * rather than imported from a shared module on purpose: Babel inlines
 * `__DEV__` and `process.env.RADIO_BACKEND` per module, and Metro folds
 * constants per module, so an imported constant would not fold and the mock
 * backend would survive into a release bundle.
 */
const backend: 'mock' | 'native' = __DEV__
  ? process.env.RADIO_BACKEND === 'native'
    ? 'native'
    : 'mock'
  : 'native';

export const Permissions: PermissionsPort = createPermissions(
  backend === 'mock'
    ? (require('./permissions.mock') as typeof import('./permissions.mock'))
        .resolveMockPermissions
    : resolveNativePermissions,
);
