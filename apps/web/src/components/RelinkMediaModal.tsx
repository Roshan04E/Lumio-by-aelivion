import { useState } from "react";
import { Modal } from "./Modal";
import { Button } from "./Button";
import { relinkAsset, type RelinkAssetNeed } from "../lib/sync";

/**
 * Shown when media whose local bytes are missing needs to be re-selected — either on project
 * OPEN (bytes gone, e.g. cleared site data / different machine; editing stays safe) or at
 * EXPORT time (the sync gate needs bytes to upload). Same list/pick UI, different title/copy/CTA
 * and different resolution behaviour per `mode`.
 */
export function RelinkMediaModal({
  open,
  mode,
  assets,
  onClose,
  onResolved,
}: {
  open: boolean;
  mode: "open" | "export";
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
  const title = mode === "open" ? "Some media is missing" : "Relink media for export";
  const copy =
    mode === "open"
      ? "This project references media that isn't on this device (e.g. cleared site data, or a different browser/machine). Your edits are safe — re-select the files below to play and export them again."
      : "This media needs to be selected once so we can sync it for export. Your edits are safe.";

  return (
    <Modal open={open} title={title} onClose={onClose} className="relink-modal">
      <p className="relink-copy">{copy}</p>
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
          {mode === "open" ? "Done" : "Continue export"}
        </Button>
      </div>
    </Modal>
  );
}
