/**
 * Professional Color System (Phase 3) — color render-engine feature flag.
 *
 * The WebGL float/3D-LUT engine is gated behind this flag so it can be built and
 * pixel-verified SIDE-BY-SIDE against the production DOM/CSS/SVG path before becoming
 * the default — the safe golden-rule path (no blind renderer replacement).
 *
 * Resolution order (first wins):
 *   1. `?colorEngine=webgl|dom` query param  — lets the comparison harness / fixture
 *      page render either engine from the same timeline JSON (and is a per-session escape
 *      hatch: `?colorEngine=dom` forces the SVG path).
 *   2. `localStorage["lumio.colorEngine"]`    — dev opt-in / opt-out.
 *   3. `VITE_COLOR_ENGINE` build env.
 *   4. default → "webgl" (the high-end float / 3D-LUT engine is now the backbone).
 *
 * The default flipped to "webgl" after the comparison gates passed in a real browser/GPU
 * env (`color:compare` 0.001%, `render:compare:pixels` 0.228%; see COLOR_SYSTEM_PLAN.md →
 * verification). WebGL is still **gated by feature detection** (`useWebglColorEngine`
 * requires WebGL2) and wrapped in an error boundary, so any unsupported/failed context
 * transparently falls back to the DOM/SVG path — that path is the permanent no-GL fallback,
 * never removed. Hue-curves & HSL-secondary (13C.3+) ONLY render through this engine (SVG
 * can't express a 3D LUT), which is why webgl is the default rather than an opt-in.
 */

import { REGION_PASS_MODEL_DEFAULT } from "@lumio-by-aelivion/shared";

export type ColorEngine = "dom" | "webgl";
export type RendererMode = "legacy" | "webgl";

function normalize(value: string | null | undefined): ColorEngine | undefined {
  return value === "webgl" || value === "dom" ? value : undefined;
}

function normalizeMode(value: string | null | undefined): RendererMode | undefined {
  return value === "webgl" || value === "legacy" ? value : undefined;
}

export function getColorEngine(): ColorEngine {
  if (typeof window !== "undefined") {
    try {
      const param = normalize(new URLSearchParams(window.location.search).get("colorEngine"));
      if (param) return param;
      const stored = normalize(window.localStorage?.getItem("lumio.colorEngine"));
      if (stored) return stored;
    } catch {
      /* SSR / restricted storage — fall through */
    }
  }
  const env = normalize((import.meta as { env?: Record<string, string | undefined> }).env?.VITE_COLOR_ENGINE);
  return env ?? "webgl";
}

/**
 * Unified media renderer mode. "webgl" routes video/image layers through the shared
 * `MediaWebGLRenderer` — ONE shader pass does color grade + matte + opacity, identical to
 * the Remotion export (apps/worker WebglMediaLayerRemotion), so the editor preview and the
 * exported MP4 are pixel-aligned and the image double-grade bug is impossible (the canvas is
 * the sole output; the source <img>/<video> is a hidden decode source with skipColorFilter).
 * "legacy" keeps the original WebglColorView / WebglVideoOverlay / MaskedVideoLayer paths.
 *
 * Resolution order: `?rendererMode=webgl|legacy` → localStorage → VITE_RENDERER_MODE → default.
 *
 * Default is "webgl": the unified path is the backbone (it's the only path that can apply
 * the pro in-shader stylize effects — vignette/grain/chroma — that effects.ts now marks
 * `native`). The worker mirrors this default (Root.getRendererMode → process.env
 * RENDERER_MODE). The formal pixel sweep (`pnpm --filter @lumio-by-aelivion/worker render:compare:pixels`
 * in a GPU env) should still be run to confirm; force the old path with `?rendererMode=legacy`
 * / localStorage if a regression appears. See COLOR_SYSTEM_PLAN.md.
 */
export function getRendererMode(): RendererMode {
  if (typeof window !== "undefined") {
    try {
      const param = normalizeMode(new URLSearchParams(window.location.search).get("rendererMode"));
      if (param) return param;
      const stored = normalizeMode(window.localStorage?.getItem("lumio.rendererMode"));
      if (stored) return stored;
    } catch {
      /* SSR / restricted storage — fall through */
    }
  }
  const env = normalizeMode((import.meta as { env?: Record<string, string | undefined> }).env?.VITE_RENDERER_MODE);
  return env ?? "webgl";
}

/** True when the high-end WebGL color engine should be used (and is supported). */
export function useWebglColorEngine(supported: boolean): boolean {
  return supported && getColorEngine() === "webgl";
}

export type CompositorMode = "dom" | "scene";

function normalizeCompositor(value: string | null | undefined): CompositorMode | undefined {
  return value === "scene" || value === "dom" ? value : undefined;
}

