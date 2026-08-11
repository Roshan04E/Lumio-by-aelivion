# Flarex node maturity — tracking, roto, keying

**2026-08-10 · audit, no code.** Scoping round against the founder's target recorded at the top of
`architecture.md`: Flarex is a real compositor, Fusion-equivalent in ~95% of the jobs its users
bring. Scope is 2D/2.5D; 3D geometry, lights, materials, mesh and particles are out and are not
reopened here.

The palette is not the question. `packages/shared/src/flarex/node-defs.ts` declares 39 node types
and the three families audited here account for 11 of them. The question is what each one can do on
a real shot, and the answer differs sharply between the three — one is nearly professional, one is
a competent tool wired to the wrong socket, and one is a shape editor being called a roto tool.

---

## 0. The one structural fact that explains most of the gaps

`compile-flarex.ts:189-195` defines the entire value vocabulary of the graph:

```ts
type FlarexImageValue = SceneLayerDraw | SceneGroupDraw;
type FlarexMatteValue = { masks: Mask[] };            // VECTOR — a list of outlines
export type FlarexValue =
  | { kind: "image"; draw: FlarexImageValue }
  | { kind: "matte"; matte: FlarexMatteValue };
```

**There is no image-matte in the graph.** A matte is a vector outline list, deliberately (the
comment says so: it stays vector "until applied to an image, so MatteControl combines losslessly").
That decision is correct for shapes and it is the reason MatteControl's booleans are exact. But it
means:

- The keyers (`chromaKey`, `lumaKey`) produce alpha **inside** an image and have `outputs: OUT`
  only. Their matte cannot leave the node. It cannot enter `matteControl`, cannot be blurred,
  cannot be combined with a garbage roto.
- `hslQualifier` — a qualifier, whose entire purpose in a compositor is to *make a matte* — also
  has `outputs: OUT`. It can only grade in place.
- `aiMatte` is declared with `outputs: MATTE_OUT` and then lowers to
  `degrade(at, node.id, "node-unimplemented")` (`compile-flarex.ts:1752-1754`). It cannot be
  implemented as declared: a mask sequence is a per-frame *image*, and the matte channel cannot
  carry one. The unimplemented case is not neglect, it is the type system refusing.

Every "usable on a real job" gap below eventually reaches this. It is named here once, and each
slice is scoped to **not** require solving it, so that the three slices stay small. Solving it is a
fourth, larger piece of work — see §5.

---

## 1. Tracking

### What is actually implemented

Better than the node suggests, and wired somewhere the node cannot reach.

**The analysis is real and is genuinely good.** `apps/web/src/tools/local-tracking.ts` is a
from-scratch NCC point tracker: a patch template anchored once (rigid, not adaptive, so it does not
drift silently), velocity prediction, normalized cross-correlation search, a 2-level pyramid in
"quality" mode, sub-pixel refinement by parabola fit on the NCC scores, a confidence floor
(`MIN_CONFIDENCE = 0.55`), a widening search window while lost, and semantic re-acquisition through
the segmenter after 5 consecutive low-confidence frames. It runs in a Web Worker with an inline
fallback.

`apps/web/src/tools/track-cleanup.ts` is better still: it re-opens the video and gathers three
independent evidence signals per frame — stored NCC confidence, **forward-backward round-trip
consistency**, and subject grounding via the detector — then fuses them through a Kalman/RTS
smoother. That is the honest-confidence loop `TRACKER_RESEARCH.md` recommends copying from Blender,
and it is already built.

There is a workspace (`TrackWorkspaceModal.tsx`, which reuses the Smart-Follow-Text panel in
`trackOnly` mode) and a track library (`lib/trackLibrary.ts`).

