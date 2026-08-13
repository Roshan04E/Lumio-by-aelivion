# Text and typography — the staged programme

- Drafted 2026-08-13. Design pass only; **no product code has moved.**
- Decisions live in `project-tracker/adr/023-text-typography-and-the-text-matte.md` (D1–D12,
  T-1–T-10). This file is the **sequence**; it does not re-argue the decisions.
- Standing rule applied throughout: **every stage ships a user-visible win on its own.** No stage
  builds infrastructure for a later stage without delivering something a user can see. Where a
  stage is genuinely enabling (S4), its own win is stated and must be real.

---

## The shape of it

```
S1  paint-order + stroke                  no manifest change, no schema change   ~1 day
S2  font reference + catalogue            manifest change (FontRef)              the big one
S3  user font upload                      storage + asset doctrine
S4  TextStyle as a PropertySchema         migration; unblocks S6
S5  tier-1 texture + CSS depth            rides S4
S6  caption + text preset library         rides S4; highest product value
S7  the text matte (tier 2) + matte ops   gated on OQ1 spike; largest blast radius
S8  SVG: multi-stroke + path text
S9  per-character + variable-axis animation
```

Ordering rationale, stated because two of these look reorderable and are not:

- **S2 before S6.** A preset that names a font the system cannot provide is a broken preset. The
  library must be able to guarantee its own fonts before it ships presets that use them.
- **S4 before S5.** S5 adds ~6 style properties. Adding them as loose CSS fields and *then*
  schematising makes S4's migration six fields larger, for no gain.
- **S7 last among the features.** It is the only stage that widens a core compiler type, and it is
  the only one gated on a spike. Everything ahead of it ships regardless of how OQ1 resolves.
- **S1 first** purely on value-per-line: one CSS declaration changes how every stroked title looks.

---

## S1 — `paint-order`, and stroke that does not eat the glyph

**Win:** strokes render behind the fill. Every stroked title and caption immediately looks like the
sticker-caption look people expect instead of a thinned glyph.

**Scope**
- Emit `paintOrder: "stroke fill"` alongside the existing `WebkitTextStroke`
  (`composition-style.ts:741`), in the same style object both renderers already consume.
- Optional per-style toggle so existing projects can keep the old look. Default for **new** text
  is stroke-behind; the change to existing projects is a visible pixel change and needs the founder
  call recorded in the commit.

**Not in scope:** multiple strokes (S8), stroke on the matte (S7).

**Verification:** a `render:compare:pixels` fixture with a heavy stroke, both renderers, 0.000%.
This is also the cheapest possible confirmation that the CSS reaches Remotion's Chromium at all —
worth having before S5 depends on it.

**Risk:** low. `paint-order` on text is Chromium-supported and both renderers are Chromium.

---

## S2 — The font reference, the catalogue, and the mirror

**Win:** the five-font ceiling (`renderSafeFonts`, composition-style.ts:122) is gone. The user
picks from the Google catalogue and it renders identically in the editor and the export, today and
in six months.

**Scope**
- `FontRef` in `packages/shared` (ADR-023 D1). Manifest change — both renderers, one commit (T-9).
- Ingest: parse the name table for family/weight/style (D2); the parse is also the validity gate.
  Reuse `opentype.js`, already a lazy dep of `font-outlines.ts`.
- **Mirror-on-first-use** into R2 at `fonts/catalogue/<fileHash>` (D4 shared store). A family is
  fetched from Google once, hashed, stored, and never fetched from Google again. Each mirror write
  includes the font's license file in the same operation (D4a/T-11) — not a follow-up step.
- Worker: resolve every `FontRef` in the composition and **install before rendering**. Unresolvable
  → abort with a named error (D3/T-2). Delete the `.catch(() => undefined)` at
  `export-core.ts:332`.
- Editor: substitute + surface, reusing the `needs-relink` vocabulary (`sync.ts:92`); block export
  until resolved.
- `getCompositionFontsUsed` (composition-style.ts:907) becomes a `FontRef` collector rather than a
  family-string collector.
- Font picker UI over the catalogue, with real previews.
- **Migration for existing projects is decided (D1a): none, ever, automatically.** An existing
  `fontFamily` stack normalizes to `{ source: "system" }` and keeps rendering exactly as today,
  permanently — the `LEGACY_PROJECT_COLOR_SETTINGS` shape applied to fonts. This stage needs a
  user-triggered, visible "pin this font" action per project, not a migration script.

**Also fold in:** `registerWarpFonts` / `configureFontResolver` (`font-outlines.ts:64,86`) become
consumers of the same catalogue rather than a parallel hand-maintained table. The hardcoded
`warpFontCatalog` at :52-60 is exactly the "future large font library" seam its own comment
describes; this stage is that future.

