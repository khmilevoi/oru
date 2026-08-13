module.exports = {
  root: true,
  extends: '@react-native',
  overrides: [
    {
      files: [
        '.eslintrc.js',
        '*.config.js',
        'jest.config.js',
        'metro.config.js',
        'babel.config.js',
        'scripts/**/*.js',
        '__mocks__/**/*.js',
        'jest/**/*.js',
      ],
      // es2020 (not just node) is needed for `globalThis` itself: ESLint's
      // `node` environment predefines Node's own globals (`process`,
      // `require`, ...) but not `globalThis`, which is an ES2020 language
      // global available in any environment, not a Node-specific API.
      env: {node: true, es2020: true},
      rules: {
        'no-console': 'off',
      },
    },
  ],
};