**The node is a consumer, not a tracker, and says so.** `tracker` (`node-defs.ts:646-675`) takes
`trackingPathId` (provenance) + `trackingPathData` (the track embedded as JSON, so it reaches the
manifest and therefore both renderers) + `smoothing`. `FlarexTrackPicker.tsx` attaches a saved
track. The lowering (`compile-flarex.ts:1772-1804`) samples the path at the evaluation time and
*composes* a delta onto the shell transform:

```ts
wrap.shell.transform = { ...base, x: base.x + sample.dx, y: base.y + sample.dy,
                         scale: base.scale * sample.scale, rotation: base.rotation + sample.rotateZ };
```

The file headers are unusually honest about all of this ("Deliberately NOT a tracking UI",
"It does not ANALYSE"). Take them at face value; they are accurate.

### Distance from the bar

The bar: sub-pixel, forward **and** backward, survives occlusion with gaps rather than losing the
track, and the result is **applicable** — match-move onto a transform, stabilize, and drive a mask.

| | State |
|---|---|
| Sub-pixel | **Yes.** Parabola fit on NCC scores. |
| Forward | Yes. |
| Backward | **No.** `startTimeSeconds` only trims the front; tracking always runs to the end. There is no reverse pass. `track-cleanup` does forward-backward re-tracking *between adjacent frames* as an error metric — that is not the same thing and does not give you a track that runs backwards from a mid-shot anchor. |
| Occlusion | **Partial, and better than most.** It coasts on the smooth-motion prior, widens the search, and re-acquires semantically. What it does not do is *record a gap* — a low-confidence stretch produces points, not holes, so the track claims knowledge it does not have. That is the one Blender practice most worth copying and the one not copied. |
| Applicable → match-move | **Yes,** translation only. |
| Applicable → stabilize | **No.** No inverse mode anywhere. |
| Applicable → drive a mask | **No.** The tracker outputs an image; masks output a matte and have no transform input. The two cannot meet. |
| Rotation / scale | **Structurally present, always identity in practice.** `TrackingPoint` carries `scale`/`rotateZ`/`rotateX`/`rotateY` and `sampleTrackingPathAt` reads them, but `local-tracking.ts` never writes them — its header explains the earlier corner-tracker was removed because per-corner noise was amplified into fake rotation swings. So `sample.scale` is always 1 and `sample.rotateZ` always 0. The node's scale/rotation composition is dead code against every track this app can produce. |
| Planar | **No,** and correctly refused for now (`TRACKER_RESEARCH.md` puts it in Track A, not first). |

**Blunt version:** the tracker analyses well and applies badly. It can do exactly one thing with a
track — nudge an image sideways — and a compositor needs three.

### First slice — *A track drives more than a transform*

Make the existing track applicable. No new analysis, no new model, no CV work.

