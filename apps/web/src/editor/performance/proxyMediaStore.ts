/**
 * Preview proxy media — encode, persist, and read back rendered timeline spans.
 *
 * The adaptive cache planner ([renderCache.ts]) decides WHICH timeline ranges are worth caching and
 * tracks GPU-render coverage. This module turns a covered span into real, playable media: it feeds the
 * frames the preview GPU already rendered into a per-span WebCodecs encoder ([MediaEncoder]), seals the
 * result into a compressed `Blob`, and persists it (OPFS-backed with an in-memory fallback, mirroring
 * [tools/artifact-store.ts]). A pooled reader decodes ready spans so replay/seek can draw from proxy
 * media instead of re-running the live draw list.
 *
 * Feasibility: raw frames don't scale (1080p RGBA ≈ 8.3 MB/frame → 5 min ≈ 75 GB). Compressed 540p proxy
 * is ~1.5 Mbps → 5 min ≈ 56 MB, so we ALWAYS encode; the only in-memory raw data is the small bounded
 * decode cache for the active window.
 *
 * No new WebGL context is created here — frames arrive from the single existing preview compositor.
 */

import { MediaEncoder, type ExportFormat } from "../../export/video-encoder";
import { detectBrowserToolCapabilities } from "../../tools/capabilities";

/** WebCodecs `VideoEncoder` + a canvas we can snapshot are the hard requirements. */
export function isProxyMediaSupported(): boolean {
  if (typeof VideoFrame === "undefined" || typeof VideoEncoder === "undefined") {
    return false;
  }
  try {
    return detectBrowserToolCapabilities().webCodecs;
  } catch {
    return false;
  }
}

// WebM/VP9 is the smaller, seek-friendly proxy container; MP4/H.264 is the compatibility fallback.
const PROXY_FORMAT: ExportFormat = "webm";
// Proxy quality is deliberately low: proxies exist for playback fluidity, not fidelity.
const PROXY_BITRATE = 1_500_000;

// ---------------------------------------------------------------------------
// Blob store (OPFS with in-memory fallback) — keyed by span id.
// ---------------------------------------------------------------------------

export interface ProxyBlobStore {
  kind: "opfs" | "memory";
  put: (id: string, blob: Blob) => Promise<void>;
  /** Object URL for a stored blob (or undefined if absent). Caller owns revocation via `release`. */
  getObjectUrl: (id: string) => Promise<string | undefined>;
  release: (id: string) => void;
  remove: (id: string) => Promise<void>;
  clear: () => Promise<void>;
}

const PROXY_DIR = "lumio-preview-proxies";

export async function createProxyBlobStore(): Promise<ProxyBlobStore> {
  const storage = navigator.storage as
    | (StorageManager & { getDirectory?: () => Promise<FileSystemDirectoryHandle> })
    | undefined;
  if (storage?.getDirectory) {
    try {
      const root = await storage.getDirectory();
      const directory = await root.getDirectoryHandle(PROXY_DIR, { create: true });
      return createOpfsBlobStore(directory);
    } catch {
      // fall through to memory
    }
  }
  return createMemoryBlobStore();
}

function fileName(id: string): string {
  // Span ids contain `:` and `/`-unsafe chars; encode to a flat filename.
  return `${encodeURIComponent(id)}.webm`;
}

function createMemoryBlobStore(): ProxyBlobStore {
  const blobs = new Map<string, Blob>();
  const urls = new Map<string, string>();
  const revoke = (id: string): void => {
    const url = urls.get(id);
    if (url) {
      URL.revokeObjectURL(url);
      urls.delete(id);
    }
  };
  return {
    kind: "memory",
    async put(id, blob) {
      revoke(id);
      blobs.set(id, blob);
    },
    async getObjectUrl(id) {
      const existing = urls.get(id);
      if (existing) {
        return existing;
      }
      const blob = blobs.get(id);
      if (!blob) {
        return undefined;
      }
      const url = URL.createObjectURL(blob);
      urls.set(id, url);
      return url;
    },
    release(id) {
      revoke(id);
    },
    async remove(id) {
      revoke(id);
      blobs.delete(id);
    },
    async clear() {
      for (const id of [...urls.keys()]) {
        revoke(id);
      }
      blobs.clear();
    }
  };
}

