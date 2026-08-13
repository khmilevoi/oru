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
    // Jest never runs the Metro .po transformer; map catalogs to a stand-in.
    '\\.po$': '<rootDir>/__mocks__/poCatalog.js',
  },
  transform: {
    ...preset.transform,
    // The preset's pattern omits .mjs; @lingui/core and @lingui/react ship
    // .mjs entry points only.
    '^.+\\.(js|mjs|ts|tsx)$': 'babel-jest',
  },
  transformIgnorePatterns: [
    // @lingui/core pulls in @messageformat/date-skeleton and
    // @messageformat/parser, which also ship ESM-only ("type": "module")
    // packages with no CJS entry point.
    'node_modules/(?!((jest-)?react-native|@react-native(-community)?|@lingui|@messageformat|errore)/)',
  ],
  // @reatom/core@1001.3.0 eagerly opens a `new BroadcastChannel(...)` at
  // module load time (its default `withBroadcastChannel` singleton) and
  // never closes it, which leaks a handle under Node's real, global
  // `BroadcastChannel` and hangs Jest after it prints results. Rather than
  // hiding that (and any future) leaked handle from Jest with `forceExit`,
  // remove `globalThis.BroadcastChannel` before any test module — including
  // `@reatom/core` — is imported, so reatom takes its own documented
  // in-memory fallback instead of opening a channel at all. See
  // jest/disableBroadcastChannel.js for the full rationale.
  setupFiles: [
    ...(preset.setupFiles ?? []),
    '<rootDir>/jest/disableBroadcastChannel.js',
  ],
};
