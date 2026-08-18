/**
 * Spec section 12.1 typography. `assets` is what `npx react-native-asset` reads
 * when the iOS project is refreshed on macOS at closeout; Android compiles the
 * same directory directly (see android/app/build.gradle) and iOS lists the six
 * faces in ios/Oru/Info.plist's UIAppFonts.
 */
module.exports = {
  assets: ['./assets/fonts'],
};
