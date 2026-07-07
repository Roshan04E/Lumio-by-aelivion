/**
 * P3 span-verification gate (PREVIEW_PIPELINE.md §3): NOTHING SERVES UNVERIFIED.
 *
 * Before a generated span proxy may be sealed, decode sample frames from the produced blob itself
 * and check the failure modes the 2026-07-03 soak actually shipped:
 *   1. UNDECODABLE — metadata/seek failures or a grossly short duration (a truncated/corrupt webm
 *      would stall the ProxyPlaybackLayer's <video> exactly like the frozen spans did).
 *   2. FROZEN CONTENT — every sample pixel-identical while the manifest expects motion (the
 *      decoder-warmup wedge baked frozen video into "ready" spans; this is the observed bug).
 *   3. BLACK CONTENT — belt for the worker-side black-frame guard; also covers the viewer-capture
 *      path, which skips the worker entirely.
 *
 * This gate runs ALWAYS (unlike the flag-gated viewer parity check): it needs no second render
 * path, only the blob — a <video> decode of 3 tiny samples, so it costs a few hundred ms per span
 * in the idle generation loop. Verification failure NEVER breaks playback: the span is marked
 * failed and the live compositor serves that range (correctness always has a fallback).
 *
 * Threshold notes (frozen heuristic): repeated identical frames through a lossy encoder decode to
 * near-identical pixels (normalized adjacent diff ~0.0002); real footage — even a locked-off
 * tripod shot — carries sensor noise (~0.003+). 0.0012 splits those populations with margin, and
 * the check only applies when the span is long enough for samples ≥1s apart.
 */

// Always-present soak telemetry: counts VERIFICATIONS RUN THIS SESSION (rehydrated spans from a
// previous session were verified when generated and don't re-run). 0/0 after a reload with a
// fully-cached timeline is normal, not a failure.
if (typeof window !== "undefined") {
  (window as unknown as { __rfSpanVerify?: { ok: number; failed: number; lastReason: string | null } }).__rfSpanVerify ??= {
    ok: 0,
    failed: 0,
    lastReason: null
  };
}

export interface SpanBlobVerification {
  ok: boolean;
  reason?: string;
  sampledTimes: number[];
  /** Largest normalized (0..1) mean-abs-diff between adjacent samples. */
  maxAdjacentDiff: number;
  /** Mean luma (0..1) across samples. */
  meanLuma: number;
}

const SAMPLE_EDGE_W = 96;
const SAMPLE_EDGE_H = 54;
const FROZEN_DIFF_EPS = 0.0012;
const BLACK_LUMA_EPS = 0.008;
/** Only call footage frozen when samples are at least this far apart (avoids near-frame aliasing). */
const FROZEN_MIN_SPAN_S = 2;
const METADATA_TIMEOUT_MS = 4000;
const SEEK_TIMEOUT_MS = 2500;

class VerificationAborted extends Error {
  constructor() {
    super("span verification aborted");
    this.name = "VerificationAborted";
  }
}

