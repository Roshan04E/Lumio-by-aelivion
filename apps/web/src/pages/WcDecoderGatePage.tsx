import { useEffect, useRef, useState } from "react";
import { createFile, type MP4Sample, type MP4VideoTrackInfo } from "mp4box";
import { MediaWebGLRenderer } from "@orreris/shared";
import { createImageSource } from "../export/source-decoder";
import { createWebCodecsVideoSource, wcDecoderStats } from "../export/webcodecs-decoder";
import { acquirePreviewFrameProvider, getWcPoolStats, getWcPreviewDecodeEnabled } from "../playback/preview-frame-pool";

/**
 * Streaming-demux decoder gate (`/editor/__wc-decoder-gate`) — driven headlessly by
 * `apps/worker/src/wc-decoder-gate.ts`.
 *
 * Synthesizes REAL H.264 MP4s fully in-browser (VideoEncoder → mp4-muxer) in both layouts —
 * faststart (moov first) and moov-at-end (the layout that forces the index parser to jump
 * over mdat) — then runs the real `createWebCodecsVideoSource` provider over them and asserts:
 *   1. the STREAMING index path was taken (not the fragmented full-extraction fallback),
 *   2. frame-accurate decode: each requested time returns the frame whose encoded color ramp
 *      matches (proves demux offsets/timestamps line up with what was encoded),
 *   3. forward decode across MULTIPLE chunk windows (frame count > WINDOW_MAX_SAMPLES),
 *   4. a backward jump re-materializes an evicted window correctly (keyframe rewind + reload).
 *
 * Each frame is a solid color: r = ramp(i), b = 255 - r — sampled at the canvas center with a
 * tolerance wide enough for 4:2:0 + 1Mbps encode noise but far narrower than the inter-frame step.
 */

const WIDTH = 320;
const HEIGHT = 240;
const FPS = 30;
const FRAMES = 240; // > WINDOW_MAX_SAMPLES (96) so playback crosses window reloads
const GOP = 30;
const TOLERANCE = 26;

function rampColor(frameIndex: number): { r: number; b: number } {
  const r = Math.round((frameIndex / (FRAMES - 1)) * 255);
  return { r, b: 255 - r };
}

async function synthMp4(fastStart: "in-memory" | false): Promise<string> {
  const { ArrayBufferTarget, Muxer } = await import("mp4-muxer");
  const target = new ArrayBufferTarget();
  const muxer = new Muxer({
    target,
    video: { codec: "avc", width: WIDTH, height: HEIGHT },
    fastStart,
    firstTimestampBehavior: "offset"
  });
  let encodeError: unknown = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => {
      encodeError = e;
    }
  });
  encoder.configure({ codec: "avc1.42001f", width: WIDTH, height: HEIGHT, bitrate: 1_500_000 });
  const canvas = document.createElement("canvas");
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  const ctx = canvas.getContext("2d")!;
  for (let i = 0; i < FRAMES; i += 1) {
    const { r, b } = rampColor(i);
    ctx.fillStyle = `rgb(${r}, 128, ${b})`;
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
    const frame = new VideoFrame(canvas, {
      timestamp: Math.round((i * 1_000_000) / FPS),
      duration: Math.round(1_000_000 / FPS)
    });
    encoder.encode(frame, { keyFrame: i % GOP === 0 });
    frame.close();
    if (i % 30 === 29) await new Promise((resolve) => setTimeout(resolve, 0));
  }
  await encoder.flush();
  encoder.close();
  if (encodeError) throw encodeError;
  muxer.finalize();
  return URL.createObjectURL(new Blob([target.buffer], { type: "video/mp4" }));
}

interface FrameCheck {
  timeSeconds: number;
  expectedIndex: number;
  measuredR: number;
  measuredB: number;
  ok: boolean;
}

interface VariantResult {
  name: string;
  providerCreated: boolean;
  streamingPathUsed: boolean;
  checks: FrameCheck[];
  ok: boolean;
  error?: string;
}

