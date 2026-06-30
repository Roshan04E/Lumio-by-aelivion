# ReelForge Architecture And Progress Tracker

Last updated: 2026-06-29

This file is the working architecture and product tracker. Keep it crisp:

- what is already shipped
- what is intentionally deferred
- what we are building next
- what future business/AI paths must not be forgotten

## Product Direction

ReelForge is a browser-first video editor for short-form creators.

It should feel simple for normal users, but familiar enough for Premiere Pro and After Effects users:

```text
Assets -> Timeline -> Project Graph -> Render Manifest -> Renderer Adapter
                                             -> Web preview
                                             -> Browser export
                                             -> Local desktop render
                                             -> Cloud worker render
```

The render manifest is the product contract. Every renderer should consume deterministic data so preview, export, local render, and cloud render stay aligned.

## Two Usage Paths

ReelForge must support two different user realities.

### Path 1: Free Prompt Bridge

For users who cannot pay for integrated AI:

```text
User opens a tool
  -> ReelForge generates a precise prompt/schema
  -> user copies it into their own chat agent
  -> chat agent returns transcript/captions/JSON/etc.
  -> user pastes the result back into ReelForge
  -> ReelForge validates it and applies editable timeline data
```

This path must stay first-class, not treated like a hack. It is important for students, middle-class creators, low-budget editors, and users who already have access to free chat tools.

### Path 2: Integrated AI

For users who want convenience:

```text
User asks ReelForge chat
  -> AI chooses a tool
  -> AI fills params
  -> user confirms
  -> adapter runs browser/cloud/local work
  -> artifacts become editable timeline data
```

The same tool capability registry powers both paths.

## Future Pricing Direction

Do not implement pricing yet.

Keep these future modes in mind:

- Free/manual: user copies prompts to external AI and pastes output back.
- Subscription: integrated AI/chat convenience and higher limits.
- Pay per output: one-off render/transcription/masking jobs.

During product build:

- credits are metadata only
- no subscription dependency
- no hard credit blockers
- all tool results must remain editable

## Current Shipped Foundation

### App Foundation

[x] pnpm workspace.

[x] Node backend.

[x] Vite web frontend.

[x] PostgreSQL and Redis Docker services.

[x] API, worker, shared packages, render templates, and web app are split.

### Editor

[x] Filmora/Premiere-inspired editor layout.

[x] Resizable panels.

[x] Slim editor header.

[x] Asset bin with upload, delete, filters, view modes, size modes, drag-to-timeline, double-click add, replace clip, and used markers.

[x] Media Library (Phase 1): unified SourceAsset metadata (source/folder/tags/external/ai/thumbnail/cloudUrl); Local/AI/Stock/Brand/Used tabs; type filters + search; redesigned cards with type + source badges, meta, and a More menu. Stock import (Pexels/Pixabay) is real + env-gated — the server downloads the file into our storage before timeline use (never a remote URL). Timeline-generated assets: "Save freeze frame" + tagged tool mattes. Optional per-asset "Upload to cloud" remaps clips to a server copy for cloud render. See MEDIA_LIBRARY.md.
[x] Media Library (Phase 2 — footage-first cards): fluid CSS-column masonry that preserves each asset's true width:height (measured on load when dims are missing); hover-to-play video previews; icon type chips + hover-only name/meta/action overlay (icon add buttons, not text); audio compact cards; List + S/M/L view controls on Local and Stock tabs; reduced-motion guard. See MEDIA_LIBRARY.md "Card / grid".

[x] Universal visual tracks and audio tracks.

[x] Timeline track controls: lock, hide, mute, delete.

[x] Add text, image, shape, visual track, audio track, and adjustment clip flows.

[x] Timeline row density supports XS/S/M/L/custom.

[x] Timeline navigation supports Shift + wheel horizontal pan and Alt + wheel cursor-anchored horizontal zoom.

[x] Timeline ruler, lane grid, clips, playhead, scrubbing, dragging, and keyframes share the same horizontal zoom scale.

[x] Timeline ruler/playhead sync is fixed, including XS row mode.

[x] Timeline playhead is smooth and spans the track area correctly. **Playback no longer hitches** (2026-06-28): the render-status poll (`EditorPage.tsx`) was rebuilding the `project` object every 1.5s for a stuck render job → full editor re-render → periodic ~300ms freeze; it now returns the same reference when nothing render-related changed (no-op re-render).

[x] Timeline playback follows the playhead with smooth horizontal viewport scrolling. **Rewritten 2026-06-28** (`TimelineStrip.tsx`): the per-frame auto-follow uses cached geometry (`followGeomRef`/`measureFollowGeom`, refreshed by a ResizeObserver on dock+lane) instead of two `getBoundingClientRect` calls per animation frame — no forced synchronous reflow. The old dead-zone "drift to 84% then ease back to 64%" sawtooth (jumpy/stop-motion) is replaced by **continuous pinned follow** (`PIN_FRAC = 0.88`): the playhead glides to ~88% of the viewport, then holds while the content scrolls in lockstep with its clock-driven motion.

[x] Timeline toolbar stays fixed during horizontal scrolling; clip link/unlink actions live beside undo/redo.

[x] Viewer renders real timeline layers.

[x] Viewer pan, zoom, fit width, fit height, 50%-400% presets, ctrl-wheel zoom, and mouse pan controls.

[x] Viewer selection handles, resize, rotation, and deselect behavior.

### Render And Preview

[x] Render manifest foundation exists.

[x] Remotion worker render path exists.

[x] Render jobs store manifest snapshots.

[x] Manifest download exists.

[x] Web preview and Remotion export share composition style helpers.

[x] Pixel comparison test exists between Remotion frame and web preview frame.

[~] Web preview still primarily receives editable `TimelineComposition`; direct manifest-preview renderer is still needed.

[ ] Browser export renderer is not built.

[ ] Local desktop renderer is not built.

