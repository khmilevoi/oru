import {getMockScenario, onMockScenarioChange} from '../mock/mock.scenario';
import type {MockScenarioName} from '../mock/mock.scenario';
import type {PermissionStatus, PermissionsBackend} from './permissions.types';
import type {ResolvePermissions} from './permissions.port';

/**
 * Spec section 6.5: under the `onboarding` scenario "the scripted permission
 * gateway answers granted / denied / permanently-denied in turn", so one
 * walkthrough of the three onboarding steps exercises all three branches.
 * Every other scenario grants, so the pairing and radio scenarios are never
 * blocked behind a permission wall.
 *
 * The cursor below (`index`, in `createMockPermissions`) advances once per
 * `request()` *call*, not once per permission: a retry of the same
 * permission (Allow pressed again after a denial) consumes the next scripted
 * answer too, it does not repeat the previous one. Once the script runs out,
 * every further call repeats its last answer rather than throwing or
 * returning `undefined`.
 *
 * Under `onboarding` this means the third permission the user reaches
 * (`nearbyDevices`, per `APP_PERMISSIONS`'s order
 * microphone/bluetooth/nearbyDevices) is always answered `blocked`, never
 * `granted`: the first Allow press consumes `'granted'`, the second (for the
 * permission the walkthrough denies) consumes `'denied'`, and every call
 * after that — including the one for `nearbyDevices` — lands on the
 * script's last entry, `'blocked'`. The "Ready" screen at the end of
 * onboarding is therefore reachable only by pressing Skip past
 * `nearbyDevices`, never by granting it. Both
 * `__tests__/onboarding-flow.test.tsx` and `__tests__/stage2-acceptance.test.tsx`
 * walk exactly this path and depend on it silently.
 */
const SCRIPTS: Record<MockScenarioName, readonly PermissionStatus[]> = {
  happy: ['granted'],
  solo: ['granted'],
  'pairing-success': ['granted'],
  'pairing-empty': ['granted'],
  'button-lost': ['granted'],
  'engine-error': ['granted'],
  onboarding: ['granted', 'denied', 'blocked'],
};

export type MockPermissions = PermissionsBackend & {
  /** Rewinds the script to its first answer. */
  reset(): void;
  /** How many times `openSettings()` has been called since the last reset. */
  openSettingsCalls(): number;
};

export function createMockPermissions(): MockPermissions {
  let index = 0;
  let settingsCalls = 0;

  return {
    async request() {
      const script = SCRIPTS[getMockScenario()];
      // The last scripted answer repeats: a screen that retries a blocked
      // permission must keep getting `blocked`, not fall off the end.
      const answer = script[Math.min(index, script.length - 1)];
      index += 1;

      return answer;
    },

    async openSettings() {
      settingsCalls += 1;
    },

    reset() {
      index = 0;
      settingsCalls = 0;
    },

    openSettingsCalls: () => settingsCalls,
  };
}

export const mockPermissions: MockPermissions = createMockPermissions();

onMockScenarioChange(() => {
  mockPermissions.reset();
});

export const resolveMockPermissions: ResolvePermissions = () => mockPermissions;
