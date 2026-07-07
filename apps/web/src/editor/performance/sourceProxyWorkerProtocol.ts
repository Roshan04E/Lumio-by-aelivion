/**
 * Message contract between sourceProxyEngine.ts (main thread) and sourceProxy.worker.ts.
 *
 * The main thread keeps everything that NEEDS the DOM or Web Audio: queue/fingerprint/OPFS
 * bookkeeping, the <video> metadata probe, and the OfflineAudioContext PCM pre-decode. The worker
 * does the heavy part — WebCodecs software decode → OffscreenCanvas downscale → H.264+AAC encode —
 * so a build in flight can never hold the editor's main thread.
 *
 * `sourceUrl` may be a main-thread `blob:` object URL: dedicated workers on the same origin can
 * fetch those (the export worker already relies on this for every local export source).
 */

export interface SourceProxyWorkerPayload {
  sourceUrl: string;
  width: number;
  height: number;
  durationSeconds: number;
  /** Cap for the proxy frame rate; the worker samples at min(cap, source nominal fps). */
  maxFps: number;
  keyFrameIntervalSeconds: number;
  bitsPerPixelFrame: number;
  /** Pre-decoded PCM (planes transferred). Null = video-only proxy. */
  audio: { sampleRate: number; channels: number; frames: number; planes: ArrayBuffer[] } | null;
  /** Initial suspension state so a build queued mid-playback parks before its first frame. */
  suspended: boolean;
}

export type SourceProxyWorkerRequest =
  | { type: "start"; payload: SourceProxyWorkerPayload }
  | { type: "abort" }
  | { type: "suspend"; suspended: boolean };

export type SourceProxyWorkerResponse =
  | { type: "done"; buffer: ArrayBuffer; mime: string; encodedFrames: number; fps: number }
  | { type: "error"; message: string; aborted: boolean };