1. `tracker` gains `mode: "matchMove" | "stabilize"`. Stabilize negates `dx/dy` and applies an
   auto-scale (a `1 + maxExcursion` fit, computed from the path's own bounding excursion) so the
   frame edges do not swim into view. Two params and a sign flip against a path that already exists.
2. `rectMask` / `ellipseMask` / `polygonMask` / `bezierMask` gain the same
   `trackingPathId` + `trackingPathData` pair the Tracker node already has, attached with the same
   `FlarexTrackPicker`. The lowering offsets the mask's points (or centre, for rect/ellipse) by
   `sampleTrackingPathAt(path, at).dx/dy` before building the `Mask`. Mask points are already
   comp-fraction and already resolved per frame, so this is an addition inside the existing
   `case "polygonMask"` body, not a new mechanism.
3. Surface mean confidence on the node, not just in the picker — a track that reads 61% should say
   so where it is being used.

**Excludes, deliberately:** backward tracking; gap recording; planar / corner-pin; rotation and
scale channels; running the tracker *from* the node; any change to the tracker's own algorithm.

**Renderer or editor:** neither, exactly — **shared-compiler**. All of it lands in
`compile-flarex.ts` and `node-defs.ts`, which both `VideoPreview.tsx` and
`apps/worker/src/remotion/Root.tsx` reach through `build-scene-draws.ts`. Parity is structural, and
the track payload is already embedded in node params precisely so the manifest carries it. Still
needs `render:compare:pixels` with a tracked-mask fixture — structural parity is an argument, not
evidence.

---

## 2. Rotoscoping

### What is actually implemented

A shape editor. Not a roto tool.

`polygonMask` / `bezierMask` (`node-defs.ts:448-477`) store `points` as a **JSON string of `[x, y]`
fraction pairs**, plus `feather` and `invert`. `keyframeable: ["feather"]`. The lowering
(`compile-flarex.ts:1710-1724`) parses the string, multiplies by comp size, and builds one `Mask`
through the shared `createMask`.

`rectMask` / `ellipseMask` are better off: `centerX`, `centerY`, `width`, `height`, `feather` are
all keyframeable. **The two shapes that can animate are the two that cannot do roto; the two that
can do roto cannot animate.**

`matteControl` gives real boolean combination — add / subtract / intersect / exclude — by
concatenating mask lists with modes, exact for add-combined and documented as approximate for mixed
chains.

The editing UI is good. `flarex-mask-bridge.ts` presents a mask node as a synthetic `shape` layer so
the app's real `MaskEditorOverlay` (point drag, edge insert, double-click delete, marquee) edits it.
Its header names its own limit rather than hiding it: **tangents are dropped on commit**, because
the node param is `[x, y]` pairs and `MaskPoint` carries `inTangent`/`outTangent`.

**The substrate for real roto already exists one level down, in the clip mask system:**
`packages/shared/src/types.ts` has `MaskPoint` with tangents, `MaskPathKeyframe`
(`{ timeSeconds, points, interpolation }`), `Mask.expansion`, `Mask.opacity`, a per-mask
`transform`, and `pathKeyframes`. `clip-masks.ts:155` `getMaskPathAtTime` interpolates the outline
with per-point tangent lerp and holds when point counts differ. Clip masks can be animated. Flarex
mask nodes cannot, and they are the ones inside the compositor.

### Distance from the bar

The bar: bezier shapes with **per-point animation**, feather (ideally per-point), several shapes
combined with booleans, shapes attachable to a track, motion blur.

| | State |
|---|---|
| Bezier curves | **Renders curved, cannot be authored curved.** The rasterizer honours tangents (`clip-masks.ts:236-249` emits cubic segments when any point has one); the node param cannot store them, so a `bezierMask` is a closed polyline through dragged points. Pull a handle and the edit is silently discarded on commit. |
| Per-point animation | **None.** `points` is a string param; only `feather` keyframes. This is the line between a mask and a roto tool, and Flarex is on the wrong side of it. |
| Feather | Per-mask only, one scalar, converted to px. No per-point feather. No `expansion` exposed at all, though `Mask.expansion` exists and the rasterizer reads it. |
| Booleans | **Yes**, via `matteControl`. The strongest part of the roto story. |
| Attach to a track | **No.** See §1. |
| Motion blur | **None anywhere in the mask path.** The only `motionBlur` in `masks.ts` is a layer effect on follow-text. |

**Blunt version:** you can draw a shape and you can boolean two shapes. You cannot animate one. On
any shot where the subject moves — which is every roto shot — the tool has nothing to offer.

### First slice — *Animatable bezier shapes*

Give the mask node the shape payload the rest of the codebase already understands.

1. Change the `points` param from `[[x,y], …]` to a point record carrying optional tangents
   (`[x, y, inX, inY, outX, outY]`, or an object form — the 6-tuple keeps the JSON compact and the
   parse cheap). Keep the 2-tuple readable as a legacy shape so saved comps do not break; the
   compiler's `parseFractionPoints` already soft-fails and the bridge already mirrors it.
2. Add a `shapeKeyframes` param holding `MaskPathKeyframe`-shaped snapshots in comp fractions, and
   evaluate it in the lowering with the **existing** `getMaskPathAtTime` — same hold-on-count-
   mismatch rule, same tangent lerp, one shared evaluator for clip masks and node masks.
3. Stop discarding tangents in `flarexMaskPointsToParam`, and give the overlay a diamond
   set-key/next/prev affordance for the outline, matching `MaskItemBody`'s existing one.
4. Expose `expansion` as a keyframeable node param — the rasterizer already reads it and choking a
   roto edge is a daily operation.

**Excludes, deliberately:** per-point feather; motion blur; shape morphing across differing point
counts (holds, per the existing MVP rule); planar-tracked roto; any automated roto.

> **SHIPPED 2026-08-10.** All four items landed. The payload is `mask-shape.ts`'s tuple form (2-tuple
> corner, 6-tuple corner+handles, legacy payloads still read); `shapeKeyframes` resolves through the
> shared `getMaskPathAtTime`; the bridge preserves tangents in both directions and the inspector has a
> `KeyframeButtons` diamond; `expansion` is a keyframeable param.
>
> One thing this slice had to fix that the scoping did not anticipate: **`computeFlarexContentHashes`
> hashed the keyframe track as a constant string.** ADR-009 R1 resolves *numeric* drivers to values, and
> a track that arrives as JSON has no numeric form, so an animating node's content hash was identical at
> every time — and the node-thumbnail cache keys on `(ContractVersion, contentHash)` with no time axis.
> That would have frozen every thumbnail of an animated mask on its first rendered frame: DEBT-016's
> class exactly. Fixed with a def-declared `trackParams` list and a time term folded only when a track
> is actually present (static nodes hash unchanged), plus a ContractVersion bump to 2. Gate:
> `pnpm --filter @orreris/shared maskShape:test`, §4.
>
> **SLICE 1b, 2026-08-11 — the curve was storable but only half-authorable.** A browser pass over the
> editor found that of the two gestures that create a tangent, only one reached the graph. Alt-DRAG
> (pull-out) worked already: its `shape: "bezier"` promotion is skipped for a mask that is already
> bezier/polygon — which the bridge's synthetic mask always is — so it fell through to
> `commitPointsFor`. Alt-CLICK (the corner⇄smooth toggle) did not: it writes through
> `onUpdateLayerMasks`, which the bridge has passed as `undefined` since it was built (2026-07-30).
> The withholding is pre-existing and was harmless while tangents were discarded on commit anyway;
> slice 1 is what made it load-bearing. Fixed with an explicit `geometryOnly` mode on
> `MaskEditorOverlay`, taking `commitPointsFor` for node masks and leaving the clip-mask write
> textually unchanged.

