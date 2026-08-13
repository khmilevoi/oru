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
      ],
      env: {node: true},
      rules: {
        'no-console': 'off',
      },
    },
  ],
};
