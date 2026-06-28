import { downsampleGrayHalf, nccToConfidence, prepareTemplate, searchNcc, type GrayImage } from "./tracking-core";

/**
 * Dedicated worker that runs the per-frame NCC point search for
 * local-tracking.ts off the main thread, so a long tracking run doesn't
 * freeze the editor UI. Cast `self` instead of using a `webworker` lib
 * reference, since this project's tsconfig shares a single DOM-lib config
 * across apps/web and a `webworker` triple-slash reference here would
 * collide with that (Window vs WorkerGlobalScope `self` redeclaration).
 */

interface TrackWorkerTargetRequest {
  id: string;
  /** Anchor template patch at full resolution (raw, not yet zero-meaned). */
  templateFull: Float32Array;
  templateFullRadius: number;
  /** Anchor template patch at half resolution, used for the coarse pyramid pass. */
  templateHalf: Float32Array;
  templateHalfRadius: number;
  predictedX: number;
  predictedY: number;
  searchRadiusFull: number;
  searchRadiusHalf: number;
  usePyramid: boolean;
}

interface TrackWorkerTargetResult {
  id: string;
  x: number;
  y: number;
  confidence: number;
}

interface TrackWorkerRequest {
  type: "track";
  requestId: number;
  width: number;
  height: number;
  currentGray: Float32Array;
  targets: TrackWorkerTargetRequest[];
}

interface TrackWorkerResponse {
  type: "tracked";
  requestId: number;
  results: TrackWorkerTargetResult[];
}

type WorkerSelf = {
  onmessage: ((event: MessageEvent<TrackWorkerRequest>) => void) | null;
  postMessage: (message: TrackWorkerResponse) => void;
};

const workerSelf = self as unknown as WorkerSelf;

workerSelf.onmessage = (event) => {
  const { requestId, width, height, currentGray, targets } = event.data;
  const image: GrayImage = { data: currentGray, width, height };
  const needsHalf = targets.some((target) => target.usePyramid);
  const halfImage = needsHalf ? downsampleGrayHalf(image) : undefined;

  const results: TrackWorkerTargetResult[] = targets.map((target) => {
    let centerX = target.predictedX;
    let centerY = target.predictedY;

    if (target.usePyramid && halfImage) {
      const halfTemplate = prepareTemplate(target.templateHalf, target.templateHalfRadius);
      const coarse = searchNcc(halfTemplate, halfImage, centerX / 2, centerY / 2, target.searchRadiusHalf);
      centerX = coarse.x * 2;
      centerY = coarse.y * 2;
    }

    const fullTemplate = prepareTemplate(target.templateFull, target.templateFullRadius);
    const refined = searchNcc(fullTemplate, image, centerX, centerY, target.searchRadiusFull);

    return { id: target.id, x: refined.x, y: refined.y, confidence: nccToConfidence(refined.score) };
  });

  workerSelf.postMessage({ type: "tracked", requestId, results });
};

export {};
