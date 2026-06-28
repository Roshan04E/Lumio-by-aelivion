import { useEffect, useState } from "react";

/**
 * GP2 / GP2.1 "thinking" log — Claude-Code-style activity while the planner runs.
 * When `activePhase` is provided it is driven by REAL backend stream events
 * (provider connected → reasoning tokens → drafting → validating). Without events
 * (deterministic planner) it falls back to a gentle timed ticker.
 */
const PHASES = [
  "Understanding request",
  "Inspecting timeline slice",
  "Querying capability registry",
  "Reasoning…",
  "Drafting plan",
  "Validating against registry"
];

const GLYPH = { done: "✓", active: "⏳", pending: "○" } as const;

export function AiThinkingLog({
  activePhase,
  reasoning,
  provider
}: {
  activePhase?: number | undefined;
  reasoning?: string | undefined;
  provider?: string | undefined;
}) {
  const [ticked, setTicked] = useState(0);

  // Always walk the phases forward on a gentle timer so each line lights up after the
  // previous one — a real, progressive feel. Real backend events (`activePhase`) act
  // only as a FLOOR: they pull the display ahead if the model is faster, but the
  // ticker keeps things moving when events stall (e.g. the LLM pool is failing over
  // and we're about to fall back to the deterministic planner). We never tick past
  // the last phase, so it never shows "done" before the plan actually arrives.
  useEffect(() => {
    const timer = setInterval(() => {
      setTicked((current) => (current >= PHASES.length - 1 ? current : current + 1));
    }, 620);
    return () => clearInterval(timer);
  }, []);

  const floor = typeof activePhase === "number" ? activePhase : 0;
  const current = Math.min(PHASES.length - 1, Math.max(ticked, floor));

  return (
    <div className="ai-thinking">
      <ul className="ai-thinking-log" aria-label="AI activity">
        {PHASES.map((phase, index) => {
          const state = index < current ? "done" : index === current ? "active" : "pending";
          const label = index === 3 && provider ? `Reasoning… (${provider})` : phase;
          return (
            <li key={phase} className={`ai-thinking-row is-${state}`}>
              <span className="ai-thinking-glyph" aria-hidden>
                {GLYPH[state]}
              </span>
              <span className="ai-thinking-label">{label}</span>
            </li>
          );
        })}
      </ul>
      {reasoning && reasoning.trim() ? <pre className="ai-thinking-stream">{tail(reasoning)}</pre> : null}
    </div>
  );
}

/** Show the most recent reasoning so the box doesn't grow unbounded while streaming. */
function tail(text: string): string {
  const max = 600;
  return text.length > max ? `…${text.slice(-max)}` : text;
}
