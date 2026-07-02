import { useEffect, useMemo, useState } from "react";
import { Cloud, CloudUpload, Download, Film, Layers, Music, Plus, Trash2 } from "lucide-react";
import type { SourceAsset, StockResult, StockVariant } from "@lumio-by-aelivion/shared";
import { Modal } from "./Modal";
import { ThemedSelect, type ThemedSelectGroup } from "../editor/inspector/controls/ThemedSelect";

type AssetAddMode = "auto" | "video" | "audio" | "both";

export type AssetViewerTarget =
  | { kind: "asset"; asset: SourceAsset }
  | { kind: "stock"; result: StockResult };

type ViewerKind = "video" | "image" | "audio" | "graphic";

function assetViewerKind(fileType: string): ViewerKind {
  if (fileType.startsWith("image/")) return fileType.includes("svg") ? "graphic" : "image";
  if (fileType.startsWith("audio/")) return "audio";
  return "video";
}

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
}

function formatBytes(bytes?: number): string | null {
  if (!bytes || bytes <= 0) return null;
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

const SOURCE_LABEL: Record<string, string> = {
  local: "Local",
  ai: "AI",
  pexels: "Pexels",
  pixabay: "Pixabay",
  unsplash: "Unsplash",
  "timeline-generated": "Generated",
  brand: "Brand"
};

/**
 * Focused single-asset viewer. Library assets play from our own storage; stock results stream
 * straight from the provider and offer a quality picker (exact resolutions) before import.
 */
export function AssetViewerModal({
  target,
  importing = false,
  onClose,
  onAddToTimeline,
  onImport,
  onUploadToCloud,
  onDelete
}: {
  target: AssetViewerTarget | null;
  importing?: boolean;
  onClose: () => void;
  onAddToTimeline?: ((asset: SourceAsset, mode?: AssetAddMode) => void) | undefined;
  onImport?: ((result: StockResult, variant?: StockVariant) => void) | undefined;
  onUploadToCloud?: ((asset: SourceAsset) => void) | undefined;
  onDelete?: ((asset: SourceAsset) => void) | undefined;
}) {
  const variants = target?.kind === "stock" ? target.result.variants ?? [] : [];
  const [variantIdx, setVariantIdx] = useState("0");

  // Reset the chosen quality whenever a new stock result opens.
  useEffect(() => {
    setVariantIdx("0");
  }, [target?.kind === "stock" ? target.result.externalId : target?.kind === "asset" ? target.asset.id : null]);

  const qualityGroups = useMemo<ThemedSelectGroup<string>[]>(
    () => [
      {
        label: "Quality",
        options: variants.map((variant, index) => ({
          value: String(index),
          label: variant.width && variant.height ? `${variant.label} · ${variant.width}×${variant.height}` : variant.label
        }))
      }
    ],
    [variants]
  );

  if (!target) return null;

  const isStock = target.kind === "stock";
  const kind: ViewerKind = isStock ? (target.result.type === "video" ? "video" : "image") : assetViewerKind(target.asset.fileType);

  const title = isStock ? target.result.author ?? (target.result.provider === "pexels" ? "Pexels" : "Pixabay") : target.asset.originalName ?? target.asset.fileName;
  const source = isStock ? target.result.provider : target.asset.source ?? "local";
  const width = isStock ? target.result.width : target.asset.width;
  const height = isStock ? target.result.height : target.asset.height;
  const durationSeconds = isStock ? target.result.durationSeconds : target.asset.durationSeconds;
  const fileType = isStock ? (target.result.type === "video" ? "video/mp4" : "image/jpeg") : target.asset.fileType;

  const reduce = prefersReducedMotion();

  function renderStage() {
    if (isStock) {
      const result = target!.kind === "stock" ? target!.result : null!;
      if (result.type === "video") {
        return (
          <video
            className="asset-viewer-media"
            src={result.previewUrl ?? result.downloadUrl}
            poster={result.thumbnailUrl}
            controls
            loop
            muted
            playsInline
            autoPlay={!reduce}
          />
        );
      }
      return <img className="asset-viewer-media" src={result.downloadUrl || result.thumbnailUrl} alt={title} />;
    }

    const asset = target!.kind === "asset" ? target!.asset : null!;
    if (kind === "audio") {
      return (
        <div className="asset-viewer-audio">
          <Music size={42} />
          <audio src={asset.fileUrl} controls autoPlay={false} />
        </div>
      );
    }
    if (kind === "image" || kind === "graphic") {
      return <img className={`asset-viewer-media ${kind === "graphic" ? "is-graphic" : ""}`} src={asset.thumbnailUrl ?? asset.fileUrl} alt={title} />;
    }
    return (
      <video
        className="asset-viewer-media"
        src={asset.proxyUrl ?? asset.previewUrl ?? asset.fileUrl}
        poster={asset.thumbnailUrl}
        controls
        loop
        muted
        playsInline
        autoPlay={!reduce}
      />
    );
  }

  const metaParts: string[] = [];
  if (width && height) metaParts.push(`${width}×${height}`);
  if ((kind === "video" || kind === "audio") && durationSeconds) metaParts.push(`${Math.round(durationSeconds)}s`);
  if (!isStock) {
    const size = formatBytes(target.asset.sizeBytes);
    if (size) metaParts.push(size);
  }
  if (fileType) metaParts.push(fileType);

  const isLocalOnly =
    target.kind === "asset" && (target.asset.fileUrl.startsWith("localblob:") || (!target.asset.cloudUrl && target.asset.id.startsWith("asset_local_")));

  return (
    <Modal title={title} open className="asset-viewer-modal" onClose={onClose}>
      <div className="asset-viewer-stage">{renderStage()}</div>

      <div className="asset-viewer-info">
        <span className={`asset-badge asset-badge-source asset-badge-${source}`}>{SOURCE_LABEL[source] ?? source}</span>
        {metaParts.length ? <span className="asset-viewer-meta">{metaParts.join("  ·  ")}</span> : null}
        {isStock && target.result.author ? <span className="asset-viewer-meta">By {target.result.author}</span> : null}
      </div>

      <div className="asset-viewer-actions">
        {isStock ? (
          <>
            {variants.length ? (
              <label className="asset-viewer-quality">
                <span>Quality</span>
                <ThemedSelect ariaLabel="Import quality" value={variantIdx} groups={qualityGroups} onChange={setVariantIdx} />
              </label>
            ) : null}
            <button
              type="button"
              className="asset-viewer-primary"
              disabled={importing}
              onClick={() => onImport?.(target.result, variants[Number(variantIdx)] ?? variants[0])}
            >
              <Download size={15} /> {importing ? "Importing…" : "Import to library"}
            </button>
          </>
        ) : (
          <>
            {kind === "video" ? (
              <>
                <button type="button" className="asset-viewer-primary" onClick={() => { onAddToTimeline?.(target.asset, "both"); onClose(); }}>
                  <Layers size={15} /> Add video + audio
                </button>
                <button type="button" onClick={() => { onAddToTimeline?.(target.asset, "video"); onClose(); }}>
                  <Film size={15} /> Video only
                </button>
                <button type="button" onClick={() => { onAddToTimeline?.(target.asset, "audio"); onClose(); }}>
                  <Music size={15} /> Audio only
                </button>
              </>
            ) : (
              <button type="button" className="asset-viewer-primary" onClick={() => { onAddToTimeline?.(target.asset, "auto"); onClose(); }}>
                <Plus size={15} /> Add to timeline
              </button>
            )}
            <span className="asset-viewer-actions-spacer" />
            {onUploadToCloud && isLocalOnly ? (
              <button type="button" title="Upload to cloud" onClick={() => onUploadToCloud(target.asset)}>
                <CloudUpload size={15} /> Upload to cloud
              </button>
            ) : target.asset.cloudUrl ? (
              <span className="asset-viewer-note">
                <Cloud size={14} /> In cloud
              </span>
            ) : null}
            {onDelete ? (
              <button type="button" className="is-danger" onClick={() => { onDelete(target.asset); onClose(); }}>
                <Trash2 size={15} /> Delete
              </button>
            ) : null}
          </>
        )}
      </div>
    </Modal>
  );
}