[~] **Method 3 — single GPU compositor (Phases 1/2/4.1/4.2 done; DEFAULT now "scene").** North-star: collapse the three renderers' divergent *composite* step (preview DOM siblings / export canvas2D / Remotion Chromium) into ONE GPU pass so preview IS the export. The per-clip grade was already unified (`MediaWebGLRenderer`); Method 3 adds the missing composite: `packages/shared/src/color/scene-compositor.ts` (`SceneCompositor` — one WebGL2 context, ping-pong RTT accumulator, object-fit + clip mask + 16 in-shader blend modes via `blend.ts` + element-box/3D transform), on shared plumbing `gl-context.ts`. Wired into `VideoPreview.tsx` via `getCompositorMode()`. **Phase 1** media composite; **Phase 2** GPU blur + glow (plate-RTT + separable premultiplied Gaussian + glow drop-shadow; one mechanism covers whole-clip AND region blur); **Phase 4 v1** text/shape rasterized INTO the pass (`scene-text-raster.ts`/`scene-mask-matte.ts`); **Phase 4.1** self-sufficient text/shape — resolution-aware box raster (4.1), transform-independent raster (4.1b), generalized element-box + 3D composite quad (4.1a), text/shape color-grade (per-layer `MediaWebGLRenderer`) + clip-mask + 3D in the pass (4.1c), all DOM fallbacks dropped (4.1d, only a runtime GL failure reverts); **Phase 4.2** junction transitions folded into the pass (per-junction `TransitionCompositor` mix fed as one scene layer; DOM `TransitionOverlay` suppressed in scene mode). Also: clip masks on text/shape now render in DOM preview + Remotion + local export too (comp-space mask wrapper — they never did before); colour/grade effects are now apply-able to text/shape in the inspector (`effects.ts` `compatibleLayerTypes`). **Default flipped dom→"scene" (2026-06-29)** after the prior same-day revert's causes were fixed: the empty-gap **background flash** is gone (the scene canvas is ALWAYS mounted — `sceneEnabled`, decoupled from `visualCount` — so it owns the background every frame; the DOM empty-frame is suppressed in scene mode), preload/cut handling + stale warp key fixed, media is click-selectable in the preview again (`opacity:0` interactive-hidden, not `visibility:hidden`), and perf is event-driven (idle = a timestamp check; per-source texture cache). Escape hatch: `?compositor=dom` / `localStorage` / `VITE_COMPOSITOR_MODE`; WebGL2-gated + `sceneFailed` runtime fallback. **Phase-1.5 export WebGL-context budget (stable, 2026-06-30):** scene-mode local export runs on the main thread, so its contexts stack on the live preview's and can cross the browser's ~16 cap → preview eviction + console spam. Fixed by: preview GPU suspended during export (`export-preview-suspend.ts` + `local-export.ts` begin/end wrap + `ScenePreviewCanvas` rAF guard), a media-renderer **free-list pool** in `scene-frame-compositor.ts` (`MAX_POOLED_MEDIA_RENDERERS=2`, `SAFE_CONTEXT_THRESHOLD=8`, peak counter — caps live media contexts at ~1–2 active reused across all clips, not one-per-clip), and `[export-gl]` telemetry (`export-gl-debug.ts`, gated by `?exportGlDebug=1`). **Gates green:** `blend:test`; `scene:compare` (DOM-vs-scene) incl. masked-blur 0.000%, transition 0.246%, graded/masked/tilted-text ~0.4–0.6%; `render:compare:pixels` (now scene↔Remotion); `export:stress` (isolated 24-clip compositor sweep — pool bounds contexts, returns to baseline); `export:live-stress` (real-world: live `ScenePreviewCanvas` + real `exportLocally` ×3 over a 24-clip bloom/blur/grade comp — peak 7 ≤ 14, suspend observed every export, preview never fell back, 0 lost-context, contexts released to baseline). **Phase 2 local export (complete, 2026-06-30):** scene-mode local export now defaults to the Worker + single-context `SceneCompositor` (`exportSingleContext` and `exportWorkerScene` default ON, with query/localStorage/Vite-env rollback overrides); Worker failure or the black-frame guard falls back to the stable main-thread scene export, which still uses preview suspend. **Phase 5 (complete, 2026-06-30):** the canvas2D `FrameCompositor` is retired — `SceneFrameCompositor` is now the ONLY local export compositor. `frame-compositor.ts` + its `quad-3d.ts` 3D helper are deleted, the `exportCompositor` frame/scene flag + both canvas2D fallbacks (construct-error + per-frame render-error) are gone, and the `export:compare:scene` frame↔scene migration scaffold (+ its `ExportFixturePage` route) is removed. Local export now has exactly two paths: **Worker `SceneFrameCompositor` (default) → main-thread `SceneFrameCompositor` fallback** (no canvas2D anywhere). Export parity is held permanently by `export:worker-scene` (Worker scene vs main-thread scene reference) and `scene:compare` (scene preview vs DOM, which transitively covers the export since it shares the preview's draw-list + compositor); re-verified green with `render:compare:pixels`, `pnpm -r typecheck`, and `@reelforge/web` build. **Remaining:** Phase 6 (Remotion/cloud convergence) — not started. Plan: `~/.claude/plans/we-re-building-lumio-moonlit-beacon.md`.

### Effects

[x] Shared effect registry.

[x] Schema-driven effect controls.

[x] Effects tab with search.

[x] Drag/drop effects onto compatible clips.

[x] Incompatible drops are rejected.

[x] Basic Color Correction includes exposure, contrast, highlights, shadows, whites, blacks, saturation, vibrance, temperature, tint, and lightweight curves.

[x] Effect params can be keyframed.

[x] Adjustment clips exist and can affect lower visual layers.

[~] Grain, Vignette, and Chroma Key are manifest-ready but need stronger render implementations.

[x] Effect reorder: drag-and-drop handle on each effect card in the Controls tab; `reorderEffect` timeline action in `packages/shared/src/timeline-actions/actions/effect.ts` (undoable, used by the AI registry).

[ ] Save/load effect presets are not built.

[x] Transitions — **unified GPU two-texture engine** (2026-06-26). Every junction transition is now a single GL-Transitions–style fragment shader that samples BOTH clips (`getFromColor`/`getToColor`) by eased `progress` + named params, so old and new transitions behave identically and advanced cross-clip effects are possible. Registry + shader assembler: `packages/shared/src/color/transitions/registry.ts` (`TransitionDefinition`, `buildTransitionFragmentShader`, `applyTransitionEasing`). GPU primitive: `packages/shared/src/color/transition-compositor.ts` (`TransitionCompositor`, per-id program cache + pre-warm). Shared window detection/progress: `findTransitionPairs` + `getActiveTransition` in `composition-style.ts` (one implementation for all 3 renderers). Catalog (Basic): Cross Dissolve, Dip to Black/White/Color, Slide ×4, Push ×4, Zoom in/out, Wipe ×4, Iris in/out. **Creator pack**: Punch Zoom, Smooth Zoom Blur, Whip Pan ×4, Blur Swipe ×2, Flash, Camera Shake, Spin. **Cinematic**: Luma Fade, Light Leak, Film Burn, 3D Parallax Push ×2. **Glitch**: Glitch (RGB split), Pixelate. **Mask**: Circle/Box/Diamond Reveal. Transition stays **pure metadata** on `TimelineLayer.transitionIn` (kind=registry id, `params`); zero clip-length/position mutation (handle model preserved). Wiring: web preview `TransitionLayer.tsx` (two headless `WebglMediaLayer`s via `onGradedFrame` + overlay compositor, interleaved at the clips' track z), browser export via the shared `SceneCompositor` (the junction `TransitionCompositor` mix is fed in as one scene layer — Phase 4.2), Remotion `TransitionLayerRemotion` in `Root.tsx` (windowed Sequence on top). Per-clip edge fades (fadeIn/fadeOut) remain keyframe-driven (no second clip). Each clip's **object-fit** (cover/contain/fill) is applied inside the mix shader (per-texture UV remap, `uFromFit`/`uToFit`) so the transition's incoming/outgoing sides render with the same geometry as the clips normally do — no squeeze/jump at the window boundary (fixed 2026-06-27). **Known limitation:** per-clip *transform* (scale/position/rotation keyframes) is still not applied during the transition window — only object-fit; a clip with a non-identity transform may still shift at the boundary (separate, larger follow-up). The old keyframe transition path (`buildTransitionAnimations`) is retired for junctions. Deferred (infra-gated): Speed Ramp (timeline time-remap), Beat Sync (audio analysis), Person/Object/Subject reveal (real masks), AI Smart/Match/Reference (LLM planner). Deferred (UX): junction params popover; drag-from-gallery onto a junction.

[x] Effects tab redesigned Adobe-style: a searchable collapsible **folder tree** (Video/Text/Audio/Transition/AI) with a live search and per-item **favourite star** (a pinned Favourites bin, persisted in localStorage). `apps/web/src/components/EffectGraphPanel.tsx`. The "Show more" transition gallery is grouped into 8 industry-standard categories (Essentials / Slide & Push / Zoom & Spin / Whip & Blur / Wipes & Reveals / Glitch / Cinematic / Impact) with filter chips + labeled sections (`catalog.ts` `transitionGalleryCategories`).

[x] **Pro IA redesign — right Inspector shell** (2026-06-27). The editor moved to the industry-standard layout: Left (browse: Assets / Effects / Color / Settings) · Center (Preview) · **Right (Inspector)** · Bottom (Timeline). Clip properties (Transform/Opacity/Blend/3D/graph editor/effects stack via `inspectorRegistry` + `LayerInspector`) relocated out of the cramped left "Controls" tab into a dedicated, resizable right `editor-inspector` column (`--right-pane-width`, persisted); it's driven by selection (empty state otherwise). `EditorPage.tsx` grid + `global.css` `.editor-main`/`.is-panel-expanded`/`.editor-inspector`.

[x] **Blend modes** (2026-06-27): new `TimelineLayer.blendMode` (`BlendMode` union) with one mapping for all 3 renderers — CSS `mix-blend-mode` (preview + Remotion via the shared style functions) and canvas `globalCompositeOperation` (browser export), helpers `cssBlendMode`/`canvasBlendOp` in `composition-style.ts`; carried in the render manifest; control is a dropdown next to Opacity in `TransformPanel`.

[x] **Timeline track headers + Solo** (2026-06-27): bigger headers (prominent V1/A1 name + type chip), and a new **Solo** (`TimelineTrack.solo`) alongside Lock + Mute/Hide. Solo + mute resolve through one shared helper `isTrackEnabled(track, allTracks)` used by preview, browser export (`scene-frame-compositor` — also fixes muted *visual* tracks not being skipped there), the render manifest builder, and the audio mixer.

[x] **Preview creator tools** (2026-06-27, `VideoPreview.tsx`): a floating toolbar with Safe-area (title + action + reels caption-safe zone), rule-of-thirds Grid, Background cycle (dark/light/checker), Before/After (bypasses the color grade in the preview), and Fullscreen. Overlays are non-interactive; toggles are preview-local.

[x] Editor header reworked: a single status slot (render progress **or** one sync badge — fixed the old duplicate "Saved" + "Sync failed"), icon-only document actions (template/manifest/preview/export-on-device) with tooltips grouped by dividers, and a transient action-feedback toast.

### Keyframes And Motion

[x] K0-K8 foundation is built.

[x] Shared animation evaluator.

[x] Transform keyframes.

[x] Numeric effect param keyframes.

[x] Keyframe lane visibility.

[x] Previous/next/add/remove keyframe controls.

[x] Interpolation menu.

[x] Graph Editor MVP.

[x] Temporal Bezier handles.

[x] Viewer-side spatial handles.

[x] Motion path editing.

[x] Animation presets.

[x] **Vector masks** (clip masks + effect-region/blur masks) — rectangle/ellipse/polygon/Bézier shapes with Add/Subtract/Intersect/Exclude modes, invert/feather/expansion/opacity, scalar + shape keyframes, reorder, drag-to-move. Alpha-matte SVG built once in `packages/shared/src/clip-masks.ts` and consumed identically by preview + Remotion. The mask-editing overlay in the viewer is gated to the clip's active time (2026-06-28) — it no longer renders before the selected clip's in-point. Full reference + test recipes: [MASKS.md](MASKS.md).

[x] **Mask tracking** — attach a saved motion track to a mask so it follows a moving subject (`trackingPathToMaskTransformKeyframes` → `scope:"mask"` transform.x/y keyframes, renderer-agnostic). Clip masks also now composite in the **local browser export** (`apps/web/src/export/scene-frame-compositor.ts` via the shared `SceneCompositor`).

[x] **Effect-region mask parity** — region masks (e.g. blur-a-face) now have the full clip-mask toolset: keyframeable feather/expansion/opacity + transform, shape keyframes, and mask tracking, via a shared `MaskItemBody` and a container-agnostic `mapMask` (finds a mask in `layer.masks` or `effect.masks`).

[x] **Region masks for color/blur effects** (P6) — `expandEffectRegionMasks` (`packages/shared/src/clip-masks.ts`) splits a media layer with region masks on color (`COLOR_EFFECT_TYPES`) or blur effects into base + a **cascade** of duplicates (each applies all region effects up to itself in panel order, clipped to its own region — so overlapping region effects stack), applied at all three render entry points (preview `renderedLayerEntries`, `render-templates` manifest, export `export-core`). Renders in preview, Remotion AND local export with no new compositor. Region **glow** is deferred (bloom-beyond-mask); region **blur in the local canvas export** is the remaining P7 gap. P7–P8 roadmap in [MASKS.md](MASKS.md#roadmap--phases).

### Person Extraction / Matting (2026-06-21)

[x] `MatteRef` type on `TimelineLayer` (`packages/shared/src/types.ts`) - the real, renderer-read signal for a masked layer.

[x] `packages/shared/src/matte.ts` - shared, DOM-free alpha-compositing math (`compositeMatteToImageData`). Both renderers call this; never duplicate the math.

[x] `MaskSequenceArtifactData` extended with `matteVideoUri` (canonical grayscale luma-matte video) in `packages/shared/src/masks.ts`; `createMatteRefFromMaskSequence` helper added.

[x] `withMaskMetadata` now attaches a real `MatteRef` when a baked mask is available, falling back to the old disabled-`chromaKey` placeholder for mock/unbaked masks.

[x] `apps/web/src/tools/local-segmentation.ts` - tiered segmentation engine. FAST tier = MediaPipe ImageSegmenter (same model family as Google Meet). QUALITY tier = RVM via onnxruntime-web (WebGPU, falls back to WASM). Device-aware tier/profile selection via existing `capabilities.ts`.

[x] `apps/web/src/tools/matte-store.ts` - bakes raw matte frames into a WebM (WebCodecs `VideoEncoder` + `webm-muxer`), with a PNG sprite-sheet fallback when WebCodecs is unavailable. Persists through the existing OPFS artifact store.

[x] `apps/web/src/components/MaskedVideoLayer.tsx` + Remotion `apps/worker/src/remotion/MaskedVideo.tsx` - the actual compositors, wired into `VideoPreview.tsx` and `Root.tsx` respectively when `layer.matte` is present. `RenderManifestLayer` (`packages/render-templates/src/index.ts`) carries `matte` through to the manifest.

[x] `ToolDetailPage.tsx` apply calls for Text Behind Person / Remove Background now pass `mask: subjectAnalysis.maskSequence` through to the composition builders (no-op today since the mock mask has no `matteVideoUri` yet; takes effect once Extract Person produces a real one).

[x] Whole monorepo (`pnpm -r typecheck`) verified clean after all of the above.

[x] Extract Person tool page UI (`ToolDetailPage.tsx`'s `ExtractPersonPanel`) - real run lifecycle: upload/select asset, "Extract person" (FAST/MediaPipe tier, auto-bakes a usable matte via `matte-store.ts` so Apply works immediately), "Bake high quality" (QUALITY/RVM tier, device-aware via `chooseSegmentationDeviceProfile`), cancel, status messaging, device-tier transparency note. Falls back to `createMockSubjectAnalysis` as a placeholder only until the user runs a real extraction. Tabbed `Upload`/`Adjust` layout matching Auto Captions, on the same 2-column sticky `tool-shell-captions` layout - the old 3-column generic mock-tool shell (Stages card, redundant Run-mock/adapter-selector block, always-open dev diagnostics) is hidden entirely for this tool. Apply is gated on having a real matte. Verified in-browser with Playwright twice (initial build, then again after fixing a MediaPipe `runningMode` crash and the layout rework) - zero console errors both times; real CDN model load wasn't reachable in the sandboxed dev environment, which is expected and doesn't block the UI.

[x] Fixed: MediaPipe `ImageSegmenter` was missing `runningMode: "VIDEO"` (defaulted to IMAGE mode, threw on first `segmentForVideo()` call), and the cached segmenter's per-call timestamps weren't monotonically increasing across separate Extract runs (would have thrown on a second run). Both fixed in `local-segmentation.ts`.

[ ] Real `browser` adapter dispatch for `PERSON_EXTRACTION` in `apps/web/src/tools/tool-runner.ts` (the generic mock/progressive adapter system) is still separate from the page's own direct calls to `local-segmentation.ts`/`matte-store.ts`. Today the tool page bypasses `tool-runner.ts` entirely for Extract Person's real path - worth reconciling so the adapter selector UI (mock/browser/cloud/desktop buttons) reflects what's actually happening.

[ ] Cross-tool artifact reuse: Text Behind Person / Remove Background / Smart Follow Text pages still each generate their own `createMockSubjectAnalysis` rather than letting a user pick an already-extracted real mask from a prior Extract Person run on the same asset. Needed for the product to feel coherent (extract once, reuse everywhere).

[ ] Cloud segmentation adapter (offload tier for weak device + long clip) is contract-only.

[ ] OPFS matte URIs are browser-local; render-manifest/Remotion path needs an upload/resolve step before a masked layer can actually export server-side (`matte.uri` must become an http(s) URL the worker can fetch).

[ ] Full manual E2E (real video -> real cutout visible in viewer -> Remotion export matches) needs a real network path to the MediaPipe/onnxruntime-web CDNs, which wasn't available to verify from this sandbox - worth a manual pass in a normal dev environment.

Full plan: `/home/rosn/.claude/plans/typed-stargazing-globe.md`.

### Person Removal / Remove Person tool (2026-06-22)

New AI tool that removes a person/object from a clip and produces a clean inpainted video, with a real generative inpainting model (not just a placeholder fill).

[x] Shared vocabulary: `PERSON_REMOVAL` module type, `inpaintedClip` artifact type, `mod_person_removal` catalog entry, `PERSON_REMOVAL: ["PERSON_EXTRACTION"]` dependency rule + default config, and a `tool_remove_person` capability (`remove-person`) in `packages/shared/src/tools.ts`.

[x] `applyRemovePersonComposition` + `InpaintedClipArtifactData` in `packages/shared/src/masks.ts`. The result is a single plain video layer pointing at the inpainted clip (no `matte`) — so web preview and Remotion render it identically with zero new compositor code (deliberate parity choice).

[x] **Real in-browser inpainting**: `apps/web/src/tools/local-inpainting.ts` runs the real LaMa (Large Mask Inpainting) generative model via onnxruntime-web (`Carve/LaMa-ONNX` `lama_fp32.onnx`, ~208MB, WebGPU with WASM fallback - mirrors the RVM pattern in `local-segmentation.ts`). Verified by downloading the actual model and inspecting its ONNX graph directly (not guessed): input `image` float32 [1,3,512,512] normalized 0-1, input `mask` float32 [1,1,512,512] (1=hole), output `output` float32 [1,3,512,512] already composited + scaled to 0-255 internally by the graph's own final nodes. `apps/web/src/tools/video-inpaint.ts` orchestrates per frame: center-crops to a square, runs the real model on that crop, and falls back to the cheaper diffusion fill (`mock-inpaint.ts`) for any hole pixels outside the crop or if the model fails to load entirely - so the tool degrades gracefully instead of failing outright on weak devices/networks.

[x] Browser tooling: `apps/web/src/tools/mock-inpaint.ts` (diffusion fallback - also used for periphery pixels outside the real model's square crop) and `apps/web/src/tools/inpaint-store.ts` (encodes inpainted RGB frames to VP9 WebM, OPFS-persisted, mirroring `matte-store.ts`).

[x] Tool UI: `apps/web/src/pages/RemovePersonToolPanel.tsx` — self-contained tabbed panel (Upload / Select / Preview) with interactive tap (auto-detect subject via reused `segmentVideoFast`) and brush (freehand region) selection, feather control, before/after preview, real-vs-fallback status messaging, and Apply → `applyRemovePersonComposition` → editor. Injected into `ToolDetailPage.tsx` via a single early return when `slug === "remove-person"` (keeps the monolith untouched).

[x] **Verified live end-to-end via Playwright against a running dev server** (no project skill existed for this yet - drove it directly): brush-select → generate → preview → apply → editor, twice - once with the model CDN blocked (confirms graceful fallback: clear "model unavailable" status, diffusion-filled clip still produced and applied correctly) and once with real network access (confirmed the real LaMa model genuinely downloads, loads, and runs per-frame inference - observed 14+ real frames complete with progressing status messages over several minutes; CPU/WASM-only in this sandbox since headless Chromium had no WebGPU, so each frame took 20-40s - a real device with WebGPU would be much faster). Caught and fixed a real bug this way: `fitProcessingDimensions`' 540px long-side cap pushed standard 9:16 reels' short side under the API's `min(320)` asset-upload floor (`packages/shared/src/schemas.ts`), silently degrading every real upload to the browser-local-only fallback. Fixed by flooring the scale at `MIN_OUTPUT_DIMENSION / shortSide` so output clips always clear the upload floor.

[ ] Real SAM2 point-prompt selection + per-frame mask propagation/tracking is deferred (selection still uses reused person-extraction segmentation for tap, or a static single-frame brushed region - the brush doesn't track motion across the clip yet).

[ ] Cloud SAM2 + inpainting service behind the existing contract-only cloud adapter stub is deferred (today "browser" mode does the real local LaMa work; cloud is still a placeholder for low-power-device offload).

[ ] Real model only covers a centered square crop per frame (the model's fixed 512x512 input) - hole pixels outside that crop on non-square sources fall back to the cheaper diffusion fill. True full-frame coverage needs a model exported at the source aspect ratio.

### Clip rebinding: Replace asset + Slip (2026-06-23)

Two timeline editing primitives that make a clip's media re-bindable independently of its placement - the foundation for the templating system below.

[x] **Replace asset**: swap the media behind a video/image/audio clip while keeping its timeline position and (for images) duration. Drag-onto-clip already routed through `handleDropAsset(..., replaceLayerId)`; added a discoverable clip context menu ("Replace asset…") that puts the asset bin into a pick-one "replace mode" (`assetPickerForLayerId` in `EditorPage.tsx`, banner + `replaceActive` in `AssetBin`). Fixed a latent bug: a swapped-in asset no longer inherits the old clip's `sourceInSeconds`.

[x] **Slip mode**: double-click a video/audio clip to enter slip mode (`slipLayerId` in `TimelineStrip.tsx`); horizontal drag shifts the clip's source in-point (`sourceInSeconds`) while position/duration stay fixed, clamped to `[0, assetDuration - clipDuration]`, frame-snapped, with a live offset badge and Escape to exit. No renderer change needed - both `VideoPreview.tsx` and Remotion `Root.tsx` already honor `sourceInSeconds` identically (verified `render:compare:pixels` still passes at 0.25%).

[x] Also added a clip context menu (Replace / Slip / Duplicate / Delete) mirroring the timeline track-area menu, and made the in/out work-area checks null-safe (persisted JSON `null` no longer crashes the timeline).

### Templating: save project as template (MVP, 2026-06-23)

Canva-for-video direction: a template *is* a saved composition (with its effects/tool stack) plus slot metadata - authored by editing a normal project, reusable by anyone. Reuses 100% of the editor; no separate builder.

[x] Shared: `TemplateSlot` + `TimelineLayer.slot` (`media`/`text`/`color`, `replaceable`, `key`). `ensureTemplateSlots` auto-marks the primary media layer + text layers when none are marked; `buildTemplateGraphFromProject` snapshots the live composition into a reusable graph (media slots shed `assetId`/`matte`, text/color slots seed `editableFields`); `instantiateTemplateComposition` rebuilds it into a fresh project (remaps `${projectId}_*` ids, fills empty media slots with the uploaded asset). All in `packages/shared/src/timeline.ts`.

[x] API: `POST /projects` now instantiates `templateGraph.composition` when present instead of always calling `createDefaultComposition` (module-stack templates + blank drafts unchanged). `createTemplateSchema.requiredModules` relaxed to allow composition-based templates with no module stack.

[x] Web: editor "Save as Template" header button + modal → `createTemplate` (POST /templates); per-layer "Template slot" toggle in the Controls tab. **Verified the full round-trip via API + Playwright**: edit → save as template (3-track composition persisted) → create project from it (ids remapped, slots marked, media slot fills with the chosen asset).

[ ] Deferred: template marketplace/discovery/ratings/sharing; a structured module/effect builder; slot-bound editable-field editing UI on instantiation (today media slots fill from the uploaded asset and text slots keep their authored copy); clearing the linked companion-audio asset of a media slot at save time (currently retained).

### Tool surface unification (foundation, 2026-06-23)

Target: a tool is declared once and runs identically wherever it's surfaced. `layerToolEffectHandlers` + the shared `apply*Composition()` functions are already the single source of truth for "ready" tools.

[x] Extracted the run → progress → cancel → apply lifecycle into a shared `useLayerToolEffectRunner` hook (`apps/web/src/tools/`); the editor's `ToolEffectRunnerModal` now consumes it instead of owning the state machine.

[x] Smart 3D Follow Text is registered as a `layerToolEffectHandler` (`apps/web/src/tools/layer-effect-handlers.ts`) purely so it surfaces in the editor Effects tab list (matched by `accepts`); the simple `ToolEffectRunnerModal` it would otherwise run through is intercepted for this tool (see next bullet) since the real workflow needs more than a run/progress popup.

[x] The full Smart 3D Follow Text workspace (target list, auto-select, add tracker, track all/re-track from a fix marker, clean & smooth, follow/stabilize mode, depth/smoothing/stabilize-strength controls, live `TrackBoxEditor` tracker preview, real `FollowResultPreviewPlayer` result preview using the same `VideoPreview` renderer as the editor) was extracted out of `ToolDetailPage.tsx` into a standalone, self-contained `SmartFollowTextToolPanel` (`apps/web/src/pages/SmartFollowTextToolPanel.tsx`), mirroring the existing `RemovePersonToolPanel` pattern. It takes optional `preselectedAsset`/`liveComposition`/`onApplyToComposition`/`compact` props so the same component serves both contexts: the standalone `/tools/smart-3d-follow-text` page (asset upload/select required, Apply creates a new project) and a large `Modal` (`.modal-workspace` CSS class) opened from the editor's Effects tab via `SmartFollowTextEffectModal` - asset preselected/locked from the selected layer, no upload UI, Apply merges directly into the live editor composition via the shared `buildFollowResultComposition` builder (no new project/navigation). `resolveToolMediaUrl`/`isCompatibleToolAsset` were pulled out to `apps/web/src/tools/tool-media.ts` so both files can share them without a circular import. Each tracked target can also be "reused" onto a new target (`+ Reuse track` in the target list) - clones an already-tracked motion path onto a second piece of text/graphic without re-tracking. Beyond in-session reuse, every Apply also seeds each tracked target as a `SavedTrack` into the project's `editableFields.trackLibrary` (`buildSavedTracksFromTargets` in `SmartFollowTextToolPanel.tsx`, re-applying with the same target ids overwrites rather than duplicates) - this is the same library the "Attach track" layer-inspector control already reads from, so the exact tracked motion can be attached to any other layer, including ones added after the Apply, with no re-tracking. In the editor-modal path this is applied atomically alongside the composition update via `EditorPage.applySmartFollowTextResult` (one combined `updateGraph` call, avoiding a stale-`graph` race between separate composition/editableFields updates); the standalone-page path seeds it directly in its `patchProject` call. The library's own "Track a new point..." entry point was upgraded from the older single-target `TrackEffectModal` (now deleted) to `TrackWorkspaceModal` (`apps/web/src/components/TrackWorkspaceModal.tsx`), which opens the same `SmartFollowTextToolPanel` workspace in a new `trackOnly` mode: the Style tab is hidden, an inline "Track name" field lets each target be renamed, and Apply only seeds `editableFields.trackLibrary` (via the `idFor`/`labelFor` overrides on `buildSavedTracksFromTargets`) without inserting follow-text/stabilize layers. `initialTrack` seeds the workspace from an existing library entry for the "edit/retrack" (↺) action. There is now exactly one tracking UI in the app instead of two.

[ ] Next: migrate the multi-stage `/tools/:slug` page (`ToolDetailPage`, ~2700 lines) to drive the same handler contract via `useLayerToolEffectRunner` stage-by-stage, so its bespoke per-tool "Apply" logic isn't a second implementation. Templates already express tool prerequisites generically through `ProjectEffect[]` + `resolveModuleInsertions` - no special-casing needed there.

### Text Warp + Compact Controls (2026-06-23)

[x] **Text Warp (vector envelope mesh, opentype.js — 2026-06-24 rewrite)**: `TextWarp` / `TextWarpStyle` on `TimelineLayer` (`packages/shared/src/types.ts`). Styles: Arc, Arc Lower, Arch, Bulge/Lens, Wave, Flag, Fisheye.

  **Engine.** Warp is now a **geometric vector deformation on real glyph outlines** (Photoshop-grade), not a pixel filter. Two pure-shared modules + one font service:
  - `packages/shared/src/text-warp-mesh.ts` — pure envelope math (no opentype/DOM dep, unit-testable): `warpPathCommands(commands, bounds, warp, fontSize)` pushes every anchor/bezier control point of `M/L/C/Q/Z` outline commands through a per-style envelope. Bend = curve amplitude (font-relative, `fontSize*0.9`); Distort H/V = perspective trapezoid. Per-style: arc/arcLower (parabola offset, lower weighted by `v`), arch (sine), bulge/fisheye (vertical scale `s(u)` peaking centre), wave (`sin 2πu`), flag (`sin 2πu · u`).
  - `packages/shared/src/font-outlines.ts` — `buildWarpedTextPathSvg(warp, runs, style): Promise<string|undefined>`: lazy `import("opentype.js")`, fetch+parse the font binary (cached per family), lay out runs via `font.getPath`/`getAdvanceWidth`, warp commands, emit one `<path>` per run inside an absolutely-positioned `<svg>` overlay. Memoized by content+style; returns `undefined` when warp is off or the font isn't hosted (caller shows plain text → graceful). Font catalog (`warpFontFile`, `registerWarpFonts`, `configureFontResolver`) is the seam for a future large (Canva-scale) library — only the used font is fetched. opentype.js can't Brotli-decode `.woff2`; serve ttf/otf/woff.

  **Renderers.** Both keep HTML `<span>` runs `visibility:hidden` (box sizing/selection, and the container keeps transform/scale/rotate/effects) and overlay the warped `<path>`. `VideoPreview.tsx` uses `useWarpedTextSvg` (async `useState`); `Root.tsx` uses `useWarpedTextSvgRemotion` which blocks the frame via `delayRender/continueRender` (like `useLoadedCompositionFonts`) so the export matches the preview. Fonts are served from each app's `public/fonts` (web resolver `/${warpFontFile}`; worker `staticFile(...)` with `publicDir` set in `remotion-renderer.ts`). Initial hosted font: `Roboto-Regular.ttf` (universal default until the catalog grows).

  **Why the rewrite:** the old `feImage`→`feDisplacementMap` pixel approach smeared glyphs (poor quality) and biased position ("bend shifts right"); Chrome also only resolves `feImage` for SVG-painted content. The vector-mesh engine is crisp at any zoom and is the reusable foundation for the planned graphics window (warp any vector, not just text). Pragmatic limits: warp uses the catalog/hosted font (not the system stack), single weight per font for now, background pill itself isn't warped (the glyphs are). `render-templates/src/index.ts` carries `textWarp` in the manifest `style` record; Controls tab "Warp" section unchanged (`TextWarpPanel.tsx`). Removed from `text-warp.ts`: `buildTextWarpFilterSvg`, `buildWarpedTextOverlaySvg`, `getTextWarpFilterId`, displacement-map/gradient helpers.

[x] **Compact Controls panel (DaVinci Resolve style)**: right-hand studio panel redesigned without touching component markup. Key changes in `apps/web/src/styles/global.css`: CSS tokens (`--ctl-h: 26px`, `--ctl-gap: 6px`, `--panel-pad: 8px`); `.number-control` and `.font-control` converted from stacked label+input to single-row 2-column grid (label col fills, value col fixed 84px for numbers / full-width for font select); section headers now 28px with uppercase 11.5px labels; inputs/selects/color-picker-shell shrunk to `var(--ctl-h)`; swatches, eyedropper, alignment buttons, inspector-toggles all reduced to match; `.inspector-section-body` gap tightened to 6px; `.icon-control-row` uses `auto-fit` grid (no more fixed 4-col). `.control-field` (textarea) left as stacked since it needs full width for its textarea child.

## Lumio AI Operating System — Phased Roadmap

Vision (`AI_ARCHITECTURE.md`): Lumio is a professional editor with an **AI operating system on top** — "Claude Code for video editing". AI never mutates the timeline directly. It *plans → selects registered tools/actions → previews → asks when it matters → executes through an approved registry*, leaving everything editable and undoable. The editor stays fully usable without AI.

```text
User → AI Chat Panel → Planner → Capability Registry → Plan Review
     → Executor → Timeline Action Registry → patches → Undo Stack → Editor Timeline
```

Foundational rule: the **Timeline Action Registry is the only approved mechanism for AI timeline mutation.** AI may only invoke registered, validated, reversible actions that *wrap* the existing pure ops — never touch `TimelineLayer`/effects/keyframes directly, never touch rendering (manifest stays the contract; web↔Remotion parity preserved).

### Status — P1–P8 shipped (2026-06-23 / 24)

No renderer/manifest ever touched — pixel diff unchanged (~0.245%, `render:compare:pixels`); `actions:test` + `editor:test` green; `pnpm -r typecheck` clean. One-line-per-phase (code is the source of truth — read the files, not a prose dump):

- **P1 Timeline Action Registry** — `packages/shared/src/timeline-actions/` (`registry.ts` + 24 actions wrapping pure ops, validation reading the real registries, immer `{before,after,patch,undoPatch,summary}`, analytics). Test: `actions:test`.
- **P2 Capability discovery + cost** — `packages/shared/src/capability-index.ts` (`buildCapabilityIndex()`/`describeForPlanner()`, `classifyToolCost()` browser⇒free / cloud⇒credits, `actionCost()`).
- **P3 AI MVP + interactive tools** — `apps/web/src/ai/` (`PlannerProvider`, `DeterministicPlanner`, `PlanExecutor`) + `components/ai/` (`AiChatPanel`/`PlanReviewCard`/`AiProgressList`); `tool` steps open the real tool window and pause on `requiresInput` (`openToolForAi` in `EditorPage`).
- **P4 Confidence + Permission Modes** — `ai/confidence.ts` + `ai/permission.ts` (`quick`/`professional`/`agent`, `shouldAutoApply()`); `PermissionModeSelector`.
- **P5 Conversational refinement** — `PlannerContext.{history,lastAction,memory}`; deterministic follow-ups/deltas via `updateText`; `PlanExecutor` returns `targetLayerIds`+`durationMs`.
- **P6 AI Memory** — `ai/memory.ts` (localStorage prefs; remembered text color / permission mode / caption-style hint).
- **P7 Analytics + Missing-Capability Dashboard** — extended `analytics.ts` (tool/effect demand, plan accept/reject, exec time, `logUnsupported`, subscribe/hydrate); `ai/analytics-store.ts` persists to localStorage; `AiInsightsDashboard`.
- **Interactive clarify loop** — `clarify` steps pause and ask in chat (`AiChatPanel.askClarify`, ask→confirm→reask); accepted approximations logged `acceptedApproximation:true`.
- **P8 LLM planner seam** — `ai/planner/LlmPlanner.ts` + `createPlanner.ts` behind the same `PlannerProvider`; validates every returned step against the registries; falls back to deterministic on any failure.

**Cost rule — never send the whole project.** `LlmPlanner.summarizeContext()` sends only a bounded *relevant slice* (selected + on-playhead layers, cap 12, trimmed fields — no keyframes/animations/matte blobs/asset binaries/off-screen layers); layer ids in the slice are real and directly targetable; if the model needs a layer not in the slice it must `clarify`. The static capability registry rides in a cached system block. Net ~80–95% smaller than serialising `TimelineComposition`.

### Provider Gateway — multi-model failover (free-first, internet-scale)

Decision (validated for an indie launch): don't bind the brain to one provider. Behind the *unchanged* `/api/ai/plan` route, swap the single LLM call for a **config-driven pool with automatic failover**. The full AI spine (PlannerProvider, slice payload, **registry validation of every step**, Plan Review, Executor→patches→Undo, permission modes, memory, analytics, interactive clarify/tool loop) is untouched — only the server-side brain grows. Keys stay server-side (multi-user safe). Reasoning models are weaker than Claude, but **registry validation + deterministic floor** guarantee safety/precision regardless of model quality.

Failover chain (priority order; a provider is skipped when its key is absent or it's in cooldown after a 429/503/5xx/timeout):
```text
Cerebras → Groq → OpenRouter → Gemini → Claude Sonnet (paid, opt-in) → Deterministic planner (always-free floor)
```
All pool members are **OpenAI-compatible** (`POST /v1/chat/completions`) → one adapter, model IDs env-overridable (free tiers drift — config, not code). Free RPD is small, so multi-user needs: per-IP rate limit + short-TTL plan cache (both P1), BYO-key (P2).

**Confidence layer.** The model returns a numeric `confidence` (0–1); the gateway passes it through and the UI shows the **raw percentage** (user-chosen override of the earlier no-percentages rule). Low confidence (`<60%`) **blocks auto-apply** and routes to a `clarify` step listing interpretations (A/B/C) — reuses the shipped clarify loop, no new infra.

- **GP1 — Gateway + failover + confidence (this track, now).** `apps/api/src/services/aiGateway.service.ts` (pool, cooldown failover, OpenAI-compat call, `<think>`-strip + JSON extract); route rewritten to use it; per-IP rate limit + plan cache; numeric confidence → raw `%` in `PlanReviewCard`; `<60%` blocks auto-apply. Pool: Cerebras→Groq→OpenRouter→Gemini. Deterministic floor intact. Env: `{CEREBRAS,GROQ,OPENROUTER}_API_KEY` + per-provider `*_MODEL`, reuse `GEMINI_API_KEY`.
- **GP2 — Reasoning / "thinking" log (shipped 2026-06-24).** Gateway captures the model's chain-of-thought (`message.reasoning`/`reasoning_content` + inline `<think>`, capped 3000 chars) → route passes it back → `AiPlan.reasoning`/`provider`. `AiThinkingLog` shows the live pipeline phases while planning (Understanding → Inspecting slice → Querying registry → Reasoning → Drafting → Validating); `AiReasoningLog` is a collapsible "AI reasoning · {provider}" trace under the plan card.
- **GP2.1 — live SSE/NDJSON streaming (shipped 2026-06-24).** `streamPlanWithGateway()` asks the chosen provider for `stream:true` and parses its SSE; `POST /api/ai/plan/stream` relays NDJSON events (`provider`/`reasoning`/`answer`/`done`/`unavailable`). `LlmPlanner` streams it, dispatching real `PlanStreamEvent`s (`PlannerProvider.plan` gained an optional `onEvent`); `AiChatPanel` drives `AiThinkingLog` from them — phases advance on actual backend progress and reasoning tokens render live. Failover is pre-stream only (once a provider sends bytes we commit to it); any failure falls back to the deterministic planner. Per-IP rate limit + plan cache shared with the non-stream route.
- **GP3 — BYO-key (shipped 2026-06-24).** `ai/byok.ts` (localStorage `{provider,apiKey,model?}` for groq/cerebras/openrouter/gemini/**anthropic (Claude)**) + `ByoKeyPanel` (key button in the chat toolbar). `LlmPlanner` includes `byo` in the request; the gateway prepends it as the first candidate (own cooldown id `byo-<provider>`); the route exempts BYO from the shared per-IP rate limit (their quota) and namespaces the cache by provider. Claude uses its OpenAI-compatible endpoint (`api.anthropic.com/v1/chat/completions`). The key is stored only in the browser and sent per-request — **never persisted or logged server-side**.
- **GP4 — Paid premium tier (shipped 2026-06-24).** Shared paid Claude hop (`premiumClaudeConfig()` from the server `ANTHROPIC_API_KEY`, Anthropic's OpenAI-compatible endpoint), **gated to "Best Quality" mode** (a ✨ toggle in the chat toolbar, persisted as `memory.qualityMode`). The client sends `premium:true`; the gateway then tries Claude **first** (best model for hard requests) with the free pool as failover — but only when the toggle is on AND a server key exists, so free-mode traffic (95%) never touches it. Cache is namespaced by `best`/`free`. No subscription gating (pricing stays metadata-only); BYO-Claude (GP3) already covers individual paid users.
- **GP5 — Local mode via Ollama (shipped 2026-06-26).** A **"Local" toggle** beside Pro routes the chat consultant + planner to the user's own Ollama model, **browser-direct** to `http://localhost:11434/v1/chat/completions` (OpenAI-compatible) — private, offline, unmetered; the remote gateway can't reach localhost, so the browser calls it itself. The planner/consultant system prompts + user-content builders + plan JSON extractor moved to `packages/shared/src/ai-prompts.ts` so the local path produces requests byte-identical to the server gateway (and registry validation is unchanged). `ai/ollama.ts` (localStorage config, `/api/tags` model list + vision inference, ping, OpenAI SSE chat) + `ai/openai-stream.ts` (ported `consumeSse`); `OllamaPanel` for setup. **Local-first with cloud fallback:** a pre-flight ping decides the route; if Ollama is unreachable a 5s "using cloud" hint with **Cancel** appears, else any mid-run failure falls through to the gateway. Vision models read attached reference images. Needs `OLLAMA_ORIGINS=<web origin>` so Ollama's CORS allows the site. Pixel ML (person-extract/matting/inpaint) stays on the local ONNX/transformers models — Ollama is the *brain*, not the matte. **Deferred:** multi-core ML acceleration (cross-origin isolation → multithreaded WASM + `numThreads=hardwareConcurrency`, keep WebGPU).