async function runVariant(name: string, fastStart: "in-memory" | false): Promise<VariantResult> {
  const result: VariantResult = { name, providerCreated: false, streamingPathUsed: false, checks: [], ok: false };
  let url: string | null = null;
  try {
    url = await synthMp4(fastStart);
    const before = { ...wcDecoderStats };
    // Export semantics (no frame budget): getFrame must block until the exact frame is decoded,
    // which is what makes the color assertions deterministic.
    const provider = await createWebCodecsVideoSource(url, {});
    result.providerCreated = provider !== null;
    result.streamingPathUsed = wcDecoderStats.streaming > before.streaming && wcDecoderStats.fragmented === before.fragmented;
    if (!provider) return result;

    const canvas = document.createElement("canvas");
    canvas.width = WIDTH;
    canvas.height = HEIGHT;
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    // Forward across several windows, then a backward jump onto an evicted window, then forward again.
    const targets = [0, 1.0, 4.5, 7.9, 0.5, 4.0];
    for (const timeSeconds of targets) {
      const expectedIndex = Math.min(FRAMES - 1, Math.floor(timeSeconds * FPS + 1e-6));
      const frame = await provider.getFrame(timeSeconds);
      let measuredR = -1;
      let measuredB = -1;
      if (frame) {
        ctx.drawImage(frame as CanvasImageSource, 0, 0, WIDTH, HEIGHT);
        const px = ctx.getImageData(WIDTH >> 1, HEIGHT >> 1, 1, 1).data;
        measuredR = px[0]!;
        measuredB = px[2]!;
      }
      const expected = rampColor(expectedIndex);
      const ok =
        frame !== null &&
        Math.abs(measuredR - expected.r) <= TOLERANCE &&
        Math.abs(measuredB - expected.b) <= TOLERANCE;
      result.checks.push({ timeSeconds, expectedIndex, measuredR, measuredB, ok });
    }
    provider.dispose();
    result.ok = result.providerCreated && result.streamingPathUsed && result.checks.every((c) => c.ok);
    return result;
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    return result;
  } finally {
    if (url) URL.revokeObjectURL(url);
  }
}

interface PoolCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

function measureCenter(frame: CanvasImageSource): { r: number; b: number } {
  const canvas = document.createElement("canvas");
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(frame, 0, 0, WIDTH, HEIGHT);
  const px = ctx.getImageData(WIDTH >> 1, HEIGHT >> 1, 1, 1).data;
  return { r: px[0]!, b: px[2]! };
}

/**
 * Reverse-shuttle scenario (flip blocker 3): 25 strictly descending frame requests (J-shuttle
 * pattern). Naively each one re-decodes from the GOP keyframe (~450 decode calls here); with the
 * reverse cache the single collect pass covers the rest, so total decode work must stay bounded —
 * while every served frame stays frame-accurate.
 */
async function runReverseShuttleCheck(): Promise<PoolCheck[]> {
  const checks: PoolCheck[] = [];
  const url = await synthMp4("in-memory");
  try {
    const provider = await createWebCodecsVideoSource(url, {});
    if (!provider) {
      checks.push({ name: "shuttle provider created", ok: false });
      return checks;
    }
    const stats = provider as unknown as { __wcDecodeCalls?: number };
    await provider.getFrame((90 + 0.5) / FPS); // park at frame 90 (a keyframe boundary GOP)
    const before = stats.__wcDecodeCalls ?? 0;
    let colorsOk = true;
    let firstBad = "";
    for (let i = 1; i <= 25; i += 1) {
      const idx = 90 - i;
      const frame = await provider.getFrame((idx + 0.5) / FPS);
      const measured = frame ? measureCenter(frame as CanvasImageSource) : null;
      const want = rampColor(idx);
      const ok = measured !== null && Math.abs(measured.r - want.r) <= TOLERANCE && Math.abs(measured.b - want.b) <= TOLERANCE;
      if (!ok && !firstBad) firstBad = `frame ${idx}: got ${measured ? `r=${measured.r} b=${measured.b}` : "null"} want r=${want.r} b=${want.b}`;
      colorsOk &&= ok;
    }
    const delta = (stats.__wcDecodeCalls ?? 0) - before;
    checks.push({ name: "reverse shuttle frame-accurate", ok: colorsOk, ...(firstBad ? { detail: firstBad } : {}) });
    checks.push({
      name: "reverse shuttle decode work bounded (cache engaged)",
      ok: delta <= 120,
      detail: `decodes=${delta} (naive≈450, one collect pass≈70)`
    });
    provider.dispose();
  } catch (error) {
    checks.push({ name: "reverse shuttle threw", ok: false, detail: error instanceof Error ? error.message : String(error) });
  } finally {
    URL.revokeObjectURL(url);
  }
  return checks;
}

/**
 * Session-prioritization scenario (flip blocker 2), run only when `?wcDecode=1`:
 * preload leases may not take the last slot; a playhead acquire preempts the oldest preload
 * when full; `setPriority` promotion protects a shell that just went live.
 */
