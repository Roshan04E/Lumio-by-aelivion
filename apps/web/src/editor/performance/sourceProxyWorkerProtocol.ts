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
   * RESUME (2026-08-11, Slice 1). Segment length in FRAMES. The worker replays every cached segment
   * into the muxer without re-encoding and encodes only the frames no segment covers.
   *
   * `segmentFrames` MUST be a multiple of `keyFrameEveryNFrames`, so every segment boundary — and
   * therefore every possible resume point — is a keyframe. The engine enforces this; the worker
   * asserts it rather than trusting it, because a non-keyframe splice produces a proxy that plays
   * and then breaks up, which is exactly the corruption class this file's frozen-tail guard exists
   * to prevent.
   */
  segmentFrames: number;
  /**
   * Segments already on disk, in any order and with any gaps (Slice 2 made the cache sparse — see
   * `playheadSeconds`). The engine has already checked each one's guards; the worker re-parses and
   * re-checks contiguity of the FRAME RANGE it claims, then encodes only the indices that are
   * missing. Empty for a full build.
   */
  resumeSegments: Array<{ index: number; buffer: ArrayBuffer }>;
  /**
   * PLAYHEAD-FIRST BUILD ORDER (2026-08-11, Slice 2). Where the user is parked, in SOURCE seconds
   * (the engine maps timeline time through the placed clip's speed/sourceIn). The worker builds the
   * segment containing this point first, then forward to the end, then wraps to the head.
   *
   * Null — no clip placed at the playhead, no resolver registered — means build from 0, i.e. exactly
   * the order every build used before this existed.
   *
   * Forward-then-wrap rather than strictly alternating outward: a proxy exists because its SOURCE is
   * expensive to seek, so each backward jump costs a full GOP grind on the original. Forward-wrap
   * pays that once; alternating outward would pay it once per segment.
   */
  playheadSeconds: number | null;
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
