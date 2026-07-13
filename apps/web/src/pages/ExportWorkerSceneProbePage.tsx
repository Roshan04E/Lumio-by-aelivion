/**
 * Phase 2 — Stage 0 diagnostic probe (`export:worker-scene-probe`). NEGATIVE CONTROL.
 *
 * Proves/​disproves the premise behind Phase 2: that LEGACY scene-mode export (today's MULTI-context
 * `SceneFrameCompositor`, unchanged) is reliable on the MAIN thread but FAILS inside the export Worker — because
 * each media grade lives on its own WebGL2 context and `SceneCompositor` uploads those canvases cross-context,
 * which is documented to die in the Worker's isolated GPU process. That premise is why `local-export.ts` forces
 * scene to the main thread.
 *
 * Stage 0 v2 tests the REAL risky case (v1 used images and did NOT reproduce the failure):
 *   - REAL VIDEO sources via the WebCodecs decode path (an H.264 MP4 minted in-browser with the export's own
 *     `MediaEncoder`, fed back as a data URL so the Worker's mp4box+VideoDecoder path is exercised),
 *   - 20–30 clips, each with bloom + blur + color grade (the stress fixture's heavy GPU stack),
 *   - sampled at MANY times across the whole timeline (not only frame 0),
 *   - REPEATED 2–3×,
 *   - compared frame-for-frame (luma + diff) against a MAIN-THREAD scene reference,
 *   - detecting black frames, lost-WebGL-context, and the scene→canvas2D fallback (bloom/blur loss → big diff).
 *
 * It changes NO default behavior: it drives a hidden diagnostic route + its OWN Worker with
 * `exportCompositor:"scene"`. `local-export.ts` routing, `MediaWebGLRenderer`, `FrameCompositor`, and the editor
 * preview are untouched. Needs real WebGL2 (main + worker) + WebCodecs encode/decode → `PIXEL_BROWSER_CHANNEL=chrome`.
 *
 * NOTE on A/V sync: this probe is video-only (no audio track), so deep A/V sync is NOT assessed — it does check
 * the exported video DURATION matches the timeline (gross truncation/desync guard). Audio-sync is a follow-up.
 */

import { useEffect, useState } from "react";
import { createExportStressFixture, type TimelineComposition } from "@kimera-by-aelivion/shared";
import { type ExportCoreInput, type SourceUrlMap } from "../export/export-core";
import { createFrameProvider, type FrameProvider } from "../export/source-decoder";
import { SceneFrameCompositor } from "../export/scene-frame-compositor";
import { MediaEncoder } from "../export/video-encoder";
import type { ExportWorkerRequest, ExportWorkerResponse } from "../export/export-worker-protocol";

const PROBE_VIDEO_ASSET = "probe_video";

function intParam(name: string, fallback: number, min = 1): number {
  if (typeof window === "undefined") return fallback;
  const raw = Number(new URLSearchParams(window.location.search).get(name));
  return Number.isFinite(raw) && raw >= min ? Math.floor(raw) : fallback;
}

type Verdict = "reproduced-black" | "reproduced-fallback" | "reproduced-error" | "not-reproduced" | "cannot-run";

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error("blob→dataURL failed"));
    reader.readAsDataURL(blob);
  });
}

/** Mint a short animated H.264 MP4 (data URL) using the export's own encoder — a real WebCodecs-decodable source.
 *  The bright moving disc gives bloom highlights to bloom from AND makes frames differ over time, so a desynced
 *  decode would show up as a diff too. */
async function generateVideoDataUrl(width: number, height: number, fps: number, seconds: number): Promise<string> {
  const enc = new MediaEncoder({ width, height, fps, format: "mp4" });
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("probe: gen video 2D context unavailable");
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
        layer.assetId = PROBE_VIDEO_ASSET;
        layer.sourceInSeconds = 0;
      }
    }
  }
  return composition;
}

