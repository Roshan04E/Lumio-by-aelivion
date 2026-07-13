import type { TrackingPathArtifactData, TrackingPoint } from "@kimera-by-aelivion/shared";
import { smoothTrackingPoints } from "@kimera-by-aelivion/shared";
import { detectInitialSubjectBox, loadVideoElement, sampleFrameTimes, seekVideo } from "./local-segmentation";
import { downsampleGrayHalf, extractPatch, nccToConfidence, prepareTemplate, searchNcc, type GrayImage } from "./tracking-core";

/**
 * Real (non-mock) in-browser point tracker for Smart Follow Text. Runs fully
 * locally - no network call, no cloud cost - so it's free for base users.
 *
 * Deliberately simple, DaVinci-style point tracking: the user (or auto
 * subject detection) picks a single point, and the tracker follows that
 * point's position frame to frame. No box, no scale/rotation/perspective
 * decomposition - those were the source of the earlier corner-tracker's
 * inaccuracy (tiny per-corner noise got amplified into large fake rotation/
 * perspective swings). Position-only is what's actually robust to build
 * confidently with a from-scratch tracker; richer channels can come back
 * later once this is solid.
 *
 * Pipeline per sampled frame, per target:
 * 1. The anchor template (a small patch around the point) is captured once
 *    when tracking starts and never silently replaced - a rigid match, not
 *    an adaptive one, so the track is predictable and doesn't drift.
 * 2. Each frame, the next position is predicted from the previous frame's
 *    velocity, then refined via normalized cross-correlation (NCC) search
 *    around that prediction. NCC (unlike raw pixel-difference matching) is
 *    invariant to brightness/contrast changes between frames.
 * 3. "quality" mode runs the search coarse-to-fine over a 2-level image
 *    pyramid first, which lets it recover from larger frame-to-frame motion
 *    than a single-scale search at the same cost; "fast" mode is single-scale.
 * 4. Subpixel refinement (parabola fit on the NCC scores) removes the
 *    constant 1px jitter an integer-only search produces.
 * 5. The auto target re-anchors itself via AI segmentation after several
 *    consecutive low-confidence frames (occlusion/track-loss recovery);
 *    manual points hold their last position and widen the search window the
 *    longer they stay lost, since there's no detector to re-acquire them with.
 * 6. The search itself runs in a Web Worker so a long track doesn't block the
 *    UI thread; falls back to running inline when Workers are unavailable.
 */

export type TrackQuality = "fast" | "quality";

export interface TrackPointPercent {
  x: number;
  y: number;
}

export interface TrackTargetInput {
  id: string;
  label: string;
  /** When true, `point` is ignored and the initial point is auto-detected via segmentation (and re-acquired on track loss). */
  auto?: boolean | undefined;
  /** Required when `auto` is not set: a manually-placed percent point. */
  point?: TrackPointPercent | undefined;
}

export interface NamedTrackingResult {
  id: string;
  label: string;
  trackingPath: TrackingPathArtifactData;
}

export interface PlanarTrackOptions {
  videoUrl: string;
  durationSeconds: number;
  width: number;
  height: number;
  /** One or more targets to track in a single pass over the video. */
  targets: TrackTargetInput[];
  quality?: TrackQuality | undefined;
  trackFps?: number | undefined;
  /**
   * When set (> 0), tracking starts at this time instead of frame 0: the template is
   * anchored at this frame using each target's `point`, and only frames from here to
   * the end are tracked/returned. Used by the "re-track from a fix marker" flow to
   * re-track just the tail of a path while keeping the good earlier portion.
   */
  startTimeSeconds?: number | undefined;
  onProgress?: ((message: string) => void) | undefined;
  isCancelled?: (() => boolean) | undefined;
  /** Disable worker offload, e.g. for environments without Worker support. Defaults to auto-detect. */
  useWorker?: boolean | undefined;
}

export const AUTO_TARGET_ID = "auto";

interface Point {
  x: number;
  y: number;
}

interface TargetState {
  id: string;
  label: string;
  isAuto: boolean;
  point: Point;
  velocity: Point;
  templateFull: Float32Array;
  templateHalf: Float32Array;
  lostStreak: number;
  /** Frames since the anchor template was last refreshed - rate-limits adaptive refresh so it can't drift quickly even under sustained high confidence. */
  framesSinceRefresh: number;
  points: TrackingPoint[];
}

