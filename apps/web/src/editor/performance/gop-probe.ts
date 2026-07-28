/**
 * GOP-DENSITY PROBE (2026-07-28) — measures what a source actually costs to SEEK, so the ingest-proxy
 * engine can stop guessing that cost from file size.
 *
 * The bug this exists to fix: `sourceProxyEngine` skipped any source under `MIN_SOURCE_BYTES` with the
 * note "source small enough", on the stated assumption that a small file "is already cheap to decode".
 * That assumption is an inference from size, and for one whole class of footage it inverts. Smoke, fog,
 * light leaks, gradient overlays — low-frequency, slow-moving content — compress enormously, and the
 * encoder buys that compression with LONG GOPs and heavy inter-frame prediction. The file is small
 * BECAUSE it is expensive to seek, not despite it.
 *
 * That inversion was load-bearing, because a skipped proxy is not a soft degradation. With no
 * `proxyUrl`, `VideoPreview` sets `preferNativeDecode`, `WebglMediaLayer` refuses a pooled WebCodecs
 * lease, and the source falls to the `<video>` element path — which for a Flarex loader is the freeze
 * that `WebglMediaLayer.tsx` warns about. A 45s 1080p smoke clip under 12MB therefore skipped, landed
 * on the element path, and freeze-played while every sibling with a proxy ran clean.
 *
 * What is measured: the distance in FRAMES between sync samples, read from the MP4 sample table
 * (metadata only — no sample data is decoded or retained). Frames, not seconds, because catch-up cost
 * is frames — the same reasoning that made the proxy recipe's own keyframe interval a frame count
 * (`PROXY_KEYFRAME_EVERY_N_FRAMES`) rather than a duration, after 1-second GOPs froze 60fps proxies.
 *
 * What is deliberately NOT concluded: `null` means "cannot tell" — an unparseable container (WebM),
 * an oversized file, or a track with no `stss` box. Per ISO 14496-12 an ABSENT sync-sample table means
 * every sample IS a sync sample, so all-false flags are the opposite of sparse and must never be read
 * as "build a proxy". Callers keep their existing behaviour on `null`; this probe only ever ADDS a
 * reason to build, never removes one.
 */

import { createFile, type MP4Sample } from "mp4box";

/** Above this the size gate already builds a proxy, so the probe would be pure cost. */
const MAX_PROBE_BYTES = 64 * 1024 * 1024;
const READY_TIMEOUT_MS = 8_000;

/**
 * Worst-case catch-up, in frames, that the preview's decoder pool can grind without stalling.
 *
 * Anchored to the proxy recipe's own numbers rather than picked: the recipe writes a keyframe every
 * `PROXY_KEYFRAME_EVERY_N_FRAMES` = 12 (its target), and its v7 note records that the previous
 * 1-second GOP — 60 frames at 60fps — "the decoder couldn't grind in realtime → high-fps proxies
 * froze" (its known-bad). 24 sits at 2× the target and well under the measured failure point, so a
 * source only earns a transcode when it is meaningfully worse than what we would produce for it.
 */
export const MAX_TOLERABLE_GOP_FRAMES = 24;

export interface GopProfile {
  /** Video samples in the track. */
  sampleCount: number;
  /** Samples flagged `is_sync`. */
  keyframeCount: number;
  /** Largest keyframe-to-keyframe distance, in frames. */
  maxGapFrames: number;
  /**
   * 95th-percentile gap. The DECISION metric: `max` alone is hostage to one outlier (a tail run, a
   * single scene-cut GOP), and a source whose typical seek is cheap does not need a transcode because
   * of one bad stretch.
   */
  p95GapFrames: number;
}

/**
 * Pure gap math over decode-order sync flags — the whole decision, extracted so it can be tested
 * without an MP4.
 *
 * Returns null when the flags cannot support a conclusion: an empty track, or zero sync samples
 * (no `stss` → spec says all samples are sync → dense, not sparse).
 */
export function summarizeGopGaps(isSync: readonly boolean[]): GopProfile | null {
  if (isSync.length === 0) return null;
  const syncIndices: number[] = [];
  for (let i = 0; i < isSync.length; i += 1) {
    if (isSync[i]) syncIndices.push(i);
  }
  if (syncIndices.length === 0) return null;

  const gaps: number[] = [];
  for (let i = 1; i < syncIndices.length; i += 1) {
    gaps.push(syncIndices[i]! - syncIndices[i - 1]!);
  }
  // The tail run is a real seek cost: landing on the last frame decodes from the last keyframe
  // forward, even though no keyframe closes the run.
  const tail = isSync.length - syncIndices[syncIndices.length - 1]!;
  if (tail > 0) gaps.push(tail);
  // Samples BEFORE the first keyframe are not decodable at all, so they are not a gap.

  const sorted = [...gaps].sort((a, b) => a - b);
  const p95 = sorted.length === 0 ? 1 : sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)]!;
  return {
    sampleCount: isSync.length,
    keyframeCount: syncIndices.length,
    maxGapFrames: sorted.length === 0 ? 1 : sorted[sorted.length - 1]!,
    p95GapFrames: p95
  };
}

/**
 * Does this source cost enough to seek that it earns a proxy despite being small?
 *
 * Conservative by construction: an unknown profile answers "no", preserving today's behaviour rather
 * than flooding the build queue on every file the probe cannot read (tracker v29's "+22 queued" storm
 * is the regression this guards against).
 */
export function needsProxyForDecodeCost(profile: GopProfile | null): boolean {
  return profile !== null && profile.p95GapFrames > MAX_TOLERABLE_GOP_FRAMES;
}

/** Human-readable tail for the skip/build note — this is what makes the decision diagnosable. */
export function describeGopProfile(profile: GopProfile | null): string {
  if (!profile) return "gop unknown";
  return `gop p95 ${profile.p95GapFrames}f / max ${profile.maxGapFrames}f over ${profile.sampleCount}f`;
}

/**
 * Read the first video track's sync flags out of an MP4/MOV. Metadata only: the sample TABLE carries
 * `is_sync` without any sample payload, so nothing is decoded.
 *
 * The whole blob is appended in one go (rather than the streaming slice walk the decoder uses) because
 * this only runs on files the size gate already considers small, and one append handles a tail `moov`
 * and a fragmented layout without needing to detect either.
 */
export async function probeGopProfile(blob: Blob): Promise<GopProfile | null> {
  if (blob.size === 0 || blob.size > MAX_PROBE_BYTES) return null;
  try {
    const buffer = (await blob.arrayBuffer()) as ArrayBuffer & { fileStart: number };
    buffer.fileStart = 0;
    const file = createFile();
    let trackId: number | null = null;
    let settled = false;
    file.onReady = (info) => {
      settled = true;
      trackId = info.videoTracks?.[0]?.id ?? null;
    };
    file.onError = () => {
      settled = true;
    };
    file.appendBuffer(buffer);
    file.flush();
    if (!settled) {
      await new Promise<void>((resolve) => {
        const start = Date.now();
        const tick = () => (settled || Date.now() - start > READY_TIMEOUT_MS ? resolve() : setTimeout(tick, 32));
        tick();
      });
    }
    if (trackId === null) return null;
    const samples: MP4Sample[] = file.getTrackSamplesInfo?.(trackId) ?? [];
    file.stop();
    return summarizeGopGaps(samples.map((s) => Boolean(s.is_sync)));
  } catch {
    return null;
  }
}
