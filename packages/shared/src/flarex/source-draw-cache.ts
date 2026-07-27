/**
 * Flarex source-draw cache (build-scene-draws optimization).
 *
 * PROBLEM (measured): a Flarex comp's asset-source `MediaIn`s each rebuild a full per-clip source draw
 * every playback frame via `resolveSourceDraw` → `buildLayerPreFlarexDraw` → `buildLayerDraw` +
 * `getCompositionTransform` + `buildFragmentPasses`. The profiler showed this `resolveSourceDraw` cost is
 * ~54% of compile time, and the draw STRUCTURE is identical frame to frame — only the live media handle
 * (graded canvas + its version) changes. Those builder functions have no cache; they reconstruct the same
 * object graph every frame.
 *
 * SOLUTION: cache the immutable source-draw TEMPLATE keyed by stable composition state and, on a hit,
 * rebind ONLY the live media resources (`source`/`sourceWidth`/`sourceHeight`/`sourceVersion`). The
 * builders are skipped entirely on a hit.
 *
 * CORRECTNESS: virtual loader layers (`collectFlarexVirtualLayers`) are BARE — identity transform,
 * `effects: []`, no keyframes/animations/masks — so their presentation is time-INVARIANT; no resolved-time
 * axis is needed in the key, and the cached template is byte-identical to a fresh rebuild for every frame.
 * The media handle is the ONLY per-frame-volatile part and is always rebound, so a playing video never
 * serves stale pixels (the compositor's upload-skip keys on the rebound `sourceVersion`). The caller
 * guards cacheability (bare only) so a hypothetical future non-bare loader falls back to a full rebuild
 * rather than reuse a stale presentation. This lives entirely in the draw-build layer — the Flarex
 * evaluator is untouched (no retained node graph, no evaluator cache).
 *
 * The template is never handed out directly: a hit returns a fresh `{ ...template, <media> }` object and a
 * miss returns the just-built draw (which the compiler clones before mutating), so cached entries are
 * immutable in practice; the template is additionally shallow-frozen to catch accidental mutation in dev.
 */

import type { SceneLayerDraw } from "../color/scene-compositor";

/** Bounded (LRU) store of immutable source-draw templates, keyed by `(layerId, comp.version, renderScale)`.
 *  Owned + persisted across frames by the caller (e.g. `ScenePreviewCanvas`), mirroring `SceneMaskMatteCache`. */
export class FlarexSourceDrawCache {
  private readonly entries = new Map<string, SceneLayerDraw>();
  private readonly cap: number;

  constructor(cap = 64) {
    this.cap = Math.max(1, cap);
  }

  /** Stable cache key. `renderScale` is folded in defensively (a bare loader's presentation doesn't
   *  actually depend on it today, but a future blurred/tilted loader would). */
  static key(layerId: string, compVersion: number, renderScale: number): string {
    return `${layerId}|${compVersion}|${renderScale}`;
  }

  /** LRU get: touch the entry (move to newest) so eviction targets genuinely idle templates. */
  get(key: string): SceneLayerDraw | undefined {
    const template = this.entries.get(key);
    if (template !== undefined) {
      this.entries.delete(key);
      this.entries.set(key, template);
    }
    return template;
  }

  /** Store a template, evicting the least-recently-used entries past the cap. */
  set(key: string, template: SceneLayerDraw): void {
    this.entries.delete(key);
    this.entries.set(key, template);
    while (this.entries.size > this.cap) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}