function once<K extends keyof HTMLVideoElementEventMap>(
  video: HTMLVideoElement,
  event: K,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      video.removeEventListener(event, onEvent);
      video.removeEventListener("error", onError);
      signal?.removeEventListener("abort", onAbort);
      window.clearTimeout(timer);
    };
    const onEvent = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error(`video error while waiting for ${event}`));
    };
    const onAbort = () => {
      cleanup();
      reject(new VerificationAborted());
    };
    const timer = window.setTimeout(() => {
      cleanup();
      reject(new Error(`timeout waiting for ${event}`));
    }, timeoutMs);
    video.addEventListener(event, onEvent, { once: true });
    video.addEventListener("error", onError, { once: true });
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function verifySpanBlobIntegrity(input: {
  blob: Blob;
  spanDurationSeconds: number;
  /** True when any VIDEO layer overlaps the span (frozen heuristic only applies then). */
  motionExpected: boolean;
  /** True when any visual media layer overlaps the span (black heuristic only applies then). */
  mediaExpected: boolean;
  signal?: AbortSignal | undefined;
}): Promise<SpanBlobVerification> {
  const { blob, spanDurationSeconds, motionExpected, mediaExpected, signal } = input;
  const url = URL.createObjectURL(blob);
  const video = document.createElement("video");
  video.muted = true;
  video.preload = "auto";
  video.src = url;
  const fail = (reason: string, sampledTimes: number[], maxAdjacentDiff = 0, meanLuma = 0): SpanBlobVerification => ({
    ok: false,
    reason,
    sampledTimes,
    maxAdjacentDiff,
    meanLuma
  });
  try {
    try {
      await once(video, "loadedmetadata", METADATA_TIMEOUT_MS, signal);
    } catch (error) {
      if (error instanceof VerificationAborted) throw error;
      return fail(`undecodable: ${error instanceof Error ? error.message : String(error)}`, []);
    }
    // webm duration metadata can be imprecise — only flag GROSS truncation.
    const reported = Number.isFinite(video.duration) ? video.duration : 0;
    if (spanDurationSeconds > 1 && reported > 0 && reported < spanDurationSeconds * 0.5) {
      return fail(`truncated: reports ${reported.toFixed(2)}s of ${spanDurationSeconds.toFixed(2)}s`, []);
    }
    const usable = Math.max(0.1, Math.min(reported || spanDurationSeconds, spanDurationSeconds));
    const sampleTimes = [usable * 0.1, usable * 0.5, usable * 0.9];
    const canvas = document.createElement("canvas");
    canvas.width = SAMPLE_EDGE_W;
    canvas.height = SAMPLE_EDGE_H;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return fail("no 2d context for sampling", []);
    const samples: Uint8ClampedArray[] = [];
    for (const time of sampleTimes) {
      try {
        video.currentTime = time;
        await once(video, "seeked", SEEK_TIMEOUT_MS, signal);
      } catch (error) {
        if (error instanceof VerificationAborted) throw error;
        return fail(`unseekable @ ${time.toFixed(2)}s: ${error instanceof Error ? error.message : String(error)}`, sampleTimes);
      }
      ctx.drawImage(video, 0, 0, SAMPLE_EDGE_W, SAMPLE_EDGE_H);
      samples.push(ctx.getImageData(0, 0, SAMPLE_EDGE_W, SAMPLE_EDGE_H).data);
    }
    let lumaSum = 0;
    let maxAdjacentDiff = 0;
    for (let s = 0; s < samples.length; s += 1) {
      const data = samples[s]!;
      let sampleLuma = 0;
      for (let i = 0; i < data.length; i += 4) {
        sampleLuma += 0.2126 * data[i]! + 0.7152 * data[i + 1]! + 0.0722 * data[i + 2]!;
      }
      lumaSum += sampleLuma / (255 * (data.length / 4));
      if (s > 0) {
        const prev = samples[s - 1]!;
        let diff = 0;
        for (let i = 0; i < data.length; i += 4) {
          diff += Math.abs(data[i]! - prev[i]!) + Math.abs(data[i + 1]! - prev[i + 1]!) + Math.abs(data[i + 2]! - prev[i + 2]!);
        }
        maxAdjacentDiff = Math.max(maxAdjacentDiff, diff / (255 * 3 * (data.length / 4)));
      }
    }
    const meanLuma = lumaSum / samples.length;
    if (mediaExpected && meanLuma < BLACK_LUMA_EPS) {
      return fail(`black content (mean luma ${(meanLuma * 100).toFixed(2)}%)`, sampleTimes, maxAdjacentDiff, meanLuma);
    }
    if (motionExpected && spanDurationSeconds >= FROZEN_MIN_SPAN_S && maxAdjacentDiff < FROZEN_DIFF_EPS) {
      return fail(`frozen content (max adjacent diff ${(maxAdjacentDiff * 100).toFixed(4)}%)`, sampleTimes, maxAdjacentDiff, meanLuma);
    }
    return { ok: true, sampledTimes: sampleTimes, maxAdjacentDiff, meanLuma };
  } finally {
    video.removeAttribute("src");
    try {
      video.load();
    } catch {
      /* detached teardown */
    }
    URL.revokeObjectURL(url);
  }
}

export { VerificationAborted as SpanVerificationAborted };
