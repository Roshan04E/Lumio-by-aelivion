/**
 * Export WebGL-context-budget stress page (`export:stress` gate).
 *
 * Constructs ONE `SceneFrameCompositor` over a large (24-clip) timeline — each clip carries bloom + blur +
 * a color grade — and SWEEPS `renderFrame(t)` across the whole duration, so every clip becomes active then
 * inactive. This drives the media-renderer pool (`pruneMediaRenderers` + free-list reuse) exactly as a real
 * long export does. It records the PEAK live WebGL context count (`getActiveGlContextCount`) and surfaces it
 * (plus baseline/final) via `data-` attributes + `[export-gl]` console lines, so the Playwright worker script
 * can assert the count stays bounded (pool reuse, not one-per-clip) with no "lost WebGL context" error.
 *
 * Like the other export gates it needs a real WebGL2 GPU + the export decode path, so run the gate with
 * `PIXEL_BROWSER_CHANNEL=chrome` (bundled Chromium lacks WebGL2).
 */

import { useEffect, useState } from "react";
import { createExportStressFixture, getActiveGlContextCount } from "@kimera-by-aelivion/shared";
import { buildSourceUrlMap } from "../export/export-core";
import { createFrameProvider, type FrameProvider } from "../export/source-decoder";
import { SceneFrameCompositor } from "../export/scene-frame-compositor";

function clipCountFromUrl(): number {
  if (typeof window === "undefined") return 24;
  const raw = Number(new URLSearchParams(window.location.search).get("clips"));
  return Number.isFinite(raw) && raw >= 2 ? Math.floor(raw) : 24;
}

// The fixture image is an SVG data URL; `createImageBitmap(blob)` can't decode SVG in Chrome, so rasterize it
// to a PNG data URL via <img>→canvas. Keeps the real decode path under test.
async function bitmapDecodableUrl(url: string): Promise<string> {
  if (!url.startsWith("data:image/svg")) return url;
  const img = new Image();
  img.decoding = "async";
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("fixture SVG failed to decode"));
    img.src = url;
  });
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth || 1080;
  canvas.height = img.naturalHeight || 1920;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("fixture SVG raster: 2D context unavailable");
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/png");
}

export function ExportStressPage() {
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [message, setMessage] = useState<string>("");
  const [peak, setPeak] = useState(0);
  const [baseline, setBaseline] = useState(0);
  const [final, setFinal] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const sources = new Map<string, FrameProvider>();
    let compositor: SceneFrameCompositor | null = null;

    async function run() {
      const fixture = createExportStressFixture(clipCountFromUrl());
      const composition = fixture.graph.composition;
      if (!composition) throw new Error("stress fixture has no composition");

      const assetUrl = new Map(fixture.assets.map((asset) => [asset.id, asset.fileUrl]));
      const urlMap = buildSourceUrlMap(composition, (id) => assetUrl.get(id));
      await Promise.all(
        Object.entries(urlMap).map(async ([key, { url, kind }]) => {
          const decodable = kind === "image" ? await bitmapDecodableUrl(url) : url;
          sources.set(key, await createFrameProvider(decodable, kind));
        })
      );
      if (cancelled) return;

      // Baseline context count BEFORE the compositor exists, so the worker can assert we return to it on dispose.
      const baselineCount = getActiveGlContextCount();
      setBaseline(baselineCount);
      console.log(`[export-gl] stress baseline contexts=${baselineCount}, clips=${fixture.clipCount}`);

      // Use an OffscreenCanvas (NOT a connected DOM canvas) so the scene output's context is freed on dispose
      // exactly like the real export (runExportCore renders into a `new OffscreenCanvas`). A DOM canvas stays
      // `isConnected`, so releaseContextIfDetached would keep its context → final wouldn't return to baseline.
      const outputCanvas = new OffscreenCanvas(composition.width, composition.height);
      compositor = new SceneFrameCompositor(composition, outputCanvas, (id) => sources.get(id));

      // Sweep the whole timeline (~4 samples per 0.5s clip) so each clip enters AND leaves the active set,
      // exercising the pool. Track the peak live context count.
      let peakCount = baselineCount;
      const step = 0.12;
      for (let t = 0; t < fixture.durationSeconds; t += step) {
        if (cancelled) return;
        await compositor.renderFrame(t);
        peakCount = Math.max(peakCount, getActiveGlContextCount());
      }
      const compositorPeak = compositor.getPeakContextCount();
      peakCount = Math.max(peakCount, compositorPeak);
      setPeak(peakCount);
      console.log(`[export-gl] stress peak contexts=${peakCount} (compositor peak=${compositorPeak})`);

      // Dispose and confirm the count returns to baseline (rule 5: release immediately after export).
      compositor.dispose();
      compositor = null;
      const finalCount = getActiveGlContextCount();
      setFinal(finalCount);
      console.log(`[export-gl] stress final contexts=${finalCount} (baseline=${baselineCount})`);

      if (cancelled) return;
      setState("ready");
    }

    run().catch((error) => {
      if (cancelled) return;
      console.error("ExportStressPage failed", error);
      setMessage(String(error));
      setState("error");
    });

    return () => {
      cancelled = true;
      compositor?.dispose();
      for (const source of sources.values()) source.dispose();
    };
  }, []);

  return (
    <section
      className="export-stress-page"
      data-render-fixture={state === "ready" ? "ready" : state}
      data-peak-contexts={peak}
      data-baseline-contexts={baseline}
      data-final-contexts={final}
      style={{ margin: 0, padding: 0, background: "#000", color: "#fff", fontFamily: "monospace" }}
    >
      <pre>
        state={state} peak={peak} baseline={baseline} final={final}
      </pre>
      {state === "error" ? <pre data-export-error>{message}</pre> : null}
    </section>
  );
}
