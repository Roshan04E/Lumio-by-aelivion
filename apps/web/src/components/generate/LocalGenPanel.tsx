import { useState } from "react";
import {
  DEFAULT_COMFY_BASE_URL,
  DEFAULT_LOCAL_GEN_BASE_URL,
  clearLocalGenConfig,
  listLocalModels,
  loadLocalGenConfig,
  saveLocalGenConfig,
  type LocalGenBackend,
  type LocalGenConfig
} from "../../generate/localGen";
import { ThemedSelect } from "../../editor/inspector/controls/ThemedSelect";

/**
 * "Local" generation setup — point the Studio at your own Stable Diffusion server (AUTOMATIC1111).
 * Image generation then runs browser-direct on your machine (private, offline, free) instead of the
 * cloud pool. Config is stored only in this browser. The server must allow this site's origin (CORS).
 */
export function LocalGenPanel({
  onClose,
  onChange
}: {
  onClose: () => void;
  onChange: (config: LocalGenConfig | null) => void;
}) {
  const existing = loadLocalGenConfig();
  const [baseUrl, setBaseUrl] = useState(existing?.baseUrl ?? DEFAULT_LOCAL_GEN_BASE_URL);
  const [backend, setBackend] = useState<LocalGenBackend>(existing?.backend ?? "a1111");
  const [model, setModel] = useState(existing?.model ?? "");
  const [models, setModels] = useState<string[]>([]);
  const [status, setStatus] = useState<"idle" | "testing" | "ok" | "error">("idle");
  const [error, setError] = useState("");

  const test = async () => {
    setStatus("testing");
    setError("");
    try {
      const found = await listLocalModels(baseUrl, backend);
      setModels(found);
      setStatus("ok");
      if (found.length === 0) {
        setError(
          backend === "comfy"
            ? "Reachable, but no checkpoints found. Put a model in ComfyUI/models/checkpoints."
            : "Reachable, but no checkpoints found. Add a model to your Stable Diffusion server."
        );
      } else if (!model || !found.includes(model)) {
        setModel(found[0]!);
      }
    } catch {
      setStatus("error");
      setError("Couldn't reach the local server. Is it running, and does it allow this site's origin (CORS)?");
    }
  };

  const handleEnable = () => {
    const config: LocalGenConfig = {
      baseUrl: baseUrl.trim() || DEFAULT_LOCAL_GEN_BASE_URL,
      backend,
      model: model.trim(),
      enabled: true
    };
    saveLocalGenConfig(config);
    onChange(config);
    setTimeout(onClose, 400);
  };

  const handleClear = () => {
    clearLocalGenConfig();
    onChange(null);
    setModel("");
    setModels([]);
    setStatus("idle");
    setError("");
  };

  return (
    <div className="ai-byok">
      <div className="ai-byok-head">
        <strong>Local generator (Stable Diffusion)</strong>
        <button type="button" className="ai-dock-close" onClick={onClose} aria-label="Back">
          ✕
        </button>
      </div>
      <p className="ai-byok-note">
        Generate images on <em>your</em> machine — private, unmetered, free. Stored only in this browser.
        {backend === "comfy" ? (
          <>
            {" "}
            Launch ComfyUI with CORS allowed for this site:{" "}
            <code>python main.py --enable-cors-header {typeof location !== "undefined" ? location.origin : "<this origin>"}</code>.
            Put a checkpoint in <code>ComfyUI/models/checkpoints</code>. Text-to-image only for now.
          </>
        ) : (
          <>
            {" "}
            Start your AUTOMATIC1111 server with API + CORS for this site:{" "}
            <code>--api --cors-allow-origins={typeof location !== "undefined" ? location.origin : "<this origin>"}</code>.
          </>
        )}{" "}
        Video always uses the cloud.
      </p>

      <label className="ai-byok-field">
        <span>Backend</span>
        <ThemedSelect
          ariaLabel="Backend"
          value={backend}
          options={[
            { value: "a1111", label: "AUTOMATIC1111" },
            { value: "comfy", label: "ComfyUI" }
          ]}
          onChange={(next) => {
            const nextBackend = next as LocalGenBackend;
            setBackend(nextBackend);
            // Auto-swap the port to the backend's default if the field is still on the other default.
            setBaseUrl((current) => {
              const trimmed = current.trim();
              if (nextBackend === "comfy" && (trimmed === DEFAULT_LOCAL_GEN_BASE_URL || trimmed === "")) {
                return DEFAULT_COMFY_BASE_URL;
              }
              if (nextBackend === "a1111" && trimmed === DEFAULT_COMFY_BASE_URL) {
                return DEFAULT_LOCAL_GEN_BASE_URL;
              }
              return current;
            });
            setModels([]);
            setStatus("idle");
            setError("");
          }}
        />
      </label>

      <label className="ai-byok-field">
        <span>Server URL</span>
        <input
          type="text"
          value={baseUrl}
          onChange={(event) => setBaseUrl(event.target.value)}
          placeholder={DEFAULT_LOCAL_GEN_BASE_URL}
          autoComplete="off"
          spellCheck={false}
        />
      </label>

      <div className="ai-byok-actions">
        <button type="button" className="primary" onClick={() => void test()} disabled={status === "testing"}>
          {status === "testing" ? "Testing…" : "Test connection"}
        </button>
      </div>

      {models.length > 0 ? (
        <label className="ai-byok-field">
          <span>Checkpoint</span>
          <ThemedSelect
            ariaLabel="Checkpoint"
            value={model}
            options={models.map((name) => ({ value: name, label: name }))}
            onChange={(next) => setModel(next)}
          />
        </label>
      ) : null}

      {error ? <p className="ai-byok-hint ai-byok-error">{error}</p> : null}

      <div className="ai-byok-actions">
        {existing ? (
          <button type="button" className="ghost" onClick={handleClear}>
            Remove
          </button>
        ) : null}
        <button type="button" className="primary" onClick={handleEnable}>
          {existing?.enabled ? "Save" : "Enable local generation"}
        </button>
      </div>
    </div>
  );
}
