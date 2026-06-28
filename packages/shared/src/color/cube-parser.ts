/**
 * Professional Color System (Phase 3, 13C.4) — .cube LUT parser.
 *
 * Parses the Adobe/Resolve standard `.cube` LUT text format into a `Lut3d` that
 * the existing WebGL / CPU pipeline can consume directly. The result slots into a
 * `ColorStage.lut3d` field and is baked into the final 3D LUT by `bakePipelineToLut3d`.
 *
 * Spec summary:
 *   LUT_3D_SIZE <N>       — grid dimension (N³ entries)
 *   LUT_1D_SIZE <N>       — 1-D LUT (we reject these; 3D only)
 *   DOMAIN_MIN / DOMAIN_MAX — clamp/remap (we normalise to 0..1)
 *   Data lines: R G B (floats, one per line, R-fastest order)
 */

import type { Lut3d } from "./lut3d";

export interface CubeParseError {
  ok: false;
  error: string;
}
export interface CubeParseOk {
  ok: true;
  lut: Lut3d;
  title?: string;
}
export type CubeParseResult = CubeParseOk | CubeParseError;

/**
 * Parse a `.cube` file string into a `Lut3d`.
 * Returns `{ ok: false, error }` on any format / range error.
 */
export function parseCubeFile(text: string): CubeParseResult {
  let size = 0;
  let title: string | undefined;
  let domainMin: [number, number, number] = [0, 0, 0];
  let domainMax: [number, number, number] = [1, 1, 1];
  const dataLines: string[] = [];
  let inData = false;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;

    if (!inData) {
      if (line.startsWith("LUT_1D_SIZE")) {
        return { ok: false, error: "1-D LUTs are not supported — import a 3-D .cube file." };
      }
      if (line.startsWith("LUT_3D_SIZE")) {
        const n = parseInt(line.split(/\s+/)[1] ?? "", 10);
        if (!n || n < 2 || n > 65) {
          return { ok: false, error: `Invalid LUT_3D_SIZE: ${line}` };
        }
        size = n;
        continue;
      }
      if (line.startsWith("TITLE")) {
        title = line.replace(/^TITLE\s+/, "").replace(/^"|"$/g, "").trim();
        continue;
      }
      if (line.startsWith("DOMAIN_MIN")) {
        const parts = line.split(/\s+/).slice(1).map(Number);
        if (parts.length >= 3) domainMin = [parts[0]!, parts[1]!, parts[2]!];
        continue;
      }
      if (line.startsWith("DOMAIN_MAX")) {
        const parts = line.split(/\s+/).slice(1).map(Number);
        if (parts.length >= 3) domainMax = [parts[0]!, parts[1]!, parts[2]!];
        continue;
      }
      // First line that looks like a data triplet → start data section
      if (/^[-\d]/.test(line)) {
        inData = true;
        dataLines.push(line);
      }
    } else {
      dataLines.push(line);
    }
  }

  if (size === 0) return { ok: false, error: "Missing LUT_3D_SIZE declaration." };
  const expected = size * size * size;
  if (dataLines.length < expected) {
    return { ok: false, error: `Expected ${expected} data entries, got ${dataLines.length}.` };
  }

  const data = new Float32Array(expected * 3);
  const [rMin, gMin, bMin] = domainMin;
  const [rMax, gMax, bMax] = domainMax;
  const rRange = (rMax! - rMin!) || 1;
  const gRange = (gMax! - gMin!) || 1;
  const bRange = (bMax! - bMin!) || 1;

  for (let i = 0; i < expected; i++) {
    const parts = dataLines[i]!.split(/\s+/);
    const r = (parseFloat(parts[0]!) - rMin!) / rRange;
    const g = (parseFloat(parts[1]!) - gMin!) / gRange;
    const b = (parseFloat(parts[2]!) - bMin!) / bRange;
    if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) {
      return { ok: false, error: `Non-numeric data at entry ${i}.` };
    }
    data[i * 3] = Math.max(0, Math.min(1, r));
    data[i * 3 + 1] = Math.max(0, Math.min(1, g));
    data[i * 3 + 2] = Math.max(0, Math.min(1, b));
  }

  const result: CubeParseOk = { ok: true, lut: { size, data } };
  if (title) result.title = title;
  return result;
}

/**
 * Serialise a `Lut3d` to a compact base64 string for storage in effect params.
 * Format: `<size>:<base64-float32>` (little-endian, RGBA interleaved per node).
 */
export function lut3dToBase64(lut: Lut3d): string {
  const header = `${lut.size}:`;
  const bytes = new Uint8Array(lut.data.buffer, lut.data.byteOffset, lut.data.byteLength);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) {
    bin += String.fromCharCode(bytes[i]!);
  }
  return header + btoa(bin);
}

/**
 * Deserialise a base64 string (from `lut3dToBase64`) back to a `Lut3d`.
 * Returns null on any parse / decode error.
 */
export function lut3dFromBase64(encoded: string): Lut3d | null {
  try {
    const colon = encoded.indexOf(":");
    if (colon < 1) return null;
    const size = parseInt(encoded.slice(0, colon), 10);
    if (!size || size < 2 || size > 65) return null;
    const bin = atob(encoded.slice(colon + 1));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) {
      bytes[i] = bin.charCodeAt(i);
    }
    const expected = size * size * size * 3;
    const data = new Float32Array(bytes.buffer);
    if (data.length !== expected) return null;
    return { size, data };
  } catch {
    return null;
  }
}