/**
 * Single GPU compositor (Method 3) — now the DEFAULT ("scene"), like `getRendererMode`'s "webgl" backbone.
 *
 * "scene" routes the preview's media + text/shape layers through the shared `SceneCompositor`: one
 * WebGL2 context composites every already-graded clip canvas + rasterized text/shape into ONE output
 * canvas (object-fit + clip mask + 16 blend modes + blur/glow + 3D tilt + junction transitions in-shader).
 * Only selection handles stay DOM overlays on top. "dom" is the original per-clip-canvas path — kept as the
 * escape hatch (`?compositor=dom`).
 *
 * History: a first flip (2026-06-28) was reverted the SAME day for scene-only gaps the single-frame
 * fixtures don't exercise — preloaded-clip handling + a black flash at cuts, a stale text-warp raster key,
 * empty-gap background consistency (the GPU canvas mounting/unmounting as `sceneActive` toggled on
 * `visualCount`), and per-frame perf. Those are now fixed: Phase 4.1 (self-sufficient text/shape: grade +
 * mask + 3D, no DOM fallbacks), Phase 4.2 (transitions in the pass), the warp key, the always-mounted scene
 * canvas (`sceneEnabled` — owns the background every frame, no toggle flash), and the event-driven redraw +
 * per-source texture cache. Gates green (`scene:compare` incl. transition/graded/masked/tilted-text;
 * `render:compare:pixels`). So the default flips to "scene" for good.
 *
 * Still WebGL2-gated (`useSceneCompositor`) + a runtime GL-failure fallback (`sceneFailed`), so even as the
 * default it can never blank a comp; `?compositor=dom` / `localStorage["lumio.compositor"]` /
 * `VITE_COMPOSITOR_MODE` force the DOM path.
 *
 * Resolution order: `?compositor=scene|dom` → localStorage → VITE_COMPOSITOR_MODE → default "scene".
 */
export function getCompositorMode(): CompositorMode {
  if (typeof window !== "undefined") {
    try {
      const param = normalizeCompositor(new URLSearchParams(window.location.search).get("compositor"));
      if (param) return param;
      const stored = normalizeCompositor(window.localStorage?.getItem("lumio.compositor"));
      if (stored) return stored;
    } catch {
      /* SSR / restricted storage — fall through */
    }
  }
  const env = normalizeCompositor((import.meta as { env?: Record<string, string | undefined> }).env?.VITE_COMPOSITOR_MODE);
  return env ?? "scene";
}

/** True when the single GPU SceneCompositor should drive the preview's media layers (and WebGL2 is supported). */
export function useSceneCompositor(supported: boolean): boolean {
  return supported && getCompositorMode() === "scene";
}

/**
 * Local-export compositor (Method 3) — `SceneFrameCompositor` is the ONLY browser-export compositor as of
 * Phase 5. It drives the SAME shared `SceneCompositor` + `buildSceneDraws` the editor preview uses, so the
 * on-screen preview LITERALLY becomes the export (the Method 3 goal): blur/glow/highlight-bloom/content-
 * transform all render in export, which the retired canvas2D `FrameCompositor` never did. There is no longer
 * an `exportCompositor` flag or a canvas2D fallback — `getExportSingleContext` / `getExportWorkerScene` below
 * are the remaining export-path toggles. Export parity is held by `export:worker-scene` (Worker scene vs
 * main-thread scene) and `scene:compare` (scene preview vs DOM), which transitively covers the export since
 * it shares the preview's draw-list + compositor.
 */

/**
 * Single-context export (Method 3, Phase 2) — when ON, `SceneFrameCompositor` grades media + text/shape
 * overlays into render-targets on the `SceneCompositor`'s OWN WebGL2 context (no per-clip context, no
 * cross-context canvas upload), so the whole export runs on ONE context. That single self-contained context
 * is what lets scene export move back to the Worker (Phase 2 Stage 3); the cross-context multi-context path
 * is what dies in the Worker's isolated GPU process today (the Stage 0 probe reproduced the black frames).
 *
 * ON by default (Phase 2 Stage 4). Query/localStorage/VITE env overrides remain so the legacy
 * multi-context scene path can be forced for debugging or emergency rollback.
 * Resolution order: `?exportSingleContext=0|1` → localStorage `lumio.exportSingleContext` → VITE env → true.
 */
