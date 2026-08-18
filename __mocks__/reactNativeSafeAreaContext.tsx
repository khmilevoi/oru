import React from 'react';
// Reaches the real package through a subpath so the top-level
// `react-native-safe-area-context` moduleNameMapper entry below does not
// intercept this require -- the library's own bundled Jest mock does exactly
// that (`jest.requireActual('react-native-safe-area-context')`) and, mapped
// straight back to this file, resolves to its own not-yet-finished exports.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const Real = require('react-native-safe-area-context/lib/commonjs/index.js');

// Stand-in for `react-native-safe-area-context` under Jest. `App.tsx` wraps
// the tree in `SafeAreaProvider`. The real component holds `insets` at
// `null` until a native `onInsetsChange` event arrives -- an event nothing
// under Jest ever sends -- so its children, the whole app, would never
// render at all. This mirrors the library's own Jest stand-in
// (`react-native-safe-area-context/jest/mock`): synchronous default insets,
// no native bridge, and the real `SafeAreaInsetsContext` /
// `SafeAreaFrameContext` so a consumer reading them behaves identically to
// production.
const MOCK_INITIAL_METRICS = {
  frame: {width: 320, height: 640, x: 0, y: 0},
  insets: {left: 0, right: 0, bottom: 0, top: 0},
};

const SafeAreaProvider = ({
  children,
  initialMetrics,
}: {
  children?: React.ReactNode;
  initialMetrics?: typeof MOCK_INITIAL_METRICS | null;
}) => (
  <Real.SafeAreaFrameContext.Provider
    value={initialMetrics?.frame ?? MOCK_INITIAL_METRICS.frame}>
    <Real.SafeAreaInsetsContext.Provider
      value={initialMetrics?.insets ?? MOCK_INITIAL_METRICS.insets}>
      {children}
    </Real.SafeAreaInsetsContext.Provider>
  </Real.SafeAreaFrameContext.Provider>
);

module.exports = {
  ...Real,
  initialWindowMetrics: MOCK_INITIAL_METRICS,
  SafeAreaProvider,
};
