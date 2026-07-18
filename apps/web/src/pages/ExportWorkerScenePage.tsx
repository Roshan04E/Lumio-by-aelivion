/**
 * Phase 2 — Stage 3 gate (`export:worker-scene`). POSITIVE control.
 *
 * Proves the Phase 2 payoff: SINGLE-CONTEXT scene export runs correctly IN THE EXPORT WORKER — the case that
 * black-frames today on the legacy multi-/cross-context path (the Stage 0 negative probe reproduced that).
 * The single self-contained WebGL2 context (Stage 1/2) is what survives the Worker's isolated GPU process.
 *
 * It exercises the REAL risky case (same fixture as the Stage 0 probe):
 *   - REAL VIDEO sources via the WebCodecs decode path (an H.264 MP4 minted in-browser with the export's own
 *     `MediaEncoder`, fed back as a data URL so the Worker's mp4box+VideoDecoder path runs),
 *   - 20–30 clips, each with bloom + blur + color grade (the stress fixture's heavy GPU stack),
 *   - sampled at many times across the whole timeline,
 *   - REPEATED 2–3×,
 *   - compared frame-for-frame (luma) against a MAIN-THREAD single-context scene reference,
 *   - asserting: export completes, NO black frames, NO scene→canvas2D fallback (bloom/blur loss → big diff).
 *
 * It drives its OWN Worker directly with `exportCompositor:"scene"` + `exportSingleContext:true` (the same
 * input `local-export.ts` threads when Stage 3 routing is enabled), so it tests the Worker scene path without
 * touching default routing. Lost-WebGL-context + scene-fallback console lines are asserted by the gate script
 * (it scans the forwarded page/worker console).
 *
 * Parity note: the reference is an uncompressed canvas render and the worker output is a lossy H.264 MP4, so
 * exact-pixel parity is impossible here — we use a luma diff with a per-pixel tolerance (H.264 noise) and a
 * small whole-frame diff budget. TRUE pixel parity of the scene compositor itself is gate-locked separately
 * by `scene:compare` (scene preview == DOM), which transitively covers the export; this gate's job is the Worker.
 *
 * Needs real WebGL2 (main + worker) + WebCodecs encode/decode → run with `PIXEL_BROWSER_CHANNEL=chrome`.
 */

import { useEffect, useState } from "react";
import { createExportStressFixture, type TimelineComposition, type TimelineLayer } from "@orreris/shared";
import { type ExportCoreInput, type SourceUrlMap } from "../export/export-core";
import { clipSourceKey, createFrameProvider, type FrameProvider } from "../export/source-decoder";
import { SceneFrameCompositor } from "../export/scene-frame-compositor";
import { MediaEncoder } from "../export/video-encoder";
import type { ExportWorkerRequest, ExportWorkerResponse } from "../export/export-worker-protocol";

const GATE_VIDEO_ASSET = "gate_video";

function intParam(name: string, fallback: number, min = 1): number {
  if (typeof window === "undefined") return fallback;
  const raw = Number(new URLSearchParams(window.location.search).get(name));
  return Number.isFinite(raw) && raw >= min ? Math.floor(raw) : fallback;
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error("blob→dataURL failed"));
    reader.readAsDataURL(blob);
  });
}

/** Mint a short animated H.264 MP4 (data URL) using the export's own encoder — a real WebCodecs-decodable
 *  source. The bright moving disc gives bloom highlights to bloom from AND makes frames differ over time. */
async function generateVideoDataUrl(width: number, height: number, fps: number, seconds: number): Promise<string> {
  const enc = new MediaEncoder({ width, height, fps, format: "mp4" });
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("gate: gen video 2D context unavailable");
  const frames = Math.max(1, Math.round(fps * seconds));
  for (let i = 0; i < frames; i += 1) {
    const p = i / frames;
    ctx.fillStyle = "#101018";
    ctx.fillRect(0, 0, width, height);
    const cx = width * (0.2 + 0.6 * p);
    const cy = height * 0.4;
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, width * 0.4);
    g.addColorStop(0, "#fff7e0");
    g.addColorStop(0.4, "#e08a3c");
    g.addColorStop(1, "#120a06");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, width * 0.4, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#fffbe8";
    ctx.beginPath();
    ctx.arc(cx, cy, width * 0.13, 0, Math.PI * 2);
    ctx.fill();
    await enc.addVideoFrame(canvas, i);
  }
  return blobToDataUrl(await enc.finalize());
}

