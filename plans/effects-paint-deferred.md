# Deferred deep-engineering tasks (2026-07-17) — designs for the next session

These four were deliberately NOT shipped in the overnight auto-run: each needs surgery inside
parity-locked render paths, where a half-right implementation is worse than none. Designs below are
grounded in source. **All four are Fable-tier tasks** (per user directive: deep engineering goes to
Fable, not Sonnet).

## D1 — Track matte key (Premiere "use clip above as luma/alpha matte") — SHIPPED 2026-07-17

> Implemented per the design below (with two deviations: the matte RTT pool is DEPTH-INDEXED so
> chained mattes work, and the inspector control lives in the Transform section next to Blend, not a
> separate Video-tab section). See architecture.md "Phase C" for the shipped summary; `track-matte`
> pixel fixture at 0.000%.

Why deferred: the obvious CPU approach (bake the matte-source layer into a comp-space canvas and
feed `SceneLayerDraw.mask`) BREAKS the single-context export path, where media sources are
`SceneTextureSource` GPU textures (`getMediaGraded` returns textures, not canvases) — you cannot
`drawImage` a WebGLTexture. Luma mode would also need a per-frame `getImageData` readback (≈2M px).

Correct design (GPU, single shared implementation):
1. `TimelineLayer.trackMatte?: { mode: "alpha" | "luma"; invert?: boolean }` — the SOURCE is resolved
   at build time as the nearest layer ABOVE (next in the z-ordered `ls` array, skipping `__rfx_`
   clones) in `buildSceneDraws`.
2. New `SceneLayerDraw.matteFrom?: SceneLayerDraw` — build-scene-draws builds the source's full draw
   (`buildLayerDrawWithPasses`), attaches it to the consumer, and EXCLUDES the source from normal
   drawing (like `foldedIds`).
3. `scene-compositor.ts`: render `matteFrom` into a pooled comp-sized RTT (the nest/transition RTT
   machinery already exists), bind it as a second matte sampler in the layer composite shader with
   `uMatteMode` (0 = alpha, 1 = luma) + `uMatteInvert`, multiplied alongside the existing clip-mask
   term (the multiply site is the existing `mask` application, scene-compositor.ts ~95-136/356-358).
4. UI: an inspector Video-tab section "Track Matte" (mode select Off/Alpha/Luma + invert checkbox);
   dim the source clip in the timeline (like `is-disabled`) so it reads as consumed.
5. Gates: a new pixel fixture (shape-above-video luma matte) + `render:compare:pixels`.

## D2 — Texture paint / texture fill on text & shapes

Why deferred: fills are canvas-2D solid colors at `text-shape.ts:455` (glyphs) and `:524` (shapes);
adding an IMAGE fill needs the image decoded synchronously inside the shared rasterizer, which runs
in three environments (web main thread, export Worker without DOM, worker Chromium). The plumbing is
an async image resolver + raster-cache keying, not a one-line `createPattern`.

Design: `layer.fillTexture?: { assetId?: string; url?: string; fit: "cover" | "tile"; scale: number }`;
a caller-owned decoded-image pool handed into `SceneTextRasterizer` (mirrors `getMediaGraded`'s
environment-specific injection); in `drawTextLayer`/`drawShapeLayer` draw the fill image clipped by
the glyph/path alpha (`globalCompositeOperation = "source-in"` inside a save/restore, or
`createPattern` for tile mode); raster cache key must include the texture identity + fit + scale
(`contentStyleForKey`, scene-text-raster.ts:64). Remotion needs the image URL in the manifest
(carry `fillTexture` verbatim like `graphic`). Add a pixel fixture.

## D3 — Anchor points — SHIPPED 2026-07-17

> Implemented per the design below, plus a FIFTH pivot site the design missed: the clip-mask matte
> bake (`scene-mask-matte` rides the layer transform — an anchored clip's mask would land off the
> clip without it). Anchor is keyframable (`transform.anchor.x/.y`). Alt-drag of the viewer
> crosshair is NOT in yet (crosshair is display-only; edit via inspector) — Sonnet-safe follow-up.
> `anchored-media` fixture 0.000%. See architecture.md "Phase C".

Why deferred: the rotate/scale pivot is hardcoded to layer center in FOUR parity-locked paths —
GPU quad transform (scene-compositor.ts ~1222-1264, incl. 3D tilt), canvas-2D text/shape
(text-shape.ts:512-518), mask overlay math (VideoPreview.tsx ~4116-4135), and the viewer gizmos.
All four must move in lockstep or preview ≠ export.

Design: `transform.anchor?: { x: number; y: number }` (percent of the layer box, default 50/50 =
today's behavior, no migration); evaluation additive in `evaluateTimelineTransform`; each pivot
site becomes `center + (anchor - 50%) rotated/scaled`; keep `position` meaning the ANCHOR's comp
position (Premiere semantics) so moving the anchor shifts the pivot, not the image. Gizmos draw the
anchor as a crosshair, draggable with Alt. Pixel-gate a rotated+anchored fixture in all renderers.

## D4 — Transitions playing INSIDE nested clips (R2 step 3) — SHIPPED 2026-07-17

> Implemented per the design below (per-group pair map + mix draw at the incoming child's z-slot),
> plus an ambient-size resize on the pooled effect/side RTTs (latent bug: in-nest blur/mix rendered
> into a corner of comp-sized textures). `nested-transition` fixture 0.000%; `editor:test` green.
> See architecture.md "Phase C".

Already-shipped steps 1-2 mean nested clips render correct HARD CUTS (nothing vanishes, no
cross-nest false pairs). Step 3 (the mix actually playing inside the nest): in `buildGroupDraw`
(build-scene-draws.ts ~724-749), detect active pairs whose BOTH sides are members of this group
(reuse `activeByIncomingId` + the group's member set) and emit the transition mix as a member draw
at the incoming child's z-slot, scoped to the nest's dims — the same `from`/`to` group-build logic
as the top-level branch (~772-784). Needs a nested-transition pixel fixture.

## Smaller follow-ups (Sonnet-safe)

- Speed-ramp graph lane: bespoke `GraphTarget` kind `"speed"` backed by `layer.speedKeyframes`
  (linear-only — suppress bezier handles; the closed-form `integrateRamp` contract must hold);
  write path through the shared `upsertSpeedRampPoint` helper (already extracted, R5).
- Lanes view polish: marquee selection, live (sync-clock) playhead line, value tooltips on hover.
- Pen shapes: on-canvas POINT EDITING for `shapePath` after drawing (drawing shipped 2026-07-17;
  editing still targets masks only) — retarget the select-tool point/tangent drag in
  MaskEditorOverlay to `shapePath` when the layer is a pen shape.
- Insufficient-handle UX: zebra/warning stripes on the timeline junction pill when
  `resolveTransitionWindowSides` had to shorten a side below D/2 AND the other side lacks material
  (the only remaining repeated-frames case).
