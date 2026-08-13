# ADR-023 — Text, typography, and the text matte

- Status: **Accepted** for the decisions in §2–§6 (D1–D12, D1a, D4a, D6a, D9a). **Provisional** for D9
  (the raster matte value inside the Flarex compiler), which is accepted in intent and gated on the
  spike in §9/OQ1 before code moves. **D9a is Accepted and NOT gated on OQ1** — warp's rasterize-
  then-deform pipeline is outside the Flarex compiler and does not touch `FlarexMatteValue`; it does
  not inherit D9's Provisional status just because both are called "matte operations."
- Date drafted: 2026-08-13
- Governed by: `FLAREX_IMPLEMENTATION_GOVERNANCE.md`

```
Depends on:  ADR-004 (PropertySchema), ADR-005 (inspector adapter pattern),
             ADR-007 (compiler contract), ADR-009 (content-version contract),
             ADR-010 (node capability contract), ADR-021 (frame-provider seam — the
             mirror-and-pin argument here is the same argument, applied to fonts)
Supersedes:  nothing
Amends:      nothing. D9 WIDENS `FlarexMatteValue` (compile-flarex.ts:189-195); the vector
             matte's lossless-combination property is preserved for vector-only chains, and
             that preservation is a normative obligation (T-7), not a hope. D9a retires
             `font-outlines.ts`'s `opentype.js` glyph-lookup path from warp (`text-warp.ts`,
             `text-warp-mesh.ts`), replacing vector-outline-then-deform with rasterize-then-
             deform; `opentype.js` itself is retained for D2's name-table ingest parse.
             D6a (added 2026-08-13) amends D6 WITHIN this document: the first pass asserted
             that handing text to the browser is sufficient for correct international
             rendering, and it is not — the UBA also needs a base direction, which no code
             in `packages/shared` supplies. D6 is not wrong; it was incomplete.
Evidence base: none yet. Every number in this ADR is an estimate and is labelled as one.
               Contrast ADR-021, which is measured. Do not read this document as measured.
Related:     `plans/text-and-typography.md` (the staged programme)
```

---

## 0. What this does NOT reopen

**ADR-008/009/010 stand, unamended.** D9 changes what a matte *value* can hold, not how a node's
picture is computed, not the meaning of the content hash, and not the evaluator's node-type
blindness. A text node that emits a matte is an ordinary generator with a `matte` output socket —
the capability contract already describes exactly that shape for `rectMask`/`bezierMask`.

**The PropertyField taxonomy is frozen (ADR-003).** D6 introduces a `TextStyle` *schema*, using
existing field kinds. If a text feature appears to need a 16th kind, ADR-003's promotion rule
applies — metadata evolves before taxonomy. Nothing in this ADR authorises a new kind.

**The local-first asset doctrine is settled.** D5 reuses it; it does not renegotiate it.

---

## 1. Context — four pieces, one seam each, and why they are one document

Four features were scoped separately and each turned out to touch the same three places:

| Feature | Touches |
|---|---|
| Font catalogue + upload | manifest (a font reference), worker (install before render), storage (two stores) |
| Advanced text styling | the style object emitted by `getCompositionTextStyle` |
| Textured text | the style object (tier 1); the matte value (tier 2) |
| Graphics/preset library | the style object, as *serialized preset data* |

Written separately, four sessions invent four text models. The one that hurts most is the style
object: three of the four features want it to be a schema, and the fourth (presets) is *unbuildable*
until it is one.

**The state today, read from the code:**

- `composition-style.ts:713-741` emits a flat CSS object. Text carries exactly four decorative
  properties: `letterSpacing`, `textShadow`, `WebkitTextStroke`, and a background pill
  (`background` + `borderRadius` + `padding`). They are loose fields on the layer, read with
  `layer.X ?? style.X ?? default` at each site.
- `composition-style.ts:122` `renderSafeFonts` is **five entries**, and the constant's name is the
  whole argument: the list is small because it had to be a font both Chromiums already had.
- `composition-style.ts:907` `getCompositionFontsUsed` collects **family strings**, and
  `export-core.ts:324-333` calls `document.fonts.load(...)` on each with `.catch(() => undefined)`.
  A missing font is currently swallowed by design.
- `font-outlines.ts:30-60` already contains a font *catalogue* — family → binary path, with a
  registration hook (`registerWarpFonts`) and a per-app resolver (`configureFontResolver`) — and its
  own comment names "a future large (Canva-scale) font library" as the thing it is a seam for. It
  also carries the scar: the catalogue shipped **empty**, so every warped layer silently rendered as
  Roboto, and the user reported it as "changing the font did nothing".

That last item is the single most useful fact in this section. **The silent-fallback failure has
already happened here once, in the narrow warp path, and it presented as a feature that did not
work rather than as an error.** D3 is that incident written as a rule.

---

## 2. Fonts

### D1 — The manifest carries a font REFERENCE, not a CSS font stack. (Accepted)

```ts
/** What a layer stores. NOT a CSS string — a string names a font, it does not provide one. */
export type FontRef =
  | { source: "catalogue"; family: string; weight: number; style: "normal" | "italic"; fileHash: string }
  | { source: "user"; family: string; weight: number; style: "normal" | "italic"; fileHash: string; ownerId: string }
  | { source: "system"; fontFamily: string };
```

`family`/`weight`/`style` are the *human* identity and drive the picker and the CSS
`font-family`/`font-weight` we hand the browser. **`fileHash` is the render identity** and is what
the worker resolves. Two projects that both say "Inter 700" but pin different hashes are two
different renders, correctly.

**`source: "system"` is the legacy case, not a third render path.** It carries the raw CSS font
stack unchanged (`fontFamily: "Arial, Helvetica, sans-serif"`) and resolves exactly as it does
today — the platform's installed font, no pinning, no determinism. It exists so that a project
authored before `FontRef` existed has something to normalize into that keeps meaning "render this
the old way" forever. See D1a below: this is a decided value, not an open one.

