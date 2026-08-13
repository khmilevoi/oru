# P1 `bootstrap` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the bare React Native project, the four gate scripts every later plan is verified against, all JS runtime dependencies, the §11 permission declarations, and the §17 directory skeleton — so that plans P2–P7 add code and never touch the toolchain.

**Architecture:** The repository is greenfield: it currently holds two Markdown documents and nothing else. Task 1 materialises a bare React Native 0.87.0 project (New Architecture, TypeScript) from the official community template, installs it with pnpm under a hoisted node linker, and replaces the "works on my machine" build story with a Node script that resolves the Android SDK and JDK from well-known locations, writes `android/local.properties` itself, and pins `org.gradle.java.home` — so `pnpm build:android` runs in a fresh shell and a fresh git worktree with no environment setup at all. Tasks 2–6 then add exactly the declarative surface later plans consume: the §17 directories, the §11 permission declarations on both platforms, the runtime dependencies with the Jest interop they need to be importable, and the Lingui pipeline.

**Tech Stack:** React Native 0.87.0 (New Architecture, Hermes) · React 19.2.3 · TypeScript 6 · pnpm 10.14.0 (`node-linker=hoisted`) · Node 26.5.0 · Gradle 9.4.1 · AGP (managed by `@react-native/gradle-plugin`) · Kotlin 2.2.0 · Android SDK 37 / minSdk 26 · iOS 16.0 · Jest 29 + `@react-native/jest-preset` · ESLint 8 + `@react-native/eslint-config` · Prettier 2.8.8 · Reatom v1001 · errore 0.14.1 · Lingui 6.6.0

**Spec:** `docs/superpowers/specs/2026-08-13-offline-nearby-ptt-design.md` (sections §5, §11, §12.2, §17)

**Schedule:** `docs/superpowers/execution/2026-08-13-offline-nearby-ptt.md`, block "### P1 `bootstrap` — wave 1, track A"

---

## Global Constraints

Every task's requirements implicitly include this section.

**Gates.** Copied verbatim from the schedule header — an implementer sees only its own task, so these are repeated in every task's verification step:

- **Task gate:** `pnpm typecheck && pnpm lint && pnpm test <paths>` (+ `pnpm build:android` when the task touched `android/`)
- **Merge gate:** `pnpm typecheck && pnpm lint && pnpm test && pnpm build:android`
- **Known flakes:** none known — greenfield repository. Two standing environment caveats: (1) the first Gradle / NDK / CMake / dependency downloads are slow and can time out — a download failure or timeout is infrastructure, not a regression; re-run once before reporting. (2) Swift is never compiled by any gate on this Windows host — a green merge gate is **not** evidence of iOS health; iOS compilation happens only at closeout on macOS.

**Spec values, copied verbatim:**

- RN foundation: **Bare React Native, New Architecture (Turbo Native Modules), TypeScript** (§5)
- Minimum OS: **iOS 16+ (PushToTalk framework requirement); Android 8.0+ (minSdk 26)** (§5)
- UI state: **Reatom v1001** (`atom`, `computed`, `effect`, `atom.extend`) (§5)
- TS error handling: **errore convention — errors as values (`Error | T` unions), no thrown domain errors** (§5, §13)
- Localization: **English (default) + Russian via Lingui; language follows the system locale, English fallback** (§5, §12.2)
- Android permissions model: **implemented against Android 12+ Bluetooth permissions and Android 14 foreground-service-type rules** (§5)

**Names this plan fixes, which later plans must consume unchanged:**

| Constant | Value | Consumed by |
|---|---|---|
| RN project name | `Oru` | all |
| Android namespace / `applicationId` | `com.oru` | P2, P5 |
| iOS `PRODUCT_BUNDLE_IDENTIFIER` | `com.oru` | P3, P5, closeout |
| iOS app source directory | `ios/Oru/` | P3, P5 |
| iOS Xcode project | `ios/Oru.xcodeproj` | P3, P5, closeout |
| Nearby Connections **Service ID** | `oru` | **P2 and P3 must both use this exact string** |
| Android radio source root | `android/app/src/main/java/com/oru/radio/` | P2, P5 |
| iOS radio source directory | `ios/Radio/` | P3, P5 |

**§17 path mapping.** §17 draws the Android radio at `android/app/radio/`. That is schematic: the Android Gradle Plugin only compiles sources under a registered source set, and the template's source set is `android/app/src/main/java/`. This plan therefore materialises §17's `android/app/radio/` as **`android/app/src/main/java/com/oru/radio/`** and does not add a custom `srcDirs` entry. §17's `ios/Radio/` is taken literally, because it is already a valid location for Swift sources added to the Xcode target. The `.gitkeep` files created in Task 2 are the on-disk statement of this mapping — P2, P3 and P5 read the merged tree, not this document.

