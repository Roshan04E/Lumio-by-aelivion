/**
 * ADR-023 S3 — `wawoff2` ships no types. Only the one function this repo uses is declared, rather
 * than a speculative surface: the compressor is deliberately absent, because nothing here creates
 * WOFF2 and a declaration would invite something to start.
 */
declare module "wawoff2" {
  export function decompress(input: Uint8Array): Promise<Uint8Array>;
}
