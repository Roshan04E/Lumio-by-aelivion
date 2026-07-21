/**
 * Pure sizing helpers for Notes cards (plans/notes-sonnet-execution-3.md Q1) — kept decoupled from
 * `SourceAsset` (plain kind + optional natural dimensions) so they're testable here in shared
 * without pulling the UI-layer asset type in. The UI resolves an asset's kind/width/height and
 * calls these; the generic 260×160 stays only as the type-level default elsewhere.
 */

export type NoteAssetKind = "video" | "image" | "audio" | "file";

export interface NoteCardSize {
  w: number;
  h: number;
}

const AUDIO_SIZE: NoteCardSize = { w: 300, h: 96 };
const FILE_SIZE: NoteCardSize = { w: 240, h: 72 };
const VIDEO_FALLBACK: NoteCardSize = { w: 280, h: 158 };
const IMAGE_FALLBACK: NoteCardSize = { w: 260, h: 180 };
const IMAGE_MAX_W = 320;
const IMAGE_MAX_H = 320;
const IMAGE_MIN_W = 160;

/**
 * Per-kind default card size at creation time. Audio is short+wide (a waveform strip, not a
 * portrait box); video/image derive real aspect from the asset's natural dimensions when known
 * (image additionally clamped to a sane on-board footprint); file/doc is a compact row.
 */
export function defaultSizeForAsset(kind: NoteAssetKind, width?: number, height?: number): NoteCardSize {
  if (kind === "audio") return AUDIO_SIZE;
  if (kind === "file") return FILE_SIZE;
  if (kind === "video") {
    if (width && height && width > 0 && height > 0) {
      const w = VIDEO_FALLBACK.w;
      return { w, h: Math.round(w * (height / width)) };
    }
    return VIDEO_FALLBACK;
  }
  // image
  if (width && height && width > 0 && height > 0) {
    const shrink = Math.min(IMAGE_MAX_W / width, IMAGE_MAX_H / height, 1);
    let w = width * shrink;
    let h = height * shrink;
    if (w < IMAGE_MIN_W) {
      const grow = IMAGE_MIN_W / w;
      w *= grow;
      h *= grow;
    }
    return { w: Math.round(w), h: Math.round(h) };
  }
  return IMAGE_FALLBACK;
}
