import { useState } from "react";
import { Modal } from "./Modal";
import { Button } from "./Button";
import { relinkAsset, type RelinkAssetNeed } from "../lib/sync";

/**
 * Shown when export needs media whose local bytes are missing (e.g. cleared site data).
 * The user re-selects each file once; we re-attach it under the same local asset id and
 * then let the caller retry export. Edits are never lost.
 */
export function RelinkMediaModal({
  open,
  assets,
  onClose,
  onResolved,
}: {
  open: boolean;
  assets: RelinkAssetNeed[];
  onClose: () => void;
  onResolved: () => void;
}) {
  const [done, setDone] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function pick(need: RelinkAssetNeed, file: File) {
    setBusy(true);
    setError(null);
    try {
      await relinkAsset(need.localAssetId, file);
      setDone((prev) => ({ ...prev, [need.localAssetId]: true }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not attach that file.");
    } finally {
      setBusy(false);
    }
  }

  const allDone = assets.length > 0 && assets.every((a) => done[a.localAssetId]);

  return (
    <Modal open={open} title="Relink media for export" onClose={onClose} className="relink-modal">
      <p className="relink-copy">
        This media needs to be selected once so we can sync it for export. Your edits are safe.
      </p>
      <ul className="relink-list">
        {assets.map((need) => (
          <li key={need.localAssetId}>
            <span className="relink-name">{need.fileName}</span>
            {done[need.localAssetId] ? (
              <span className="relink-ok">Ready</span>
            ) : (
              <label className="relink-pick">
                Choose file
                <input
                  type="file"
                  hidden
                  accept="video/*,image/*,audio/*"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) void pick(need, file);
                  }}
                />
              </label>
            )}
          </li>
        ))}
      </ul>
      {error ? <p className="relink-error">{error}</p> : null}
      <div className="relink-actions">
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button disabled={!allDone || busy} onClick={onResolved}>
          Continue export
        </Button>
      </div>
    </Modal>
  );
}
