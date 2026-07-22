import { useMemo } from "react";
import type { SourceAsset, TimelineComposition, TimelineLayer, ToolCapabilityDefinition } from "@orreris/shared";
import { TextBehindPersonToolPanel } from "../pages/TextBehindPersonToolPanel";
import { Modal } from "./Modal";

/**
 * The full-workspace version of Text Behind Person, opened from the editor's Effects tab instead of
 * the generic run popup — it wants text/colour/size/position/font, a quality tier, mask reuse, source
 * range and a live composite preview. Reuses the standalone /tools panel (compact) so the two stay in
 * lockstep; the clip is preselected and Apply merges into the live composition.
 */
export function TextBehindPersonEffectModal({
  tool,
  asset,
  layer,
  composition,
  editableFields,
  onApplied,
  onClose
}: {
  tool: ToolCapabilityDefinition;
  asset: SourceAsset;
  layer?: TimelineLayer | undefined;
  composition: TimelineComposition;
  editableFields?: Record<string, unknown> | undefined;
  onApplied: (nextComposition: TimelineComposition, editableFieldsPatch?: Record<string, unknown>) => void;
  onClose: () => void;
}) {
  const assets = useMemo(() => [asset], [asset]);
  const clipRange = useMemo(() => {
    if (!layer) {
      return undefined;
    }
    const speed = layer.speed && layer.speed > 0 ? layer.speed : 1;
    return { sourceInSeconds: layer.sourceInSeconds ?? 0, usedDurationSeconds: layer.durationSeconds * speed };
  }, [layer]);

  return (
    <Modal title={tool.name} open className="modal-workspace" onClose={onClose}>
      <TextBehindPersonToolPanel
        tool={tool}
        assets={assets}
        selectedAssetId={asset.id}
        onSelectAsset={() => undefined}
        onUploadAsset={() => undefined}
        preselectedAsset={asset}
        liveComposition={composition}
        editableFields={editableFields}
        {...(clipRange ? { clipRange } : {})}
        onApplyToComposition={onApplied}
        compact
      />
    </Modal>
  );
}
