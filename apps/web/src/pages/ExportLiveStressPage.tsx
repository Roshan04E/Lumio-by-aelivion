/**
 * Real-world export + live-preview WebGL budget gate (`export:live-stress`).
 *
 * Unlike `ExportStressPage` (which runs the export compositor in ISOLATION), this mounts the REAL editor
 * preview (`ScenePreviewCanvas` + a handful of `MediaWebGLRenderer` graded-canvas sources, exactly what
 * `WebglMediaLayer` provides in the app — each a live WebGL context) AND runs the REAL `exportLocally`
 * pipeline over a 20–30 clip bloom/blur/grade timeline, REPEATED 2–3×. This is the actual contention the
 * fixes target: the default Worker scene export must keep the preview alive without needing preview suspend;
 * when Worker scene is forced off, the main-thread fallback must still SUSPEND the preview so it can RESTORE
 * after export (keep compositing, no DOM fallback).
 *
 * Asserted (via data-attributes the worker reads): whether preview suspend was observed; the preview never
 * failed/fell back across all exports; no "lost WebGL context" error; all exports completed. Logged:
 * peak live context count, per-export suspend state, and (via `?exportGlDebug=1`) the `[export-gl]` pool lines.
 *
 * Needs a real WebGL2 GPU + WebCodecs encode — run with `PIXEL_BROWSER_CHANNEL=chrome`.
 */

import { useEffect, useRef, useState } from "react";
import {
  MediaWebGLRenderer,
  createExportStressFixture,
  getActiveGlContextCount,
  type TimelineLayer,
} from "@reelforge/shared";
import { ScenePreviewCanvas } from "../components/ScenePreviewCanvas";
import { exportLocally, canExportLocally } from "../export/local-export";
import { isPreviewSuspendedForExport } from "../export/export-preview-suspend";

function intParam(name: string, fallback: number): number {
  if (typeof window === "undefined") return fallback;
  const raw = Number(new URLSearchParams(window.location.search).get(name));
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : fallback;
}

// Rasterize the fixture's SVG data URL to a PNG data URL — createImageBitmap can't decode SVG blobs (the
// export's createImageSource), and we also need a decoded <img> for the preview's MediaWebGLRenderer sources.
async function rasterize(svgUrl: string): Promise<{ pngUrl: string; image: HTMLImageElement }> {
  const img = new Image();
  img.decoding = "async";
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("fixture SVG failed to decode"));
    img.src = svgUrl;
  });
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth || 1080;
  canvas.height = img.naturalHeight || 1920;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("fixture SVG raster: 2D context unavailable");
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  const pngUrl = canvas.toDataURL("image/png");
  const png = new Image();
  await new Promise<void>((resolve, reject) => {
    png.onload = () => resolve();
    png.onerror = () => reject(new Error("PNG re-decode failed"));
    png.src = pngUrl;
  });
  return { pngUrl, image: png };
}