**Renderer or editor:** **shared-compiler + editor.** The evaluator is shared and reaches both
renderers through `build-scene-draws.ts`; the keying affordance is editor-only. The rasterizer needs
no change — it already draws cubics. `render:compare:pixels` with an animated-bezier fixture is
mandatory: this is the first Flarex node whose *geometry* varies per frame, and a preview/export
disagreement here would be exactly the class of bug CLAUDE.md warns about.

---

## 3. Keying

### What is actually implemented

The best of the three by a wide margin, and the closest to shipping.

`FLAREX_CHROMA_KEY` (`packages/shared/src/color/fragment-effects/builtins.ts:292-408`) is a real
three-pass keyer, not a distance threshold:

- **matte pass** — a genuine colour-difference matte in BT.601 CbCr. It projects the pixel's chroma
  onto the key direction (`along`) and off it (`across`), takes `keyness = max(along - across, 0)`,
  normalizes by the key's own saturation, and keeps it **linear** in between — the property that
  keeps hair edges translucent. Then screen levels (`clipBlack`/`clipWhite`) and a smoothstep blend
  for softness.
- **edge pass** — a 5×5 Gaussian on the matte with a **frame-relative** radius defined at a 1080p
  short edge, so proxy, preview and export paint the same picture-space edge; then choke levels that
  eat the fringe (positive) or grow the matte back (negative).
