# Section 11 permission cross-check

This document reconciles every declaration §11 of
`docs/superpowers/specs/2026-08-13-offline-nearby-ptt-design.md` requires (plus every
declaration in `android/app/src/main/AndroidManifest.xml` and `ios/Oru/Info.plist` that
is *not* in §11's table) against the merged code that actually needs it. Each row below
was re-verified against the tree on 2026-08-18, not assumed from the plan: the "used by"
cell states the code and the `grep` evidence that backs it, drawn from the four commands
in this task's brief, plus the manifest, `Info.plist`, and the `src/permissions` onboarding
sequence read directly. `__tests__/permission-crosscheck.test.ts` pins this table — a
permission added to the manifest without a matching line here fails that test.

## The verdict table

| Declared | §11? | Used by | Verdict |
|---|---|---|---|
| `RECORD_AUDIO` | yes | `AudioEngine.kt` opens an `android.media.AudioRecord` for capture (confirmed: `grep AudioRecord android/app/src/main/java/com/oru/radio/AudioEngine.kt`); requested by the `microphone` onboarding step (`src/permissions/permissions.types.ts`: `microphone -> RECORD_AUDIO`) | keep |
| `BLUETOOTH_SCAN` / `BLUETOOTH_CONNECT` / `BLUETOOTH_ADVERTISE` | yes | Nearby Connections' BLE medium and the PTT button's BLE driver; requested by the `bluetooth` onboarding step (`src/permissions/permissions.types.ts`: `bluetooth -> BLUETOOTH_SCAN + BLUETOOTH_CONNECT + BLUETOOTH_ADVERTISE`) | keep |
| `NEARBY_WIFI_DEVICES` | yes | Nearby on API 33+; requested by the `nearbyDevices` onboarding step (`src/permissions/permissions.types.ts`: `nearbyDevices -> NEARBY_WIFI_DEVICES + ACCESS_FINE_LOCATION`) | keep |
| `ACCESS_FINE_LOCATION` | yes, unconditional | Nearby's BLE medium on every API level — `play-services-nearby` throws `ConnectionsStatusCodes 8034 MISSING_PERMISSION_ACCESS_COARSE_LOCATION` without it (spike Bug #3, manifest comment lines 22–33); requested alongside `NEARBY_WIFI_DEVICES` by the `nearbyDevices` step. `grep -n "uses-permission" android/app/src/main/AndroidManifest.xml` confirms it carries no `android:maxSdkVersion` | keep, never `maxSdkVersion` |
| `ACCESS_BACKGROUND_LOCATION` | yes | Nearby rediscovery with no visible Activity (spike Bug #5, manifest comment lines 35–43); requested by Task 7's step, `src/permissions/platform.gateway.ts` (`requestBackgroundLocation`, `hasBackgroundLocation`), preceded in-app by `src/screens/BackgroundStep.tsx` | keep |
| `POST_NOTIFICATIONS` | yes | the foreground-service notification on API 33+; requested by Task 7's step, `src/permissions/platform.gateway.ts` (`requestNotifications`, `PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS`) | keep |
| `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_MICROPHONE`, `FOREGROUND_SERVICE_CONNECTED_DEVICE` | yes | `android/app/src/main/java/com/oru/radio/RadioForegroundService.kt`; the manifest's `<service>` element declares `android:foregroundServiceType="microphone\|connectedDevice"` (confirmed: `grep -n "uses-permission" android/app/src/main/AndroidManifest.xml` and the `<service>` block at the end of the same file) | keep |
| `INTERNET` | no | Metro's dev bundle and Play Services' own transport (`grep -n "uses-permission" android/app/src/main/AndroidManifest.xml` line 3, no §11 comment above it) | keep, justified |
| `MODIFY_AUDIO_SETTINGS` | no | `RadioForegroundService.kt` sets `AudioManager.mode = MODE_IN_COMMUNICATION` and drives SCO routing. Confirmed: `grep -rn "MODE_IN_COMMUNICATION\|startBluetoothSco\|setCommunicationDevice" android/app/src/main/java/com/oru/radio/` hits `mode = AudioManager.MODE_IN_COMMUNICATION` (lines 435, 443), `audioManager.startBluetoothSco()` (line 643), and `audioManager.setCommunicationDevice(target)` (line 610) | keep, justified |
| `ACCESS_WIFI_STATE`, `CHANGE_WIFI_STATE` | no | required by `play-services-nearby`'s Wi-Fi-based mediums (advertising/discovery fail immediately with `MISSING_PERMISSION_ACCESS_WIFI_STATE` without them, manifest comment lines 46–48). Confirmed: `grep -rn "play-services-nearby" android/app/build.gradle` — `implementation("com.google.android.gms:play-services-nearby:19.4.0")` (line 172) | keep, justified |
| iOS `NSMicrophoneUsageDescription`, `NSBluetoothAlwaysUsageDescription`, `NSLocalNetworkUsageDescription`, `NSBonjourServices`, `UIBackgroundModes = audio, bluetooth-central` | yes | the merged engine. Confirmed present in `ios/Oru/Info.plist`: all four usage-description keys (lines 41, 43, 47, 49); `grep -n "NSBonjourServices" -A 3 ios/Oru/Info.plist` shows the `_7384AB769DDA._tcp` service array; `UIBackgroundModes` (lines 62–66) contains exactly two `<string>` entries, `audio` and `bluetooth-central` | keep |
| any push-to-talk entitlement | removed 2026-08-18 (§10.2) | nothing — `ios/Oru/Oru.entitlements` is an empty `<dict/>`; `com.apple.developer.push-to-talk` appears nowhere in `Info.plist` or the entitlements file | must stay absent |

### A grep result that is not a bug

`grep push-to-talk ios/Oru/Info.plist` produces one hit, at line 42, inside the
`NSBluetoothAlwaysUsageDescription` string: *"Oru connects to your Bluetooth push-to-talk
button, including while the screen is locked."* That is user-facing copy describing the
physical hardware button the app pairs with, not the `com.apple.developer.push-to-talk`
entitlement — the entitlement string does not appear anywhere in the plist or in
`Oru.entitlements`. The test's assertion (`not.toContain('com.apple.developer.push-to-talk')`)
is deliberately specific to the entitlement identifier so this line does not trip it.

## Play Store Data Safety

`ACCESS_BACKGROUND_LOCATION` requires two things in the Play Console before release, neither
of which is a code change:

- a **Data Safety** disclosure declaring that the app collects approximate/precise location
  in the background, and why (Nearby rediscovery with no visible Activity — spike Bug #5);
- a **background location declaration form**, since API 29+ background location access is a
  restricted permission that Google reviews per app before it can ship on the Play Store.

Both are console tasks owned by whoever manages the Play Console listing, not this codebase.
The in-app step that precedes asking the user for "Allow all the time" is
`src/screens/BackgroundStep.tsx`, which explains the permission in the app's own language
before `requestBackgroundLocation()` triggers the system flow.

## Verdict

No manifest or plist edit was required. Every declaration in `AndroidManifest.xml` and
`Info.plist` was re-verified against the merged code above; all fifteen Android permissions
and all iOS usage-description/background-mode declarations match §11 or carry a written
justification, and no push-to-talk entitlement exists to remove. — 2026-08-18.
