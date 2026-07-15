# Graphics Tab — Essential Graphics Plan

Living planning doc for expanding the inspector **Graphics** tab toward a real
Essential-Graphics surface. Grounded against Premiere v25's EGP (reference
screenshots reviewed 2026-07-14) and our actual code — **not** assumptions.

**How to use this doc:** each feature has a `Decisions` block with open forks.
We resolve forks here *before* building, then record the choice inline. Nothing
in here is committed scope until the fork is marked **DECIDED**.

Status legend: 🔲 not started · 🟡 in progress · ✅ shipped · ⏸ deferred

---

## 0. Where we are today

Current Graphics tab (assembled in [EditorPage.tsx:11348](apps/web/src/pages/EditorPage.tsx#L11348)):

1. **Layers** — stack of text/shape/vector layers in draw order; select, show/hide, rename
   ([GraphicsStackPanel.tsx](apps/web/src/editor/inspector/panels/GraphicsStackPanel.tsx))
2. **Align** — 6 align-*to-frame* buttons
   ([GraphicsAlignPanel.tsx](apps/web/src/editor/inspector/panels/GraphicsAlignPanel.tsx))
3. **Graphic** — vector fill color, only when `layer.graphic` exists
4. **Template slot** — mark layer user-replaceable ([EditorPage.tsx:8022](apps/web/src/pages/EditorPage.tsx#L8022))

Design intent (from [InspectorTabs.tsx](apps/web/src/editor/inspector/InspectorTabs.tsx)):
Graphics = the EGP surface (layer stack, align, vector props) for every visual
layer type. Font/fill/stroke/shadow/warp deliberately live in the **Text** tab,
**not** here. Color grading stays in the left panel's Color tab (one color surface).

### Grounded data-model facts (drive every option below)
- `TimelineTransform = { position, scale, rotation }` — **single uniform scale, no
  anchor point, no opacity field** ([types.ts:243](packages/shared/src/types.ts#L243)).
- `TimelineLayer.locked` and `TimelineLayer.linkedGroupId` **already exist**
  ([types.ts:681-682](packages/shared/src/types.ts#L681)).
- `TimelineLayer.slot` (template slot) already exists ([types.ts:691](packages/shared/src/types.ts#L691)).
- Compound clips / **Canvas Frames already exist** (`isFrame`, `nestedCompositionId`)
  ([types.ts:598-604](packages/shared/src/types.ts#L598)).
- A **global** `resizeBehavior: "keep-layout" | "scale-visuals"` already exists at
  the composition viewport level ([types.ts:768](packages/shared/src/types.ts#L768)).
- Layer draw order derives from **track order** (`tracks[0]` renders on top),
  see [GraphicsStackPanel.tsx:19](apps/web/src/editor/inspector/panels/GraphicsStackPanel.tsx#L19).

### The one hard rule
**The render manifest is the product contract.** Anything that changes geometry
or resolves at render time MUST land in *both* [VideoPreview.tsx](apps/web/src/components/VideoPreview.tsx)
(web preview) and [Root.tsx](apps/worker/src/remotion/Root.tsx) (Remotion), or
exports drift from the editor. Verify with `pnpm render:compare:pixels`. Features
below are tagged by whether they cross this line.

---

## 1. Responsive Pin (Position)

Per-layer rule for how a layer repositions/scales when the frame is reframed
(16:9 → 9:16) or resized. Highest template/multi-aspect payoff. **Crosses the
render-manifest line.**

Context: we already have a *global* `resizeBehavior` switch — so this is a
per-layer refinement, not greenfield.

### Behavior options (ascending cost)
- **A — Pin to frame edges:** pin left/right/top/bottom/center; painted box stays
  glued to chosen edges on reframe. Reuses `contentFractions()` math already in
  [GraphicsAlignPanel.tsx:30](apps/web/src/editor/inspector/panels/GraphicsAlignPanel.tsx#L30).
- **B — Pin + scale:** pin two opposing edges → layer stretches with the frame.
  Requires **non-uniform scale**, which our transform does not have.
- **C — Pin to another layer:** reflow relative to a sibling (Premiere "Pin To: [layer]").
  Most powerful; needs an inter-layer dependency/order resolve.

### Cost
- **Data model:** additive `responsive?: { pinTo; edges }` on `TimelineLayer`. No migration.
  Option B additionally forces `scaleX/scaleY` into the transform model (real ripple).
- **Renderer:** pin resolves at render time against actual output dims in **both**
  renderers. The genuinely architectural item in this doc.

### Decisions (DECIDED 2026-07-15)
1. **Per-layer pin** (additive `responsive` on TimelineLayer). The global
   `resizeBehavior` stays as-is (it is currently a no-op — stored, consumed nowhere).
2. **Scope A only** — pin the painted box to frame edges/center. **No** non-uniform
   scale (B deferred; keeps the uniform-scale transform model intact).
3. **Pin-to-layer (C) deferred.**
4. **Resolve time = BAKE AT REFRAME (editor-side), NOT render-time.** This is the
   pivotal call. Because positions are already plain percentages that BOTH renderers
   consume identically, we reflow pinned layers' `transform.position` the moment the
   viewport dims change (in `updateCompositionSettings`). The manifest keeps plain
   percents; **neither VideoPreview nor Root.tsx changes** → zero pixel-gate divergence
   risk. Trade-off accepted: one manifest = one baked set of positions (no live
   multi-aspect from a single manifest — revisit render-time resolve if templates ever
   need simultaneous multi-aspect export).

### §1 BUILD SPEC (locked 2026-07-15)

**Grounding facts that shape the design:**
- `getCompositionTransform` returns `x`/`y` as **percent** (0..100); renderers apply
  `left:x% / top:y%`. Position is frame-relative already.
- `resizeBehavior` is **dead** today — `applyCompositionSettings`
  ([EditorPage.tsx:8371](apps/web/src/pages/EditorPage.tsx#L8371)) rewrites width/height
  only, never touches layers.
- `paintedBoxAt` ([graphicsAlignGeometry.ts:84](apps/web/src/editor/inspector/panels/graphicsAlignGeometry.ts#L84))
  gives the box center+size in percent (`w = frac × scale × 100`), and — critically —
  **frac depends on comp dims** for the cases pinning actually helps: contain-fit media
  (aspect box flips with frame aspect) and text height (absolute `fontSize` px ÷ frame
  height). Shape/text-width are %-of-frame → their box % is frame-invariant → pins are
  natural no-ops there (correct, not a bug).

**Data model** (`packages/shared`, additive, no migration):
- `LayerResponsivePin = { x?: "left"|"center"|"right"; y?: "top"|"center"|"bottom" }`.
- `TimelineLayer.responsive?: LayerResponsivePin`. Absent / all-center = today's exact
  behavior (center held at constant %).

**Pure resolver** (`packages/shared/src/responsive-pin.ts`, unit-tested):
```
reflowPinnedCenter(pin, boxOld:{cx,cy,w,h}, sizeNew:{w,h}): { x:number; y:number }
```
Per axis (X shown; Y analogous with top/bottom):
- `x:"center"` (or unset) → `x = boxOld.cx` (unchanged — backward compatible).
- `x:"left"`  → hold left edge %: `x = (boxOld.cx - boxOld.w/2) + sizeNew.w/2`.
- `x:"right"` → hold right edge %: `x = (boxOld.cx + boxOld.w/2) - sizeNew.w/2`.
Holds the pinned EDGE's percent constant while the box takes its natural NEW-frame size.

**Reflow driver** (web, `graphicsReflow.ts`): `reflowCompositionForResize(nextComp,
oldDims, currentTime)` — for each TOP-LEVEL layer (no recursion into groups; a nested
comp's own dims are unchanged) with a non-center pin:
- `boxOld = paintedBoxAt(layer, oldDims, t)`, `sizeNew = paintedBoxAt(layer, nextDims, t)`
  (nextComp already carries new dims), `→ reflowPinnedCenter → write transform.position`.
- **Skip** layers whose position is keyframed (`getTransformKeyframes(...position.x/y)`
  non-empty) — baking one center would flatten the animation; v1 leaves animated-position
  layers as-is. **Applies regardless of `locked`** (lock blocks USER edits, not structural
  reframe). Center/center layers are untouched.

**Hook point:** `updateCompositionSettings`
([EditorPage.tsx:2692](apps/web/src/pages/EditorPage.tsx#L2692)) — the single funnel every
settings change (preset buttons + custom W/H inputs) passes through. Reflow ONLY when
`nextComposition.{width,height}` differ from the old comp dims.

**UI — Graphics tab, new "Responsive" section** (layout concern → Graphics owns it, next
to Align): a **3×3 anchor grid** (AE/Figma-style). Each cell sets `{x,y}`; center cell
clears the pin. Mirrors Align's multi-select semantics — applies to all selected graphic
layers via `onChangeLayers` in one undo; single selection via `onChange`. Indeterminate
when the selection's pins differ. A one-line hint: "Anchors this layer when the canvas
size changes."

**Testing:** `responsivePin.test.ts` (web `pin:test` script) — pure `reflowPinnedCenter`
cases (center no-op; left holds left edge; right holds right edge; 16:9→9:16 contain-media
numbers; text Y with absolute fontSize) + a `reflowCompositionForResize` integration case.
Plus: full `-r typecheck`, and one `render:compare:pixels` run to CONFIRM renderers are
untouched (must stay green — no manifest geometry change).

### §1 BUILD RESULT (2026-07-15)

Built exactly to spec (bake-at-reframe, Scope A, per-layer).

**Shared (additive, no migration):**
- `LayerResponsivePin { x?: PinX; y?: PinY }` + `TimelineLayer.responsive?`
  ([types.ts](packages/shared/src/types.ts)).
- `responsive-pin.ts` — pure `reflowPinnedCenter(pin, boxOld, sizeNew)` + `pinIsActive`.
  Holds the pinned edge's percent constant; center/unset = unchanged (backward compatible).
  Barrel-exported.

**Web:**
- `graphicsReflow.ts` — `reflowCompositionForResize(nextComp, oldDims, currentTime)`:
  top-level layers only, skips keyframed-position axes, applies regardless of lock,
  identity-returns when nothing moved. Uses `paintedBoxAt` (old dims vs new dims).
- Hooked into `updateCompositionSettings` — reflow ONLY when width/height changed.
- `GraphicsPinPanel.tsx` — 3×3 anchor grid in the Graphics tab (collapsible "Responsive"
  section, after Align). Mirrors Align's multi-select semantics (`onChangeLayers`, one
  undo); center/center clears the pin; indeterminate when selection pins differ. Hint line.
- `global.css` — pin-grid styles.

**NO renderer files touched** — VideoPreview.tsx / Root.tsx unchanged (positions stay
plain percents). This is why the manifest contract holds without render-time pin logic.

**Verification:**
- `pnpm -r typecheck` — all 5 packages clean.
- `pin:test` — 17/17 (reflow math: center no-op, left/right edge-hold, top/bottom,
  stable-size no-shift; driver: unpinned identity, frame-relative shape unchanged,
  keyframed-X not baked). `graphics:align:test` 20/20 + `text-style:test` 11/11 (no regression).
- `render:compare:pixels` — ✅ **27/27, 0.000–0.001%** — renderers confirmed untouched
  (preview↔Remotion parity held; no manifest geometry change, as designed).

Status: ✅ SHIPPED — built, auto-tested, pixel-gated (27/27), user-verified in-app 2026-07-15.

### §1 QA STEPS (for the user)
1. Add a **text lower-third** near the bottom; in Graphics tab → **Responsive**, click
   the **bottom-center** cell. Project Settings → switch canvas **16:9 → 9:16**. The
   lower-third should keep its **bottom margin** (not drift up/overflow). Switch back → returns.
2. Add a **logo image (fit: contain)** top-right; pin **top-right**. Reframe 16:9 → 9:16 →
   stays hugging the top-right corner.
3. **Center cell** (default) on any layer → reframe → behaves exactly as before
   (proportional). Confirms backward compatibility.
4. **Multi-select** 2–3 graphics → set a pin → all get it in ONE undo; ⌘Z reverts together.
5. **Keyframed position** layer with a pin → reframe → its animation is NOT flattened
   (position keyframes untouched).
6. A **locked** layer with a pin still re-anchors on reframe (lock blocks user edits, not
   structural reframe).

---

## 2. Text Styles (Master Styles)

A named text look (font/fill/stroke/shadow) saved once, applied to many layers.

GROUNDING CORRECTION (2026-07-14): the **Brand tab is only asset *files* today**
(logos/watermarks/fonts) — `brand` is an `AssetSource` category
([types.ts:49](packages/shared/src/types.ts#L49)), NOT a structured colors/styles
kit. So a brand-sourced style would be net-new user-level data, not free. A "style"
IS just a bundle of fields already on `TimelineLayer`.

### Decisions (DECIDED 2026-07-14)
1. **One-shot apply (bake), NOT linked.** Applying a style copies its field values
   onto the selected text layer(s); no `styleId` link, no live update. → **zero
   renderer change, no per-layer data-model change.**
2. **Project-local.** Styles live in `ProjectGraph.textStyles` — no API/Prisma. A
   brand style-kit (user-level, cross-project) is deferred (would need the new
   backend data model; revisit with §MasterStyles-brand later).

### §2 BUILD SPEC (locked 2026-07-14)

**Data model** (`packages/shared`, additive — no migration):
- `ProjectGraph.textStyles?: TextStyle[]`.
- `TextStyle = { id: string; name: string; style: TextStyleFields }` where
  `TextStyleFields` is the text-look subset of `TimelineLayer`:
  `fontFamily, fontSize, fontWeight, italic, letterSpacing, lineHeight, color,
  strokeColor, strokeWidth, backgroundColor, backgroundPaddingEm, backgroundRadiusEm,
  shadowColor, shadowBlur, shadowOffsetX, shadowOffsetY, textAlign`. (Deliberately
  NOT: text content, transform, position, width, warp, effects, keyframes.)
- Two pure helpers in shared (unit-testable): `captureTextStyle(layer): TextStyleFields`
  (snapshot those fields, dropping `undefined`) and `applyTextStyle(layer, fields): TimelineLayer`
  (spread the captured fields onto the layer).

**Behavior:**
- **Save as style** — snapshot the primary text layer's fields → new `TextStyle`
  (prompt a name; default e.g. "Style 1"). Appended to `ProjectGraph.textStyles`.
- **Apply** — **mirror Align's selection semantics exactly** (§3): one selected text
  layer → apply to it; multiple selected text layers → apply to **all in ONE undo
  step** (via batch `updateLayers`); **mixed selection → silently apply to the text
  layers only**, ignore non-text (no manual filtering forced on the user). Applies
  the full captured look; fields the style didn't capture are left untouched.
- **Update** — re-capture the selected layer's current look into an existing style.
- **Rename / Delete** — manage the project list.

**UI placement — Text tab (confirmed).** Ownership model: Graphics = layout/hierarchy/
align/responsive; **Text = how text looks** (typography); Color = grading; Transform =
geometry. A Text Style is a saved bundle of text appearance → it belongs with Text.

**UI — design it as a reusable ASSET from day one** (the layout must survive every
future version). A "Text Styles" section in the Text tab:

```
Text Styles                 [ + Save Style ]
──────────────────────────────────────────
  Corporate Heading
  Lower Third
  Caption
  Quote
──────────────────────────────────────────
  [ Apply ] [ Update ] [ Rename ] [ Delete ]
```

A selectable list of saved styles + a Save button; the action row operates on the
highlighted style. This shape absorbs later additions — **search, favorites,
categories, brand imports, linked styles** — with no redesign. (v1 wires only
Save/Apply/Update/Rename/Delete; the rest are future.)

**Renderer:** none. Values are baked at apply time; both renderers already read the
flat `TimelineLayer` fields.

**Files:** shared (`TextStyle`/`TextStyleFields` types + `ProjectGraph.textStyles` +
capture/apply helpers + a standalone assert test), Text-tab UI component, EditorPage
wiring (read/write `graph.textStyles`, apply via `updateLayers`).

**Testing:** typecheck; a `text-style:test` asserting capture→apply round-trips and
that excluded fields (text/transform) are untouched; manual — save a look, apply to
2+ text layers in one undo step.

### §2 BUILD RESULT (2026-07-14)

Built to spec. `pnpm -r typecheck` clean; `text-style:test` 11/11; editor suite green.

Files landed:
- **shared** — `TextStyleFields` + `TextStyle` types, `ProjectGraph.textStyles?`
  ([types.ts](packages/shared/src/types.ts)); new [text-styles.ts](packages/shared/src/text-styles.ts)
  (`captureTextStyle`, `applyTextStyle`, `createTextStyleFromLayer`, `TEXT_STYLE_FIELD_KEYS`);
  barrel export.
- **New** [TextStylesSection.tsx](apps/web/src/editor/inspector/TextStylesSection.tsx) —
  the reusable-asset panel (Save + list + Apply/Update/Rename/Delete, inline rename).
- **EditorPage** — `handleSaveTextStyle` / `handleApplyTextStyle` / `handleUpdateTextStyle` /
  `handleRenameTextStyle` / `handleDeleteTextStyle`; Apply mirrors Align (batch `updateLayers`,
  one undo, text-only from a mixed selection); rendered after `TextGraphicControls` in the Text tab;
  `textStyles` threaded from `graph.textStyles`.
- **New** [textStyle.test.ts](apps/web/src/editor/inspector/textStyle.test.ts) + `text-style:test` script.
- CSS for the styles panel.

### §2 QA (2026-07-14) — ✅ user-verified in-app

Save / Apply (single + multi in one undo) / Update / Rename / Delete all confirmed;
Apply copies the look but not the words/position.

Status: ✅ SHIPPED — built, auto-tested, user-verified 2026-07-14

---

## 3. Distribute + multi-select align  ← ACTIVE (forks resolved 2026-07-14)

Space-evenly buttons + an "Align to: Frame | Selection" control so align works
across multiple selected layers. **Does not cross the render-manifest line** (pure
transform writes through existing `applyTransformValueAtTime`).

Corrected blocker note: multi-select is **NOT** actually missing. `selectedLayerIds:
string[]` already exists at the editor level ([EditorPage.tsx:603](apps/web/src/pages/EditorPage.tsx#L603))
and already drives shift-select, select-all, multi-delete, link, and nest. Only the
Graphics **stack UI** is single-select — it's handed one `layer.id` at
[EditorPage.tsx:11353](apps/web/src/pages/EditorPage.tsx#L11353). So the work is:
teach the stack UI to read/write the existing array; add distribute + align-to-selection.

### Cost
- **Data model:** none. Selection reuses existing editor state.
- **Renderer:** **zero.** Ordinary position keyframes.

### Decisions (DECIDED 2026-07-14)
1. **Selection model → share the existing `selectedLayerIds`.** Stack selection and
   timeline selection are one model; shift/cmd-click in the stack behaves like the
   timeline. No separate stack-only selection state.
2. **Align-to-frame vs align-to-selection → explicit "Align to: Frame | Selection"
   toggle, defaulted by count** (Selection when 2+ selected, Frame when 1; user can
   flip). Predictable + convenient; matches Premiere muscle memory.
3. **Distribute → offer BOTH methods:** equal gaps (edge-to-edge) *and* equal center
   spacing, each on H and V. Premiere exposes both.

### Remaining implementation detail (to spec before build)
- Where the "Align to" toggle lives in the Align section, and its default-by-count logic.
- Distribute needs ≥3 layers to be meaningful (2 have nothing to distribute between) —
  gate button enabled-state on selection count.
- Stack UI: shift/cmd-click semantics, multi-selected row styling, and keeping the
  inspector's `multiSelectPrimaryLayer` anchor ([EditorPage.tsx:1162](apps/web/src/pages/EditorPage.tsx#L1162)) in sync.
- "Selection bounds" = union of each layer's painted box (reuse `contentFractions()`
  from [GraphicsAlignPanel.tsx:30](apps/web/src/editor/inspector/panels/GraphicsAlignPanel.tsx#L30)).

Status: 🟡 spec below — ready to build

---

## §3 BUILD SPEC (locked 2026-07-14)

Goal: the Graphics stack becomes a first-class multi-selection client of the
editor (shares `selectedLayerIds`), and the Align section gains
align-to-selection + distribute. **Zero render-manifest impact** — every write is
an ordinary transform edit through `applyTransformValueAtTime`.

Guiding principle (why spec-first): the stack must be *another view of the
timeline*, not a second editor with subtly different rules. Every rule below
mirrors the timeline unless a divergence is called out with rationale.

### S1 — Selection behavior

**Reuse the timeline's exact model. No new selection state, no new modes.**

- **Click** → `selectLayer(id, "replace")`.
- **Ctrl/Cmd-click** → `"toggle"`.
- **Shift-click** → `"range"` (mirrors timeline; user directive).
- **Shift+Ctrl/Cmd-click** → `"add-range"`.
- Modifier→mode resolution: **lift `resolveSelectMode()` out of
  [TimelineStrip.tsx:3883](apps/web/src/components/TimelineStrip.tsx#L3883) into a
  shared util** (`apps/web/src/editor/inspector/selectMode.ts` or a neutral
  location both import). TimelineStrip imports it too, so the two surfaces can
  never drift. Do **not** copy-paste it.
- **Range ordering** = `getSelectionRangeIds` (full-timeline flatten order),
  unchanged. DECISION: range from the stack may include layers not shown in the
  filtered stack (e.g. a video between two text layers). We accept this rather
  than a stack-order range, because identical gesture semantics across surfaces
  beats a filtered-order special case — and the selection is genuinely shared, so
  the user sees the full result reflected on the timeline. (This is the one place
  the stack is *not* WYSIWYG; it is deliberate.)
- **Anchor:** already maintained by `selectLayer` via `selectionAnchorRef`; the
  inspector's primary layer follows the existing `multiSelectPrimaryLayer`
  ([EditorPage.tsx:1162](apps/web/src/pages/EditorPage.tsx#L1162)) with no change.
  The stack marks the primary row distinctly (`.is-primary`) so the user knows
  which layer the inspector controls are editing.
- **Empty-space click does NOT clear** (divergence from timeline, deliberate):
  the inspector only exists while something is selected, so clearing from inside
  the stack would delete the panel out from under the pointer. Clearing stays a
  timeline/preview gesture. Rows still select; there is simply no
  clear-on-background here.
- Linked companions: `expandLayerSelection` already folds them in — no extra work.

**Prop changes — `GraphicsStackPanel`:**
- add `selectedLayerIds: string[]`
- add `primaryLayerId?: string`
- change `onSelectLayer` signature to `(id: string, mode: LayerSelectMode) => void`
  and compute `mode` from `resolveSelectMode(event)` in the row `onClick`.
- Row styling: `.is-selected` for every id in `selectedLayerIds`, `.is-primary`
  for `primaryLayerId`.

### S2 — Align section

Layout, top to bottom, inside the existing `InspectorSection title="Align"`:
1. **"Align to" segmented control** — two segments `[ Frame | Selection ]`.
2. **Row of 6 align buttons** (existing icons: L / centerH / R / T / middle / B).
3. **Distribute rows** (see S3).

**"Align to" mode state & default:**
- Stored at **module level** (same pattern as `lastTabByLayerType` in
  [InspectorTabs.tsx](apps/web/src/editor/inspector/InspectorTabs.tsx)) so it is
  **sticky for the session** across selection changes and unmounts.
- **Initial value:** `Selection` if the current visual-selection count ≥ 2, else
  `Frame`.
- The **`Selection` segment is disabled when < 2** visual layers are selected;
  while disabled, align always acts on the Frame regardless of the remembered
  value (the remembered value is *not* discarded — it re-applies once ≥ 2 are
  selected again).
- Once the user explicitly clicks a segment, that choice sticks for the session.

**Align math:**
- **Frame mode** (any count): each selected visual layer aligns to the frame
  edge independently — the existing single-layer math in
  [GraphicsAlignPanel.tsx:69](apps/web/src/editor/inspector/panels/GraphicsAlignPanel.tsx#L69),
  mapped over the selection.
- **Selection mode** (≥ 2): compute the selection **bounds** (S4), then align each
  moved layer's box edge/center to the corresponding bounds edge/center (left
  edges → `bounds.left`, centerH → bounds center-x, etc.).

### S3 — Distribute

- **Four buttons:** Distribute Horizontal (centers), Distribute Vertical
  (centers), Distribute Horizontal Gaps (edge-to-edge), Distribute Vertical Gaps.
- **Disabled when < 3** movable layers selected. Disabled-tooltip:
  *"Select 3 or more layers to distribute."*
- **Reference order:** sort by current box center along the axis
  (left→right for horizontal, top→bottom for vertical), ties broken by stack
  (draw) order. Positions read at the playhead via the evaluated transform.
- **Fixed anchors:** the first and last layer (by that order) stay put; interior
  layers move.
- **Equal centers:** interior centers spaced evenly between first & last centers.
- **Equal gaps:** interior boxes placed so the empty gap between adjacent boxes is
  equal (uses each box's size, so unequal-size boxes look evenly spaced).

### S4 — Selection bounds & edge cases (explicit)

Bounds = the union of each participating layer's **painted box** at the playhead.
Painted box = evaluated transform position (center) ± half the box size, where box
size comes from `contentFractions()` × scale (extracted to the pure geometry
module — see S7).

- **Which layers participate:** visual layers only. **Audio is excluded** (no
  geometry).
- **Rotated layers:** v1 **ignores rotation** — bounds use the unrotated,
  scaled box (matches how `contentFractions` already works). Aligning a rotated
  layer aligns its layout-box center/edges, not the rotated visual extent.
  Documented simplification; rotation-aware AABB is a possible v2.
- **Hidden layers (`muted === true`):** **excluded from bounds AND never moved**
  (WYSIWYG — you can't see the thing you'd be aligning). If excluding hidden
  layers drops the movable count below the threshold (2 for align-to-selection,
  3 for distribute), the operation is treated as insufficient (button disabled /
  no-op).
- **Locked layers (`locked === true`):** **contribute to bounds and to distribute
  order, but are never moved** (consistent with delete skipping locked at
  [EditorPage.tsx:3759](apps/web/src/pages/EditorPage.tsx#L3759)). They act as
  fixed reference points others align/distribute against.
- **Zero-size graphics** (no natural dims / 0 width or height): degrade to a point
  at their center; align/distribute use the center. No crash, no special-case.
- **Nested / compound graphics (`isFrame` / `nestedCompositionId`):** treated like
  media — use the media branch of `contentFractions` (comp-filling box unless
  `fit === "contain"`).

### S5 — Undo

**One history entry per align/distribute click.** Precompute a
`Map<layerId, { x?: number; y?: number }>` of target values for all moved layers,
then apply them in a single batch via a new `onChangeLayers(ids, updater)` prop
wired to the existing `updateLayers` → `updateTimelineLayers` → one
`updateComposition` ([EditorPage.tsx:2704](apps/web/src/pages/EditorPage.tsx#L2704)).
Never loop per-layer `onChange` (that would push N history entries).

### S6 — Animation (write semantics)

Every position write goes through **`applyTransformValueAtTime`** (the canonical
four-way rule, [keyframeUtils.ts:679](apps/web/src/editor/inspector/keyframeUtils.ts#L679)),
per layer, at that layer's local time (`currentTime - layer.startSeconds`, clamped ≥ 0):
- not animated + auto-KF off → sets the **static base** position.
- property already animated **or** auto-KF on → **inserts/updates a keyframe** at
  the playhead.

**Mixed selections are fine and handled per layer** — some selected layers may get
keyframes (already animated / auto-KF) while others get static writes, exactly as
single-layer align already behaves. Bounds/order are computed from each layer's
**evaluated** position at the playhead (via `getCompositionTransform`), so
animated layers align by where they actually sit on the current frame.

### S7 — Files touched

1. **New** `.../inspector/selectMode.ts` — `resolveSelectMode(event)` +
   `LayerSelectMode` type, lifted from TimelineStrip; TimelineStrip re-imports it.
2. **New** `.../inspector/panels/graphicsAlignGeometry.ts` (pure, unit-testable):
   move `contentFractions` here; add `paintedBoxAt(layer, comp, time)`,
   `selectionBounds(layers, comp, time)`, `distributeTargets(...)`,
   `alignTargets(...)`. Pure functions → the geometry can get a standalone
   assert script later (S8).
3. `GraphicsStackPanel.tsx` — S1 prop changes + multi-select/primary styling +
   modifier-aware click.
4. `GraphicsAlignPanel.tsx` — accept `selectedLayers: TimelineLayer[]`,
   add the "Align to" toggle (S2), the distribute buttons (S3), consume the
   geometry module, commit via `onChangeLayers`.
5. `EditorPage.tsx` (around [11348](apps/web/src/pages/EditorPage.tsx#L11348)) —
   thread `selectedLayerIds`, `primaryLayerId` (= `multiSelectPrimaryLayer?.id`),
   the mode-aware `selectLayer`, the selected visual layer objects, and a new
   `onChangeLayers` (→ `updateLayers`). **Implementer must verify the prop chain**
   from EditorPage → LayerInspector → Graphics tab actually carries the mode-aware
   `selectLayer` (today the stack receives a replace-only handler).
6. `styles/global.css` — `.graphics-stack-row.is-primary`, multi-`.is-selected`
   styling, the segmented "Align to" control, distribute button rows, disabled state.

### S8 — Testing / QA

No web test runner in this repo (`pnpm lint` == `pnpm typecheck`). Plan:
- **Typecheck:** `pnpm --filter @kimera-by-aelivion/web typecheck` must pass.
- **Pure geometry (recommended):** because S7#2 is pure, add a worker-style
  standalone `tsx` assert script (mirroring `animation:test`) for
  `selectionBounds` / `distributeTargets` / `alignTargets` — cheap regression
  guard for the math.
- **Manual QA checklist (must all pass):**
  1. Multi-select from the stack updates the timeline selection, and vice-versa
     (shared model, both directions).
  2. Ctrl/Cmd-click toggles; Shift-click ranges; Shift+Ctrl adds-range — same as
     timeline.
  3. Align → Frame: each selected layer snaps to the frame edge independently.
  4. Align → Selection: layers align to the selection bounds edge/center.
  5. Distribute → Equal Centers: interior centers evenly spaced; ends fixed.
  6. Distribute → Equal Gaps: gaps between boxes visually equal with mixed sizes.
  7. Distribute disabled with < 3; tooltip explains why.
  8. Undo once fully reverts a multi-layer align/distribute (single history step);
     redo re-applies.
  9. Hidden layer in selection: not moved, not counted in bounds.
  10. Locked layer in selection: not moved, but others align/distribute against it.
  11. Animated layer: align at the playhead writes/updates a keyframe (not the
      base); a mixed selection writes keyframes to animated layers and base
      values to the rest — verify in the graph editor.
  12. Rotated layer: aligns by layout-box center (documented v1 behavior), no crash.

### §3 BUILD RESULT (2026-07-14)

Built to spec. Typecheck clean; 20/20 geometry asserts pass
(`pnpm --filter @kimera-by-aelivion/web graphics:align:test`); editor suite still green.

Files landed:
- **New** `apps/web/src/editor/selectionMode.ts` — `resolveSelectMode` + `LayerSelectMode`,
  lifted from TimelineStrip (which now imports it — single source, no drift).
- **New** `.../inspector/panels/graphicsAlignGeometry.ts` — pure geometry
  (`paintedBoxAt`, `unionBounds`, `alignTargets`, `distributeTargets`, `contentFractions`).
- **New** `.../inspector/panels/graphicsAlignGeometry.test.ts` + `graphics:align:test` script.
- `GraphicsStackPanel.tsx` — shared multi-select (`selectedLayerIds`), primary-row rail,
  modifier-aware click via `resolveSelectMode`.
- `GraphicsAlignPanel.tsx` — "Align to: Frame | Selection" toggle (sticky, default-by-count),
  6 align buttons (frame/selection math), 4 distribute buttons (centers + gaps, H/V),
  batched one-history-entry commit via `onChangeLayers`.
- `EditorPage.tsx` — mode-aware `onSelectLayer` (→ `selectLayer`), new `onChangeLayers`
  (→ `updateLayers`), threaded `selectedLayerIds`/`primaryLayerId` + selected-layer objects.
- `styles/global.css` — align-to segmented control, `.is-primary` rail, distribute row,
  disabled states.
- `apps/web/package.json` — added `graphics:align:test`.

Status: ✅ SHIPPED — built, auto-tested, and user-verified in-app 2026-07-14
(single-select align, multi-select align-to-selection, and distribute all confirmed
landing in place, including the text-box measurement fix).

---

## 4. Layer stack ops

Turn the Layers list from view/hide/rename into a real layer manager: lock,
duplicate, delete, drag-reorder, group.

### Behavior options per op
- **Lock:** `locked` field exists — nearly free. Verify both renderers respect it,
  add a row toggle next to the eye.
- **Duplicate / delete:** composition ops that likely already exist (timeline
  context menu) — surface them in the stack. No new model.
- **Drag-reorder:** the subtle one. Stack order derives from **track order**, so
  reordering means moving layers between tracks / reordering tracks — a real
  timeline mutation, not a list sort. Semantics need deciding.
- **Group:** either (a) a UI folder in the stack (new `groupId`), or (b) route into
  the **already-shipped** Canvas Frame / nested-comp machinery (`isFrame`).

### Cost
- **Data model:** lock/dup/delete = none. Reorder = none. Group = new `groupId`
  OR reuse `isFrame`/nested comp (none).
- **Renderer:** lock/reorder ≈ zero (draw order already from track order).
  Group-as-Frame already supported. Group-as-folder = cosmetic.

### Decisions (DECIDED 2026-07-14)
1. **Scope this pass → Lock, Duplicate, Delete, Group.** Drag-reorder **deferred**
   (⏸) — it's the architectural fork (stack order == timeline draw order == track
   order; arbitrary reorder raises same-track / cross-track / track-create / linked-
   clip / undo questions that need a proper "draw-order editing" model first).
2. **Group → reuse Canvas Frames / nested compositions ONLY.** No lightweight UI
   folders — one grouping primitive across timeline / stack / AI / export / renderer.
   "Group" = `nestLayersIntoComposition` (already shipped). The stack becomes a
   hierarchical *view* of the real composition tree, not an organizer with its own
   folders.
3. **CORE INVARIANT (user directive):** the Graphics stack **never owns state** — it
   is always a projection of the timeline/composition, and every stack action
   dispatches the *same* operation the timeline would. This keeps it from becoming
   a second editor with divergent rules.

### §4 BUILD SPEC (locked 2026-07-14)

Zero new data model (all fields/ops exist). Every action routes to an existing
EditorPage handler, honoring the invariant.

**S1 — Lock**
- Row toggle next to the eye. Writes `locked: !locked` via the existing
  `onChangeLayer` (→ `updateLayer`). No new handler.
- `layer.locked` is already an edit-guard (delete skips it,
  [EditorPage.tsx:3710](apps/web/src/pages/EditorPage.tsx#L3710)); align/distribute
  already skip locked (§3). Renderers don't need it (lock is edit-time only).
- Locked row: dim + show a filled lock icon; eye/rename still work (lock guards
  geometry edits, not visibility).

**S2 — Duplicate / Delete (context menu)**
- Right-click a row → menu with **Duplicate**, **Delete** (+ **Group** when eligible,
  + **Ungroup** on a frame). Reuse the existing `.timeline-context-menu` CSS so it
  matches the timeline's clip menu.
- Duplicate → existing `handleDuplicateLayer` (thread as `onDuplicateLayer`).
- Delete → existing `handleDeleteLayer(s)` (thread as `onDeleteLayer`). Multi-select
  delete uses `handleDeleteLayers(selectedLayerIds)`.

**S3 — Group / Ungroup (Canvas Frame)**
- **Group** enabled with 2+ selected → existing `handleNestSelection`
  ([EditorPage.tsx:3333](apps/web/src/pages/EditorPage.tsx#L3333)) →
  `nestLayersIntoComposition`. Available in the context menu and as a small button
  when 2+ are selected.
- **Ungroup** on a compound clip → existing `handleUnnestClip`.

**S4 — Hierarchical stack view (REQUIRED for Group to be coherent)**
- Grouping moves layers into a nested composition (`graph.compositions`) and leaves
  a compound clip up top — so a FLAT stack would make grouped layers vanish. The
  stack must therefore render the composition **tree**:
  - `graphicsStackEntries` includes compound/frame clips (layers with
    `nestedCompositionId`) and, for each, recurses into its nested composition's
    layers, rendered indented under a collapsible frame row.
  - Collapse/expand per frame (local UI state — this is view state, NOT composition
    state, so it doesn't violate the invariant; it stores nothing about the layers).
  - Selecting / locking / hiding / duplicating a frame row acts on the compound clip
    (the real container), consistent with the invariant.
- Frame rows read as "folders" to the user (Title Frame ▸ Text / Logo / …) but are
  literally Canvas Frames — one concept everywhere.

**S5 — Files touched**
1. `GraphicsStackPanel.tsx` — recursive/hierarchical entries + indentation +
   collapse toggles; lock button; right-click context menu; group button.
2. `EditorPage.tsx` — thread `onDuplicateLayer`, `onDeleteLayer`, `onGroup`
   (`handleNestSelection`), `onUngroup` (`handleUnnestClip`) into the Graphics tab;
   pass `graph.compositions` so the stack can walk nested comps.
3. `styles/global.css` — frame-row / indent / collapse-caret / lock-row styling;
   reuse `.timeline-context-menu` for the stack menu.

**S6 — Testing / QA**
- Typecheck clean.
- Manual QA: lock guards edits (align skips a locked layer); duplicate adds a copy
  visible in stack + timeline; delete removes from both; group 2+ layers → they nest
  under a collapsible frame row (don't vanish); ungroup restores them; collapse/expand
  is pure view state (survives reselect, changes nothing on undo); every action shows
  the same result on the timeline (invariant holds).

### §4 BUILD RESULT (2026-07-14)

Built to spec. Typecheck clean; editor suite green. No new data model; every action
dispatches an existing EditorPage handler (invariant held).

Files landed:
- `GraphicsStackPanel.tsx` — hierarchical `graphicsStackEntries` (recurses into
  `nestedCompositions`, skips content-free frames), collapsible frame rows with
  indentation, inline lock toggle (next to eye), right-click context menu
  (Group into Frame / Ungroup / Duplicate / Delete). Only local state is view state
  (collapsed set, rename buffer).
- `EditorPage.tsx` — `inspectorHandlers` gains `onDuplicateLayer` (→ `handleDuplicateLayer`),
  `onDeleteLayer` (→ `handleDeleteLayer`), `onGroupLayers` (→ `handleNestSelection`),
  `onUngroupLayer` (→ `handleUnnestClip`); threaded into the stack with
  `nestedCompositions={graph?.compositions}`.
- `styles/global.css` — `.graphics-stack-action` (was `-eye`), caret + spacer, indent,
  `.is-locked`, `.graphics-stack-menu` (reuses `.timeline-context-menu`).

Deferred: ⏸ drag-reorder → ✅ SHIPPED 2026-07-15 (see §4 DRAG-REORDER below).

### §4 QA (2026-07-14) — ✅ user-verified in-app
Group (transparent, collapsible), lock (align/distribute skip + row shows locked),
duplicate/delete (reflected on timeline), collapse/expand (view-only), ungroup — all
confirmed. (The earlier "lock not working" was a stale dev build.) Also fixed a
Group/Nest **name clash** surfaced in QA: the compound-clip menu now reads
"Open group" / "Ungroup" (was "Open nested sequence" / "Un-nest") and all nest
toasts now say group/ungroup — one vocabulary everywhere.

Status: ✅ SHIPPED — built, auto-tested, user-verified 2026-07-14 (drag-reorder ⏸ deferred)

### §4 QA FINDINGS + FIXES (2026-07-14)

QA surfaced two issues (fixed):
- **Naming clash:** the stack menu said "Group into Frame" but wired to the *Nest*
  path (`handleNestSelection` → `nestLayersIntoComposition`, no backdrop). There are
  two existing commands — **Nest/Group** (`Ctrl+G`, transparent container) and
  **Canvas Frame** (`Ctrl+Alt+F`, same compound-clip primitive + a full-bleed
  Background + `isFrame`). Decision: **Group = Nest (no backdrop)**; Canvas Frame
  stays a separate design-frame tool. Menu relabeled "Group".
- **Canvas Frame background rendered ON TOP** (only the backdrop visible inside the
  frame). Root cause was NOT just placement — a **track-order inversion in shared
  nesting core**: the active render paints `tracks[0]` on top, but
  `expandNestedCompositions` flattened inner tracks front-first, so a nested comp's
  z-order was **inverted between the opened view and the composited (outer) view**.
  Fix (user-approved, shared core so uniform across web preview / Remotion / scene
  compositor): reverse the inner-track iteration so composited order == opened order;
  then move the frame Background to the **last** track (bottom) — now behind content
  in both views. This corrects z-order for ALL multi-track nested/imported comps, not
  just frames. Verified: `pnpm -r typecheck`, editor suite, and `render:compare:pixels`
  (**27/27 fixtures, 0.000–0.001%** — preview↔Remotion parity held through the core change).

Status: 🟢 built + fixed + auto-tested — pending final in-app QA, then ship

### §4 FOLLOW-UPS (2026-07-14) — multi-select stack ops + full lock

Two enhancements the user asked to land before §1:

- **Multi-select Duplicate/Delete (BOTH menus).** Right-clicking a clip that is part of
  a 2+ selection now acts on the WHOLE selection (like the timeline Delete key); a
  single/non-selected clip still acts on just that clip. Both fold into ONE undo:
  - `handleDuplicateLayers(ids)` (new, EditorPage) folds `duplicateLayer` over the ids
    into one `updateComposition`, selects the copies, skips locked (`isLayerEditable`).
  - `handleDeleteLayers(ids)` (already existed) reused for multi-delete.
  - **Graphics stack menu:** wired as `onDuplicateLayers` / `onDeleteLayers` through
    inspectorHandlers → LayerInspector → GraphicsStackPanel; panel computes targets at
    click time (`actionTargets`), labels "Duplicate N" / "Delete N".
  - **Timeline clip menu** (TimelineStrip): the menu already knew `selectionCount`
    (= selectedLayerIds.length when the clicked clip is within the selection, else 1);
    Duplicate/Delete now branch on `selectionCount >= 2` → `onDuplicateSelectedLayers`
    (new, → `handleDuplicateLayers`) / `onDeleteSelectedLayers` (existing), labels
    "Duplicate N clips" / "Delete N clips".

- **Full lock (property panels).** Lock previously blocked Delete + align/distribute;
  canvas handles already bailed on `layer.locked` (move/scale/crop/rotate/keyframe/
  spatial). Extended to the **inspector property body**: the single `onChange` funnel
  (every registered panel — Transform, Effects, blend, … commits through it) now no-ops
  when the primary layer is locked, and in multiselect skips locked ids (like align).
  UI: a **lock banner** with a one-click **Unlock** at the top of the inspector +
  dimmed/`pointer-events:none` body — EXCEPT on the Graphics tab, whose stack is a
  multi-layer manager (must stay interactive to select/unlock others). Unlock writes
  through `onChangeLayer` (unguarded), so it can't lock you out.

Verified: `pnpm --filter @kimera-by-aelivion/web typecheck` clean; **user-verified in-app 2026-07-14** ("verified all good" — multi-select dup/delete in both menus + full lock banner/enforcement).

Status: ✅ SHIPPED — §4 follow-ups (multi-select stack/timeline ops + full lock) user-verified 2026-07-14.

### §4 DRAG-REORDER (2026-07-15) — the deferred stack drag, now built

Decisions (2026-07-15): **within-track scope** (drag reorders a layer among SAME-track siblings;
cross-track rejected) + **front-first list orientation** (top-of-list = on top).

- **Grounding:** draw order = track order (tracks[0] top) then array order within a track (higher
  index = on top). New graphics append to the selected/first non-audio track, so several graphics
  commonly share ONE track → within-track reorder is the real case. The shipped stack listed
  within-track bottom-of-z first (mixed convention); fixed.
- **Orientation fix:** `graphicsStackEntries` now walks each track's layers REVERSED, so the list
  reads top→bottom in true Z (drag-up = bring-forward), consistent with the cross-track convention.
- **Pure op (shared):** `moveLayerWithinTrack(comp, layerId, targetId, place)` — `place` in Z terms
  ("front-of" → reinsert after target; "behind" → before). No-op unless BOTH layers are on the same
  track (cross-track drops rejected). `timeline-ops.ts`, barrel-exported.
- **UI:** top-level (depth 0) rows are `draggable`; HTML5 DnD. Drop side derived from pointer Y vs
  row midpoint (upper half = front-of); a coloured rule shows where it lands; dragged row fades.
  Group children (depth>0) aren't draggable in v1. Wired `onReorderLayer` through inspectorHandlers →
  LayerInspector → GraphicsStackPanel; commits via `handleReorderLayerWithinTrack` (one history step).
- **No renderer change** — pure stack/array reorder; both renderers read the new order identically.

Verified: `pnpm -r typecheck` all 5 clean; `stack:reorder:test` 8/8 (front-of/behind, top/bottom
edges, cross-track reject, self no-op, track isolation); editor/align/pin suites green (no regression).

Status: ✅ SHIPPED — built, auto-tested (`stack:reorder:test` 8/8), user-verified in-app 2026-07-15.

QA: put 2–3 text/shape graphics on ONE track → open Graphics tab stack → drag a row up/down → the
coloured rule shows the drop; release → z-order changes in the preview, ⌘Z reverts in one step. Drag
onto a DIFFERENT track's row → rejected (snaps back). Group children don't drag.

---

## 5. Responsive Design – Time (Protect intro/outro on resize)

Temporal twin of Responsive Pin: when a non-source animated clip's DURATION changes,
keep its crafted intro/outro timing and stretch only the middle — instead of the
current uniform proportional squeeze that turns a 0.5s fade into a sluggish 1s fade.

### Decisions (DECIDED 2026-07-15)
1. **Region UI = draggable handles on the clip** (timeline), modeled on the existing
   fade-band handles. Manipulated on the clip; enabled from the inspector.
2. **Regions = manual only** (no auto-detect from presets in v1).
3. **Resolve = bake, not render-time** (implicit — follows the existing
   `squeezeLayerKeyframesTo` bake, so NO renderer change; consistent with §1).

### Grounding (the pivotal find)
The editor ALREADY bakes keyframe times on a non-source clip's duration change:
`applyEdgeTrim` → **`squeezeLayerKeyframesTo`** ([timeline-ops.ts:306](packages/shared/src/timeline-ops.ts#L306))
rescales every keyframe by `factor = newDur/oldDur`. THAT uniform rescale is the bug.
Responsive-Time makes that one function **region-aware**. On-clip handles follow the
proven fade-drag pattern (`startTransitionDrag`/`moveTransitionDrag`/`finishTransitionDrag`,
window listeners while active, commit-on-release — [TimelineStrip.tsx:2028](apps/web/src/components/TimelineStrip.tsx#L2028)).

### §5 BUILD SPEC (locked 2026-07-15)

**Data model** (`packages/shared`, additive, no migration):
- `LayerResponsiveTime = { introSeconds: number; outroSeconds: number }`.
- `TimelineLayer.responsiveTime?: LayerResponsiveTime`. Absent = today's uniform squeeze
  (fully backward compatible).

**Pure resolver** (`packages/shared`, unit-tested) — `remapResponsiveTime(localT, oldDur,
newDur, intro, outro): number`:
- Fit-guard: if `intro + outro ≥ min(oldDur, newDur) − ε`, fall back to proportional
  (`localT × newDur/oldDur`) — protected zones can't overlap.
- `localT ≤ intro` → **unchanged** (protected head).
- `localT ≥ oldDur − outro` → **`newDur − (oldDur − localT)`** (protected tail, re-anchored
  to the new end).
- else (middle) → map `[intro, oldDur−outro] → [intro, newDur−outro]` proportionally.

**Region-aware squeeze:** `squeezeLayerKeyframesTo` uses `remapResponsiveTime` when
`layer.responsiveTime` is set (applied to v2 `animations` local time AND v1 `keyframes`
local time = `kf.timeSeconds − startSeconds`); uniform factor otherwise. This auto-covers
the trim/resize drag path (the primary, direct-manipulation duration change). Rate-stretch
+ template-instantiation paths are v1 out-of-scope (noted as follow-ups).

**Scope:** non-source layers (text/shape/image) — the titles/graphics case. Source-bound
clips (video/audio) keep the content-pinned `trimLayerKeyframesTo` path unchanged.

**Timeline UI** (TimelineStrip, mirrors fades):
- Enabled per clip from the inspector — a **"Protect intro/outro on resize"** toggle
  (Video/Text tab) that seeds `responsiveTime = { 0.5, 0.5 }` clamped to `≤ duration/3`
  each, and clears it when off. Keeps the timeline uncluttered (handles only on opted-in
  clips) and gives a discoverable entry point.
- When set, two **region bands** render at the clip head/tail (visually distinct from the
  top-corner fade slants — e.g. a hatched/bracketed band along the bottom), each with a
  draggable inner edge. New `responsiveDrag` state + window-listener effect cloned from the
  fade drag; commit via new `onSetResponsiveTime(layerId, { introSeconds, outroSeconds })`
  → `handleSetResponsiveTime` (one history step). Clamp each edge to `[frameStep,
  duration − otherRegion − frameStep]` so they never cross.

**Testing:** `responsiveTime.test.ts` (`resp-time:test`) — `remapResponsiveTime` (head
held, tail re-anchored, middle scaled, fit-guard fallback, degenerate durations) +
`squeezeLayerKeyframesTo` integration (a fade-in/hold/fade-out clip stretched 5s→10s keeps
0.5s in/out, middle grows). Plus `-r typecheck`; and one `render:compare:pixels` to CONFIRM
renderers untouched.

### §5 BUILD RESULT (2026-07-15)

Built to spec.

**Shared (additive, no migration):**
- `LayerResponsiveTime { introSeconds, outroSeconds }` + `TimelineLayer.responsiveTime?`.
- `remapResponsiveTime(localT, oldDur, newDur, intro, outro)` — pure, in `timeline-ops.ts`
  (head held / tail re-anchored / middle scaled / fit-guard fallback). Barrel-exported.
- `squeezeLayerKeyframesTo` now routes through `remapResponsiveTime` when `layer.responsiveTime`
  is set (v2 animations + v1 keyframes, both local time); uniform factor otherwise. This makes
  the existing trim/resize path region-aware with a single function change.

**Timeline UI (TimelineStrip — faithful clone of the fade-band system):**
- `ResponsiveDragState` + `responsiveDrag` state/ref/setter, `startResponsiveDrag` /
  `moveResponsiveDrag` / `finishResponsiveDrag`, and a window-listener effect — all mirrored
  from the fade drag (element-start, window move/up, commit on release).
- On-clip render: protected intro/outro **bands along the clip BOTTOM** (fades own the top),
  each with a draggable inner edge; a 0-zone shows a hover **create-grip** to pull it out from
  zero; double-click a band clears just that side. Shown only on the SELECTED, unlocked,
  non-source clip (text/shape/image). Live width follows `responsivePreview`. Edges clamped so
  intro+outro can't cross.
- Wired `onSetResponsiveTime` through timelineHandlers → TimelineStrip → TimelineClip;
  commits via `handleSetResponsiveTime` (one history step; both-zero clears the field).
- `global.css` — accent hatched bands + grips.

**NO renderer change** — `squeezeLayerKeyframesTo` is an EDIT-time bake (runs on trim/resize),
so the manifest keeps plain keyframe times both renderers already read. Scope v1: the
trim/resize squeeze path for non-source layers. Rate-stretch + template-instantiation duration
changes are noted follow-ups (they don't route through the squeeze).

**Verification:** `pnpm -r typecheck` all 5 clean; `resp-time:test` 14/14 (head held, tail
re-anchor, middle scale, fit-guard, backward-compatible uniform squeeze, region integration);
`render:compare:pixels` ✅ **27/27, 0.000–0.001%** — renderers confirmed untouched.

Status: ✅ SHIPPED — built, auto-tested (`resp-time:test` 14/14), pixel-gated (27/27), user-verified in-app 2026-07-15 (incl. outro-grab z-index fix + hover-only overlay polish). Follow-ups deferred: rate-stretch + template-instantiation duration paths don't yet route through the region-aware squeeze.

### §5 QA FIX (2026-07-15) — outro (right) handle wasn't grabbable
QA surfaced: the bottom-LEFT (intro) handle worked but the bottom-RIGHT (outro) "went
back to its original place." Root cause: `clip-resize-end` renders LATER in the clip DOM
than the responsive bands, and both sat at `z-index: 5` — for equal z-index the later DOM
node wins the pointer, so the right-edge resize handle stole the outro drag (intro was fine
because `clip-resize-start` renders BEFORE the bands). Fix: raised `.clip-resp-band` to
z-index 7 and `.clip-resp-create` to 8 (above resize 5 / fade 4/6) so DOM order no longer
matters. CSS-only.

### §5 QA POLISH (2026-07-15) — hover-only overlay
User feedback: always-on bands/grips clutter the clip. Made the WHOLE responsive-time overlay
(bands + create-grips + handles) `opacity:0; pointer-events:none` by default, revealed on
`.timeline-clip:hover` (and kept visible via `:active` during a drag). Idle clips are clean;
protected zones reveal on hover. CSS-only.

### §5 QA STEPS (for the user)
1. Add a **text** clip; give it a **fade-in + fade-out** (top-corner fade dots) or any in/out animation.
2. Select it → on the clip **bottom**, drag the **left grip inward** (~0.5s intro) and the **right
   grip inward** (~0.5s outro) — accent hatched bands appear.
3. Drag the clip's **right edge much longer** → the fade-in/out keep their length; only the middle
   stretches (before this, both fades stretched proportionally). ⌘Z reverts.
4. **Double-click** a band clears that side; drag a grip on a **locked** or **video/audio** clip →
   nothing (out of scope by design).

---

Not yet triaged; listed so we don't forget them.
- **Anchor point** control (our transform has none today).
- **Align-to-selection vs align-to-frame** toggle (folds into §3).
- **Canva-style Frames** (NEW, parked 2026-07-14) — shape *placeholders* (rectangle,
  circle, phone mockup, grid slots…) that a dropped image/video **auto-clips to**.
  A media *accommodator*, NOT a sequence container — built on our **masks/shapes**
  system (clip media to a vector shape + fit/fill), with a frame picker. This is the
  real "Frames" feature; it replaces the removed nest-with-background "Canvas Frame"
  (see decision log). Its own spec when we get to it.

---

## Cost-vs-fit summary

| Feature | Manifest cost | Data model | Note |
|---|---|---|---|
| Distribute + multi-select (§3) | **None** | None | Blocker = multi-select UI |
| Master Styles — one-shot (§2A) | **None** | None | Style clipboard |
| Layer ops — lock/dup/delete (§4) | ~None | None (fields exist) | Surface existing capability |
| Layer ops — reorder/group (§4) | Low | Maybe `groupId` / reuse Frames | Semantics call |
| Responsive Pin — A (§1A) | **High (both renderers)** | Additive field | Highest template payoff |
| Master Styles — linked (§2B/C) | Moderate (resolve) | Registry / Brand | Brand tie-in |
| Responsive Pin — B (§1B) | High + transform change | Non-uniform scale | Forces scaleX/scaleY |

---

## Decision log

Record resolved forks here (date · fork · choice · rationale) so the sections above
stay a menu and this stays the history.

- **2026-07-14 · §3 selection model** → *Share the existing `selectedLayerIds`.*
  Rationale: multi-select already exists editor-wide; a second selection model would
  conflict. (Finding: only the stack UI was single-select.)
- **2026-07-14 · §3 align mode** → *Explicit "Align to: Frame | Selection" toggle,
  defaulted by count.* Rationale: predictable + convenient; Premiere-familiar.
  (User delegated this call.)
- **2026-07-14 · §3 distribute** → *Offer both equal-gaps and equal-center, H+V.*
  Rationale: user chose full parity with Premiere.
- **2026-07-14 · §3 text-box fix** (QA finding). Root cause: `contentFractions`
  assumed text box = `textWidthPercent` (default 80%), but text renders `max-content`
  (hugs glyphs) centered on position, so align used a box ~4-5× too wide → overshoot +
  a `min(100)` clamp that collapsed align to a no-op. Proven constraint: centered text
  can't land flush without knowing the true glyph width. Resolution (user delegated,
  goal = efficient/Premiere-style): **measure the real rendered text box on-demand at
  align/distribute click** (hidden element, renderer CSS, one-shot, no per-frame cost)
  and **do not persist** — point text keeps auto-growing (true point-text behavior);
  explicit frames are honored because the measurement reflects them. Dropped the
  box clamp so scaled layers align their honest size. New `measureTextBox.ts`;
  `paintedBoxAt` gains a measured-fraction override. Media/shapes keep the analytic box.
- **2026-07-14 · §3 spec locked** (see §3 BUILD SPEC). Notable sub-calls:
  range uses full-timeline order (parity over WYSIWYG); empty-space click does
  NOT clear (would delete the inspector); hidden layers excluded from bounds &
  never moved; locked layers count toward bounds but never move; rotation ignored
  in v1 bounds; one history entry via batch `updateLayers`; writes go through the
  four-way `applyTransformValueAtTime`.
- **2026-07-14 · §2 Text Styles forks** → *One-shot apply (bake), project-local.*
  Rationale: zero renderer change + no backend; brand style-kit deferred. Grounding
  correction: the Brand tab is asset-files only, so brand-sourced styles aren't free.
  Spec locked (see §2 BUILD SPEC); lives in the **Text tab** (flag if it should move
  to Graphics).
- **2026-07-14 · Group/Frame simplification** (user directive). Reverted the earlier
  "Group = Canvas Frames" call. **One grouping primitive: Group = Nest** (compound
  clip, transparent, no backdrop). The nest-with-background **Canvas Frame**
  (`createFrame`, `isFrame`, `Ctrl+Alt+F`, timeline "Group into frame") was a
  confusing near-duplicate and is **removed entirely** — function, type field, UI,
  shortcut, tests. Timeline "Nest N clips" → "Group N clips"; grouped clip named
  "Group". The *real* Frames feature (Canva-style media-accommodator shape
  placeholders) is parked in §5 as a separate masks/shapes concept. Verified:
  `pnpm -r typecheck`, editor suite.