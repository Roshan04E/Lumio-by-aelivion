/**
 * Local export — WebCodecs encoder + container muxer.
 *
 * Wraps a `VideoEncoder` (+ optional `AudioEncoder`) and a pluggable muxer so the same
 * orchestrator can emit either MP4 (H.264 + AAC, the universally-playable default) or
 * WebM (VP9 + Opus, the smaller/modern option). Frames are pushed one at a time with
 * encoder-queue backpressure so long timelines stay memory-flat.
 */

import { ArrayBufferTarget as Mp4Target, Muxer as Mp4Muxer } from "mp4-muxer";
import { ArrayBufferTarget as WebmTarget, Muxer as WebmMuxer } from "webm-muxer";

export type ExportFormat = "mp4" | "webm";

export interface MediaEncoderOptions {
  width: number;
  height: number;
  fps: number;
  format: ExportFormat;
  /** Video bitrate in bits/s. Defaults to a quality-scaled value from the resolution. */
  videoBitrate?: number;
  /** Present when the timeline has audio. */
  audio?: { sampleRate: number; channels: number } | undefined;
}

interface CommonMuxer {
  addVideoChunk(chunk: EncodedVideoChunk, meta?: EncodedVideoChunkMetadata): void;
  addAudioChunk(chunk: EncodedAudioChunk, meta?: EncodedAudioChunkMetadata): void;
  finalize(): void;
}

function defaultBitrate(width: number, height: number, fps: number): number {
  // ~0.12 bits per pixel·frame — solid quality without bloating files; clamped to a sane range.
  const bpp = 0.12;
  const raw = width * height * fps * bpp;
  return Math.round(Math.min(40_000_000, Math.max(2_000_000, raw)));
}

/**
 * Pick an H.264 codec string whose level covers BOTH the frame's macroblock rate (MaxMBPS) and its
 * macroblock count (MaxFS). Keying off MaxMBPS alone is a bug: at a lower fps the mb/s drops and selects a
 * level whose *frame-size* cap is too small for the resolution (e.g. 1080×1920 @24fps → level 3.2, MaxFS 5120
 * < 8160 → the encoder rejects the frame). We pick the smallest level satisfying both limits.
 */
function avcCodec(width: number, height: number, fps: number): string {
  const mbW = Math.ceil(width / 16);
  const mbH = Math.ceil(height / 16);
  const mbPerFrame = mbW * mbH;
  const mbPerSec = mbPerFrame * fps;
  // [MaxMBPS, MaxFS (macroblocks), hex level_idc] — H.264 Annex A levels (High profile).
  const levels: Array<[number, number, string]> = [
    [40500, 1620, "1e"], // 3.0
    [108000, 3600, "1f"], // 3.1
    [216000, 5120, "20"], // 3.2
    [245760, 8192, "28"], // 4.0
    [245760, 8192, "29"], // 4.1
    [522240, 8704, "2a"], // 4.2
    [589824, 22080, "32"], // 5.0
    [983040, 36864, "33"], // 5.1
    [2073600, 36864, "34"], // 5.2
    [4177920, 139264, "3c"], // 6.0
    [8355840, 139264, "3d"], // 6.1
    [16711680, 139264, "3e"], // 6.2
  ];
  const level = levels.find(([maxMbps, maxFs]) => mbPerSec <= maxMbps && mbPerFrame <= maxFs)?.[2] ?? "3e";
  return `avc1.6400${level}`; // High profile
}

export class MediaEncoder {
  private readonly opts: MediaEncoderOptions;
  private readonly muxer: CommonMuxer;
  private readonly target: Mp4Target | WebmTarget;
  private readonly videoEncoder: VideoEncoder;
  private audioEncoder: AudioEncoder | null = null;
  private readonly frameDurationUs: number;
  // A WebCodecs encoder reports failures through its async `error` callback, NOT by rejecting any
  // promise we await. If we just `throw` in that callback, the error vanishes into the event loop and
  // the backpressure wait below spins forever — the export silently "stops". So we latch the error and
  // surface it from the encode/finalize calls, turning a hang into a clean failure (which then lets the
  // worker→main-thread fallback retry).
  private encoderError: Error | null = null;