export function ExportLiveStressPage() {
  const gradedRef = useRef<Record<string, HTMLCanvasElement | null>>({});
  const previewFailedRef = useRef(false);
  const [previewLayers, setPreviewLayers] = useState<TimelineLayer[]>([]);
  const [state, setState] = useState<"loading" | "running" | "ready" | "error">("loading");
  const [message, setMessage] = useState("");
  const [metrics, setMetrics] = useState({ exportsCompleted: 0, sawSuspended: false, previewFailed: false, peak: 0, baseline: 0, final: 0 });

  const exports = intParam("exports", 3);
  const clips = intParam("clips", 24);

  useEffect(() => {
    let cancelled = false;
    const previewRenderers: MediaWebGLRenderer[] = [];

    async function run() {
      if (!canExportLocally()) throw new Error("canExportLocally() = false (WebCodecs/OffscreenCanvas missing)");

      const fixture = createExportStressFixture(clips);
      const composition = fixture.graph.composition!;
      const asset = fixture.assets[0]!;
      const { pngUrl, image } = await rasterize(asset.fileUrl);
      if (cancelled) return;

      // Build a realistic PREVIEW frame: a few image layers (active at t=0), each fed by its own
      // MediaWebGLRenderer graded canvas — i.e. real live WebGL contexts, exactly like WebglMediaLayer.
      const PREVIEW_LAYER_COUNT = 3;
      const layers: TimelineLayer[] = Array.from({ length: PREVIEW_LAYER_COUNT }, (_, i) => ({
        id: `preview_layer_${i}`,
        trackId: "video_track",
        type: "image",
        name: `Preview ${i}`,
        startSeconds: 0,
        durationSeconds: 9999,
        assetId: asset.id,
        fit: "cover",
        transform: { position: { x: 30 + i * 20, y: 50 }, scale: 0.6, rotation: 0, opacity: 100 },
        effects: [],
        keyframes: [],
      }));
      for (const layer of layers) {
        const renderer = new MediaWebGLRenderer(document.createElement("canvas"));
        renderer.draw({ source: image, sourceWidth: image.naturalWidth, sourceHeight: image.naturalHeight, pipeline: null });
        previewRenderers.push(renderer);
        gradedRef.current[layer.id] = renderer.canvas as HTMLCanvasElement;
      }
      if (cancelled) return;
      setPreviewLayers(layers); // mounts ScenePreviewCanvas (the real preview SceneCompositor context)
      setState("running");

      // Let the preview mount + composite a few frames so its context is live before we start exporting.
      await new Promise((r) => setTimeout(r, 400));
      const baseline = getActiveGlContextCount();

      let peak = baseline;
      let sawSuspendedEvery = true;
      let completed = 0;
      const urlForAsset = (id: string) => (id === asset.id ? pngUrl : undefined);

      for (let r = 0; r < exports; r += 1) {
        if (cancelled) return;
        let sawSuspendedThisExport = false;
        const sampler = window.setInterval(() => {
          if (isPreviewSuspendedForExport()) sawSuspendedThisExport = true;
          peak = Math.max(peak, getActiveGlContextCount());
        }, 40);
        try {
          await exportLocally({ composition, urlForAsset, format: "mp4" });
          completed += 1;
        } finally {
          window.clearInterval(sampler);
        }
        sawSuspendedEvery = sawSuspendedEvery && sawSuspendedThisExport;
        // Let the preview resume + composite after the export releases — if its context was evicted the next
        // draw throws → onFailure → previewFailedRef. A surviving preview keeps compositing with no failure.
        await new Promise((r2) => setTimeout(r2, 500));
        console.log(
          `[export-gl] live-stress export ${r + 1}/${exports} done: sawSuspended=${sawSuspendedThisExport}, ` +
            `previewFailed=${previewFailedRef.current}, contexts=${getActiveGlContextCount()}, peak=${peak}`
        );
        if (previewFailedRef.current) break; // preview lost its context — stop, the gate will fail
      }

      const final = getActiveGlContextCount();
      setMetrics({ exportsCompleted: completed, sawSuspended: sawSuspendedEvery, previewFailed: previewFailedRef.current, peak, baseline, final });
      if (cancelled) return;
      setState("ready");
    }

    run().catch((error) => {
      if (cancelled) return;
      console.error("ExportLiveStressPage failed", error);
      setMessage(String(error));
      setState("error");
    });

    return () => {
      cancelled = true;
      for (const renderer of previewRenderers) {
        try {
          renderer.dispose();
        } catch {
          /* ignore */
        }
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <section
      className="export-live-stress-page"
      data-render-fixture={state === "ready" ? "ready" : state === "error" ? "error" : "loading"}
      data-exports-completed={metrics.exportsCompleted}
      data-saw-suspended={metrics.sawSuspended ? "1" : "0"}
      data-preview-failed={metrics.previewFailed ? "1" : "0"}
      data-peak-contexts={metrics.peak}
      data-baseline-contexts={metrics.baseline}
      data-final-contexts={metrics.final}
      style={{ margin: 0, padding: 0, background: "#000", color: "#fff", fontFamily: "monospace" }}
    >
      {/* The real preview — holds live WebGL contexts that the export must not knock out. */}
      <div style={{ position: "relative", width: 270, height: 480, overflow: "hidden" }}>
        {previewLayers.length > 0 ? (
          <ScenePreviewCanvas
            layers={previewLayers}
            width={1080}
            height={1920}
            backgroundColor="#000000"
            currentTime={0}
            isPlaying
            gradedRef={gradedRef}
            onFailure={() => {
              previewFailedRef.current = true;
            }}
          />
        ) : null}
      </div>
      <pre>
        state={state} exports={metrics.exportsCompleted}/{exports} sawSuspended={String(metrics.sawSuspended)}{" "}
        previewFailed={String(metrics.previewFailed)} peak={metrics.peak} baseline={metrics.baseline} final={metrics.final}
      </pre>
      {state === "error" ? <pre data-export-error>{message}</pre> : null}
    </section>
  );
}
