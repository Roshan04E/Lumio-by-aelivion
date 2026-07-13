import type { SourceAsset, ToolCapabilityDefinition } from "@kimera-by-aelivion/shared";

export function isCompatibleToolAsset(tool: ToolCapabilityDefinition, asset: SourceAsset) {
  if (tool.accepts.includes("video") && asset.fileType.startsWith("video/")) {
    return true;
  }
  if (tool.accepts.includes("audio") && asset.fileType.startsWith("audio/")) {
    return true;
  }
  if (tool.accepts.includes("image") && asset.fileType.startsWith("image/")) {
    return true;
  }
  return false;
}

export function resolveToolMediaUrl(fileUrl: string) {
  if (/^(blob:|data:|https?:\/\/)/.test(fileUrl)) {
    return fileUrl;
  }
  if (fileUrl.startsWith("/storage/")) {
    const apiOrigin = new URL(import.meta.env.VITE_API_URL ?? "http://localhost:4100/api").origin;
    return `${apiOrigin}${fileUrl}`;
  }
  return fileUrl;
}
