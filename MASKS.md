# Masks

Vector masks hide/reveal parts of a clip, or limit an effect to a region. They work **identically in the
editor preview and the exported video** (both are Chromium/DOM, and both consume the same SVG `<mask>` built
by `packages/shared/src/clip-masks.ts`).

There are two kinds, sharing the same model and UI:

- **Clip masks** — on a video/image layer (the **Masks** inspector section). They reveal/hide the clip.
- **Effect-region masks** — on a **Blur** effect (the **Region mask** block under the effect). They limit the
  blur to a region and blend with the sharp original outside; they do **not** crop the clip.

---

## The model: an alpha matte

Each mask is a stencil over the clip:

- **Opaque (white) = SHOW** that pixel.
- **Transparent = HIDE** that pixel.

A single, non-inverted mask therefore **shows only inside its shape** and hides everything else — no "Invert"
needed. (Internally each mask is emitted as `mask-type="alpha"`: the shape is painted opaque where it
reveals; "Invert" punches the shape out of a full-frame fill so the *outside* is opaque instead.)

### Per-mask modifiers

| Control | Effect |
|---|---|
| **Invert** | Swap show/hide — interior hidden, outside shown. |
| **Feather** | Soften the edge (Gaussian blur of the stencil), in px. |
| **Expansion** | Grow (+) / shrink (−) the shape, in px. |
| **Opacity** | Partial reveal — the clip *ghosts* through at <100%. |

---

## Modes (combining 2+ masks)

