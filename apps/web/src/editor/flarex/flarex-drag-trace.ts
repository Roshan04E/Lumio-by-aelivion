/**
 * FULL DRAG EVENT TRACE for the Flarex page (`window.__rfFlarexDragLog`).
 *
 * Three attempts at "drag a node out of the add-node menu" failed, and every one of them instrumented
 * MY OWN handlers — which only ever proved that the handlers I already suspected did or did not run.
 * That cannot see an event delivered to an element I do not handle, an event never dispatched at all,
 * or a `dragend` arriving one millisecond after `dragstart` because the browser killed the drag.
 *
 * This listens at the DOCUMENT in the CAPTURE phase, so it sees every drag-related event before any
 * component handler can stop it, whatever the target. It records the target's tag/class/id, so the
 * question "which element actually received this?" is answerable from the log instead of inferred from
 * the component tree.
 *
 * High-frequency events (`drag`, `dragover`) are COUNTED rather than appended — a 20-entry log of
 * nothing but `dragover` would push the interesting first and last events out of the window, which is
 * the failure mode of every naive event log.
 *
 * Debug-only and self-limiting. Install on mount, remove on unmount.
 */

export interface FlarexDragLogEntry {
  /** ms since the trace was installed — the GAPS are the diagnosis (dragstart → dragend in <20ms
   *  means the browser cancelled the drag rather than the user releasing it). */
  t: number;
  type: string;
  target: string;
  /** Set on dragstart/dragover/drop: what the dataTransfer actually carries. */
  types?: string;
  effectAllowed?: string;
  dropEffect?: string;
  /** True when some handler has already called preventDefault by the time we see it (capture phase
   *  means "before component handlers", so this is a listener registered even earlier). */
  defaultPrevented?: boolean;
}

const DRAG_EVENTS = ["dragstart", "drag", "dragenter", "dragover", "dragleave", "drop", "dragend"] as const;
const POINTER_EVENTS = ["pointerdown", "mousedown", "pointerup", "click"] as const;
/** Counted, not logged — see header. */
const NOISY = new Set<string>(["drag", "dragover"]);
const MAX_ENTRIES = 60;

function describe(target: EventTarget | null): string {
  const el = target as HTMLElement | null;
  if (!el || !el.tagName) return String(target);
  const cls = typeof el.className === "string" && el.className ? `.${el.className.trim().split(/\s+/).join(".")}` : "";
  const id = el.id ? `#${el.id}` : "";
  const text = el.tagName === "BUTTON" ? ` "${(el.textContent ?? "").trim().slice(0, 20)}"` : "";
  return `${el.tagName.toLowerCase()}${id}${cls}${text}`;
}

export interface FlarexDragTraceState {
  log: FlarexDragLogEntry[];
  counts: Record<string, number>;
  /** Target of the most recent event of each noisy type — "where are the dragovers GOING?" is the
   *  question that separates "nothing is happening" from "everything is happening to the wrong node". */
  lastNoisyTarget: Record<string, string>;
  installedAt: number;
}

/**
 * OFF by default (2026-07-28). This found a bug three rounds of handler-level counters could not, so it
 * is kept rather than deleted — but it installs eleven capture-phase document listeners, and `drag`
 * fires continuously for the whole of every drag in the app. That is a real cost to carry permanently
 * for a fixed bug. Enable with `?flarexDragTrace=1` when a drag misbehaves again.
 */
function traceEnabled(): boolean {
  try {
    return new URLSearchParams(window.location.search).get("flarexDragTrace") === "1";
  } catch {
    return false;
  }
}

export function installFlarexDragTrace(): () => void {
  if (typeof document === "undefined" || !traceEnabled()) return () => undefined;
  const w = window as unknown as { __rfFlarexDragLog?: FlarexDragTraceState };
  const state: FlarexDragTraceState = {
    log: [],
    counts: {},
    lastNoisyTarget: {},
    installedAt: performance.now(),
  };
  w.__rfFlarexDragLog = state;

  const onEvent = (event: Event) => {
    state.counts[event.type] = (state.counts[event.type] ?? 0) + 1;
    const target = describe(event.target);
    if (NOISY.has(event.type)) {
      state.lastNoisyTarget[event.type] = target;
      return;
    }
    const dt = (event as DragEvent).dataTransfer;
    const entry: FlarexDragLogEntry = {
      t: Math.round(performance.now() - state.installedAt),
      type: event.type,
      target,
      defaultPrevented: event.defaultPrevented,
    };
    if (dt) {
      entry.types = [...dt.types].join(",") || "(none)";
      entry.effectAllowed = dt.effectAllowed;
      entry.dropEffect = dt.dropEffect;
    }
    state.log.push(entry);
    // Keep the HEAD (the interesting opening sequence) and drop from the middle, so a long idle tail
    // cannot evict the dragstart that explains everything.
    if (state.log.length > MAX_ENTRIES) state.log.splice(MAX_ENTRIES / 2, 1);
  };

  const all = [...DRAG_EVENTS, ...POINTER_EVENTS];
  for (const type of all) document.addEventListener(type, onEvent, true);
  return () => {
    for (const type of all) document.removeEventListener(type, onEvent, true);
  };
}
