import { useCallback, useMemo, useState } from "react";
import { loadFacts, rememberFact, forgetFact, type MemoryFact, type MemoryValue } from "../../ai/memory";

/**
 * Phase 15 — Memory Panel UI + trust controls. A surface where the user sees
 * exactly what Orreris remembers (the creator + project facts behind `loadFacts()`)
 * and can curate it: **Edit** a value (pins it), **Forget** it, or pull a creator
 * default down to **this project only**. Low-confidence inferred facts (below the
 * retriever's steer threshold) surface as a gentle "save as your default?" nudge
 * instead of being silently assumed.
 *
 * Pure client, zero AI cost. It never mutates the timeline and never touches the
 * planner/executor — it only reads + writes the local memory store (which
 * best-effort syncs to `/api/memory`). Mirrors the AiInsightsDashboard / ByoKeyPanel
 * full-panel pattern (takes `onClose`).
 */

// Below this confidence an inferred fact doesn't steer the planner (see
// memory-retriever MIN_CONFIDENCE) — so it's a candidate for the save-as-default nudge.
const STEER_THRESHOLD = 0.45;

// Human labels for the well-known preference keys; unknown keys fall back to the raw key.
const KEY_LABELS: Record<string, string> = {
  captionStyle: "Caption style",
  colorGrade: "Color grade",
  qualityMode: "Render quality",
  language: "Language",
  permissionMode: "Permission mode",
  textColor: "Text color"
};

function labelFor(key: string): string {
  return KEY_LABELS[key] ?? key;
}

function formatValue(value: MemoryValue): string {
  if (Array.isArray(value)) return value.join(", ");
  return String(value);
}

/** Re-parse an edited text value back to the original fact's type. */
function parseValue(text: string, previous: MemoryValue): MemoryValue {
  if (Array.isArray(previous)) {
    return text
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
  }
  if (typeof previous === "number") {
    const next = Number(text);
    return Number.isFinite(next) ? next : previous;
  }
  if (typeof previous === "boolean") {
    return /^(true|yes|on|1)$/i.test(text.trim());
  }
  return text;
}

