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
S0  interim: disable warp on shaping-dependent scripts   RETIRED 2026-08-15 by S7 half B
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
S5  tier-1 texture + CSS depth            SHIPPED 2026-08-15; variable axes deferred (not OQ2)
S5b `fillTexture` presetable + an editor   SHIPPED 2026-08-15; decomposed, no new kind
S6  caption + text preset library         SHIPPED 2026-08-15; OQ8 closed; 18 first-party looks
S7  the text matte (tier 2) + matte ops + warp rework   half B (warp) SHIPPED 2026-08-15;
                                                          half A gated on the OQ1 spike
S8  SVG: multi-stroke + path text          SHIPPED 2026-08-16; D8 amended — multi-stroke needed no SVG
S9a STATIC variable axis                  SHIPPED 2026-08-16; OQ2's deferral REVERSED
S9b ANIMATING the axis                    not started; the trap is per-frame registration COST
S9  per-character animation                not started; OQ6 ANSWERED, precedence gate written + red
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

> **RETIRED 2026-08-15 by S7 half B (D9a/T-12), exactly as this stage's own scope said it would be.**
> The gate is DELETED, not disabled: `isTextWarpSuppressed` is gone, the preview badge is gone, and
> `warp:shaping-gate` is replaced by `warp:deform-gate`, which asserts the opposite property. What
> SURVIVES is the detector — `detectTextScript` in `text-script.ts` — because the amendment below was
> right about the second consumer and there is now a third: S9 cannot animate per grapheme cluster on
> a script whose shaping it would break (T-14). Warp was the consumer that went away, not the
> question. The stage below is kept as written, for history.

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

**SHIPPED 2026-08-15 — three of the four items. The variable-axis half is DEFERRED, and not on OQ2.**

Five schema fields, all in frozen ADR-003 kinds, no kind added and no `control`/`custom` reached for:
`fillGradientFrom`/`fillGradientTo` (`color`), `fillGradientAngle` (`number`), `backgroundPerLine`
(`boolean`), `shadowLayers` (`number`). Each is `absenceIsMeaningful` — absent is the pre-S5 look,
permanently, with no migration (D1a).

- **Gradient fill** — two stops and an angle. A richer stop list is the `gradient` kind, which is
  frozen into the taxonomy and not yet buildable by `PropertyFieldList`; ADR-003's
  promotion-out-of-the-remainder clause wants genuine two-system demand and S5 is one system, so the
  two-stop form ships in kinds that already render and collapses into the kind through an ordinary
  migration when a second system asks for it. **Both stops or nothing**: a half-authored gradient
  renders as the solid fill. In the DOM it rides the run spans, because `background-clip: text` clips
  the background *colour* as well and on the layer box it would silently eat the background pill.
- **Per-line pills** — `box-decoration-break: clone` on ONE inline wrapper around all the runs (not
  one per run, which would pad every run boundary), and one rounded rect per line in the raster, sized
  from the line's ink box so the two constructions agree. The block keeps its padding and gives up its
  background, so the element box does not move.
- **Stacked shadows** — `text-shadow` was always a list and we emitted one entry; `shadowLayers`
  stacks N copies at 1×…N× the offset, nearest first because CSS paints entry 0 on top. Independent
  per-copy colours are a list of shadows and want the `list` kind; they are **not** approximated.

**`font-variation-settings` is deferred, and the reason is prior to OQ2.** OQ2 asks whether the two
Chromiums instance an axis identically. **Measured 2026-08-15 (`apps/worker/tmp/oq2-probe.mjs`): the
canvas 2D context exposes no `fontVariationSettings` at all, and its `font` shorthand rejects an
inline `font-variation-settings` declaration** — and since T-13's correction, the canvas raster is
where BOTH renderers get their text pixels. So a variable axis would move the DOM overlay and nothing
that ships. The probe was falsified before it was believed (the same context DOES respond to a weight
change in `measureText`, so the negative is the API's, not the probe's) — and its first draft was
itself wrong in the instructive way: it tested `"fontVariationSettings" in ctx` *after* assigning to
it, and read back its own expando. OQ2 stays open and moves to S9, which is where a variable axis has
to solve the raster problem anyway.

