import { memo, useMemo, useState } from "react";
import { CONFIDENCE_INFO, confidenceClass } from "../../ai/confidence";
import { thoughtTail, type TranscriptItem } from "../../ai/transcript";
import type { AiPlan } from "../../ai/types";
import { Markdown } from "./Markdown";

/**
 * Claude-Code-style agent transcript — the AI panel's work log. Flat rows, no bubbles:
 * the user's prompt as a minimal chip, dim streaming thought (tail-clamped live, collapsible
 * once done), one accent-bulleted line per REAL action with live status + the registry's
 * result detail + real duration, inline questions, and an honest run summary.
 */
// memo: AiChatPanel re-renders on every composer keystroke; the transcript's props are
// identity-stable across those (items is a state array, the callbacks are useCallback), so
// this skips re-mapping the whole conversation history per character typed.
export const AgentTranscript = memo(function AgentTranscript({
  items,
  onWakeTrain,
  onWakeSetup
}: {
  items: TranscriptItem[];
  /** Resolve a wake-word training card: learn the heard phrase (true) or dismiss it. */
  onWakeTrain?: ((id: string, heard: string, learn: boolean) => void) | undefined;
  /** First-run wake-phrase setup card: start listening for samples (true) or dismiss. */
  onWakeSetup?: ((id: string, start: boolean) => void) | undefined;
}) {
  return (
    <div className="ai-transcript" role="log" aria-live="polite">
      {items.map((item) => (
        <TranscriptRow key={item.id} item={item} onWakeTrain={onWakeTrain} onWakeSetup={onWakeSetup} />
      ))}
    </div>
  );
});

function TranscriptRow({
  item,
  onWakeTrain,
  onWakeSetup
}: {
  item: TranscriptItem;
  onWakeTrain?: ((id: string, heard: string, learn: boolean) => void) | undefined;
  onWakeSetup?: ((id: string, start: boolean) => void) | undefined;
}) {
  switch (item.kind) {
    case "user":
      return (
        <div className="ai-tr-row ai-tr-user">
          <span className="ai-tr-user-chip">{item.text}</span>
        </div>
      );
    case "thought":
      return <ThoughtRow text={item.text} streaming={item.streaming} seconds={item.seconds} provider={item.provider} />;
    case "step":
      return (
        <div className={`ai-tr-row ai-tr-step is-${item.status}`}>
          <span className="ai-tr-glyph" aria-hidden>
            {item.status === "running" ? (
              <span className="ai-thinking-spinner" />
            ) : item.status === "done" ? (
              "✓"
            ) : item.status === "failed" ? (
              "✕"
            ) : item.status === "skipped" ? (
              "–"
            ) : (
              "○"
            )}
          </span>
          <span className="ai-tr-step-label">
            {item.label}
            {item.detail ? <span className="ai-tr-step-detail"> · {item.detail}</span> : null}
          </span>
          {typeof item.seconds === "number" && item.seconds >= 0.1 ? (
            <span className="ai-tr-time">{item.seconds.toFixed(item.seconds < 10 ? 1 : 0)}s</span>
          ) : null}
        </div>
      );
    case "text":
      return (
        <div className="ai-tr-row ai-tr-text">
          {item.markdown ? <Markdown text={item.markdown} /> : <span className="ai-typing-dots"><span /><span /><span /></span>}
        </div>
      );
    case "question":
      return (
        <div className="ai-tr-row ai-tr-question">
          <span className="ai-tr-glyph" aria-hidden>?</span>
          <span className="ai-tr-question-text">
            {item.text}
            {item.answered ? <span className="ai-tr-question-answer"> — “{item.answered}”</span> : null}
          </span>
        </div>
      );
    case "summary":
      return (
        <div className="ai-tr-row ai-tr-summary">
          <span className="ai-tr-glyph" aria-hidden>✓</span>
          <span>
            {[
              `Applied ${item.applied}`,
              item.failed ? `${item.failed} failed` : "",
              item.skipped ? `${item.skipped} skipped` : ""
            ]
              .filter(Boolean)
              .join(" · ")}
            {item.note ? <span className="ai-tr-summary-note"> — {item.note}</span> : null}
          </span>
        </div>
      );
    case "notice":
      return (
        <div className={`ai-tr-row ai-tr-notice is-${item.tone}`}>
          <span className="ai-tr-glyph" aria-hidden>{item.tone === "error" ? "✕" : "ℹ"}</span>
          <span>{item.text}</span>
        </div>
      );
    case "wakeTrain":
      // Wake-word near-miss: one confirmation teaches the ear this user's phrasing forever.
      return (
        <div className="ai-tr-row ai-tr-wake-train">
          <span className="ai-tr-glyph" aria-hidden>🎙</span>
          <span className="ai-tr-wake-train-body">
            I heard <strong>“{item.heard}”</strong> — were you calling me?
            {item.resolved === "learned" ? (
              <span className="ai-tr-wake-train-done"> ✓ Learned — that phrase wakes me now.</span>
            ) : item.resolved === "dismissed" ? (
              <span className="ai-tr-wake-train-done"> Okay, ignored.</span>
            ) : (
              <span className="ai-tr-wake-train-actions">
                <button type="button" onClick={() => onWakeTrain?.(item.id, item.heard, true)}>
                  Yes — learn it
                </button>
                <button type="button" onClick={() => onWakeTrain?.(item.id, item.heard, false)}>
                  No
                </button>
              </span>
            )}
          </span>
        </div>
      );
    case "wakeSetup":
      // First-run voice onboarding: capture the user's OWN wake phrase, however they say it.
      return (
        <div className="ai-tr-row ai-tr-wake-train">
          <span className="ai-tr-glyph" aria-hidden>🎙</span>
          <span className="ai-tr-wake-train-body">
            {item.stage === "offer" ? (
              <>
                Want hands-free control? Teach me your wake phrase — say whatever feels natural
                (“hey orreris”, “heya orreris”, anything).
                <span className="ai-tr-wake-train-actions">
                  <button type="button" onClick={() => onWakeSetup?.(item.id, true)}>
                    🎙 Teach me
                  </button>
                  <button type="button" onClick={() => onWakeSetup?.(item.id, false)}>
                    Not now
                  </button>
                </span>
              </>
            ) : item.stage === "listening" ? (
              <>
                Listening — say your wake phrase now ({item.samples.length}/3)…
                {item.samples.length > 0 ? <span className="ai-tr-wake-train-done"> heard: {item.samples.map((sample) => `“${sample}”`).join(", ")}</span> : null}
                <span className="ai-tr-wake-train-actions">
                  <button type="button" onClick={() => onWakeSetup?.(item.id, false)}>
                    Stop
                  </button>
                </span>
              </>
            ) : item.stage === "done" ? (
              <>
                ✓ Learned {item.samples.length} phrase{item.samples.length === 1 ? "" : "s"}: {item.samples.map((sample) => `“${sample}”`).join(", ")} — say any of them
                to wake me. The Ear button keeps me on standby.
              </>
            ) : (
              <span className="ai-tr-wake-train-done">Wake-phrase setup skipped — the Ear button in the header starts it any time.</span>
            )}
          </span>
        </div>
      );
    default:
      return null;
  }
}

