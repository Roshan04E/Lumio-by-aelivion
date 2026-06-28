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

/** True when the unified WebGL media renderer should be used for video/image layers. */
export function useWebglRenderer(supported: boolean): boolean {
  return supported && getRendererMode() === "webgl";
}