function createOpfsBlobStore(directory: FileSystemDirectoryHandle): ProxyBlobStore {
  const known = new Set<string>();
  const urls = new Map<string, string>();
  const revoke = (id: string): void => {
    const url = urls.get(id);
    if (url) {
      URL.revokeObjectURL(url);
      urls.delete(id);
    }
  };
  return {
    kind: "opfs",
    async put(id, blob) {
      revoke(id);
      const handle = await directory.getFileHandle(fileName(id), { create: true });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      known.add(id);
    },
    async getObjectUrl(id) {
      const existing = urls.get(id);
      if (existing) {
        return existing;
      }
      try {
        const handle = await directory.getFileHandle(fileName(id));
        const file = await handle.getFile();
        const url = URL.createObjectURL(file);
        urls.set(id, url);
        known.add(id);
        return url;
      } catch {
        return undefined;
      }
    },
    release(id) {
      revoke(id);
    },
    async remove(id) {
      revoke(id);
      known.delete(id);
      await directory.removeEntry(fileName(id)).catch(() => undefined);
    },
    async clear() {
      for (const id of [...urls.keys()]) {
        revoke(id);
      }
      for (const id of [...known]) {
        await directory.removeEntry(fileName(id)).catch(() => undefined);
      }
      known.clear();
    }
  };
}

// ---------------------------------------------------------------------------
// Per-span encoder session — feeds live GPU frames into one span's proxy.
// ---------------------------------------------------------------------------

export interface ProxySpanEncoderOptions {
  width: number;
  height: number;
  fps: number;
  /** Timeline seconds at which this span's proxy begins (frame index 0). */
  startSeconds: number;
  /** Total frames the span needs before it is considered complete. */
  totalFrames: number;
}

/**
 * Encodes one span. Frames are captured synchronously from the preview canvas (a cheap `VideoFrame`
 * snapshot) and drained into the encoder asynchronously with backpressure. Frames must arrive in
 * non-decreasing span-frame-index order (forward playback); a backward jump aborts the session so a
 * corrupt/gappy proxy is never sealed — the span simply stays pending and is retried on the next pass.
 */
export class ProxySpanEncoder {
  readonly startSeconds: number;
  private readonly fps: number;
  private readonly totalFrames: number;
  private readonly encoder: MediaEncoder;
  private readonly queue: Array<{ frame: VideoFrame; index: number }> = [];
  private draining = false;
  private encodedFrames = 0;
  private lastIndex = -1;
  private aborted = false;
  private finalizing = false;
  private readonly maxQueue = 4;

  constructor(options: ProxySpanEncoderOptions) {
    this.startSeconds = options.startSeconds;
    this.fps = Math.max(1, options.fps);
    this.totalFrames = Math.max(1, Math.round(options.totalFrames));
    this.encoder = new MediaEncoder({
      width: Math.max(2, Math.round(options.width)),
      height: Math.max(2, Math.round(options.height)),
      fps: this.fps,
      format: PROXY_FORMAT,
      videoBitrate: PROXY_BITRATE
    });
  }

  get isAborted(): boolean {
    return this.aborted;
  }

  /** Span-frame index for a timeline time, or -1 if the time is before the span start. */
  frameIndexForTime(timeSeconds: number): number {
    if (timeSeconds < this.startSeconds - 1 / (this.fps * 2)) {
      return -1;
    }
    return Math.max(0, Math.round((timeSeconds - this.startSeconds) * this.fps));
  }

  /**
   * Snapshot the current canvas for `timeSeconds`. Returns false (and aborts) on an out-of-order frame.
   * A dropped duplicate index (same frame re-rendered) is a no-op success.
   */
  capture(canvas: CanvasImageSource, timeSeconds: number): boolean {
    if (this.aborted || this.finalizing) {
      return false;
    }
    const index = this.frameIndexForTime(timeSeconds);
    if (index < 0 || index === this.lastIndex) {
      return !this.aborted;
    }
    if (index < this.lastIndex) {
      this.abort();
      return false;
    }
    this.lastIndex = index;
    if (this.queue.length >= this.maxQueue) {
      // Behind on encode — drop this frame's snapshot; timestamps stay monotonic, players hold the
      // previous frame across the gap. Proxy fluidity degrades gracefully rather than stalling playback.
      return true;
    }
    let frame: VideoFrame;
    try {
      frame = new VideoFrame(canvas, { timestamp: Math.round((index * 1_000_000) / this.fps) });
    } catch {
      return true; // transient capture failure — skip this frame, keep going
    }
    this.queue.push({ frame, index });
    void this.drain();
    return true;
  }