**Evidence:** `render:baseline` **78/78 unchanged at zero tolerance** versus `a1af4ef` — the D1a claim
for all five fields. `textstyle:golden` 77/77 (54 pre-existing + 23 new), and the 54 pre-existing cases
differ from their S4 goldens by **exactly** the two appended `<undefined>` keys and nothing else, checked
mechanically rather than by reading the diff. `textstyle:schema` sweeps 25 presetable fields. Three new
pixel fixtures (`gradient-fill`, `per-line-pill`, `shadow-stack`) at 0.000%. And `text:s5-falsifier`,
because 0.000% is also what a completely inert feature reports: each field flipped against its LEGACY
shape (key deleted, not set falsy) must change the render, and each no-op arm — a one-stop gradient, a
pill over a transparent background, `shadowLayers: 1` — must be byte-identical. All six assertions hold.

**A defect the falsifier's stills caught that no hash could have.** The first per-line implementation
drew each pill inside the line loop, so line two's pill painted over line one's descenders and ate
them. Every gate was green: parity 0.000%, the flip changed the render, the emitted style was right.
CSS puts every inline box's background in the background layer beneath *all* of the element's text,
and the raster has to do the same — the pills are now one pass before any glyph. **A "does it differ"
falsifier proves the field is wired, never that the picture is correct; the stills have to be looked
at.**

**Not done, deliberately, and each is a finding rather than a leftover:**

- `fillTexture` (image fill, shipped 2026-07-17) is a look field that is **not** in `TextStyleFields`,
  so Save Style and the clipboard silently drop it — the T-15 shape, in the preset path, in a field S4's
  exhaustiveness constraint cannot see because the constraint is over `TextStyleFields` and this is not
  in it. It has no editor UI today, so no user can reach it; **S6 must not ship presets without closing
  this**, and the fix is to describe it in the schema, which needs a kind decision for a composite value.
- The DOM overlay path is covered at the emitted-CSS level (`textstyle:schema` asserts the clip, the
  fill-colour give-up, `box-decoration-break` and the run's paint order), **not** by the pixel gate:
  that harness compares the two raster consumers, which is where the shipped picture comes from.
  `apps/worker/tmp/s5-dom-probe.mjs` paints the real emitted objects in Chrome instead, and it earned
  its keep immediately — see below.

**The same defect, twice, in two renderers, for one reason — and the second instance was only visible
because the DOM was actually painted.** CSS paints **line boxes in order** (CSS 2.1 Appendix E), each
one's inline backgrounds then its text. With the tight line-heights captions use (the default here is
0.95, under 1) that means line two's pill paints over line one's descenders — which is precisely what
the raster's first draft did, and what Chrome does natively. Fixing only the raster would have shipped
the two renderers *disagreeing*, with every gate green, because no gate compares the DOM overlay to
anything. The DOM half is `position: relative` on the run span when a pill is present: no offset, it
just moves the glyphs into the positioned-descendant layer, above all in-flow inline backgrounds. Both
paths now say "every pill, then all the text."

---

## S5b — `fillTexture` joins the presetable set, and gets an editor on the way

**Win:** image fill on text becomes usable and survives a saved style. Today `fillTexture` (shipped
2026-07-17) renders correctly and **no editor writes it** — there is no picker — and it is absent
from `TextStyleFields`, so Save Style and the clipboard silently drop it. A look you cannot author
and cannot save.

**Why it is a stage and why it is here.** S5 found it (T-15 addendum 2) and correctly left it rather
than widen scope. **S6 may not ship presets over it**: a preset library that silently discards one
look field is the same class of defect as a saved style that drops a pinned font, and S6 is where
that becomes user-visible at scale.

**The kind decision, which is the reason this needed the auditor rather than the stage.** `fillTexture`
is a composite value — `{ assetId?, url, fit: cover|tile, scale }`. **Decompose it into existing
kinds. Do not add a composite kind, and do not reach for `custom`.**

