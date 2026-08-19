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

Both 2026-08-19 changes were pushed back to the ORU project via DesignSync the same day
(`02 Settings.dc.html`, `01 Radio.dc.html`, `theme.css`). The remote was read first and
carried no edits of its own since the 2026-08-18 push, so nothing was clobbered; the write
was verified by re-fetching `theme.css` and confirming it carries the `--seal-*` tokens.
The canvas project and this export match again.

**2026-08-19 — the talk ring is recorded as geometrically invariant, and the canvas was
corrected to match.** The product owner reported the big round button *jumping* the moment
"HOLD TO TALK" is pressed. It was two defects, both faithfully ported from this canvas:

- `01 Radio` frame 04 is the only ring frame carrying a `.subhint` under the ring
  ("RELEASE TO FINISH"). `.stage` centres its column, so rendering that hint in the
  transmitting state alone grew the column by a 40 gap plus a line and lifted the ring
  **29pt at the instant of the press**. The area under the ring is now a `.hintslot`
  **reserved in every ring frame** (03, 05, 07, 09–13 reserve it empty; 04 fills it), at
  two lines of `.subhint` — the worst case across locales, since
  "ОТПУСТИТЕ ЧТОБЫ ЗАКОНЧИТЬ" wraps where "RELEASE TO FINISH" does not.
- `.ringrx` restated `border-width: 3px` against `.ring`'s 2px. With no `box-sizing`
  reset, that drew the receiving circle 308px across where every other frame's is 306px.
  **2px is canonical** — it is what four of the five states already share, and a border is
  part of the box. The heavier receiving edge is design intent and is kept as *paint*: an
  `inset 0 0 0 1px` shadow just inside the 2px border here, and an absolutely positioned
  overlay ring in the app. Same 3pt of green, zero layout cost.

A new `.canvasnote geometry` block under frames 03–05 carries the rule for implementers,
and `theme.css`'s `.ring` is annotated as the canonical border. Both files were pushed to
the ORU project on 2026-08-19 by the main session (the branch that made the change had no
DesignSync tool of its own). The remote was read first and still matched the earlier push,
so nothing was clobbered; the write was verified by re-fetching `01 Radio.dc.html` and
confirming it carries the reserved `.hintslot` and the geometry note.

**2026-08-19 — the settings version nameplate rides the content instead of being pinned
over it.** Scrolling had just been added to Settings, and the `.vers` nameplate was ported
from this canvas the way the canvas draws it: absolutely positioned against the frame at
`bottom: 24`, floating above the scroll region, always visible, with the list padded to
keep its last card from sliding underneath. The product owner rejected that on sight — a
permanent row hovering over moving content reads as a defect. The nameplate is now the
**last element of the settings content, in flow**: an auto top margin inside a content box
that is at least a viewport tall, so it rests on the bottom edge while the content is short
and scrolls away with the content once it is long. Both halves of the owner's sentence, out
of one declaration.

The frames themselves are unchanged and remain correct as drawn — at these content lengths
the pinned and in-flow treatments render identically, and a `.phone` is a fixed 390×844 box
with `overflow: hidden` that can never scroll, so absolute positioning is the only way a
still image can show a row resting at the foot of a screen. The divergence is therefore
recorded rather than redrawn: a new `.canvasnote vers` under the two frames in
`02 Settings.dc.html` carries the rule, why the CSS still says `position: absolute`, how to
build it, the 24 below it and where the gesture-bar inset goes, and the history; `theme.css`
annotates `.vers` with the same in short. Nothing else in either file changed, and no token
moved.

`02 Settings.dc.html` and `theme.css` are **owed a DesignSync push** — the branch that made
this change has no DesignSync tool, so the main session pushes them. Read the remote first:
the last write was the 2026-08-19 talk-ring correction, and anything on the remote newer
than that is someone else's and must not be clobbered.

**2026-08-19 — icons over words.** The product owner: *"Instead of HOLD TO TALK I want
an icon — it is more laconic and simpler. And in the design generally, try to use icons
for readability and brevity."* All four screens and `theme.css` changed.

The ring is the case that proves the ask. `HOLD TO TALK` is short; «УДЕРЖИВАЙТЕ ЧТОБЫ
ГОВОРИТЬ» is not, and the design had already dropped the ring's type scale from 40pt to
33pt and pre-broken the string across two lines to fit one locale. **A glyph is the same
size in every language.** `01 Radio` frames 03 / 07 / 12 now carry a hand-built
microphone — the first icon this canvas has ever put inside the talk ring — and the ring
itself is untouched: same 302 diameter, same 2pt border box, same centre. The glyph is a
*child* of a fixed box, and **no sibling of the ring was added to `.stage`**.

**The hold caption stays, demoted.** A static glyph cannot say "hold", and tap-versus-hold
is the one thing a user cannot discover by looking: a tap yields a sub-100ms transmission
or nothing, indistinguishable from a broken app. So the ready state keeps one 13pt
`.subhint` line — `HOLD` / «УДЕРЖИВАЙТЕ», the verb only, since the glyph supplies "talk" —
in the `.hintslot` that the geometry fix already reserved and left *empty* in this state.
It therefore costs **zero layout**, and spends about a quarter of the ink the 40pt headline
did. The instruction was not removed, it was moved out of the headline slot and into chrome.

