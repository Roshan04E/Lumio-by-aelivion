/**
 * Flarex MediaIn source control (FLAREX.md Phase 2, Fusion Loader model). A trigger showing the
 * current source (thumbnail + name, or "Host clip") that, when clicked, puts the REAL media pool into
 * "pick one" mode — the exact flow the user knows from the timeline's "Replace asset" (click a tile in
 * the pool, not a separate dropdown). A small "×" reverts to the host clip. No embedded asset list —
 * the media pool IS the list, so it always reflects what's actually in the pool (no stale/internal
 * artifacts leaking in, which the old self-listed popover suffered from).
 */

export interface FlarexSourceAssetOption {
  id: string;
  name: string;
  thumbnailUrl?: string | undefined;
  type?: "video" | "image" | undefined;
}

export interface FlarexSourcePickerProps {
  /** Current sourceAssetId ("" = the host clip). */
  value: string;
  /** Media-pool assets — used only to resolve the current selection's thumbnail/name. */
  assets: FlarexSourceAssetOption[];
  /** Open the media pool in pick-one mode (omit to disable, e.g. host has no pool wiring). */
  onOpenPicker?: (() => void) | undefined;
  /** Revert to the host clip. */
  onClear: () => void;
  /** Open the Source Viewer (proxy vs original A/B) for the current asset. */
  onInspect?: ((assetId: string) => void) | undefined;
}

export function FlarexSourcePicker({ value, assets, onOpenPicker, onClear, onInspect }: FlarexSourcePickerProps) {
  const current = value ? assets.find((a) => a.id === value) : null;
  const label = value ? current?.name ?? `(missing: ${value})` : "Host clip";

  return (
    <div className="flarex-source-row">
      <button
        type="button"
        className="flarex-source-trigger"
        title={onOpenPicker ? `${label} — click to pick from the media pool` : label}
        disabled={!onOpenPicker}
        onClick={() => onOpenPicker?.()}
      >
        {current?.thumbnailUrl ? (
          <img className="flarex-source-thumb" src={current.thumbnailUrl} alt="" />
        ) : (
          <span className="flarex-source-thumb flarex-source-thumb--host" aria-hidden />
        )}
        <span className="flarex-source-name">{label}</span>
        {value && current?.type === "video" ? <span className="flarex-source-badge">VID</span> : null}
      </button>
      {value && onInspect ? (
        <button
          type="button"
          className="flarex-source-clear"
          title="Inspect source — play proxy vs original"
          aria-label="Inspect source"
          onClick={() => onInspect(value)}
        >
          ⧉
        </button>
      ) : null}
      {value ? (
        <button type="button" className="flarex-source-clear" title="Revert to host clip" aria-label="Revert to host clip" onClick={onClear}>
          ×
        </button>
      ) : null}
    </div>
  );
}