Masks on the same target are listed **top → bottom** and combine in that order. The **first/top** mask is the
base; each mask **below** composites onto the running result using **its own Mode**. (A single mask ignores
mode — it's just its own shape.) Use the **▲/▼** buttons on a mask row to change the order.

Let `A` = everything revealed by the masks above, `B` = this mask's shape.

| Mode | Result (set algebra) | Visible | Hidden |
|---|---|---|---|
| **Add** | `A ∪ B` | inside A **or** B | outside both |
| **Subtract** | `A − B` | inside A but **not** B | outside A, **and** B (a hole) |
| **Intersect** | `A ∩ B` | only where A **and** B overlap | everywhere else |
| **Exclude** | `A ⊕ B` (XOR) | inside exactly one of A/B | outside both **and** the overlap |

### Truth table (two masks A then B, pixel inside/outside each)

| in A? | in B? | Add | Subtract | Intersect | Exclude |
|:---:|:---:|:---:|:---:|:---:|:---:|
| ✗ | ✗ | hide | hide | hide | hide |
| ✓ | ✗ | **show** | **show** | hide | **show** |
| ✗ | ✓ | **show** | hide | hide | **show** |
| ✓ | ✓ | **show** | hide | **show** | hide |

---

## How to test each (and the expected result)

Select a video/image clip → **Masks** → pick a shape button (it arms the matching draw tool — Rectangle/Ellipse
drag, Polygon/Pen click points), draw it in the preview, then drag it. Nothing is added until you draw.

1. **Base reveal (Add).** Add one **Ellipse**.
   → Only the oval is visible; the rest of the frame is hidden. *(No Invert needed — if you must press Invert
   to see masking, the alpha fix below isn't in.)*
2. **Subtract — cut a hole.** Keep the ellipse, add a **Rectangle**, set its Mode = **Subtract**, drag it over
   the oval. → The oval shows with a rectangular **hole** punched out.
3. **Intersect — overlap only.** Set the 2nd mask Mode = **Intersect** and overlap it ~halfway.
   → Only the **lens** where both overlap is visible.
4. **Exclude — XOR.** Two overlapping ellipses, 2nd = **Exclude**.
   → Both ovals show **except** their overlap, which becomes a hole.
5. **Invert.** Toggle **Invert** on a single mask. → Inside hidden, outside shown (good for "hide the subject,
   keep the surroundings").
6. **Feather / Expansion / Opacity.** Drag each slider → the edge softens / the shape grows·shrinks / the clip
   faintly ghosts through.
7. **Reorder.** Use **▲/▼** to move a Subtract mask above/below an Add mask and watch the combination change
   (order = composite order).
8. **Move.** With the **Select** tool, drag **inside** an active mask to move the whole shape; drag a point to
   reshape; **Alt-drag** a point to pull out Bézier handles.
9. **Export parity.** The exported MP4 shows the identical cutout (everything bakes into the same SVG stencil).
   Spot-check with `pnpm --filter @orreris/worker render:compare:pixels`.

---

## Effect-region masks (blur a region)

Add a **Blur** or **color** effect (Brightness/Contrast, curves, wheels, looks, LUTs) to a media clip → a
**Region mask** block appears. Add a shape and the effect applies **only inside** it (e.g. blur or brighten a
face); the rest is untouched. Multiple region effects on one clip **stack** in effects-panel order — e.g.
color-grade the building, then blur a sub-area inside it, and the blurred area shows color+blur. Implemented as
a render-time **duplicate-layer cascade** (see roadmap P6), so it works in preview, Remotion and local export.
If the clip also has its own **clip masks**, each region effect is confined to **`clip ∩ region`** (the region
never reveals anything the clip mask cut away). The clip masks lead and compose into the clip compound (so a
**compound** clip mask — e.g. an irregular shape **∪** a rectangle, plus holes/invert — stays intact), then the
region is intersected onto it. Exact for compound clips, a single region, and a region with a carved hole; only
**multiple separate `add` regions on one effect** + a clip mask stays approximate (a flat mask list can't
express `clip ∩ (r0 ∪ r1)` — that needs the deferred nested-compositor / single-GPU-engine work). Region masks
are edited from the **original** layer (the render-time duplicate-layer expansion is render-only), so they stay
selectable/movable even when the effect is active.
*(Glow is whole-clip only — region glow is deferred because its bloom must extend beyond the mask.)* Region
masks have the **full clip-mask toolset** —
Mode/Invert, keyframeable Feather/Expansion/Opacity + Transform, shape keyframes, and **mask tracking** (Follow
track) — so a blur region can animate and follow a moving subject. Rendered as a `backdrop-filter` overlay
clipped to the mask — single-copy, no crop, and identical in preview and Remotion export. *(Local browser
export of effect-region masks is not wired yet — see roadmap P6; clip masks already export.)*

---

## Animating masks (clip masks)

- **Scalar props** (Feather / Expansion / Opacity / mask Transform X·Y·Scale·Rotation) keyframe via the ◆
  diamond on each slider.
- **Shape** (the outline itself) keyframes via the ◆ in the mask's **Shape** row: click it, move the playhead,
  drag points — a new shape keyframe is auto-recorded; the mask morphs between them. Interpolation needs the
  same number of points between keys (otherwise it holds).

Effect-region masks share the **same** keyframe + tracking controls as clip masks (the inspector body is one
shared component).

---

## Mask model vs. Premiere / After Effects

A common question: *"Premiere applies a mask to an effect, not directly to the clip — are we doing it
backwards?"* No — our model targets the **same places** Premiere does.

**Premiere Pro** has no separate mask layer/clip. A mask is a **property of an effect** in Effect Controls:

- **Clip-level masking** = a mask drawn under the clip's intrinsic **Opacity** effect → masks the clip's
  pixels (inside visible, outside hidden; per-mask **Inverted** flips). It lives in the clip's *transformed*
  space, so it moves/scales with the clip.
- **Effect-level masking** = a mask drawn under any other effect (e.g. **Gaussian Blur**) → that effect
  applies **only inside** the mask; original pixels show outside (blend, never a crop).
- Premiere has **no per-mask blend modes** — multiple masks under one effect are simply **unioned**, and you
  carve shapes out with **Inverted**. (Per-mask **modes** — Add / Subtract / Intersect / Difference — are an
  **After Effects** feature.)

**Orreris maps 1:1 to that target** (so the result matches Premiere):

| Premiere | Orreris |
| --- | --- |
| Mask under **Opacity** (clip-level) | `layer.masks` — surfaced directly as the clip's **Mask** panel |
| Mask under an **effect** (effect-level) | `effect.masks` — e.g. the Blur effect's **Region mask** |
| Mask follows the clip transform | applied to the **transformed layer element** (so it follows automatically) |
| Additive-only, carve with Inverted | supported — *plus* AE-style per-mask **modes** as a **superset** |

So the "Mask" panel **is** Premiere's Opacity mask, surfaced as a first-class clip property instead of being
buried under an effect. The only intentional divergence is that we also offer After-Effects-style per-mask
**modes** (Add / Subtract / Intersect / Exclude) on top of Premiere's additive-only behavior — an enhancement,
not a difference in *where* the mask is applied.

---

## Mask tracking (make a mask follow motion)

A mask can **follow a saved motion track**, so e.g. a blur stays locked on a moving face without hand-keying
every frame.

1. Track a point first: editor **Track** panel → **Track a new point…** → track + save it (it lands in the
   project's track library).
2. Select the masked clip → **Masks** → the mask's **Tracking** row → pick the track in **Follow track** →
   **Attach**.
3. The mask now rides the track's motion. **Detach** removes just that track's mask keyframes.

How it works: Attach generates `scope:"mask"` `transform.x/y` keyframes from the track and adds them on top of
the mask's **current** position (so the mask keeps where you drew it and only follows the *motion*, relative to
the track's first frame). Tracking data is in **percent of the comp**; mask transform is in **comp pixels**, so
attach converts `delta% × compSize/100`. Because these are ordinary mask scalar keyframes, the motion renders
identically in the **preview, Remotion export, and local browser export** — no renderer-specific code
(`trackingPathToMaskTransformKeyframes` in `packages/shared/src/masks.ts`).

---

## Roadmap / phases

| Phase | Scope | Status |
| --- | --- | --- |
| **P1** | Vector masks — rect/ellipse/polygon/Bézier, modes, invert/feather/expansion/opacity | ✅ shipped |
| **P2** | Pen/Bézier authoring in-preview + scalar & shape keyframes, reorder, drag-to-move | ✅ shipped |
| **P3** | Effect-region masks — limit a **Blur** effect to a masked region (blend, no crop) | ✅ shipped |
| **P4** | **Mask tracking** — attach a saved motion track so a mask follows a moving subject | ✅ shipped |
| **P5** | **Effect-region parity** — region masks get the full clip-mask toolset (keyframes, transform, shape keys, mask tracking) | ✅ shipped (this) |
| **P6** | Region masks for **color / exposure** effects via a duplicate-layer **cascade** (multiple region effects stack in panel order) — preview, Remotion **and** local export. Region **glow** deferred (bloom-beyond-mask). | ✅ shipped (this) |
| **P7** | **Local-export parity gaps** — effect-region (blur) masks + 3D-tilt + mask in the exported file (clip masks already export) | ▢ planned |
| **P8** | **AI roto / SAM2** — point-prompt a subject → auto mask with per-frame propagation | ▢ planned |

Notes on the planned phases:
- **P6 (shipped)**: a render-time **duplicate-layer cascade** (`expandEffectRegionMasks` in `clip-masks.ts`)
  splits a media layer that has region masks on **color** (`COLOR_EFFECT_TYPES`) or **blur** effects into a
  base (those effects removed) + one duplicate per region effect, where each duplicate applies **all region
  effects up to and including itself** (panel order), clipped to its own region — so overlapping region effects
  stack (color+blur). Since clip masks + per-layer grading already render everywhere, this works in preview,
  Remotion and **local export** with no new compositor (applied at VideoPreview `renderedLayerEntries`, the
  `render-templates` manifest builder, and export `export-core`). When the layer **also** has its own clip
  masks, each region duplicate is clipped to **`region ∩ clip`** (region masks lead as the base group; the clip
  masks are appended with the first forced to `intersect`) so a region can't reveal anything outside the clip
  mask — exact for the common cases (single region, carved-hole / inverted clip masks); only a clip mask that
  *unions* several add-shapes combined with *multiple* region masks stays approximate (flat mask lists can't
  express `A ∩ (r0 ∪ r1)`).
- **P7 (superseded by Method 3 Phase 5)**: the old canvas2D exporter (`frame-compositor.ts`) couldn't do CSS
  blur, so it composited **clip** masks + (via P6) color/glow region masks but dropped effect-region **blur**
  masks and the 3D-tilt + mask combo. That exporter is retired — local export now runs through
  `apps/web/src/export/scene-frame-compositor.ts` → the shared `SceneCompositor`, the SAME GPU pass as the
  editor preview, so region blur/glow and 3D-tilt + mask now render in local export.
- **P8**: depends on the deferred SAM2 work (see `architecture.md` Person Extraction / Remove Person notes).
