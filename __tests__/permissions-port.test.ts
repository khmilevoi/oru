import {
  DEFAULT_MOCK_SCENARIO,
  setMockScenario,
} from '../src/mock/mock.scenario';
import {
  PermissionsUnavailableError,
  createPermissions,
} from '../src/permissions/permissions.port';
import {Permissions} from '../src/permissions/permissions.port';
import {mockPermissions} from '../src/permissions/permissions.mock';

describe('the permission port — spec section 6.4', () => {
  beforeEach(() => {
    setMockScenario(DEFAULT_MOCK_SCENARIO);
    mockPermissions.reset();
  });

  it('grants everything outside the onboarding scenario', async () => {
    await expect(Permissions.request('microphone')).resolves.toBe('granted');
    await expect(Permissions.request('bluetooth')).resolves.toBe('granted');
    await expect(Permissions.request('nearbyDevices')).resolves.toBe('granted');
  });

  it('answers granted, denied and blocked in turn under onboarding', async () => {
    setMockScenario('onboarding');
    mockPermissions.reset();

    await expect(Permissions.request('microphone')).resolves.toBe('granted');
    await expect(Permissions.request('bluetooth')).resolves.toBe('denied');
    await expect(Permissions.request('nearbyDevices')).resolves.toBe('blocked');
  });

  it('repeats the last scripted answer once the script runs out', async () => {
    setMockScenario('onboarding');
    mockPermissions.reset();

    await Permissions.request('microphone');
    await Permissions.request('bluetooth');
    await Permissions.request('nearbyDevices');

    await expect(Permissions.request('nearbyDevices')).resolves.toBe('blocked');
  });

  it('restarts the script when the scenario is re-selected', async () => {
    setMockScenario('onboarding');
    mockPermissions.reset();
    await Permissions.request('microphone');

    setMockScenario('onboarding');

    await expect(Permissions.request('microphone')).resolves.toBe('granted');
  });

  it('opens settings without throwing', async () => {
    await expect(Permissions.openSettings()).resolves.toBeNull();
  });

  it('returns the unavailable error instead of throwing, per section 13', async () => {
    const unavailable = createPermissions(
      () => new PermissionsUnavailableError({platform: 'test'}),
    );

    const result = await unavailable.request('microphone');

    expect(result).toBeInstanceOf(PermissionsUnavailableError);
  });

  it('turns a rejecting backend into a returned error', async () => {
    const failing = createPermissions(() => ({
      request: () => Promise.reject(new Error('boom')),
      openSettings: () => Promise.resolve(),
    }));

    const result = await failing.request('bluetooth');

    expect(result).toBeInstanceOf(Error);
    expect(result).not.toBe('granted');
  });
});
