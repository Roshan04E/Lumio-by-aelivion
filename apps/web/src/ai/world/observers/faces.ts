/**
 * Orreris OS observer — face presence (K5, the FIRST browser-ML observer; L3 "expensive
 * perception" on the fidelity ladder). Samples a handful of frames from a video/image asset
 * and runs MediaPipe BlazeFace (~200KB, lazy-loaded via `ai/vision/face-detection.ts`) to
 * measure whether — and how much — a person's face is on screen:
 *
 *   presenceShare · maxFaces · avgFaceAreaShare · dominantRegion
 *
 * The pattern this file sets for every future ML observer:
 *  - the MODEL loads lazily and failures make the observer DECLINE (return []), never guess;
 *  - frames come from the shared L1 sampler (wider here — detection needs resolution);
 *  - the aggregation is a PURE exported function so world:eval covers the math under node,
 *    while `signature()` returns null without a DOM so the query planner skips the path in eval;
 *  - facts land on the ASSET (source pixels are write-once → memoized until the asset changes).
 */

import { getAssetBlobStore } from "../../../lib/asset-blob-store";
import { getFaceDetector } from "../../vision/face-detection";
import type { WorldContext, WorldObserver, WorldTarget } from "../types";
import { fnv1a } from "../types";
import { sampleImage, sampleVideo } from "./look";

export const MEDIA_FACES_FACT = "media.faces";

export interface MediaFacesFact {
  /** Fraction of sampled frames with at least one face, 0..1. */
  presenceShare: number;
  /** Most faces seen in any single sampled frame. */
  maxFaces: number;
  /** Mean (largest face area / frame area) over frames that HAD a face, 0..1. */
  avgFaceAreaShare: number;
  /** Where faces sit on average: thirds of the frame. "none" when no face was ever seen. */
  dominantRegion: "left" | "center" | "right" | "none";
  framesSampled: number;
}

/** One sampled frame's detections, normalized to the frame (pure-math input for eval). */
export interface FrameFaceSample {
  faces: Array<{
    /** Face-box center x as a fraction of frame width, 0..1. */
    centerX: number;
    /** Face-box area as a fraction of frame area, 0..1. */
    areaShare: number;
  }>;
}

/** Detection needs more pixels than a histogram — BlazeFace wants real face sizes. */
const DETECT_SAMPLE_WIDTH = 256;
/** 7 spread points: presence-SHARE needs more temporal evidence than a look average. */
const DETECT_SAMPLE_POINTS = [0.05, 0.2, 0.35, 0.5, 0.65, 0.8, 0.95];

export function aggregateFaceSamples(rawSamples: FrameFaceSample[]): MediaFacesFact | null {
  if (rawSamples.length === 0) {
    return null;
  }
  // CORROBORATION rule (real report 2026-07-18: a night-city skyline "grew" a face —
  // window/light patterns are classic single-frame false positives): with 3+ samples, a
  // detection in exactly ONE frame is noise, not a person — a real face on screen long
  // enough to matter hits 2+ of the spread sample points. Missing a one-frame cameo is
  // the safe direction; claiming a person in empty footage is not (precision-first).
  const detectedFrameCount = rawSamples.filter((sample) => sample.faces.length > 0).length;
  const samples =
    rawSamples.length >= 3 && detectedFrameCount === 1 ? rawSamples.map((sample) => ({ faces: [] as FrameFaceSample["faces"] })) : rawSamples;
  let framesWithFaces = 0;
  let maxFaces = 0;
  let areaSum = 0;
  let centerSum = 0;
  let centerCount = 0;
  for (const sample of samples) {
    maxFaces = Math.max(maxFaces, sample.faces.length);
    if (sample.faces.length === 0) {
      continue;
    }
    framesWithFaces += 1;
    areaSum += Math.max(...sample.faces.map((face) => face.areaShare));
    for (const face of sample.faces) {
      centerSum += face.centerX;
      centerCount += 1;
    }
  }
  const meanCenter = centerCount > 0 ? centerSum / centerCount : 0.5;
  return {
    presenceShare: framesWithFaces / samples.length,
    maxFaces,
    avgFaceAreaShare: framesWithFaces > 0 ? areaSum / framesWithFaces : 0,
    dominantRegion: framesWithFaces === 0 ? "none" : meanCenter < 0.4 ? "left" : meanCenter > 0.6 ? "right" : "center",
    framesSampled: samples.length
  };
}

function assetFor(target: WorldTarget, ctx: WorldContext) {
  if (target.kind !== "asset") {
    return undefined;
  }
  const asset = ctx.assets.find((item) => item.id === target.id);
  if (!asset) {
    return undefined;
  }
  const kind = asset.fileType.split("/")[0];
  return kind === "video" || kind === "image" ? asset : undefined;
}

export const facesObserver: WorldObserver = {
  id: "face-presence@builtin",
  // v2 (2026-07-18): corroboration rule + 0.6 detector floor — the bump invalidates every
  // memoized v1 fact, so the skyline false positive can't survive from cache.
  version: 2,
  factTypes: [MEDIA_FACES_FACT],
  fidelity: 3,
  // Honest L3 price: first run includes the wasm+model download; warm runs are ~1–2s.
  estCostMs: 4_000,
  estConfidence: 0.85,
  signature(target, ctx) {
    if (typeof document === "undefined" || typeof WebAssembly === "undefined") {
      return null; // no DOM/wasm (eval/node) — this access path doesn't exist here
    }
    const asset = assetFor(target, ctx);
    if (!asset) {
      return null;
    }
    return fnv1a([asset.id, asset.sizeBytes ?? "", asset.updatedAt ?? "", asset.durationSeconds].join("|"));
  },
  async observe(target, ctx) {
    const asset = assetFor(target, ctx);
    if (!asset) {
      return [];
    }
    const detector = await getFaceDetector();
    if (!detector) {
      return []; // model unavailable (offline, no wasm) → decline, never guess
    }
    const localUrl = await (await getAssetBlobStore()).getObjectUrl(asset.id);
    const url = localUrl ?? asset.proxyUrl ?? asset.previewUrl ?? asset.fileUrl;
    if (!url) {
      return [];
    }
    const isVideo = asset.fileType.startsWith("video/");
    const options = { width: DETECT_SAMPLE_WIDTH, points: DETECT_SAMPLE_POINTS };
    const sampled = isVideo ? await sampleVideo(url, asset.durationSeconds, options) : await sampleImage(url, options);
    if (sampled.frames.length === 0) {
      return [];
    }
    const samples: FrameFaceSample[] = [];
    for (const frame of sampled.frames) {
      try {
        const result = detector.detect(frame);
        samples.push({
          faces: result.detections.flatMap((detection) => {
            const box = detection.boundingBox;
            if (!box || frame.width === 0 || frame.height === 0) {
              return [];
            }
            return [
              {
                centerX: (box.originX + box.width / 2) / frame.width,
                areaShare: Math.min(1, (box.width * box.height) / (frame.width * frame.height))
              }
            ];
          })
        });
      } catch {
        // One bad frame doesn't kill the observation — presence share stays honest
        // because only DETECTED frames enter the sample set.
      }
    }
    const value = aggregateFaceSamples(samples);
    if (!value) {
      return [];
    }
    return [
      {
        type: MEDIA_FACES_FACT,
        value,
        // Sampled frames, not a full scan — same honesty band as the look observer.
        confidence: isVideo ? 0.85 : 0.9,
        sampledRanges: sampled.ranges
      }
    ];
  }
};
