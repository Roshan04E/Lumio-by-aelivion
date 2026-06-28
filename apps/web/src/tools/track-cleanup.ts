import type { SubjectBounds, TrackingPathArtifactData, TrackingPoint } from "@reelforge/shared";
import { cleanTrackingPoints, fuseTrackMeasurements, type FrameMeasurement } from "@reelforge/shared";
import { detectInitialSubjectBox, loadVideoElement, seekVideo } from "./local-segmentation";
import { extractPatch, prepareTemplate, searchNcc, type GrayImage } from "./tracking-core";

/**
 * Evidence-based cleanup for an already-tracked path. Unlike the purely geometric
 * `cleanTrackingPoints`, this re-opens the real video and gathers independent
 * evidence about how trustworthy each tracked frame is, then fuses it through the
 * shared Kalman/RTS smoother (`fuseTrackMeasurements`). The result locks onto the
 * real subject where the evidence is strong and coasts on a smooth-motion prior
 * where it isn't - so a frame where the tracker slipped off the person is corrected
 * instead of being faithfully (and wrongly) smoothed.
 *
 * Three independent evidence signals per frame:
 *  1. Appearance confidence - the NCC score already stored on each tracked point.
 *  2. Forward-backward consistency - a local round-trip re-track between adjacent
 *     frames; a high round-trip error means that frame-to-frame step is unreliable
 *     (occlusion, motion blur, drift). This is the big one, and it's image-based.
 *  3. Subject grounding - re-runs the real subject detector at sampled times and
 *     flags frames whose point has wandered off the detected silhouette. This is
 *     the semantic "is this still the person/object?" check.
 *
 * A final light geometric pass (`cleanTrackingPoints`) applies the straight-path
 * recognition / de-jitter on top of the fused result.
 */

export interface TrackCleanupRefineOptions {
  videoUrl: string;
  durationSeconds: number;
  width: number;
  height: number;
  trackingPath: TrackingPathArtifactData;
  smoothing?: number | undefined;
  onProgress?: ((message: string) => void) | undefined;
  isCancelled?: (() => boolean) | undefined;
}

export interface TrackCleanupRefineResult {
  trackingPath: TrackingPathArtifactData;
  diagnostics: {
    pointCount: number;
    /** Frames the evidence judged unreliable (low confidence / high FB error / off subject). */
    correctedFrames: number;
    /** Frames whose point had drifted off the detected subject. */
    offSubjectFrames: number;
    /** Mean forward-backward round-trip error across the path, percent units. */
    meanForwardBackwardError: number;
    /** Whether subject grounding actually ran (the detector was available). */
    usedSubjectGrounding: boolean;
    /** From the final geometric pass. */
    linearity: number;
    straightened: boolean;
    averageCorrection: number;
  };
}

const FB_PATCH_RADIUS = 6;
const FB_SEARCH_RADIUS = 10;
const MAX_SUBJECT_SAMPLES = 16;
const SUBJECT_PAD = 0.15;
/** Below this fused reliability a frame is reported as "corrected" in diagnostics. */
const CORRECTED_RELIABILITY_THRESHOLD = 0.5;