async function runPoolPriorityChecks(): Promise<PoolCheck[]> {
  const checks: PoolCheck[] = [];
  const push = (name: string, ok: boolean, detail?: string) => checks.push(detail ? { name, ok, detail } : { name, ok });
  // Same encoded bytes behind four distinct URLs (the pool keys by URL).
  const sourceUrl = await synthMp4("in-memory");
  const blob = await (await fetch(sourceUrl)).blob();
  const urls = [sourceUrl, ...Array.from({ length: 3 }, () => URL.createObjectURL(blob))];
  let preemptedA = false;
  let preemptedB = false;
  try {
    const preloadA = acquirePreviewFrameProvider(urls[0]!, { priority: "preload", onPreempted: () => (preemptedA = true) });
    const preloadB = acquirePreviewFrameProvider(urls[1]!, { priority: "preload", onPreempted: () => (preemptedB = true) });
    push("preload A+B acquire spare slots", preloadA !== null && preloadB !== null);
    const preloadC = acquirePreviewFrameProvider(urls[2]!, { priority: "preload" });
    push("preload C denied at reserved slot", preloadC === null);
    await Promise.all([preloadA?.ready, preloadB?.ready]);

    const playhead1 = acquirePreviewFrameProvider(urls[2]!, { priority: "playhead" });
    push("playhead takes the last slot", playhead1 !== null);
    await playhead1?.ready;

    const playhead2 = acquirePreviewFrameProvider(urls[3]!, { priority: "playhead" });
    push("playhead preempts when full", playhead2 !== null && preemptedA && !preemptedB, `preemptedA=${preemptedA} preemptedB=${preemptedB}`);
    const provider2 = await (playhead2?.ready ?? Promise.resolve(null));
    push("preempting lease decodes", provider2 !== null && (await provider2!.getFrame(0)) !== null);

    // Shell B just went live — promote it. Pool is full of playhead leases → next acquire is denied.
    preloadB?.setPriority("playhead");
    const playhead3 = acquirePreviewFrameProvider(`${urls[3]!}#other`, { priority: "playhead" });
    push("promoted shell is not a victim", playhead3 === null && !preemptedB);

    playhead1?.release();
    playhead2?.release();
    preloadB?.release();
    preloadA?.release(); // already preempted — must be a safe no-op
    const stats = getWcPoolStats();
    push(
      "accounting settles (active=0, preemptions=1)",
      stats.active === 0 && stats.preemptions === 1 && stats.idle <= 2,
      JSON.stringify(stats)
    );
  } finally {
    for (const url of urls) URL.revokeObjectURL(url);
  }
  return checks;
}

/**
 * Image-orientation parity (2026-07-03 "photo exported upside down"): the SAME asymmetric image
 * drawn through the SAME MediaWebGLRenderer from BOTH source types — the preview's
 * HTMLImageElement (UNPACK_FLIP_Y applies) and the export's createImageSource ImageBitmap
 * (UNPACK_FLIP_Y is IGNORED per spec; must be pre-flipped via imageOrientation) — must land the
 * red half on the same side of the graded canvas.
 */
