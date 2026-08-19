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

Updated 2026-08-19. Everything the 2026-08-18 export recorded here — the colour
deltas, the swapped corners, the receded opacity, the font-weight inventory —
was closed by the reconciliation of 2026-08-18/19
(`docs/superpowers/plans/2026-08-18-design-reconciliation.md`) and the residual
fix pass that followed. What still stands:

- **The saved-step bind card shows only the `device` row.** The canvas's card
  lists `service`, `characteristic` and `press / release` too
  (`03 Pairing.dc.html`, frame 04), but `RadioState.pttButton` publishes none
  of them — a model-owning change, deferred (audit item C3).
- **Oswald 600 renders as 700.** The canvas asks for Oswald 600 on `.display`
  and `.obtitle`; the app bundles Regular/Medium/Bold, so 600 maps to Bold.
  An accepted delta, decision D3 in the reconciliation plan, not an oversight.
- **The spacing scale is invented.** `theme.ts`'s `spacing` (xs…xxl) is the
  app's own; the canvas states per-class figures instead, and those are carried
  verbatim in `theme.ts`'s named groups (`chrome`, `stage`, `sizes`,
  `routeReadout`, …) where a screen needs them.
- **No rasterized visual pass yet.** The reconciliation was token- and
  structure-level; no side-by-side render comparison against the canvas frames
  has been made.