/** Draw any source into a fixed small 2D buffer (normalizes size + damps H.264 noise) → luma stats. */
function sampleLuma(source: CanvasImageSource, w: number, h: number): { data: Uint8ClampedArray; meanLuma: number } {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("probe: sample 2D context unavailable");
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

/** Drive the REAL export Worker with exportCompositor:"scene" (legacy multi-context path, in the Worker). */
function runWorkerSceneExport(input: ExportCoreInput): Promise<Blob> {
  return new Promise<Blob>((resolve, reject) => {
    const worker = new Worker(new URL("../export/export.worker.ts", import.meta.url), { type: "module" });
    const timer = setTimeout(() => { worker.terminate(); reject(new Error("worker export timed out")); }, 240_000);
    worker.onmessage = (event: MessageEvent<ExportWorkerResponse>) => {
      const msg = event.data;
      if (msg.type === "progress") return;
      clearTimeout(timer);
      worker.terminate();
      if (msg.type === "done") resolve(new Blob([msg.buffer], { type: msg.mime }));
      else reject(new Error(msg.message || "worker export failed"));
    };
    worker.onerror = (event) => { clearTimeout(timer); worker.terminate(); reject(new Error(event.message || "worker crashed")); };
    worker.postMessage({ type: "start", payload: input } satisfies ExportWorkerRequest);
  });
}

export function ExportWorkerSceneProbePage() {
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [message, setMessage] = useState("");
  const [verdict, setVerdict] = useState<Verdict | "">("");
  const [detail, setDetail] = useState("");
  const [refLuma, setRefLuma] = useState(0);
  const [workerLuma, setWorkerLuma] = useState(0);
  const [maxDiff, setMaxDiff] = useState(0);
  const [blackEvents, setBlackEvents] = useState(0);
  const [durExpected, setDurExpected] = useState(0);
  const [durActual, setDurActual] = useState(0);
  const [workerError, setWorkerError] = useState("");

  const clips = intParam("clips", 24, 2);
  const runs = intParam("runs", 2, 1);

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
      const urlMap: SourceUrlMap = { [PROBE_VIDEO_ASSET]: { url: videoUrl, kind: "video" } };

      const sampleW = 120;
      const sampleH = Math.max(1, Math.round((sampleW * composition.height) / composition.width));
      // Sample mid-clip across a spread of clips (covers the whole timeline, avoids clip-boundary ambiguity).
      const clipDur = duration / clips;
      const sampleClips = Array.from(new Set([0, Math.floor(clips * 0.2), Math.floor(clips * 0.4), Math.floor(clips * 0.6), Math.floor(clips * 0.8), clips - 1]));
      const sampleTimes = sampleClips.map((i) => (i + 0.5) * clipDur);

      // (1) MAIN-THREAD reference: render each sample time through the legacy multi-context SceneFrameCompositor.
      const refCanvas = new OffscreenCanvas(composition.width, composition.height);
      refSources.set(PROBE_VIDEO_ASSET, await createFrameProvider(videoUrl, "video"));
      if (cancelled) return;
      refCompositor = new SceneFrameCompositor(composition, refCanvas, (id) => refSources.get(id));
      const refBuffers: { data: Uint8ClampedArray; meanLuma: number }[] = [];
      for (const t of sampleTimes) {
        if (cancelled) return;
        await refCompositor.renderFrame(t);
        refBuffers.push(sampleLuma(refCanvas, sampleW, sampleH));
      }
      const refMean = refBuffers.reduce((s, b) => s + b.meanLuma, 0) / refBuffers.length;
      setRefLuma(Number(refMean.toFixed(2)));
      console.log(`[probe] main-thread scene reference meanLuma=${refMean.toFixed(2)} over ${sampleTimes.length} samples`);
      refCompositor.dispose();
      refCompositor = null;
      for (const s of refSources.values()) s.dispose();
      refSources.clear();
      const refBlack = refMean < 3;

      // (2) LEGACY scene export THROUGH THE WORKER, repeated, sampled across the timeline.
      let worstVerdict: Verdict = "not-reproduced";
      let worstDetail = `worker scene matched main-thread scene across ${sampleTimes.length} samples × ${runs} runs`;
      let lastWorkerMean = 0;
      let maxDiffSeen = 0;
      let blackCount = 0;
      let firstWorkerError = "";
      let lastDuration = 0;

      const escalate = (v: Verdict, d: string) => {
        const rank: Record<Verdict, number> = { "not-reproduced": 0, "cannot-run": 1, "reproduced-fallback": 2, "reproduced-black": 3, "reproduced-error": 3 };
        if (rank[v] > rank[worstVerdict]) { worstVerdict = v; worstDetail = d; }
      };

      for (let r = 0; r < runs && !cancelled; r += 1) {
        let blob: Blob | null = null;
        try {
          blob = await runWorkerSceneExport({ composition, urlMap, audio: null, format: "mp4", exportCompositor: "scene" });
          console.log(`[probe] worker scene export run ${r + 1}/${runs} completed (${blob.size} bytes)`);
        } catch (error) {
          const m = String(error instanceof Error ? error.message : error);
          if (!firstWorkerError) { firstWorkerError = m; setWorkerError(m); }
          console.log(`[probe] worker scene export run ${r + 1}/${runs} errored: ${m}`);
          if (/webgl|context|\bgl\b|scene compositor|lose|lost/i.test(m)) escalate("reproduced-error", `worker scene threw a GL/context error: ${m}`);
          else escalate("cannot-run", `worker errored for an unrelated reason: ${m}`);
          continue;
        }
        if (cancelled) return;
        const video = await loadVideo(blob);
        lastDuration = video.duration;
        let runMeanSum = 0;
        for (let s = 0; s < sampleTimes.length; s += 1) {
          await seekVideo(video, sampleTimes[s]!);
          const ws = sampleLuma(video, sampleW, sampleH);
          runMeanSum += ws.meanLuma;
          const dp = lumaDiffPct(refBuffers[s]!.data, ws.data, 24);
          maxDiffSeen = Math.max(maxDiffSeen, dp);
          if (ws.meanLuma < 3 && !refBlack) {
            blackCount += 1;
            escalate("reproduced-black", `worker frame black at t=${sampleTimes[s]!.toFixed(2)}s (run ${r + 1})`);
          } else if (ws.meanLuma < 0.6 * refBuffers[s]!.meanLuma || dp > 3) {
            escalate("reproduced-fallback", `worker diverged from scene at t=${sampleTimes[s]!.toFixed(2)}s (run ${r + 1}): workerLuma=${ws.meanLuma.toFixed(2)} refLuma=${refBuffers[s]!.meanLuma.toFixed(2)} diff=${dp.toFixed(2)}% — scene fell back to canvas2D (bloom/blur lost)`);
          }
        }
        lastWorkerMean = runMeanSum / sampleTimes.length;
        URL.revokeObjectURL(video.src);
        console.log(`[probe] run ${r + 1}: workerLuma=${lastWorkerMean.toFixed(2)} refLuma=${refMean.toFixed(2)} maxDiff=${maxDiffSeen.toFixed(2)}% blackEvents=${blackCount} duration=${lastDuration.toFixed(2)}s/${duration.toFixed(2)}s`);
      }
      if (cancelled) return;

      let v: Verdict = worstVerdict;
      let d = worstDetail;
      if (refBlack) { v = "cannot-run"; d = `main-thread scene reference was black (meanLuma=${refMean.toFixed(2)}) — no valid baseline`; }

      setWorkerLuma(Number(lastWorkerMean.toFixed(2)));
      setMaxDiff(Number(maxDiffSeen.toFixed(2)));
      setBlackEvents(blackCount);
      setDurActual(Number(lastDuration.toFixed(2)));
      console.log(`[probe] VERDICT=${v} — ${d}`);
      setVerdict(v);
      setDetail(d);
      setState("ready");
    }

    run().catch((error) => {
      if (cancelled) return;
      console.error("ExportWorkerSceneProbePage failed", error);
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
      className="export-worker-scene-probe-page"
      data-probe-state={state}
      data-verdict={verdict}
      data-ref-luma={refLuma}
      data-worker-luma={workerLuma}
      data-max-diff={maxDiff}
      data-black-events={blackEvents}
      data-duration-expected={durExpected}
      data-duration-actual={durActual}
      data-worker-error={workerError}
      style={{ margin: 0, padding: 16, background: "#000", color: "#fff", fontFamily: "monospace" }}
    >
      <pre>
        state={state} verdict={verdict || "…"} refLuma={refLuma} workerLuma={workerLuma} maxDiff={maxDiff}% blackEvents={blackEvents} dur={durActual}/{durExpected}s
      </pre>
      <pre data-probe-detail>{detail}</pre>
      {state === "error" ? <pre data-probe-error>{message}</pre> : null}
    </section>
  );
}
