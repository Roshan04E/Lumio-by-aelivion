import { useState } from "react";
import {
  DEFAULT_OLLAMA_BASE_URL,
  clearOllamaConfig,
  listOllamaModels,
  loadOllamaConfig,
  saveOllamaConfig,
  type OllamaConfig,
  type OllamaModel
} from "../../ai/ollama";
import { ThemedSelect } from "../../editor/inspector/controls/ThemedSelect";

/**
 * "Local" mode setup — point Orreris at your own Ollama model. Requests then run browser-direct on your
 * machine (private/offline, unmetered) instead of the cloud pool. Config is stored only in this
 * browser. Ollama must allow this site's origin (`OLLAMA_ORIGINS=<this origin> ollama serve`).
 */
export function OllamaPanel({ onClose, onChange }: { onClose: () => void; onChange: (config: OllamaConfig | null) => void }) {
  const existing = loadOllamaConfig();
  const [baseUrl, setBaseUrl] = useState(existing?.baseUrl ?? DEFAULT_OLLAMA_BASE_URL);
  const [model, setModel] = useState(existing?.model ?? "");
  const [models, setModels] = useState<OllamaModel[]>([]);
  const [status, setStatus] = useState<"idle" | "testing" | "ok" | "error">("idle");
  const [error, setError] = useState("");

  const test = async () => {
    setStatus("testing");
    setError("");
    try {
      const found = await listOllamaModels(baseUrl);
      setModels(found);
      setStatus("ok");
      if (found.length === 0) {
        setError("Ollama is reachable but has no models pulled. Run e.g. `ollama pull llama3.2-vision`.");
      } else if (!model || !found.some((item) => item.name === model)) {
        setModel(found[0]!.name);
      }
    } catch {
      setStatus("error");
      setError("Couldn't reach Ollama. Is it running, and is OLLAMA_ORIGINS set to allow this site?");
    }
  };

  const selected = models.find((item) => item.name === model);

  const handleEnable = () => {
    if (!model.trim()) return;
    const config: OllamaConfig = {
      baseUrl: baseUrl.trim() || DEFAULT_OLLAMA_BASE_URL,
      model: model.trim(),
      enabled: true,
      supportsVision: selected?.supportsVision ?? existing?.supportsVision ?? false
    };
    saveOllamaConfig(config);
    onChange(config);
    setTimeout(onClose, 400);
  };

  const handleClear = () => {
    clearOllamaConfig();
    onChange(null);
    setModel("");
    setModels([]);
    setStatus("idle");
    setError("");
  };

  return (
    <div className="ai-byok">
      <div className="ai-byok-head">
        <strong>Local model (Ollama)</strong>
        <button type="button" className="ai-dock-close" onClick={onClose} aria-label="Back to chat">
          ✕
        </button>
      </div>
      <p className="ai-byok-note">
        Runs the chat + planner on <em>your</em> Ollama model — private, unmetered. Stored only in this browser. Start
        Ollama allowing this site: <code>OLLAMA_ORIGINS={typeof location !== "undefined" ? location.origin : "<this origin>"} ollama serve</code>.
      </p>
      <p className="ai-byok-hint">
        Using a cloud model (no big download)? Sign in once with <code>ollama signin</code>, then pull its manifest, e.g.{" "}
        <code>ollama pull minimax-m3:cloud</code> — it then appears below and runs on the same local API.
      </p>

      <label className="ai-byok-field">
        <span>Server URL</span>
        <input
          type="text"
          value={baseUrl}
          onChange={(event) => setBaseUrl(event.target.value)}
          placeholder={DEFAULT_OLLAMA_BASE_URL}
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
          <span>Model</span>
          <ThemedSelect
            ariaLabel="Model"
            value={model}
            options={models.map((item) => ({ value: item.name, label: `${item.name}${item.supportsVision ? "  · vision" : ""}` }))}
            onChange={(next) => setModel(next)}
          />
        </label>
      ) : null}

      {status === "ok" && selected ? (
        <p className="ai-byok-hint">{selected.supportsVision ? "Vision-capable — reference images will be read." : "Text only — reference images won't be read by this model."}</p>
      ) : null}
      {error ? <p className="ai-byok-hint ai-byok-error">{error}</p> : null}

      <div className="ai-byok-actions">
        {existing ? (
          <button type="button" className="ghost" onClick={handleClear}>
            Remove
          </button>
        ) : null}
        <button type="button" className="primary" onClick={handleEnable} disabled={!model.trim()}>
          {existing?.enabled ? "Save" : "Enable Local mode"}
        </button>
      </div>
    </div>
  );
}
