# Text and typography — the staged programme

- Drafted 2026-08-13. Design pass only; **no product code has moved.**
- Decisions live in `project-tracker/adr/023-text-typography-and-the-text-matte.md` (D1–D12 plus
  D1a/D4a/D9a, T-1–T-12). This file is the **sequence**; it does not re-argue the decisions.
- Standing rule applied throughout: **every stage ships a user-visible win on its own.** No stage
  builds infrastructure for a later stage without delivering something a user can see. Where a
  stage is genuinely enabling (S4), its own win is stated and must be real.

---

## The shape of it

```
S0  interim: disable warp on shaping-dependent scripts   independent, immediate   ~half a day
S0b base text direction (RTL)             rides S0's detector; live correctness   ~1 day
S0c raster honours direction              closes S0b's two measured gaps        ~1-2 days
S1  paint-order + stroke                  no manifest change, no schema change   ~1 day
S2  font reference + catalogue            manifest change (FontRef)              the big one
S3  user font upload                      storage + asset doctrine
S4  TextStyle as a PropertySchema         migration; unblocks S6
S5  tier-1 texture + CSS depth            rides S4
S6  caption + text preset library         rides S4; highest product value
S7  the text matte (tier 2) + matte ops + warp rework   gated on OQ1 for the matte
                                                          half only; largest blast radius
S8  SVG: multi-stroke + path text
S9  per-character + variable-axis animation
```

Ordering rationale, stated because two of these look reorderable and are not:

- **S0 first, ahead of everything, including S1.** It fixes a live, already-shipped defect
  (D9a/T-12: warp silently renders wrong for shaping-dependent scripts) and depends on nothing else
  in this programme. There is no reason to sequence it behind S1 just because S1 is also small.
- **S0b immediately after S0, and not later, for one reason: the detector.** S0b is also a live
  defect (D6a — no base direction anywhere in `packages/shared`), but that is not why it sits here.
  It sits here because it consumes the *same* script detection S0 builds. Sequenced anywhere else it
  builds a second detector answering the same question, and two of those drift. If S0 has already
  shipped a boolean detector, S0b's first task is widening it, not writing another one.
- **S2 before S6.** A preset that names a font the system cannot provide is a broken preset. The
  library must be able to guarantee its own fonts before it ships presets that use them.
- **S4 before S5.** S5 adds ~6 style properties. Adding them as loose CSS fields and *then*
  schematising makes S4's migration six fields larger, for no gain.
- **S7 last among the features.** Its matte-widening half is the only stage that changes a core
  compiler type, and it is the only one gated on a spike (OQ1). The warp-rework half riding along in
  S7 is **not** gated by OQ1 — it doesn't touch `FlarexMatteValue` — but is sequenced here anyway
  because it is the same conceptual reclassification (D10's matte vocabulary) and splitting it into
  its own stage would mean explaining "matte operation" twice.

---

## S0 — Interim: warp detects a shaping-dependent script and disables itself, visibly

**Win:** warp stops silently rendering wrong. Today, warping Arabic, Devanagari, Thai or any other
shaping-dependent script text produces incorrect glyphs with no indication anything is wrong — the
same shape of failure as the empty warp-font-catalogue incident (`font-outlines.ts:50`), where a
missing feature looked like a working one. This stage makes the gap visible instead of silent.

**Scope**
- Script detection on the layer's text content (a small, targeted check — Unicode block ranges for
  the scripts `opentype.js` glyph lookup cannot shape correctly: Arabic, Hebrew, Devanagari and other
  Indic scripts, Thai, and complex emoji ZWJ sequences).
- **AMENDED 2026-08-13 (D6a/T-12): the detector returns the detected script and its direction, not
  a boolean.** Shape it as `{ script, shapingDependent, direction }` — not `boolean`, and not a
  warp-private helper. S0b consumes the identical detection for `direction: "auto"`, and the whole
  point of amending mid-flight rather than filing a follow-up is that the second consumer never
  writes a second detector. Live it in shared text code, not inside the warp module. Warp uses only
  the `shapingDependent` field; the others exist because the next stage needs them, and that is the
  one case where anticipating a consumer is correct — the alternative is not "less code," it is
  "two detectors."
- When detected on a layer with warp enabled: warp does not apply, and the layer shows a visible
  marked state (reuses the same "degraded, needs attention" vocabulary as D3's font substitution
  banner) rather than rendering the wrong glyphs with no signal.
- No engine change. This does not touch `text-warp.ts`/`text-warp-mesh.ts`/`font-outlines.ts` — it
  gates whether they run.

**Not in scope:** the actual fix (S7 folds in the rasterize-then-deform rework, D9a). This stage is
strictly interim and is retired — the detection code deleted, not merely disabled — the moment S7's
warp rework ships, per T-12.

**Verification:** a fixture with Arabic text and warp enabled; before this stage it renders wrong
with no signal, after this stage it renders unwarped with a visible marker. No pixel-comparison
fixture needed (there's no "correct warped Arabic" render to compare against yet — that's S7).