- the image → `reference`, `refType: "asset"`
- `fit` → `enum`
- `scale` → `number`

This is ADR-003's own precedent applied unchanged: `lut` is deliberately *not* a kind, it is
`reference` + `number` (ADR-003 line 38). Metadata evolves before taxonomy. **The editor comes free**
— S4b (`279a616`) made `reference` a kind the renderer builds, which is exactly why this is cheap
now and would have meant a bespoke picker three stages ago.

**Scope**
- The three fields into the text schema, in the frozen kinds above.
- `fillTexture` joins `TextStyleFields`, so S4's two-way constraint starts covering it — the
  constraint was never wrong, it simply proved a set this field had never joined.
- Absent stays absent, permanently. Same discipline as every stage since S1.

**Verification**
- The T-15 falsifier per field, **and** a look at the rendered picture. S5's pill-over-descenders
  defect is the precedent: every gate was green while the render was wrong. A falsifier proves the
  field is wired; nothing in this repo's vocabulary proves the picture is right except looking.
- Save Style → apply on a fresh layer round-trips the fill. That assertion is the whole stage.
- `render:baseline` at zero tolerance: no existing project has a `fillTexture`, so nothing may move.

**Risk:** low. The renderer already paints it; this is authoring plus schema membership.

**SHIPPED 2026-08-15.**

Three fields, three existing kinds, no composite kind and no escape hatch: `fillTextureAssetId`
(`reference`/asset), `fillTextureFit` (`enum`), `fillTextureScale` (`number`). All three
`absenceIsMeaningful`, all three presetable, and the picker is the shared `reference` editor S4b built
— **this stage adds no widget**, which is the whole reason it was cheap now and would not have been in
July.

**The `url` did not survive the decomposition, and that is the decomposition working.** A reference
serializes as an id (ADR-003); a URL is a machine- and account-specific *resolution* of that id, and
baking one into project data is precisely what would break the preset this stage exists to enable.
Resolution moved to `CompositionStyleOptions.resolveAssetUrl`, resolved once in shared and emitted into
the style object — the "resolve once, hand both paths the same concrete answer" shape T-13 was
corrected into. The app supplies it (editor from the media pool, Remotion from `manifest.assets`, local
export from the source-URL map) rather than a module-level registry, because the registry shape is the
one ADR-023 §1 records as having shipped EMPTY and silently rendered every warped layer in Roboto.

**What is genuinely narrowed:** a fill must now be a project asset rather than an arbitrary URL.
Nothing could author an arbitrary URL — there was no editor — so no capability a user had is gone, and
fills now inherit the local-first asset doctrine. **This was checked before proceeding, because it is
the one finding that would have reopened the kind decision.** It did not.

Two copy lists died on the way. The manifest's hand-written top-level `fillTexture` (two sites) became
three entries in the derived style bag, so the exhaustiveness constraint owns them; and
`scene-text-raster`'s `layer.fillTexture ?? null` cache-key special case is gone, because a fill is
keyed now for the same reason everything else is — it is emitted. `textWarp` is the last such
special case left.

**Evidence:** `render:baseline` **81/81 unchanged at zero tolerance** versus `71457b8`, including
`texture-fill` — whose fill is now addressed completely differently and paints exactly the same pixels.
`textstyle:schema` sweeps 28 presetable fields and carries the assertion this stage is for: **Save
Style → apply to a fresh layer → the fill round-trips**, through the envelope and through JSON, ending
in the same emitted style. `textstyle:golden` 85/85, with the 77 pre-existing cases differing by exactly
one appended `fillTexture:<undefined>` key and nothing else. `text:s5-falsifier` gains four arms,
including the one that matters here: an **unresolvable id must render byte-identically to no fill** —
the intended degradation, and otherwise indistinguishable from the feature being dead.

