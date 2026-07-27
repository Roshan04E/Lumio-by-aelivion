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
  /**
   * Keyframe cadence in FRAMES, not seconds. The worker converts to `intervalSeconds = N / fps` once it
   * knows the final encode fps — so the GOP is a fixed frame count at ANY source fps (30/60/120). A
   * fixed-SECONDS GOP made catch-up decode scale with fps (a 1s GOP = 60 frames at 60fps to grind), which
   * froze high-fps proxy playback in the WebCodecs preview pool. Frames-based keeps catch-up cost flat.
   */
  keyFrameEveryNFrames: number;
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
  | {
      /** Build progress (throttled ~every 30 frames) — feeds the editor's live "optimizing media" UI. */
      type: "progress";
      encodedFrames: number;
      totalFrames: number;
    }
  | {
      type: "done";
      buffer: ArrayBuffer;
      mime: string;
      encodedFrames: number;
      fps: number;
      /** True decodable end from the source's sample table (see FrameProvider.decodableEndSeconds); undefined on the <video> fallback. */
      decodableEndSeconds?: number | undefined;
    }
  | { type: "error"; message: string; aborted: boolean };
