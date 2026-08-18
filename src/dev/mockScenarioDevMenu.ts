import {DevSettings} from 'react-native';

import {MOCK_SCENARIOS, setMockScenario} from '../mock/mock.scenario';

/**
 * Spec section 6.5: "Switching scenarios inside a running dev build is one Dev
 * Menu entry per scenario, registered with `DevSettings.addMenuItem` under
 * `__DEV__`; tests set the scenario directly."
 *
 * P7 calls this once from app entry. It is a no-op outside a dev build.
 */
export type DevMenuHost = {
  addMenuItem(title: string, handler: () => void): void;
};

let registered = false;

export function registerMockScenarioDevMenu(
  host: DevMenuHost = DevSettings,
): void {
  if (!__DEV__ || registered) return;
  registered = true;

  MOCK_SCENARIOS.forEach(scenario => {
    host.addMenuItem(`Radio scenario: ${scenario}`, () => {
      setMockScenario(scenario);
    });
  });
}
