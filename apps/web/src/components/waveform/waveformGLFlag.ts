/**
 * Feature gate for the WebGL2 waveform surface (Phase 2B). Default OFF — the per-clip Canvas renderer
 * is the default and permanent path because it lives INSIDE each clip's stacking context, so it
 * layers correctly under the clip's own controls (volume envelope + keyframes, fade handles, name,
 * selection halo) and under the playhead / label gutter. A single GPU overlay cannot: each
 * `.timeline-clip` is its own stacking context (position + z-index), so an overlay is either above
 * the whole clip (hiding those controls) or below it (hidden behind the clip). The Canvas path reads
 * the same finest-level pyramid resolution the GL path did, so there is NO detail difference.
 *
 * GL stays opt-in (`?glWaveform=1` or `localStorage.glWaveform = "1"`) for future perf experiments on
 * very-many-clip projects; requires WebGL2. See WAVEFORM_QA.md.
 */

let cached: boolean | null = null;

function supportsWebGL2(): boolean {
  try {
    const canvas = document.createElement("canvas");
    return Boolean(canvas.getContext("webgl2"));
  } catch {
    return false;
  }
}

export function isWaveformGLEnabled(): boolean {
  if (cached !== null) return cached;
  if (typeof window === "undefined") return false;
  let requested = false;
  try {
    const params = new URLSearchParams(window.location.search);
    requested = params.get("glWaveform") === "1" || window.localStorage.getItem("glWaveform") === "1";
  } catch {
    requested = false;
  }
  cached = requested && supportsWebGL2();
  return cached;
}