**Why the hash and not the name:** the family name is not a key. Google reships files under
unchanged names; foundries revise metrics; "Inter 700" in January and "Inter 700" in June are not
guaranteed to be the same outlines. A name-keyed manifest silently re-renders differently. This is
the same argument ADR-021 makes for pinning a provider's identity rather than trusting container
metadata — trust the artifact, not the label.

**Bounded honestly:** pinning the bytes makes the *font* deterministic. It does **not** make the
render byte-identical across time. Chromium's shaper, hinting and rasterizer change between
versions, and both renderers ride Chromium. **This ADR guarantees "the same font", not "the same
pixels forever."** Anyone who later claims frame-exact reproducibility across a browser upgrade is
claiming something this decision does not support.

### D1a — Legacy projects keep their CSS stack, unchanged, forever. Migration is opt-in. (Accepted — closes OQ5)

An existing project's `fontFamily` string normalizes to `{ source: "system", fontFamily: <the
unchanged string> }` and is **never** remapped to a pinned OFL face automatically. Migrating to a
pinned face is a per-project, user-triggered, visible action — never a side effect of opening the
project or of this ADR shipping.

**This is not a new rule; it is the colour pipeline's rule, applied to a second axis.**
`color-management.ts:82-119` draws exactly this line: `LEGACY_PROJECT_COLOR_SETTINGS` and
`NEW_PROJECT_COLOR_SETTINGS` are two separate constants, not one default with a flag, precisely so
that "the field is absent" keeps meaning "authored before this existed" **permanently** — not merely
until the default's value next changes. `normalizeProjectColorSettings` (`color-management.ts:136`)
falls back to the legacy value on anything unrecognised, on the stated reasoning that "I could not
read it" and "it said something else" must have the same safe answer. That design took seven
commits to land correctly; this ADR reuses the shape rather than re-deriving it.

The reason a silent remap is wrong here is concrete, not merely cautious: swapping "Arial,
Helvetica, sans-serif" for the metric-compatible `Arimo` mid-project **reflows text** — line breaks
move, a title that fit now clips — in a project the user may have already published. A colour
default drifting is bad; a caption drifting off a subject's shoulder because a font swap reflowed
the line is worse, because it fails in the *export*, unattended.

### D2 — Read the name table. Never trust the filename. (Accepted)

Family, subfamily, weight class and italic flag come from the font's `name`/`OS/2` tables at
ingest. `MyFont-Bold-FINAL(2).ttf` is not evidence of anything. The parse is also the validity
check: a file whose name table cannot be read is not a font and is rejected at upload, not at
render.

*Note:* `opentype.js` is already a lazy dependency of `font-outlines.ts` and can do this parse. It
should be reused rather than adding a second font parser.

### D3 — A missing font is a hard failure at the render boundary, and a VISIBLE degraded state in the editor. (Accepted — this refines the brief)

The brief says "missing font is a hard fail, never a silent fallback". Agreed for the renderer, and
this is the correction: **a blanket hard-fail is wrong for the editor.** An editor that renders
nothing because one font of forty is missing has converted a small problem into a stopped session,
and this repo's own local-first doctrine already has the right shape for it.

Normative:

- **Worker / export**: a `FontRef` that does not resolve to installed bytes **aborts the render with
  a named error**. No fallback, no `.catch(() => undefined)`. The current
  `export-core.ts:332` swallow is removed as part of this.
- **Editor / preview**: renders with a substitute, and the substitution is **surfaced** — a marked
  state on the layer and a project-level banner, reusing the `needs-relink` vocabulary in
  `apps/web/src/lib/sync.ts:92`. The failure mode this exists to prevent is exactly the warp
  catalogue incident: wrong pixels that look like a working feature.
- **A project with an unresolved font cannot be exported** until it is relinked or the font is
  re-picked. That is where the hard fail lands for the user — at the action that produces a
  deliverable, not at the action of opening the door.

### D4 — Two stores, structurally separate. This is a licensing invariant. (Accepted, normative)

- **Shared mirror** — OFL/Apache catalogue fonts, mirrored on first use into R2 under
  `fonts/catalogue/<fileHash>`, **deduplicated across all users**. This is correct: the licence
  permits redistribution.
- **Per-user store** — user-uploaded licensed fonts, at `fonts/user/<ownerId>/<fileHash>`,
  **never deduplicated across accounts and never served to another account**. Two users who upload
  byte-identical copies of a commercial font get two objects. The storage waste is the point: the
  duplicate is what makes the isolation structural.

**Not a boolean on one store.** A flag is a thing an optimisation can read as "these rows have the
same hash, collapse them" — and content-addressed storage's whole instinct is to collapse equal
hashes. That collapse, on a commercial font, is redistributing a licence the user bought and we did
not. Encode it in the type system, in the manner of `input-transform.ts:60-85`: the two stores are
two *types* with no common supertype that carries a resolvable URL, so no function can be written
that takes "a font" and serves it without first discriminating on the source. The per-user key is
`(ownerId, fileHash)` and `ownerId` is not optional and has no default.

> If a future reader is tempted to merge these for storage efficiency: the saving is measured in
> gigabytes and the exposure is measured in lawsuits. This paragraph exists so that the merge has to
> be argued against a written decision instead of discovered as clever.

### D4a — Mirroring OFL/Apache faces is licensed redistribution, not a grey area. (Accepted — closes OQ4)

OFL explicitly permits redistribution, including bundling and self-hosting; Apache-2.0 likewise,
with notice retained. This is exactly what Fontsource and Bunny Fonts do at scale, so there is
precedent for doing it at this scale too. The conditions are operational, not blocking:

- **Every mirrored font is stored with its license file, and the mirror never serves a font
  without one.** (T-11, below — this is the kind of requirement that silently stops being true if
  it lives only in prose: a future ingest path that copies bytes into R2 without also copying the
  `OFL.txt`/`LICENSE` alongside it is a licence violation that ships silently.)
- Never sold standalone — consistent with D-monetization elsewhere in this repo (editor free,
  charge only real COGS).
- Reserved Font Names apply only if a face is **modified**. We mirror unmodified bytes (D1's
  `fileHash` pins exactly that), so RFN is not triggered by this pipeline — but it becomes live the
  moment anyone builds a font *editing* feature (explicitly out of scope, §6), and that future work
  must re-read this clause rather than assume it is still inert.

### D5 — User fonts are assets, and reuse the asset doctrine unchanged. (Accepted)

Upload lands in OPFS locally; an opt-in cloud upload **records a pairing** and does not remap the
project. A font missing on a second machine takes the existing `needs-relink` path (D3), not a new
one. No new sync concept is introduced by fonts.

---

## 3. Text styling

### D6 — Text rides CSS/DOM in both renderers. It does NOT move to GL. (Accepted, normative)

Parity between the web preview and Remotion is currently free for text, and it is free for a
structural reason, not a lucky one: **both renderers are Chromium, and both hand the same CSS to the
same layout and shaping engine.** Moving text to GL replaces that with two hand-written text
stacks — the exact "two machines kept in agreement by gates" that ADR-021 §1 was written to stop.

It would also discard **shaping**: bidi, ligatures, contextual forms, cursive joining, mark
positioning, grapheme clustering. That is what makes Arabic, Devanagari, Thai and emoji work. It is
tens of thousands of engineer-hours in HarfBuzz and it is already in the process.

**The precise rule — and the brief's version needs this correction, because the codebase already
violates the loose form of it:**

> **Layout and shaping are always the browser's. Rasterization may happen anywhere.**

`scene-text-raster.ts` already rasterizes text to a canvas for the Flarex/scene path, via
`drawTextLayer`, which is canvas 2D `fillText` — that is *browser shaping into a raster*, and it is
fine. `font-outlines.ts` is today's exception: `opentype.js` `getPath()` does **glyph lookup, not
shaping**, so the text-warp path has no ligatures, no bidi, and no complex-script support. **This is
not a hypothetical risk to avoid — it is a live limitation of shipped warp today**, recorded here so
it is findable rather than rediscovered: any warped Arabic, Devanagari or complex-script text is
already wrong, right now, before this ADR changes anything.

**The exception is not accepted as permanent — see D9a, which retires it.** Warp is reclassified
from a vector-outline operation to a matte operation, at which point it rasterizes with full browser
shaping like every other text path, and `font-outlines.ts`'s glyph-lookup route is deleted rather
than kept as a standing carve-out. Until D9a ships, D3's interim rule (T-12) applies: warp must
detect a shaping-dependent script and refuse to apply itself, visibly, rather than render wrong.

### D6a — Base direction is DATA the browser needs, not something the browser infers for us. (Accepted, normative — amends D6, added 2026-08-13 after the first pass missed it)

D6 says shaping belongs to the browser. That is true and it is not sufficient, and the first pass of
this ADR stopped one step short. **Shaping is not the only input the Unicode Bidi Algorithm needs —
it also needs the paragraph's base direction, and that is not derivable from the glyph stream.** The
UBA resolves the *relative* order of runs within a paragraph correctly no matter what, but the
paragraph embedding level decides where neutrals land, which edge a line starts from, and what
"align left" even means. We never supply it.

**Verified 2026-08-13: `direction`, `dir` and `unicode-bidi` appear nowhere in `packages/shared`.**
Every text layer in every project is therefore rendered at the CSS initial value, `direction: ltr`,
including layers whose content is entirely Arabic or Hebrew.

What this costs is narrower than "Arabic is broken" and worse than it sounds, because it is
invisible to our own instruments. A pure-Arabic run still resolves to correct visual order under
`direction: ltr` — the letters look right, and a pixel fixture passes. What breaks is everything
governed by the base level:

- **Neutrals at the boundaries.** A `?` or `!` closing an Arabic sentence attaches to the wrong end.
- **Mixed content.** Arabic with an embedded Latin brand name or a number orders wrongly.
- **Alignment.** RTL text should default to the right edge. `textAlign: "left"` is a *physical*
  value and stays physical, so RTL text left-aligns.
- **Wrap and overflow.** Lines start from the wrong edge.

This is the failure mode that survives a gate: it screenshots clean and it is obviously wrong to
anyone who reads the script. That is precisely why it is being written down as a decision rather
than left to be noticed later.

**The decision, in three parts:**

**1. Direction is a carried property, not a paint-time inference.** A text layer gets
`direction?: "auto" | "ltr" | "rtl"`. It travels in the manifest and both renderers read the same
field (T-9). No renderer sniffs the content at paint time — that is a second text engine by
accretion, which is the thing D6 exists to prevent.

**2. `"auto"` delegates to the browser; we never implement first-strong ourselves.** `"auto"` emits
`unicode-bidi: plaintext`, which is the UBA's own P2/P3 first-strong-character rule implemented in
the engine that already has it. `"rtl"`/`"ltr"` emit `direction` explicitly with
`unicode-bidi: isolate`. This is T-5 applied to bidi and not just to shaping: we hand over the
input, we do not reimplement the algorithm.

**3. Absent means legacy, permanently — the D1a shape, again.** An absent `direction` renders
exactly as today (`ltr`, physical alignment), forever, with no migration script. New text is
authored `"auto"`. Two constants, never one default behind a flag, so *absent* keeps meaning
"authored before this existed" — the same discipline as `LEGACY_PROJECT_COLOR_SETTINGS` vs
`NEW_PROJECT_COLOR_SETTINGS` (`color-management.ts:94-119`). An existing project with Arabic text
stays as wrong as it is today until its author opts in, and that is the correct trade: a silent
re-layout of shipped projects is a worse defect than the one it fixes.

**Logical alignment rides along.** `textAlign` gains `"start"`/`"end"`; existing `"left"`/`"right"`
keep meaning physical left and right and are never remapped. New text defaults to `"start"`. Without
this, part 1 delivers correctly-ordered text pinned to the wrong edge, which is not a fix.

**One detector, not two.** The script detection T-12 requires for warp and the script detection
`"auto"` defaulting requires at authoring time are the same question asked twice. It returns the
script and the direction, not a boolean. This is the whole reason D6a is being written *now*, while
S0 is in flight, rather than filed as a follow-up: sequenced later, it builds a second detector.

### D7 — The reachable CSS surface is much larger than four properties, and `paint-order` is first. (Accepted)

In priority order:

1. **`paint-order: stroke fill`** — strokes render *behind* the fill instead of eating half the
   stroke width inward. This is the difference between our current stroke and every sticker-caption
   look on social. One CSS declaration; supported in Chromium for text. **Highest value per line in
   this entire document.**
2. **Multiple `text-shadow`s** — the property is already a list; we emit one. Stacked shadows are how
   hard 3D-extrude and multi-colour offset looks are made.
3. **`background-clip: text`** — tier 1 textured text (§4).
4. **`font-variation-settings`** — variable-font axes as *animatable numbers*, which makes weight,
   width and optical size continuous rather than five discrete cuts.
5. **Per-line background pills** — the existing pill is one box around the block; per-line boxes
   (with the CSS box-decoration-break behaviour) is the caption look people actually want.

### D8 — SVG is added for exactly two things CSS cannot do. (Accepted)

**Multiple independent strokes** (concentric outlines of different widths and colours) and
**text on a path / arc text**. Both are `<text>`/`<textPath>` in SVG, which **still uses browser
shaping** — so D6 holds. SVG is a second *rendering surface*, not a second *text engine*, and it is
used only when a style actually needs it. A style that does not is plain DOM.

### D9 — Text emits a matte, and `FlarexMatteValue` widens to admit a raster. (Accepted in intent; **Provisional** pending OQ1)

Tier 2 textured text is: **the text produces a matte; the matte keys a GL fill.** Fusion and After
Effects both do it this way, and it is why in those tools "video inside text" is not a text feature
— it is a matte wired to a source. Once text emits a matte, the fill can be a generator, a
procedural texture, a video source, or an entire Flarex comp, with no further text work.

The cost is precise and must not be glossed. `compile-flarex.ts:189-195`:

```ts
/** Matte values stay VECTOR (`Mask[]`) until applied to an image, so MatteControl combines
 *  losslessly through the same multi-mask compositing the mask rasterizer already does. */
