import type { SourceAsset } from "@lumio-by-aelivion/shared";

export const ASSET_AUDIO_TRUE_TAG = "lumio:audio=true";
export const ASSET_AUDIO_FALSE_TAG = "lumio:audio=false";

/** Whether an asset has a usable audio stream. `undefined` means unknown (not yet probed). */
export function assetHasAudioStream(asset: SourceAsset): boolean | undefined {
  if (asset.fileType.startsWith("audio/")) return true;
  if (!asset.fileType.startsWith("video/")) return false;
  if (asset.tags?.includes(ASSET_AUDIO_TRUE_TAG)) return true;
  if (asset.tags?.includes(ASSET_AUDIO_FALSE_TAG)) return false;
  return undefined;
}