**Verification**
- Pixel fixture using a catalogue font that is **not** installed on the host — proves the install
  path is what put it there and not the machine.
- A negative test: a manifest with a bogus `fileHash` must **fail** the render, loudly. (The
  succeed-then-fail discipline applies: a permanently-broken font proves the setup fails, not that
  a *missing* font fails at the right point.)
- Determinism check: same manifest, two renders, byte-identical text region.

**Risk:** the largest surface-area stage. Manifest change + worker change + storage + UI.

---

## S3 — User font upload

**Win:** brand fonts. A user with a licensed font they own can use it.

**Scope**
- Upload → OPFS locally; opt-in cloud upload records a pairing (D5). No new sync concept.
- **Per-user store** at `fonts/user/<ownerId>/<fileHash>`, structurally separate from S2's mirror,
  as two types with no shared resolvable-URL supertype (D4/T-3). This is the stage where that
  invariant is either built correctly or built as a boolean; it will not be revisited cheaply.
- Missing on a second machine → the `needs-relink` flow (D3), export blocked.
- Format acceptance: `.ttf`/`.otf`/`.woff`/`.woff2`. Note `opentype.js` cannot Brotli-decode
  `.woff2` (`font-outlines.ts:35`), so a `.woff2` upload needs decompression before the name-table
  parse and before any warp use.

**Blocked on:** nothing from OQ4 — closed (D4a), and moot here anyway since user fonts are not
redistributed. OQ7 (a collaborator who cannot relink) **does** need an answer before sharing a
project with user fonts is a supported flow.

**Verification:** upload a font, render in the worker, confirm the bytes came from the per-user
path. Plus a test that a second account **cannot** resolve the first account's font by hash.

---

## S4 — `TextStyle` as a PropertySchema

**Win, standalone:** one text inspector, generated from the schema, replacing the ad-hoc controls —
with grouping, tooltips, search/command-palette reach, and copy-paste of a look between layers.
Copy-paste alone is a real user win and is the thing to demo for this stage.

**Scope**
- `TextStyle` as a `PropertySchema` (ADR-004): `{id: "text-style", version, metadata, groups, fields,
  migrations, documentation}`, produced by an adapter (ADR-005), rendered by `PropertyFieldList`
  (ADR-002), using only frozen field kinds (ADR-003). **If a text property appears to need a new
  kind, ADR-003's promotion rule applies — metadata first.**
- Collapse the `layer.X ?? style.X ?? default` reads in `composition-style.ts` into one resolved
  style object. `getCompositionTextStyle` becomes schema-resolution → CSS emission, two steps
  instead of one tangled one.
- The migration from loose fields. Sequence with S2's manifest migration: written together, applied
  in order, tested against real saved projects.
- Clipboard and (future) presets share the `{schemaId, version, values}` envelope (T-10).

**Verification:** pixel-identical output for every existing fixture after the migration — this stage
must change **no pixels**. That is the acceptance bar: a schema refactor that shifts a fixture has a
bug in the migration.

---

## S5 — Tier-1 texture and CSS depth

**Win:** gradient- and image-filled titles, stacked-shadow depth, per-line caption pills. Visible,
immediate, no architecture change.

**Scope** (all D7)
- `background-clip: text` — image and gradient fill. This is **tier 1** textured text and it covers
  the majority of real cases.
- Multiple `text-shadow`s as a list — hard-offset 3D looks, multi-colour glows.
- Per-line background pills.
- `font-variation-settings` exposed as animatable axes — **gated on OQ2**, a pixel-gate fixture
  proving both Chromiums instance the axis identically. If OQ2 fails, ship the rest of S5 and defer
  axes.

**Verification:** a fixture per feature, both renderers. `background-clip: text` interacts with
`mix-blend-mode` and `filter`, both of which `getCompositionTextStyle` already emits — test the
combination, not just the property.

---

## S6 — Caption presets and the text preset library

**Win:** **instant short-form captions.** `AUTO_CAPTIONS` already produces a caption track; a preset
applied over that track is the whole feature. This is the highest product value in the programme
and the reason S4 is worth doing.

**Scope**
- **Layer 1 presets** (D12): `{schemaId: "text-style", version, values}` as separate data, migrated
  by the schema's own migrations. Save, browse, apply, and apply-to-a-whole-caption-track.
- A first-party preset set: 10–15 caption looks, built entirely from S1+S5 capability.
- Shape presets over `drawShapeLayer` (`scene/text-shape.ts:596`) — shapes need a schema and presets,
  **not an engine**; the renderer already exists and is already shared with the scene raster path.