type FlarexMatteValue = { masks: Mask[] };
```

**Glyph coverage is not expressible as `Mask[]`.** So one of these must happen:

- **(a) Widen the value** to `{ kind: "vector"; masks: Mask[] } | { kind: "raster"; ... }`. Every
  matte consumer — `matteControl`, `chromaKey`'s garbage/hold-out, the region-pass path at
  compile-flarex.ts:869, every `matteInput` call site — must handle both. Vector-only ops need
  raster equivalents.
- **(b) Convert glyphs to bezier `Mask[]`** via `opentype.js`, preserving vector purity. Rejected as
  the primary path: it is the `font-outlines.ts` route, which means **no shaping** (D6) — complex
  scripts and ligatures would be wrong in textured text specifically, which is an absurd place for
  them to break. It is also hundreds of contours for a line of text.

**Recommendation: (a), with (b) available as an opt-in for the specific case of a text matte the
user wants to edit as bezier paths.** The status is Provisional because the blast radius across
matte consumers is the largest single cost in this programme and has not been spiked. See OQ1.

### D9a — Text warp is a matte operation: rasterize with shaping, THEN deform. Not outline, then deform. (Accepted, normative — same class as D10)

Warp exists today (`text-warp.ts`, `text-warp-mesh.ts`, `font-outlines.ts`) as a **vector** pipeline:
`opentype.js` extracts glyph outlines, an envelope mesh deforms the path commands, and
`buildWarpedTextPathSvg` emits the result as an SVG `<path>` overlay — `composition-style.ts`'s own
comment is explicit that this is deliberately *not* a CSS filter. That design bought crisp warp at
any deformation strength, and paid for it with D6's exception: `getPath()` is glyph lookup, not
shaping, so warp has no ligatures, no bidi, no complex-script support, and it is wrong **today**
for any shaping-dependent script.

**Reclassify it: warp is coverage-in, coverage-out, driven by a deformation field — exactly D10's
definition of a matte operation, in the same family as roughen, choke and feather.** The pipeline
becomes: rasterize the text with full browser shaping (`drawTextLayer`'s canvas `fillText`, the same
call `scene-text-raster.ts` already uses), then deform the *raster* through the existing envelope
mesh math. `opentype.js`'s `getPath()` — the glyph-lookup call — is deleted from the warp path
entirely. Shaping is not approximated afterward; it never has to be, because it already happened
before rasterization, in the browser, for free. This is what fixes complex scripts, and it is not a
targeted fix for complex scripts — it is the structural consequence of moving the deform to the
right side of the shaping boundary.

**The cost is real and specific: a raster loses detail under heavy local magnification that a vector
deformation would not.** A warp field that stretches one region of the raster by, say, 4× exposes
that region's original pixel grid. **Mitigate by supersampling the raster at a scale derived from
the deformation field's maximum local magnification**, not a fixed multiplier — cheap warps stay
cheap, extreme warps get the resolution they need. The mechanism already exists in this codebase and
does not need inventing: `scene-text-raster.ts:47-48,280` computes `rasterScale` from a
`displayScale`-derived bucket, capped by `MAX_RASTER_DIM` so magnified text stays crisp within a
bounded cost. The same shape of computation applies here, keyed to the warp field's max stretch
instead of display scale.

**harfbuzzjs is the named escape hatch, not the plan.** If a future deliverable genuinely needs
*vector* warped text — an SVG export target is the only case that would — `harfbuzzjs` (HarfBuzz
compiled to WASM) does real shaping and can emit shaped glyph runs an outline pipeline could deform
losslessly, which `opentype.js` cannot. **It is not needed now** and pulling it in now would be
exactly the finished-but-unused infrastructure this repo's standing rule forbids. Recorded here so
the next person who wants vector warped text finds the answer instead of reaching for `opentype.js`
again.

**T-12 — Interim, until this ships: warp detects a shaping-dependent script and disables itself
visibly.** Not silently — the warp catalogue's empty-list incident (§1) is exactly the shape of bug
a silent partial-render produces. A visible "warp unavailable for this text" beats a wrong render,
and it beats nothing at all. This rule is retired the moment D9a ships, because at that point warp
has no shaping-dependent limitation left to guard against.

### D10 — Edge treatments are MATTE operations, not text features. (Accepted, normative — and this generalises)

Roughened/torn edges, choke/spread, feather, and edge blur go on **the matte**. Built there, they
compose for free with masks, keyers, tracked shapes and the AI matte. Built into the text renderer,
each is a one-off that the next feature reimplements.

The vector `Mask` type already has `feather` and expansion (types.ts:453-463), and `matteControl`
already exposes `feather`. So the shape of this is established; D10 is the commitment that the
*new* treatments land in the same place and that **no edge treatment is ever added to a text node's
params.**

**The general rule, stated so it outlives this feature:** when an operation's input is coverage and
its output is coverage, it belongs to the matte vocabulary, wherever the coverage came from.

### D11 — A rasterized text matte is keyed on the existing content hash, and the font is part of the key. (Accepted, normative)

The ADR-009 content hash already governs re-rasterization. The obligation this adds: **the font's
`fileHash` is an input to the text raster's content hash.** Without it, a font finishing its async
load produces new pixels under an unchanged key — a stale hit that renders the old font forever.

`scene-text-raster.ts:15` documents that the current code bumps a version on a `document.fonts`
listener. That is the existing mitigation and it is a *signal-based* one — which is the
liveness-signal bug class this repo has already been bitten by (DEBT-009). Folding the font hash
into the key is the structural fix; the listener becomes an optimisation rather than the
correctness mechanism.

---

## 4. Presets and the graphics library

### D12 — A text preset and a graphics template are the same *concept* at two different layers, and they are NOT the same object. (Accepted — this disagrees with the brief)

The brief says a text preset and a graphics template are the same object, and that `templates.ts`
already exists for it. **The concept is right and the object is wrong**, and this matters because
building presets *as* `TemplateDefinition` would be a substantial detour.

`templates.ts` today produces `TemplateDefinition = { slug, category, durationSeconds,
requiredModules: ModuleType[], templateGraph: ProjectGraph, editableFields, creditCost }`. That is a
**project-level** object: a stack of AI modules with a dependency resolver behind it and a credit
price. "Bold yellow caption with a black stroke" is not a module stack, has no duration, and costs
nothing.

The primitive already specified for this is **PropertySchema presets**, ADR-004: *"Presetability is
described by the schema; presets are separate data"*, with presets, project data and clipboard all
being `{schemaId, version, values}` and all passing through the same migrations. That is exactly a
style preset, including the part everyone forgets — **a preset saved today still loads after the
schema changes**, because migrations run on presets identically.

So:

- **Layer 1 — style presets.** `{schemaId: "text-style", version, values}`. This is what a text
  preset, a caption preset, and a shape preset each are. Requires D6's schema (below) and nothing
  else.
- **Layer 2 — graphics templates.** A reusable stack of layers, each carrying a layer-1 preset,
  plus placement and timing. `templates.ts` is the right home for *this* layer, and a lower-third or
  a title card lives here.

The brief's instinct is preserved — one vocabulary, presets are data, templates compose them — while
the two granularities stay separable. **Caption presets are the highest-value entry point** and sit
entirely in layer 1: `AUTO_CAPTIONS` already produces a caption track, so a layer-1 preset applied
over that track *is* short-form captions, with no layer-2 work at all.

**Shapes are largely already there** — `scene/text-shape.ts:596 drawShapeLayer` is the renderer, and
it is already shared by the scene raster path. Shapes need a schema and presets, not an engine.

### The schema itself

`TextStyle` becomes a `PropertySchema` (ADR-004) produced by an adapter (ADR-005) and rendered by
`PropertyFieldList` (ADR-002), using only frozen field kinds (ADR-003). The loose
`layer.X ?? style.X ?? default` reads in `composition-style.ts` become one resolved style object.

This is not optional polish. Presets (D12), AI text editing, copy-paste of a look, and forward
migration of saved styles are each **blocked** on the style being a versioned schema rather than a
bag of CSS fields — and adding six more loose CSS fields for D7 without doing it makes the eventual
migration six fields worse.

---

## 5. Normative obligations

**T-1 — The manifest carries `FontRef`, never a CSS stack.** A stack string in a layer is legacy
data to be migrated, not a supported value.

**T-2 — Render aborts on an unresolvable font; the editor degrades visibly.** No `.catch()` that
turns a missing font into a fallback. (D3)

**T-3 — The two font stores are two types.** No function may resolve a font to bytes without
discriminating on `source`. The per-user key includes `ownerId`, non-optional. (D4)

**T-4 — Font identity is read from the name table.** (D2)

**T-5 — Layout and shaping are the browser's, always. Rasterization may happen anywhere.** No
hand-written line breaking, bidi, or glyph positioning. (D6)

**T-6 — No edge treatment on a text node's params.** Coverage-in/coverage-out belongs to the matte.
(D10)

**T-7 — A vector-only matte chain must remain lossless after D9.** Widening the value must not
silently rasterize a chain that could have stayed vector; rasterization happens at the point a
raster is genuinely introduced, and no earlier. This is the property the current comment claims and
it must survive the widening.

**T-8 — The font hash is an input to any text raster's content hash.** (D11)

**T-9 — Both renderers, always, in the same change.** Every stage lands in
`apps/web/src/components/VideoPreview.tsx` **and** `apps/worker/src/remotion/Root.tsx`, with a
`render:compare:pixels` fixture. This is CLAUDE.md's standing rule; it is restated because text is
where it is easiest to believe parity is automatic. It is automatic for *layout* (D6) and not for
anything else.

**T-10 — Presets, project data and clipboard share one envelope and one migration set.** (ADR-004,
via D12)

**T-11 — A mirrored font is never stored, and never served, without its license file alongside it.**
(D4a) The mirror write path and the license-file write are one operation, not two steps a future
change can drift apart. A mirror entry missing its license file is a defect to fix before ship, not
a cleanup task to defer — it is the operational half of what makes D4a's redistribution lawful.

**T-12 — Until warp rasterizes-then-deforms (D9a), it must detect a shaping-dependent script and
refuse to apply itself visibly, never silently render wrong.** (D9a) Interim only; retired the
moment D9a ships, at which point warp has no shaping gap left to guard against. **The detector this
rule requires returns the detected script AND its direction, not a boolean** — D6a consumes the same
detection, and two detectors answering one question is how they drift apart.

**T-13 — Base direction is carried in the manifest and read identically by both renderers. No
renderer infers direction from content at paint time.** (D6a) `"auto"` is delegated to the browser
via `unicode-bidi: plaintext`; we do not implement first-strong resolution. An absent `direction`
renders as `ltr` with physical alignment, permanently and without migration.

**T-13 CORRECTED 2026-08-13, after S0b (e4d1a48) shipped against it and the correction is mine, not
the stage's.** As written above the rule was too broad, and it cost this feature its headline win.
`"auto"` delegating to `unicode-bidi: plaintext` only works where there IS a CSS box. **Canvas 2D
has no equivalent** — `ctx.direction` takes a concrete value — and both renderers take their pixels
from the raster path (`scene/text-shape.ts`), so `"auto"` silently draws `ltr` in the preview AND
the export. Measured, not inferred: S0b's `"auto"` baseline hash is byte-identical to its `"ltr"`
render. New text is authored `"auto"`, so the shipped default is "Arabic works if you pick RTL",
not "Arabic works."

The hazard T-13 was actually written to prevent is **two renderers each deciding direction for
themselves and drifting.** Resolving `"auto"` to a concrete direction **once, in shared code, at
style-resolution time** is not that — it is one function both paths consume, exactly as
`getCompositionTextStyle` already is. The corrected rule:

> **Resolve `"auto"` once, in shared, and hand both paths the same concrete answer. No renderer may
> resolve it for itself, and no resolution may happen inside a paint loop.**

The cost is per-paragraph auto: one resolved direction per layer rather than per line. That is what
After Effects and Premiere both do — direction is a paragraph/layer setting, not a per-line
inference — and no one has asked for a single text layer holding paragraphs of opposing direction.
Accepted.

**T-13a — Logical order requires drawing lines, not words.** (S0b, measured.) The raster tokenizes
to words and places each at a computed logical x (`text-shape.ts:198,229,567-569`), so cross-word
bidi reordering cannot occur no matter what `ctx.direction` says: `"مرحبا Brand بالعالم"` exports in
logical word order even at explicit `"rtl"`. Setting `ctx.direction` fixes the start edge and
intra-call bidi; it cannot fix placement the caller already decided. A line whose runs share one
style must be drawn with a **single `fillText`**, which is also faster. A line with multiple style
runs cannot be — canvas 2D exposes no per-character visual positions — and must therefore apply
T-12's discipline: detect a shaping-dependent script and degrade visibly rather than silently
emitting logical order.

**T-15 — Every new text field ships with a falsifier: flip it and prove the render CHANGES.**
(S1, 2026-08-13 — learned the hard way.) A renderer-parity gate compares two consumers that read the
same manifest bag; it therefore cannot detect a field that never reached the bag. Both renderers
agree, at 0.000%, on the answer neither of them was given. S1 nearly shipped exactly this:
`strokePaintOrder` was absent from `buildRenderManifest`'s hand-written field list
(`render-templates/src/index.ts:404-433` and the second site at :509), so the editor rendered
stroke-under and the export stroke-over for the same project. What caught it was flipping the
fixture to the opposite value and finding the render **byte-identical** to the baseline — a feature
that changes nothing changed nothing.

Parity answers "do the two renderers agree." It never answers "is either one listening." Only a
falsifier does, and from S2 on every stage adds manifest fields, so this is not a one-off lesson.
**The hand-written copy list is the defect's home** — until the manifest's text bag is derived from
a declared key set with a compile-time exhaustiveness constraint (the `TEXT_STYLE_FIELD_KEYS`
`satisfies` pattern at `text-styles.ts:10-29` is the shape), every future field is one omission away
from the same silent divergence, in two places at once.

**T-13a addendum — the multi-run path is unreachable without a visible change, and that is a
property of the design, not a hole in the gate.** (S0c, b3adaa0.) An attempt to build a pixel arm for
T-13a failed for an instructive reason: `collapseLine` keys on the *effective draw style*, so every
way of forcing the run-by-run path also changes how the text looks — even restating `fontFamily` on
alternate runs resolves to the same font string and still collapses (verified byte-identical). There
is no pixel-invisible way to select the logical path, because the raster only takes it when the runs
genuinely differ. **Do not treat the missing pixel arm as a gap to close later.** It is covered by
asserting `collapseLine` as a pure function (falsified by disabling the collapse and watching the
assertion fail) plus the baseline delta, where S0b's committed render serves as the word-by-word
reference. Recorded because the obvious next move — "add the missing fixture" — is wasted work.

**T-16 — A "visible degraded state" is proven by pixels, never by computed style.** (D3, T-12; S0,
2026-08-13.) D3's font-substitution surface and T-12's warp marker both exist to announce a silent
degradation, which makes a marker that silently fails to paint the purest form of the bug it guards
against — and S0 shipped that in its first draft: the badge was nested inside an element carrying
`opacity: 0` while GPU-composited, and reported a full rect, `opacity: 1`, `visibility: visible`.
Every naive assertion passed on an invisible element. A marker check must walk effective opacity up
the ancestor chain and confirm viewport intersection. **Any gate asserting a user-visible warning
must itself be falsified against a deliberately hidden marker before it is trusted.**

**T-11 addendum — the licence may live BESIDE the font, and that is still one operation.** (S2.6,
f553091, measured.) D4a and T-11 assumed the licence travels in the font's name table. Every static
instance `fonts.gstatic.com` serves has name IDs 13/14 **stripped** — Cairo, Amiri, Noto Naskh
Arabic and Inter all return no licence text — so a mirror that reads only the name table would have
refused every family the catalogue can offer, and mirror-on-pick would have been dead on arrival.
The licence is not missing; it is stored next to the font. The mirror therefore admits a **second
source** (a licence path recorded in the index) but never a second **step**: the licence is fetched
inside the same call, before any write, both-or-neither intact. A document too short to be a licence
is refused, or a 404 page returned with status 200 would satisfy T-11 on paper. The stored file
records which source applied. **`isOpenSource` in Google's metadata is true for all ~1942 families
and filters nothing** — do not mistake it for a licence check.

**T-17 — A font gate must not assert a fact about the host it runs on. Make the host demonstrate the
difference.** (S2.4, 72982a3. **Sharpened by S2.6:** "differs from the control" is necessary and not
sufficient. Two *different* system-named families render the identical picture when neither is
installed and both land on one fallback — so pinned renders must also be asserted to differ **from
each other**, or a single face standing in for every pinned font passes. The same trap caught an
optimisation: a family loaded for the sample text `"Ag"` has no Arabic glyphs, so a row could report
itself loaded and draw the fallback. The sample text is part of the load request, tracked per
family.) The obvious way to prove an install path delivered bytes is to render
a font "the machine does not have" — which silently makes the gate depend on the font folder it is
standing in, the exact dependency it claims to remove, and turns green on a host that happens to
have the face. The shape that works: render the same text twice, once naming the family as a system
stack and once through a pinned ref, and assert the two **differ**. Self-establishing on any host,
and on a machine that does have the font it fails honestly rather than passing vacuously. This
generalises to every remaining font stage — S2.5's previews must be proven to render in the face
they name, and "it looked right on my machine" is the same fallacy in a different costume.

**T-18 — A nearest-match font resolver answers "what do I show". It must never answer "what do I
become".** (S2.7, 581cbd1.) `catalogueFace` and `fontIndexFace` both fall back to the nearest
weight, which is right for display — a picker row must draw *something* — and a lie the moment the
same call decides which face a layer pins: asking either for Anton 700 returns Anton 400, and the
Bold toggle silently does nothing while reporting success. **Identity resolution must refuse across
styles and return `undefined`**, and the refusal must be re-checked at the write site, because a
plan is reachable from code that never consulted the control. Two pre-existing instances of the same
hazard were closed alongside it: a bundled fast path served the roman under an italic request, and a
family topping out at 700 asked for 900 would have sent the mirror after a face that does not exist.
Whenever a font resolver gains a second caller, ask which of the two questions it is being asked.

**T-14 — No feature may re-open the shaping boundary that D9a closes.** (D6a, OQ6) Any operation
that transforms text below the level of a shaping run — per-character animation is the known case,
because each animated grapheme cluster becomes its own shaping context and cursive joining breaks —
must either resolve OQ6 or apply T-12's discipline: detect the shaping-dependent script and disable
itself visibly. Shipping S9 over Arabic without one of the two reintroduces, in a new feature,
exactly the defect S7's warp rework was written to remove.

---

## 6. Out of scope

- **A text engine of our own** — shaping, line breaking, justification, hyphenation. (D6)
- **Font subsetting** as part of the determinism story. See OQ3.
- **Selling fonts**, a font marketplace, or any font licence transaction.
- **Font-file editing** (glyph editing, metric adjustment). Kerning *pair overrides* per layer are
  deferred, not rejected.
- **3D extruded text.** Out with the rest of 3D per ADR-021 §5. Faked extrusion via stacked
  `text-shadow` (D7 item 2) is in scope and is what users actually mean most of the time.
- **OpenType feature UI** (`font-feature-settings` beyond defaults) — deferred.
- **`harfbuzzjs` / vector-shaped warp output.** Named as the escape hatch for vector warped text
  (D9a) if an SVG export target ever needs it. Not needed now, not a dependency of anything in this
  programme, and not to be added ahead of that need.

---

## 7. Consequences

**Accepted.** The font-reference migration touches every existing project with text, and the
schema migration touches the same data a second time. These should be **one** migration, sequenced
so that the schema lands after the font reference (plan stages 2→4) but both are written before
either ships to real projects.

Export gains a failure mode it did not have: a render that stops on a missing font. That is the
intended trade and D3 places the stop at the point where the user can act on it.

The per-user font store deliberately stores duplicates. This is a cost, and it is the mechanism.

**Improved.** The five-font ceiling goes. `getCompositionFontsUsed` becomes a resolver over pinned
hashes instead of a string collector, and the export path stops guessing. Text styling becomes
preset-able, AI-editable and migratable in one move rather than three. Edge treatments accrue to
the matte vocabulary, so every future coverage source inherits them. Warp's complex-script gap
(D9a) closes as a side effect of a reclassification made for an unrelated reason (matte
consistency), not as a targeted fix — `opentype.js`'s `getPath()` is deleted from the warp path
entirely, and shaping happens once, in the browser, before any deformation.

Legacy projects pay nothing here: D1a keeps every existing `fontFamily` string rendering exactly as
it does today, permanently, with migration strictly opt-in. That is a deliberate mirror of the
colour pipeline's `LEGACY_PROJECT_COLOR_SETTINGS` split (`color-management.ts:82-119`), not a new
policy — the same failure (a silent default-driven remap reflowing or reshading a published
project) gets the same fix.

**Still open, honestly.** D9's blast radius is unmeasured (OQ1), and this whole ADR carries no
measurements. It is a design document. ADR-021's provisional/accepted split is deliberately copied,
but the reader should note that ADR-021's limits were provisional *against data*, and this one's are
provisional against *nothing yet*.

---

## 8. Alternatives considered

- **Ship a bigger `renderSafeFonts` list.** Rejected: it is the current design and the ceiling it
  imposes is exactly the complaint. It also does not solve determinism, because a system font is
  whatever the machine has.
- **Bundle the whole Google catalogue.** Rejected: ~1500 families is gigabytes, and mirror-on-first-
  use gets the same determinism for the fonts actually used.
- **Move text to GL for effects headroom.** Rejected — D6. The headroom is real; the price is the
  shaping engine and renderer parity, and the matte route (D9) buys most of the same headroom
  without paying it.
- **Glyph outlines as bezier masks as the primary matte path.** Rejected as primary — D9 option (b).
- **Presets as `TemplateDefinition`.** Rejected — D12.
- **A `textureFill` param on the text node.** Rejected: it is D10's mistake in a different costume.
  Fill is a wired input, not a text property.
- **Keep warp as a vector-outline pipeline and patch shaping in some other way.** Rejected — D9a.
  There is no "patch shaping onto glyph lookup" move; shaping is not a post-process on glyph
  positions, it changes *which* glyphs are selected (ligatures, contextual forms). The only fixes
  are "shape before rasterizing" (D9a) or "shape inside the vector pipeline via real HarfBuzz" —
  which is the `harfbuzzjs` route, below.
- **Pull in `harfbuzzjs` now to keep warp vector.** Rejected for now — D9a. Real shaping without
  rasterizing is possible in principle, but nothing in this programme's scope (§6: no SVG warp
  export target exists) needs vector warped output, and building it ahead of that need is exactly
  the finished-but-unused infrastructure the standing rule forbids. Revisit if an SVG export
  deliverable is scoped.

---

## 9. Open questions

**OQ1 — What is the true blast radius of widening `FlarexMatteValue`, and what does a raster
feather cost?** The single question gating D9 out of Provisional. Needs a spike that (i) enumerates
every `matteInput` consumer and classifies each as vector-only, raster-capable, or needs-work; and
(ii) measures a raster feather/choke against the existing vector rasterizer at 1080p. **Run this
before any D9 code.** If the raster path forces every matte chain to rasterize early, T-7 is
violated and D9 needs a different shape.

**OQ2 — Do the two Chromiums interpolate `font-variation-settings` identically?** Untested. Variable
axes are the one D7 item whose parity is not obviously free, because it involves the variation
instancer rather than layout. Needs a pixel-gate fixture before the feature is claimed.

**OQ3 — Full font files or per-project subsets?** Subsetting cuts payload substantially but makes
the stored artifact a function of the subsetter's version, which undermines D1's determinism story
in the same way name-keying did. Provisional lean: **mirror full files** (determinism), subset only
at *delivery* to the browser if payload becomes a real problem, never at storage. Not decided.

**OQ4 — CLOSED. See D4a.** Mirroring OFL/Apache faces is licensed redistribution with an operational
obligation (T-11: license file travels with every mirrored font), not an open legal question.

**OQ5 — CLOSED. See D1a.** Existing `fontFamily` CSS stacks normalize to `{ source: "system" }` and
are never remapped automatically; migration to a pinned face is opt-in, per project, user-triggered.

**OQ6 — Per-character animation and grapheme clusters.** Per-character animation builds on the
existing `TextRun`s. A "character" for animation purposes must be a **grapheme cluster**, never a
code unit — splitting inside a cluster breaks combining marks, emoji ZWJ sequences and Devanagari
conjuncts. Whether `Intl.Segmenter` is available across both renderers, and what a per-cluster
transform does to the shaping run (it breaks it — each animated cluster becomes its own shaping
context, which changes kerning), is unresolved.

**Sharpened 2026-08-13 (D6a):** for Latin this is a kerning question and the answer is "slightly
wrong spacing, acceptable." For a cursive script it is not — breaking the shaping run breaks
*joining*, which is the same class of defect as pre-D9a warp, arriving in a new feature after the
old one was fixed. T-14 makes that non-optional: S9 either resolves this or disables per-character
animation visibly on shaping-dependent scripts, the way T-12 does for warp. The open part is only
which of the two; that S9 may not simply ship over it is now decided.

**OQ7 — Does a missing *user* font on a second machine hard-fail export, or relink first?** D3 says
relink, then hard-fail on decline. But a collaborator who does not *own* the licensed font can never
relink. What that project's export does — fail, or substitute with an explicit acknowledgement — is
a product decision touching D4's licensing invariant, and it is not settled here.

**OQ8 — How does a preset name a font it may not be able to provide?** A shared caption preset
referencing a user-store font cannot resolve for another account (D4). A preset must therefore carry
either a catalogue-only `FontRef` or an explicit "uses your font" slot. Unresolved, and it gates
preset *sharing*, not preset *saving*.
