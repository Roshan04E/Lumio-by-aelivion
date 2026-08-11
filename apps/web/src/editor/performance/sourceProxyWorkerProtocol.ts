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
  /** Identity + guards stamped into each cached segment so a stale prefix can never be reused. */
  assetId: string;
  sourceByteSize: number;
  recipeVersion: number;
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
  /**
   * RESUME (2026-08-11, Slice 1). Segment length in FRAMES, and the already-persisted prefix the
   * engine resolved from the segment cache. The worker replays `resumePrefix` into the muxer
   * without re-encoding, then encodes live from `resumeFromFrame` onward.
   *
   * `segmentFrames` MUST be a multiple of `keyFrameEveryNFrames`, so every segment boundary — and
   * therefore every possible resume point — is a keyframe. The engine enforces this; the worker
   * asserts it rather than trusting it, because a non-keyframe splice produces a proxy that plays
   * and then breaks up, which is exactly the corruption class this file's frozen-tail guard exists
   * to prevent.
   */
  segmentFrames: number;
  /** Frame index to start LIVE encoding at (0 = full build). Always a multiple of segmentFrames. */
  resumeFromFrame: number;
  /** Serialized segment files covering [0, resumeFromFrame), in order. Empty for a full build. */
  resumePrefix: ArrayBuffer[];
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
      /** One completed segment of the resume cache, emitted as soon as its frames are encoded.
       *  NOT terminal — the build continues. The engine persists it and keeps listening. */
      type: "segment";
      segmentIndex: number;
      buffer: ArrayBuffer;
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
