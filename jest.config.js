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
  // `.claude/worktrees/<plan>` holds live agent worktrees: full, checked-out
  // copies of this project whose code is unfinished by construction. They are
  // git-ignored, but git-ignoring a path does not hide it from Jest, so
  // without these two keys a run in the main checkout discovers every
  // worktree's `__tests__/` as well as its own -- reporting, when one worktree
  // existed, 14 suites / 104 tests instead of 7 / 52, and failing the trunk's
  // gate for work that is not on the trunk.
  //
  // Both keys are needed and they do different jobs: testPathIgnorePatterns
  // stops test *discovery*, while modulePathIgnorePatterns keeps the worktrees
  // out of the haste map -- each one carries a package.json named "oru", so
  // two or more concurrent worktrees would otherwise collide by name.
  //
  // The preset defines neither key, so nothing is being overridden here. Note
  // that Jest's own default for testPathIgnorePatterns is ["/node_modules/"]
  // and setting the key replaces it, which is why node_modules is repeated.
  testPathIgnorePatterns: ['/node_modules/', '[\\\\/]\\.claude[\\\\/]'],
  modulePathIgnorePatterns: ['[\\\\/]\\.claude[\\\\/]'],
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
