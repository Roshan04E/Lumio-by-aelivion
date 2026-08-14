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
S2  font reference + mirror + install     manifest change (FontRef)              the big one
S2.5 catalogue + font picker UI          the ceiling a user can SEE going       split from S2
S2.6 the catalogue goes VAST             virtualized list + mirror-on-pick      the original ask
S2.7 Bold picks the bold FILE            weight resolves to a face, not CSS    S2.6 made it reachable
S3  user font upload                      storage + asset doctrine
S4  TextStyle as a PropertySchema         SHIPPED 2026-08-14; no migration; unblocks S6
S4b `reference` renderable in PropertyFieldList  SHIPPED 2026-08-14; both pickers moved
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
- **Carries S0c's open T-16 debt.** S0c's multi-run marker was argued structurally sound (same class
  and sibling placement as S0's pixel-proven marker) but never photographed, and named as such rather
  than passed off as done. D3's substitution surface built here is a third marker with the identical
  failure mode, so this stage photographs **both** with one harness. That is the efficient moment,
  not a deferral of convenience: authoring the two-colour Arabic layer costs the same whether one
  marker or two is being proven.
- `getCompositionFontsUsed` (composition-style.ts:907) becomes a `FontRef` collector rather than a
  family-string collector.
- ~~Font picker UI over the catalogue, with real previews.~~ **Moved to S2.5 (2026-08-13, founder
  call at the commit-3 boundary.)** Scoping error in the original S2: the picker and the browsable
  catalogue are the only pieces here with no ADR obligation behind them, and they were sitting in
  the same commit as T-2's named abort, the `export-core.ts:332` deletion and the T-16 harness — the
  load-bearing half. See S2.5.
- **Migration for existing projects is decided (D1a): none, ever, automatically.** An existing
  `fontFamily` stack normalizes to `{ source: "system" }` and keeps rendering exactly as today,
  permanently — the `LEGACY_PROJECT_COLOR_SETTINGS` shape applied to fonts. This stage needs a
  user-triggered, visible "pin this font" action per project, not a migration script.

**Also fold in — moved to S2.5 with the catalogue it depends on:** `registerWarpFonts` /
`configureFontResolver` (`font-outlines.ts:64,86`) become consumers of the same catalogue rather
than a parallel hand-maintained table. The hardcoded `warpFontCatalog` at :52-60 is exactly the
"future large font library" seam its own comment describes.

**Verification**
- Pixel fixture using a catalogue font that is **not** installed on the host — proves the install
  path is what put it there and not the machine.
- A negative test: a manifest with a bogus `fileHash` must **fail** the render, loudly. (The
  succeed-then-fail discipline applies: a permanently-broken font proves the setup fails, not that
  a *missing* font fails at the right point.)
- Determinism check: same manifest, two renders, byte-identical text region.

**Risk:** the largest surface-area stage. Manifest change + worker change + storage + UI.

---

## S2.5 — The catalogue and the picker: the ceiling actually goes

**Win:** the user picks a font from the Google catalogue and sees it, with a real preview, in a
list that is not five items long. This is the half of S2 a user can point at. S2 makes fonts
*travel correctly*; S2.5 makes them *choosable*.

**Split out of S2 on 2026-08-13**, at the commit-3 boundary, on the implementor's flag. S2's commit
4 carries T-2's named abort, the `export-core.ts:332` deletion, the substitute surface and the T-16
two-marker harness — every obligation in the stage. The picker carries none. Putting UI iteration
in the same commit as the render-boundary contract meant the two competed, and the piece with no
ADR behind it was the one that would have been compressed.

**Scope**
- The browsable catalogue over the mirrored store — families, weights, styles, with real previews
  rendered in the actual face rather than a name in a system font.
- The picker UI, replacing `renderSafeFonts` (`composition-style.ts:121-127`) as the editor's font
  surface. Legacy stacks keep rendering; D1a is not touched.
- `warpFontCatalog` (`font-outlines.ts:51-61`) and `registerWarpFonts` / `configureFontResolver`
  (:64, :86) become consumers of this catalogue rather than a parallel hand-maintained table. That
  table's own comment calls itself the seam for a future font library, and it has been wrong twice:
  it shipped EMPTY once, so every warped family silently rendered as the Roboto fallback.
- Pinning a font is a **user-triggered, visible, per-project action** (D1a). Still no migration
  script, still never automatic.

**Verification**
- Previews render in the face they name — the empty-catalogue incident is the precedent: a font
  surface that silently shows the fallback looks exactly like one that works.
- Picking a catalogue font writes a `catalogue` `FontRef` with a `fileHash`, not a family string.
- The warp path resolves through the catalogue and its fallback still works when a family is absent.

**Risk:** low-moderate. UI over a contract S2 already proved. The one real hazard is the preview
lying, which is why it has its own check.

---

## S2.6 — The catalogue is actually vast, and the list still doesn't stutter

**Win:** the founder's original ask, delivered. The picker lists the Google catalogue — ~1500
families, filterable, with a real preview per row — and stays smooth. S2.5 shipped the picker and
the write path correctly and was honest that what it lists is the **already-mirrored set: five
families, eight faces.** The *kind* of ceiling changed (system stacks the export box was assumed to
have → pinned faces that render identically everywhere), which is the load-bearing change. The
*size* did not. A user opening the picker today still sees five families, and "vast library" was the
brief.

**Why this is a stage and not a data-entry task.** Mirror-on-first-use (D4) already means a family
costs nothing until someone picks it. What is missing is the **index** — the picker can only list
what has been mirrored, so nothing is ever picked, so nothing is ever mirrored. Breaking that
circle needs catalogue metadata (family, weights, styles, category, **subsets**) independent of the
bytes, and a list that can render a thousand rows without fetching a thousand fonts.

**Scope**
- Ingest the Google Fonts metadata index — names, weights, styles, category, subsets. Metadata
  only; bytes still arrive on first use, unchanged.
- **Virtualized picker with lazy per-row face loading.** Only rows near the viewport load a face;
  the rest render in a neutral face until they are close. This is the whole "not laggy" half of the
  brief and it is the only real engineering here. Canva and Figma both do exactly this.
- Mirror-on-pick: selecting an unmirrored family triggers S2.3's mirror-with-license write, then
  writes the `FontRef`. The user sees a brief resolving state, not a failure.
- **Filter by subset/script**, which is where this stage meets S0b/S0c: a user writing Arabic needs
  to find Noto Naskh Arabic, Cairo or Amiri, and a Latin-only list makes the RTL work unreachable
  in practice. Script filtering is not a nicety here; it is what connects two stages.

**Verification**
- T-17 still governs: previews prove they render in the face they name. At this scale, prove it on
  a sample plus the invariant that no two loaded faces render identically — one font standing in
  for all of them is the empty-catalogue failure at scale.
- A scroll of the full list holds frame — measure it, do not eyeball it. Startup cost of the picker
  is a separate number from steady-state scroll; report both.
- Picking an unmirrored family end-to-end: metadata row → mirror write with license → `FontRef`
  with `fileHash` → renders in the export. The full S2 contract, exercised from the UI.

**Risk:** moderate, and concentrated in the list. The contract underneath is proven; what is
unproven is a thousand-row surface that loads fonts as it moves.

**Known, not a bug (from S2.5, worth stating before someone files it):** in a dev environment with
no seeded mirror and no API, a picked catalogue font previews correctly in the list while the layer
reports "Missing font — showing a substitute". Previews load a bundled copy under a distinct
`"<family> Preview"` CSS family so they can never be picked up by a layer's CSS by accident; the
layer's own font resolves through the store, which is empty. That is D3 behaving exactly as
designed, and it will look like a defect to anyone who has not seeded the mirror.

---

## S2.7 — Bold picks the bold FILE

**Win:** turning on Bold over a pinned font makes it bold. Today it does nothing, and S2.6 made
that failure far more reachable: a pinned ref's weight comes from the ref because the ref describes
a *file* (`fontRefCss`), which is correct and was settled in S2 — but the layer's Bold toggle still
writes a CSS weight nothing reads. With 7,804 faces now pickable, someone hits this immediately.
S2.6 wired the picker to the layer's current weight, so picking *while* Bold is on pins the bold
cut; toggling *after* pinning is the hole.

**The industry answer, and it is not synthetic weight.** Figma, InDesign and Canva all resolve a
weight/style request to a real face of the family and only synthesise when no such cut exists.
Faux-bold over a family that ships a bold file is the amateur outcome — smeared, and different in
the export.

**Scope**
- A resolver: `(family, weight, italic) → FontRef`, over the face index S2.6 already ingested.
  Bold/Italic toggles **rewrite the ref** to the family's matching cut rather than emitting CSS.
- **No cut, no lie.** A single-style family — Anton is the standing example, and
  `warpFontCatalog`'s bold-less entry was the precedent — must not silently faux-bold. Either the
  control disables with a reason, or synthesis is explicit and visible. Choose one and say which.
- Legacy `{ source: "system" }` refs keep CSS synthetic weight, exactly as today. D1a: untouched,
  permanently.
- The variable-axis case is **out of scope** — that is S9's `font-variation-settings`. A variable
  family exposing `wght` is one file, and this stage is about picking between files. Note where the
  two will meet; do not build it.

**Verification**
- Bold on a pinned family writes a *different* `fileHash`, and the render differs. T-17's sharpened
  form applies: the two renders must differ from each other, not merely from a fallback.
- A single-style family takes the declared no-cut path, asserted — not "looks fine."
- A legacy stack still bolds via CSS, byte-identical to today. `render:baseline` covers it.

**Risk:** low. Contained to resolution; no new storage, no new manifest field.

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

- **Family grouping is the seam S2.7 left you** (581cbd1). A `source: "user"` font has no known
  siblings, so today both weight controls correctly report "we don't know what other cuts this has"
  and refuse to turn bold **on** while still allowing it **off**. Giving uploaded fonts a family
  group is what closes that — and T-18 governs it: the grouping resolver must refuse across styles
  rather than return a nearest match, or an uploaded roman silently answers a bold request.

**Blocked on:** nothing from OQ4 — closed (D4a), and moot here anyway since user fonts are not
redistributed. OQ7 (a collaborator who cannot relink) **does** need an answer before sharing a
project with user fonts is a supported flow.

**Verification:** upload a font, render in the worker, confirm the bytes came from the per-user
path. Plus a test that a second account **cannot** resolve the first account's font by hash.

**OPEN TAIL (S3, 2026-08-14 — the only thing not done).** The authenticated `POST /api/fonts/user`
round trip and the `.woff2` upload path both need `requireAuth`, which loads a user row, and the box
S3 was built on has no database (Docker not running). The storage isolation guard is DB-free by
design and is fully exercised against the real app on a real port; the upload route's ingest logic
is the same shared code `font:ingest-test` covers. **What is unverified is the HTTP round trip
itself.** Run it once against a live DB before S3 is called done in an environment that has one.
This is a gap in evidence, not a known defect — do not let it be quietly reclassified as either.

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
- ~~The migration from loose fields. Sequence with S2's manifest migration.~~ **There is no migration
  — see the cross-cutting note.** A pre-S4 saved style is already the v1 value shape, so it is
  *adopted* into the envelope without a value being read, written or defaulted.
- Clipboard and (future) presets share the `{schemaId, version, values}` envelope (T-10).

**Verification:** pixel-identical output for every existing fixture after the migration — this stage
must change **no pixels**. That is the acceptance bar: a schema refactor that shifts a fixture has a
bug in the migration.

**SHIPPED 2026-08-14.**

- `packages/shared/src/property-schema.ts` — ADR-004's first implementation, the minimal cut its own
  self-critique recommends. Inert metadata; the frozen ADR-003 taxonomy stated as a union.
- `packages/shared/src/text-style-schema.ts` — the `text-style` schema, v1, 21 described fields in 4
  groups. **No kind was added**, and none was needed: fonts are `reference`/`font` per ADR-003, and
  the five widgets the renderer's subset has no branch for arrive through ADR-002's escape hatch.
- `getCompositionTextStyle` is now `resolveTextStyle` → CSS emission. The precedence chain and the
  keyframe reads live in the first step; the second emits declarations and nothing else.
- **The preset key list is derived from the schema, with two compile-time constraints** (every
  `TextStyleFields` key is described; the presetable set is *exactly* `TextStyleFields`). This closed a
  live T-15 defect: the hand-written list had fallen two fields behind the layer, so **Save Style
  silently dropped `fontRef` and `direction`** — a saved look applied in a different typeface than the
  one it was captured from, and no parity gate could see it.
- Copy Look / Paste Look in the Text tab, over the envelope. Refuses a foreign schema or a
  newer-version payload with a reason rather than pasting half a look.

**Evidence:** `render:baseline` 78/78 unchanged at zero tolerance (the acceptance bar), plus a new
`textstyle:golden` gate — 54 emitted-style cases across the branch matrix, byte-identical including
key order and `undefined`-vs-absent — and `textstyle:schema`, which sweeps all 20 presetable fields
through capture → envelope → apply and asserts each one *changes the emitted style* (T-15). Both new
gates were falsified before being trusted.

---

## S4b — `reference` becomes a kind the renderer can build

**Win:** one picker, shared. The font picker and Flarex's asset picker stop being two bespoke
widgets behind the escape hatch and become one resolver-backed field with shared validation and
shared behaviour — which also means the next picker is free rather than a third copy.

**This is ADR-002/003 work, not ADR-023 work**, and it is scheduled here only because this
programme is what surfaced it. ADR-003's renderer-subset clause fired on 2026-08-14: `reference` is
already in the frozen fifteen with `font` and `asset` both named as refTypes, and both systems
already *declare* it correctly. The renderer simply cannot build what they declare. **No new kind.
No taxonomy change. Do not reopen the four-part test — it does not govern this.**

**Before S6, and that is the whole reason for the position.** S6's preset library adds a third
reference-shaped picker. Two bespoke copies is a finding; three is a pattern that gets defended.
This is the same argument that put S0's detector ahead of S0b — claim the shared thing before the
next consumer builds its own.

**Scope**
- `reference` in `PropertyFieldList`, resolver-backed, dispatching on `refType`.
- Move both existing pickers onto it: text's font picker (S4, `5cb1d4e`) and Flarex's asset picker.
- Keyframe and validation semantics declared on the kind, not per field (ADR-003's consequence:
  "interpolability is a declared property of the kind").

**Verification**
- Both pickers behave as they do today — this is a refactor with no intended user-visible change,
  so `render:baseline` at zero tolerance is the claim, and the S4 golden-style gate still passes.
- The font picker still writes a `FontRef` with a `fileHash` (S2.5's assertion, unchanged) — a
  shared picker that writes the wrong shape is the whole risk of consolidating.
- `font:picker-perf` unchanged: 1,949 rows must still virtualize. A generic renderer that mounts
  every row would be a real regression hidden inside a "no user-visible change" stage.

**Risk:** moderate. Two live surfaces move onto shared code at once, and one of them is the
virtualized 1,942-family list.

**SHIPPED 2026-08-14.**

- `apps/web/src/editor/inspector/controls/ReferenceControl.tsx` — the resolver contract
  (`ResolvedReference` / `ReferenceResolver` / `resolveReference`) plus the canonical `refType:
  "asset"` editor, which is `flarex/FlarexSourcePicker` moved: the widget was never Flarex-specific,
  only Flarex-located, and a shared renderer may not import a domain folder. Its DOM and
  `flarex-source-*` class names are carried over unchanged.
- `PropertyFieldList` gains one `reference` branch that resolves the id ONCE and then dispatches on
  `refType`. **The field type carries no `keyframe` member**, so ADR-003's "interpolability is a
  property of the kind" is enforced by the type rather than by everyone remembering it; the
  positive declaration lives in `propertyKindInterpolable` (shared), where a non-inspector consumer
  can read it.
- Both pickers moved. The font row stopped being a slot — the schema always called it
  `reference`/font, and what crosses the adapter boundary now is the value and the writes, not a
  widget. Flarex's `sourceAssetId` became a `reference` field whose resolver reads the media pool.
- What is deliberately NOT shared is the browsing experience: a searchable 1,900-family list and a
  "click a tile in the pool" mode are different editors over identical semantics, which is the axis
  `refType` exists to dispatch on. **The two wanted different resolvers, not different semantics** —
  the question this stage was told to stop and report on if it went the other way.

**Evidence:** `render:baseline` 78/78 unchanged at zero tolerance versus `a1af4ef` (the claim, not a
regression check — this commit does not batch), `textstyle:golden` 54/54 byte-identical including key
order and `undefined`-vs-absent, and `font:picker-perf` at 1,949 rows / **16 mounted** / 50 ms to
open / 13.4 ms median frame, with the `fileHash` assertion passing *through the shared path* — the
fixture was moved onto `PropertyFieldList` for exactly that reason, since a gate pointed at the
widget directly would keep passing after the shared renderer started mounting all 1,949 rows.
`textstyle:schema` gains one assertion (no schema field may declare `animatableAs` on a
non-interpolable kind), falsified by giving `fontFamily` a track and watching it fail.

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

**The variable-axis half needs a different file than S2.7 pins** (581cbd1). Cairo is a variable
family, but Google's index enumerates *instances* and its CDN serves a static instance per weight —
which is why S2.7 sees nine weights and correctly picks between files. Animating weight that way is
a different `fileHash` per frame, and T-8 makes each one a different raster. S9 needs the one
variable file plus `font-variation-settings`. **An assertion in the face tests fails loudly if
someone "fixes" the enumeration** to collapse those instances; that assertion is protecting this
stage, not the last one.

**Blocked on OQ6, which is a correctness question, not a polish one:** an animated "character" must
be a **grapheme cluster**, never a code unit, or combining marks, emoji ZWJ sequences and Devanagari
conjuncts break. And per-cluster transforms break the shaping run — each animated cluster becomes
its own shaping context, changing kerning. Decide the model before writing the animation.

---

## Cross-cutting obligations

**Both renderers, every stage.** `apps/web/src/components/VideoPreview.tsx` **and**
`apps/worker/src/remotion/Root.tsx`, in the same change, with a `render:compare:pixels` fixture
(T-9). Text parity is free for *layout* and for nothing else.

**~~Two migrations, one design.~~ DELETED 2026-08-14 (S4) — the obligation was moot as written.**
This said S2's manifest migration and S4's schema migration touch the same saved data and had to be
written together. **Neither migration exists.** D1a decided S2 has no migration, ever, by design (S2's
own scope says so: an existing `fontFamily` stack normalizes to `{ source: "system" }` and keeps
rendering exactly as today, permanently), and S4 inherited that shape rather than inventing a second
one — a pre-S4 saved style is already exactly the v1 value shape, so adopting it into the envelope
reads and writes nothing. The instruction is deleted rather than marked done, because leaving it
would have had the next stage sequencing against two migrations that were never going to be written.

What survives is the *reason* the note existed: **absent stays absent, in every store.** Project data,
saved styles, presets and the clipboard all decline to fill in a field nobody authored. That is the
D1a rule, and it is what makes migrations unnecessary here rather than merely deferred.

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