async function runImageOrientationCheck(): Promise<PoolCheck[]> {
  const checks: PoolCheck[] = [];
  let url = "";
  try {
    // Top half red, bottom half blue.
    const source = document.createElement("canvas");
    source.width = 64;
    source.height = 64;
    const sctx = source.getContext("2d")!;
    sctx.fillStyle = "rgb(255,0,0)";
    sctx.fillRect(0, 0, 64, 32);
    sctx.fillStyle = "rgb(0,0,255)";
    sctx.fillRect(0, 32, 64, 32);
    const blob: Blob = await new Promise((resolve, reject) =>
      source.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob failed"))), "image/png")
    );
    url = URL.createObjectURL(blob);

    const drawAndSampleTop = async (draw: { source: TexImageSource; width: number; height: number }) => {
      const canvas = document.createElement("canvas");
      const renderer = new MediaWebGLRenderer(canvas, { kind: "media-renderer", label: "wc-gate-orientation" });
      try {
        renderer.draw({ source: draw.source, sourceWidth: draw.width, sourceHeight: draw.height, pipeline: null, amount: 1, opacity: 1, mediaEffects: null, transition: null });
        const out = document.createElement("canvas");
        out.width = draw.width;
        out.height = draw.height;
        const octx = out.getContext("2d", { willReadFrequently: true })!;
        octx.drawImage(canvas, 0, 0);
        const px = octx.getImageData(draw.width >> 1, 4, 1, 1).data;
        return { r: px[0]!, b: px[2]! };
      } finally {
        renderer.dispose();
      }
    };

    const img = new Image();
    img.src = url;
    await img.decode();
    const elementTop = await drawAndSampleTop({ source: img, width: img.naturalWidth, height: img.naturalHeight });

    const provider = await createImageSource(url);
    const bitmap = (await provider.getFrame(0)) as TexImageSource | null;
    if (!bitmap) {
      checks.push({ name: "image orientation: export bitmap decodes", ok: false });
      return checks;
    }
    const bitmapTop = await drawAndSampleTop({ source: bitmap, width: provider.width, height: provider.height });
    provider.dispose();

    checks.push({
      name: "image orientation: element path shows red on top",
      ok: elementTop.r > 180 && elementTop.b < 80,
      detail: `element top r=${elementTop.r} b=${elementTop.b}`
    });
    checks.push({
      name: "image orientation: export bitmap matches element (no upside-down export)",
      ok: Math.abs(bitmapTop.r - elementTop.r) < 40 && Math.abs(bitmapTop.b - elementTop.b) < 40,
      detail: `bitmap top r=${bitmapTop.r} b=${bitmapTop.b}`
    });
  } catch (error) {
    checks.push({ name: "image orientation check threw", ok: false, detail: error instanceof Error ? error.message : String(error) });
  } finally {
    if (url) URL.revokeObjectURL(url);
  }
  return checks;
}

/**
 * Diagnostic: for one file, demux via BOTH paths — mp4box extraction (ground truth bytes) and the
 * sample TABLE (getTrackSamplesInfo offsets/sizes + raw slices, what the streaming decoder feeds) —
 * and byte-compare every sample. A mismatch means the streaming path feeds corrupt bitstream.
 */
async function diffTableVsExtraction(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  const raw = new Uint8Array(buffer);

  const extracted: MP4Sample[] = [];
  let table: MP4Sample[] = [];
  let track: MP4VideoTrackInfo | null = null;
  const file = createFile();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("diff demux timeout")), 8000);
    file.onError = (e) => {
      clearTimeout(timer);
      reject(new Error(String(e)));
    };
    file.onReady = (info) => {
      track = info.videoTracks?.[0] ?? null;
      if (!track) {
        clearTimeout(timer);
        reject(new Error("no video track"));
        return;
      }
      table = (file.getTrackSamplesInfo?.(track.id) ?? []).map((s) => ({ ...s }));
      file.setExtractionOptions(track.id, null, { nbSamples: track.nb_samples || 1_000_000 });
      file.start();
    };
    file.onSamples = (_id, _user, list) => {
      for (const s of list) extracted.push(s);
      if (track && extracted.length >= (track.nb_samples || Infinity)) {
        clearTimeout(timer);
        resolve();
      }
    };
    const part = buffer.slice(0) as ArrayBuffer & { fileStart: number };
    part.fileStart = 0;
    file.appendBuffer(part);
    file.flush();
  });

  if (!table.length) return `table empty (extracted=${extracted.length})`;
  if (table.length !== extracted.length) return `count mismatch: table=${table.length} extracted=${extracted.length}`;
  // The wedge is deterministic at output ~14 — dump the raw timing table around there so the
  // failure mechanism (cts order, duplicates, negative composition offsets) is visible in the log.
  console.log(
    "[gate] sample timing:",
    table
      .slice(0, 24)
      .map((s, i) => `#${i} dts=${s.dts} cts=${s.cts} ${s.is_sync ? "K" : "d"} ${s.size}B`)
      .join(" | "),
    `timescale=${(track as MP4VideoTrackInfo | null)?.timescale}`
  );
  for (let i = 0; i < extracted.length; i += 1) {
    const t = table[i]!;
    const e = extracted[i]!;
    if (t.size !== e.data!.byteLength) return `sample ${i}: table size=${t.size} vs extracted=${e.data!.byteLength}`;
    if (t.cts !== e.cts) return `sample ${i}: table cts=${t.cts} vs extracted=${e.cts}`;
    if (Boolean(t.is_sync) !== Boolean(e.is_sync)) return `sample ${i}: table sync=${t.is_sync} vs extracted=${e.is_sync}`;
    const off = t.offset ?? -1;
    for (let b = 0; b < t.size!; b += 1) {
      if (raw[off + b] !== e.data![b]) {
        return `sample ${i}: BYTE mismatch at +${b} (offset=${off}, size=${t.size}): slice=${raw[off + b]} extracted=${e.data![b]}`;
      }
    }
  }
  return "identical";
}

