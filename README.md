# Oru

An offline push-to-talk radio for Android and iPhone, over Nearby Connections: no internet, no
accounts, no backend. Full design and rationale live in
[`docs/superpowers/specs/2026-08-13-offline-nearby-ptt-design.md`](docs/superpowers/specs/2026-08-13-offline-nearby-ptt-design.md).

## Requirements

- Node ≥ 22.11 (see `engines` in `package.json`) and pnpm (built against 10.14.0; pnpm 11.x
  also works — see the `node-linker` note under Install).
- The Android SDK and the Android Studio JBR (Java runtime), for Android.
- macOS with Xcode and CocoaPods, for iOS.

**iOS is built only on macOS, and no gate in this repository compiles Swift.** A green
`pnpm test` says nothing about whether the iOS build even compiles.

## Install

```bash
pnpm install
```

Both `.npmrc` and `pnpm-workspace.yaml` pin `node-linker`/`nodeLinker: hoisted`, which React
Native requires (its native-linking tooling expects a flat, hoisted `node_modules`, not pnpm's
default symlinked layout). Both files are needed: pnpm 11.x silently ignores `.npmrc`'s
`node-linker` and reads the setting from `pnpm-workspace.yaml` instead (`pnpm config get
node-linker` should print `hoisted`).

## Run on Android

In one shell:

```bash
pnpm start
```

In another:

```bash
pnpm android
```

`pnpm android` (`react-native run-android`) assumes an already-configured Android SDK/JDK on
`PATH`. If you'd rather not set that up, use `pnpm build:android` instead
(`scripts/build-android.js`): it resolves the SDK and a JDK itself, writes
`android/local.properties`, and pins `org.gradle.java.home`, so it works in a fresh shell with no
environment setup. Either way, the first run downloads Gradle, the NDK and CMake, and is slow.

## Run on iOS

From the repo root, once:

```bash
bundle install
```

Then, from `ios/`, every time native dependencies change:

```bash
cd ios && bundle exec pod install
```

Then, back in the repo root:

```bash
cd .. && pnpm ios
```

Two open native-side notes:

- The fonts folder reference in `ios/Oru.xcodeproj` is still an open Xcode step, recorded by P6
  — Xcode itself has to add it; it cannot be hand-edited into the `pbxproj` blind.
- The local `Radio` Swift package (`ios/Radio/Package.swift`) builds `RadioKit`, the iOS radio
  engine (Nearby Connections + Opus), as a Swift Package Manager dependency of the app.

## Permissions on first launch

Onboarding is three permission screens plus a done screen — microphone, Bluetooth, nearby
devices, done (`src/screens/OnboardingFlow.tsx`) — each explaining one permission before
triggering the system prompt. On Android there is a fourth, Android-only step
(`src/screens/BackgroundStep.tsx`) for `ACCESS_BACKGROUND_LOCATION`, which cannot be granted from
a normal permission dialog on API 30+ and needs its own "Allow all the time" Settings redirect.

On Android, the microphone, Bluetooth and location grants are required before the foreground
service will start; without them the radio reports `foreground_service_denied`. To pre-grant
them for testing (from `docs/stage3-bridge-acceptance.md`):

```bash
adb shell pm grant com.oru android.permission.RECORD_AUDIO
```

(plus the Bluetooth and location grants listed in `docs/phase0-android-spike-hooks.md`).

## The mock backend

`RADIO_BACKEND=mock` builds the app against the §6.5 mock engine and the mock permission
gateway — this is how design work, demos and screenshots run, and it's what the Jest suite runs
against unconditionally. Under `__DEV__`, the Dev Menu carries one entry per mock scenario
(`src/dev/mockScenarioDevMenu.ts`), letting you switch scenarios inside a running dev build.

**The default backend, in both dev and release, is the real native one.** `RADIO_BACKEND=mock`
is the opt-in:

```bash
RADIO_BACKEND=mock pnpm start --reset-cache
RADIO_BACKEND=mock pnpm android   # or: RADIO_BACKEND=mock pnpm ios
```

`RADIO_BACKEND` is inlined at transform time by `babel-plugin-transform-inline-environment-variables`
(`babel.config.js`), and Metro's transform cache key does not include `process.env` — the same
gotcha `jest.config.js` documents for `babel-jest`. Switching backends on a machine with an
existing Metro cache can silently reuse a transform compiled under the old value, so clear the
cache on the Metro side — `pnpm start --reset-cache` — and set `RADIO_BACKEND` the same way for
both the Metro shell and the build shell.

## Locales

English by default, Russian for a `ru` system locale; there is no in-app language picker. Copy
lives in `src/locales/{en,ru}/messages.po` and is regenerated with `pnpm lingui:extract`.

## Tests and gates

```bash
pnpm typecheck    # tsc --noEmit
pnpm lint         # eslint . --ext .js,.jsx,.ts,.tsx
pnpm test         # jest
pnpm build:android
```

The JS suite runs entirely against the mock: `jest.config.js` pins `RADIO_BACKEND=mock`
unconditionally, so a green suite says nothing about a device — it only proves the app's
behaviour against the mock engine's scenarios.

## Acceptance on real hardware

Automated gates cannot stand in for a device. **Physical devices are the only source of truth
for Nearby, BLE and background behaviour** (§16) — simulators cannot emulate them. Manual
acceptance checklists executed on real Android + iPhone hardware:

- [`docs/stage3-bridge-acceptance.md`](docs/stage3-bridge-acceptance.md) — the RadioNative
  bridge.
- [`docs/stage4-integration-acceptance.md`](docs/stage4-integration-acceptance.md) — this
  integration stage.

## Layout

```text
src/            TypeScript app: screens, Reatom models, the radio/permissions ports, UI kit
android/app/src/main/java/com/oru/   Kotlin: the Turbo Module bridge and the native radio engine
ios/            Swift app plus the local `Radio` (RadioKit) Swift package
specs/          Codegen'd Turbo Module spec (`NativeRadio.ts`)
docs/           Design spec, manual acceptance checklists, and planning notes
```
