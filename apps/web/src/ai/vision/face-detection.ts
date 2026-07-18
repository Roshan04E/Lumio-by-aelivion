/**
 * Lazy MediaPipe BlazeFace detector — the browser-ML loader pattern for world observers
 * (mirrors `local-transcription.ts`: lazy dynamic import, cached singleton promise, graceful
 * null on any failure so callers DECLINE instead of guessing — precision-first).
 *
 * Model: BlazeFace short-range (~200KB float16) + the tasks-vision wasm runtime, both fetched
 * on first use and HTTP-cached by the browser. GPU delegate first (WebGL2), CPU fallback.
 * A failed init clears the cache so a later query retries (transient network ≠ permanent no).
 */

import type { FaceDetector } from "@mediapipe/tasks-vision";

const TASKS_VISION_VERSION = "0.10.35"; // keep in lockstep with package.json — the wasm must match the JS
const WASM_ROOT = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${TASKS_VISION_VERSION}/wasm`;
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite";

let detectorPromise: Promise<FaceDetector | null> | null = null;

export function getFaceDetector(): Promise<FaceDetector | null> {
  if (!detectorPromise) {
    detectorPromise = createDetector().then((detector) => {
      if (!detector) {
        detectorPromise = null; // failed init must not poison the session — retry next ask
      }
      return detector;
    });
  }
  return detectorPromise;
}

async function createDetector(): Promise<FaceDetector | null> {
  if (typeof document === "undefined" || typeof WebAssembly === "undefined") {
    return null;
  }
  try {
    const { FaceDetector: Detector, FilesetResolver } = await import("@mediapipe/tasks-vision");
    const fileset = await FilesetResolver.forVisionTasks(WASM_ROOT);
    for (const delegate of ["GPU", "CPU"] as const) {
      try {
        return await Detector.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: MODEL_URL, delegate },
          runningMode: "IMAGE",
          minDetectionConfidence: 0.5
        });
      } catch {
        // GPU delegate unavailable (no WebGL2) — fall through to CPU.
      }
    }
    return null;
  } catch {
    return null; // offline / CDN blocked — the observer declines, the model tiers take over
  }
}

/** Test/reset seam. */
export function __resetFaceDetectorForTests(): void {
  detectorPromise = null;
}