export function MemoryPanel({ projectId, onClose }: { projectId?: string | undefined; onClose: () => void }) {
  const [facts, setFacts] = useState<MemoryFact[]>(() => loadFacts());

  const refresh = useCallback(() => setFacts(loadFacts()), []);

  const { projectFacts, creatorFacts, nudges } = useMemo(() => {
    // Style scope is Phase 12; the panel curates the tiers the user actually steers.
    const relevant = facts.filter((fact) => fact.scope === "creator" || fact.scope === "project");
    const nudgeFacts = relevant.filter((fact) => fact.source === "inferred" && fact.confidence < STEER_THRESHOLD);
    const steady = relevant.filter((fact) => !(fact.source === "inferred" && fact.confidence < STEER_THRESHOLD));
    return {
      nudges: nudgeFacts,
      projectFacts: steady.filter((fact) => fact.scope === "project" && fact.projectId === projectId),
      creatorFacts: steady.filter((fact) => fact.scope === "creator")
    };
  }, [facts, projectId]);

  const handleEdit = useCallback(
    (fact: MemoryFact, text: string) => {
      rememberFact({ ...fact, value: parseValue(text, fact.value), source: "explicit" });
      refresh();
    },
    [refresh]
  );

  const handleForget = useCallback(
    (fact: MemoryFact) => {
      forgetFact({ scope: fact.scope, projectId: fact.projectId, key: fact.key });
      refresh();
    },
    [refresh]
  );

  const handleScopeToProject = useCallback(
    (fact: MemoryFact) => {
      if (!projectId) return;
      rememberFact({ ...fact, scope: "project", projectId, source: "explicit" });
      refresh();
    },
    [projectId, refresh]
  );

  const handleSaveDefault = useCallback(
    (fact: MemoryFact) => {
      rememberFact({ ...fact, source: "explicit" });
      refresh();
    },
    [refresh]
  );

  const isEmpty = nudges.length === 0 && projectFacts.length === 0 && creatorFacts.length === 0;

  return (
    <div className="ai-memory">
      <div className="ai-memory-head">
        <strong>What Orreris remembers</strong>
        <button type="button" className="ai-dock-close" onClick={onClose} aria-label="Back to chat">
          ✕
        </button>
      </div>
      <p className="ai-memory-note">
        Orreris uses these to fill in your usual style. Everything here is editable — pin it, forget it, or keep it to this
        project only. Stored on this device and synced to your account when signed in.
      </p>

      {isEmpty ? (
        <p className="ai-memory-empty">Nothing remembered yet. As you apply edits, Orreris learns your preferences here.</p>
      ) : null}

      {nudges.length > 0 ? (
        <div className="ai-memory-section ai-memory-nudges">
          <h4>Orreris noticed</h4>
          {nudges.map((fact) => (
            <div key={`${fact.scope}|${fact.projectId ?? ""}|${fact.key}`} className="ai-memory-nudge">
              <span className="ai-memory-nudge-text">
                Save <strong>{labelFor(fact.key)}</strong> = <em>{formatValue(fact.value)}</em> as your default?
              </span>
              <div className="ai-memory-nudge-actions">
                <button type="button" className="primary" onClick={() => handleSaveDefault(fact)}>
                  Save as default
                </button>
                <button type="button" className="ghost" onClick={() => handleForget(fact)}>
                  Dismiss
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {projectFacts.length > 0 ? (
        <FactSection
          title="This project"
          facts={projectFacts}
          onEdit={handleEdit}
          onForget={handleForget}
        />
      ) : null}

      {creatorFacts.length > 0 ? (
        <FactSection
          title="About you"
          facts={creatorFacts}
          onEdit={handleEdit}
          onForget={handleForget}
          {...(projectId ? { onScopeToProject: handleScopeToProject } : {})}
        />
      ) : null}
    </div>
  );
}

function FactSection({
  title,
  facts,
  onEdit,
  onForget,
  onScopeToProject
}: {
  title: string;
  facts: MemoryFact[];
  onEdit: (fact: MemoryFact, text: string) => void;
  onForget: (fact: MemoryFact) => void;
  onScopeToProject?: (fact: MemoryFact) => void;
}) {
  return (
    <div className="ai-memory-section">
      <h4>{title}</h4>
      <ul className="ai-memory-list">
        {facts.map((fact) => (
          <FactRow
            key={`${fact.scope}|${fact.projectId ?? ""}|${fact.key}`}
            fact={fact}
            onEdit={onEdit}
            onForget={onForget}
            {...(onScopeToProject ? { onScopeToProject } : {})}
          />
        ))}
      </ul>
    </div>
  );
}

function FactRow({
  fact,
  onEdit,
  onForget,
  onScopeToProject
}: {
  fact: MemoryFact;
  onEdit: (fact: MemoryFact, text: string) => void;
  onForget: (fact: MemoryFact) => void;
  onScopeToProject?: (fact: MemoryFact) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(() => formatValue(fact.value));

  const commit = () => {
    if (draft.trim() && draft !== formatValue(fact.value)) {
      onEdit(fact, draft);
    }
    setEditing(false);
  };

  return (
    <li className="ai-memory-row">
      <div className="ai-memory-row-main">
        <span className="ai-memory-key">{labelFor(fact.key)}</span>
        {editing ? (
          <input
            className="ai-memory-edit"
            value={draft}
            autoFocus
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === "Enter") commit();
              if (event.key === "Escape") {
                setDraft(formatValue(fact.value));
                setEditing(false);
              }
            }}
          />
        ) : (
          <span className="ai-memory-value">{formatValue(fact.value)}</span>
        )}
      </div>
      <div className="ai-memory-meta">
        <span className={`ai-memory-source ai-memory-source-${fact.source}`}>
          {fact.source === "explicit" ? "Pinned" : "Learned"}
        </span>
        <span className="ai-memory-confidence" title={`Confidence ${Math.round(fact.confidence * 100)}%`}>
          <span className="ai-memory-confidence-fill" style={{ width: `${Math.round(fact.confidence * 100)}%` }} />
        </span>
      </div>
      <div className="ai-memory-actions">
        {!editing ? (
          <button type="button" className="ghost" onClick={() => setEditing(true)}>
            Edit
          </button>
        ) : null}
        {onScopeToProject ? (
          <button type="button" className="ghost" onClick={() => onScopeToProject(fact)} title="Use this value for the current project only">
            This project only
          </button>
        ) : null}
        <button type="button" className="ghost ai-memory-forget" onClick={() => onForget(fact)}>
          Forget
        </button>
      </div>
    </li>
  );
}
