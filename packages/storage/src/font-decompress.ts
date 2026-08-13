/**
 * ADR-023 S3 — WOFF2 → SFNT, **server-side only, and that placement is the finding.**
 *
 * This started life in `@orreris/shared` beside the rest of the ingest, which is where it reads as
 * belonging. It does not belong there, for a reason that only shows up when something tries to build:
 * the only available decoder is a ~300KB emscripten module that takes a Node branch (`require("fs")`)
 * and, in `shared`, is pulled into every bundle importing the ingest. Vite's copy hung at runtime;
 * Remotion's webpack refused outright with `Can't resolve 'path'` — **which broke the render bundle**,
 * caught by `font:ref-falsifier` rather than by a typecheck.
 *
 * So it lives in the package that is server-only by construction. The editor never calls it: a
 * `.woff2` upload is a round trip (see `user-fonts.ts`), while `.ttf`, `.otf` and `.woff` are ingested
 * entirely on-device — opentype.js inflates WOFF natively, measured against a real one.
 */
import { FontIngestError } from "@orreris/shared";

let woff2Promise: Promise<{ decompress(input: Uint8Array): Promise<Uint8Array> }> | undefined;
async function getWoff2(): Promise<{ decompress(input: Uint8Array): Promise<Uint8Array> }> {
  if (!woff2Promise) {
    // Lazy for the same reason `opentype.js` is, and more so: only a WOFF2 upload ever needs it.
    woff2Promise = import("wawoff2").then(
      (mod) => ((mod as unknown as { default?: unknown }).default ?? mod) as { decompress(input: Uint8Array): Promise<Uint8Array> }
    );
  }
  return woff2Promise;
}

function isWoff2(bytes: ArrayBuffer): boolean {
  const head = new Uint8Array(bytes, 0, Math.min(4, bytes.byteLength));
  return head.length === 4 && head[0] === 0x77 && head[1] === 0x4f && head[2] === 0x46 && head[3] === 0x32;
}

/**
 * Decompress a WOFF2 into the SFNT the rest of the pipeline can read, or return the bytes untouched.
 *
 * **This is a conversion, and the consequence is worth stating plainly: the `fileHash` stored is the
 * hash of the DECOMPRESSED file, not of what the user handed us.** That is the right way round. D1
 * makes the hash the render identity — the thing the worker resolves to bytes and installs — so it
 * has to name bytes that can actually be parsed, installed and rasterized. Hashing the upload would
 * pin an identity nothing downstream could use, and would make the same face uploaded as `.woff2`
 * and as `.ttf` into two different fonts to a system whose whole point is that they are one.
 */
export async function decompressFontIfNeeded(bytes: ArrayBuffer): Promise<ArrayBuffer> {
  if (!isWoff2(bytes)) return bytes;
  let out: Uint8Array;
  try {
    out = await (await getWoff2()).decompress(new Uint8Array(bytes));
  } catch (error) {
    // The typed code stays exactly what S2.2 defined. What changed is that it now means "this WOFF2
    // could not be decompressed" rather than "WOFF2 is not supported" — a much rarer answer, and one
    // a user meets only with a genuinely broken file.
    throw new FontIngestError(
      "woff2-unsupported",
      `That WOFF2 font could not be decompressed: ${(error as Error)?.message ?? "unknown error"}.`
    );
  }
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
}