**Host environment facts** (from the schedule's "Decomposition rationale"; agents run in fresh shells and none of this is in the environment by default):

- Android SDK: `C:\Users\Khmil\AppData\Local\Android\Sdk`. **No `ANDROID_HOME` is set.** Installed: platform `android-37.0`, `build-tools 36.0.0`, `platform-tools 37.0.1`. **Not installed:** NDK, CMake, `cmdline-tools`, and `build-tools 37.0.0` (which the template requests). The `android-sdk-license` is accepted, so the Android Gradle Plugin auto-downloads the missing packages on first build — that download is slow and is covered by the known-flakes caveat above.
- JDK: Android Studio JBR at `C:\Program Files\Android\Android Studio\jbr` — **OpenJDK 25.0.2**. It is the only JDK on the host; `JAVA_HOME` is not set.
- Gradle 9.1.0 is the first Gradle release that supports running on JDK 25. The React Native 0.87.0 template ships **Gradle 9.4.1**, so the JBR is supported. Task 1 verifies this rather than assuming it, and carries the fallback.
- Node v26.5.0, pnpm 10.14.0. No macOS available: iOS code is review-verified only.

**Scope fence — these belong to other plans and must not be implemented here:**

- Any radio logic — `RadioEngine`, `NearbyManager`, `AudioEngine`, `PttManager`, `RadioForegroundService`, `BackgroundManager`, libopus/NDK/CMake build config → **P2** (Android) and **P3** (iOS).
- The `<service>` element for the foreground service, `foregroundServiceType` attributes, and the en/ru `strings.xml` notification copy → **P2**. This plan declares §11 *permissions* only.
- `InfoPlist.strings` and `Localizable.strings` (the localisation of the iOS usage descriptions and the PushToTalk channel name) → **P3**. This plan declares the `Info.plist` keys with English source copy; P3 localises them.
- `NSBonjourServices` exact wire values: this plan declares valid Bonjour service types derived from the fixed Service ID `oru`, and Task 4's test asserts the key is present and non-empty rather than asserting exact strings — so **P3 may amend the entries** if Google's NearbyConnections Swift library requires a different form, without breaking this plan's test.
- TypeScript types, the Turbo Module spec, the typed native wrapper and the Reatom model → **P4**. This plan creates `src/radio/`, `src/ptt/`, `src/app/` and `specs/` as empty directories and writes no `.ts` file into them.
- Turbo Module registration, `codegenConfig` in package.json, `MainApplication` wiring → **P5**.
- Screens, UI copy, filled `en`/`ru` catalogs, fonts and asset config → **P6**. This plan creates the catalogs **empty**.
- App entry, `i18n` activation at startup, navigation, runtime permission sequencing, README → **P7**. This plan writes `src/i18n.ts` as a scaffold with a pure `resolveLocale` and an `initI18n`, and calls neither.

**Working rules:**

- Every task ends with one commit. Commit messages are English, imperative mood.
- No task may add or remove a dependency outside the task that owns it (Tasks 1, 5, 6). The whole point of P1 is that P2–P7 never edit `package.json` dependencies.
- `pnpm-lock.yaml` is committed. Sync 1 regenerates it with `pnpm install` if it ever conflicts.

---

## File Structure

Files this plan creates or modifies, and what each is responsible for.

**Created by the React Native template in Task 1** (not enumerated file by file — the template is copied verbatim and committed as-is): `App.tsx`, `index.js`, `app.json`, `Gemfile`, `.bundle/config`, `.watchmanconfig`, `.prettierrc.js`, `__tests__/App.test.tsx`, the whole `android/` tree, the whole `ios/` tree.

**Authored or rewritten by this plan:**

| File | Responsibility | Task |
|---|---|---|
| `.npmrc` | pnpm linker settings that make React Native's flat-`node_modules` assumptions hold | 1 |
| `.gitignore` | template ignores plus `.claude/` and `.metro-bundle-check/` | 1 |
| `package.json` | project name and the six scripts the gates and later plans run | 1, 5, 6 |
| `tsconfig.json` | template config plus `node` types, so tests may read files | 1 |
| `.eslintrc.js` | template config plus a Node-environment override for config and script files | 1 |
| `.eslintignore` | keeps `eslint .` out of `android/`, `ios/`, build output | 1 |
| `scripts/build-android.js` | the whole `build:android` gate: SDK/JDK resolution, `local.properties` generation, Gradle invocation | 1 |
| `android/build.gradle` | `minSdkVersion = 26` per §5 | 1 |
| `__tests__/toolchain.test.ts` | proves the build script can resolve an SDK and a JDK on this host | 1 |
| `__tests__/project-structure.test.ts` | proves the §17 skeleton exists; a canary later plans keep green | 2 |
| `src/{app,radio,screens,ptt}/.gitkeep`, `specs/.gitkeep`, `android/app/src/main/java/com/oru/radio/.gitkeep`, `ios/Radio/.gitkeep` | the §17 skeleton | 2 |
| `android/app/src/main/AndroidManifest.xml` | every §11 Android permission | 3 |
| `__tests__/android-manifest.test.ts` | asserts each §11 Android permission is declared | 3 |
| `ios/Oru/Info.plist` | every §11 iOS declaration plus `UIBackgroundModes` | 4 |
| `ios/Oru/Oru.entitlements` | the `com.apple.developer.push-to-talk` entitlement stub | 4 |
| `ios/Oru.xcodeproj/project.pbxproj` | deployment target 16.0 and the entitlements build setting | 4 |
| `ios/Podfile` | iOS platform floor 16.0 | 4 |
| `__tests__/ios-config.test.ts` | asserts each §11 iOS declaration and the entitlement | 4 |
| `jest.config.js` | Jest interop for the ESM-only runtime dependencies | 5, 6 |
| `__tests__/dependencies.test.ts` | proves every runtime dependency is importable from a test | 5 |
| `lingui.config.ts` | Lingui catalogs for `en` and `ru` | 6 |
| `babel.config.js` | the Lingui macro plugin | 6 |
| `metro.config.js` | the Lingui `.po` transformer and source extension | 6 |
| `src/i18n.ts` | `loadAndActivate` scaffold and the pure locale resolver | 6 |
| `src/locales/{en,ru}/messages.po` | empty catalogs, generated by `lingui extract` | 6 |
| `src/po.d.ts` | TypeScript declaration so `.po` imports typecheck | 6 |
| `__mocks__/poCatalog.js` | `.po` stand-in under Jest, which does not run the Metro transformer | 6 |
| `__tests__/i18n.test.ts` | proves locale resolution and `loadAndActivate` | 6 |

---

## Task 1: Scaffold the project and the four gate scripts

This is deliberately the largest task in the plan: until it finishes, the repository contains no code, no package manager state and no way to run any gate, so there is nothing a reviewer could approve in halves. It ends with the full merge gate green.

**Files:**
- Create: `.npmrc`, `.gitignore`, `package.json`, `tsconfig.json`, `.eslintrc.js`, `.eslintignore`, `scripts/build-android.js`, `App.tsx`, `index.js`, `app.json`, `babel.config.js`, `metro.config.js`, `jest.config.js`, `.prettierrc.js`, `.watchmanconfig`, `Gemfile`, `.bundle/config`, `README.md`, `android/**`, `ios/**` (all from the template)
- Modify: `android/build.gradle`
- Test: `__tests__/toolchain.test.ts`

**Interfaces:**
- Consumes: nothing — this is the first task in the run.
- Produces:
  - `pnpm typecheck` → `tsc --noEmit`
  - `pnpm lint` → `eslint . --ext .js,.jsx,.ts,.tsx`
  - `pnpm test` → `jest`
  - `pnpm build:android` → `node scripts/build-android.js` (default Gradle task `assembleDebug`)
  - `pnpm bundle:android` → a Metro production bundle into `.metro-bundle-check/`, used as an extra verification step in Tasks 1 and 6; **not** part of the gate
  - `scripts/build-android.js` exports `resolveAndroidSdkDir(): string | null`, `resolveJdkDir(): string | null`, `writeLocalProperties(sdkDir: string): string`
  - A React Native 0.87.0 project rooted at the repository root, `newArchEnabled=true`, `minSdkVersion = 26`

- [ ] **Step 1: Confirm the host prerequisites**

Run each of these and confirm the output before going further. If any one of them disagrees, stop and report `BLOCKED` — the rest of the plan is written against these exact facts.

```bash
node --version                 # expect v26.5.0 (any v26.x is fine)
pnpm --version                 # expect 10.14.0
ls "C:/Program Files/Android/Android Studio/jbr/bin/java.exe"
ls "C:/Users/Khmil/AppData/Local/Android/Sdk/licenses/android-sdk-license"
git status --porcelain         # expect only untracked run-directory scratch, no tracked changes
```

- [ ] **Step 2: Scaffold the template into a staging directory**

The React Native CLI refuses to initialise into a directory that already has content, and this repository already holds `docs/` and `.git/`. Scaffold into a staging directory inside the repository, then move the result up. The CLI's `--pm` flag supports only `yarn`, `npm` and `bun` — never pnpm — so installation is skipped here and done with pnpm in Step 5.

Run from the repository root:

```bash
npx --yes @react-native-community/cli@20.2.0 init Oru \
  --version 0.87.0 \
  --directory rn-template \
  --package-name com.oru \
  --skip-install \
  --skip-git-init \
  --install-pods false
```

Expected: a `rn-template/` directory containing `package.json`, `App.tsx`, `android/`, `ios/Oru.xcodeproj`, `ios/Oru/`.

- [ ] **Step 3: Move the scaffold to the repository root**

```bash
cp -a rn-template/. .
rm -rf rn-template
ls -a
```

Expected `ls -a` to now show, among others: `.bundle`, `.eslintrc.js`, `.gitignore`, `.prettierrc.js`, `.watchmanconfig`, `App.tsx`, `Gemfile`, `android`, `app.json`, `babel.config.js`, `docs`, `index.js`, `ios`, `jest.config.js`, `metro.config.js`, `package.json`, `tsconfig.json`, `__tests__`. Confirm `rn-template` is gone.

- [ ] **Step 4: Write `.npmrc`**

React Native's Metro resolver, its Gradle autolinking and CocoaPods all assume a flat `node_modules`. pnpm's default symlinked store breaks all three.

Create `.npmrc`:

```ini
node-linker=hoisted
strict-peer-dependencies=false
```

`strict-peer-dependencies=false` is required because `@lingui/metro-transformer` (installed in Task 6) declares `expo` and `@expo/metro-config` as peers, which a bare React Native project deliberately does not have.

- [ ] **Step 5: Install with pnpm**

```bash
pnpm install
```

Expected: completes, creates `node_modules/` and `pnpm-lock.yaml`. Peer-dependency warnings are expected and are not failures.

- [ ] **Step 6: Verify the untouched template is green before changing it**

```bash
pnpm test
```

Expected: PASS — one suite, `__tests__/App.test.tsx`, one test `renders correctly`. If this fails, the template itself is broken on this host; stop and report `BLOCKED` rather than working around it.

- [ ] **Step 7: Set the project name and the scripts in `package.json`**

Replace the `"name"` value and the whole `"scripts"` block with the fragment below — it is the head of the file, and `"version"` and `"private"` are shown only as position anchors. Leave `"dependencies"`, `"devDependencies"` and `"engines"` exactly as the template wrote them.

The template's `.prettierrc.js` is the project's Prettier configuration and needs no change; Prettier is not wired into `pnpm lint`, because `@react-native/eslint-config` pulls in `eslint-config-prettier` (which switches conflicting rules off) and not `eslint-plugin-prettier` (which would enforce formatting).

```json
  "name": "oru",
  "version": "0.0.1",
  "private": true,
  "scripts": {
    "android": "react-native run-android",
    "ios": "react-native run-ios",
    "start": "react-native start",
    "typecheck": "tsc --noEmit",
    "lint": "eslint . --ext .js,.jsx,.ts,.tsx",
    "test": "jest",
    "build:android": "node scripts/build-android.js",
    "bundle:android": "react-native bundle --platform android --dev false --entry-file index.js --bundle-output .metro-bundle-check/index.android.bundle --assets-dest .metro-bundle-check"
  },
```

The `--ext` flag is not decoration: ESLint 8 traverses a directory looking for `.js` only, so a bare `eslint .` would silently lint no TypeScript at all in a TypeScript project.

- [ ] **Step 8: Add `@types/node` and widen the TypeScript `types` list**

`@react-native/typescript-config` sets `"types": ["jest"]`, which leaves `require`, `process`, `__dirname` and `fs` undeclared. Several tests in this plan read files from disk.

```bash
pnpm add --save-dev @types/node
```

Then replace `tsconfig.json` in full:

```json
{
  "extends": "@react-native/typescript-config",
  "compilerOptions": {
    "types": ["jest", "node"]
  },
  "include": ["**/*.ts", "**/*.tsx"],
  "exclude": ["**/node_modules", "**/Pods"]
}
```

- [ ] **Step 9: Give ESLint a Node environment for config and script files**

Replace `.eslintrc.js` in full:

```js
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
```

Create `.eslintignore`:

```
node_modules/
android/
ios/
vendor/
coverage/
.metro-bundle-check/
src/locales/
```

- [ ] **Step 10: Set the Android minimum SDK to 26 per §5**

In `android/build.gradle`, inside the `buildscript { ext { ... } }` block, change the one line:

```groovy
        minSdkVersion = 24
```

to:

```groovy
        minSdkVersion = 26
```

Leave `buildToolsVersion = "37.0.0"`, `compileSdkVersion = 37`, `targetSdkVersion = 36`, `ndkVersion = "27.1.12297006"` and `kotlinVersion = "2.2.0"` untouched.

- [ ] **Step 11: Extend `.gitignore`**

Append to the end of `.gitignore`:

```
# Metro bundle produced by `pnpm bundle:android` as a build check
.metro-bundle-check/

# Local agent worktrees
.claude/
```

`android/local.properties` is already covered by the template's `local.properties` line, and stays ignored on purpose: it is regenerated on every `pnpm build:android`, so a fresh git worktree needs no setup and a macOS checkout is not poisoned by a Windows path.

- [ ] **Step 12: Write the failing test for the build script**

Create `__tests__/toolchain.test.ts`:

```ts
import {existsSync} from 'fs';
import {join} from 'path';

import packageJson from '../package.json';
import {
  resolveAndroidSdkDir,
  resolveJdkDir,
} from '../scripts/build-android';

// package.json resolves to a precise literal type, which cannot be indexed
// with an arbitrary string under `strict`.
const scripts = packageJson.scripts as Record<string, string | undefined>;

describe('gate scripts', () => {
  it.each([
    'typecheck',
    'lint',
    'test',
    'build:android',
    'bundle:android',
  ])('package.json declares the "%s" script', name => {
    expect(scripts[name]).toBeTruthy();
  });
});

describe('android build script', () => {
  it('resolves an Android SDK directory that exists', () => {
    const sdkDir = resolveAndroidSdkDir();
    expect(sdkDir).toBeTruthy();
    expect(existsSync(join(sdkDir as string, 'platform-tools'))).toBe(true);
  });

  it('resolves a JDK directory that contains a java executable', () => {
    const jdkDir = resolveJdkDir();
    expect(jdkDir).toBeTruthy();
    const hasJava =
      existsSync(join(jdkDir as string, 'bin', 'java.exe')) ||
      existsSync(join(jdkDir as string, 'bin', 'java'));
    expect(hasJava).toBe(true);
  });
});
```

- [ ] **Step 13: Run the test to verify it fails**

```bash
pnpm test __tests__/toolchain.test.ts
```

Expected: FAIL — `Cannot find module '../scripts/build-android'`.

- [ ] **Step 14: Write the build script**

Create `scripts/build-android.js`:

```js
/**
 * The `pnpm build:android` gate.
 *
 * Resolves the Android SDK and a JDK without depending on any shell
 * environment, regenerates android/local.properties, and runs the Gradle
 * wrapper with org.gradle.java.home pinned to the resolved JDK. This is what
 * makes the gate work in a fresh shell and in a fresh git worktree, on this
 * Windows host and on the macOS machine used at closeout.
 *
 * Usage: node scripts/build-android.js [gradleTask]   (default: assembleDebug)
 * Env:   RN_ARCHS   comma-separated ABIs (default: arm64-v8a)
 */
'use strict';

const {existsSync, writeFileSync} = require('fs');
const {homedir} = require('os');
const path = require('path');
const {spawnSync} = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const ANDROID_DIR = path.join(REPO_ROOT, 'android');

function firstExistingDir(candidates) {
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function resolveAndroidSdkDir() {
  const localAppData = process.env.LOCALAPPDATA;
  return firstExistingDir([
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    localAppData ? path.join(localAppData, 'Android', 'Sdk') : null,
    path.join(homedir(), 'AppData', 'Local', 'Android', 'Sdk'),
    path.join(homedir(), 'Library', 'Android', 'sdk'),
    path.join(homedir(), 'Android', 'Sdk'),
  ]);
}

function resolveJdkDir() {
  return firstExistingDir([
    process.env.JAVA_HOME,
    'C:\\Program Files\\Android\\Android Studio\\jbr',
    '/Applications/Android Studio.app/Contents/jbr/Contents/Home',
    path.join(
      homedir(),
      'Applications',
      'Android Studio.app',
      'Contents',
      'jbr',
      'Contents',
      'Home',
    ),
    '/opt/android-studio/jbr',
  ]);
}

function writeLocalProperties(sdkDir) {
  const file = path.join(ANDROID_DIR, 'local.properties');
  const body = [
    '# Generated by scripts/build-android.js on every build.',
    '# Do not commit and do not edit by hand.',
    `sdk.dir=${sdkDir.replace(/\\/g, '/')}`,
    '',
  ].join('\n');
  writeFileSync(file, body, 'utf8');
  return file;
}

function main() {
  const task = process.argv[2] || 'assembleDebug';
  const archs = process.env.RN_ARCHS || 'arm64-v8a';

  const sdkDir = resolveAndroidSdkDir();
  if (!sdkDir) {
    console.error(
      'Android SDK not found. Set ANDROID_HOME to your SDK directory.',
    );
    process.exit(1);
  }

  const jdkDir = resolveJdkDir();
  if (!jdkDir) {
    console.error(
      'No JDK found. Set JAVA_HOME, or install Android Studio so its bundled JBR is available.',
    );
    process.exit(1);
  }

  console.log(`Android SDK: ${sdkDir}`);
  console.log(`JDK:         ${jdkDir}`);
  console.log(`Gradle task: ${task} (${archs})`);
  writeLocalProperties(sdkDir);

  const isWindows = process.platform === 'win32';
  const wrapper = path.join(ANDROID_DIR, isWindows ? 'gradlew.bat' : 'gradlew');
  const gradleArgs = [
    task,
    `-Dorg.gradle.java.home=${jdkDir}`,
    `-PreactNativeArchitectures=${archs}`,
    '--console=plain',
  ];

  const result = spawnSync(
    isWindows ? 'cmd.exe' : wrapper,
    isWindows ? ['/c', wrapper, ...gradleArgs] : gradleArgs,
    {
      cwd: ANDROID_DIR,
      stdio: 'inherit',
      env: {
        ...process.env,
        JAVA_HOME: jdkDir,
        ANDROID_HOME: sdkDir,
        ANDROID_SDK_ROOT: sdkDir,
      },
    },
  );

  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  process.exit(result.status === null ? 1 : result.status);
}

module.exports = {
  resolveAndroidSdkDir,
  resolveJdkDir,
  writeLocalProperties,
};

if (require.main === module) {
  main();
}
```

- [ ] **Step 15: Run the test to verify it passes**

```bash
pnpm test __tests__/toolchain.test.ts
```

Expected: PASS — 7 tests (five script assertions, two resolver assertions).

- [ ] **Step 16: Verify Gradle runs on JDK 25**

```bash
node scripts/build-android.js --version
```

Expected output includes `Gradle 9.4.1` and `Launcher JVM:  25.0.2`.

Two contingencies, both concrete:

- If Gradle reports that the JVM version is unsupported, edit `android/gradle/wrapper/gradle-wrapper.properties` and raise `distributionUrl` to `https\://services.gradle.org/distributions/gradle-9.4.1-bin.zip` — if it is already 9.4.1, report `BLOCKED`, because no newer Gradle is known to this plan and the choice of a different JDK is the operator's.
- If the process fails with a Windows argument-quoting error mentioning `org.gradle.java.home`, delete the `` `-Dorg.gradle.java.home=${jdkDir}` `` element from `gradleArgs`. The `JAVA_HOME` entry already placed in the child environment pins the same JVM; the `-D` flag is belt-and-braces. Note the removal in the task report.

- [ ] **Step 17: Run the Android build gate**

```bash
pnpm build:android
```

Expected: `BUILD SUCCESSFUL`. This first run downloads the Gradle 9.4.1 distribution, the Android Gradle Plugin, `build-tools 37.0.0`, and NDK 27.1.12297006 — it takes a long time and may time out. Per the known-flakes line, a download failure or timeout is infrastructure, not a regression: re-run once before reporting anything.

Confirm afterwards that `android/local.properties` exists, contains a `sdk.dir=` line with forward slashes, and is **not** listed by `git status --porcelain`.

- [ ] **Step 18: Run the Metro bundle check**

```bash
pnpm bundle:android
```

Expected: Metro writes `.metro-bundle-check/index.android.bundle` and exits 0. This is not part of the gate; it is the only thing in the run that proves Metro can actually resolve and transform the dependency graph, and Task 6 repeats it once Lingui is wired in.

If the command fails with `ENOENT` for the output directory, run `mkdir -p .metro-bundle-check` and re-run — the directory is gitignored, so it is created once per checkout and never committed.

- [ ] **Step 19: Run the full gate**

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm build:android
```

Expected: all four green. `pnpm build:android` is included because this task created `android/`.

- [ ] **Step 20: Commit**

```bash
git add -A
git commit -m "Bootstrap bare React Native 0.87 project with pnpm and gate scripts"
```

---

## Task 2: The §17 directory skeleton

**Files:**
- Create: `src/app/.gitkeep`, `src/radio/.gitkeep`, `src/screens/.gitkeep`, `src/ptt/.gitkeep`, `specs/.gitkeep`, `android/app/src/main/java/com/oru/radio/.gitkeep`, `ios/Radio/.gitkeep`
- Test: `__tests__/project-structure.test.ts`

**Interfaces:**
- Consumes: `pnpm typecheck`, `pnpm lint`, `pnpm test` from Task 1.
- Produces: the seven directories above. P2 writes its Kotlin into `android/app/src/main/java/com/oru/radio/`; P3 writes its Swift into `ios/Radio/`; P4 writes into `src/radio/`, `src/ptt/`, `src/app/` and `specs/`; P6 writes into `src/screens/`. Task 6 adds `src/locales/`, which is generated and therefore not asserted here.

This task touches `android/` (it creates a directory under it), so its verification includes `pnpm build:android`.

- [ ] **Step 1: Write the failing test**

Create `__tests__/project-structure.test.ts`:

```ts
import {existsSync, statSync} from 'fs';
import {join} from 'path';

const REPO_ROOT = join(__dirname, '..');

const REQUIRED_DIRECTORIES = [
  'src/app',
  'src/radio',
  'src/screens',
  'src/ptt',
  'specs',
  'android/app/src/main/java/com/oru/radio',
  'ios/Radio',
];

describe('project structure (spec section 17)', () => {
  it.each(REQUIRED_DIRECTORIES)('%s exists and is a directory', relative => {
    const absolute = join(REPO_ROOT, relative);
    expect(existsSync(absolute)).toBe(true);
    expect(statSync(absolute).isDirectory()).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm test __tests__/project-structure.test.ts
```

Expected: FAIL — seven failing cases, each reporting `expect(false).toBe(true)` for a missing directory.

- [ ] **Step 3: Create the directories**

Git cannot track an empty directory, so each gets a `.gitkeep`.

```bash
mkdir -p src/app src/radio src/screens src/ptt specs \
         android/app/src/main/java/com/oru/radio ios/Radio
touch src/app/.gitkeep src/radio/.gitkeep src/screens/.gitkeep \
      src/ptt/.gitkeep specs/.gitkeep \
      android/app/src/main/java/com/oru/radio/.gitkeep ios/Radio/.gitkeep
```

Write no `.ts`, `.kt` or `.swift` file into any of them — those files belong to P2, P3, P4 and P6.

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm test __tests__/project-structure.test.ts
```

Expected: PASS — 7 tests.

- [ ] **Step 5: Run the gate**

```bash
pnpm typecheck && pnpm lint && pnpm test __tests__/project-structure.test.ts && pnpm build:android
```

Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "Add the spec section 17 directory skeleton"
```

---

## Task 3: Android permission declarations (§11)

**Files:**
- Modify: `android/app/src/main/AndroidManifest.xml`
- Test: `__tests__/android-manifest.test.ts`

**Interfaces:**
- Consumes: the manifest created by Task 1; `pnpm build:android` from Task 1.
- Produces: the ten §11 Android permission declarations. P2 adds the `<service>` element and its `foregroundServiceType` attributes to the same file; P7 cross-checks the declarations against what the merged code uses.

This task touches `android/`, so its verification includes `pnpm build:android`.

- [ ] **Step 1: Write the failing test**

Create `__tests__/android-manifest.test.ts`:

```ts
import {readFileSync} from 'fs';
import {join} from 'path';

const manifest = readFileSync(
  join(__dirname, '..', 'android', 'app', 'src', 'main', 'AndroidManifest.xml'),
  'utf8',
);

const REQUIRED_PERMISSIONS = [
  'android.permission.RECORD_AUDIO',
  'android.permission.BLUETOOTH_SCAN',
  'android.permission.BLUETOOTH_CONNECT',
  'android.permission.BLUETOOTH_ADVERTISE',
  'android.permission.NEARBY_WIFI_DEVICES',
  'android.permission.ACCESS_FINE_LOCATION',
  'android.permission.POST_NOTIFICATIONS',
  'android.permission.FOREGROUND_SERVICE',
  'android.permission.FOREGROUND_SERVICE_MICROPHONE',
  'android.permission.FOREGROUND_SERVICE_CONNECTED_DEVICE',
];

describe('AndroidManifest permissions (spec section 11)', () => {
  it.each(REQUIRED_PERMISSIONS)('declares %s', permission => {
    expect(manifest).toContain(`android:name="${permission}"`);
  });

  it('bounds ACCESS_FINE_LOCATION to pre-Android-13', () => {
    const line = manifest
      .split('\n')
      .find(candidate =>
        candidate.includes('android.permission.ACCESS_FINE_LOCATION'),
      );
    expect(line).toContain('android:maxSdkVersion="32"');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm test __tests__/android-manifest.test.ts
```

Expected: FAIL — ten of the eleven cases fail (the manifest currently declares only `INTERNET`), plus the `maxSdkVersion` case.

- [ ] **Step 3: Declare the permissions**

In `android/app/src/main/AndroidManifest.xml`, replace the single line:

```xml
    <uses-permission android:name="android.permission.INTERNET" />
```

with:

```xml
    <uses-permission android:name="android.permission.INTERNET" />

    <!-- Spec section 11: microphone -->
    <uses-permission android:name="android.permission.RECORD_AUDIO" />

    <!-- Spec section 11: Nearby Connections + the external PTT button -->
    <uses-permission android:name="android.permission.BLUETOOTH_SCAN" />
    <uses-permission android:name="android.permission.BLUETOOTH_CONNECT" />
    <uses-permission android:name="android.permission.BLUETOOTH_ADVERTISE" />

    <!-- Spec section 11: Nearby discovery -->
    <uses-permission android:name="android.permission.NEARBY_WIFI_DEVICES" />
    <uses-permission
        android:name="android.permission.ACCESS_FINE_LOCATION"
        android:maxSdkVersion="32" />

    <!-- Spec section 11: foreground service -->
    <uses-permission android:name="android.permission.POST_NOTIFICATIONS" />
    <uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
    <uses-permission android:name="android.permission.FOREGROUND_SERVICE_MICROPHONE" />
    <uses-permission android:name="android.permission.FOREGROUND_SERVICE_CONNECTED_DEVICE" />
```

Declare exactly this set and nothing more. §11 is the authoritative list, and P7 owns the cross-check that reconciles it with what the merged native code actually calls; adding speculative legacy permissions here would make that cross-check meaningless.

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm test __tests__/android-manifest.test.ts
```

Expected: PASS — 11 tests.

- [ ] **Step 5: Run the gate**

```bash
pnpm typecheck && pnpm lint && pnpm test __tests__/android-manifest.test.ts && pnpm build:android
```

Expected: all green. The manifest merger will now also pull in the permissions' own constraints; a `BUILD SUCCESSFUL` here is the evidence the declarations are well-formed.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "Declare every spec section 11 Android permission"
```

---

## Task 4: iOS platform floor, permission declarations and the push-to-talk entitlement (§5, §11)

Nothing in this task is compiled by any gate on this host — see the known-flakes caveat. The test written here is therefore the only automated check these files will get before the closeout macOS build, which is exactly why it exists.

**Files:**
- Create: `ios/Oru/Oru.entitlements`
- Modify: `ios/Oru/Info.plist`, `ios/Oru.xcodeproj/project.pbxproj`, `ios/Podfile`
- Test: `__tests__/ios-config.test.ts`

**Interfaces:**
- Consumes: the iOS project created by Task 1.
- Produces: `NSMicrophoneUsageDescription`, `NSBluetoothAlwaysUsageDescription`, `NSLocalNetworkUsageDescription`, `NSBonjourServices`, `UIBackgroundModes = [push-to-talk, bluetooth-central]` in `ios/Oru/Info.plist`; `com.apple.developer.push-to-talk` in `ios/Oru/Oru.entitlements`, wired to the app target through `CODE_SIGN_ENTITLEMENTS`; `IPHONEOS_DEPLOYMENT_TARGET = 16.0` per §5. P3 localises the usage descriptions via `InfoPlist.strings` and may amend `NSBonjourServices` to whatever Google's NearbyConnections Swift library requires for Service ID `oru`.

This task does not touch `android/`, so its verification omits `pnpm build:android`.

- [ ] **Step 1: Write the failing test**

Create `__tests__/ios-config.test.ts`:

```ts
import {readFileSync} from 'fs';
import {join} from 'path';

const IOS_DIR = join(__dirname, '..', 'ios');

const infoPlist = readFileSync(join(IOS_DIR, 'Oru', 'Info.plist'), 'utf8');
const entitlements = readFileSync(
  join(IOS_DIR, 'Oru', 'Oru.entitlements'),
  'utf8',
);
const pbxproj = readFileSync(
  join(IOS_DIR, 'Oru.xcodeproj', 'project.pbxproj'),
  'utf8',
);
const podfile = readFileSync(join(IOS_DIR, 'Podfile'), 'utf8');

function stringValue(source: string, key: string): string | null {
  const keyIndex = source.indexOf(`<key>${key}</key>`);
  if (keyIndex === -1) {
    return null;
  }
  const open = source.indexOf('<string>', keyIndex);
  const close = source.indexOf('</string>', open);
  if (open === -1 || close === -1) {
    return null;
  }
  return source.slice(open + '<string>'.length, close);
}

function arrayValues(source: string, key: string): string[] {
  const keyIndex = source.indexOf(`<key>${key}</key>`);
  if (keyIndex === -1) {
    return [];
  }
  const open = source.indexOf('<array>', keyIndex);
  const close = source.indexOf('</array>', open);
  if (open === -1 || close === -1) {
    return [];
  }
  return source
    .slice(open + '<array>'.length, close)
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.startsWith('<string>'))
    .map(line => line.replace('<string>', '').replace('</string>', ''));
}

describe('Info.plist usage descriptions (spec section 11)', () => {
  it.each([
    'NSMicrophoneUsageDescription',
    'NSBluetoothAlwaysUsageDescription',
    'NSLocalNetworkUsageDescription',
  ])('%s is declared with non-empty English source copy', key => {
    const value = stringValue(infoPlist, key);
    expect(value).toBeTruthy();
    expect((value as string).length).toBeGreaterThan(10);
  });

  it('declares at least one Bonjour service', () => {
    expect(arrayValues(infoPlist, 'NSBonjourServices').length).toBeGreaterThan(
      0,
    );
  });

  it('declares the push-to-talk and bluetooth-central background modes', () => {
    const modes = arrayValues(infoPlist, 'UIBackgroundModes');
    expect(modes).toContain('push-to-talk');
    expect(modes).toContain('bluetooth-central');
  });
});

describe('push-to-talk entitlement (spec section 11)', () => {
  it('declares com.apple.developer.push-to-talk', () => {
    expect(entitlements).toContain(
      '<key>com.apple.developer.push-to-talk</key>',
    );
  });

  it('is wired to the app target', () => {
    expect(pbxproj).toContain(
      'CODE_SIGN_ENTITLEMENTS = Oru/Oru.entitlements;',
    );
  });
});

describe('iOS platform floor (spec section 5)', () => {
  it('sets the deployment target to 16.0 everywhere', () => {
    expect(pbxproj).toContain('IPHONEOS_DEPLOYMENT_TARGET = 16.0;');
    expect(pbxproj).not.toContain('IPHONEOS_DEPLOYMENT_TARGET = 15.1;');
  });

  it('pins the Podfile platform to 16.0', () => {
    expect(podfile).toContain("platform :ios, '16.0'");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm test __tests__/ios-config.test.ts
```

Expected: FAIL at module load — `ENOENT` for `ios/Oru/Oru.entitlements`, which does not exist yet.

- [ ] **Step 3: Add the §11 declarations to `Info.plist`**

In `ios/Oru/Info.plist`, insert the following immediately **before** the closing `</dict>` line. Keep the file's tab indentation.

```xml
	<key>NSMicrophoneUsageDescription</key>
	<string>Oru uses the microphone to transmit your voice to nearby devices.</string>
	<key>NSBluetoothAlwaysUsageDescription</key>
	<string>Oru connects to your Bluetooth push-to-talk button, including while the screen is locked.</string>
	<key>NSLocalNetworkUsageDescription</key>
	<string>Oru discovers and connects to nearby devices over the local network.</string>
	<key>NSBonjourServices</key>
	<array>
		<string>_oru._tcp</string>
		<string>_oru._udp</string>
	</array>
	<key>UIBackgroundModes</key>
	<array>
		<string>push-to-talk</string>
		<string>bluetooth-central</string>
	</array>
```

The English strings here are source copy; §12.2 assigns their localisation to `InfoPlist.strings`, which P3 owns. The Bonjour entries are derived from the fixed Nearby Service ID `oru` — dot-free, so they are valid Bonjour service types. P3 verifies them against the NearbyConnections Swift library and may change them; the test above asserts only that the key is present and non-empty, so that change will not break this task.

- [ ] **Step 4: Create the entitlements file**

Create `ios/Oru/Oru.entitlements`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>com.apple.developer.push-to-talk</key>
	<true/>
</dict>
</plist>
```

- [ ] **Step 5: Wire the entitlements file into the Xcode target**

In `ios/Oru.xcodeproj/project.pbxproj`, replace **every** occurrence (there are two — the app target's Debug and Release configurations) of the line:

```
				INFOPLIST_FILE = Oru/Info.plist;
```

with these two lines:

```
				CODE_SIGN_ENTITLEMENTS = Oru/Oru.entitlements;
				INFOPLIST_FILE = Oru/Info.plist;
```

The indentation is four tab characters, matching the surrounding `buildSettings` entries. Use a replace-all edit, not a hand edit of one occurrence.

This sets the build setting only; the file is not added to the project's file list. Xcode does not need a `PBXFileReference` to codesign against an entitlements path, and hand-editing the object graph of a `.pbxproj` that no gate can compile is a worse trade. Adding it to the Xcode navigator is a closeout convenience, not a build requirement.

- [ ] **Step 6: Raise the deployment target to iOS 16.0**

In `ios/Oru.xcodeproj/project.pbxproj`, replace **every** occurrence (there are four — two app-target configurations and two project-level ones) of:

```
IPHONEOS_DEPLOYMENT_TARGET = 15.1;
```

with:

```
IPHONEOS_DEPLOYMENT_TARGET = 16.0;
```

In `ios/Podfile`, replace:

```ruby
platform :ios, min_ios_version_supported
```

with:

```ruby
platform :ios, '16.0'
```

§5 fixes the floor at iOS 16 because the PushToTalk framework requires it; `min_ios_version_supported` resolves to React Native's own floor, which is lower.

- [ ] **Step 7: Run the test to verify it passes**

```bash
pnpm test __tests__/ios-config.test.ts
```

Expected: PASS — 9 tests.

- [ ] **Step 8: Run the gate**

```bash
pnpm typecheck && pnpm lint && pnpm test __tests__/ios-config.test.ts
```

Expected: all green. `pnpm build:android` is omitted: this task touched no file under `android/`.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "Declare iOS section 11 permissions, background modes and the push-to-talk entitlement"
```

---

## Task 5: Runtime dependencies and Jest interop

Reatom, errore and (in Task 6) Lingui are all ESM-first packages. `errore` publishes an `exports` map with **only** an `import` condition, so a plain `require('errore')` from Jest fails to resolve at all; `@lingui/core` and `@lingui/react` publish `.mjs` entry points with no `main`, and the React Native Jest preset's `transform` map covers `.js`, `.ts` and `.tsx` but not `.mjs`. None of this surfaces until a test imports one of them — which is P4's very first task. Fixing it here is the whole point of P1 pre-installing the dependencies.

**Files:**
- Modify: `package.json`, `jest.config.js`
- Test: `__tests__/dependencies.test.ts`

**Interfaces:**
- Consumes: `pnpm test` from Task 1.
- Produces: `@reatom/core@1001.3.0`, `@reatom/react@1001.0.1` and `errore@0.14.1` installed and importable from both application code and Jest tests. P4 imports `atom`, `computed` and `effect` from `@reatom/core` and the errore helpers from `errore`; P6 imports from `@reatom/react`.

This task does not touch `android/`, so its verification omits `pnpm build:android`.

- [ ] **Step 1: Write the failing test**

Create `__tests__/dependencies.test.ts`:

```ts
import {atom, computed} from '@reatom/core';
import * as errore from 'errore';

describe('runtime dependencies are importable under Jest', () => {
  it('exposes the Reatom v1001 primitives the spec names', () => {
    expect(typeof atom).toBe('function');
    expect(typeof computed).toBe('function');
  });

  it('supports atom.extend, which the section 6.2 model relies on', () => {
    const counter = atom(0).extend(target => ({
      increment() {
        target.set(target() + 1);
      },
    }));

    counter.increment();

    expect(counter()).toBe(1);
  });

  it('computes derived state', () => {
    const source = atom(2);
    const doubled = computed(() => source() * 2);

    expect(doubled()).toBe(4);
  });

  it('exposes the errore helpers the TypeScript layer uses', () => {
    expect(typeof errore.createTaggedError).toBe('function');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm test __tests__/dependencies.test.ts
```

Expected: FAIL — `Cannot find module '@reatom/core'`.

- [ ] **Step 3: Install the runtime dependencies**

```bash
pnpm add @reatom/core@1001.3.0 @reatom/react@1001.0.1 errore@0.14.1
```

`@reatom/react` is installed here even though no code in P1 uses it, because P6 renders against the model and the schedule requires that later plans never edit `package.json` dependencies.

- [ ] **Step 4: Run the test again to see the real failure**

```bash
pnpm test __tests__/dependencies.test.ts
```

Expected: FAIL — now on `errore`, with a resolution error such as `Package subpath '.' is not defined by "exports"` or `Cannot find module 'errore'`. `@reatom/core` resolves because it ships a `require` condition; `errore` does not.

- [ ] **Step 5: Teach Jest about the ESM-only packages**

Replace `jest.config.js` in full:

```js
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
};
```

- [ ] **Step 6: Run the test to verify it passes**

```bash
pnpm test __tests__/dependencies.test.ts
```

Expected: PASS — 4 tests.

- [ ] **Step 7: Run the gate**

```bash
pnpm typecheck && pnpm lint && pnpm test
```

Expected: all green — and run the whole suite here, not just the new file, because `jest.config.js` changed and every existing suite must still pass under it.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "Install Reatom and errore and make them importable under Jest"
```

---

## Task 6: Lingui localization pipeline (§12.2)

**Files:**
- Create: `lingui.config.ts`, `src/i18n.ts`, `src/po.d.ts`, `__mocks__/poCatalog.js`, `src/locales/en/messages.po`, `src/locales/ru/messages.po`
- Modify: `package.json`, `babel.config.js`, `metro.config.js`, `jest.config.js`
- Test: `__tests__/i18n.test.ts`

**Interfaces:**
- Consumes: `src/` from Task 2; the Jest configuration from Task 5.
- Produces:
  - `pnpm lingui:extract` → `lingui extract`
  - `src/i18n.ts` exports `defaultLocale: 'en'`, `locales: readonly ['en', 'ru']`, `type AppLocale = 'en' | 'ru'`, `resolveLocale(systemLocale: string | undefined): AppLocale`, and `initI18n(systemLocale?: string): AppLocale` — which calls `i18n.loadAndActivate({locale, messages})` and returns the activated locale. **P7 calls `initI18n` at app entry, passing the system locale it reads there.** P1 does not detect the system locale: that is an app-entry concern and §12.2 assigns the startup call to the entry point.
  - Empty `en` and `ru` `.po` catalogs. P6 fills them by writing `Trans` / `t` macro copy and re-running `pnpm lingui:extract`.
- Not produced here: `@lingui/react`'s `I18nProvider` is not mounted — that is app-entry wiring and belongs to P7.

This task does not touch `android/`, so its verification omits `pnpm build:android`.

- [ ] **Step 1: Write the failing test**

Create `__tests__/i18n.test.ts`:

```ts
import {i18n} from '@lingui/core';

import {defaultLocale, initI18n, locales, resolveLocale} from '../src/i18n';

describe('locale resolution (spec section 12.2)', () => {
  it('defaults to English', () => {
    expect(defaultLocale).toBe('en');
    expect(locales).toEqual(['en', 'ru']);
  });

  it.each([
    ['ru', 'ru'],
    ['ru-RU', 'ru'],
    ['ru_RU', 'ru'],
    ['RU-ru', 'ru'],
  ])('resolves %s to %s', (systemLocale, expected) => {
    expect(resolveLocale(systemLocale)).toBe(expected);
  });

  it.each([['en'], ['en-US'], ['de-DE'], ['zh-Hans'], [''], [undefined]])(
    'falls back to English for %s',
    systemLocale => {
      expect(resolveLocale(systemLocale as string | undefined)).toBe('en');
    },
  );
});

describe('i18n activation', () => {
  it('activates Russian for a Russian system locale', () => {
    expect(initI18n('ru-RU')).toBe('ru');
    expect(i18n.locale).toBe('ru');
  });

  it('activates English for anything else', () => {
    expect(initI18n('fr-FR')).toBe('en');
    expect(i18n.locale).toBe('en');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm test __tests__/i18n.test.ts
```

Expected: FAIL — `Cannot find module '@lingui/core'`.

- [ ] **Step 3: Install the Lingui packages**

```bash
pnpm add @lingui/core@6.6.0 @lingui/react@6.6.0
pnpm add --save-dev @lingui/cli@6.6.0 @lingui/metro-transformer@6.6.0 \
  @lingui/babel-plugin-lingui-macro@6.6.0 @react-native/metro-babel-transformer@0.87.0
```

In Lingui 6 the `@lingui/macro` package no longer exists — it is frozen at 5.9.5. Macros come from `@lingui/core/macro` (`t`, `plural`, `msg`) and `@lingui/react/macro` (`Trans`, `Plural`). P6 imports from those paths.

Peer-dependency warnings about `expo` and `@expo/metro-config` are expected: `@lingui/metro-transformer` serves both Expo and bare React Native, and this is a bare project. `.npmrc` already sets `strict-peer-dependencies=false` so they stay warnings.

- [ ] **Step 4: Add the `lingui:extract` script**

In `package.json`, add one entry to `"scripts"`, after `"bundle:android"`:

```json
    "lingui:extract": "lingui extract"
```

`lingui compile` is deliberately absent: `@lingui/metro-transformer` compiles `.po` catalogs during bundling, so there is no separate compile step and no generated `.js` catalogs to commit.

- [ ] **Step 5: Write the Lingui configuration**

Create `lingui.config.ts`:

```ts
export default {
  sourceLocale: 'en',
  locales: ['en', 'ru'],
  fallbackLocales: {
    default: 'en',
  },
  catalogs: [
    {
      path: '<rootDir>/src/locales/{locale}/messages',
      include: ['src'],
    },
  ],
};
```

No `format` key: `po` is Lingui's default format and is what `@lingui/metro-transformer` consumes. The file imports nothing, so `tsc --noEmit` and `eslint` both handle it without needing type declarations from `@lingui/cli`, which is ESM-only.

- [ ] **Step 6: Wire the Lingui macro plugin into Babel**

Replace `babel.config.js` in full:

```js
module.exports = {
  presets: ['module:@react-native/babel-preset'],
  plugins: ['@lingui/babel-plugin-lingui-macro'],
};
```

- [ ] **Step 7: Wire the `.po` transformer into Metro**

Replace `metro.config.js` in full:

```js
const {getDefaultConfig, mergeConfig} = require('@react-native/metro-config');

const defaultConfig = getDefaultConfig(__dirname);

/**
 * Metro configuration
 * https://reactnative.dev/docs/metro
 *
 * @type {import('@react-native/metro-config').MetroConfig}
 */
const config = {
  transformer: {
    babelTransformerPath: require.resolve(
      '@lingui/metro-transformer/react-native',
    ),
  },
  resolver: {
    sourceExts: [...defaultConfig.resolver.sourceExts, 'po'],
  },
};

module.exports = mergeConfig(defaultConfig, config);
```

The entry point is `@lingui/metro-transformer/react-native`. The package also exports `/expo`; that one pulls in `@expo/metro-config` and must not be used here.

- [ ] **Step 8: Declare the `.po` module type for TypeScript**

Create `src/po.d.ts`:

```ts
declare module '*.po' {
  import type {Messages} from '@lingui/core';

  export const messages: Messages;
}
```

- [ ] **Step 9: Give Jest a `.po` stand-in**

Jest bundles nothing and never runs the Metro transformer, so a `.po` import inside `src/i18n.ts` would reach Jest as raw gettext text.

Create `__mocks__/poCatalog.js`:

```js
// Stand-in for a Metro-compiled .po catalog. Jest does not run the Metro
// transformer, so `.po` imports are mapped here by jest.config.js.
module.exports = {messages: {}};
```

Then in `jest.config.js`, add one entry to `moduleNameMapper`, after the `errore` entry:

```js
    // Jest never runs the Metro .po transformer; map catalogs to a stand-in.
    '\\.po$': '<rootDir>/__mocks__/poCatalog.js',
```

- [ ] **Step 10: Write the i18n scaffold**

Create `src/i18n.ts`:

```ts
import {i18n} from '@lingui/core';

import {messages as enMessages} from './locales/en/messages.po';
import {messages as ruMessages} from './locales/ru/messages.po';

export const locales = ['en', 'ru'] as const;

export type AppLocale = (typeof locales)[number];

export const defaultLocale: AppLocale = 'en';

const catalogs: Record<AppLocale, typeof enMessages> = {
  en: enMessages,
  ru: ruMessages,
};

/**
 * Spec section 12.2: the app language follows the system locale, and anything
 * other than Russian falls back to English. There is no in-app picker.
 */
export function resolveLocale(systemLocale: string | undefined): AppLocale {
  const tag = (systemLocale ?? '').toLowerCase();
  const language = tag.split(/[-_]/)[0];

  return language === 'ru' ? 'ru' : defaultLocale;
}

/**
 * Activates a catalog and returns the locale that was activated. The caller
 * supplies the system locale; reading it is an app-entry concern (P7).
 */
export function initI18n(systemLocale?: string): AppLocale {
  const locale = resolveLocale(systemLocale);

  i18n.loadAndActivate({locale, messages: catalogs[locale]});

  return locale;
}
```

`resolveLocale('RU-ru')` returns `'ru'` because the tag is lowercased before the language subtag is split off — that is the case the test pins.

- [ ] **Step 11: Generate the empty catalogs**

```bash
pnpm lingui:extract
```

Expected: Lingui reports `en` and `ru` with 0 messages and creates `src/locales/en/messages.po` and `src/locales/ru/messages.po`. Confirm both files exist and contain only gettext headers — P6 fills them.

- [ ] **Step 12: Run the test to verify it passes**

```bash
pnpm test __tests__/i18n.test.ts
```

Expected: PASS — 13 tests.

- [ ] **Step 13: Verify Metro can actually bundle the Lingui pipeline**

```bash
pnpm bundle:android
```

Expected: Metro writes `.metro-bundle-check/index.android.bundle` and exits 0. This is the only check in the entire run that exercises `@lingui/metro-transformer`, the macro Babel plugin and the `.po` source extension together — Jest maps `.po` to a stand-in and therefore proves nothing about them. If this step fails, the fault is in Steps 6, 7 or 11, not in the test. If it fails with `ENOENT` for the output directory, run `mkdir -p .metro-bundle-check` and re-run.

- [ ] **Step 14: Run the gate**

```bash
pnpm typecheck && pnpm lint && pnpm test
```

Expected: all green — the whole suite again, because `jest.config.js` and `babel.config.js` both changed.

- [ ] **Step 15: Commit**

```bash
git add -A
git commit -m "Add the Lingui en/ru localization pipeline and i18n scaffold"
```

---

## Final verification

After Task 6, run the merge gate exactly as sync 1 will run it:

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm build:android
```

Expected: all four green, with the Jest run reporting seven suites — `App.test.tsx`, `toolchain.test.ts`, `project-structure.test.ts`, `android-manifest.test.ts`, `ios-config.test.ts`, `dependencies.test.ts`, `i18n.test.ts` — and 52 passing tests (1 + 7 + 7 + 11 + 9 + 4 + 13).

Confirm as well:

- `git status --porcelain` is clean, and in particular `android/local.properties` and `.metro-bundle-check/` do not appear — both are ignored.
- `android/gradle.properties` still contains `newArchEnabled=true`.
- `package.json` `"dependencies"` contains `@lingui/core`, `@lingui/react`, `@reatom/core`, `@reatom/react`, `errore`, `react`, `react-native`, `react-native-safe-area-context`, `@react-native/new-app-screen`. No later plan should need to add to this list.
