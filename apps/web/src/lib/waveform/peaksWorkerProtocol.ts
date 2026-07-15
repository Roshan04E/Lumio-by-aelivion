/** Message protocol between the main thread and the waveform-peaks Worker. */

/** Main thread → Worker. */
export type PeaksWorkerRequest = { type: "start"; url: string } | { type: "abort" };

/** One LOD level's envelopes (max/min/rms), as transferable buffers. */
export type PeaksLevelData = { max: ArrayBuffer; min: ArrayBuffer; rms: ArrayBuffer };

/** Worker → main thread. */
export type PeaksWorkerResponse =
  | { type: "done"; duration: number; levels: PeaksLevelData[] }
  | { type: "error"; message: string };