export async function refineTrackingPath(options: TrackCleanupRefineOptions): Promise<TrackCleanupRefineResult> {
  assertNotCancelled(options.isCancelled);
  const path = options.trackingPath;
  const points = path.points;

  // Too short to gather meaningful evidence - fall back to the geometric cleaner.
  if (points.length < 4) {
    const geo = cleanTrackingPoints(points, { smoothing: options.smoothing });
    return {
      trackingPath: { ...path, points: geo.points },
      diagnostics: {
        pointCount: points.length,
        correctedFrames: geo.diagnostics.outliersFixed,
        offSubjectFrames: 0,
        meanForwardBackwardError: 0,
        usedSubjectGrounding: false,
        linearity: geo.diagnostics.linearity,
        straightened: geo.diagnostics.straightened,
        averageCorrection: geo.diagnostics.averageCorrection
      }
    };
  }

  options.onProgress?.("Re-opening clip to verify the track.");
  const video = await loadVideoElement(options.videoUrl);
  const width = video.videoWidth || options.width;
  const height = video.videoHeight || options.height;
  const diagonal = Math.hypot(width, height) || 1;

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) {
    throw new Error("Canvas 2D context unavailable for track cleanup.");
  }

  // --- Signal 2: forward-backward consistency over real frames -----------
  const fbErrorPx = new Array<number>(points.length).fill(0);
  let prevGray: GrayImage | undefined;
  let prevPx: { x: number; y: number } | undefined;
  for (let i = 0; i < points.length; i += 1) {
    assertNotCancelled(options.isCancelled);
    const point = points[i];
    if (!point) {
      continue;
    }
    await seekVideo(video, point.timeSeconds);
    ctx.drawImage(video, 0, 0, width, height);
    const gray: GrayImage = { data: toGrayscale(ctx.getImageData(0, 0, width, height)), width, height };
    const px = { x: (point.position.x / 100) * width, y: (point.position.y / 100) * height };

    if (prevGray && prevPx) {
      const error = roundTripError(prevGray, gray, prevPx, px);
      // The error belongs to the transition between i-1 and i; surface it on both endpoints.
      fbErrorPx[i - 1] = Math.max(fbErrorPx[i - 1] ?? 0, error);
      fbErrorPx[i] = Math.max(fbErrorPx[i] ?? 0, error);
    }
    prevGray = gray;
    prevPx = px;
    if (i % 8 === 0) {
      options.onProgress?.(`Verifying motion ${i + 1}/${points.length}.`);
    }
  }

  // --- Signal 3: subject grounding (semantic) ----------------------------
  const { offSubject, usedSubjectGrounding } = await sampleOffSubject(options, points, width, height);

  // --- Fuse all evidence through the shared Kalman/RTS smoother -----------
  options.onProgress?.("Fusing evidence and smoothing.");
  const frames: FrameMeasurement[] = points.map((point, i) => ({
    timeSeconds: point.timeSeconds,
    x: point.position.x,
    y: point.position.y,
    confidence: point.confidence,
    forwardBackwardError: ((fbErrorPx[i] ?? 0) / diagonal) * 100,
    offSubject: offSubject[i] ?? 0
  }));
  const fused = fuseTrackMeasurements(frames, options.smoothing === undefined ? {} : { smoothing: options.smoothing });

  const fusedPoints: TrackingPoint[] = points.map((point, i) => {
    const nx = fused.x[i] ?? point.position.x;
    const ny = fused.y[i] ?? point.position.y;
    const dx = nx - point.position.x;
    const dy = ny - point.position.y;
    return {
      ...point,
      position: { x: Number(nx.toFixed(3)), y: Number(ny.toFixed(3)) },
      bounds: { ...point.bounds, x: point.bounds.x + dx, y: point.bounds.y + dy }
    };
  });

  // --- Final geometric pass: straight-path recognition / de-jitter -------
  const geo = cleanTrackingPoints(fusedPoints, { smoothing: Math.min(0.2, options.smoothing ?? 0.2) });

  const correctedFrames = fused.reliability.filter((value) => value < CORRECTED_RELIABILITY_THRESHOLD).length;
  const offSubjectFrames = offSubject.filter((value) => value > 0).length;
  const meanFb = frames.reduce((sum, frame) => sum + frame.forwardBackwardError, 0) / frames.length;

  return {
    trackingPath: { ...path, points: geo.points },
    diagnostics: {
      pointCount: points.length,
      correctedFrames,
      offSubjectFrames,
      meanForwardBackwardError: Number(meanFb.toFixed(3)),
      usedSubjectGrounding,
      linearity: geo.diagnostics.linearity,
      straightened: geo.diagnostics.straightened,
      averageCorrection: geo.diagnostics.averageCorrection
    }
  };
}

/**
 * Local forward-backward round-trip: take the patch at `prevPx` in the previous
 * frame, find it in the current frame (forward), then take that match and find it
 * back in the previous frame (backward). The distance between the start and the
 * round-tripped point is the consistency error - large means this frame-to-frame
 * step can't be trusted. Local (one step) so it doesn't accumulate drift.
 */
function roundTripError(prevGray: GrayImage, gray: GrayImage, prevPx: { x: number; y: number }, px: { x: number; y: number }): number {
  const patch = extractPatch(prevGray, prevPx.x, prevPx.y, FB_PATCH_RADIUS);
  if (!patch) {
    return 0;
  }
  const forward = searchNcc(prepareTemplate(patch, FB_PATCH_RADIUS), gray, px.x, px.y, FB_SEARCH_RADIUS);
  const patchForward = extractPatch(gray, forward.x, forward.y, FB_PATCH_RADIUS);
  if (!patchForward) {
    return 0;
  }
  const back = searchNcc(prepareTemplate(patchForward, FB_PATCH_RADIUS), prevGray, prevPx.x, prevPx.y, FB_SEARCH_RADIUS);
  return Math.hypot(back.x - prevPx.x, back.y - prevPx.y);
}