The rest of the pass, each with the word relocated rather than deleted:

- **`STEP n OF m` deleted** (`04 Onboarding`) — `.obdots` already rendered exactly that.
  The strings survive as the dot row's `accessibilityLabel`. Because the dots are now the
  only step indicator, they differ by **shape**, not only hue: pending is a hollow ring,
  current an 18×6 `--ink` pill, done a filled `--green` dot.
- **`BUTTON CONNECTED` deleted** (`03 Pairing`) — a 96pt green tick restating itself in
  30pt display type directly underneath. The mark grew to the shared 132pt `.okbig`, which
  moved to `theme.css`, so **both success moments in the product are now one glyph**.
- **Route readout dropped the generic device word** — the glyph says speaker / wired /
  bluetooth in every locale at once. Only a Bluetooth route adds text of its own: the
  headset name exactly as the OS reports it. The **mode stays a word** ("radio" / "music,
  phone mic") — it is a policy statement about what the headset is for, not a state.
  Frame 08 gained a nameless-headset row.
- **`still scanning` became the pulsing amber dot**, moved onto the `Found` section label
  so it has something to anchor to; a whole row of chrome deleted.
- **`BLE ·` became four signal bars** (`.sig`, new). The dBm figure **stays** — four bars
  cannot separate two similarly named buttons on the same shelf. RSSI→bars mapping is
  stated so nobody invents one.
- **The settings connection dot is state-coloured** (`.pdot.off`, new). Frame 02 had no dot
  where frame 01 had a green one, which is how the app came to show green beside
  "Not connected". Both frames now carry the same `.devrow`.
- **The gear stopped being a codepoint.** The canvas drew it as `⚙` U+2699 with VS15 while
  the app had already rebuilt it from Views, because U+2699 renders as a colour emoji
  without the variation selector and VS15 is unreliable on Android. The canvas now draws
  the same primitive gear (eight 3×6 teeth on wrappers rotated k×45°, hub ring inset 5 at
  2pt), so reference and build agree.

New in `theme.css`: eight `--icon-*` tokens, and the shared `.micmark` / `.gearmark` /
`.sig` / `.okbig` / `.pdot.off` components. The microphone is **one glyph at two idioms** —
every part is a fraction of its box, so only `--m` and `--ms` change between the ring's
160/3.5 and onboarding's 176/2.5.

`01 Radio` gained **frame 14, an icon-system glyph sheet** (each new glyph at size and at
3×, with its full construction spec) and a `.canvasnote icons` carrying the contract: the
four idioms and when each applies, why stroke belongs to the idiom and not the pixel count,
primitives-only with the arc and rotation tricks named, never-an-emoji-codepoint, the
colour discipline (a ready-state glyph in the talk ring is `--ink`, never an accent), the
accessibility rule — **the word is not deleted, it moves to the accessible name**, and every
decorative glyph is hidden from the tree — and the list of labels that **stay words** with
the reason for each: `PRESS THE PTT BUTTON` (the target is a physical button in the user's
other hand), `TRANSMITTING…` / `RECEIVING…` (icon-only would separate TX from RX by hue
alone and delete the only announcement of the live state), `Auto / Radio / Music` (a
speaker-vs-note glyph would read as "output device", the exact wrong model, and "Auto" has
no glyph), permission-consent titles, every `.btn` label, `TAP TO TURN ON`, `RADIO OFF`.

One accessibility fact shaped the ring change and is recorded in the note so nobody
over-builds: the ready ring already sits inside a pressable declaring
`accessibilityRole="button"` and the name "Push to talk" / «Нажмите и говорите», so no
screen reader has ever announced `HOLD TO TALK`. **The glyph costs nothing in accessible
name — and must not be given a redundant one of its own.**

All five files (`theme.css`, `01 Radio`, `02 Settings`, `03 Pairing`, `04 Onboarding`) are
**owed a DesignSync push**; the branch that made the change has no DesignSync tool, so the
main session pushes and verifies, reading the remote first as on the earlier pushes.

Spec §12.1 (`docs/superpowers/specs/2026-08-13-offline-nearby-ptt-design.md`) points at this
canvas as the source of the visual design, but until now it was never exported — the P6 UI
plan states this outright and records reconciling the app's tokens against the canvas as an
open closeout item. These files close the export half of that gap. **They are the reference,
not the implementation**: nothing here is built or bundled, and `src/ui/theme.ts` still
carries the values the plan invented from §12.1's one-sentence written direction.

## Files

| File | What it is |
|---|---|
| `theme.css` | Shared tokens (colours, fonts, the `--icon-*` idiom scale) and the component styles every screen reuses, including the hand-built glyphs (`.micmark`, `.gearmark`, `.sig`, `.okbig`) |
| `01 Radio.dc.html` | Main screen — fourteen frames: off, searching, ready, transmitting, receiving, off/ready in the alternate locale, the audio-route-readout states sheet, the power-off hold seal at 15/55/95%, aborted, and at 55% in the alternate locale, and the icon-system glyph sheet |
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