/** Dim reasoning block: live = last ~6 lines streaming; finished = one-line collapsible toggle. */
function ThoughtRow({
  text,
  streaming,
  seconds,
  provider
}: {
  text: string;
  streaming: boolean;
  seconds?: number | undefined;
  provider?: string | undefined;
}) {
  const [open, setOpen] = useState(false);
  if (streaming) {
    return (
      <div className="ai-tr-row ai-tr-thought is-streaming">
        <pre className="ai-tr-thought-body">{thoughtTail(text)}</pre>
      </div>
    );
  }
  if (!text.trim()) {
    return null;
  }
  const label = `Thought${typeof seconds === "number" && seconds >= 1 ? ` for ${Math.round(seconds)}s` : ""}${provider ? ` · ${provider}` : ""}`;
  return (
    <div className="ai-tr-row ai-tr-thought">
      <button type="button" className="ai-tr-thought-toggle" onClick={() => setOpen((value) => !value)}>
        <span aria-hidden>{open ? "▾" : "▸"}</span> {label}
      </button>
      {open ? <pre className="ai-tr-thought-body">{text}</pre> : null}
    </div>
  );
}

/**
 * Slim approval bar (Professional mode) — replaces the boxy PlanReviewCard. The planned steps
 * themselves render as pending `step` rows in the transcript above; this is just the one-row
 * decision affordance: confidence chip · cost · Cancel/Modify/Apply. Per-step exclusion
 * checkboxes appear only when ≥2 runnable steps (logic lifted from PlanReviewCard).
 */
export function ApprovalBar({
  plan,
  busy,
  onApply,
  onCancel,
  onModify
}: {
  plan: AiPlan;
  busy: boolean;
  onApply: (stepIds: string[]) => void;
  onCancel: () => void;
  onModify?: (() => void) | undefined;
}) {
  const runnableIds = useMemo(
    () => plan.steps.filter((step) => step.kind !== "clarify").map((step) => step.id),
    [plan.steps]
  );
  const [excluded, setExcluded] = useState<Set<string>>(() => new Set());
  const showChecks = runnableIds.length >= 2;
  const selectedIds = plan.steps.filter((step) => step.kind === "clarify" || !excluded.has(step.id)).map((step) => step.id);
  const nothingSelected = runnableIds.length > 0 && runnableIds.every((id) => excluded.has(id));
  const applyCount = selectedIds.filter((id) => runnableIds.includes(id)).length;
  const toggle = (id: string) =>
    setExcluded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="ai-approval">
      {showChecks ? (
        <div className="ai-approval-checks">
          {plan.steps
            .filter((step) => step.kind !== "clarify")
            .map((step) => (
              <label key={step.id} className="ai-approval-check">
                <input type="checkbox" checked={!excluded.has(step.id)} onChange={() => toggle(step.id)} />
                <span>{step.summary}</span>
              </label>
            ))}
        </div>
      ) : null}
      <div className="ai-approval-bar">
        <span
          className={`ai-confidence ${confidenceClass(plan.confidence)}`}
          title={CONFIDENCE_INFO[plan.confidence].detail}
        >
          {plan.confidence}
          {typeof plan.confidencePercent === "number" ? ` · ${plan.confidencePercent}%` : ""}
        </span>
        <span className="ai-approval-cost">{plan.totalCredits === 0 ? "free" : `${plan.totalCredits} credits`}</span>
        <span className="ai-approval-actions">
          <button type="button" className="ai-approval-ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          {onModify ? (
            <button type="button" className="ai-approval-ghost" onClick={onModify} disabled={busy}>
              Modify
            </button>
          ) : null}
          <button
            type="button"
            className="ai-approval-apply"
            onClick={() => onApply(selectedIds)}
            disabled={busy || nothingSelected}
          >
            {busy ? "Applying…" : applyCount > 1 ? `Apply ${applyCount}` : "Apply"}
          </button>
        </span>
      </div>
    </div>
  );
}