export function getExportSingleContext(): boolean {
  const truthy = (v: string | null | undefined): boolean => v === "1" || v === "true";
  if (typeof window !== "undefined") {
    try {
      if (new URLSearchParams(window.location.search).has("exportSingleContext")) {
        return truthy(new URLSearchParams(window.location.search).get("exportSingleContext"));
      }
      const stored = window.localStorage?.getItem("lumio.exportSingleContext");
      if (stored != null) return truthy(stored);
    } catch {
      /* SSR / restricted storage — fall through */
    }
  }
  const env = (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_EXPORT_SINGLE_CONTEXT;
  return env == null ? true : truthy(env);
}

/**
 * Worker scene export (Method 3, Phase 2 Stage 3) — when ON, scene-mode export runs in the export Worker
 * instead of on the main thread. This is ONLY honored together with single-context export
 * ({@link getExportSingleContext}): the single self-contained WebGL2 context is what survives the Worker's
 * isolated GPU process, whereas the legacy multi-/cross-context path black-frames there (Stage 0 probe).
 *
 * ON by default (Phase 2 Stage 4): scene-mode export now runs in the Worker through the stable single-context
 * path. If Worker scene export fails, `local-export.ts` falls back to the main-thread scene path (NOT directly
 * to canvas2D).
 *
 * Resolution order: `?exportWorkerScene=0|1` → localStorage `lumio.exportWorkerScene` → VITE env → true.
 */
export function getExportWorkerScene(): boolean {
  const truthy = (v: string | null | undefined): boolean => v === "1" || v === "true";
  if (typeof window !== "undefined") {
    try {
      if (new URLSearchParams(window.location.search).has("exportWorkerScene")) {
        return truthy(new URLSearchParams(window.location.search).get("exportWorkerScene"));
      }
      const stored = window.localStorage?.getItem("lumio.exportWorkerScene");
      if (stored != null) return truthy(stored);
    } catch {
      /* SSR / restricted storage — fall through */
    }
  }
  const env = (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_EXPORT_WORKER_SCENE;
  return env == null ? true : truthy(env);
}

/** True when the unified WebGL media renderer should be used for video/image layers. */
export function useWebglRenderer(supported: boolean): boolean {
  return supported && getRendererMode() === "webgl";
}

/**
 * Region-effect PASS model (todo.md "Region-effect model" TRUE fix): region effects render as per-effect
 * masked post-composite passes inside a per-layer nest in the SceneCompositor, replacing stacked `__rfx_`
 * clone DRAWS in the composite. Upstream expansion (`expandEffectRegionMasks`) and per-clone grading are
 * unchanged in this stage — only the composite differs, so the flag is a clean A/B. Default OFF until the
 * scene:compare region fixtures pass with it on (then flip, the governor playbook).
 *
 * Resolution order: `?regionPasses=0|1` → localStorage `lumio.regionPasses` → `VITE_REGION_PASSES` →
 * `REGION_PASS_MODEL_DEFAULT` (the shared single flip point — the render-manifest builder derives the cloud
 * renderer's value from the same constant, so all three renderers flip together).
 */
export function getRegionPassesEnabled(): boolean {
  const truthy = (v: string | null | undefined): boolean => v === "1" || v === "true";
  if (typeof window !== "undefined") {
    try {
      if (new URLSearchParams(window.location.search).has("regionPasses")) {
        return truthy(new URLSearchParams(window.location.search).get("regionPasses"));
      }
      const stored = window.localStorage?.getItem("lumio.regionPasses");
      if (stored != null) return truthy(stored);
    } catch {
      /* SSR / restricted storage — fall through */
    }
  }
  const env = (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_REGION_PASSES;
  return env == null ? REGION_PASS_MODEL_DEFAULT : truthy(env);
}

/**
 * Viewer-capture proxy generation (todo.md Phase 6B P1a — "the proxy IS the viewer"): background spans are
 * rendered through the VISIBLE preview's own SceneCompositor (offscreen, no present) with pooled `<video>`
 * decode + shared-context grading, instead of the second WebCodecs pipeline in the export Worker. Faithful
 * to the viewer by construction (same compositor instance, caches, draw builder — plugins included). The
 * Worker pipeline remains the fallback when capture fails.
 *
 * DEFAULT ON (flipped 2026-07-03) — soaked on a real user project: span sealed viewer-first with
 * `parity-ok` worst-diff 0.00% and zero worker fallbacks, on top of the Playwright live gate
 * (viewer-ready + parity-ok, fallback chain verified). Escape hatch `?proxyViewerCapture=0`.
 *
 * Resolution order: `?proxyViewerCapture=0|1` → localStorage `lumio.proxyViewerCapture` →
 * `VITE_PROXY_VIEWER_CAPTURE` → true.
 */
export function getProxyViewerCaptureEnabled(): boolean {
  const truthy = (v: string | null | undefined): boolean => v === "1" || v === "true";
  if (typeof window !== "undefined") {
    try {
      if (new URLSearchParams(window.location.search).has("proxyViewerCapture")) {
        return truthy(new URLSearchParams(window.location.search).get("proxyViewerCapture"));
      }
      const stored = window.localStorage?.getItem("lumio.proxyViewerCapture");
      if (stored != null) return truthy(stored);
    } catch {
      /* SSR / restricted storage — fall through */
    }
  }
  const env = (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_PROXY_VIEWER_CAPTURE;
  return env == null ? true : truthy(env);
}

/**
 * Single-context GPU-first preview (Phase 5 — the preview sibling of {@link getExportSingleContext}).
 * When ON, scene-mode media layers do NOT create their own `MediaWebGLRenderer` context/canvas: each
 * `WebglMediaLayer` exposes its RAW frame source (the `<video>` element / held WebCodecs `VideoFrame` /
 * decoded still) plus its `ColorPipeline`, and `ScenePreviewCanvas` grades it through a shared-context
 * `MediaWebGLRenderer` + `RenderTarget` ON the SceneCompositor's own WebGL2 context (the exact
 * architecture the single-context EXPORT ships with). One upload per layer per frame instead of 2–3,
 * zero per-clip GL contexts (no governor churn / context-loss storms), less VRAM.
 *
 * ON by default (flipped 2026-07-07) after the full flip ladder: `scene:compare`
 * (PIXEL_BROWSER_CHANNEL=chrome) 22/22 in BOTH flag states at ZERO threshold changes with
 * media-fixture diffs byte-identical, `render:compare:pixels` 23/23 at 0.000%, the engagement probe
 * (`__rfSingleCtxPreview.grades>0` on / untouched off), and a user soak on the :4173 production
 * build (one found-and-fixed bug: the ruler-click flicker → hold-last-graded-frame, tracker
 * playback-preview v9). The per-clip-context path stays fully intact behind the escape hatch —
 * `?singleCtxPreview=0` / localStorage `"0"` — and remains what DOM-compositor mode uses.
 *
 * Resolution order: `?singleCtxPreview=0|1` → localStorage `lumio.singleCtxPreview` →
 * `VITE_SINGLE_CTX_PREVIEW` → true.
 */
export function getSingleCtxPreviewEnabled(): boolean {
  const truthy = (v: string | null | undefined): boolean => v === "1" || v === "true";
  if (typeof window !== "undefined") {
    try {
      if (new URLSearchParams(window.location.search).has("singleCtxPreview")) {
        return truthy(new URLSearchParams(window.location.search).get("singleCtxPreview"));
      }
      const stored = window.localStorage?.getItem("lumio.singleCtxPreview");
      if (stored != null) return truthy(stored);
    } catch {
      /* SSR / restricted storage — fall through */
    }
  }
  const env = (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_SINGLE_CTX_PREVIEW;
  return env == null ? true : truthy(env);
}

/**
 * Preview WebGL context governor (todo.md Phase 2) — bounds the number of LIVE preview WebGL2 contexts so a
 * large, many-clip timeline never crosses the browser's ~16-context cap (which force-loses the OLDEST context
 * → `texImage2D` spam + a permanent fall to the non-pixel-identical DOM path). When ON, `gl-context.ts`
 * enforces its budget: per-layer `MediaWebGLRenderer` allocation routes through `requestContextSlot` (evicting
 * the least-valuable idle context when over the hard cap) and preview media layers release their renderer
 * after a grace period once their clip leaves the active window.
 *
 * DEFAULT ON (flipped 2026-07-02) — proven via the GPU preview-contention stress gate
 * (`pnpm --filter @lumio-by-aelivion/worker governor:stress`, real Chrome): enforced run bounded peak at 7
 * live contexts with 12 LRU evictions + clean lazy recreation + the root scene preview alive (settling to
 * the hard cap 4), while the control run (governor off) climbed unbounded to 13 on the same fixture.
 * Telemetry (`__rfGlContextBudget`) is always on regardless of this flag; only ENFORCEMENT is gated.
 * Escape hatch: `?glGovernor=0`.
 *
 * Resolution order: `?glGovernor=0|1` → localStorage `lumio.glGovernor` → `VITE_GL_GOVERNOR` → true.
 */
export function getGlGovernorEnabled(): boolean {
  const truthy = (v: string | null | undefined): boolean => v === "1" || v === "true";
  if (typeof window !== "undefined") {
    try {
      if (new URLSearchParams(window.location.search).has("glGovernor")) {
        return truthy(new URLSearchParams(window.location.search).get("glGovernor"));
      }
      const stored = window.localStorage?.getItem("lumio.glGovernor");
      if (stored != null) return truthy(stored);
    } catch {
      /* SSR / restricted storage — fall through */
    }
  }
  const env = (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_GL_GOVERNOR;
  return env == null ? true : truthy(env);
}