/**
 * MediaEncoder-minted source — the EXACT file class the worker-scene gate feeds the decoder
 * (export's own MediaEncoder: hardware H.264 via avcCodec(), keyframe every 2s → a short clip has
 * ONE keyframe, portrait, delivered as a data URL). This reproduced the 2026-07-03 worker-scene
 * probe failure that my synthesized/ffmpeg fixtures missed.
 */
async function runMediaEncoderScan(): Promise<PoolCheck[]> {
  const checks: PoolCheck[] = [];
  try {
    const { MediaEncoder } = await import("../export/video-encoder");
    const width = 360;
    const height = 640;
    const fps = 30;
    const frames = 45; // 1.5s at kf-interval 2s → single keyframe, like the worker-scene fixture clips
    const enc = new MediaEncoder({ width, height, fps, format: "mp4" });
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d")!;
    for (let i = 0; i < frames; i += 1) {
      const { r, b } = rampColor(Math.round((i / (frames - 1)) * (FRAMES - 1)));
      ctx.fillStyle = `rgb(${r}, 128, ${b})`;
      ctx.fillRect(0, 0, width, height);
      await enc.addVideoFrame(canvas, i);
    }
    const blob = await enc.finalize();
    const url = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(new Error("blob→dataURL failed"));
      reader.readAsDataURL(blob);
    });
    const diff = await diffTableVsExtraction(blob).catch((e) => `diff threw: ${e instanceof Error ? e.message : String(e)}`);
    checks.push({ name: "mediaenc table bytes == extraction bytes", ok: diff === "identical", detail: diff });
    // Software-decode control: same file, prefer-software. Splits "bitstream/feeding bug" (sw fails
    // too) from "hardware decoder input-queue wedge" (sw passes).
    const swProvider = await createWebCodecsVideoSource(url, { preferSoftware: true });
    checks.push({ name: "mediaenc[sw] provider created", ok: swProvider !== null });
    if (swProvider) {
      const f = await swProvider.getFrame(1.0);
      checks.push({ name: "mediaenc[sw] decodes mid-clip", ok: f !== null });
      swProvider.dispose();
    }
    const provider = await createWebCodecsVideoSource(url, {});
    checks.push({ name: "mediaenc provider created (probe survives)", ok: provider !== null });
    if (!provider) return checks;
    const targets = [0, 0.5, 1.4, 0.2, 1.0];
    let allOk = true;
    let detail = "";
    for (const t of targets) {
      const idx = Math.min(frames - 1, Math.floor(t * fps + 1e-6));
      const frame = await provider.getFrame(t);
      const measured = frame ? measureCenter(frame as CanvasImageSource) : null;
      const want = rampColor(Math.round((idx / (frames - 1)) * (FRAMES - 1)));
      const ok = measured !== null && Math.abs(measured.r - want.r) <= TOLERANCE && Math.abs(measured.b - want.b) <= TOLERANCE;
      if (!ok && !detail) detail = `t=${t}: got ${measured ? `r=${measured.r} b=${measured.b}` : "null"} want r=${want.r} b=${want.b}`;
      allOk &&= ok;
    }
    checks.push({ name: "mediaenc frame-accurate incl. backward jump", ok: allOk, ...(detail ? { detail } : {}) });
    provider.dispose();
  } catch (error) {
    checks.push({ name: "mediaenc scan threw", ok: false, detail: error instanceof Error ? error.message : String(error) });
  }
  return checks;
}

/**
 * Realistic-source scan (export read pattern) — runs when the harness has generated
 * `/__wc-fixtures/real.mp4` (H.264 high profile, B-frames, sparse GOP, AAC audio interleaved,
 * moov-at-end; ffmpeg testsrc2 so every frame differs visually). Reads 0→12s monotonically at
 * 30fps exactly like the export does, both hardware and prefer-software, then a clip-boundary
 * backward jump. Asserts NO null frames and NO frozen runs (a stale `current` returned
 * repeatedly = the "clip looks paused in the export" failure).
 */