/** Reuse the stress fixture's bloom/blur/grade composition but swap every visual clip to the generated VIDEO. */
function buildVideoComposition(clips: number): TimelineComposition {
  const fixture = createExportStressFixture(clips);
  const composition = structuredClone(fixture.graph.composition!) as TimelineComposition;
  for (const track of composition.tracks) {
    for (const layer of track.layers) {
      if (layer.type === "image" || layer.type === "video") {
        layer.type = "video";
        layer.assetId = GATE_VIDEO_ASSET;
        layer.sourceInSeconds = 0;
      }
    }
  }
  return composition;
}

function mediaSourceKey(layer: TimelineLayer): string | null {
  if ((layer.type !== "video" && layer.type !== "image") || !layer.assetId) return null;
  return layer.type === "video" ? clipSourceKey(layer.id, layer.assetId) : layer.assetId;
}

/** Draw any source into a fixed small 2D buffer (normalizes size + damps H.264 noise) → luma stats. */
function sampleLuma(source: CanvasImageSource, w: number, h: number): { data: Uint8ClampedArray; meanLuma: number } {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("gate: sample 2D context unavailable");
  ctx.drawImage(source, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h).data;
  let sum = 0;
  for (let i = 0; i < data.length; i += 4) sum += 0.2126 * data[i]! + 0.7152 * data[i + 1]! + 0.0722 * data[i + 2]!;
  return { data, meanLuma: sum / (w * h) };
}

function lumaDiffPct(a: Uint8ClampedArray, b: Uint8ClampedArray, tol: number): number {
  let differing = 0;
  const n = a.length / 4;
  for (let i = 0; i < a.length; i += 4) {
    const la = 0.2126 * a[i]! + 0.7152 * a[i + 1]! + 0.0722 * a[i + 2]!;
    const lb = 0.2126 * b[i]! + 0.7152 * b[i + 1]! + 0.0722 * b[i + 2]!;
    if (Math.abs(la - lb) > tol) differing += 1;
  }
  return (differing / n) * 100;
}

/** Load an exported Blob into a seekable <video>. */
async function loadVideo(blob: Blob): Promise<HTMLVideoElement> {
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  video.src = URL.createObjectURL(blob);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("worker MP4 never loaded")), 30_000);
    video.addEventListener("loadeddata", () => { clearTimeout(timer); resolve(); }, { once: true });
    video.addEventListener("error", () => { clearTimeout(timer); reject(new Error("worker MP4 decode error")); }, { once: true });
  });
  return video;
}

async function seekVideo(video: HTMLVideoElement, t: number): Promise<void> {
  await new Promise<void>((resolve) => {
    video.addEventListener("seeked", () => resolve(), { once: true });
    video.currentTime = Math.max(0, Math.min(t, (video.duration || t) - 1e-3));
  });
}

/** Drive the REAL export Worker with exportCompositor:"scene" + exportSingleContext:true (Stage 3 path). */
function runWorkerSceneExport(input: ExportCoreInput): Promise<Blob> {
  return new Promise<Blob>((resolve, reject) => {
    const worker = new Worker(new URL("../export/export.worker.ts", import.meta.url), { type: "module" });
    const timer = setTimeout(() => { worker.terminate(); reject(new Error("worker export timed out")); }, 240_000);
    worker.onmessage = (event: MessageEvent<ExportWorkerResponse>) => {
      const msg = event.data;
      if (msg.type === "progress") {
        if (msg.label.startsWith("[worker-scene-stage]")) console.log(msg.label);
        return;
      }
      clearTimeout(timer);
      worker.terminate();
      if (msg.type === "done") resolve(new Blob([msg.buffer], { type: msg.mime }));
      else reject(new Error(msg.message || "worker export failed"));
    };
    worker.onerror = (event) => { clearTimeout(timer); worker.terminate(); reject(new Error(event.message || "worker crashed")); };
    worker.postMessage({ type: "start", payload: input } satisfies ExportWorkerRequest);
  });
}

