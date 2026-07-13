/**
 * Local export Worker (Phase L3).
 *
 * Runs the full composite → encode → mux pipeline off the main thread so the editor UI stays
 * responsive during export. Receives pre-resolved source URLs + pre-mixed audio PCM, fetches
 * and decodes media itself (WebCodecs/mp4box + createImageBitmap all work in a Worker), and
 * transfers the finished container buffer back. If WebCodecs can't handle a source there's no
 * <video> fallback in here, so it reports an error and the main thread re-runs the export.
 */

import { configureFontResolver, warpFontFile } from "@kimera-by-aelivion/shared";
import { Aborted, runExportCore } from "./export-core";
import type { ExportWorkerRequest, ExportWorkerResponse } from "./export-worker-protocol";

// Mirror the main thread's warp-font resolver so vector text-warp still rasterizes in here.
configureFontResolver((family, weight) => `/${warpFontFile(family, weight)}`);

interface WorkerScope {
  postMessage(message: ExportWorkerResponse, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent<ExportWorkerRequest>) => void) | null;
}
const scope = self as unknown as WorkerScope;

let aborted = false;
const signal = {
  get aborted() {
    return aborted;
  },
};

scope.onmessage = (event) => {
  const message = event.data;
  if (message.type === "abort") {
    aborted = true;
    return;
  }
  if (message.type !== "start") return;

  void (async () => {
    try {
      const blob = await runExportCore(message.payload, {
        signal,
        onProgress: (fraction, label) => scope.postMessage({ type: "progress", fraction, label }),
      });
      const buffer = await blob.arrayBuffer();
      scope.postMessage({ type: "done", buffer, mime: blob.type }, [buffer]);
    } catch (error) {
      scope.postMessage({
        type: "error",
        message: error instanceof Error ? error.message : "Local export failed",
        aborted: aborted || error instanceof Aborted,
      });
    }
  })();
};
