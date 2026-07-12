/**
 * Source color detection (Phase 3) — read a source file's signalled color space at ingest.
 *
 * Parses the MP4/MOV `colr` box (via mp4box) from the first video track's sample entry and maps the
 * ISO 23091-2 code points to our {@link SourceColorMetadata}. Runs at ingest/decode, OFF the render
 * loop, so it never costs preview/playback latency. Returns null when there's no video track, no
 * `colr` signalling, an unsupported container (e.g. WebM — mp4box won't parse it), or the file is too
 * large to probe — the caller then falls back to `ASSUMED_REC709_SOURCE_METADATA` ("Assumed Rec.709").
 */

import { createFile, type ColrBox, type MP4File, type MP4Info } from "mp4box";
import type { ColorMatrix, ColorPrimaries, ColorTransfer, SourceColorMetadata } from "@lumio-by-aelivion/shared";
import { normalizeSourceColorMetadata } from "@lumio-by-aelivion/shared";

// Cap probe memory: skip very large files (they'd need a full in-memory buffer for a tail `moov`).
const MAX_PROBE_BYTES = 300 * 1024 * 1024;
const READY_TIMEOUT_MS = 8000;

/** ISO 23091-2 colour primaries → our union. */
function mapPrimaries(code: number | undefined): ColorPrimaries {
  switch (code) {
    case 1:
      return "bt709";
    case 5:
    case 6:
    case 7:
      return "bt601";
    case 9:
      return "bt2020";
    case 11:
    case 12:
      return "display-p3";
    default:
      return "unknown";
  }
}

/** ISO 23091-2 transfer characteristics → our union (SDR gammas collapse to bt709). */
function mapTransfer(code: number | undefined): ColorTransfer {
  switch (code) {
    case 1:
    case 6:
    case 14:
    case 15:
      return "bt709"; // BT.709 / BT.601 / BT.2020 SDR gammas — all SDR power curves
    case 13:
      return "srgb";
    case 16:
      return "pq";
    case 18:
      return "hlg";
    default:
      return "unknown";
  }
}

/** ISO 23091-2 matrix coefficients → our union. */
function mapMatrix(code: number | undefined): ColorMatrix {
  switch (code) {
    case 0:
      return "rgb";
    case 1:
      return "bt709";
    case 5:
    case 6:
      return "bt601";
    case 9:
      return "bt2020-ncl";
    default:
      return "unknown";
  }
}

function colrToMetadata(colr: ColrBox): SourceColorMetadata | null {
  // Only nclx/nclc carry the numeric color codes; ICC-profile variants aren't mapped here.
  if (colr.colour_type !== "nclx" && colr.colour_type !== "nclc") return null;
  const transfer = mapTransfer(colr.transfer_characteristics);
  // HDR transfers imply ≥10-bit; surface that so `sourceColorWarnings` flags the HDR downcast.
  const bitDepth = transfer === "pq" || transfer === "hlg" ? 10 : 8;
  return normalizeSourceColorMetadata({
    primaries: mapPrimaries(colr.colour_primaries),
    transfer,
    matrix: mapMatrix(colr.matrix_coefficients),
    fullRange: colr.full_range_flag === 1,
    bitDepth,
    detectedFrom: "detected",
    confidence: "high"
  } satisfies Partial<SourceColorMetadata>);
}

function readColrFromInfo(file: MP4File, info: MP4Info): SourceColorMetadata | null {
  // The first video track's sample entry carries the `colr` box.
  const trackId = info.videoTracks?.[0]?.id;
  if (trackId == null) return null;
  const entry = file.getTrackById(trackId)?.mdia?.minf?.stbl?.stsd?.entries?.[0];
  const colr = entry?.colr;
  return colr ? colrToMetadata(colr) : null;
}

export type SourceRotation = 0 | 90 | 180 | 270;

/**
 * Derive the display rotation from a `tkhd` matrix. The matrix is [a,b,u, c,d,v, x,y,w] in 16.16
 * fixed-point (a,b,c,d) — rotation is `atan2(b, a)`. Snap to the nearest quarter-turn; anything else
 * (skew/flip) → 0 (we only correct clean 90° multiples).
 */
export function rotationFromMatrix(matrix: number[] | undefined): SourceRotation {
  if (!matrix || matrix.length < 2) return 0;
  const a = matrix[0]! / 65536;
  const b = matrix[1]! / 65536;
  if (Math.abs(a) < 1e-3 && Math.abs(b) < 1e-3) return 0;
  const deg = ((Math.round(Math.atan2(b, a) * (180 / Math.PI)) % 360) + 360) % 360;
  if (deg >= 45 && deg < 135) return 90;
  if (deg >= 135 && deg < 225) return 180;
  if (deg >= 225 && deg < 315) return 270;
  return 0;
}

function readRotationFromInfo(file: MP4File, info: MP4Info): SourceRotation {
  const trackId = info.videoTracks?.[0]?.id;
  if (trackId == null) return 0;
  try {
    return rotationFromMatrix(file.getTrackById(trackId)?.tkhd?.matrix);
  } catch {
    return 0;
  }
}

/**
 * Detect a source file's signalled color space. Resolves to the detected metadata, or null when it
 * can't be determined (caller assumes Rec.709). Never throws.
 */
export interface SourceProbeResult {
  color: SourceColorMetadata | null;
  rotationDegrees: SourceRotation;
}

/**
 * Detect a source file's signalled color space AND display rotation in ONE mp4box probe (off the
 * render loop). Resolves with `{ color, rotationDegrees }`; color is null and rotation is 0 when they
 * can't be determined (unsupported container, no signalling, too large, or a parse error). Never throws.
 */
export async function detectSourceMetadataFromFile(file: Blob): Promise<SourceProbeResult> {
  const empty: SourceProbeResult = { color: null, rotationDegrees: 0 };
  if (file.size > MAX_PROBE_BYTES) return empty;
  try {
    const buffer = (await file.arrayBuffer()) as ArrayBuffer & { fileStart: number };
    buffer.fileStart = 0;
    const mp4 = createFile();
    let result: SourceProbeResult = empty;
    let ready = false;
    mp4.onReady = (info) => {
      ready = true;
      try {
        result = { color: readColrFromInfo(mp4, info), rotationDegrees: readRotationFromInfo(mp4, info) };
      } catch {
        result = empty;
      }
    };
    mp4.onError = () => {
      ready = true;
    };
    mp4.appendBuffer(buffer);
    mp4.flush();
    // onReady fires synchronously from appendBuffer/flush once the moov is parsed; guard with a timeout
    // for pathological inputs so ingest never hangs on the probe.
    if (!ready) {
      await new Promise<void>((resolve) => {
        const start = Date.now();
        const tick = () => (ready || Date.now() - start > READY_TIMEOUT_MS ? resolve() : setTimeout(tick, 32));
        tick();
      });
    }
    return result;
  } catch {
    return empty;
  }
}

/** Back-compat: color-only probe (kept for existing callers). Prefer {@link detectSourceMetadataFromFile}. */
export async function detectSourceColorFromFile(file: Blob): Promise<SourceColorMetadata | null> {
  return (await detectSourceMetadataFromFile(file)).color;
}
