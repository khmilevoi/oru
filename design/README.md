# Design canvas — Offline Nearby PTT

Verbatim export of the Claude Design project **ORU**
(<https://claude.ai/design/p/d07936f3-e452-4039-bda7-bb80b599e104>), pulled 2026-08-18.

**2026-08-18 — extended for the seamless-headphone-audio spec**
(`docs/superpowers/specs/2026-08-18-seamless-headphone-audio-design.md` §3 D2/D4, §8):
`01 Radio` gained the audio route readout — a bottom-centre engraved indicator
(route icon + device + mode; voice mode reads "radio", media reads "music, phone mic"),
shown per state across frames 02–05 and 07 plus a new frame 08 enumerating every
route/mode/locale variant; `02 Settings` gained an Audio section with the one
`audioMode` setting (auto | voice | media, default auto, rendered Auto / Radio / Music)
as a segmented control in both frames. Both changes carry en/ru copy; `theme.css` is
untouched. Both changed screens were pushed back to the ORU project via DesignSync on
2026-08-18 (write verified: the remote `02 Settings.dc.html` was re-fetched and carries
the Audio section), so the canvas project and this export match again.

Spec §12.1 (`docs/superpowers/specs/2026-08-13-offline-nearby-ptt-design.md`) points at this
canvas as the source of the visual design, but until now it was never exported — the P6 UI
plan states this outright and records reconciling the app's tokens against the canvas as an
open closeout item. These files close the export half of that gap. **They are the reference,
not the implementation**: nothing here is built or bundled, and `src/ui/theme.ts` still
carries the values the plan invented from §12.1's one-sentence written direction.

## Files

| File | What it is |
|---|---|
| `theme.css` | Shared tokens (colours, fonts) and the component styles every screen reuses |
| `01 Radio.dc.html` | Main screen — eight frames: off, searching, ready, transmitting, receiving, off/ready in the alternate locale, and the audio-route-readout states sheet |
| `02 Settings.dc.html` | Settings — button connected / not configured; both frames carry the Audio section (`audioMode`) |
| `03 Pairing.dc.html` | Pairing — scan, select, learn, saved |
| `04 Onboarding.dc.html` | Onboarding — microphone, Bluetooth, nearby devices, done |
| `support.js` | Generated Claude Design canvas runtime; renders the `<x-dc>` templates. Not app code — do not edit |

Each screen file carries a `lang` prop (`en` / `ru`) holding the canvas's own copy for both
locales, so it doubles as a reference for the Lingui catalogs. `01 Radio` and `02 Settings`
and `03 Pairing` default to `en`; `04 Onboarding` defaults to `ru`.

Open a screen file directly in a browser — the relative `./theme.css` and `./support.js`
links resolve from this directory. Fonts load from Google Fonts, so first render needs
network; the app bundles Oswald and IBM Plex Mono locally instead.

The project's `.thumbnail` entry is a generated canvas preview and was not exported.

## Known divergences from `src/ui/theme.ts`

Recorded here as the starting point for reconciliation, not as a change:

- **Colours differ throughout.** Chassis `#0b0d0f` vs the app's `#0a0c0d`, panel `#13161a`
  vs `#14181a`, text `#f2f4f2` vs `#e7ecee`. The status colours are the widest gap — the
  canvas specifies them in oklch, which resolves to roughly `#35c26d` / `#ed413b` /
  `#eba941` against the app's `#2fd65b` / `#ff3b30` / `#ffb020`.
- **Corners are swapped.** The canvas puts the settings gear bottom-**left** and the power
  key bottom-**right**.
- **Receded opacity** is `0.34` in the canvas, `0.15` in `theme.ts`.
- **Font weights.** The canvas loads Oswald 500/600 and IBM Plex Mono 400/500/600; the app
  bundles Oswald Regular/Medium/Bold and IBM Plex Mono Regular/Medium/SemiBold.