- **Layer 2 (graphics templates) is deferred out of this stage.** Lower-thirds and title cards are a
  stack of layers with placement and timing, and belong in `templates.ts` at that granularity. S6
  ships without them and is complete without them.

**Blocked on:** OQ8 — a preset that references a user-store font cannot resolve for another account.
Gates preset *sharing*; does not gate preset *saving*, so S6 can ship single-user first.

---

## S7 — The text matte, and matte edge operations

**Win:** video inside text. A generator, a procedural texture, a video source, or an **entire Flarex
comp** inside the glyphs. Plus roughened/torn edges, choke/spread and edge blur — which, because
they land on the matte, immediately work on every existing mask, key and tracked shape too.

**GATE: the OQ1 spike runs first and is a separate, reportable piece of work.** It must (i)
enumerate every `matteInput` consumer in `compile-flarex.ts` and classify each vector-only /
raster-capable / needs-work, and (ii) measure raster feather+choke against the existing vector
rasterizer at 1080p. **If the spike shows that a raster value forces early rasterization of chains
that could stay vector, T-7 is violated and S7 needs a different design** — do not proceed on the
assumption that it will be fine.

**Scope, assuming the spike clears**
- Widen `FlarexMatteValue` (compile-flarex.ts:189-195) to a vector|raster union (D9 option (a)).
  Vector chains stay vector and stay lossless (T-7).
- The `text` node (`node-defs.ts:600`) gains a `matte` output socket. It is then an ordinary
  matte source and needs no other new vocabulary — `matteControl`, the keyer's garbage/hold-out,
  and the region pass all consume it as-is.
- Matte edge ops as matte-vocabulary nodes/params (D10/T-6): roughen, choke/spread, edge blur.
  `feather` already exists on both `Mask` (types.ts:463) and `matteControl` — extend that vocabulary,
  do not start a second one.
- **The font hash goes into the text raster's content hash** (D11/T-8). Not optional, and not
  satisfiable by the existing `document.fonts` listener alone — that is a liveness signal, and this
  repo has a named bug class for correctness resting on one (DEBT-009).

**Explicitly not in this stage:** any edge treatment on the text node's params. T-6.

---

## S8 — SVG: multiple strokes and text on a path

**Win:** concentric multi-colour outlines, and arc/path text.

**Scope:** an SVG rendering surface used **only** by styles that need it; DOM otherwise (D8).
`<text>`/`<textPath>` keeps browser shaping, so T-5 holds. Both renderers, one fixture each.

**Watch:** this is a second rendering surface for text, so every style property in S5 needs a
defined behaviour on it (or an explicit "not available in path mode" in the schema). The schema
from S4 is what makes that expressible rather than a pile of runtime conditionals.

---

## S9 — Per-character and variable-axis animation

**Win:** per-character reveals, stagger, wave, and continuous weight/width animation.

**Scope:** builds on the existing `TextRun`s (`getCompositionTextRuns`, composition-style.ts:746)
and the existing keyframe evaluator (`animation.ts`) — no new animation system.

**Blocked on OQ6, which is a correctness question, not a polish one:** an animated "character" must
be a **grapheme cluster**, never a code unit, or combining marks, emoji ZWJ sequences and Devanagari
conjuncts break. And per-cluster transforms break the shaping run — each animated cluster becomes
its own shaping context, changing kerning. Decide the model before writing the animation.

---

## Cross-cutting obligations

**Both renderers, every stage.** `apps/web/src/components/VideoPreview.tsx` **and**
`apps/worker/src/remotion/Root.tsx`, in the same change, with a `render:compare:pixels` fixture
(T-9). Text parity is free for *layout* and for nothing else.

**Two migrations, one design.** S2's manifest migration and S4's schema migration touch the same
saved data. Write both before shipping either.

**Fixtures accumulate.** Each stage adds at least one. Before every pixel run, check for a stray
headless Chrome or leftover vite-server node tree — a dirty machine has voided runs here before.

**Open questions belong to stages.** OQ1→S7 (gate, still open — the spike), OQ2→S5 (gate on one
feature), OQ3→S2 (lean: full files), OQ6→S9 (gate), OQ7→S3, OQ8→S6 (gates sharing only). OQ4 and
OQ5 are **closed** (D4a, D1a) and need no gate — S2 proceeds on the decided values.

---

## What this plan does not claim

No number in this document or in ADR-023 is measured. The effort shapes are estimates and the
"~1 day" on S1 is the only one stated at all, deliberately. ADR-021 is the model for the *form* of
these documents, but ADR-021's limits were provisional against data and these are provisional
against nothing yet. The first measurement this programme should produce is the OQ1 spike.