export function ExportWorkerScenePage() {
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [message, setMessage] = useState("");
  const [pass, setPass] = useState<"" | "pass" | "fail">("");
  const [detail, setDetail] = useState("");
  const [refLuma, setRefLuma] = useState(0);
  const [workerLuma, setWorkerLuma] = useState(0);
  const [maxDiff, setMaxDiff] = useState(0);
  const [blackEvents, setBlackEvents] = useState(0);
  const [durExpected, setDurExpected] = useState(0);
  const [durActual, setDurActual] = useState(0);
  const [runsDone, setRunsDone] = useState(0);

  const clips = intParam("clips", 24, 2);
  const runs = intParam("runs", 2, 1);
  // Whole-frame luma-diff budget (%) past which we call it a scene→canvas2D fallback (bloom/blur lost). A
  // correct single-context worker frame differs from the uncompressed reference only by H.264 noise (small);
  // a fallback drops the entire bloom/blur → a large region differs.
  const fallbackDiffPct = Number(new URLSearchParams(typeof window !== "undefined" ? window.location.search : "").get("fallbackDiff") ?? "3");

  useEffect(() => {
    let cancelled = false;
    const refSources = new Map<string, FrameProvider>();
    let refCompositor: SceneFrameCompositor | null = null;

    async function run() {
      const composition = buildVideoComposition(clips);
      const duration = composition.durationSeconds;
      setDurExpected(Number(duration.toFixed(2)));

      // Mint a real H.264 MP4 source (WebCodecs-decodable) and reference it from every clip.
      const videoUrl = await generateVideoDataUrl(360, 640, composition.fps, Math.max(1, composition.durationSeconds / clips + 0.5));
      if (cancelled) return;
      const urlMap: SourceUrlMap = { [GATE_VIDEO_ASSET]: { url: videoUrl, kind: "video" } };

      const sampleW = 120;
      const sampleH = Math.max(1, Math.round((sampleW * composition.height) / composition.width));
      const clipDur = duration / clips;
      const sampleClips = Array.from(new Set([0, Math.floor(clips * 0.2), Math.floor(clips * 0.4), Math.floor(clips * 0.6), Math.floor(clips * 0.8), clips - 1]));
      const sampleTimes = sampleClips.map((i) => (i + 0.5) * clipDur);

      // (1) MAIN-THREAD reference: render each sample time through the SINGLE-CONTEXT SceneFrameCompositor
      // (the exact path the worker runs — so any diff is H.264 lossiness, not an engine difference).
      const refCanvas = new OffscreenCanvas(composition.width, composition.height);
      const ensureRefSourcesAt = async (t: number) => {
        for (const track of composition.tracks) {
          for (const layer of track.layers) {
            const key = mediaSourceKey(layer);
            if (!key || refSources.has(key)) continue;
            if (t < layer.startSeconds || t >= layer.startSeconds + layer.durationSeconds) continue;
            const source = layer.assetId ? urlMap[layer.assetId] : undefined;
            if (source) refSources.set(key, await createFrameProvider(source.url, layer.type === "video" ? "video" : "image"));
          }
        }
      };
      if (cancelled) return;
      refCompositor = new SceneFrameCompositor(composition, refCanvas, (id) => refSources.get(id), { singleContext: true });
      const refBuffers: { data: Uint8ClampedArray; meanLuma: number }[] = [];
      for (const t of sampleTimes) {
        if (cancelled) return;
        await ensureRefSourcesAt(t);
        await refCompositor.renderFrame(t);
        refBuffers.push(sampleLuma(refCanvas, sampleW, sampleH));
      }
      const refMean = refBuffers.reduce((s, b) => s + b.meanLuma, 0) / refBuffers.length;
      setRefLuma(Number(refMean.toFixed(2)));
      console.log(`[worker-scene] main-thread single-context reference meanLuma=${refMean.toFixed(2)} over ${sampleTimes.length} samples`);
      refCompositor.dispose();
      refCompositor = null;
      for (const s of refSources.values()) s.dispose();
      refSources.clear();
      const refBlack = refMean < 3;
      if (refBlack) {
        setPass("fail");
        setDetail(`main-thread single-context reference was black (meanLuma=${refMean.toFixed(2)}) — no valid baseline`);
        console.log(`[worker-scene] RESULT=fail — reference black`);
        setState("ready");
        return;
      }

      // (2) SINGLE-CONTEXT scene export THROUGH THE WORKER, repeated, sampled across the timeline.
      let failDetail = "";
      let lastWorkerMean = 0;
      let maxDiffSeen = 0;
      let blackCount = 0;
      let completedRuns = 0;
      let lastDuration = 0;

      for (let r = 0; r < runs && !cancelled; r += 1) {
        let blob: Blob;
        try {
          blob = await runWorkerSceneExport({
            composition,
            urlMap,
            audio: null,
            format: "mp4",
            exportCompositor: "scene",
            exportSingleContext: true,
            workerSceneDiagnostics: { sampleTimes, blackFrameGuard: true, stageProbes: true },
          });
        } catch (error) {
          const m = String(error instanceof Error ? error.message : error);
          if (!failDetail) failDetail = `worker scene export threw on run ${r + 1}: ${m}`;
          console.log(`[worker-scene] run ${r + 1}/${runs} ERRORED: ${m}`);
          break;
        }
        completedRuns += 1;
        console.log(`[worker-scene] run ${r + 1}/${runs} completed (${blob.size} bytes)`);
        if (cancelled) return;
        const video = await loadVideo(blob);
        lastDuration = video.duration;
        let runMeanSum = 0;
        for (let s = 0; s < sampleTimes.length; s += 1) {
          await seekVideo(video, sampleTimes[s]!);
          const ws = sampleLuma(video, sampleW, sampleH);
          console.log(`[worker-scene-stage] mp4 t=${sampleTimes[s]!.toFixed(3)} luma=${ws.meanLuma.toFixed(2)}`);
          runMeanSum += ws.meanLuma;
          const dp = lumaDiffPct(refBuffers[s]!.data, ws.data, 24);
          maxDiffSeen = Math.max(maxDiffSeen, dp);
          if (ws.meanLuma < 3) {
            blackCount += 1;
            if (!failDetail) failDetail = `worker frame BLACK at t=${sampleTimes[s]!.toFixed(2)}s (run ${r + 1})`;
          } else if (ws.meanLuma < 0.6 * refBuffers[s]!.meanLuma || dp > fallbackDiffPct) {
            if (!failDetail) failDetail = `worker diverged from scene reference at t=${sampleTimes[s]!.toFixed(2)}s (run ${r + 1}): workerLuma=${ws.meanLuma.toFixed(2)} refLuma=${refBuffers[s]!.meanLuma.toFixed(2)} diff=${dp.toFixed(2)}% > ${fallbackDiffPct}% — likely scene→canvas2D fallback (bloom/blur lost)`;
          }
        }
        lastWorkerMean = runMeanSum / sampleTimes.length;
        URL.revokeObjectURL(video.src);
        console.log(`[worker-scene] run ${r + 1}: workerLuma=${lastWorkerMean.toFixed(2)} refLuma=${refMean.toFixed(2)} maxDiff=${maxDiffSeen.toFixed(2)}% blackEvents=${blackCount} duration=${lastDuration.toFixed(2)}s/${duration.toFixed(2)}s`);
      }
      if (cancelled) return;

      const ok = completedRuns === runs && blackCount === 0 && !failDetail;
      setWorkerLuma(Number(lastWorkerMean.toFixed(2)));
      setMaxDiff(Number(maxDiffSeen.toFixed(2)));
      setBlackEvents(blackCount);
      setDurActual(Number(lastDuration.toFixed(2)));
      setRunsDone(completedRuns);
      setPass(ok ? "pass" : "fail");
      const summary = ok
        ? `worker single-context scene export matched main-thread scene across ${sampleTimes.length} samples × ${runs} runs (maxDiff=${maxDiffSeen.toFixed(2)}%, no black, no fallback)`
        : failDetail || `incomplete: ${completedRuns}/${runs} runs`;
      setDetail(summary);
      console.log(`[worker-scene] RESULT=${ok ? "pass" : "fail"} — ${summary}`);
      setState("ready");
    }

    run().catch((error) => {
      if (cancelled) return;
      console.error("ExportWorkerScenePage failed", error);
      setMessage(String(error));
      setState("error");
    });

    return () => {
      cancelled = true;
      refCompositor?.dispose();
      for (const s of refSources.values()) s.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <section
      className="export-worker-scene-page"
      data-gate-state={state}
      data-pass={pass}
      data-ref-luma={refLuma}
      data-worker-luma={workerLuma}
      data-max-diff={maxDiff}
      data-black-events={blackEvents}
      data-duration-expected={durExpected}
      data-duration-actual={durActual}
      data-runs-done={runsDone}
      style={{ margin: 0, padding: 16, background: "#000", color: "#fff", fontFamily: "monospace" }}
    >
      <pre>
        state={state} pass={pass || "…"} refLuma={refLuma} workerLuma={workerLuma} maxDiff={maxDiff}% blackEvents={blackEvents} runs={runsDone}/{runs} dur={durActual}/{durExpected}s
      </pre>
      <pre data-gate-detail>{detail}</pre>
      {state === "error" ? <pre data-gate-error>{message}</pre> : null}
    </section>
  );
}
