import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { isModelCached } from "../tools/model-cache";
import { SEGMENTATION_MODEL_URLS, redownloadSegmentationModels } from "../tools/local-segmentation";

/**
 * "Local engine" status + Redownload control for the segmentation-backed tools (Remove Background,
 * Text Behind Person). The ML weights are cached in the browser (OPFS) so they download once and
 * survive reloads; Redownload force-refreshes them — the fix when a partial/corrupt download (flaky
 * network, OS network optimizations) wedged the high-quality engine.
 */
export function ModelEngineControl() {
  const [cached, setCached] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");

  useEffect(() => {
    let alive = true;
    void isModelCached(SEGMENTATION_MODEL_URLS.quality).then((value) => {
      if (alive) setCached(value);
    });
    return () => {
      alive = false;
    };
  }, []);

  async function redownload() {
    setBusy(true);
    setStatus("");
    try {
      await redownloadSegmentationModels(setStatus);
      setCached(true);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Redownload failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="toolws-field toolws-engine">
      <span className="toolws-field-label">Local engine</span>
      <div className="toolws-engine-row">
        <span className="toolws-engine-status">
          {cached === null ? "Checking cache…" : cached ? "Downloaded · cached in browser" : "Downloads on first run"}
        </span>
        <button type="button" className="ui-btn" disabled={busy} title="Clear and re-download the model weights" onClick={() => void redownload()}>
          <RefreshCw size={13} className={busy ? "toolws-spin" : ""} />
          {busy ? "Downloading…" : "Redownload"}
        </button>
      </div>
      {status ? <p className="toolws-range-readout">{status}</p> : null}
    </div>
  );
}
