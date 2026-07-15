/**
 * WaveformGLLayer (Phase 2B) — drives a single WebGL2 canvas that draws every registered audio-clip
 * waveform in a few instanced draws. The canvas is React-owned and lives INSIDE `.timeline-tracks`
 * (see TimelineStrip), absolutely positioned and pinned to the dock's visible viewport each frame via
 * a CSS transform. Living inside the timeline's own stacking context (not a `position:fixed` overlay
 * on document.body) is what keeps it BELOW the playhead and track-label gutter and ABOVE clips —
 * i.e. it layers exactly like the per-clip Canvas renderer it replaces.
 *
 * Positions come from each clip's live DOM rect (via waveformGLStore) measured relative to the dock,
 * so there's no duplicated pxPerSecond/lane math and the GL output lands exactly where the DOM clip
 * is. A per-frame rAF loop reads rects, culls to the viewport, uploads any new source textures, and
 * issues the instanced draws. Falls back to the per-clip Canvas renderer when this is disabled.
 */

import { useEffect } from "react";
import { getCachedPyramid, getTextureLevel, getAudioPeaks } from "../../lib/audioPeaks";
import { WaveformGLRenderer, type WaveInstance } from "./WaveformGLRenderer";
import { getWaveformEntries } from "./waveformGLStore";

type Props = { canvas: HTMLCanvasElement | null; laneOffsetPx: number };

export function WaveformGLLayer({ canvas, laneOffsetPx }: Props) {
  useEffect(() => {
    if (!canvas) return;
    const dock = canvas.closest(".editor-timeline-dock");
    const tracks = canvas.closest(".timeline-tracks");
    if (!(dock instanceof HTMLElement) || !(tracks instanceof HTMLElement)) return;

    let renderer: WaveformGLRenderer | null = null;
    try {
      renderer = new WaveformGLRenderer(canvas);
    } catch {
      return; // WebGL2 unavailable → Canvas fallback (per-clip <canvas>) stays in the tree
    }
    const gl = renderer;
    const maxTex = gl.maxTextureSize;
    let raf = 0;
    let disposed = false;

    const frame = () => {
      if (disposed) return;
      raf = requestAnimationFrame(frame);
      const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
      const dockRect = dock.getBoundingClientRect();
      const tracksRect = tracks.getBoundingClientRect();
      const clientW = dock.clientWidth;
      const clientH = dock.clientHeight;
      // Pin the (absolutely-positioned, in-tracks) canvas to the dock's visible viewport so clip rects
      // measured relative to the dock map 1:1 onto canvas pixels. The transform cancels the tracks'
      // scroll offset within the dock; the canvas top-left thus sits at the dock viewport's top-left.
      canvas.style.width = `${clientW}px`;
      canvas.style.height = `${clientH}px`;
      canvas.style.transform = `translate(${dockRect.left - tracksRect.left}px, ${dockRect.top - tracksRect.top}px)`;
      gl.resize(clientW, clientH, dpr);

      // Sticky track-label gutter width, measured from the DOM so the scissor matches the real label
      // edge exactly (laneOffsetPx alone missed the dock's left padding, leaking ~16px over the menu).
      let gutterCss = laneOffsetPx;
      const label = tracks.querySelector(".timeline-track-label");
      if (label instanceof HTMLElement) {
        gutterCss = Math.max(0, label.getBoundingClientRect().right - dockRect.left);
      }

      const instances: WaveInstance[] = [];
      for (const entry of getWaveformEntries()) {
        const rect = entry.element.getBoundingClientRect();
        const x = rect.left - dockRect.left;
        const y = rect.top - dockRect.top;
        if (rect.width <= 0 || rect.height <= 0) continue;
        // Cull to the viewport (with the sticky label gutter excluded on the left).
        if (x + rect.width <= gutterCss || x >= clientW || y + rect.height <= 0 || y >= clientH) continue;

        const pyramid = getCachedPyramid(entry.url);
        if (!pyramid) {
          void getAudioPeaks(entry.url); // warm the cache; drawn next frame once ready
          continue;
        }
        if (!gl.hasSource(entry.url)) {
          const level = getTextureLevel(pyramid, maxTex);
          if (level) gl.uploadSource(entry.url, level);
        }
        const dur = pyramid.duration || entry.durationSeconds || 1;
        const inFrac = Math.max(0, Math.min(1, entry.sourceInSeconds / dur));
        const outFrac = Math.max(0, Math.min(1, (entry.sourceInSeconds + entry.durationSeconds) / dur));
        const muted = entry.element.closest(".timeline-lane.is-muted") !== null;
        instances.push({
          sourceId: entry.url,
          x,
          width: rect.width,
          laneTop: y,
          laneHeight: rect.height,
          inFrac,
          outFrac: outFrac <= inFrac ? Math.min(1, inFrac + 1e-4) : outFrac,
          tint: entry.tint,
          stateAlpha: muted ? 0.4 : 1
        });
      }
      gl.setInstances(instances);
      gl.render(gutterCss, dpr);
    };
    raf = requestAnimationFrame(frame);

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      gl.dispose();
    };
  }, [canvas, laneOffsetPx]);

  return null;
}
