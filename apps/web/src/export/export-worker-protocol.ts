/** Message protocol between the main thread and the export Worker. */

import type { ExportCoreInput } from "./export-core";

/** Main thread → Worker. */
export type ExportWorkerRequest =
  | { type: "start"; payload: ExportCoreInput }
  | { type: "abort" };

/** Worker → main thread. */
export type ExportWorkerResponse =
  | { type: "progress"; fraction: number; label: string }
  | { type: "done"; buffer: ArrayBuffer; mime: string }
  | { type: "error"; message: string; aborted: boolean };
