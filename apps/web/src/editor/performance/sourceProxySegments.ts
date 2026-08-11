/**
 * Source-proxy SEGMENT CACHE — the resume layer under an ingest-proxy build (2026-08-11, Slice 1 of
 * `plans/source-proxy-progressive.md`).
 *
 * WHAT THIS IS FOR. A proxy build is ~60s for a 145s clip. Today it is all-or-nothing: close the
 * tab at 80% and 100% of the work is discarded, because the muxer's `moov` is only written at
 * `finalize()` (see the plan's §2 — a truncated `fastStart:"in-memory"` MP4 is not a short file,
 * it is a non-file). This module persists the ENCODED CHUNKS as the build produces them, so the
 * next attempt can replay what already exists and encode only what is missing.
 *
 * WHY CHUNKS AND NOT N COMPLETE MP4s (a deliberate deviation from the plan's §2 "Option B", which
 * proposed one finalized MP4 per segment):
 *   - Option B needs one ENCODER per segment. Each encoder starts with fresh rate-control state, so
 *     the encoded bitstream necessarily differs from today's single continuous encode — segmenting
 *     would change the output of every build, including uninterrupted ones.
 *   - Tapping one continuous encoder instead keeps the bitstream EXACTLY as it is today for any
 *     build that runs to completion. Only a genuinely RESUMED build diverges, and only after the
 *     resume point, which is unavoidable in any design (encoder state cannot be persisted).
 *   - It also removes the N× `moov` overhead §4 flagged as Slice 1's main cost, since no segment
 *     carries a container at all.
 * The trade is that segments are not independently playable. Slice 3 wants playable coverage, and
 * gets it by muxing the covered prefix on demand — one file covering [0, coverage) rather than N
 * files to juggle, which is if anything simpler for routing than Option B would have been.
 *
 * FORMAT. One OPFS file per segment: a JSON header line (byte length prefixed), then the raw chunk
 * payloads back to back. Deliberately boring — this is a disposable cache keyed by the same
 * `sourceByteSize` + `SOURCE_PROXY_VERSION` guards the finished proxy uses, so a format that cannot
 * be read is simply a cache miss and a full rebuild, never a corrupt proxy.
 */

export interface SegmentChunkMeta {
  type: "key" | "delta";
  timestamp: number;
  duration: number | null;
  byteLength: number;
}

export interface SegmentHeader {
  /** Guards, mirroring SourceProxyRecord — a mismatch is a cache miss, never a reuse. */
  assetId: string;
  sourceByteSize: number;
  version: number;
  /** 0-based segment index; segments are fixed-length in FRAMES and strictly ordered. */
  segmentIndex: number;
  /** Inclusive first / exclusive last frame index this segment covers. */
  startFrame: number;
  endFrame: number;
  fps: number;
  width: number;
  height: number;
  /** avcC/decoder description from the encoder's first chunk, base64. Present on segment 0 only. */
  descriptionBase64?: string | undefined;
  codec?: string | undefined;
  chunks: SegmentChunkMeta[];
}

const TEXT = new TextEncoder();
const DECODER = new TextDecoder();

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

/** Serialize one segment: [4-byte header length][JSON header][chunk payloads...]. */
export function encodeSegment(header: SegmentHeader, payloads: Uint8Array[]): Blob {
  const headerBytes = TEXT.encode(JSON.stringify(header));
  const prefix = new Uint8Array(4);
  new DataView(prefix.buffer).setUint32(0, headerBytes.length, true);
  return new Blob([prefix, headerBytes, ...payloads.map((p) => p.slice())], { type: "application/octet-stream" });
}

/** Parse a segment file. Returns null on ANY inconsistency — the caller rebuilds instead. */
export async function decodeSegment(blob: Blob): Promise<{ header: SegmentHeader; payloads: Uint8Array[] } | null> {
  try {
    if (blob.size < 4) return null;
    const prefix = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
    const headerLength = new DataView(prefix.buffer).getUint32(0, true);
    if (!Number.isFinite(headerLength) || headerLength <= 0 || 4 + headerLength > blob.size) return null;
    const header = JSON.parse(DECODER.decode(await blob.slice(4, 4 + headerLength).arrayBuffer())) as SegmentHeader;
    if (!Array.isArray(header.chunks) || header.chunks.length === 0) return null;
    const total = header.chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    if (4 + headerLength + total !== blob.size) return null; // truncated write — treat as absent
    const body = new Uint8Array(await blob.slice(4 + headerLength).arrayBuffer());
    const payloads: Uint8Array[] = [];
    let offset = 0;
    for (const chunk of header.chunks) {
      payloads.push(body.subarray(offset, offset + chunk.byteLength));
      offset += chunk.byteLength;
    }
    return { header, payloads };
  } catch {
    return null;
  }
}

/** `AllowSharedBufferSource` (the spec type of `decoderConfig.description`) widens to
 *  SharedArrayBuffer, which `new Uint8Array(...)` will not take directly — normalize both shapes. */
export function descriptionToBase64(description: AllowSharedBufferSource | undefined): string | undefined {
  if (!description) return undefined;
  const view = ArrayBuffer.isView(description)
    ? new Uint8Array(description.buffer as ArrayBuffer, description.byteOffset, description.byteLength)
    : new Uint8Array(description as ArrayBuffer);
  return toBase64(view);
}

export function descriptionFromBase64(value: string | undefined): Uint8Array | undefined {
  return value ? fromBase64(value) : undefined;
}

/** Rebuild the EncodedVideoChunks of a parsed segment, in presentation order. */
export function segmentToChunks(header: SegmentHeader, payloads: Uint8Array[]): EncodedVideoChunk[] {
  return header.chunks.map((meta, index) => {
    const data = payloads[index]!;
    return new EncodedVideoChunk({
      type: meta.type,
      timestamp: meta.timestamp,
      ...(meta.duration !== null ? { duration: meta.duration } : {}),
      // Copy: EncodedVideoChunk does not take ownership of a subarray view's parent buffer.
      data: data.slice(),
    });
  });
}
