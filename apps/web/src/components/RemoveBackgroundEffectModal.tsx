import { useMemo } from "react";
import type { SourceAsset, TimelineComposition, ToolCapabilityDefinition } from "@orreris/shared";
import { RemoveBackgroundToolPanel } from "../pages/RemoveBackgroundToolPanel";
import { Modal } from "./Modal";

/**
 * The full-workspace version of Remove Background, opened from the editor's Effects tab instead
 * of the generic ToolEffectRunnerModal popup — this tool wants quality tiers, a recolourable plate,
 * mask reuse and a live composited preview, which a run/progress popup can't host. Reuses the exact
 * same workspace as the standalone /tools page (RemoveBackgroundToolPanel in compact mode) so the
 * two stay in lockstep; the only difference is the clip is preselected (the layer's own asset) and
 * Apply merges into the live editor composition instead of creating a new project.
 */
export function RemoveBackgroundEffectModal({
  tool,
  asset,
  composition,
  editableFields,
  onApplied,
  onClose
}: {
  tool: ToolCapabilityDefinition;
  asset: SourceAsset;
  composition: TimelineComposition;
  editableFields?: Record<string, unknown> | undefined;
  onApplied: (nextComposition: TimelineComposition, editableFieldsPatch?: Record<string, unknown>) => void;
  onClose: () => void;
}) {
  const assets = useMemo(() => [asset], [asset]);

  return (
    <Modal title={tool.name} open className="modal-workspace" onClose={onClose}>
      <RemoveBackgroundToolPanel
        tool={tool}
        assets={assets}
        selectedAssetId={asset.id}
        onSelectAsset={() => undefined}
        onUploadAsset={() => undefined}
        preselectedAsset={asset}
        liveComposition={composition}
        editableFields={editableFields}
        onApplyToComposition={onApplied}
        compact
      />
    </Modal>
  );
}