**Risk:** very low. Additive, narrow, and does not touch any renderer's shared code path.

---

## S0b — Base text direction: RTL text that is actually right

**Win:** Arabic and Hebrew text lays out correctly — punctuation on the correct side, mixed
Arabic-and-Latin in the correct order, right-edge alignment by default. Today every text layer in
every project renders at the CSS initial `direction: ltr`, because `direction`, `dir` and
`unicode-bidi` appear nowhere in `packages/shared` (verified 2026-08-13). This is a live defect for
a whole class of users, and it is one that passes our gates: a pure-Arabic run still resolves to
correct visual order under `ltr`, so a pixel fixture is clean while the render is wrong to anyone
who reads the script.

**Scope**
- `direction?: "auto" | "ltr" | "rtl"` on the text layer (ADR-023 D6a). Manifest change, both
  renderers, one commit (T-9).
- Emission: `"auto"` → `unicode-bidi: plaintext` (the browser's own first-strong P2/P3 rule);
  `"ltr"`/`"rtl"` → explicit `direction` with `unicode-bidi: isolate`. **We do not implement
  first-strong resolution ourselves** (T-5, T-13) — the delegation is the decision.
- `textAlign` gains `"start"`/`"end"`. Existing `"left"`/`"right"` keep meaning physical left and
  right, forever, and are never remapped. ~~New text defaults to `"start"`.~~ **Corrected 2026-08-13
  during S0b: new text keeps `"center"`.** Today's default is centre, so defaulting to `"start"`
  would have silently left-aligned every new text layer — an unrelated product regression smuggled
  in by a bidi stage. The logical-alignment argument is about `left`/`right`, never about centre.
- Defaults: absent `direction` renders exactly as today (`ltr`, physical alignment), permanently, no
  migration script — the D1a shape, mirroring `LEGACY_PROJECT_COLOR_SETTINGS`. New text is authored
  `"auto"`, alignment unchanged at `"center"` (see the correction above). **Two constants, not one
  default behind a flag**, so *absent* keeps meaning "authored before this existed."
- Inspector: a direction control on the text layer, defaulting to Auto.
- Consumes S0's detector for the authoring-time default. Does not re-detect at paint time (T-13).

**Not in scope:** vertical writing modes (CJK `writing-mode: vertical-rl`) — a real feature, a
different axis, and no one has asked. Warp's own physical anchor logic
(`font-outlines.ts:278-286`), which maps `left`/`right` to physical CSS positioning: warp is
disabled for RTL scripts by S0 until S7's rework, so this is inert. **Note it in S7's scope** — when
warp comes back for shaping-dependent scripts, that anchor must resolve logical alignment against
`direction`, or warp returns correct glyphs pinned to the wrong edge.

**Verification**
- A pixel fixture: Arabic text ending in `?`, plus an embedded Latin word, at `direction: "auto"`,
  both renderers, 0.000%. The two renderers agreeing is the cheap half.
- **The half that actually matters is not a pixel gate.** Both renderers are Chromium and will agree
  on a wrong answer as readily as a right one — this is the DEBT-017 class, and the gate's universe
  is its fixture list. Assert the *emitted CSS* directly: `"auto"` over Arabic content emits
  `unicode-bidi: plaintext`; an absent `direction` emits neither property, unchanged from today.
- `render:baseline` at zero tolerance across the commit. The legacy-absent path must be byte-
  identical — this is the whole claim D6a makes about existing projects, and it is checkable.
- **The falsifier (T-15), non-optional:** render the fixture at `"rtl"`, then at `"ltr"`, and assert
  the two renders DIFFER. S1 proved a parity gate cannot see a field that never reached the manifest
  — both renderers read the same bag and agree at 0.000% on an answer neither was given.
- **Fold in the structural fix while adding `direction`.** `buildRenderManifest`'s text bag is a
  hand-written field list in two places (`render-templates/src/index.ts:404-433`, :509). S5 adds ~6
  more properties; every one is an omission away from S1's near-miss, twice. Derive the copy from a
  declared key set with a compile-time exhaustiveness constraint — `TEXT_STYLE_FIELD_KEYS`
  (`text-styles.ts:10-29`) is the pattern — so a missing field is a typecheck failure, not a
  silent divergence found by luck. This is the last cheap moment to do it.

**Risk:** low-moderate. The manifest addition is small and the CSS is engine-native. The real risk
is the alignment change leaking into existing projects, which `render:baseline` is the instrument
for. If baseline moves by a single byte on a legacy fixture, the legacy split is wrong — stop.

---

## S0c — The raster tells the truth about direction

**Win:** Arabic works *by default*, and mixed Arabic-and-Latin comes out in reading order. S0b
shipped the manifest field and the CSS, and measured two gaps that leave its own headline claim
half-delivered. Neither is S0b's mistake — one is a correction to T-13, which was mine.

**Scope**
- **Resolve `"auto"` once, in shared, at style-resolution time** (T-13 as corrected). Canvas 2D has
  no `unicode-bidi: plaintext`, and both renderers take pixels from the raster, so `"auto"` currently
  draws `ltr` everywhere — its baseline hash is byte-identical to `"ltr"`. One shared resolver, both
  paths consume the concrete answer, no renderer decides for itself, nothing resolves in a paint
  loop. One direction per layer, not per line: the AE/Premiere model.
- **Draw single-style lines with one `fillText`** (T-13a). The word loop at
  `text-shape.ts:567-569` places each word at a computed logical x, so bidi reordering cannot happen
  regardless of `ctx.direction`. Single-run lines are the common case for captions and titles, and
  one call is also fewer measure passes than the loop it replaces.
- **Multi-run lines: degrade visibly, do not silently emit logical order.** Canvas 2D exposes no
  per-character visual positions, so a line carrying two colours cannot be drawn in one call. Apply
  T-12's discipline with S0's existing detector and marker vocabulary — the machinery is built.
- Per-run highlight boxes (`text-shape.ts:571`) and `textRevealProgress` both depend on word
  positions. Check them against the single-call path before assuming it is a drop-in; if reveal
  needs word extents, clip rather than reposition.

**Verification**
- The falsifier S0b built, extended: `"auto"` over Arabic must now differ from `"ltr"`. That exact
  assertion fails today and is the stage's definition of done.
- Mixed `"مرحبا Brand بالعالم"` at `"rtl"`: assert the render differs from the word-by-word draw.
  S0b measured that these currently match, which is the defect.
- The Latin control on every arm — a subject-only difference proves nothing about bidi.
- `render:baseline` full and unbatched. This changes the draw path for **all** text, not just RTL:
  every existing fixture is the claim. Expect single-run lines to shift by antialiasing if the old
  loop's accumulated word advances differed from one shaped call — **if that happens, stop and
  report the delta rather than re-baselining.** A changed Latin render means the layout changed.

**Risk:** moderate, and higher than S0b. The draw path is shared by every text layer in the product.

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

## S7 — The text matte, matte edge operations, and the warp rework

**Win:** video inside text — a generator, a procedural texture, a video source, or an **entire
Flarex comp** inside the glyphs. Roughened/torn edges, choke/spread and edge blur, which land on the
matte and so immediately work on every existing mask, key and tracked shape too. **And** warp gets
real shaping for free — Arabic, Devanagari and other complex scripts warp correctly for the first
time, closing the gap S0 only masked.

This stage has two halves with **different gates**, and they should be tracked as such rather than
as one undifferentiated blob of work.

**Half A — the Flarex text matte. GATE: the OQ1 spike runs first**, as a separate, reportable piece
of work. It must (i) enumerate every `matteInput` consumer in `compile-flarex.ts` and classify each
vector-only / raster-capable / needs-work, and (ii) measure raster feather+choke against the
existing vector rasterizer at 1080p. **If the spike shows that a raster value forces early
rasterization of chains that could stay vector, T-7 is violated and this half needs a different
design** — do not proceed on the assumption that it will be fine.

**Half A scope, assuming the spike clears**
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

**Half B — the warp rework. NOT gated by OQ1** — it doesn't touch `FlarexMatteValue`; warp lives
outside the Flarex compiler entirely (`text-warp.ts`, `text-warp-mesh.ts`, `font-outlines.ts`). Can
ship independently of, and in either order relative to, half A.

**Half B scope (D9a)**
- Rasterize the text layer with full browser shaping (reuse `drawTextLayer`'s canvas `fillText`
  path, as `scene-text-raster.ts` already does), then run the existing envelope-mesh deformation math
  over the raster instead of over `opentype.js` path commands.
- Delete `opentype.js`'s `getPath()` call from the warp path. `opentype.js` itself stays — it is
  still used for D2's name-table ingest parse — only the glyph-outline use inside warp goes.
- Supersample the raster at a scale derived from the deformation field's **maximum local
  magnification**, not a fixed multiplier. Extend the existing `rasterScale`-from-bucket mechanism
  (`scene-text-raster.ts:47-48,280`, today keyed to display scale) to also account for warp stretch,
  capped by the same `MAX_RASTER_DIM` bound.
- Delete S0's script-detection gate once this ships (T-12) — there is no shaping gap left to guard.
- `harfbuzzjs` is explicitly **not** part of this half's scope (see ADR §6/§8) — no vector warped
  output is being built here, only raster warped output with correct shaping.

**Explicitly not in this stage:** any edge treatment on the text node's params (T-6, half A). Vector
warped output / SVG export of warped text (half B — deferred, `harfbuzzjs` is the named path if it's
ever scoped).

**Verification (half B):** the same Arabic fixture from S0 — before this half, unwarped-with-marker;
after, warped correctly. Plus the existing warp pixel fixtures re-run to confirm the rasterize-then-
deform swap doesn't regress simple-script warp, and a heavy-warp fixture checking supersampling holds
detail at high local magnification.

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
