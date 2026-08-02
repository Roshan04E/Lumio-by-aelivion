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

export function AiThinkingPanel() {
  const shown = useMemo(() => isAiThinkingShown(), []);
  const [events, setEvents] = useState<ExperienceEvent[]>([]);
  const [stats, setStats] = useState<ExperienceStats | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [copied, setCopied] = useState(false);
  const listRef = useRef<HTMLDivElement | null>(null);

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

  return (
    <div
      style={{
        position: "fixed",
        right: 12,
        bottom: 12,
        width: collapsed ? 320 : 620,
        maxHeight: collapsed ? undefined : "70vh",
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
      <div style={{ display: "flex", gap: 8, alignItems: "center", padding: "7px 9px", borderBottom: "1px solid #1e293b" }}>
        <strong style={{ color: "#7dd3fc", letterSpacing: 0.4 }}>ORIS · what the AI is doing</strong>
        <span style={{ flex: 1 }} />
        <button type="button" onClick={copyJson} style={buttonStyle}>
          {copied ? "copied" : "copy json"}
        </button>
        <button
          type="button"
          onClick={() => {
            clearExperience();
            refresh();
          }}
          style={buttonStyle}
        >
          clear
        </button>
        <button type="button" onClick={() => setCollapsed((v) => !v)} style={buttonStyle}>
          {collapsed ? "open" : "hide"}
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