**The gate that had to exist, and the one the other gates cannot be:** every instrument above answers
"does the fill reach the renderer", and the defect was "you cannot author it". So
`apps/worker/tmp/s5b-editor-probe.mjs` drives the real editor and asserts the row is on screen and its
trigger arms the media pool. Its first run reported "no Image fill row" against an inspector it had
never opened — the instrument answering about itself, which is the same shape as S5's OQ2 probe reading
back its own expando. Falsified, then believed.

**Looked at, not just hashed** (S5's lesson): the `texture-fill` still shows the checkerboard genuinely
painting the glyphs, and `cover` vs `tile` vs scale each change it visibly. One incidental finding while
looking — the fixture's comment claims "the squares are huge and unambiguous", and they are not: a 2×2
image scaled 40× through a canvas pattern is bilinearly smoothed into a soft ramp. The fixture still
discriminates (an orange-yellow ramp is nothing like a solid white fill), so this is a wrong comment
rather than a vacuous gate — recorded because the next reader will otherwise trust the comment.

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

### SHIPPED 2026-08-15

**A preset is a named envelope and nothing else.** `{schemaId, version, values}` — byte-identical to
what the clipboard carries and to what a saved project style carries, wrapped with an id, a name and
a category so it can be listed (`style-presets.ts`). T-10 taken literally rather than approximately:
a format that merely *resembled* the clipboard would be two formats with one name, and the second one
would rot exactly the way a copy list rots.

**Shapes got the schema they were owed.** `shape-style` is ADR-004's second adopter — 11 presetable
fields over what `getCompositionShapeStyle` already emits, with the same pair of two-way constraints
`text-style` carries. No renderer change, which is what "a schema and presets, not an engine" means
when it is true rather than asserted. `shapeKind` is described and NOT presetable, for
`textWidthPercent`'s reason one type over: a look that turned your ellipse into a rectangle would also
orphan its `shapePath`.

**D12 held.** Layer 2 is not here. A caption preset applied across the whole caption track is one
call (`applyStylePresetToTrack`), and that call is the entire short-form-captions feature — no
`TemplateDefinition`, no module graph, no credit price.

**OQ8 CLOSED — see the ADR. The short form: it was never only about fonts.** S5b put a second
reference kind in the same envelope three days earlier, and a project asset is account-scoped for the
same reason a licensed font is. One rule covers both: save always, **share hard-fails by name**,
apply is allowed and reports what did not resolve. The render boundary is untouched (T-2 still aborts,
an unresolvable fill still degrades byte-identically).

**Verification, and the part worth reading.** `presets:test` (28 assertions + a per-preset sweep)
checks every hand-written value against the schema field that describes it, sweeps the whole library
for URLs (T-20), and carries the stage's assertion: a look with a pinned catalogue font, a gradient
and an image fill, through JSON, into a fresh project, emits an identical style key for key. It
caught a `borderRadius: 999` on its first run — the CSS pill idiom, outside the schema's own envelope.

**Then the renders were looked at, and that is where the two findings came from** (`preset:sheet`
renders all 18 looks through the real Remotion renderer):

1. **`shadowLayers` could never produce the extrude it documents.** `textShadowCss` returned
   `undefined` at blur 0 — the only blur an extrude is authored at — so the whole stack vanished. The
   emitter's own comment said "the extrude look is authored at blur 0" directly above the line that
   threw it away, and S5's gate asserted the defect as the contract ("zero blur still emits nothing,
   stack or no stack"). Fixed here, because the Extrude preset is built on it: a stack is honoured
   when it displaces (`shadowLayers >= 2` and a non-zero offset); a single copy at blur 0 still emits
   nothing, which is what every legacy layer resolves to. One golden moved, and it is the defect case.
   *This is a correction to shipped S5 code — flagged rather than folded in.*
2. **A pinned font does not reach the glyphs in a composition with no media layer.** Same graph, same
   seeded mirror, same resolved bytes in `inputProps`; drop the image layer and Anton renders as the
   `sans-serif` fallback. That is a silent substitution in an export — the exact failure D3/T-2 exists
   to prevent — and it is invisible to `font:install-gate` because every fixture there carries media.
   **Not fixed here**: it is an S2/D3 render-boundary defect, not S6's, and it is recorded with its
   reproduction (`apps/worker/tmp/s6-bisect.ts`) rather than absorbed. `preset:sheet` puts a ground
   layer behind the cells so the sheet tells the truth about typography, and says why.
   **FIXED 2026-08-15**, before S7 started, as a DEBT-009 instance: the raster's font readiness rested
   on a debounced `document.fonts` listener, so the right face reached the pixels only when something
   else in the frame outlasted the debounce. `ensureOverlayFonts` now awaits the layer's own faces on
   the consumer's path, before the measure. `font:install-gate` gained a no-media arm; see ADR §8 for
   why that arm needed three drafts before it could tell the two answers apart.

The sheet also earned the Extrude preset a `lineHeight` of 1.35 rather than its neighbours' 1.05: a
7×4px stack reaches 28px past the baseline and lands on the next line at tight leading. Nothing but
looking finds that.

**Left standing deliberately: `captionStylePresets` in `captions.ts`.** The AUTO_CAPTIONS tool still
carries its own six-entry look list — a hand-written struct of nine fields, which is a parallel copy
list of the same kind T-15 is about, one layer up from the field list. It can express nine of the
`text-style` schema's 28 presetable fields; no gradient, no per-line pill, no paint order, no
`fontRef`. Folding it into the envelope is a real improvement and a real migration (`CaptionTrackData.
stylePresetId` is persisted project data, and `CaptionSegmentStyleOverride` is a second parallel bag
on top of it), and doing it inside S6 would have meant migrating caption project data in the stage
that was supposed to ship a library. **Not in scope, and now cheap:** the target shape exists, and
`applyStylePresetToTrack` already does the applying.

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

### SHIPPED 2026-08-16, in two commits — and the stage's own premise was RE-TESTED first, and failed

**D8 said SVG was needed for two things. It is needed for one.** The premise probe
(`apps/worker/tmp/s8-premise-probe.mjs`, `543b302`) ran before any S8 code, and concentric
multi-strokes turned out to be native on both surfaces that ship a picture: the canvas raster strokes
widest-first then fills, and the DOM overlay stacks copies of the same browser-shaped text. Both
reproduce SVG's own band profile at the authored widths. **A second surface for that half would have
bought a second surface and nothing else.** See the D8 amendment in the ADR — the plan is not the
place that decision lives.

**Half one — the concentric ring** (`dd74511`): `strokeOuterColor` + `strokeOuterWidth`, two fields
for the reason the gradient is three (a list of independently-coloured strokes is the frozen `list`
kind; a third ring is **not** approximated). Three refusals, resolved in one place: no width, no
inner stroke to ring, or a ring no wider than what it surrounds — each byte-identical to no ring.
One copy list died: the inner stroke's hand-rolled `slice(String(num(s)).length + 3)` became
`parseTextStroke`, shared by both rings.

**Half two — text on a path** (`3f02248`): `textPathCurve`, one number, so it is emitted and
therefore keyed like every other look rather than becoming a second `textWarp`-shaped special case.
The SVG surface carries its own fonts as data URIs and **refuses to draw** when it cannot (T-21).
What a curve cannot carry is declared in `textPathUnsupported`, not dropped quietly.

**Two findings worth carrying out of this stage:**

1. **"Warp wins over a curve" was declared and not enforced.** Warp rasterizes by recursively calling
   the ordinary draw, which applied the curve and then deformed it. Caught only because the control
   was written as an EQUALITY against warp-alone rather than as "the picture differs" — a difference
   assertion would have passed on the composed geometry (T-15 addendum 3, again, and this time in a
   control rather than in a subject).
2. **Two constants were replaced by measurements before they could ship.** The arc's ink box used
   0.8/0.2 of the font size for ascent/descent; it reads the face's own metrics now, because the ink
   box is what centres the run and a guess there makes the text JUMP the instant a user drags the
   curve off zero.

**Evidence:** `render:baseline` 85/85 unchanged at zero tolerance across the full unbatched sweep,
twice (once per commit); `multi-stroke` and `path-text` at 0.000% parity, captured and then
re-checked from a cold browser so their determinism is measured rather than assumed;
`text:s5-falsifier` gains eight arms; `textstyle:schema` sweeps 31 fields; `textstyle:golden` 99/99
with the pre-existing cases differing by exactly the appended key each commit adds, checked
mechanically; and `apps/worker/tmp/s8-dom-probe.mjs`, which is the S5 lesson taken literally — the
pixel gate compares the two RASTER consumers, so the DOM overlay is covered by nothing, and the ring
is an absolutely-positioned copy that would paint straight over the glyphs without the
`position: relative` lift. It matches the DOM's bands against the AUTHORED look rather than against
the raster's output, because two implementations checked against each other both pass when both are
wrong the same way.

**Looked at, not just hashed:** the ring still (white fill, dark inner stroke, yellow ring,
concentric) and the arc still (glyphs rotated to the tangent, both rings reproduced by the SVG
surface exactly as the canvas surface draws them).

---

## S9 — Per-character and variable-axis animation

**Win:** per-character reveals, stagger, wave, and continuous weight/width animation.

**Scope:** builds on the existing `TextRun`s (`getCompositionTextRuns`, composition-style.ts:746)
and the existing keyframe evaluator (`animation.ts`) — no new animation system.

**SPLIT into three 2026-08-16**, because the halves have very different costs and the cheapest one
was ready first. S9a (static axis) ships a visible win with no animation machinery at all and is
DONE. S9b (animating the axis) has a registration-cost trap that has to be measured, not assumed.
S9 proper (per-character) is the largest and is gated on OQ6, which is now ANSWERED.

---

### S9a — the STATIC variable axis. **SHIPPED 2026-08-16.**

**Win:** author any weight or width a variable family exposes — 550, 620, whatever is in the file's
`fvar` — instead of being limited to the cuts the catalogue enumerates. No animation machinery at all.

**It reverses S5's deferral, and the reversal is measured.** S5 deferred this because canvas 2D
exposes no `fontVariationSettings` and `ctx.font` rejects an inline declaration. Both are true and
both are about DRAW time. A `FontFace` carries a `variationSettings` DESCRIPTOR that instances the
axis at REGISTRATION, and CSS carries the same descriptor inside `@font-face` — the route the worker
takes, because the worker installs faces as CSS. Two aliases over one variable file measure 331.98
vs 368.08 **on canvas**, with a DOM control at 331.98 vs 368.09 proving the file is variable and the
engine can instance it. See ADR-023's OQ2 entry for the full record.

**What shipped**
- `fontWeightAxis` / `fontWidthAxis` on `TimelineLayer` and `TextStyleFields`; two `number` fields,
  not a `Record<axisTag, number>` — the ADR-003 taxonomy has no map kind, and this is the third time
  the answer has been decomposition (`lut`, S8's two-fields-not-a-list). `opsz`/`slnt`/custom axes are
  REFUSED, not approximated: an axis whose meaning is per-foundry cannot be given a labelled slider.
- `font-variation.ts` — the alias-family derivation, the descriptor string, and a hand-rolled `fvar`
  parser (hand-rolled because opentype.js cannot Brotli-decode `.woff2`; `font-outlines.ts:35`).
- Registration on both surfaces: `new FontFace(alias, src, { variationSettings })` in the editor,
  `font-variation-settings:` inside the worker's `@font-face` block. One download per FILE, one
  registration per INSTANCE.
- The S8 arc surface too — an SVG-as-`<img>` ignores the presentation attribute (measured) but
  honours the `@font-face` descriptor, so a curved run varies.
- The two rows sit directly under the Bold toggle, and appear only when the ref is PINNED and the
  file either exposes the axis or has not been read yet. A file read and known static gets no row —
  showing one would be S2.7's faux-bold lie in a new place.

**The S2.7 boundary, which is why these do not fight.** S2.7 picks between FILES (Google enumerates
instances and serves a static file per weight, which is why it sees Cairo's nine); S9a picks WITHIN
one file. An axis never rewrites the ref, and the alias face carries the ref's own `font-weight`
descriptor, so the emitted `font-weight` is byte-identical with and without an axis — asserted in
`textstyle:golden`. **Cairo's nine enumerated instances must not be collapsed**; `font:face-test`
still reports "Cairo 9 (no italic)", and that assertion protects THIS stage.

**⚠ The detect that lies.** `FontFace.variationSettings` does not reflect back — Chromium returns
empty for a face that renders the axis correctly — so a feature detect on the reflected value calls a
working API unsupported. Written into `font-variation.ts` and the falsifier's failure message.

**Evidence:** `font:axis-falsifier` — file control (Arimo-Regular, already in this repo, is VARIABLE
with `wght` 400–700), subject (400 vs 700 differ), D1a (absent == the file's own default, in pixels),
the arc surface (curved 400 vs 700 differ), refusal (system ref + axis is byte-identical to system
ref). `textstyle:golden` 103 cases with **4 added and 0 changed**. `textstyle:schema` 33 fields swept.
`font:install-gate`, `text:s5-falsifier`, `font:face-test`, `font:index-test`, `font:catalogue-test`
all unchanged.

**`render:baseline`: 83 of 85 byte-identical, 2 IRREPRODUCIBLE — stated that way rather than as
"83/85 passed".** Re-run to completion on a clean machine (32 GB free, preconditions enforced) after
the earlier `ENOSPC` runs. `text-warp` and `multi-stroke` flag in a FULL sweep at 3/2073600 and
0–1/2073600 pixels, and report `unchanged` when the same two are run narrowed, repeatably. Not S9a: the
reading is unstable across sweeps (`multi-stroke` 0 then 1 on unchanged render code), and the raw diff
is 18 and 2 bytes each **±1 in one channel** on antialiased glyph edges — LSB rounding, not a moved
region. Logged in `project-tracker/infrastructure.md` with a re-registration trigger, and deliberately
NOT closed by re-capturing the baseline, which would freeze the noise into the reference.

Per the founder's noise-floor rule a void run is not netted out, so the zero-tolerance statement is
**not available** for this stage. Its no-move evidence rests instead on `textstyle:golden` (103
emitted styles, 4 added, **0 changed**) and on `font:axis-falsifier`'s absent-==-the-face's-own-default
arm, in pixels, both of which completed. Stills read, not just hashed: the 700 is the same Arimo letterform
with interpolated stems, not a faux-bold smear or a substituted face.

### S9b — ANIMATING the axis. **Not started.**

Only after S9a. **The trap is registration cost:** a continuously animated axis wants a face per
sampled value, and registering `FontFace`s per frame is not free — `collectPinnedFontInstances` turns
from "a handful" into "one per sampled value". **Quantize to N steps and MEASURE N against visible
banding** rather than picking a number. If the cost makes continuous animation impractical, saying so
with the number is a real answer. S9a deliberately ships the axis rows WITHOUT keyframe wiring, so
this half cannot arrive by accident.

---

### S9 — per-character animation. **Not started; OQ6 ANSWERED, precedence gate written and RED.**

`text:s9-precedence` (bbf1242) declares the four compositions — animation composes UNDER warp, the
curve WINS, a shaping-dependent script WINS, and at rest the animation contributes NOTHING — as
equalities, written BEFORE the feature and failing by design. That is the `pending()` pattern: a gate
that passed before the feature existed could not tell whether it arrived. **Do not re-tier it as
broken and do not make it green until the animator lands.**

**The paragraph below is now HISTORY for the axis half, kept for its S2.7 argument.** S9a shipped the
axis and the argument here is what it was built on — that Google's index enumerates instances, so
animating weight through the FILE would be a different `fileHash` (and, per T-8, a different raster)
per frame.

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