async function runRealFixtureScan(): Promise<PoolCheck[]> {
  const url = "/__wc-fixtures/real.mp4";
  const head = await fetch(url, { method: "HEAD" }).catch(() => null);
  if (!head?.ok) return []; // fixture not generated (page opened standalone) — skip
  const checks: PoolCheck[] = [];
  const canvas = document.createElement("canvas");
  canvas.width = 640;
  canvas.height = 360;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  const signature = (frame: CanvasImageSource) => {
    ctx.drawImage(frame, 0, 0, 640, 360);
    const parts: number[] = [];
    for (let i = 0; i < 8; i += 1) {
      const px = ctx.getImageData(40 + i * 80, 30 + i * 40, 1, 1).data;
      parts.push(px[0]!, px[1]!, px[2]!);
    }
    return parts.join(",");
  };
  for (const preferSoftware of [false, true]) {
    const label = preferSoftware ? "sw" : "hw";
    try {
      const provider = await createWebCodecsVideoSource(url, preferSoftware ? { preferSoftware: true } : {});
      if (!provider) {
        checks.push({ name: `real[${label}] provider created`, ok: false, detail: "fell back (demux/config failed)" });
        continue;
      }
      let nullCount = 0;
      let maxRun = 0;
      let run = 0;
      let prevSig = "";
      const frames = 12 * 30 - 6;
      for (let i = 0; i < frames; i += 1) {
        const frame = await provider.getFrame(i / 30);
        if (!frame) {
          nullCount += 1;
          continue;
        }
        const sig = signature(frame as CanvasImageSource);
        if (sig === prevSig) {
          run += 1;
          maxRun = Math.max(maxRun, run);
        } else {
          run = 0;
        }
        prevSig = sig;
      }
      checks.push({ name: `real[${label}] no null frames in export scan`, ok: nullCount === 0, detail: `nulls=${nullCount}/${frames}` });
      checks.push({ name: `real[${label}] no frozen runs in export scan`, ok: maxRun <= 6, detail: `longest identical run=${maxRun + 1} frames` });

      // Clip boundary: a second clip earlier in the same source (one-off backward jump), then forward.
      let boundaryFrozen = 0;
      prevSig = "";
      for (let i = 0; i < 30; i += 1) {
        const frame = await provider.getFrame(2 + i / 30);
        const sig = frame ? signature(frame as CanvasImageSource) : "null";
        if (sig === prevSig) boundaryFrozen += 1;
        prevSig = sig;
      }
      checks.push({ name: `real[${label}] clip-boundary jump stays live`, ok: boundaryFrozen <= 4, detail: `frozen=${boundaryFrozen}/30` });
      provider.dispose();
    } catch (error) {
      checks.push({ name: `real[${label}] scan threw`, ok: false, detail: error instanceof Error ? error.message : String(error) });
    }
  }
  return checks;
}

export function WcDecoderGatePage() {
  const startedRef = useRef(false);
  const [status, setStatus] = useState<"running" | "ready" | "error">("running");
  const [results, setResults] = useState<VariantResult[]>([]);
  const [poolChecks, setPoolChecks] = useState<PoolCheck[]>([]);
  const [fatal, setFatal] = useState<string | null>(null);

  useEffect(() => {
    if (startedRef.current) return; // StrictMode double-mount guard
    startedRef.current = true;
    (async () => {
      try {
        const variants: VariantResult[] = [];
        variants.push(await runVariant("faststart", "in-memory"));
        variants.push(await runVariant("moov-at-end", false));
        setResults(variants);
        const orientation = await runImageOrientationCheck();
        const mediaenc = await runMediaEncoderScan();
        const real = await runRealFixtureScan();
        const shuttle = await runReverseShuttleCheck();
        const pool = getWcPreviewDecodeEnabled() ? await runPoolPriorityChecks() : [];
        const combined = [...orientation, ...mediaenc, ...real, ...shuttle, ...pool];
        setPoolChecks(combined);
        setStatus(variants.every((v) => v.ok) && combined.every((c) => c.ok) ? "ready" : "error");
      } catch (error) {
        setFatal(error instanceof Error ? error.message : String(error));
        setStatus("error");
      }
    })();
  }, []);

  const allOk = status === "ready";
  return (
    <div
      className="wc-decoder-gate-page"
      data-render-fixture={status === "running" ? "running" : allOk ? "ready" : "error"}
      data-ok={allOk ? "1" : "0"}
      style={{ color: "#ddd", fontFamily: "monospace", padding: 16 }}
    >
      <h1>WebCodecs streaming-demux gate</h1>
      <p>status: {status}</p>
      {fatal ? <pre data-gate-error>{fatal}</pre> : null}
      <pre data-gate-results>{JSON.stringify(results, null, 2)}</pre>
      <pre data-gate-pool>{JSON.stringify(poolChecks, null, 2)}</pre>
    </div>
  );
}
