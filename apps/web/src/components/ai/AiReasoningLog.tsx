import { useState } from "react";

/**
 * GP2 — the model's chain-of-thought, shown collapsed under the plan (Claude-Code
 * style). Only rendered when the gateway captured reasoning from a thinking model.
 */
export function AiReasoningLog({ reasoning, provider }: { reasoning: string; provider?: string | undefined }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="ai-reasoning">
      <button type="button" className="ai-reasoning-toggle" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <span className="ai-reasoning-caret" aria-hidden>
          {open ? "▾" : "▸"}
        </span>
        AI reasoning{provider ? ` · ${provider}` : ""}
      </button>
      {open ? <pre className="ai-reasoning-body">{reasoning}</pre> : null}
    </div>
  );
}
