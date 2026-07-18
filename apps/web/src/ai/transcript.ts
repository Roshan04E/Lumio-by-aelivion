/**
 * Agent transcript model — the AI panel's single source of display truth.
 *
 * The panel used to be a chat (bubbles + a boxy plan card + a separate progress list). It is now a
 * Claude-Code-style WORK LOG: a flat, ordered list of typed items, each one row — the user's
 * prompt, a dim streaming thought block, one line per real action with its live status/result,
 * inline questions, and an honest run summary. Every item maps to a REAL signal (planner stream
 * events, executor onProgress, registry summaries) — nothing here is scripted or timer-driven.
 */

import type { DecisionTrace } from "./decision-trace";

export type TranscriptItem =
  | { kind: "user"; id: string; text: string }
  | {
      kind: "thought";
      id: string;
      text: string;
      streaming: boolean;
      /** Real wall-clock seconds spent thinking (set when the thought finishes). */
      seconds?: number | undefined;
      /** Provider that produced the reasoning (e.g. "groq"), shown on the collapsed row. */
      provider?: string | undefined;
    }
  | {
      kind: "step";
      id: string;
      label: string;
      status: "pending" | "running" | "done" | "failed" | "skipped";
      /** The real result summary from the registry/tool (always shown, unlike the old list). */
      detail?: string | undefined;
      seconds?: number | undefined;
    }
  | { kind: "text"; id: string; markdown: string; streaming?: boolean | undefined }
  | { kind: "question"; id: string; text: string; answered?: string | undefined }
  | { kind: "summary"; id: string; applied: number; failed: number; skipped: number; note?: string | undefined }
  /** K5 trace chrome: a collapsed "Why?" row under a result — the DecisionTrace snapshot for
   * THAT result (the WHY reflex answers about the latest; this row keeps every past one). */
  | { kind: "trace"; id: string; trace: DecisionTrace }
  | { kind: "notice"; id: string; tone: "info" | "warn" | "error"; text: string }
  /** Wake-word near-miss: a greeting-led phrase standby heard but didn't match — the user can
   * confirm it to TRAIN the wake word ("hello mia" → wakes from now on). */
  | { kind: "wakeTrain"; id: string; heard: string; resolved?: "learned" | "dismissed" | undefined }
  /** First-run voice onboarding: teach Orreris YOUR wake phrase ("hey orreris", "heya orreris"…).
   * offer → listening (captures 3 spoken samples) → done/dismissed. */
  | { kind: "wakeSetup"; id: string; stage: "offer" | "listening" | "done" | "dismissed"; samples: string[] };

/** Distributive omit — `Omit` on a union collapses to common keys; this preserves each variant. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** A transcript item without (or with an optional) id — the shape the panel's `pushItem` accepts. */
export type TranscriptItemInput = DistributiveOmit<TranscriptItem, "id"> & { id?: string | undefined };

let transcriptSeq = 0;
export function transcriptId(): string {
  transcriptSeq += 1;
  return `tr_${Date.now().toString(36)}_${transcriptSeq}`;
}

/** Append an item (pure — returns a new array). */
export function appendItem(items: TranscriptItem[], item: TranscriptItem): TranscriptItem[] {
  return [...items, item];
}

/**
 * Patch an item by id (pure). The partial is merged shallowly; the item's kind never changes.
 * Unknown id → returns the input array unchanged (safe for late async patches after a clear).
 */
export function patchItem(items: TranscriptItem[], id: string, patch: Partial<TranscriptItem>): TranscriptItem[] {
  let changed = false;
  const next = items.map((item) => {
    if (item.id !== id) {
      return item;
    }
    changed = true;
    return { ...item, ...patch, id: item.id, kind: item.kind } as TranscriptItem;
  });
  return changed ? next : items;
}

/** Last N lines of a streaming thought — the live view shows only the tail, Claude-Code style. */
export function thoughtTail(text: string, maxLines = 6): string {
  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  return lines.slice(-maxLines).join("\n");
}

// ---------------------------------------------------------------------------
// Persistence — the conversation survives reloads, per project. localStorage
// (local-first, like the brain stores); bounded so one long session can't eat
// the quota. Live-only flags are sanitized on load: nothing may come back
// "streaming"/"running" from a session that no longer exists.
// ---------------------------------------------------------------------------

const TRANSCRIPT_KEY_PREFIX = "orreris.ai.transcript.v1.";
const MAX_PERSISTED_ITEMS = 150;
const MAX_PERSISTED_TEXT = 4000;

function transcriptKey(projectId: string): string {
  return `${TRANSCRIPT_KEY_PREFIX}${projectId || "default"}`;
}

/** Freeze an item for storage: cap text sizes, drop live-session flags. */
function sanitizeForLoad(item: TranscriptItem): TranscriptItem {
  switch (item.kind) {
    case "thought":
      return { ...item, streaming: false, text: item.text.slice(0, MAX_PERSISTED_TEXT) };
    case "text":
      return { ...item, streaming: false, markdown: item.markdown.slice(0, MAX_PERSISTED_TEXT) };
    case "step":
      // A step still "running" belongs to a session that's gone — report it honestly.
      return item.status === "pending" || item.status === "running" ? { ...item, status: "skipped", detail: item.detail ?? "session ended" } : item;
    case "wakeTrain":
      // An unanswered training card can't be answered by a dead session — close it.
      return item.resolved ? item : { ...item, resolved: "dismissed" };
    case "wakeSetup":
      // A live setup can't survive the session that ran it; keep only its outcome states.
      return item.stage === "offer" || item.stage === "listening" ? { ...item, stage: "dismissed" } : item;
    default:
      return item;
  }
}

export function loadTranscript(projectId: string): TranscriptItem[] {
  try {
    if (typeof localStorage === "undefined") {
      return [];
    }
    const parsed: unknown = JSON.parse(localStorage.getItem(transcriptKey(projectId)) ?? "[]");
    if (!Array.isArray(parsed)) {
      return [];
    }
    return (parsed as TranscriptItem[])
      .filter((item) => item && typeof item === "object" && typeof item.id === "string" && typeof item.kind === "string")
      .map(sanitizeForLoad);
  } catch {
    return [];
  }
}

export function saveTranscript(projectId: string, items: TranscriptItem[]): void {
  try {
    if (typeof localStorage === "undefined") {
      return;
    }
    const bounded = items.slice(-MAX_PERSISTED_ITEMS).map(sanitizeForLoad);
    localStorage.setItem(transcriptKey(projectId), JSON.stringify(bounded));
  } catch {
    // Quota/private mode — the live session still works; history just won't survive.
  }
}

export function clearTranscript(projectId: string): void {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.removeItem(transcriptKey(projectId));
    }
  } catch {
    // best-effort
  }
}
