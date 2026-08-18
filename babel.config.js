module.exports = {
  presets: ['module:@react-native/babel-preset'],
  plugins: [
    '@lingui/babel-plugin-lingui-macro',
    // Spec section 6.5: RADIO_BACKEND must be a compile-time constant so that
    // Metro folds the backend choice in src/radio/radio.native.ts and drops the
    // mock module from release bundles before it collects dependencies.
    // `include` is mandatory -- without it this plugin inlines the whole
    // process environment into the bundle.
    ['transform-inline-environment-variables', {include: ['RADIO_BACKEND']}],
  ],
};
