import { useMemo } from "react";
import type { SourceAsset, TimelineComposition, ToolCapabilityDefinition } from "@lumio-by-aelivion/shared";
import type { SavedTrack } from "../lib/trackLibrary";
import { SmartFollowTextToolPanel } from "../pages/SmartFollowTextToolPanel";
import { Modal } from "./Modal";

/**
 * The large "full workspace" version of Smart 3D Follow Text, opened from the editor's
 * Effects tab instead of the generic ToolEffectRunnerModal popup - this tool needs
 * re-track/add-tracker/auto-select/smoothing/live preview, which a simple run/progress
 * popup can't host. Reuses the exact same workspace as the standalone /tools page
 * (SmartFollowTextToolPanel in compact mode) so the two stay in lockstep; the only
 * difference is the clip is preselected (the layer's own asset) and Apply merges
 * straight into the live editor composition instead of creating a new project.
 */
export function SmartFollowTextEffectModal({
  tool,
  asset,
  composition,
  onApplied,
  onClose
}: {
  tool: ToolCapabilityDefinition;
  asset: SourceAsset;
  composition: TimelineComposition;
  /**
   * `savedTracks` holds every tracked target so the caller can merge them into the
   * project's `editableFields.trackLibrary` - that's what lets the same tracked motion
   * later be attached to a different layer (including ones added after this Apply) via
   * the editor's existing "Attach track" control, with no re-tracking.
   */
  onApplied: (nextComposition: TimelineComposition, savedTracks: SavedTrack[]) => void;
  onClose: () => void;
}) {
  const assets = useMemo(() => [asset], [asset]);

  return (
    <Modal title={tool.name} open className="modal-workspace" onClose={onClose}>
      <SmartFollowTextToolPanel
        tool={tool}
        assets={assets}
        selectedAssetId={asset.id}
        onSelectAsset={() => undefined}
        onUploadAsset={() => undefined}
        preselectedAsset={asset}
        liveComposition={composition}
        onApplyToComposition={(nextComposition, _primaryTrackingPath, savedTracks) => onApplied(nextComposition, savedTracks)}
        compact
      />
    </Modal>
  );
}
