# Frames — parametric, editable, marketplace-ready media placeholders

Living plan. Same workflow as GRAPHICS_TAB.md: ground → decide forks → build-ready spec →
build → user QA → ship. Frames is a NEW feature area (not the inspector Graphics tab).

## The end goal (from the founder, 2026-07-15)

- A **Frame** is a shape placeholder that a dropped image/video **auto-clips to** (fit/fill,
  then pan/zoom inside via `contentTransform`).
- **NOT hardcoded.** Every frame is DATA. Its editable parameters (roundness, corner style,
  torn-edge roughness, sides, …) surface in the **Effects subpanel** of the inspector, using
  the existing schema-driven effect controls — fully editable, like any effect.
- **Advanced shapes** matter: modern Canva frames include paper, torn pages, blobs, custom
  outlines. The format must express those.
- **Marketplace:** third parties author frame packs and SELL them — so the frame format is a
  plugin pack, and built-in frames use the exact same format (dogfood).
- Lives as a **section in the Graphics search panel** (Used · Shapes · Vectors · GIFs ·
  **Frames** · …). Animated GIFs come AFTER Frames ship.

## Grounding — the three systems Frames reuses (all confirmed in-tree)

1. **Clipping is already solved in BOTH renderers.** `maskShapeToPathD` ([clip-masks.ts:219](packages/shared/src/clip-masks.ts#L219))
   turns a shape into an SVG path `d`; the DOM preview clips via CSS `mask-image`, the
   SceneCompositor builds an alpha matte ([scene-mask-matte.ts](packages/shared/src/scene/scene-mask-matte.ts)).
   Shape vocabulary today: **ellipse, rectangle+cornerRadius (`roundedPolygonPathD`), polygon,
   bezier-with-tangents** (arbitrary smooth curves) → any torn/paper/custom outline is just a
   point-set. **Frames need NO new clipping code.**
2. **`contentTransform`** ([types.ts:311](packages/shared/src/types.ts#L311)) — the CapCut/Canva
   "adjust the media inside the box" model (fit + pan/zoom/crop) already exists. Filling a frame
   reuses it.
3. **Plugin pack system** ([plugin-manifest.ts:5](packages/shared/src/plugin-manifest.ts#L5)) —
   kinds `effect/transition/look/timeline-template/look-pack/bundle`, with zip packaging + import.
   A `frame-pack` kind (or reuse of `effect`) rides these rails for the marketplace.
4. **Effect param schema** (`effects.ts` `timelineEffectRegistry`) — schema-driven param defs
   consumed by BOTH the inspector controls and the renderers. This is how the frame's params get
   an editor UI + persistence for free.

## THE DECISION (committed 2026-07-15)

**A Frame is a data-driven parametric CLIP-SHAPE on a media layer, edited through the effect
param-schema system and rendered through the existing clip-mask matte.**

Four pillars, each reusing an existing system so nothing is hardcoded:

1. **Shape = a trusted GENERATOR + params (data).** A frame instance stored on a layer is
   `frame?: { generatorId: string; params: Record<string, number|string> }`. A generator is a
   TRUSTED, shared function `(params, box) => MaskPoint[] | pathD` that emits the clip outline in
   the layer's box. Built-in generators live in `packages/shared`:
   - `rounded-rect` (params: `roundness`) · `ellipse` · `polygon` (`sides`, `roundness`) ·
     `blob` (`points`, `seed`, `roughness`) · `torn-paper` (`seed`, `roughness`, `edges`) ·
     **`svg-path`** (creator supplies a STATIC normalized path in a unit box — pure data, the
     escape hatch that lets a marketplace ship ANY custom outline safely, no code).
   Marketplace packs ship frame DEFINITIONS that reference a trusted `generatorId` + param
   schema/defaults (+ a static `svg-path` for bespoke art). **No third-party code executes** →
   safe to sell/import. New procedural generators are platform updates; `svg-path` covers the
   long tail meanwhile.
2. **Editing = effect param schema → Effects subpanel.** Each generator declares a param SCHEMA
   (reusing the effect param definition shape). The applied frame renders as a card in the
   **Effects subpanel** with the right controls (roundness slider, roughness, sides, seed…) —
   exactly the founder's requirement. Width/height come from the layer box (transform/scale), not
   duplicated params. Edits persist on `layer.frame.params`.
3. **Render = generate path → existing clip-mask.** At render time, `layer.frame` → generator →
   path/points → fed into the SAME clip-mask matte + CSS `mask-image` path masks already use. One
   small hook in each renderer ("if `layer.frame`, add its generated clip"), no new clip engine.
   Pixel-gated.
4. **Fill = placeholder layer + drop-to-assign.** An empty frame = a layer with `frame` set and
   no asset → renders a placeholder (icon + dashed outline; NOT exported). Dropping media assigns
   the asset (reuse `onReplaceLayerAsset`); the media clips to the frame and auto-fits
   (`contentTransform`), then is pan/zoom-adjustable inside.

**Frame definition format (built-in AND marketplace, identical):**
```
FrameDefinition = {
  id: string;               // "kimera.rounded-rect" | "acme.torn-note"
  name: string;
  generatorId: GeneratorId; // trusted generator key
  params: ParamSchema;      // reuses the effect param-def shape (min/max/step/default/label)
  staticPath?: string;      // unit-box svg path, only for generatorId === "svg-path"
  thumbnail?: string;       // data-URI preview for the panel
  section?: "frames";
}
```
Built-in frames are a `FrameDefinition[]` in shared. A `frame-pack` plugin ships more.

## Why this satisfies every requirement
- **Not hardcoded** → frames are `FrameDefinition` data (built-in list + imported packs).
- **Editable params in Effects subpanel** → generator param schema drives the existing effect controls.
- **Advanced shapes (torn/paper/custom)** → `blob`/`torn-paper` generators + the `svg-path` escape hatch.
- **Marketplace** → `frame-pack` plugin manifest, same format as built-ins, no code execution (safe).
- **Renders identically in preview + export** → reuses the one clip-mask matte (pixel-gated).

## Phasing (build order)

- **Phase 1 — Vertical slice (proves the whole architecture).** Foundation types + 2 generators
  (`rounded-rect`, `svg-path`) in shared (+ unit test). One built-in frame. Render hook in BOTH
  renderers (pixel gate). Effects-subpanel param card (roundness). Fill by dropping media.
  Frames section in the Graphics panel listing the built-ins. → a usable, editable rounded-rect
  frame end to end.
- **Phase 2 — Shape library.** Add `ellipse`, `polygon`, `blob`, `torn-paper` generators + their
  param schemas + built-in frames + thumbnails. Placeholder empty-state polish.
- **Phase 3 — Marketplace.** `frame-pack` manifest kind + import + (later) an authoring/export flow;
  wire imported packs into the Frames section.
- **Later — Animated GIFs** section (new provider; explicitly after Frames).

## Open sub-decisions (resolve as we reach them, not blocking Phase 1)
- Multi-slot / grid (collage) frames — deferred past single-slot v1.
- Fill gesture: canvas drop vs asset-bin drag vs click-to-fill (Phase 1 picks the simplest reuse).
- `frame` as its own `layer.frame` field vs a `frame`-scoped effect entry — Phase 1 spec settles it
  (leaning: dedicated `layer.frame` field, so it's distinct from hand-drawn `layer.masks` and can
  own the placeholder empty-state).

## Phase 1 progress

**Step 1 — shared foundation ✅ (2026-07-15).** Proves the data format end-to-end (pure, no
renderer/UI yet):
- `frames.ts` — `LayerFrame` (`{ definitionId, generatorId, params, staticPath? }`),
  `FrameDefinition` (params reuse `TimelineEffectParamDefinition` → Effects-subpanel controls),
  `frameOutlinePathD` (unit-box SVG `d`) with generators `rounded-rect`, `ellipse`, `polygon`,
  `svg-path`, and safe full-box fallback for `blob`/`torn-paper` (Phase 2) + unknown pack ids.
  `frameParamDefaults` / `makeLayerFrame` / `findFrameDefinition`. Built-in catalogue: Rounded
  Rectangle, Circle, Hexagon (same format a marketplace pack will use).
- `TimelineLayer.frame?` field added (additive, no migration). Barrel-exported.
- Verified: `pnpm -r typecheck` all 5 clean; `frames:test` 18/18.

**Remaining Phase 1 steps** (each its own change):
- Step 2 — **Render hook** in BOTH renderers: `layer.frame` → `frameOutlinePathD` → scale into the
  layer box → feed the existing clip-mask matte (DOM `mask-image` + SceneCompositor alpha matte).
  Empty frame (no asset) → placeholder (dashed outline + icon; NOT exported). **Pixel-gated.**
- Step 3 — **Effects-subpanel card**: an applied frame renders as a card with its param schema
  (roundness slider, sides, rotation…); edits write `layer.frame.params`.
- Step 4 — **Fill**: drop media onto the frame (reuse `onReplaceLayerAsset`) → assigns asset +
  auto-fit via `contentTransform`.
- Step 5 — **Frames section** in the Graphics search panel listing the built-ins; pick → adds an
  empty frame layer.

**Step 2 — render hook ✅ (2026-07-15).** A frame renders by becoming a native clip `Mask`, so it
rides the EXISTING pixel-gated mask pipeline — no new clip code, no new coordinate system.
- `frames.ts` → `frameClipMask(layer, comp)`: synthesizes a `Mask` inscribed in the comp box from
  `layer.frame` (rounded-rect → `rectangle`+cornerRadius, circle → `ellipse`, hexagon → `polygon`).
  Returns null for `svg-path`/`blob`/`torn-paper` (Phase 2 → media shows unclipped, never vanishes).
  Deterministic `frameMaskId(layerId)` keeps the DOM def and CSS ref in sync.
- Injected as the BASE (index-0) mask at the three mask seams, all shared so both renderers agree:
  `buildMaskDefsSvg` (DOM `<mask>` def), `getCompositionMaskCss` (DOM `mask-image` ref via
  `getCompositionMediaStyle`), and `SceneMaskMatteCache.get` (compositor alpha matte, with the layer
  transform baked in — the frame rides the clip like every media mask). The layer transform then
  scales/positions the framed media.
- Verified: `pnpm -r typecheck` all 5 clean; `frames:test` 26/26 (added `frameClipMask` mask-synthesis
  checks); `render:compare:pixels` regression (see below).
- NOTE: a dedicated framed-media render fixture is a follow-up; for now the frame reuses the exact
  mask path the masked-blur/masked-text fixtures already pixel-gate, so divergence risk is covered and
  the synthesizer is unit-tested. Real visual QA comes with Steps 3–5 (the UI to create a frame).

Step 2 pixel regression gate: ✅ **27/27** — the mask-pipeline injection broke nothing.

**Steps 3 + 5 — editable + pickable ✅ (2026-07-15).** A frame is now applyable and fully editable end
to end (media clips + live param edits), visible in-app:
- **Effects-subpanel card** (`FrameEffectCard.tsx`): when `layer.frame` is set, the Effects tab shows a
  "Frame" card rendering the FrameDefinition's param SCHEMA via the shared `NumberControl` (roundness
  slider, hexagon sides/rotation scrubs) + a Remove-frame button. Edits write `layer.frame.params` →
  the clip mask re-derives live. Nothing hardcoded — it renders whatever knobs the frame declares.
- **Frames section in the Graphics search panel** (new `Frames` chip alongside Photos/Videos/Graphics/
  Templates): tiles preview each built-in shape (unit-box `frameOutlinePathD` → SVG). Clicking a tile
  → `onApplyFrame` → `handleApplyFrame` sets `layer.frame = makeLayerFrame(def)` on the selected
  image/video clip (toast prompts to select a clip first). Orientation/quality filters hidden for it.

**Remaining Phase 1:**
- Step 4 — **empty-frame placeholder + drop-to-fill ✅ (2026-07-16)**: see the detailed note in the
  QA-round-5 "remaining Frames work" list below.
- Fuller Graphics-panel **sub-sectioning** (Used · Shapes · Vectors · GIFs · Frames) is its own task
  (the founder's broader vision); Phase 1 added the Frames chip.

Status: 🟢 Phase 1 COMPLETE (Steps 1–5, apply-to-selected + editable params + empty-placeholder/drop-to-fill,
pixel-safe). Also done: v1.5 QA rounds 1–5 + Convert-to-graphic (D4 / Step F). Remaining Frames work: Step E
(border — renderer, blocked on the pixel gate), Phase 2 (blob/torn-paper generators), Phase 3 (marketplace).

---

# Frames v1.5 — QA round 1 findings + plan (2026-07-15)

In-app QA confirmed the architecture works (media clips, params edit live) and surfaced five issues.

## Findings → ONE root cause

**The frame has no box of its own.** A media layer has NO width/height box: its box IS the whole
comp frame (16:9), positioned by `transform.scale`. `widthPercent`/`heightPercent` exist on
`TimelineLayer` but only feed SHAPE layers ([composition-style.ts:699](packages/shared/src/composition-style.ts#L699)) —
media ignores them. `frameClipMask` inscribes the shape in that comp box. Hence:

| Reported | Cause |
|---|---|
| "circle is not circle" | an ellipse inscribed in a **16:9** box IS an oval |
| "they are consuming the handles" | handles belong to the **media box** (= full comp frame), not the visible frame shape → they sit at the box corners, under/away from the media |
| "circle is with no adjustment" | `kimera.circle` has `params: []` — and can't have width/height while the frame owns no box |
| "rectangle should have width height" | same gap |
| "border, borderWidth, borderColor" | **different**: masks only CLIP. There is no stroke anywhere in the media render path → a border is a genuinely NEW render surface (both renderers, pixel gate). |
| "change to graphics + graphics color settings" | shape layers already own fill/stroke/width/height/radius/custom-path, rendered in both renderers ([text-shape.ts:530](packages/shared/src/scene/text-shape.ts#L530)) |

## Decisions (founder, 2026-07-15)

- **D1 — Frames own their FULL vocabulary.** Both tiers (generator params AND box/border chrome)
  are frame-native; nothing is shared with the shape-layer field names. Rationale accepted: complex
  frames (torn-paper, blob) will need their own vocab anyway, so the format stays self-contained and
  free to evolve without shape-layer coupling.
  - *Known cost, deliberately taken:* frame chrome and shape layers express the same concepts under
    different names → "convert to graphic" is a translation, not a field swap. **Containment rule:**
    that translation lives in exactly ONE place, `frameToShapeLayer()` in `frames.ts`. No other
    module may map frame↔shape fields. Drift stays in one reviewable table.
- **D4 — "Convert to graphic" is a TRUE, one-way conversion.** The layer BECOMES a `shape`
  (`layer.frame` dropped, media dropped, undoable) and fully inherits shape behaviour: the graphics
  panel, colour settings, shape keyframes, the shape renderer. One owner of the outline afterwards.
  `frameToShapeLayer()` maps to a NATIVE `shapeKind` wherever one exists — rounded-rect →
  `rounded-rectangle`+`borderRadius` (roundness stays a LIVE slider), circle → `ellipse` — and falls
  back to `pen`+`shapePath` (MaskPoint tangents carry curves) for exotic generators. So simple frames
  convert losslessly and stay parametric AS shapes; only `blob`/`torn-paper` bake (their
  `roughness`/`seed` freeze into a pen-editable path). Rejected: a live generator→shapePath link
  (two owners of one outline = permanent two-vocab coupling, exactly what D1's containment rule exists
  to prevent).
- **D2 — Handles resize the FRAME BOX**, and the selection box hugs the frame (not the media box).
- **D3 — Double-click the frame on canvas → content-reposition mode**: pan/zoom the media INSIDE
  the frame, mirroring the inspector's existing content/crop model (`contentTransform`).

## v1.5 model — frame-native param vocabulary

Every frame (built-in or pack) = **generator params** + **chrome params**, all frame-native keys.
Chrome is a shared SCHEMA FRAGMENT (`frameChromeParams`) merged into every definition at lookup, so
pack authors never redeclare it and even the most exotic frame gets a box + border for free.

```
TIER 1 — generator params (per definition, unbounded — where complexity lives)
  rounded-rect: { roundness }        polygon: { sides, rotation }
  torn-paper:   { roughness, seed, edges, grain }   blob: { points, seed, wobble }

TIER 2 — chrome params (frame-native names, same for EVERY frame)
  box:    width, height   (% of comp)   aspectLock (boolean)
  border: border (boolean), borderWidth (px), borderColor (color)
```

The param schema already supports `number | color | boolean | select` ([effects.ts:14](packages/shared/src/effects.ts#L14)),
so all of this renders through the existing schema-driven controls — still nothing hardcoded.

## Build order

- **Step A — the frame box ✅ (2026-07-15)** (fixes circle-not-circle, width/height, circle-has-no-params).
  `frameBoxRect(frame, comp)` → centered inscribed rect from `width`/`height` %, with `aspectLock`
  deriving the shorter side in **pixels** (so a circle stays a circle at ANY comp aspect).
  `frameClipMask` inscribes in that rect instead of the full comp box. Circle defaults
  `aspectLock: true`. Fixes two latent bugs: `LayerFrame.params` must accept `boolean`, and
  `frameParamDefaults` currently DROPS boolean defaults. Pure geometry → **no renderer change → pixel-safe.**
- **Step B — card renders every param type ✅ (2026-07-15)**, grouped Shape · Box (Border joins at
  Step E — knobs ship WITH their pixels, never dead controls). `frameParamSections` returns the
  grouping as DATA, so an imported pack frame groups itself. New shared `BooleanControl` renders the
  `boolean` param variant, which had no inspector control until now — built on the `PropertyRow` shell
  per that file's directive, so it lands on the same 24px baseline as every other row.
- **Step C — selection box hugs the frame; handles resize the box.** Reuse the existing
  `contentBoxSizeOverride` hook ([VideoPreview.tsx:4453](apps/web/src/components/VideoPreview.tsx#L4453))
  that already makes handles hug `contain` media; resize routing writes frame `width`/`height`
  (honouring `aspectLock`). **Fixes "consuming the handles".**
- **Step D — double-click → content mode** (D3): drag pans / wheel zooms the media inside the frame
  via `contentTransform`; Esc or click-out exits.
- **Step E — border render** — the ONLY step touching renderers: stroke the frame outline in the DOM
  preview AND the SceneCompositor. Requires a **new framed-media pixel fixture** + gate.
- **Step F — Convert to graphic**: framed media layer → `shape` layer carrying the outline
  (`shapePath`) + colors, via the single `frameToShapeLayer()` table (D1). Inherits the shape
  layer's existing color settings for free.

Then resume Phase 1 **Step 4** (empty placeholder + drop-to-fill), which lands naturally after C.

## Steps A + B — what shipped (2026-07-15)

- `frames.ts`: `frameChromeParams` (Tier 2: `width`/`height`/`aspectLock`, frame-native names per D1),
  `frameParamSchema` (own params + chrome; a pack **cannot shadow** a chrome key — chrome semantics
  stay identical across every frame), `frameParamSections` (Shape · Box grouping as data),
  `FrameDefinition.chromeDefaults` (per-frame box defaults without redeclaring the schema),
  `frameBoxRect` (centered inscribed rect; `aspectLock` squares it in **pixels**), `frameEffectiveParams`.
- `frameClipMask` now inscribes in `frameBoxRect` instead of the full comp box. **This is the
  circle fix**: Circle + Hexagon ship `chromeDefaults: { aspectLock: true }` (an N-gon is only regular
  in a square box), so they're round/regular at 16:9, 9:16 AND 1:1 — no per-format special-casing.
- **Two latent bugs fixed:** `LayerFrame.params` was typed `number | string`, so `frameParamDefaults`
  silently DROPPED boolean defaults — `aspectLock` would have vanished on apply. Now `FrameParamValue`
  includes `boolean` and defaults are taken as-is.
- **Back-compat:** stored params are an OVERRIDE layer over the definition (`frameEffectiveParams`),
  not a replacement. A circle saved during QA round 1 (`params: {}`) inherits `aspectLock` and
  **self-heals to a circle** — no migration. Also future-proofs pack versioning (a param added in a
  later pack version resolves for frames already on a timeline) and keeps uninstalled-pack frames rendering.
- Verified: `pnpm -r typecheck` 5/5 clean (at 10:26, against frames.ts + FrameEffectCard changes);
  `frames:test` **50/50**.
- ✅ **Pixel gate GREEN (2026-07-16): 27/27, 0.000%.** The blocking `graphicIsAnimated` duplicate was
  resolved by the other agent; `pnpm -r typecheck` now passes all 5 packages and the gate runs clean. All
  Frames work through QA round 4 (pure mask geometry + inspector UI + preview interaction, no renderer
  change) is confirmed to have broken nothing. The gate is unblocked for Step E (border).

## QA round 2 (2026-07-15) — the fields lied

Reported: with aspectLock on, the Width/Height fields didn't update; and their reset buttons "did nothing".

**One root cause, two symptoms.** `aspectLock` squared the box at RENDER time (`frameBoxRect`) and never
told the params — so a locked circle stored `width: 100, height: 100` while really occupying 56.25% × 100%
of a 16:9 comp. The fields showed the STORED params, so they read 100/100 against a square canvas shape.
Reset then wrote `100` over a field already reading `100` → no state change → the button looked dead.
(`ScrubNumberInput` was fine — it's properly controlled; it was faithfully rendering a wrong number.)

**Fix — the inspector shows the EFFECTIVE box, and the axes are linked:**
- `frameBoxPercent(frame, comp)` — the box as % of the comp, derived from `frameBoxRect`. The fields render
  this, so they can never disagree with the canvas (also self-corrects after a comp reframe, no re-bake).
- `setFrameBoxAxis(frame, axis, %, comp)` — writes BOTH axes while locked, so the square follows the drag.
  Required because `frameBoxRect` takes the `min` of the two: without moving the partner, dragging Width
  past the cap would do nothing. When a square can't fit (100% width needs 177% height at 16:9) the partner
  clamps at 100 and the field **snaps back to the largest square that fits** — honest, not silently held.
- `FrameEffectCard` takes `comp` (already a `LayerInspector` prop) and routes width/height through these.
- Verified: web typecheck clean; `frames:test` **62/62** (12 new: effective-%, linked axes, square-in-pixels
  after edit, unlocked partner untouched, over-large clamp, 9:16 constrained axis).

## Steps C + D ✅ (2026-07-15) — handles + content mode

**Step C — handles resize the FRAME box** (fixes QA round 1's "they are consuming the handles"):
- Selection box hugs the frame: `contentBoxSizeOverride` returns `frameBoxPercent` for a framed layer,
  reusing the SAME hook that already makes handles hug `contain` media. (It only needs the comp ASPECT —
  the percentages are scale-invariant — so the layer needs no comp pixel dims.)
- All handles route to the frame box for framed media (never fall through to crop/scale).
  `frameResizeAxisFromHandle` → E/W = "x", N/S = "y", corners = "both", so an EDGE handle moves only its
  own axis instead of shearing. `setFrameBoxFromResize` (shared, tested) owns the rule: with aspectLock the
  square follows the axis actually dragged, corners take the larger extent.
- `frameSizeFromResize` divides out the layer's evaluated SCALE (unlike `shapeSizeFromResize`): the frame
  box is a % of the COMP but renders through the layer transform, so without it a scaled framed clip's
  resize would run away from the pointer.
- The canvas and the inspector fields go through the same shared geometry → they cannot disagree.

**Step D — double-click → content mode** (D3): double-click a framed clip to reposition the media INSIDE
the frame; drag pans, wheel zooms, Escape (or selecting another clip) exits. Writes the same `content.*`
properties the inspector's Content/Crop panel writes, via `applyContentValueAtTime` → auto-keyframe behaves
identically on canvas and in the panel. Box goes dashed/accented (`.is-content-mode`) so it's visible why
dragging stopped moving the clip.

## QA round 3 — "width and height should be the same when locked"

**They already were — in pixels.** Reported as `Width 29 / Height 51` with Lock Aspect on. Reproduced:
`setFrameBoxAxis(height=51)` → stored `width: 28.6875%, height: 51%` → box **550.800 × 550.800 px, exactly
square**. The numbers differed because `width` is a % of the comp's WIDTH and `height` a % of its HEIGHT —
two different rulers (51/29 ≈ 16/9 = the comp aspect). Geometry correct, **units wrong**.

**Fix:** the Box fields now display **pixels** (one ruler, like Canva/Figma/Premiere), so a locked square
reads 551 / 551. Display-only — params stay percentages, which is what keeps a frame resolution-independent
across a reframe. Pinned by 3 regression checks reproducing the exact reported case.

Verified: web typecheck clean; `frames:test` **74/74**. No renderer touched (Steps C/D are preview
interaction + inspector display; the clip mask is unchanged) → still pixel-safe.

## QA round 4 (2026-07-15) — content-mode axis + the REAL handle cause

- **Content pan inverted on Y** — fixed. The compositor samples
  `mediaUv = (v_uv - 0.5 - uContentPan) * uFitScale + 0.5` with `v_uv` **Y-UP** (its crop test reads
  `v_uv.y > 1 - cropTop` for the TOP edge), so a POSITIVE `offsetY` moves the media UP — the opposite of
  screen Y. `contentOffsetFromPan` now negates the Y delta. (`build-scene-draws.ts` is the ONLY consumer
  of content pan, so there is exactly one convention to honour.)
- **"Handles are not visible at all… only right and lower right" — THE ROOT CAUSE, finally.**
  `selectionOverlayStyle` copies the clip's geometry style and strips appearance props (background,
  opacity, filter, blend…) but **not the mask properties**. So the selection box inherited the clip's
  `mask-image` — i.e. **the frame was masking away its own selection chrome.** Handles on the shape's edge
  were cut in half; handles outside it vanished. Only those landing inside the shape survived (the reported
  right / lower-right). Fixed by also stripping `maskImage`/`maskRepeat`/`WebkitMask*` — UI chrome must
  never inherit the content's mask.
  **This — not the box size — was the original QA-round-1 "they are consuming the handles".** Step C's
  box-hugging is still right (handles should hug the visible frame), but it was treating a symptom; the
  mask inheritance was the disease. It would have bitten hand-drawn clip masks too, not just Frames.

**Still open from this round:** content mode should show the ENTIRE clip with the area OUTSIDE the frame
faded to a very light opacity (so you can see what you're panning into view). NOT done — it isn't a CSS
tweak: media paints through the GPU scene compositor (single-ctx preview is default-ON), and the frame
clip is baked into the compositor's alpha matte. Needs the frame mask suppressed in the matte for the
content-mode layer only (e.g. feed `{...layer, frame: undefined}` into the scene layers) plus an
editor-only scrim overlay that dims outside the frame path (SVG rect + path, `fill-rule: evenodd`).
Editor-only, no export impact — but it is real compositor plumbing, so it gets its own change.

## QA round 5 — content mode: pan speed + handles must hug the source

- **Pan was 2× too slow** — FIXED. `build-scene-draws` maps `offsetX/Y (-1..1 frame fractions) → pan ±0.5
  frame` (`pan: [ct.offsetX * 0.5, …]`) before it reaches `uContentPan`, so an offset of 1 shifts only HALF
  a frame. `contentOffsetFromPan` now doubles the frame-fraction delta → the media tracks the pointer 1:1.
- **Handles don't hug the source clip inside the frame** — FIXED (see "what shipped" below). In content mode
  the box falls back to the clip's `contain` rect, which ignores `content.scale`/`offset`, so it neither
  shrinks on zoom nor follows a pan.
  **Spec (derived from the compositor, not guessed):** `fitVec = baseFit / content.scale` and
  `mediaUv = (v_uv - 0.5 - pan) * fitVec + 0.5`. Inverting → the media occupies, in LAYER-BOX fractions:
  - size: `width = 1 / fitVec.x`, `height = 1 / fitVec.y`
  - centre: `0.5 + pan` (i.e. offset from the layer centre = `pan` = `offset * 0.5`)
  `baseFit = fitScale(sw, sh, w, h, layer.fit)` needs the SOURCE dims — the layer component already measures
  `sourceAspect`, so the aspect suffices.
  **Blocker:** `boxOverride` only carries `{ width, height }` — there is no POSITION channel, so the box
  can't follow a pan. It needs a third field (a centre offset applied as a translate AFTER the layer's own
  transform, so it lands in the clip's rotated/scaled local space, which is where content pan lives).
  Worth doing properly — it's the difference between handles that describe the media and handles that lie.
- **Snap the source to the frame's edges** — FIXED for panning (see "what shipped"); the corner content-zoom
  snap is deferred. Snap while panning when a media edge meets a frame edge (and at centre), with the classic
  escape: snapping only engages within a small screen-px threshold, so a deliberate drag past it still wins.

### D5 — the faded-outside overlay is DROPPED (founder call 2026-07-15)

Content mode shows the source clip as an **outline + handles**, not a dimmed reveal of the whole clip.
Rationale: the fade's PURPOSE was "the user can't tell whether the source is actually touching the frame" —
an outline that hugs the media plus a snap at the frame edges answers that **directly** (you see the rect and
feel the snap), where the fade only let you infer it. And the cost is lopsided: hug+snap are editor-only and
pixel-safe, while the fade was the ONLY item here needing the frame mask suppressed in the GPU compositor
matte (single-ctx preview is default-ON, so the hidden pixels don't exist in the DOM) plus a scrim overlay.
Most invasive thing on the list, for a need the cheap fixes already meet. Revisit only if QA shows the
outline isn't enough.

### D6 — frame handles scale the CLIP too; content mode scales only the clip (founder call 2026-07-15)

Today a frame resize changes the box ONLY: the media stays put, so shrinking the frame just masks more of it.
The founder wants the frame handles to behave like a GROUP scale — frame + inner clip together — with
content mode as the drill-in that scales the media alone.

| Gesture | Frame box | Source clip |
| --- | --- | --- |
| Frame handle — corner | resizes | **scales with it** (group) |
| Frame handle — edge (N/E/S/W) | resizes that axis | unchanged (reveals/hides) — see below |
| Double-click (content mode) | untouched | scales / pans alone |

**Why edges are excluded from the group scale — flag for review.** `content.scale` is a single UNIFORM
scalar (the compositor folds it into `fitVec` on both axes), but an edge handle changes ONE axis. There is
no way to express "stretch the media horizontally only", so an edge drag would have to scale the media on an
axis the user never touched. Cleanest reading: corners = group scale (uniform, unambiguous — both axes move
by the same pixel factor, especially under `aspectLock`), edges = reframe the box against a fixed media
(which is exactly the "reveal/hide" that makes a frame a frame). **If the founder wants edges to group-scale
too, that needs a non-uniform content scale (`content.scaleX/scaleY`) — a new field in
`LayerContentTransform` + the compositor shader, i.e. renderer work + a pixel gate. Ask before assuming.**

**Mapping (corners):** on a frame resize from side `S0` → `S1` (pixels), `content.scale *= S1 / S0`, so the
media keeps its relative coverage of the frame. Under `aspectLock` both axes share one factor → exact.
Unlocked corners: use the same factor the box itself took, so the media tracks the drag.

### Locked plan — QA round 5 (build in this order)

**Everything below is editor-only: no renderer touched, no pixel-gate exposure.**

1. **`mediaRectInFrame` (shared, pure, unit-tested)** — THE single source of truth for where the media
   actually sits:
   ```
   mediaRectInFrame({ sourceAspect, fit, contentScale, contentOffset }, frameBox)
     → { x, y, width, height }   // layer-box fractions
   ```
   Derived from the compositor mapping (`fitVec = baseFit / content.scale`;
   `mediaUv = (v_uv - 0.5 - pan) * fitVec + 0.5`; `pan = offset * 0.5`) → size `1/fitVec`, centre `0.5 + pan`.
   Both consumers below read it, so the outline and the snap can never disagree about the same rect.
2. **Hug (outline + handles)** — feed it to `boxOverride`, which must gain a POSITION channel (today it's
   `{ width, height }` only, so the box cannot follow a pan). Apply the centre offset as a `translate`
   APPENDED after the layer's transform: CSS applies transforms right-to-left, so appending puts it
   innermost = the clip's pre-rotation local space, which is where content pan lives → rotation/scale come
   for free. Gotcha: CSS `translate` percentages resolve against the element's OWN size, so convert the pan
   fraction from layer-box units to box-own units.
3. **Snap** — compare the rect's edges to the frame box; engage within ~6 **SCREEN** px (not comp px, so it
   feels identical at any viewer zoom); snap edges + centre; keep dragging to break out. Applies to both the
   pan drag and the corner content-zoom.
4. **D6 group scale** — corner frame-handle drags also multiply `content.scale` by the box's pixel factor.
   Lands in `setFrameBoxFromResize`'s caller (`handlePreviewResizeFrameLayer`), which already has both the
   old and new box: it must write `frame.params` AND `content.scale` in ONE updater, or a live drag would
   commit them as two separate history entries and could tear mid-drag.

### QA round 5 — what shipped (2026-07-16)

Steps 1, 2, 4 done + pan-snap (step 3); the corner-content-zoom snap is the one deferred sub-item.

- **Step 1 — `mediaRectInFrame` (shared, pure).** Inverts the compositor mapping to the rect the SOURCE
  media occupies, in comp (= media layer-box) fractions, SCREEN space (y-down): size `contentScale/baseFit`,
  centre `(0.5 + offsetX·0.5, 0.5 − offsetY·0.5)` (the Y flip is the compositor's Y-UP `v_uv`). **Correction
  vs the locked spec:** the media fits the COMP, not the frame box (the frame is only a clip mask, and
  `fitScale` uses the comp draw dims), so the frame box does NOT enter the rect — it's the reference the snap
  compares to, not an input. `fitScale` reduces to a ratio of the two ASPECTS, so
  `mediaRectInFrame` needs `sourceAspect` + `compAspect` (both already measured), not pixel dims. Also added
  `snapMediaRectToBox` (edges + centre, pure) and `frameGroupScaleFactor` (D6, geometric-mean of the two
  axis factors — preserves AREA coverage under a non-uniform corner). All unit-tested.
- **Step 2 — hug.** `boxOverride` gained a `translate` channel. In content mode `contentBoxSizeOverride`
  now returns the media rect's size (can exceed 100% for cover/zoom — correct: the handles describe media
  bigger than the frame) + a `translate` APPENDED to the layer transform (innermost = the clip's
  pre-rotation local space; the media layer's transform is always `translate3d(-50%,-50%) rotate scale`, so
  scale/rotation carry the pan for free). The pan fraction is divided by the box size → box-own-size units,
  per the CSS-% gotcha. Applied via the `transform` string (NOT the `translate` CSS prop, which resolves
  OUTSIDE `transform`).
- **Step 3 — pan snap.** `snapContentOffset` in the content-pan handler converts a fixed ~6 **screen-px**
  threshold → comp fractions (`6 / (surface·layerScale)`), runs `snapMediaRectToBox`, and maps the rect
  shift back to an offset delta (`Δoffset = 2·Δcentre`, y screen-flipped). Deferred: snapping the corner
  content-ZOOM (adjusting `content.scale` so an edge clicks onto the frame) — genuinely harder (offset-
  dependent solve) and not visually verifiable here, so it wasn't shipped blind. The hug outline + pan snap
  already answer "is the source covering the frame"; revisit if QA shows the zoom needs it too.
- **Step 4 — D6 group scale.** A CORNER frame-handle drag now also multiplies `content.scale` by
  `frameGroupScaleFactor` in the SAME updater as the box params (one history entry). The per-drag factor
  telescopes across a live drag because each fire's box is absolute (`gm(a→b)·gm(b→c) = gm(a→c)`). Edges are
  excluded (uniform `content.scale` can't stretch one axis — the flagged D6 limitation). Written as a BASE
  content edit (the frame box isn't keyframeable).
- Verified: `pnpm -r typecheck` all 5 clean; `frames:test` **88/88** (+14: media-rect fit/zoom/pan/Y-flip,
  snap edges+centre+threshold, D6 uniform/non-uniform/degenerate). Editor-only, no renderer touched → still
  pixel-safe. **On-canvas visual QA (drag/zoom/snap feel) is the user's to run** — pure geometry is unit-
  pinned but the interaction can't be driven headlessly here.

### Then — remaining Frames work, in order

- **Step F — Convert to graphic (D4) ✅ (2026-07-16).** A framed media layer converts to a native `shape`
  through the ONE `frameToShapeLayer()` table in `frames.ts` (D1 containment — no other module maps
  frame↔shape fields). Native `shapeKind` where one exists so simple frames stay parametric: rounded-rect →
  `rounded-rectangle` + `borderRadius` (roundness → the same half-min-side px `frameClipMask` uses, so it
  looks identical), circle → `ellipse`; polygon → `pen` + `shapePath` (vertices in 0..100 shape-box coords,
  same orientation as `polygonPathD`); `svg-path`/`blob`/`torn-paper` → `rectangle` (their honest current
  visual — they don't clip yet). One-way + undoable: `frame` and every media-only field (`assetId`,
  `content`, `fit`, `matte`) are dropped and the shape adopts its own fill/stroke, after which the colour
  panel / shape keyframes / shape renderer own it. Box carries over as `widthPercent`/`heightPercent` (the
  EFFECTIVE box %, so an aspectLock circle stays round). UI: a "Convert to graphic" button (Shapes icon)
  beside Remove in the Effects-subpanel frame card — it's just an `onChange` updater, so no new plumbing.
  Verified: `pnpm -r typecheck` all 5 clean; `frames:test` **100/100** (+12: each generator's mapping,
  one-way drop, identity preserved, aspectLock box %). Editor-only → pixel-safe.
- **Step E — Border** (`border` / `borderWidth` / `borderColor`): the ONLY renderer work. Needs a stroke pass
  in BOTH the DOM preview and the SceneCompositor + a NEW framed-media pixel fixture. **BLOCKED** until the
  gate can run (see the `graphicIsAnimated` duplicate above) — do not land it on an unverifiable gate.
- **Phase 1 Step 4 — empty-frame placeholder + drop-to-fill ✅ (2026-07-16).** Picking a frame with no
  image/video selected now drops an EMPTY placeholder (an `image` layer with `frame` set and no `assetId`,
  `fit: "cover"`) instead of erroring. `VideoPreview` renders it as a dashed outline in the frame's actual
  SHAPE (`frameOutlinePathD` scaled into the `frameBoxPercent` box) + an "Add media" affordance; a
  double-click or the hint opens the asset picker bound to that layer (new `onRequestFillFrame` →
  `handleReplaceLayerAsset`). Filling reuses the existing replace flow, which already preserves `layer.frame`
  and now force-fits `cover` for framed clips (so the media fills the shape with no gaps — the "auto-fit").
  **Not exported, for free:** a no-asset layer resolves to no source, so BOTH renderers already draw nothing
  (web scene compositor returns null at the `providerKey` guard; the Remotion `ImageGrabber`/`VideoGrabber`
  bail on missing `assetUrl`) — verified by reading both guards, no exclusion code needed. Verified: `pnpm -r
  typecheck` all 5 clean; `frames:test` 100/100 (unchanged — Step 4 is editor wiring, not shared geometry).
  **On-canvas QA (placeholder look, drop-to-fill) is the user's to run.**
  - **Fix (2026-07-16, QA): the placeholder painted a black "asset-not-found" frame-shaped box.** TWO roots,
    both cured (not the symptom): (1) my container reused the `.preview-empty-frame` CLASS, which already
    exists as the empty-COMPOSITION backdrop (`background: #161618; inset: 0`) — later in the cascade, so it
    overrode my transparent, and since the container style came from `getCompositionMediaStyle` (which carries
    the frame `mask-image`) that dark fill got clipped to the frame → the black shape. Renamed my classes to
    `.preview-frame-slot*` and now strip the mask/background off the container via `selectionOverlayStyle`
    (geometry only — the SVG draws the shape). (2) `sceneMediaIds` added EVERY image/video to the scene
    compositor, so the sourceless slot was also composited as black; empty-frame placeholders
    (`isEmptyFramePlaceholder`) are now excluded from the scene, matching the export (both already draw
    nothing for a no-source layer). Also enlarged the "Add media" hint (was tiny) + counter-scaled it so it
    stays readable at any frame scale. Outline + selection box both read `frameBoxPercent`, so they hug.
- **Handle gesture model (founder call, 2026-07-16): corner = PROPORTIONAL, edge = single-axis.** Previously
  an aspect-unlocked CORNER moved both axes independently (distorting the frame). Now a corner is a uniform
  scale that preserves the box's pixel aspect (`setFrameBoxFromResize` axis `"both"` scales both percentages
  by one factor, driven by the pointer-dominant axis, clamping the FACTOR so both stay in [1,100] with the
  ratio intact); edges (already single-axis) are the deliberate way to change proportions. `aspectLock`
  shapes (circle/hexagon) still keep every handle square (an edge can't make an oval circle). Bonus: this
  makes D6's group scale EXACT — corners are now truly uniform, so `frameGroupScaleFactor`'s geometric-mean
  is only a safety fallback, never hit in practice. `frames:test` 102/102.
- **Phase 2** — shape library: real `blob` / `torn-paper` generators (they currently return null from
  `frameClipMask` → media shows unclipped). This is the "advanced shapes" half of the end goal.
- **Phase 3** — `frame-pack` marketplace manifest + import.
- **Graphics panel sub-sectioning** — Used · Shapes · Vectors · GIFs · Frames.
- **Animated GIFs** — explicitly after Frames.

Still open from QA round 1 → **Step E** (border — the only renderer work). Step F (convert to graphic) ✅ 2026-07-16.

## Inspector default height (founder call 2026-07-15)

The Inspector now opens **full height**; half is the opt-in toggle (Alt+R) — editors spend most of their
time in property edits. `inspectorExpanded` defaults `true`, BUT the layout classes are gated on a new
`inspectorFullHeight = inspectorExpanded && !inspectorCollapsed`: the Inspector starts COLLAPSED, and
`is-any-expanded` re-lays the whole editor (`.editor-main` → `display: contents`, dropping the viewer's
260px min-height and the panels' min-widths). Without the gate, the new default would have applied that
layout on first load for a panel that isn't even mounted. Height intent is remembered while collapsed;
it just doesn't distort the grid until the panel is open. (`.is-any-expanded.is-inspector-collapsed`
stays reachable via the LEFT panel, so no CSS was orphaned.)
