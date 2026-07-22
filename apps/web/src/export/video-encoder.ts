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

/**
 * Container color descriptor written into the MP4 `colr` / WebM `Colour` box. Defaults to Rec.709
 * SDR limited-range. We PREFER the encoder's own reported `colorSpace` (it truthfully matches the
 * RGB→YUV matrix/range the encoder actually used — overriding it would reintroduce the BT.601-vs-BT.709
 * mismatch the Remotion path had to disable parallel-encoding to avoid) and only fill fields the encoder
 * left unspecified with these defaults.
 */
export interface OutputColorSpace {
  primaries: VideoColorPrimaries;
  transfer: VideoTransferCharacteristics;
  matrix: VideoMatrixCoefficients;
  fullRange: boolean;
}

export const REC709_SDR_LIMITED: OutputColorSpace = {
  primaries: "bt709",
  transfer: "bt709",
  matrix: "bt709",
  fullRange: false
};

export interface MediaEncoderOptions {
  width: number;
  height: number;
  fps: number;
  format: ExportFormat;
  /** Video bitrate in bits/s. Defaults to a quality-scaled value from the resolution. */
  videoBitrate?: number;
  /** Rate control: "vbr" (variable, default) or "cbr" (constant). From the export window. */
  bitrateMode?: "vbr" | "cbr" | undefined;
  /** Fallback color descriptor for the container tag (default {@link REC709_SDR_LIMITED}). */
  outputColorSpace?: OutputColorSpace | undefined;
  /**
   * Keyframe cadence in seconds (default 2 — the export setting). The source-proxy transcoder
   * passes 1 to make ingest proxies keyframe-DENSE, so a playhead drop lands within ~15 delta
   * frames of a sync point instead of a multi-second decode catch-up on sparse-GOP camera files.
   */
  keyFrameIntervalSeconds?: number;
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

/**
 * Thrown by {@link MediaEncoder.addVideoFrame} after a wedged encoder was successfully reset:
 * frames past `resumeFrameIndex` were queued but never muxed. The caller re-renders and re-submits
 * from `resumeFrameIndex` (deterministic compositor → identical pixels), making the recovery
 * gapless — no held frame, no motion jump, no timestamp gap in the output file.
 */
export class EncoderStallRecoveredError extends Error {
  constructor(public readonly resumeFrameIndex: number) {
    super(`Video encoder wedged and was reset — re-render from frame ${resumeFrameIndex}`);
    this.name = "EncoderStallRecoveredError";
  }
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
  // Saved video config so a wedged encoder can be reset + reconfigured mid-export (see addVideoFrame).
  private readonly videoConfig: VideoEncoderConfig;
  private encoderStallRecoveries = 0;
  private forceKeyFrame = false;
  // Video chunks actually MUXED — after a stall recovery this is the exact frame index the caller
  // must re-render from, so the recovery is GAPLESS (no held frame, no motion jump) in the output.
  private muxedVideoChunks = 0;
  // Fallback color descriptor merged into the encoded-chunk metadata so the muxer writes a color box.
  private readonly outputColorSpace: OutputColorSpace;
  // The color descriptor actually written (encoder-reported values preserved, gaps filled) — surfaced
  // for export diagnostics. Null until the first chunk carrying a decoderConfig has been muxed.
  private colorSpaceApplied: VideoColorSpaceInit | null = null;

  constructor(opts: MediaEncoderOptions) {
    this.opts = opts;
    this.frameDurationUs = 1_000_000 / opts.fps;
    this.outputColorSpace = opts.outputColorSpace ?? REC709_SDR_LIMITED;

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
      output: (chunk, meta) => {
        this.muxedVideoChunks += 1;
        this.muxer.addVideoChunk(chunk, this.tagColorMetadata(meta));
      },
      error: (error) => {
        this.encoderError = error instanceof Error ? error : new Error(`Video encoder error: ${String(error)}`);
      },
    });
    this.videoConfig = {
      codec: opts.format === "mp4" ? avcCodec(opts.width, opts.height, opts.fps) : "vp09.00.40.08",
      width: opts.width,
      height: opts.height,
      bitrate: videoBitrate,
      // CBR holds a steadier bitrate (predictable file size / streaming); VBR (default) spends bits
      // where the picture needs them at the same average target. Only set when the user chose one.
      ...(opts.bitrateMode ? { bitrateMode: opts.bitrateMode === "cbr" ? ("constant" as const) : ("variable" as const) } : {}),
      framerate: opts.fps,
      // Keep HARDWARE encode (default) for full quality: SW H.264 encode in the browser is Baseline-profile
      // only, which would downgrade the output. The H.264 decode↔encode contention is resolved on the DECODER
      // side instead (software source decode is lossless — identical pixels — so quality is untouched).
      ...(opts.format === "mp4" ? { avc: { format: "avc" as const } } : {}),
    };
    this.videoEncoder.configure(this.videoConfig);

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