- **final pass** — luma-preserving despill (project the key hue out of the chroma plane, rebuild
  RGB from untouched Y, so no darkening) plus **edge decontamination** by screen subtraction:
  `unmix = (despilled - keyColor * (1 - m)) / max(m, 0.08)`, so green leaves the hair rather than
  being dimmed.

That is a defensible Delta-Keyer-lite. `matteOnly` lets you tune against the matte.
`FLAREX_LUMA_KEY` is a straightforward two-sided smoothstep with invert — fine for what it is.

### Distance from the bar

The bar: screen-colour **sampling**, spill suppression / despill, edge handling, and matte cleanup
on a **separate matte output**.

| | State |
|---|---|
| Colour-difference matte | **Yes**, and properly linear. |
| Despill | **Yes**, luma-preserving, plus decontamination. Genuinely above the usual browser-keyer bar. |
| Edge handling | **Yes** — frame-relative feather + choke, and the frame-relative part is a real correctness win most implementations get wrong. |
| Screen sampling | **No.** `color` is a hex swatch defaulting to `#00b140`. You type a colour and guess. There is an eyedropper *icon* (`flarex-node-icons.tsx:205`) and no eyedropper. |
| Garbage / hold-out matte | **No.** The node has one input (`image("in")`) and no matte socket, unlike every colour node, which all take `matte("mask")`. |
| Separate matte output | **No.** `outputs: OUT`. `matteOnly` replaces the image with the matte rather than emitting one alongside — you can look at the matte, you cannot use it. |
| Matte cleanup as ops | Partially, and only *inside* the node (choke, edge softness). No erode/dilate/blur/gamma reachable as graph operations, because §0. |
| Clean plate / screen correction | **No.** Uneven screen lighting has no answer. |

**Blunt version:** the shader is close to professional and the node around it is a dead end. On a
real greenscreen — a stand in frame, a floor seam, an uneven screen — there is no way to garbage it
out, and no way to get the matte anywhere.

### First slice — *Sample the screen, gate the key*

Make the good shader usable on a shot that is not a perfect studio plate. Both halves avoid §0.

1. **Eyedropper.** Pick the key colour from the viewer — the pixel under the cursor in the Flarex
   source viewer, written into the `color` param. The icon already implies it exists. Sample a small
   average (3×3) rather than a single pixel; single-pixel sampling on compressed footage picks up a
   macroblock artefact and the user cannot tell why the key is worse than the one they typed.
2. **Garbage and hold-out matte inputs.** Add `matte("garbage")` and `matte("holdout")` sockets,
   using the vector matte channel that already works. Garbage forces alpha to 0 inside the shape,
   hold-out forces it to 1 — both applied through the same `rasterizeMatte` + region-pass machinery
   the colour nodes already use for `matte("mask")`. This is the single change that turns the keyer
   from a demo into a tool, and it costs no new value kind.
3. **A screen-levels readout** while `matteOnly` is on — how much of the frame is fully
   transparent, fully opaque, and in between. Tuning `clipBlack`/`clipWhite` by eye against a grey
   ramp is guesswork.

**Excludes, deliberately:** the matte-output socket and everything that needs it (§0); clean-plate /
screen correction; light-wrap; a difference keyer (needs two image inputs — `SceneFragmentPass`
`auxInputs`, already fenced in `FLAREX.md` Part 4); any change to the three-pass shader itself.

**Renderer or editor:** **shared-compiler + editor.** Sockets and lowering are shared and reach both
renderers; the eyedropper and the readout are editor-only. `render:compare:pixels` with a
garbage-matted key fixture.

---

## 4. Recommended order

**1 · Roto (animatable bezier shapes) → 2 · Tracking (a track drives more than a transform) →
3 · Keying (sample the screen, gate the key).**