const FULL_PATCH_RADIUS = 7;
const HALF_PATCH_RADIUS = 5;
const FAST_SEARCH_RADIUS = 20;
const QUALITY_COARSE_SEARCH_RADIUS = 22;
const QUALITY_REFINE_SEARCH_RADIUS = 9;
const MIN_CONFIDENCE = 0.55;
const LOST_STREAK_REACQUIRE_THRESHOLD = 5;
const LOST_SEARCH_WIDEN_PER_FRAME = 6;
const MAX_LOST_SEARCH_WIDEN = 48;
const VISUAL_BOX_PERCENT = 3;

/**
 * A purely rigid template (anchored once at frame 0) loses lock the moment the
 * point's surroundings change - the person turns, the camera angle shifts,
 * lighting changes. Adaptive refresh lets the template slowly drift along with
 * those gradual appearance changes (the dominant real-world failure mode)
 * while staying safe: it only blends in a fresh patch when the match was
 * strongly confident (REFRESH_CONFIDENCE, well above the bare MIN_CONFIDENCE
 * needed to just keep tracking), only partially (REFRESH_BLEND, never a full
 * replace - so one bad confident-but-wrong frame can't corrupt the anchor),
 * and only every few frames (REFRESH_MIN_INTERVAL_FRAMES) so the effective
 * drift rate stays slow even under sustained high confidence.
 */
const TEMPLATE_REFRESH_CONFIDENCE = 0.82;
const TEMPLATE_REFRESH_BLEND = 0.25;
const TEMPLATE_REFRESH_MIN_INTERVAL_FRAMES = 3;

/** Backward-compatible single-target wrapper around {@link trackTargetsPlanar3D}. */
export async function trackSubjectPlanar3D(options: {
  videoUrl: string;
  durationSeconds: number;
  width: number;
  height: number;
  initialPoint?: TrackPointPercent | undefined;
  quality?: TrackQuality | undefined;
  trackFps?: number | undefined;
  onProgress?: ((message: string) => void) | undefined;
  isCancelled?: (() => boolean) | undefined;
}): Promise<TrackingPathArtifactData> {
  const results = await trackTargetsPlanar3D({
    videoUrl: options.videoUrl,
    durationSeconds: options.durationSeconds,
    width: options.width,
    height: options.height,
    quality: options.quality,
    trackFps: options.trackFps,
    onProgress: options.onProgress,
    isCancelled: options.isCancelled,
    targets: [{ id: AUTO_TARGET_ID, label: "Subject", auto: !options.initialPoint, point: options.initialPoint }]
  });
  const result = results[0];
  if (!result) {
    throw new Error("Tracking produced no usable frames.");
  }
  return result.trackingPath;
}