  /**
   * Ensure the muxer receives a `decoderConfig.colorSpace` so it writes the container color box
   * (MP4 `colr` / WebM `Colour`). Encoder-reported fields are AUTHORITATIVE (they match the pixels
   * the encoder produced) and preserved; only unspecified fields are filled from `outputColorSpace`.
   * When the encoder emits no `decoderConfig` (no color info to attach), the metadata passes through
   * untouched and `colorSpaceApplied` stays null → the export surfaces an `export-metadata-fallback`.
   */
  private tagColorMetadata(meta?: EncodedVideoChunkMetadata): EncodedVideoChunkMetadata | undefined {
    if (!meta?.decoderConfig) return meta;
    const reported = meta.decoderConfig.colorSpace;
    const merged: VideoColorSpaceInit = {
      primaries: reported?.primaries ?? this.outputColorSpace.primaries,
      transfer: reported?.transfer ?? this.outputColorSpace.transfer,
      matrix: reported?.matrix ?? this.outputColorSpace.matrix,
      fullRange: reported?.fullRange ?? this.outputColorSpace.fullRange
    };
    this.colorSpaceApplied = merged;
    return { ...meta, decoderConfig: { ...meta.decoderConfig, colorSpace: merged } };
  }

  /**
   * The color descriptor written into the container, or null if the encoder never emitted a
   * `decoderConfig` to attach one to (caller should warn: container color tag not guaranteed).
   */
  getAppliedColorSpace(): VideoColorSpaceInit | null {
    return this.colorSpaceApplied;
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
        // RECOVERY before giving up (2026-07-05 soak: "Export stalled: encodeFrame 9063/16690" killed a
        // 5-minute export at 54%): a long-export hardware encoder can wedge without ever firing its error
        // callback (GPU pressure, background-tab session loss). reset() discards the ≤9 wedged in-queue
        // frames, reconfigure gives us a fresh session, and the thrown EncoderStallRecoveredError tells
        // the caller the exact frame the mux actually reached — the export loop re-renders from there
        // (the compositor is deterministic), so the recovery is GAPLESS in the output. The next encoded
        // frame is a forced IDR so the resumed stream stays decodable. Bounded: a repeatedly wedging
        // encoder still surfaces the hard error.
        if (this.encoderStallRecoveries < 2 && this.videoEncoder.state === "configured") {
          this.encoderStallRecoveries += 1;
          try {
            this.videoEncoder.reset();
            this.videoEncoder.configure(this.videoConfig);
            this.forceKeyFrame = true;
          } catch (error) {
            throw new Error(`Video encoder stalled and could not be recovered: ${error instanceof Error ? error.message : String(error)}`);
          }
          console.warn(
            `[export] video encoder wedged at frame ${index + 1} → reset (recovery ${this.encoderStallRecoveries}/2), resuming render at frame ${this.muxedVideoChunks + 1}`
          );
          throw new EncoderStallRecoveredError(this.muxedVideoChunks);
        }
        throw new Error("Video encoder stalled during export (queue stopped draining). Try a lower export resolution.");
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    if (this.encoderError) throw this.encoderError;
    const frame = new VideoFrame(source, {
      timestamp: Math.round(index * this.frameDurationUs),
      duration: Math.round(this.frameDurationUs),
    });
    const keyFrame =
      this.forceKeyFrame || index % Math.max(1, Math.round(this.opts.fps * (this.opts.keyFrameIntervalSeconds ?? 2))) === 0;
    this.forceKeyFrame = false;
    this.videoEncoder.encode(frame, { keyFrame });
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
