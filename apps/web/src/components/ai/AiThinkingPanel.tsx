/**
 * ORIS Stage A — the observatory's viewport. Gated on `?aiThinkingShow=1`.
 *
 * Stage A's whole premise is that we stop assuming what the AI is doing and go and LOOK.
 * This panel renders the Experience Stream live, exactly as it is recorded — no summarising,
 * no prettifying, no inference. If a field is `null` it renders as `null`, because an unwired
 * observation must never be visually indistinguishable from a measured one.
 *
 * It is a pure READER: it subscribes, it never writes (except the explicit Clear button), and
 * a throw in here can never reach the stream (see `notify`). Same convention as the existing
 * `?flarexProfile=1` HUD.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  clearExperience,
  experienceStats,
  isAction,
  isDecision,
  listExperience,
  subscribeExperience,
  type ExperienceEvent,
  type ExperienceStats
} from "../../ai/experience/stream";

export function isAiThinkingShown(): boolean {
  try {
    return new URLSearchParams(window.location.search).get("aiThinkingShow") === "1";
  } catch {
    return false;
  }
}

const MONO = "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace";

const PRODUCER_COLOR: Record<string, string> = {
  ai: "#7dd3fc",
  system: "#a78bfa",
  editor: "#86efac",
  ledger: "#fcd34d"
};

function Field({ label, value }: { label: string; value: unknown }) {
  const empty =
    value === null ||
    value === undefined ||
    (Array.isArray(value) && value.length === 0) ||
    value === "";
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "flex-start", lineHeight: 1.45 }}>
      <span style={{ color: "#64748b", minWidth: 108, flexShrink: 0 }}>{label}</span>
      <span
        style={{
          color: empty ? "#475569" : "#e2e8f0",
          fontStyle: empty ? "italic" : "normal",
          whiteSpace: "pre-wrap",
          wordBreak: "break-word"
        }}
      >
        {empty
          ? value === null || value === undefined
            ? "null — not observed"
            : "(none)"
          : typeof value === "string"
            ? value
            : JSON.stringify(value, null, 1)}
      </span>
    </div>
  );
}

function EventRow({ event }: { event: ExperienceEvent }) {
  const [open, setOpen] = useState(false);
  const colour = PRODUCER_COLOR[event.producer] ?? "#cbd5e1";
  const headline = isDecision(event)
    ? `${event.payload.prompt.slice(0, 64)}${event.payload.prompt.length > 64 ? "…" : ""}`
    : isAction(event)
      ? `${event.payload.operation} · ${event.payload.initiator ?? "undeclared"}${event.payload.actionIds.length > 0 ? ` · ${event.payload.actionIds.join(", ")}` : ""}`
      : `${event.payload.reason} · build ${event.payload.buildId}`;
  const latency =
    isDecision(event) && event.payload.startedAt !== null ? `${event.t - event.payload.startedAt}ms` : null;

  return (
    <div style={{ borderTop: "1px solid #1e293b", padding: "6px 8px" }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{
          all: "unset",
          cursor: "pointer",
          display: "flex",
          gap: 8,
          width: "100%",
          alignItems: "baseline"
        }}
      >
        <span style={{ color: "#475569", minWidth: 34 }}>#{event.seq}</span>
        <span style={{ color: colour, minWidth: 96 }}>
          {event.producer}/{event.kind}
        </span>
        <span style={{ color: "#e2e8f0", flex: 1 }}>{headline}</span>
        {latency ? <span style={{ color: "#64748b" }}>{latency}</span> : null}
        <span style={{ color: "#475569" }}>τ{event.tau.toFixed(0)}</span>
        <span style={{ color: "#334155" }}>{open ? "▾" : "▸"}</span>
      </button>

      {open ? (
        <div style={{ padding: "8px 0 4px 42px", display: "grid", gap: 2 }}>
          <Field label="id" value={event.id} />
          {/* No `episode` row: episodes are DERIVED (schema v4), never stored on evidence. */}
          <Field label="session" value={event.sessionId} />
          <Field label="refs" value={event.refs} />
          <Field label="t / τ / dτ" value={`${new Date(event.t).toLocaleTimeString()}  ·  τ=${event.tau.toFixed(2)}  ·  dτ=${event.dTau.toFixed(2)}`} />
          <Field label="τ inputs" value={event.tauInputs} />
          <Field label="τ policy" value={event.tauPolicy} />
          <Field label="signals" value={event.signals.map((s) => `${s.kind}(${s.strength})${s.detail ? ` — ${s.detail}` : ""}`)} />
          {isDecision(event) ? (
            <>
              <div style={{ color: "#334155", margin: "6px 0 2px" }}>── decision payload ──</div>
              <Field label="route" value={event.payload.route} />
              <Field label="owner" value={event.payload.owner} />
              <Field label="confidence" value={event.payload.confidence} />
              <Field label="zeroTokens" value={String(event.payload.zeroTokens)} />
              <Field label="applied/failed" value={`${event.payload.applied} applied · ${event.payload.failed} failed`} />
              <Field label="startedAt" value={event.payload.startedAt} />
              <Field label="situation" value={event.payload.situation} />
              <Field label="facts" value={event.payload.factsConsulted} />
              <Field label="actions" value={event.payload.actions} />
              <Field label="candidates" value={event.payload.candidates} />
              <Field label="steps" value={event.payload.steps} />
              <Field label="notes" value={event.payload.notes} />
            </>
          ) : isAction(event) ? (
            <>
              <div style={{ color: "#334155", margin: "6px 0 2px" }}>── action payload ──</div>
              <Field label="operation" value={event.payload.operation} />
              {/* `null` renders as "not observed" — U6: undeclared is a reading, never "user". */}
              <Field label="initiator" value={event.payload.initiator} />
              <Field label="actionIds" value={event.payload.actionIds} />
              <Field label="summary" value={event.payload.summary} />
              <Field label="graphVersion" value={event.payload.graphVersion} />
              <Field label="undoDepth" value={event.payload.undoDepth} />
            </>
          ) : (
            <>
              <div style={{ color: "#334155", margin: "6px 0 2px" }}>── session payload ──</div>
              <Field label="schema" value={`v${event.payload.schemaVersion}`} />
              <Field label="buildId" value={event.payload.buildId} />
              <Field label="seatId" value={event.payload.seatId} />
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

const PANEL_W = 620;
const PLACEMENT_KEY = "orreris.oris.panel.placement.v1";

interface Placement {
  x: number;
  y: number;
  minimised: boolean;
}

/** Default: bottom-right, where it started — but clamped so it is always on screen. */
function defaultPlacement(): Placement {
  return { x: Math.max(12, window.innerWidth - PANEL_W - 12), y: Math.max(12, window.innerHeight - 420), minimised: false };
}

function loadPlacement(): Placement {
  try {
    const saved = JSON.parse(localStorage.getItem(PLACEMENT_KEY) ?? "null") as Partial<Placement> | null;
    if (saved && typeof saved.x === "number" && typeof saved.y === "number") {
      // Clamp on load: a window that shrank since last session must not strand the panel
      // off-screen where it cannot be dragged back.
      return {
        x: Math.min(Math.max(0, saved.x), Math.max(0, window.innerWidth - 120)),
        y: Math.min(Math.max(0, saved.y), Math.max(0, window.innerHeight - 40)),
        minimised: Boolean(saved.minimised)
      };
    }
  } catch {
    // fall through to the default
  }
  return defaultPlacement();
}

export function AiThinkingPanel() {
  const shown = useMemo(() => isAiThinkingShown(), []);
  const [events, setEvents] = useState<ExperienceEvent[]>([]);
  const [stats, setStats] = useState<ExperienceStats | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [placement, setPlacement] = useState<Placement>(() => (shown ? loadPlacement() : { x: 0, y: 0, minimised: false }));
  const listRef = useRef<HTMLDivElement | null>(null);
  /**
   * A pointer drag also fires `click` on the element it started from. Without this, dragging
   * the minimised pill re-opens the panel instead of moving it — which is the only thing a
   * floating pill really needs to do. Set once the pointer travels past a small threshold, so
   * a genuine click (no movement) still opens.
   */
  const draggedRef = useRef(false);

  useEffect(() => {
    if (!shown) {
      return;
    }
    try {
      localStorage.setItem(PLACEMENT_KEY, JSON.stringify(placement));
    } catch {
      // Placement is a convenience; losing it must never break the observatory.
    }
  }, [shown, placement]);

  /** Drag from the header. Pointer capture so a fast drag cannot escape the handle. */
  const startDrag = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    draggedRef.current = false;
    if ((event.target as HTMLElement).closest("[data-oris-control]")) {
      return; // let the header's own controls work; everything else is a drag handle
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const startY = event.clientY;
    let origin = { x: 0, y: 0 };
    setPlacement((current) => {
      origin = { x: current.x, y: current.y };
      return current;
    });
    const move = (moveEvent: PointerEvent) => {
      if (Math.abs(moveEvent.clientX - startX) > 4 || Math.abs(moveEvent.clientY - startY) > 4) {
        draggedRef.current = true;
      }
      setPlacement((current) => ({
        ...current,
        x: Math.min(Math.max(0, origin.x + (moveEvent.clientX - startX)), window.innerWidth - 120),
        y: Math.min(Math.max(0, origin.y + (moveEvent.clientY - startY)), window.innerHeight - 40)
      }));
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
  }, []);

  const refresh = useCallback(() => {
    setEvents(listExperience().slice(-200).reverse());
    setStats(experienceStats());
  }, []);

  useEffect(() => {
    if (!shown) {
      return;
    }
    refresh();
    return subscribeExperience(() => refresh());
  }, [shown, refresh]);

  const copyJson = useCallback(() => {
    void navigator.clipboard
      .writeText(JSON.stringify({ stats: experienceStats(), events: listExperience() }, null, 2))
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => undefined);
  }, []);

  if (!shown) {
    return null;
  }

  // MINIMISED: a small pill, not a smaller panel. The old "hide" only shrank the width to
  // 320px and stayed pinned bottom-right, which still covered the inspector's lower rows —
  // an observatory that blocks the thing you are trying to observe.
  if (placement.minimised) {
    return (
      <button
        type="button"
        onClick={() => {
          if (draggedRef.current) {
            draggedRef.current = false;
            return; // that was a drag, not a click
          }
          setPlacement((c) => ({ ...c, minimised: false }));
        }}
        onPointerDown={startDrag as unknown as React.PointerEventHandler<HTMLButtonElement>}
        title="ORIS — click to open, drag to move"
        style={{
          all: "unset",
          position: "fixed",
          left: placement.x,
          top: placement.y,
          cursor: "grab",
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "4px 9px",
          background: "#0b1220f2",
          border: "1px solid #1e293b",
          borderRadius: 999,
          boxShadow: "0 6px 20px rgba(0,0,0,.45)",
          font: `11px/1.4 ${MONO}`,
          color: "#7dd3fc",
          zIndex: 99999,
          backdropFilter: "blur(6px)"
        }}
      >
        <span style={{ width: 6, height: 6, borderRadius: 999, background: "#7dd3fc" }} />
        ORIS
        <span style={{ color: "#64748b" }}>{stats ? stats.events : 0}</span>
      </button>
    );
  }

  return (
    <div
      style={{
        position: "fixed",
        left: placement.x,
        top: placement.y,
        width: PANEL_W,
        maxHeight: collapsed ? undefined : "60vh",
        display: "flex",
        flexDirection: "column",
        background: "#0b1220f2",
        border: "1px solid #1e293b",
        borderRadius: 8,
        boxShadow: "0 12px 40px rgba(0,0,0,.55)",
        font: `11px/1.4 ${MONO}`,
        color: "#e2e8f0",
        zIndex: 99999,
        backdropFilter: "blur(6px)"
      }}
    >
      <div
        onPointerDown={startDrag}
        style={{
          display: "flex",
          gap: 8,
          alignItems: "center",
          padding: "7px 9px",
          borderBottom: "1px solid #1e293b",
          cursor: "grab",
          touchAction: "none"
        }}
      >
        <span style={{ color: "#334155", letterSpacing: 2 }}>⠿</span>
        <strong style={{ color: "#7dd3fc", letterSpacing: 0.4 }}>ORIS · what the AI is doing</strong>
        <span style={{ flex: 1 }} />
        <button type="button" data-oris-control onClick={copyJson} style={buttonStyle}>
          {copied ? "copied" : "copy json"}
        </button>
        <button
          type="button"
          data-oris-control
          onClick={() => {
            clearExperience();
            refresh();
          }}
          style={buttonStyle}
        >
          clear
        </button>
        <button type="button" data-oris-control onClick={() => setCollapsed((v) => !v)} style={buttonStyle}>
          {collapsed ? "list" : "rows"}
        </button>
        <button type="button" data-oris-control onClick={() => setPlacement((c) => ({ ...c, minimised: true }))} style={buttonStyle} title="Minimise to a pill">
          —
        </button>
      </div>

      {stats ? (
        <div style={{ padding: "6px 9px", color: "#94a3b8", borderBottom: "1px solid #1e293b", display: "flex", flexWrap: "wrap", gap: 10 }}>
          <span>{stats.events} rows</span>
          <span>{stats.decisions} decisions</span>
          <span>{stats.sessions} sessions</span>
          <span>{stats.episodes} episodes</span>
          <span>τ {stats.tau.toFixed(0)}</span>
          <span>{stats.bytesPerEvent.toFixed(0)} B/row</span>
          <span style={{ color: stats.evicted > 0 ? "#fbbf24" : undefined }}>{stats.evicted} evicted</span>
          <span style={{ color: stats.pinned > 0 ? "#fbbf24" : undefined }}>{stats.pinned} pinned</span>
          <span style={{ color: stats.factsOrphaned > 0 ? "#f87171" : undefined }}>{stats.factsOrphaned} orphan facts</span>
          <span style={{ color: stats.malformed > 0 ? "#f87171" : undefined }}>{stats.malformed} malformed</span>
        </div>
      ) : null}

      {collapsed ? null : (
        <div ref={listRef} style={{ overflowY: "auto", flex: 1 }}>
          {events.length === 0 ? (
            <div style={{ padding: 14, color: "#475569" }}>
              Nothing observed yet. Ask the AI panel to do something — every decision it makes lands here,
              newest first, with the raw record behind it.
            </div>
          ) : (
            events.map((event) => <EventRow key={event.id} event={event} />)
          )}
        </div>
      )}
    </div>
  );
}

const buttonStyle: React.CSSProperties = {
  all: "unset",
  cursor: "pointer",
  color: "#94a3b8",
  border: "1px solid #1e293b",
  borderRadius: 4,
  padding: "2px 7px"
};