export async function trackTargetsPlanar3D(options: PlanarTrackOptions): Promise<NamedTrackingResult[]> {
  assertNotCancelled(options.isCancelled);
  if (!options.targets.length) {
    throw new Error("trackTargetsPlanar3D requires at least one target.");
  }
  options.onProgress?.("Loading video for tracking.");
  const video = await loadVideoElement(options.videoUrl);
  const width = video.videoWidth || options.width;
  const height = video.videoHeight || options.height;
  const quality = options.quality ?? "fast";

  const worker = options.useWorker === false ? undefined : createTrackingWorker();

  const trackFps = Math.min(15, Math.max(6, options.trackFps ?? 10));
  const startTimeSeconds = Math.max(0, options.startTimeSeconds ?? 0);
  // For a partial (from-marker) re-track, anchor exactly at the marker time and keep
  // only the frames after it; otherwise this is the full sampled set from frame 0.
  const frameTimes =
    startTimeSeconds > 0
      ? [startTimeSeconds, ...sampleFrameTimes(options.durationSeconds, trackFps).filter((time) => time > startTimeSeconds + 1e-3)]
      : sampleFrameTimes(options.durationSeconds, trackFps);

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) {
    throw new Error("Canvas 2D context unavailable for tracking.");
  }

  // Anchor frame 0: draw it, then seed every target's point + template from it.
  await seekVideo(video, frameTimes[0] ?? 0);
  ctx.drawImage(video, 0, 0, width, height);
  const anchorImage: GrayImage = { data: toGrayscale(ctx.getImageData(0, 0, width, height)), width, height };

  const targets: TargetState[] = [];
  for (const targetInput of options.targets) {
    assertNotCancelled(options.isCancelled);
    const isAuto = Boolean(targetInput.auto);
    const pointPercent = isAuto ? await autoDetectPoint(options.videoUrl, width, height) : targetInput.point;
    if (!pointPercent) {
      throw new Error(`Target "${targetInput.label}" is missing a track point.`);
    }
    const point = percentToPixels(pointPercent, width, height);
    const anchored = anchorTemplates(anchorImage, point);
    if (!anchored) {
      throw new Error(`Target "${targetInput.label}" is too close to the frame edge to track.`);
    }
    targets.push({
      id: targetInput.id,
      label: targetInput.label,
      isAuto,
      point,
      velocity: { x: 0, y: 0 },
      templateFull: anchored.templateFull,
      templateHalf: anchored.templateHalf,
      lostStreak: 0,
      framesSinceRefresh: 0,
      points: []
    });
  }

  pushTrackingPoints(targets, frameTimes[0] ?? 0, width, height, 0.95);

  for (const [frameIndex, timeSeconds] of frameTimes.entries()) {
    if (frameIndex === 0) {
      options.onProgress?.(`Tracked frame 1 of ${frameTimes.length} (${targets.length} target${targets.length > 1 ? "s" : ""}).`);
      continue;
    }
    assertNotCancelled(options.isCancelled);
    await seekVideo(video, timeSeconds);
    ctx.drawImage(video, 0, 0, width, height);
    const image: GrayImage = { data: toGrayscale(ctx.getImageData(0, 0, width, height)), width, height };

    const requestTargets = targets.map((target) => {
      const widen = target.lostStreak > 0 ? Math.min(MAX_LOST_SEARCH_WIDEN, target.lostStreak * LOST_SEARCH_WIDEN_PER_FRAME) : 0;
      const predicted = target.lostStreak > 0 ? target.point : { x: target.point.x + target.velocity.x, y: target.point.y + target.velocity.y };
      return {
        id: target.id,
        templateFull: target.templateFull,
        templateHalf: target.templateHalf,
        predicted,
        searchRadiusFull: (quality === "quality" ? QUALITY_REFINE_SEARCH_RADIUS : FAST_SEARCH_RADIUS) + widen,
        searchRadiusHalf: QUALITY_COARSE_SEARCH_RADIUS + Math.round(widen / 2),
        usePyramid: quality === "quality"
      };
    });

    const results = await trackTargetsBatch(worker, image, requestTargets);
    const resultsById = new Map(results.map((result) => [result.id, result]));

    for (const target of targets) {
      const result = resultsById.get(target.id);
      if (!result) {
        continue;
      }
      const confident = result.confidence >= MIN_CONFIDENCE;
      target.velocity = confident ? { x: result.x - target.point.x, y: result.y - target.point.y } : { x: 0, y: 0 };
      target.point = { x: result.x, y: result.y };
      target.lostStreak = confident ? 0 : target.lostStreak + 1;
      target.framesSinceRefresh += 1;

      if (target.isAuto && target.lostStreak >= LOST_STREAK_REACQUIRE_THRESHOLD) {
        try {
          const reacquiredPercent = await detectInitialSubjectPoint(options.videoUrl, width, height, timeSeconds);
          const reacquiredPoint = percentToPixels(reacquiredPercent, width, height);
          const anchored = anchorTemplates(image, reacquiredPoint);
          if (anchored) {
            target.point = reacquiredPoint;
            target.velocity = { x: 0, y: 0 };
            target.templateFull = anchored.templateFull;
            target.templateHalf = anchored.templateHalf;
            target.lostStreak = 0;
            target.framesSinceRefresh = 0;
            options.onProgress?.(`Re-acquired "${target.label}" after losing track.`);
          }
        } catch {
          // Re-acquisition failed (e.g. subject left frame) - keep holding the last position.
        }
      } else if (result.confidence >= TEMPLATE_REFRESH_CONFIDENCE && target.framesSinceRefresh >= TEMPLATE_REFRESH_MIN_INTERVAL_FRAMES) {
        refreshTemplate(target, image);
        target.framesSinceRefresh = 0;
      }
    }

    pushTrackingPoints(targets, timeSeconds, width, height);
    options.onProgress?.(`Tracked frame ${frameIndex + 1} of ${frameTimes.length} (${targets.length} target${targets.length > 1 ? "s" : ""}).`);
  }

  worker?.terminate();

  return targets.map((target) => {
    if (!target.points.length) {
      throw new Error(`Tracking produced no usable frames for "${target.label}".`);
    }
    const trackingPath: TrackingPathArtifactData = {
      id: `track_browser_${target.id}_${Date.now()}`,
      durationSeconds: options.durationSeconds,
      smoothing: 0.4,
      source: "browser",
      is3d: false,
      points: target.points
    };
    return {
      id: target.id,
      label: target.label,
      trackingPath: { ...trackingPath, points: smoothTrackingPoints(trackingPath.points, trackingPath.smoothing) }
    };
  });
}

