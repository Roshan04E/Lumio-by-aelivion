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
 * RENDERER_MODE). The formal pixel sweep (`pnpm --filter @reelforge/worker render:compare:pixels`
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
