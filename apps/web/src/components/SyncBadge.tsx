import { useSyncExternalStore } from "react";
import { getSyncStatusString, subscribe, type UiSyncStatus } from "../lib/sync";

const LABELS: Record<UiSyncStatus, string> = {
  "saved-local": "Saved locally",
  syncing: "Syncing…",
  synced: "Synced",
  "export-ready": "Export ready",
  failed: "Sync failed",
};

const TITLES: Record<UiSyncStatus, string> = {
  "saved-local": "Saved on this device. Will sync to the cloud when the backend is reachable.",
  syncing: "Syncing your project to the cloud…",
  synced: "Saved to the cloud.",
  "export-ready": "Synced and ready to export.",
  failed: "Sync failed — your edits are safe locally. Retry to sync.",
};

/** Live sync state for a project id (re-renders on registry/connectivity changes). */
function useSyncStatus(projectId: string | undefined): UiSyncStatus {
  return useSyncExternalStore(
    subscribe,
    () => (projectId ? getSyncStatusString(projectId) : "saved-local"),
    () => (projectId ? getSyncStatusString(projectId) : "saved-local")
  );
}

export function SyncBadge({ projectId, onRetry }: { projectId: string | undefined; onRetry?: () => void }) {
  const status = useSyncStatus(projectId);
  return (
    <span className={`sync-badge sync-badge-${status}`} title={TITLES[status]}>
      <span className="sync-badge-dot" aria-hidden="true" />
      <span className="sync-badge-label">{LABELS[status]}</span>
      {status === "failed" && onRetry ? (
        <button type="button" className="sync-badge-retry" onClick={onRetry}>
          Retry
        </button>
      ) : null}
    </span>
  );
}
