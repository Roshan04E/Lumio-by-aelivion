import { useEffect, useRef, useState } from "react";

/**
 * GP2 / GP2.1 "thinking" log — Claude-Code-style activity while the planner runs.
 *
 * Every line here reflects a REAL backend stream event, never a scripted timer: steps are only
 * revealed as the planner actually reaches them (`activePhase` from the NDJSON stream), the live
 * step shows a spinner + its real elapsed seconds, and finished steps show the real time they took
 * ("Thought for 4s"). We never pre-list future steps or auto-advance on a clock — if the planner
 * stalls, the display stalls with it, honestly.
 */
const STEP_LABELS = [
  "Understanding your request",
  "Reading the timeline",
  "Checking available tools",
  "Thinking", // provider appended live (e.g. "Thinking · groq")
  "Drafting the plan",
  "Validating against the editor's tools"
];

/** The reasoning phase — labelled and timed differently ("Thought for Ns"). */
const THINKING_INDEX = 3;

export function AiThinkingLog({
  activePhase,
  reasoning,
  provider
}: {
  activePhase?: number | undefined;
  reasoning?: string | undefined;
  provider?: string | undefined;
}) {
  const current = Math.min(STEP_LABELS.length - 1, Math.max(0, typeof activePhase === "number" ? activePhase : 0));

  // Real per-step start timestamps. Fill every index up to `current` (with no gaps, even when the
  // stream jumps two phases in one tick) the first time we see it, so each step's duration is the
  // genuine wall-clock time between it starting and the next step starting.
  const startsRef = useRef<number[]>([]);
  for (let i = 0; i <= current; i += 1) {
    if (startsRef.current[i] === undefined) {
      startsRef.current[i] = performance.now();
    }
  }

  // Tick a few times a second ONLY to advance the live elapsed-seconds readout of the active step.
  // This is a clock for DISPLAYING real elapsed time — it never moves the steps forward itself.
  const [nowMs, setNowMs] = useState(() => performance.now());
  useEffect(() => {
    const timer = setInterval(() => setNowMs(performance.now()), 250);
    return () => clearInterval(timer);
  }, []);

  const secondsFor = (index: number): number => {
    const start = startsRef.current[index];
    if (start === undefined) {
      return 0;
    }
    const end = index < current ? (startsRef.current[index + 1] ?? nowMs) : nowMs;
    return Math.max(0, (end - start) / 1000);
  };

  return (
    <div className="ai-thinking">
      <ul className="ai-thinking-log" aria-label="AI activity">
        {STEP_LABELS.slice(0, current + 1).map((label, index) => {
          const done = index < current;
          const isThinking = index === THINKING_INDEX;
          const text = isThinking && provider ? `${label} · ${provider}` : label;
          const secs = secondsFor(index);
          const timeLabel = isThinking
            ? done
              ? `Thought for ${Math.max(1, Math.round(secs))}s`
              : `${secs.toFixed(secs < 10 ? 1 : 0)}s`
            : secs >= 0.6
              ? `${secs.toFixed(secs < 10 ? 1 : 0)}s`
              : null;
          return (
            <li key={index} className={`ai-thinking-row is-${done ? "done" : "active"}`}>
              <span className="ai-thinking-glyph" aria-hidden>
                {done ? "✓" : <span className="ai-thinking-spinner" />}
              </span>
              <span className="ai-thinking-label">{text}</span>
              {timeLabel ? <span className="ai-thinking-time">{timeLabel}</span> : null}
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
