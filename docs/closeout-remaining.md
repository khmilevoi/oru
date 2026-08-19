# Closeout — remaining operator items

Run `2026-08-13-offline-nearby-ptt` finished on 2026-08-18: all five plans merged, every
merge gate green (41 suites / 599 tests, Android `BUILD SUCCESSFUL`), the merged trunk
compiles for the iOS Simulator, DoD §4 statically verified, `ru` catalog complete. What
remains needs physical hardware or a manual host step and is deliberately left unticked in
`docs/superpowers/execution/2026-08-13-offline-nearby-ptt.md`.

## Stage 5 — the purchased BLE PTT button

- Reverse-engineer the purchased button: nRF Connect, GATT inspection — find the notify
  characteristic and its pressed/released values.
- Run the learning flow end-to-end with the real button on both platforms (the generic
  learning drivers are merged; only the concrete button's protocol is unknown).
- If the button turns out to be HID-only: record the R2 fallback — the button stays
  Android-only, and a GATT-capable button is purchased for iOS.

## Stage 6 — reliability matrix on physical devices

Run on real Android + iPhone, internet off, screens locked. The scripted scenarios live in
`docs/stage4-integration-acceptance.md`.

- 5 min / 30 min / multi-hour locked-screen sessions with audio both ways.
- PTT-button loss + reconnect.
- Peer loss + reconnect (brief signal loss must recover via the native backoff).
- Incoming call during a session.
- Bluetooth headphones connected; audio route switch mid-session — superseded by the
  `2026-08-18-seamless-headphone-audio` run's §9 behavior-contract oracle and §10 hardware
  checklist (`docs/superpowers/execution/2026-08-18-seamless-headphone-audio.md`), which cover
  this route switch and more; run it there, not here.

## Host / project notes (not blockers)

- `xcode-select` on this Mac points at `/Library/Developer/CommandLineTools`, so bare
  `xcodebuild` and `pnpm ios` fail. One-time fix:
  `sudo xcode-select -s /Applications/Xcode.app`
  (until then, prefix builds with `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer`).
- The bundled fonts folder still needs to be added to `ios/Oru.xcodeproj` by hand in Xcode —
  see the README's iOS section.
- The schedule's closeout text still says the macOS build uses the
  `com.apple.developer.push-to-talk` entitlement; that text predates the 2026-08-18 removal
  of PushToTalk and was left as written (the schedule is a record). The build actually runs
  unsigned, with empty entitlements — do not re-add the PTT entitlement.
- `pnpm lingui extract` rewrites two stale source-line references in the `*.po` catalogs
  (`BackgroundStep.tsx`); harmless — commit the refresh whenever the catalogs next change.