function pushTrackingPoints(targets: TargetState[], timeSeconds: number, width: number, height: number, forcedConfidence?: number) {
  const halfBoxPx = { width: (VISUAL_BOX_PERCENT / 100) * width, height: (VISUAL_BOX_PERCENT / 100) * height };
  for (const target of targets) {
    const confidence = forcedConfidence ?? (target.lostStreak === 0 ? 0.92 : Math.max(0.1, 0.92 - target.lostStreak * 0.15));
    target.points.push({
      timeSeconds,
      position: { x: (target.point.x / width) * 100, y: (target.point.y / height) * 100 },
      bounds: {
        timeSeconds,
        x: ((target.point.x - halfBoxPx.width / 2) / width) * 100,
        y: ((target.point.y - halfBoxPx.height / 2) / height) * 100,
        width: VISUAL_BOX_PERCENT,
        height: VISUAL_BOX_PERCENT,
        confidence
      },
      confidence
    });
  }
}

async function autoDetectPoint(videoUrl: string, width: number, height: number): Promise<TrackPointPercent> {
  return detectInitialSubjectPoint(videoUrl, width, height);
}

async function detectInitialSubjectPoint(videoUrl: string, width: number, height: number, timeSeconds?: number): Promise<TrackPointPercent> {
  const bounds = await detectInitialSubjectBox(timeSeconds === undefined ? { videoUrl, width, height } : { videoUrl, width, height, timeSeconds });
  return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height * 0.42 };
}

function percentToPixels(point: TrackPointPercent, width: number, height: number): Point {
  return { x: (point.x / 100) * width, y: (point.y / 100) * height };
}

function anchorTemplates(image: GrayImage, point: Point): { templateFull: Float32Array; templateHalf: Float32Array } | undefined {
  const templateFull = extractPatch(image, point.x, point.y, FULL_PATCH_RADIUS);
  if (!templateFull) {
    return undefined;
  }
  const templateHalf = extractPatch(downsampleGrayHalf(image), point.x / 2, point.y / 2, HALF_PATCH_RADIUS);
  if (!templateHalf) {
    // Fall back to a degenerate (zeroed) half template - coarse pass simply won't help, refine pass still works.
    return { templateFull, templateHalf: new Float32Array((HALF_PATCH_RADIUS * 2 + 1) ** 2) };
  }
  return { templateFull, templateHalf };
}

/** Blends a freshly-extracted patch at the target's current point into its anchor templates - see TEMPLATE_REFRESH_* for why this is partial/rate-limited rather than a full replace. */
function refreshTemplate(target: TargetState, image: GrayImage) {
  const freshFull = extractPatch(image, target.point.x, target.point.y, FULL_PATCH_RADIUS);
  if (freshFull) {
    target.templateFull = blendPatch(target.templateFull, freshFull, TEMPLATE_REFRESH_BLEND);
  }
  const freshHalf = extractPatch(downsampleGrayHalf(image), target.point.x / 2, target.point.y / 2, HALF_PATCH_RADIUS);
  if (freshHalf) {
    target.templateHalf = blendPatch(target.templateHalf, freshHalf, TEMPLATE_REFRESH_BLEND);
  }
}

