import { useMemo } from "react";
import type { ActionAnalyticsSnapshot } from "@orreris/shared";
import { readAnalytics } from "../../ai/analytics-store";
import { summarizeRouting, type RoutingSummary } from "../../ai/brain/ledger";

/**
 * Missing-Capability Dashboard (P7). Reads the persisted analytics snapshot and
 * surfaces demand: most-requested tools/effects, accepted vs rejected plan rate,
 * average execution time, failures, and the prompts that hit a missing
 * capability — the ranked backlog of what to build next.
 */
function rankedEntries(record: Record<string, number>, limit = 8): [string, number][] {
  return Object.entries(record)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit);
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function AiInsightsDashboard({ onClose }: { onClose: () => void }) {
  // Snapshot is read once on mount; the dashboard is a point-in-time view.
  const data: ActionAnalyticsSnapshot = useMemo(() => readAnalytics(), []);
  const routing: RoutingSummary = useMemo(() => summarizeRouting(), []);

  const tools = rankedEntries(data.toolDemand);
  const effects = rankedEntries(data.effectDemand);
  const actions = rankedEntries(data.actionUsage);
  const reviewed = data.plansAccepted + data.plansRejected;
  const acceptRate = reviewed === 0 ? 0 : Math.round((data.plansAccepted / reviewed) * 100);
  const avgMs = Math.round(average(data.executionMs));

  return (
    <div className="ai-insights">
      <div className="ai-insights-head">
        <strong>AI Insights</strong>
        <button type="button" className="ai-dock-close" onClick={onClose} aria-label="Back to chat">
          ✕
        </button>
      </div>

      <div className="ai-insights-stats">
        <Stat label="AI actions" value={String(data.aiGeneratedCount)} />
        <Stat label="Plan accept rate" value={reviewed === 0 ? "—" : `${acceptRate}%`} sub={`${data.plansAccepted}/${reviewed}`} />
        <Stat label="Avg run" value={data.executionMs.length === 0 ? "—" : `${avgMs}ms`} />
        <Stat label="Failed" value={String(data.failedCount)} />
        <Stat label="Rejected by registry" value={String(data.rejectedCount)} />
      </div>

      <div className="ai-insights-section">
        <h4>Brain routing (last {routing.total} requests)</h4>
        {routing.total === 0 ? (
          <p className="ai-insights-empty">No routed requests yet — ask the AI something.</p>
        ) : (
          <div className="ai-insights-stats">
            <Stat
              label="Resolved instantly"
              value={`${Math.round(routing.instantShare * 100)}%`}
              sub={`${routing.instant}/${routing.total} · ${Math.round(routing.avgInstantMs)}ms avg`}
            />
            <Stat label="Model runs" value={String(routing.total - routing.instant)} sub={routing.avgLlmMs > 0 ? `${(routing.avgLlmMs / 1000).toFixed(1)}s avg` : undefined} />
            <Stat label="Est. tokens spent" value={routing.estTokensSpent.toLocaleString()} />
            <Stat label="Est. tokens saved" value={routing.estTokensSaved.toLocaleString()} sub="by local tiers" />
          </div>
        )}
      </div>

      <Section title="Most-requested tools" entries={tools} empty="No tool requests yet." />
      <Section title="Most-requested effects" entries={effects} empty="No effect requests yet." />
      <Section title="Timeline actions used" entries={actions} empty="No actions applied yet." />

      <div className="ai-insights-section">
        <h4>Missing capabilities ({data.unsupported.length})</h4>
        {data.unsupported.length === 0 ? (
          <p className="ai-insights-empty">Every request mapped to something Orreris can do. 🎉</p>
        ) : (
          <ul className="ai-insights-missing">
            {[...data.unsupported]
              .reverse()
              .slice(0, 12)
              .map((entry, index) => (
                <li key={`${entry.at}_${index}`}>
                  <span className="ai-insights-missing-cap">{entry.missingCapability}</span>
                  <span className="ai-insights-missing-prompt">“{entry.prompt}”</span>
                </li>
              ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string | undefined }) {
  return (
    <div className="ai-insights-stat">
      <span className="ai-insights-stat-value">{value}</span>
      <span className="ai-insights-stat-label">{label}</span>
      {sub ? <span className="ai-insights-stat-sub">{sub}</span> : null}
    </div>
  );
}

function Section({ title, entries, empty }: { title: string; entries: [string, number][]; empty: string }) {
  const max = entries[0]?.[1] ?? 1;
  return (
    <div className="ai-insights-section">
      <h4>{title}</h4>
      {entries.length === 0 ? (
        <p className="ai-insights-empty">{empty}</p>
      ) : (
        <ul className="ai-insights-bars">
          {entries.map(([name, count]) => (
            <li key={name} className="ai-insights-bar-row">
              <span className="ai-insights-bar-label">{name}</span>
              <span className="ai-insights-bar-track">
                <span className="ai-insights-bar-fill" style={{ width: `${Math.max(6, (count / max) * 100)}%` }} />
              </span>
              <span className="ai-insights-bar-count">{count}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
