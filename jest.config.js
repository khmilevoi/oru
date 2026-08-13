const preset = require('@react-native/jest-preset');

/** @type {import('jest').Config} */
module.exports = {
  preset: '@react-native/jest-preset',
  // The preset's own entries are spread back in explicitly so this config is
  // correct however Jest chooses to merge preset keys. Losing
  // preset.moduleNameMapper would break every `react-native` import.
  moduleNameMapper: {
    ...preset.moduleNameMapper,
    // errore publishes an "exports" map with only an "import" condition, so a
    // CommonJS require() cannot resolve it. Point Jest at the file directly.
    '^errore$': '<rootDir>/node_modules/errore/dist/index.js',
  },
  transform: {
    ...preset.transform,
    // The preset's pattern omits .mjs; @lingui/core and @lingui/react ship
    // .mjs entry points only.
    '^.+\\.(js|mjs|ts|tsx)$': 'babel-jest',
  },
  transformIgnorePatterns: [
    'node_modules/(?!((jest-)?react-native|@react-native(-community)?|@lingui|errore)/)',
  ],
  // @reatom/core@1001.3.0 eagerly opens a `new BroadcastChannel(...)` at
  // module load time (its default `withBroadcastChannel` singleton) and
  // never closes it. Node >=18 exposes a real, global `BroadcastChannel`
  // (unlike a browser-only jsdom polyfill), so that open channel is a real
  // handle that keeps the process's event loop alive: without this flag the
  // whole Jest process — single file or full suite alike — hangs forever
  // after printing results instead of exiting. Confirmed empirically in this
  // environment (Node v26.5.0): the same run finishes in under a second with
  // `forceExit` and never exits without it. There is no supported reatom API
  // to close that channel from test code, so `forceExit` is the sanctioned
  // Jest mechanism for exactly this situation.
  forceExit: true,
};