The reason is compounding, and it runs in exactly that direction:

- **Roto is first because it is the worst and because it is a dependency of the other two.** It is
  the only one of the three that fails on the *ordinary* case rather than the hard case — a subject
  that moves. It is also the cheapest relative to its impact: the whole evaluator
  (`getMaskPathAtTime`, tangent lerp, `MaskPathKeyframe`) exists and is shipped for clip masks; the
  slice is mostly a param-shape change plus a call to code that already runs in production.
- **Tracking is second because it is nearly worthless before roto and clearly valuable after.**
  Attaching a track to a mask is the payload of slice 2, and until slice 1 lands there is no mask
  worth attaching one to — a tracked static polygon is a static polygon. Run the other way and slice
  1's animated shapes have to be hand-keyed every few frames, which is the difference between a
  usable roto tool and a tedious one. The founder's framing — a shape attached to a track is worth
  more than either alone — is exactly right, and the ordering follows from it.
- **Keying is third because it is already the strongest** and because its slice is *improved* by the
  first two, not blocked by them: the garbage and hold-out inputs in slice 3 take mattes, and after
  slice 1 those mattes can be animated bezier shapes, and after slice 2 they can be tracked. Ship
  keying first and its headline feature accepts only static polygons.

The sequence therefore produces, at the end, a thing none of the slices delivers alone: **an
animated bezier garbage matte following a track, gating a professional keyer** — which is a real
screen-replacement and cleanup workflow, and those are two of the named target jobs.

---

## 5. Constraints checked

**2D/2.5D.** Nothing proposed needs a 3D system. Rotation and scale channels are explicitly left out
of slice 2, and planar/corner-pin tracking is deferred to `TRACKER_RESEARCH.md` Track A rather than
smuggled in.

**ADR-021 neutrality — all three slices are neutral, with one flag.** None of them constructs a
`MediaIn`, a synthetic timeline layer, or a decoder session; they operate on values already inside
the graph. The flag is for a *later* slice, not these: if the tracker's **analysis** ever moves into
the node (tracking from the Flarex page rather than from `TrackWorkspaceModal`), it must consume a
`FrameProvider` (`apps/web/src/export/source-decoder.ts`) and not the fake-layer bridge. Today
`local-tracking.ts` reaches frames through an HTML `<video>` element and `seekVideo`, entirely
outside the MediaIn path, so it neither helps nor hinders removing the bridge. Note also that
tracking is random access over a source, which ADR-021 §3.2(b) measured at ~100× budget — a
node-hosted tracker is a frame-cache and scheduling problem before it is a CV problem.

**Both renderers or neither.** Every pixel-affecting change in all three slices lands in
`compile-flarex.ts` / `node-defs.ts` / the fragment-effect builtins, which are shared and reach
`VideoPreview.tsx` and `apps/worker/src/remotion/Root.tsx` through the one compile site in
`build-scene-draws.ts`. That is parity by construction, which is an argument and not evidence — each
slice carries a `render:compare:pixels` fixture, and slice 1's is non-negotiable because it is the
first Flarex node whose geometry varies per frame.

**Real shaders and real algorithms.** No CSS or canvas fakes are proposed. The keyer work adds no
shader at all; the roto work adds no shader (the rasterizer already emits cubics); the tracking work
adds no shader.

**Not proposed here, and why.** The image-matte channel (§0) is the largest single unlock across all
three families — it is what `aiMatte` needs to exist, what a matte-out socket needs, what matte
erode/dilate/blur as graph nodes need, and what an HSL qualifier needs to be a qualifier rather than
a grade. It is deliberately not one of the three slices: it is a change to `FlarexValue`, to
`matteControl`, and to how mattes rasterize, and it would swallow all three of these slices into one
piece of work that ships nothing until it all ships. It should be its own scoping round, informed by
having shipped these three.