interface SubjectSample {
  timeSeconds: number;
  bounds: SubjectBounds;
}

async function sampleOffSubject(
  options: TrackCleanupRefineOptions,
  points: TrackingPoint[],
  width: number,
  height: number
): Promise<{ offSubject: number[]; usedSubjectGrounding: boolean }> {
  const offSubject = new Array<number>(points.length).fill(0);
  const sampleCount = Math.min(points.length, MAX_SUBJECT_SAMPLES);
  const samples: SubjectSample[] = [];
  try {
    for (let s = 0; s < sampleCount; s += 1) {
      assertNotCancelled(options.isCancelled);
      const index = sampleCount === 1 ? 0 : Math.round((s * (points.length - 1)) / (sampleCount - 1));
      const point = points[index];
      if (!point) {
        continue;
      }
      const bounds = await detectInitialSubjectBox({ videoUrl: options.videoUrl, width, height, timeSeconds: point.timeSeconds });
      samples.push({ timeSeconds: point.timeSeconds, bounds });
      options.onProgress?.(`Checking subject ${s + 1}/${sampleCount}.`);
    }
  } catch {
    // Subject detector unavailable for this clip - skip grounding rather than fail the whole cleanup.
    return { offSubject, usedSubjectGrounding: false };
  }

  if (!samples.length) {
    return { offSubject, usedSubjectGrounding: false };
  }

  for (let i = 0; i < points.length; i += 1) {
    const point = points[i];
    if (!point) {
      continue;
    }
    const bounds = interpolateBounds(samples, point.timeSeconds);
    offSubject[i] = outsideAmount(point.position, bounds);
  }
  return { offSubject, usedSubjectGrounding: true };
}

function interpolateBounds(samples: SubjectSample[], timeSeconds: number): SubjectBounds {
  if (timeSeconds <= (samples[0]?.timeSeconds ?? 0)) {
    return samples[0]!.bounds;
  }
  const last = samples[samples.length - 1]!;
  if (timeSeconds >= last.timeSeconds) {
    return last.bounds;
  }
  for (let i = 1; i < samples.length; i += 1) {
    const a = samples[i - 1]!;
    const b = samples[i]!;
    if (timeSeconds <= b.timeSeconds) {
      const span = b.timeSeconds - a.timeSeconds || 1;
      const t = (timeSeconds - a.timeSeconds) / span;
      return {
        timeSeconds,
        x: a.bounds.x + (b.bounds.x - a.bounds.x) * t,
        y: a.bounds.y + (b.bounds.y - a.bounds.y) * t,
        width: a.bounds.width + (b.bounds.width - a.bounds.width) * t,
        height: a.bounds.height + (b.bounds.height - a.bounds.height) * t,
        confidence: Math.min(a.bounds.confidence, b.bounds.confidence)
      };
    }
  }
  return last.bounds;
}

/** 0 when the point is inside the (padded) subject box, growing with normalised distance outside it. */
function outsideAmount(position: { x: number; y: number }, bounds: SubjectBounds): number {
  const padX = bounds.width * SUBJECT_PAD;
  const padY = bounds.height * SUBJECT_PAD;
  const left = bounds.x - padX;
  const right = bounds.x + bounds.width + padX;
  const top = bounds.y - padY;
  const bottom = bounds.y + bounds.height + padY;
  let dx = 0;
  if (position.x < left) {
    dx = left - position.x;
  } else if (position.x > right) {
    dx = position.x - right;
  }
  let dy = 0;
  if (position.y < top) {
    dy = top - position.y;
  } else if (position.y > bottom) {
    dy = position.y - bottom;
  }
  return Math.hypot(dx / (bounds.width || 1), dy / (bounds.height || 1));
}

function toGrayscale(imageData: ImageData): Float32Array {
  const { data, width, height } = imageData;
  const gray = new Float32Array(width * height);
  for (let i = 0; i < width * height; i += 1) {
    const r = data[i * 4] ?? 0;
    const g = data[i * 4 + 1] ?? 0;
    const b = data[i * 4 + 2] ?? 0;
    gray[i] = 0.299 * r + 0.587 * g + 0.114 * b;
  }
  return gray;
}

function assertNotCancelled(isCancelled?: () => boolean) {
  if (isCancelled?.()) {
    throw new Error("Track cleanup cancelled.");
  }
}