  constructor(opts: MediaEncoderOptions) {
    this.opts = opts;
    this.frameDurationUs = 1_000_000 / opts.fps;

    const videoBitrate = opts.videoBitrate ?? defaultBitrate(opts.width, opts.height, opts.fps);

    if (opts.format === "mp4") {
      const target = new Mp4Target();
      this.target = target;
      this.muxer = new Mp4Muxer({
        target,
        fastStart: "in-memory",
        video: { codec: "avc", width: opts.width, height: opts.height },
        ...(opts.audio
          ? { audio: { codec: "aac", numberOfChannels: opts.audio.channels, sampleRate: opts.audio.sampleRate } }
          : {}),
      }) as unknown as CommonMuxer;
    } else {
      const target = new WebmTarget();
      this.target = target;
      this.muxer = new WebmMuxer({
        target,
        video: { codec: "V_VP9", width: opts.width, height: opts.height, frameRate: opts.fps },
        ...(opts.audio
          ? { audio: { codec: "A_OPUS", numberOfChannels: opts.audio.channels, sampleRate: opts.audio.sampleRate } }
          : {}),
      }) as unknown as CommonMuxer;
    }

    this.videoEncoder = new VideoEncoder({
      output: (chunk, meta) => this.muxer.addVideoChunk(chunk, meta),
      error: (error) => {
        this.encoderError = error instanceof Error ? error : new Error(`Video encoder error: ${String(error)}`);
      },
    });
    this.videoEncoder.configure({
      codec: opts.format === "mp4" ? avcCodec(opts.width, opts.height, opts.fps) : "vp09.00.40.08",
      width: opts.width,
      height: opts.height,
      bitrate: videoBitrate,
      framerate: opts.fps,
      // Keep HARDWARE encode (default) for full quality: SW H.264 encode in the browser is Baseline-profile
      // only, which would downgrade the output. The H.264 decode↔encode contention is resolved on the DECODER
      // side instead (software source decode is lossless — identical pixels — so quality is untouched).
      ...(opts.format === "mp4" ? { avc: { format: "avc" as const } } : {}),
    });

    if (opts.audio) {
      this.audioEncoder = new AudioEncoder({
        output: (chunk, meta) => this.muxer.addAudioChunk(chunk, meta),
        error: (error) => {
          this.encoderError = error instanceof Error ? error : new Error(`Audio encoder error: ${String(error)}`);
        },
      });
      this.audioEncoder.configure({
        codec: opts.format === "mp4" ? "mp4a.40.2" : "opus",
        numberOfChannels: opts.audio.channels,
        sampleRate: opts.audio.sampleRate,
        bitrate: 192_000,
      });
    }
  }

  /** Encode one composited frame. `index` is the 0-based frame number. */
  async addVideoFrame(source: CanvasImageSource, index: number): Promise<void> {
    // Backpressure: don't let the encoder queue grow unbounded on long exports. Bail out the instant the
    // encoder errors or closes, so a failed encoder surfaces a clear error instead of an infinite wait.
    // Watchdog: a healthy encoder drains the queue in milliseconds; if it stops draining entirely for
    // STALL_MS (e.g. GPU-memory pressure with no error event), throw rather than spin forever — the
    // export then surfaces an error / the worker falls back to the main thread instead of hanging.
    const STALL_MS = 30_000;
    const waitStart = Date.now();
    while (this.videoEncoder.encodeQueueSize > 8) {
      if (this.encoderError) throw this.encoderError;
      if (this.videoEncoder.state === "closed") throw new Error("Video encoder closed unexpectedly during export.");
      if (Date.now() - waitStart > STALL_MS) {
        throw new Error("Video encoder stalled during export (queue stopped draining). Try a lower export resolution.");
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    if (this.encoderError) throw this.encoderError;
    const frame = new VideoFrame(source, {
      timestamp: Math.round(index * this.frameDurationUs),
      duration: Math.round(this.frameDurationUs),
    });
    this.videoEncoder.encode(frame, { keyFrame: index % Math.max(1, Math.round(this.opts.fps * 2)) === 0 });
    frame.close();
  }

  /** Encode the full mixed-down audio (one AudioData per buffer). */
  encodeAudio(data: AudioData): void {
    this.audioEncoder?.encode(data);
    data.close();
  }

  /** Tear down the encoders WITHOUT muxing a file — used to abandon a partial/aborted encode. */
  dispose(): void {
    try {
      if (this.videoEncoder.state !== "closed") {
        this.videoEncoder.close();
      }
    } catch {
      // ignore
    }
    try {
      if (this.audioEncoder && this.audioEncoder.state !== "closed") {
        this.audioEncoder.close();
      }
    } catch {
      // ignore
    }
  }

  async finalize(): Promise<Blob> {
    if (this.encoderError) throw this.encoderError;
    await this.videoEncoder.flush();
    this.videoEncoder.close();
    if (this.audioEncoder) {
      await this.audioEncoder.flush();
      this.audioEncoder.close();
    }
    if (this.encoderError) throw this.encoderError;
    this.muxer.finalize();
    const buffer = (this.target as { buffer: ArrayBuffer }).buffer;
    return new Blob([buffer], { type: this.opts.format === "mp4" ? "video/mp4" : "video/webm" });
  }
}
