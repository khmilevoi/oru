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

**2026-08-19 — extended locally for the in-app language picker** (amended spec §12.2 of
`docs/superpowers/specs/2026-08-13-offline-nearby-ptt-design.md`): `02 Settings` gained a
Language section in both frames — a segmented control with the endonym options
English / Русский (labels literal, never translated; the selected side follows the frame's
`lang`), and `01 Radio`'s canvas note no longer says "no in-app picker".

**2026-08-19 — the power-off hold moved off the key and onto the whole screen.**
Holding the corner power key filled a 3pt bar inside the 56pt key — directly under the
thumb doing the holding, so nobody ever saw it. `01 Radio` gains five frames (09–13) and
`theme.css` seven `--seal-*` tokens for the replacement, an amber **perimeter seal**:

- **09 / 10 / 11** — the hold at 15% / 55% / 95%. Four 3pt rails inset 16pt from the screen
  edge. Both grow from the power key's own corner (bottom-right), one along the bottom then
  up the left, the other up the right then along the top, closing together on the far corner
  at 100%. Each path is exactly `railW + railH` long for any rectangle, so the two always
  arrive together with no per-device constant. Under them a corner-anchored amber wash
  (`--seal-wash`) tracks progress; the ring's border recedes and its label cross-fades to
  the amber power-off line.
- **12** — the abort. An early release cancels the commit and runs the same value back to 0
  over 260ms, the rails retracting into the key they came from. The frame's faint trailing
  rails are a canvas device for a still image, not a layer to build.
- **13** — the 55% state in the alternate locale, matching the file's existing alt-locale
  frames 06/07.

Amber, deliberately: red is TRANSMITTING and already owns a full-screen wash, green is
peers and receiving; amber is the only unspent accent and already means "armed, finish the
action" on `03 Pairing`. The treatment is scoped to the **live** screen's corner key only —
the off screen's hero key is a plain tap and must not grow a hold. New string pair
`holdOff` / `holdOffCls` in both locale tables. A `.canvasnote hold` under frames 09–13
carries the full implementer contract: geometry, derived breakpoints, timings, easing,
abort, completion, reduced motion, and the RN primitives it is restricted to (no new
dependency — an SVG dash-offset ring is noted as the ruled-out alternative).

**Both 2026-08-19 changes are local only — not yet pushed back to the ORU project; they
need a DesignSync push** (`02 Settings.dc.html`, `01 Radio.dc.html`, `theme.css`) before the
canvas project and this export match again.

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
| `01 Radio.dc.html` | Main screen — thirteen frames: off, searching, ready, transmitting, receiving, off/ready in the alternate locale, the audio-route-readout states sheet, and the power-off hold seal at 15/55/95%, aborted, and at 55% in the alternate locale |
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
