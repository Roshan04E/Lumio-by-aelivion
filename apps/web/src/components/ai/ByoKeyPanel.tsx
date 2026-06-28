import { useState } from "react";
import { BYO_PROVIDERS, clearByoKey, loadByoKey, saveByoKey, type ByoProvider } from "../../ai/byok";
import { ThemedSelect } from "../../editor/inspector/controls/ThemedSelect";

/**
 * GP3 — Bring Your Own Key form. Lets a user run AI on their own provider quota.
 * The key is stored only in this browser and sent per-request; it is never persisted
 * or logged on the server.
 */
export function ByoKeyPanel({ onClose }: { onClose: () => void }) {
  const existing = loadByoKey();
  const [provider, setProvider] = useState<ByoProvider>(existing?.provider ?? "groq");
  const [apiKey, setApiKey] = useState(existing?.apiKey ?? "");
  const [model, setModel] = useState(existing?.model ?? "");
  const [saved, setSaved] = useState(false);

  const hint = BYO_PROVIDERS.find((item) => item.id === provider)?.keyHint ?? "";

  const handleSave = () => {
    if (!apiKey.trim()) return;
    saveByoKey({ provider, apiKey: apiKey.trim(), ...(model.trim() ? { model: model.trim() } : {}) });
    setSaved(true);
    setTimeout(onClose, 600);
  };

  const handleClear = () => {
    clearByoKey();
    setApiKey("");
    setModel("");
    setSaved(false);
  };

  return (
    <div className="ai-byok">
      <div className="ai-byok-head">
        <strong>Your own AI key</strong>
        <button type="button" className="ai-dock-close" onClick={onClose} aria-label="Back to chat">
          ✕
        </button>
      </div>
      <p className="ai-byok-note">
        Runs AI on <em>your</em> provider quota instead of the shared pool. Stored only in this browser; sent per-request,
        never saved on the server.
      </p>

      <label className="ai-byok-field">
        <span>Provider</span>
        <ThemedSelect
          ariaLabel="Provider"
          value={provider}
          options={BYO_PROVIDERS.map((item) => ({ value: item.id, label: item.label }))}
          onChange={(next) => setProvider(next as ByoProvider)}
        />
      </label>
      <p className="ai-byok-hint">{hint}</p>

      <label className="ai-byok-field">
        <span>API key</span>
        <input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="Paste your key" autoComplete="off" />
      </label>

      <label className="ai-byok-field">
        <span>Model (optional)</span>
        <input type="text" value={model} onChange={(event) => setModel(event.target.value)} placeholder="Provider default" />
      </label>

      <div className="ai-byok-actions">
        <button type="button" className="ghost" onClick={handleClear} disabled={!existing && !apiKey}>
          Clear
        </button>
        <button type="button" className="primary" onClick={handleSave} disabled={!apiKey.trim()}>
          {saved ? "Saved ✓" : "Save"}
        </button>
      </div>
    </div>
  );
}
