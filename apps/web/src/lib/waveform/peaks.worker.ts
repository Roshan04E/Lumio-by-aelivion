/**
 * Waveform-peaks Worker. Fetches + decodes an audio/video asset and builds its full LOD peak
 * pyramid off the main thread, so a big source's decode + bucket loop never jank the editor.
 * `audioPeaks.ts` falls back to a main-thread decode if this worker is unavailable, crashes, or
 * `OfflineAudioContext` isn't supported in a Worker context (e.g. Safari/Firefox at time of
 * writing) — this file must never be the only path to a waveform.
 */

import { bufferToPeaks, buildPyramid, hiresBucketCount } from "./peakDsp";
import type { PeaksWorkerRequest, PeaksWorkerResponse, PeaksLevelData } from "./peaksWorkerProtocol";

interface WorkerScope {
  postMessage(message: PeaksWorkerResponse, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent<PeaksWorkerRequest>) => void) | null;
}
const scope = self as unknown as WorkerScope;

let aborted = false;

scope.onmessage = (event) => {
  const message = event.data;
  if (message.type === "abort") {
    aborted = true;
    return;
  }
  if (message.type !== "start") return;

  void (async () => {
    try {
      const OfflineCtor = (self as unknown as { OfflineAudioContext?: typeof OfflineAudioContext }).OfflineAudioContext;
      if (!OfflineCtor) {
        scope.postMessage({ type: "error", message: "no-offline-audio-context" });
        return;
      }
      // no-store: Chromium can't range-cache the dev server's /storage media responses and
      // throws ERR_CACHE_OPERATION_NOT_SUPPORTED when asked to (same fix as the export decoders).
      const res = await fetch(message.url, { cache: "no-store" });
      const data = await res.arrayBuffer();
      if (aborted) return;
      // A throwaway OfflineAudioContext is only used for its decodeAudioData — we never render it.
      const octx = new OfflineCtor(1, 1, 44100);
      const buffer = await octx.decodeAudioData(data);
      if (aborted) return;
      const base = bufferToPeaks(buffer, hiresBucketCount(buffer.duration));
      const levels = buildPyramid(base);
      if (aborted) return;
      const payload: PeaksLevelData[] = levels.map((level) => ({
        max: level.max.buffer as ArrayBuffer,
        min: level.min.buffer as ArrayBuffer,
        rms: level.rms.buffer as ArrayBuffer
      }));
      const transfer = payload.flatMap((level) => [level.max, level.min, level.rms]);
      scope.postMessage({ type: "done", duration: buffer.duration, levels: payload }, transfer);
    } catch (error) {
      scope.postMessage({ type: "error", message: error instanceof Error ? error.message : String(error) });
    }
  })();
};