  private async drain(): Promise<void> {
    if (this.draining) {
      return;
    }
    this.draining = true;
    try {
      while (this.queue.length > 0) {
        const next = this.queue.shift();
        if (!next) {
          break;
        }
        if (this.aborted) {
          next.frame.close();
          continue;
        }
        try {
          await this.encoder.addVideoFrame(next.frame, next.index);
          this.encodedFrames += 1;
        } catch {
          this.abort();
        } finally {
          next.frame.close();
        }
      }
    } finally {
      this.draining = false;
    }
  }

  /** True once enough contiguous frames have arrived to represent the whole span. */
  get isComplete(): boolean {
    // lastIndex is 0-based; the span needs frames [0, totalFrames).
    return !this.aborted && this.lastIndex >= this.totalFrames - 1;
  }

  abort(): void {
    if (this.aborted) {
      return;
    }
    this.aborted = true;
    for (const item of this.queue.splice(0)) {
      item.frame.close();
    }
    try {
      this.encoder.dispose?.();
    } catch {
      // ignore
    }
  }

  /** Drain remaining frames and produce the sealed proxy blob. Throws if aborted or empty. */
  async finalize(): Promise<{ blob: Blob; encodedFrames: number }> {
    if (this.aborted) {
      throw new Error("proxy span encoder aborted");
    }
    this.finalizing = true;
    await this.drain();
    if (this.encodedFrames === 0) {
      throw new Error("proxy span encoder produced no frames");
    }
    const blob = await this.encoder.finalize();
    return { blob, encodedFrames: this.encodedFrames };
  }
}

// ---------------------------------------------------------------------------
// Reader — pooled decode of ready spans for playback substitution.
// ---------------------------------------------------------------------------

export interface ProxyFrameReader {
  /**
   * Draw the proxy frame for `timeSeconds` (with `spanStartSeconds` mapping into the span-local clock)
   * to `target`. Returns true on a confident hit; false means the caller should render live this frame.
   */
  draw: (input: { url: string; spanStartSeconds: number; timeSeconds: number; target: CanvasRenderingContext2D; width: number; height: number }) => boolean;
  dispose: () => void;
}

/**
 * A tiny pool of `<video>` elements keyed by proxy URL. Each element is kept seeked near the playhead;
 * during forward playback the element simply plays, so `currentTime` tracks and we blit the current
 * frame with zero decode work on the main thread. On a large seek we nudge `currentTime` and let the
 * next frames land — until then we report a miss so the live path fills in seamlessly.
 */
export function createProxyFrameReader(poolSize = 2): ProxyFrameReader {
  const pool = new Map<string, HTMLVideoElement>();
  const order: string[] = [];

  const acquire = (url: string): HTMLVideoElement => {
    const existing = pool.get(url);
    if (existing) {
      return existing;
    }
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    video.src = url;
    void video.play().catch(() => undefined);
    pool.set(url, video);
    order.push(url);
    while (order.length > poolSize) {
      const evictUrl = order.shift();
      if (evictUrl && evictUrl !== url) {
        const stale = pool.get(evictUrl);
        stale?.pause();
        stale?.removeAttribute("src");
        pool.delete(evictUrl);
      }
    }
    return video;
  };

  return {
    draw({ url, spanStartSeconds, timeSeconds, target, width, height }) {
      const video = acquire(url);
      if (video.readyState < 2 || video.videoWidth === 0) {
        return false; // not decodable yet — render live
      }
      const spanLocal = Math.max(0, timeSeconds - spanStartSeconds);
      // If the element has drifted from the playhead, nudge it and skip this frame.
      if (Math.abs(video.currentTime - spanLocal) > 0.25) {
        try {
          video.currentTime = spanLocal;
        } catch {
          return false;
        }
        return false;
      }
      try {
        target.drawImage(video, 0, 0, width, height);
        return true;
      } catch {
        return false;
      }
    },
    dispose() {
      for (const video of pool.values()) {
        video.pause();
        video.removeAttribute("src");
      }
      pool.clear();
      order.length = 0;
    }
  };
}
