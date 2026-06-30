/**
 * Gated WebGL-budget debug logging for local export.
 *
 * Opt-in (`?exportGlDebug=1` or `localStorage["lumio.exportGlDebug"] = "1"`), OFF by default so the normal
 * export console stays clean. When on, the export pipeline emits `[export-gl]` lines — preview-suspend state,
 * media renderers created/reused, live + peak WebGL context counts — so the context budget (the media-renderer
 * pool, the threshold warn, the stress gate) is observable. The flag check mirrors `getExportCompositor`'s
 * query → localStorage pattern in `../color/render-engine`.
 *
 * The threshold WARN (`warnExportGlThresholdOnce`) is NOT gated — exceeding the safe context count is a real
 * "you're near eviction" signal worth surfacing even without the debug flag, but it fires at most once per
 * process so it can't spam.
 */

let cachedEnabled: boolean | null = null;

function debugEnabled(): boolean {
  if (cachedEnabled !== null) return cachedEnabled;
  let enabled = false;
  try {
    if (typeof window !== "undefined") {
      if (new URLSearchParams(window.location.search).get("exportGlDebug") === "1") enabled = true;
      else if (window.localStorage?.getItem("lumio.exportGlDebug") === "1") enabled = true;
    }
  } catch {
    /* no window/localStorage (export Worker) → stay off */
  }
  cachedEnabled = enabled;
  return enabled;
}

/** Log a `[export-gl]` line when the debug flag is on. The message is a thunk so it's free when off. */
export function logExportGl(message: () => string): void {
  if (!debugEnabled()) return;
  // eslint-disable-next-line no-console
  console.log(`[export-gl] ${message()}`);
}

let warned = false;

/** Warn ONCE per process that the live WebGL context count crossed the safe threshold (not flag-gated). */
export function warnExportGlThresholdOnce(active: number, threshold: number): void {
  if (warned) return;
  warned = true;
  console.warn(
    `[export-gl] active WebGL contexts ${active} exceeds safe threshold ${threshold} — nearing the browser cap; ` +
      `the preview's context may be evicted. Export continues (pooled); falls back to canvas2D only if a frame's context is actually lost.`
  );
}
