/**
 * Preview-suspend signal for main-thread exports.
 *
 * Scene-mode local export runs on the MAIN THREAD (its multi-/cross-context WebGL is only reliable
 * there — see local-export.ts), creating its own `SceneFrameCompositor` + per-media WebGL contexts on
 * top of the LIVE editor preview's contexts. That can push past the browser's ~16-context cap, so the
 * browser evicts the oldest context — the preview's — and if the preview's rAF loop is mid-upload when
 * that happens it floods the console with `texImage2D: Can't upload from a lost WebGL context`, then
 * drops to the DOM path. Pausing the preview's GPU compositing for the duration of a main-thread export
 * means it isn't touching its context when the eviction lands → the eviction is silent, and the preview
 * repaints the current frame once the export releases.
 *
 * A refcount (not a boolean) so nested/overlapping exports compose correctly; the preview polls
 * `isPreviewSuspendedForExport()` once per frame in its rAF loop, so no subscription is needed.
 */

let suspendCount = 0;

export function beginPreviewSuspendForExport(): void {
  suspendCount += 1;
}

export function endPreviewSuspendForExport(): void {
  suspendCount = Math.max(0, suspendCount - 1);
}

export function isPreviewSuspendedForExport(): boolean {
  return suspendCount > 0;
}
