import { useMemo } from "react";
import { getToolCapability } from "@reelforge/shared";
import type { SourceAsset, TimelineComposition } from "@reelforge/shared";
import type { SavedTrack } from "../lib/trackLibrary";
import { SmartFollowTextToolPanel } from "../pages/SmartFollowTextToolPanel";
import { Modal } from "./Modal";

/**
 * The editor's standalone "Track a new point..." workspace - reuses the exact same
 * full Smart 3D Follow Text workspace (auto-select, add tracker, track all/re-track,
 * clean & smooth, live preview) instead of the older single-target TrackEffectModal,
 * via SmartFollowTextToolPanel's `trackOnly` mode: Apply only saves the tracked
 * target(s) into editableFields.trackLibrary, it never inserts follow-text layers.
 */
export function TrackWorkspaceModal({
  asset,
  composition,
  existingTrack,
  onSave,
  onClose
}: {
  asset: SourceAsset;
  composition: TimelineComposition;
  /** When set, this modal edits/retracks an existing saved track instead of starting fresh. */
  existingTrack?: SavedTrack | undefined;
  onSave: (savedTracks: SavedTrack[]) => void;
  onClose: () => void;
}) {
  const assets = useMemo(() => [asset], [asset]);
  const tool = useMemo(() => getToolCapability("smart-3d-follow-text"), []);

  if (!tool) {
    return null;
  }

  return (
    <Modal title="Track" open className="modal-workspace" onClose={onClose}>
      <SmartFollowTextToolPanel
        tool={tool}
        assets={assets}
        selectedAssetId={asset.id}
        onSelectAsset={() => undefined}
        onUploadAsset={() => undefined}
        preselectedAsset={asset}
        liveComposition={composition}
        onApplyToComposition={(_nextComposition, _primaryTrackingPath, savedTracks) => {
          onSave(savedTracks);
          onClose();
        }}
        compact
        trackOnly
        initialTrack={existingTrack}
      />
    </Modal>
  );
}