function blendPatch(oldPatch: Float32Array, newPatch: Float32Array, alpha: number): Float32Array {
  const blended = new Float32Array(oldPatch.length);
  for (let i = 0; i < oldPatch.length; i += 1) {
    blended[i] = (oldPatch[i] ?? 0) * (1 - alpha) + (newPatch[i] ?? 0) * alpha;
  }
  return blended;
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

interface BatchTargetRequest {
  id: string;
  templateFull: Float32Array;
  templateHalf: Float32Array;
  predicted: Point;
  searchRadiusFull: number;
  searchRadiusHalf: number;
  usePyramid: boolean;
}

interface BatchTargetResult {
  id: string;
  x: number;
  y: number;
  confidence: number;
}

async function trackTargetsBatch(
  worker: TrackingWorkerHandle | undefined,
  image: GrayImage,
  targets: BatchTargetRequest[]
): Promise<BatchTargetResult[]> {
  if (worker) {
    try {
      return await worker.track({ width: image.width, height: image.height, currentGray: image.data, targets });
    } catch {
      // Fall through to inline computation if the worker failed mid-run.
    }
  }
  return targets.map((target) => trackOneInline(image, target));
}

function trackOneInline(image: GrayImage, target: BatchTargetRequest): BatchTargetResult {
  let centerX = target.predicted.x;
  let centerY = target.predicted.y;

  if (target.usePyramid) {
    const halfImage = downsampleGrayHalf(image);
    const halfTemplate = prepareTemplate(target.templateHalf, HALF_PATCH_RADIUS);
    const coarse = searchNcc(halfTemplate, halfImage, centerX / 2, centerY / 2, target.searchRadiusHalf);
    centerX = coarse.x * 2;
    centerY = coarse.y * 2;
  }

  const fullTemplate = prepareTemplate(target.templateFull, FULL_PATCH_RADIUS);
  const refined = searchNcc(fullTemplate, image, centerX, centerY, target.searchRadiusFull);
  return { id: target.id, x: refined.x, y: refined.y, confidence: nccToConfidence(refined.score) };
}

interface TrackingWorkerHandle {
  track: (input: {
    width: number;
    height: number;
    currentGray: Float32Array;
    targets: BatchTargetRequest[];
  }) => Promise<BatchTargetResult[]>;
  terminate: () => void;
}

function createTrackingWorker(): TrackingWorkerHandle | undefined {
  if (typeof Worker === "undefined") {
    return undefined;
  }
  try {
    const worker = new Worker(new URL("./tracking-worker.ts", import.meta.url), { type: "module" });
    let nextRequestId = 1;
    let pending: { requestId: number; resolve: (results: BatchTargetResult[]) => void; reject: (error: unknown) => void } | undefined;

    worker.onmessage = (event: MessageEvent<{ type: "tracked"; requestId: number; results: BatchTargetResult[] }>) => {
      if (pending && event.data.requestId === pending.requestId) {
        pending.resolve(event.data.results);
        pending = undefined;
      }
    };
    worker.onerror = (event) => {
      if (pending) {
        pending.reject(new Error(event.message || "Tracking worker error."));
        pending = undefined;
      }
    };

    return {
      track: (input) =>
        new Promise<BatchTargetResult[]>((resolve, reject) => {
          const requestId = nextRequestId;
          nextRequestId += 1;
          pending = { requestId, resolve, reject };
          // Transfer a COPY of the frame's grayscale (≈8MB at 1080p): the transfer list removes the
          // per-frame structured-clone on the receiving side, and copying first keeps the caller's
          // buffer intact for the trackOneInline fallback that reads `image` after a worker failure.
          // Templates persist across frames on the main thread — they stay structured-cloned.
          const grayCopy = input.currentGray.slice();
          worker.postMessage({
            type: "track",
            requestId,
            width: input.width,
            height: input.height,
            currentGray: grayCopy,
            targets: input.targets.map((target) => ({
              id: target.id,
              templateFull: target.templateFull,
              templateFullRadius: FULL_PATCH_RADIUS,
              templateHalf: target.templateHalf,
              templateHalfRadius: HALF_PATCH_RADIUS,
              predictedX: target.predicted.x,
              predictedY: target.predicted.y,
              searchRadiusFull: target.searchRadiusFull,
              searchRadiusHalf: target.searchRadiusHalf,
              usePyramid: target.usePyramid
            }))
          }, [grayCopy.buffer]);
        }),
      terminate: () => worker.terminate()
    };
  } catch {
    return undefined;
  }
}

function assertNotCancelled(isCancelled?: () => boolean) {
  if (isCancelled?.()) {
    throw new Error("Tracking cancelled.");
  }
}
