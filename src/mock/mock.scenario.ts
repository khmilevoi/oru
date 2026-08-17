/**
 * Spec section 6.5's seven named scenarios, and the process-wide choice of
 * which one is running.
 *
 * Deliberately a plain module singleton rather than an atom: both consumers
 * (the mock engine and the mock permission backend) sit *below* the Reatom
 * model, and the Dev Menu switches scenarios from a callback that runs outside
 * any Reatom frame.
 */

export type MockScenarioName =
  | 'happy'
  | 'solo'
  | 'pairing-success'
  | 'pairing-empty'
  | 'button-lost'
  | 'engine-error'
  | 'onboarding';

export const MOCK_SCENARIOS: readonly MockScenarioName[] = [
  'happy',
  'solo',
  'pairing-success',
  'pairing-empty',
  'button-lost',
  'engine-error',
  'onboarding',
];

export const DEFAULT_MOCK_SCENARIO: MockScenarioName = 'happy';

type ScenarioListener = (scenario: MockScenarioName) => void;

let current: MockScenarioName = DEFAULT_MOCK_SCENARIO;
const listeners = new Set<ScenarioListener>();

export const getMockScenario = (): MockScenarioName => current;

export function setMockScenario(scenario: MockScenarioName): void {
  current = scenario;
  listeners.forEach(listener => listener(scenario));
}

export function onMockScenarioChange(listener: ScenarioListener): () => void {
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
  };
}
