/**
 * ORIS Stage A — the Experience Stream (O1). See ORIS_RESEARCH_PROGRAMME.md §2, §11, §12.
 *
 * The habitat's fact store is deliberately AMNESIC: one live fact per (type, target),
 * invalidated the moment its inputs change. That is right for facts and fatal for a mind —
 * nothing in it can answer "what happened, and in what order". This module is the missing
 * history substrate: an append-only, bounded, persisted log of what the runtime actually did.
 *
 * Stage A is an OBSERVATORY, not intelligence. Nothing here adapts, learns, or decides.
 *
 * ── ONE LOG, MANY PRODUCERS ──────────────────────────────────────────────────────────────
 * The stream is a single ordered journal with several producers, NOT several streams:
 *
 *     ai      → decision events        (wired: recordDecisionTrace)
 *     system  → session events         (wired: hydration / reload)
 *     editor  → action events          (wired: the composition write choke point, ADR-017)
 *     ledger  → prediction events      (Stage B — reserved, not yet wired)
 *
 * One log preserves global ordering and keeps replay a single pass. That is why events are
 * ENVELOPES with typed payloads: a decision-shaped record would force `applied`/`failed`
 * onto outcome and session rows where they are meaningless. Splitting into parallel streams
 * would be worse still — it would make "what happened next" a merge problem forever.
 *
 * ── TWO RULES THAT CARRY THE FILE ────────────────────────────────────────────────────────
 * Both exist so the corpus outlives our current guesses (ORIS_RESEARCH_PROGRAMME.md §4.1 —
 * segmentation is model SELECTION, not labelling; §12 — observations over classifications):
 *
 *  1. STORE THE FEATURES, NOT JUST THE DECISION. Every WITNESSED boundary signal is written
 *     alongside every event, whether or not today's provisional segmenter used it. That is
 *     what lets Stage C re-segment a year-old corpus under a hypothesis nobody has had yet,
 *     instead of re-collecting the data.
 *     ADR-016 I3 narrowed this: a signal an EMITTER witnessed (project switched, export
 *     started) is evidence; a signal the stream COMPUTES from other rows is a derivation and
 *     belongs in `segment()`. Schema v5 moved `intent-class-change` and `outcome-error` to
 *     read time for exactly that reason — see `deriveReadTimeSignals`.
 *  2. STORE τ'S INPUTS, NOT JUST τ. Subjective time (ORIS_TIME.md §1) is currently computed
 *     with its surprise term STUBBED — there is no Prediction Ledger yet, so no error signal
 *     exists. `tauInputs` keeps the raw terms so `recomputeTau` can re-derive the whole
 *     stream under the real model later. The stub is recorded honestly as `surprise: null`.
 *
 * Node-safe (localStorage guarded, same convention as the fact store). Covered by
 * `pnpm --filter @orreris/web experience:eval`.
 */

import type { DecisionTrace } from "../decision-trace";

/**
 * Bumped whenever an envelope or payload shape changes. Stored per SESSION, not per event.
 *
 * v6 is ADDITIVE and reads v4/v5 rows unchanged: it adds the `action` kind (ADR-017) and the
 * session coverage record. v5 stopped WRITING two derived signals and added one session reason. `STORAGE_KEY` therefore stays at v4 — the key tracks readability
 * generations, not schema versions, and discarding a readable corpus to renumber a key would
 * be exactly the silent shrinkage ADR-016 I9 forbids.
 */
export const SCHEMA_VERSION = 6;

// ── Envelope ─────────────────────────────────────────────────────────────────────────────

/** Reserved kinds are declared but unwired — their payload shapes are Stage B's to settle. */
export type EventKind = "decision" | "session" | "action";
export type Producer = "ai" | "editor" | "ledger" | "system";

/**
 * ORIS-18 — **every producer observes only its own boundary.** A producer may never
 * synthesise another producer's observation: the `ai` producer cannot emit
 * `outcome: accepted` because it does not observe the user's reaction, and the `editor`
 * producer cannot emit `claimedConfidence` because it never possessed that claim.
 *
 * This table documents the boundary and guards it at runtime, but the PRIMARY enforcement is
 * structural: there is no generic exported `append()`. Each producer gets one narrow typed
 * entry point (`appendDecisionEvent` for `ai`; `openSession` for `system`; future
 * `appendOutcomeEvent` for `editor`, `appendPredictionEvent` for `ledger`), so a producer
 * literally cannot reach for a kind it has no standing to report.
 */
export const PRODUCER_KINDS: Record<Producer, EventKind[]> = {
  ai: ["decision"],
  system: ["session"],
  // ADR-017: the editor witnesses COMMITTED MUTATIONS. Not outcomes — nobody witnesses
  // "accepted" or "rejected", so there is no outcome producer and there will not be one.
  editor: ["action"],
  ledger: [] // reserved: "prediction" — Stage B, unwired
};

/** The raw terms τ was computed from, kept so τ is re-derivable (rule 2 above). */
export interface TauInputs {
  /** Base cost of the event kind. */
  base: number;
  /** Consequence: how much of the world this event actually moved. */
  consequence: number;
  /**
   * Surprise weight. NULL until the Prediction Ledger (O2) exists — τ currently advances on
   * consequential change alone, which is an ACKNOWLEDGED approximation of ORIS_TIME.md §1,
   * not an implementation of it. H2 cannot be tested until this is a real number.
   */
  surprise: number | null;
}

interface Envelope<K extends EventKind, P> {
  id: string;
  /** Monotonic across the whole stream; survives eviction (never renumbered). */
  seq: number;
  /**
   * Join key for session-scoped facts. Witnessed: this row WAS written during that session.
   * (Contrast `episodeId`, removed in schema v4 — see the note below.)
   */
  sessionId: string;
  /** Wall clock (ORIS_TIME.md §1: `t` governs communication and scheduling). */
  t: number;
  /**
   * Subjective time at append (`τ` governs decay, recency, consolidation). This is a
   * DERIVATION, not an observation — so L12 requires it to name the policy that produced it.
   * `tauInputs` alone was not enough: it made τ recomputable but left the stored value
   * unattributable ("τ = 128, according to… something").
   */
  tau: number;
  dTau: number;
  tauInputs: TauInputs;
  tauPolicy: string;
  producer: Producer;
  kind: K;
  /**
   * Ids of rows this row depends on. ORIS-17: **no dangling references** — a referenced row
   * is never evicted before every row referencing it. Today the only reference is
   * decision → session (for the buildId/seatId/schemaVersion join); tomorrow it is
   * outcome → decision and prediction → decision, and the rule is already in place for them.
   *
   * RESERVED — typed relations. Anonymous edges are sufficient while the runtime only needs
   * "do not evict this". Research will eventually need *"every outcome attached to a
   * prediction"*, which is a question about edge TYPE, not edge existence, and following
   * every edge to answer it does not scale. The migration is `string[]` →
   * `{ target: string; relation: "observes" | "predicts" | "scopes" | … }[]`, and it is
   * deliberately NOT taken today: with one relation in existence, a type would be a
   * classification invented ahead of its observations.
   */
  refs: string[];
  /**
   * Envelope-level, deliberately: segmentation must run across ALL event kinds. An outcome
   * or session row can carry a boundary signal exactly like a decision row can.
   */
  signals: BoundarySignal[];
  payload: P;
}

/**
 * SCHEMA v4 — `episodeId` and `openedEpisode` were REMOVED from the envelope.
 *
 * They failed the admission test (ORIS-19 / calculus L11): a producer never witnesses an
 * episode. It witnesses signals, ordering, and time; an episode boundary is a *function over
 * those under a segmentation policy*, and two honest observers running different policies
 * would disagree about where one begins. Carrying them on the evidence envelope mixed
 * derivation into evidence in the same row.
 *
 * Episodes are now purely `segment(events, policy)` — which also deleted the write-time
 * episode state machine outright. The provisional cut is just another policy
 * (`PROVISIONAL_POLICY`) applied on read, with no privileged status in the corpus.
 */

/**
 * σ — the situation (calculus phase ②). **State, not an event.** A situation is not something
 * that *happened*; it is simply true until changed, which is exactly why it persists across
 * ticks and why that persistence IS the core self (ORIS_ARCHITECTURE.md §4).
 *
 * So it is set, not noted, and snapshotted at append time. `null` means NOT OBSERVED and is
 * deliberately distinguishable from any real value — an unwired field must never be
 * indistinguishable from a measured absence.
 */
export interface Situation {
  projectId: string | null;
  compositionHash: string | null;
  mode: string | null;
  focusPanel: string | null;
  selectionCount: number | null;
  targetLayerIds: string[];
  activeTool: string | null;
}

/**
 * A fact as it stood WHEN CONSULTED (calculus phase ①). The fact store cascade-invalidates,
 * so the value at decision time is destroyed the moment its inputs change — this snapshot is
 * the only thing that survives (ORIS_RESEARCH_PROGRAMME.md §12.1 item 2).
 */
export interface ConsultedFact {
  factId: string;
  type: string;
  target: string;
  value: unknown;
  confidence: number;
  observerId: string;
  observerVersion: number;
  inputSignature: string;
  accessPath: string;
  costMs: number;
}

/** Who made the claim — structured, so attribution never has to parse a display string. */
export interface DecisionOwner {
  tier: string;
  ruleId: string;
  recipeId: string | null;
  provider: string | null;
}

/** One executed action (calculus phase ⑤), structured rather than prose. */
export interface DecisionAction {
  actionId: string;
  targetLayerIds: string[];
  ok: boolean;
  error: string | null;
}

/** A hypothesis that was considered — including the ones NOT chosen (phase ④). */
export interface DecisionCandidate {
  id: string;
  score: number;
  chosen: boolean;
  whyRejected: string | null;
}

export interface DecisionPayload {
  prompt: string;
  route: string;
  zeroTokens: boolean;
  notes: string[];
  steps: string[];
  applied: number;
  failed: number;
  /** ② — snapshotted from standing state at append time. */
  situation: Situation;
  /** ① — scoped to THIS decision and to no other (see `beginDecision`). */
  factsConsulted: ConsultedFact[];
  /** ④/⑦ — `null` until wired. */
  owner: DecisionOwner | null;
  /** ④ — the claim. H5 (calibration) is impossible without it. */
  confidence: { label: string; percent: number | null } | null;
  /**
   * ⑤ — start of the decision. Kept as a TIMESTAMP PAIR with `t` (the finish) rather than a
   * scalar duration: a scalar destroys temporal overlap, and overlap is what lets a slow
   * decision later be correlated with an interruption, a decode stall, or another decision.
   * `latencyMs` is derivable from the pair; the pair is not recoverable from the scalar.
   */
  startedAt: number | null;
  /** ⑤ — structured; `steps` stays as the human-readable rendering. */
  actions: DecisionAction[];
  /** ④ — the counterfactuals. The most irrecoverable class in the system. */
  candidates: DecisionCandidate[];
}

/**
 * Session-scoped facts live HERE, not on every event — they do not change within a session,
 * so duplicating them per row is denormalisation that H7 pays for forever
 * (ORIS_RESEARCH_PROGRAMME.md §12.1 items 11–13, normalised onto their natural key).
 */
export interface SessionPayload {
  /**
   * ADR-016 I10 — error paths may not fabricate observations. `storage-unreadable` exists
   * because the corrupt-storage path previously recorded itself as `cold-start`: a reload
   * whose history could not be read, asserting it was a first-ever launch. That the storage
   * read threw is witnessed; that this was a cold start was not.
   */
  reason: "cold-start" | "reload" | "storage-unreadable";
  schemaVersion: number;
  /** Which BODY this was — ORIS_SELF.md §6: an upgrade is an autobiographical event. */
  buildId: string;
  /** Stable, local, non-PII. An unlabelled multi-user corpus is unpartitionable forever. */
  seatId: string;
  startedAt: number;
}

/**
 * What the EDITOR witnesses when the composition changes (ADR-017 U1–U11).
 *
 * Every field is observed at the composition write choke point. Nothing here is derived, and
 * nothing here is an interpretation: there is no outcome class, no quality judgement, no
 * confidence, and no causal reference — because no producer witnesses any of those (ORIS-19).
 */
export interface ActionPayload {
  /**
   * Which affordance produced the commit. WITNESSED, not classified: an edit, an undo and a
   * redo arrive through different call paths, and the caller that took one knows which.
   *
   * U5: an undo is recorded as an OCCURRENCE. That it happened is witnessed; *what it undid*
   * is not, because the history stack holds whole-composition snapshots rather than commits.
   * "The user rejected the AI" is therefore derived at read time, never stored.
   */
  operation: "commit" | "undo" | "redo";
  /**
   * U6 — declared by callers that genuinely know; `null` means UNDECLARED, and never "user".
   * The choke point does not witness authorship: the AI's commits arrive through the same
   * function as every human edit. Treating an omitted declaration as evidence of a human is
   * the I10 fabrication pattern, so absence stays absence and attribution is derived on read,
   * licensed by the session's coverage record.
   */
  initiator: "ai" | "user" | null;
  /**
   * U7 — the registry actions this commit carried, where the caller kept their identity.
   * A LIST because one commit may carry several; a scalar would silently keep only the last.
   * Empty means none was declared, which is again a reading and not a gap.
   */
  actionIds: string[];
  /** Human-readable, for explainability. Never parsed (ADR-015 D4). */
  summary: string | null;
  /** Graph version after the write — witnessed, and an independent replay cross-check. */
  graphVersion: number;
  /** Undo depth after the operation — witnessed; lets a replay verify the history math. */
  undoDepth: number;
}

export type DecisionEvent = Envelope<"decision", DecisionPayload>;
export type SessionEvent = Envelope<"session", SessionPayload>;
export type ActionEvent = Envelope<"action", ActionPayload>;
export type ExperienceEvent = DecisionEvent | SessionEvent | ActionEvent;

export function isDecision(event: ExperienceEvent): event is DecisionEvent {
  return event.kind === "decision";
}

export function isSession(event: ExperienceEvent): event is SessionEvent {
  return event.kind === "session";
}

export function isAction(event: ExperienceEvent): event is ActionEvent {
  return event.kind === "action";
}

// ── Signals ──────────────────────────────────────────────────────────────────────────────

/**
 * Candidate episode-boundary signals (ORIS_TIME.md §3). The anti-signals from ORIS_TIME.md §3
 * are deliberately absent: a clarify question or a pause to watch playback must NOT be logged
 * as a boundary candidate.
 *
 * ── WITNESSED vs DERIVED (ADR-016 I3) ────────────────────────────────────────────────────
 * Only kinds an EMITTER directly witnesses are ever written to the corpus. The rest are
 * computed by `segment()` from stored evidence, under the policy that asked for them:
 *
 *   written   session-start, project-switch, export-started, save, timeline-jump,
 *             workspace-change, undo-cluster        ← something happened at an emitter
 *   derived   idle-gap, intent-class-change, outcome-error, undo-cluster*
 *
 * `undo-cluster` appears in both: a single undo is witnessed, a *cluster* is a policy over
 * several. Only the former may ever be emitted.
 *
 * KNOWN DEFECT, not yet fixed — `strength` fails the same test. It is a prior about how much
 * a signal kind matters, not a property of the occurrence, and two honest observers disagree
 * about whether a project switch is "strong". It belongs on the policy, not the row. Removing
 * it changes the envelope, so it is deliberately left for an explicit governance decision
 * rather than taken silently.
 */
export type BoundarySignalKind =
  | "session-start"
  | "project-switch"
  | "export-started"
  | "save"
  | "idle-gap"
  | "intent-class-change"
  | "timeline-jump"
  | "workspace-change"
  | "undo-cluster"
  | "outcome-error";

export type SignalStrength = "strong" | "medium" | "weak";

export interface BoundarySignal {
  kind: BoundarySignalKind;
  at: number;
  strength: SignalStrength;
  detail: string;
}

export interface EpisodeSummary {
  id: string;
  startedAt: number;
  endedAt: number;
  startedTau: number;
  endedTau: number;
  eventCount: number;
  applied: number;
  failed: number;
  openReason: BoundarySignalKind;
}

// ── Configuration ────────────────────────────────────────────────────────────────────────

const STORAGE_KEY = "orreris.oris.experience.v4";
const SEAT_KEY = "orreris.oris.seat.v1";
const PERSIST_DEBOUNCE_MS = 750;
/** ORIS-9: every store has a ceiling. */
const MAX_EVENTS = 1500;

/** Wall clock, deliberately: an absence is measured in `t`, not `τ` (ORIS_TIME.md §6.6). */
const IDLE_GAP_MS = 30 * 60 * 1000;

/**
 * SUPERSEDED, RETAINED (ADR-016 I8). v1 read `idle-gap` from a signal written into the
 * envelope; v2 computes the gap itself. A policy identifier that no longer resolves to a
 * runnable policy is a decoration, not a citation — so v1 stays here, runnable, and any
 * derivation attributed to it remains reproducible. It is superseded, never deleted.
 */
export const PROVISIONAL_POLICY_V1: SegmentationPolicy = {
  id: "provisional.strong-signals.v1",
  openOn: ["session-start", "project-switch", "export-started", "idle-gap"],
  idleGapMs: 0,
  fixedEvents: 0,
  fixedWindowMs: 0
};

export const PROVISIONAL_POLICY_ID = "provisional.strong-signals.v2";

/**
 * The provisional segmentation cut. Applied ON READ like every other policy — it has no
 * privileged status in the corpus and writes nothing (schema v4).
 *
 * v2 (schema v5): the idle gap is now the policy's own threshold rather than a signal the
 * writer stamped onto rows. Same boundaries, but the 30-minute judgement lives with the
 * policy that holds it instead of being frozen into the corpus.
 */
export const PROVISIONAL_POLICY: SegmentationPolicy = {
  id: PROVISIONAL_POLICY_ID,
  openOn: ["session-start", "project-switch", "export-started"],
  idleGapMs: IDLE_GAP_MS,
  fixedEvents: 0,
  fixedWindowMs: 0
};

/**
 * SUPERSEDED, RETAINED (ADR-016 I8). v1 covered two producers; v2 extends the same
 * consequence-only model to the editor's action rows. Rows written under v1 keep naming v1,
 * and v1 stays here so their τ remains reproducible — a policy id that no longer resolves to a
 * runnable policy is a decoration, not a citation.
 */
export const TAU_POLICY_V1_ID = "tau.consequence-only.v1";

/** The τ model that produced stored `tau`/`dTau` values. Bumped when the model changes. */
export const TAU_POLICY_ID = "tau.consequence-only.v2";

let buildId = "unknown";
let configuredSeatId = "";

/**
 * Set by the app at startup. Deliberately injected rather than read from `import.meta.env`
 * so this module stays node-safe and pure — and so an unknown build is recorded HONESTLY as
 * "unknown" rather than silently faked.
 */
export function configureExperience(config: { buildId?: string; seatId?: string }): void {
  if (config.buildId) {
    buildId = config.buildId;
  }
  if (config.seatId) {
    configuredSeatId = config.seatId;
  }
}

function resolveSeatId(): string {
  if (configuredSeatId) {
    return configuredSeatId;
  }
  try {
    if (typeof localStorage !== "undefined") {
      const existing = localStorage.getItem(SEAT_KEY);
      if (existing) {
        return existing;
      }
      const minted = `seat-${Math.random().toString(36).slice(2, 10)}`;
      localStorage.setItem(SEAT_KEY, minted);
      return minted;
    }
  } catch {
    // fall through
  }
  return "seat-ephemeral";
}

// ── State ────────────────────────────────────────────────────────────────────────────────

interface StreamState {
  events: ExperienceEvent[];
  nextSeq: number;
  tau: number;
  evicted: number;
  sessionId: string;
  /** The row every event in this session `refs` — the join target ORIS-17 conserves. */
  sessionEventId: string;
}

const state: StreamState = {
  events: [],
  nextSeq: 1,
  tau: 0,
  evicted: 0,
  sessionId: "",
  sessionEventId: ""
};

let hydrated = false;
let persistTimer: ReturnType<typeof setTimeout> | undefined;
/** Signals emitted by the app since the last event; drained on the next append. */
let pendingSignals: BoundarySignal[] = [];
/** Rows refused on load because they were malformed. Counted, never silently dropped (I9). */
let malformedDropped = 0;
let sessionCounter = 0;

function ensureHydrated(): void {
  if (hydrated) {
    return;
  }
  hydrated = true;
  let hadPriorHistory = false;
  let storageUnreadable = false;
  try {
    if (typeof localStorage !== "undefined") {
      const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
      if (parsed && typeof parsed === "object") {
        const saved = parsed as Partial<StreamState>;
        if (Array.isArray(saved.events)) {
          state.events = saved.events.filter(
            (event): event is ExperienceEvent =>
              !!event && typeof event.id === "string" && typeof event.seq === "number" && !!event.payload
          );
          // ADR-016 I9 — a refused row is COUNTED, never silently dropped. This filter used
          // to discard malformed rows invisibly, which made the corpus quietly smaller than
          // it reported and corrupted every coverage-, rate-, and growth-based conclusion
          // drawn from it. A corpus that silently shrinks is worse than one that loudly breaks.
          malformedDropped += saved.events.length - state.events.length;
          hadPriorHistory = state.events.length > 0;
        }
        state.nextSeq = typeof saved.nextSeq === "number" ? saved.nextSeq : state.events.length + 1;
        state.tau = typeof saved.tau === "number" ? saved.tau : 0;
        state.evicted = typeof saved.evicted === "number" ? saved.evicted : 0;
      }
    }
  } catch {
    // ADR-016 I10 — the error path may not fabricate an observation. That the read threw is
    // witnessed; that this was a first-ever launch is not, and recording it as `cold-start`
    // (the previous behaviour) asserted exactly that.
    state.events = [];
    storageUnreadable = true;
  }
  if (malformedDropped > 0) {
    console.warn(`[oris] ${malformedDropped} malformed row(s) refused on load — see experienceStats().malformed`);
  }
  // A reload is always a new session AND a new episode: the previous one ended for reasons
  // we did not observe.
  openSession(storageUnreadable ? "storage-unreadable" : hadPriorHistory ? "reload" : "cold-start");
}

function schedulePersist(): void {
  if (persistTimer !== undefined) {
    return;
  }
  persistTimer = setTimeout(() => {
    persistTimer = undefined;
    try {
      if (typeof localStorage !== "undefined") {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      }
    } catch {
      // Quota/private mode — the in-memory stream still works this session. Deliberately not
      // silently trimming to fit: a corpus that shrinks itself without saying so corrupts
      // every growth measurement H7 depends on.
    }
  }, PERSIST_DEBOUNCE_MS);
}

// ── τ ────────────────────────────────────────────────────────────────────────────────────

const TAU_BASE = 1;

/** Pure: τ advance for one event. Exported so eval and Stage C use the SAME function. */
export function tauAdvance(inputs: TauInputs): number {
  return inputs.base * inputs.consequence * (inputs.surprise ?? 1);
}

/**
 * Re-derive the whole stream's τ under a different model. This is the point of `tauInputs`:
 * when the Prediction Ledger lands, H2 is tested by recomputing an EXISTING corpus rather
 * than waiting a year for a new one.
 */
export function recomputeTau(
  events: readonly ExperienceEvent[],
  model: (inputs: TauInputs, event: ExperienceEvent) => number
): ExperienceEvent[] {
  let tau = 0;
  return events.map((event) => {
    const dTau = model(event.tauInputs, event);
    tau += dTau;
    return { ...event, dTau, tau };
  });
}

// ── Signal emission ──────────────────────────────────────────────────────────────────────

/**
 * Report a candidate boundary signal from anywhere in the app. Buffered and attached to the
 * next event, so emitters never need to know about episodes, τ, or the stream's shape.
 *
 * Emitters still to wire (Stage A tail): project switch, export start, save, timeline jump,
 * workspace change, undo cluster. Until then those kinds simply never appear in the corpus —
 * an absence Stage C must treat as missing data, NOT as a negative observation.
 */
export function noteBoundarySignal(
  kind: BoundarySignalKind,
  detail = "",
  strength: SignalStrength = "strong"
): void {
  pendingSignals.push({ kind, at: Date.now(), strength, detail });
}

// ── Situation: standing state, not an event ──────────────────────────────────────────────

const EMPTY_SITUATION: Situation = {
  projectId: null,
  compositionHash: null,
  mode: null,
  focusPanel: null,
  selectionCount: null,
  targetLayerIds: [],
  activeTool: null
};

let situation: Situation = { ...EMPTY_SITUATION };

/**
 * Update the standing situation. **Set, not noted** — buffering would imply "this happened",
 * and a situation is not an occurrence; it is true until changed. Merged, so a caller that
 * only knows the focus panel does not have to invent the rest.
 *
 * UNWIRED as of Stage A slice 1: no editor call sites exist yet, so every field is `null` and
 * Stage C must read that as MISSING DATA, never as a measured absence.
 */
export function setSituation(partial: Partial<Situation>): void {
  situation = { ...situation, ...partial };
}

export function getSituation(): Situation {
  return { ...situation, targetLayerIds: [...situation.targetLayerIds] };
}

// ── Fact scope: a fact belongs to exactly one decision ───────────────────────────────────

let openScope: { label: string; facts: ConsultedFact[] } | null = null;
let factsOrphaned = 0;

/**
 * Open a fact-collection scope for one decision (calculus phase ①).
 *
 * > **Invariant: a fact belongs to exactly one decision.**
 *
 * Deliberately NOT modelled on `noteBoundarySignal`'s drain-on-next-append buffer. A
 * forgotten drain there is harmless (a signal attaches slightly late); here it would silently
 * attribute one decision's evidence to the next, and that bug surfaces months later as
 * attribution that "looks strange" with no way to tell which rows are contaminated.
 *
 * So contamination is made impossible rather than unlikely:
 *  - facts observed with NO scope open are REJECTED, never buffered forward;
 *  - re-opening a scope DISCARDS the previous one's facts rather than merging them;
 *  - both cases increment `factsOrphaned`, which `experienceStats()` reports — a forgotten
 *    drain is loud in the metrics instead of invisible in the corpus.
 */
export function beginDecision(label = ""): void {
  if (openScope !== null) {
    factsOrphaned += openScope.facts.length;
  }
  openScope = { label, facts: [] };
}

/** Record a fact against the OPEN decision scope. Returns false if there is none. */
export function observeFact(fact: ConsultedFact): boolean {
  if (openScope === null) {
    factsOrphaned += 1;
    return false;
  }
  openScope.facts.push(fact);
  return true;
}

function drainFactScope(): ConsultedFact[] {
  const facts = openScope ? openScope.facts : [];
  openScope = null;
  return facts;
}

/**
 * Coarse intent class from the ask — enough to detect "grading → cutting" style shifts.
 *
 * ADR-016 I8: this is a POLICY, not an observation. It is a keyword table that two honest
 * observers would populate differently, so it names and versions itself, and it runs at READ
 * time only (`deriveReadTimeSignals`). Exported so Stage C can run it — and so that when a v2
 * replaces it, v1 remains runnable and its past derivations stay reproducible.
 */
export const INTENT_CLASS_POLICY_ID = "intent-class.keyword.v1";

export function intentClassOf(prompt: string): string {
  const text = prompt.toLowerCase();
  if (/\b(cut|trim|split|ripple|slip|slide|shorten|lengthen)\b/.test(text)) return "edit";
  if (/\b(grade|color|colour|look|contrast|exposure|saturation|moody|warm|cool)\b/.test(text)) return "color";
  if (/\b(audio|volume|mute|sync|dialogue|music|loud|quiet)\b/.test(text)) return "audio";
  if (/\b(text|title|caption|subtitle|font)\b/.test(text)) return "text";
  if (/\b(move|scale|rotate|position|zoom|pan|animate|keyframe)\b/.test(text)) return "motion";
  if (/\b(export|render|deliver)\b/.test(text)) return "export";
  return "other";
}

/**
 * Signals COMPUTED from stored evidence at read time, unioned with the witnessed signals on
 * the row before a policy's `openOn` is applied.
 *
 * These used to be written into the envelope, and that was an ADR-016 I3 violation found by
 * applying the admission test per-field rather than per-row: `intent-class-change` is the
 * output of a keyword classifier (I4 — a derivation riding an evidence row), and
 * `outcome-error` restates `payload.failed`, which is already stored. Nothing is lost by
 * moving them here — both are functions of data the corpus keeps — and the corpus stops
 * carrying one policy's opinion baked into rows that outlive it.
 *
 * `idle-gap` is NOT here: it is timestamp arithmetic (I6) and its threshold belongs to the
 * policy, so `segment()` handles it via `policy.idleGapMs`.
 */
function deriveReadTimeSignals(event: ExperienceEvent, previousIntentClass: string): BoundarySignal[] {
  if (!isDecision(event)) {
    return [];
  }
  const derived: BoundarySignal[] = [];
  const intentClass = intentClassOf(event.payload.prompt);
  if (previousIntentClass && intentClass !== previousIntentClass) {
    derived.push({
      kind: "intent-class-change",
      at: event.t,
      strength: "medium",
      detail: `${previousIntentClass} → ${intentClass} (${INTENT_CLASS_POLICY_ID})`
    });
  }
  if (event.payload.failed > 0) {
    // The closest available proxy for a prediction-error spike until the Ledger exists
    // (ORIS_RESEARCH_PROGRAMME.md §4.2 / Event Segmentation Theory).
    derived.push({
      kind: "outcome-error",
      at: event.t,
      strength: "medium",
      detail: `${event.payload.failed} step(s) failed`
    });
  }
  return derived;
}

// ── Episodes + sessions ──────────────────────────────────────────────────────────────────

function openSession(reason: SessionPayload["reason"]): void {
  const at = Date.now();
  sessionCounter += 1;
  state.sessionId = `s-${at.toString(36)}-${sessionCounter.toString(36)}`;
  // A session start is not subjective time passing — opening the app changes nothing about
  // the world, so consequence is 0 and τ does not advance (ORIS_TIME.md §1).
  const event = push({
    producer: "system",
    kind: "session",
    t: at,
    tauInputs: { base: TAU_BASE, consequence: 0, surprise: null },
    signals: [{ kind: "session-start", at, strength: "strong", detail: reason }],
    refs: [],
    payload: {
      reason,
      schemaVersion: SCHEMA_VERSION,
      buildId,
      seatId: resolveSeatId(),
      startedAt: at
    }
  });
  state.sessionEventId = event.id;
}

// ── Append ───────────────────────────────────────────────────────────────────────────────

interface PushArgs<K extends EventKind, P> {
  producer: Producer;
  kind: K;
  t: number;
  tauInputs: TauInputs;
  signals: BoundarySignal[];
  refs: string[];
  payload: P;
}

/**
 * PRIVATE by design. Exporting a generic append would hand every producer the ability to
 * fabricate every other producer's observations, which is exactly what ORIS-18 forbids.
 */
function push<K extends EventKind, P>(args: PushArgs<K, P>): Envelope<K, P> {
  if (!PRODUCER_KINDS[args.producer].includes(args.kind)) {
    // Defence in depth behind the structural boundary. Loud, and refuses to write: a corpus
    // containing one fabricated observation is untrustworthy everywhere, not just there.
    throw new Error(`[oris] producer "${args.producer}" may not emit kind "${args.kind}" (ORIS-18)`);
  }
  const dTau = tauAdvance(args.tauInputs);
  state.tau += dTau;
  const event: Envelope<K, P> = {
    id: `xp-${args.t.toString(36)}-${state.nextSeq.toString(36)}`,
    seq: state.nextSeq,
    sessionId: state.sessionId,
    t: args.t,
    tau: state.tau,
    dTau,
    tauInputs: args.tauInputs,
    tauPolicy: TAU_POLICY_ID,
    producer: args.producer,
    kind: args.kind,
    refs: args.refs,
    signals: args.signals,
    payload: args.payload
  };
  state.nextSeq += 1;
  state.events.push(event as unknown as ExperienceEvent);
  evictIfOverflowing();
  schedulePersist();
  notify(event as unknown as ExperienceEvent);
  return event;
}

// ── Live subscription (the observatory's viewport) ───────────────────────────────────────

type StreamListener = (event: ExperienceEvent) => void;
const listeners = new Set<StreamListener>();

/** Watch the stream as it fills. Used by the `?aiThinkingShow=1` panel. */
export function subscribeExperience(listener: StreamListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function notify(event: ExperienceEvent): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch {
      // A viewer must never be able to break the thing it is viewing.
    }
  }
}

/**
 * The `ai` producer's write seam. Called from `recordDecisionTrace`, so every apply/answer
 * seam the runtime already has — and every future one — lands in the corpus for free.
 */
export function appendDecisionEvent(trace: DecisionTrace): DecisionEvent {
  ensureHydrated();
  // ADR-016 I3: ONLY witnessed signals are written. Everything the stream could compute for
  // itself is computed by `segment()` instead, from evidence that is already stored.
  const signals = pendingSignals;
  pendingSignals = [];

  return push({
    producer: "ai",
    kind: "decision",
    t: trace.at,
    // Consequence: failures move the world less but matter more, so they are weighted UP.
    // This is a guess, recorded as an input rather than baked into τ (see `tauInputs`).
    tauInputs: { base: TAU_BASE, consequence: 1 + trace.applied + 2 * trace.failed, surprise: null },
    signals,
    // ORIS-17: the session row carries this event's buildId/seatId/schemaVersion, so it may
    // not be evicted while this row survives.
    refs: state.sessionEventId ? [state.sessionEventId] : [],
    payload: {
      prompt: trace.prompt,
      route: trace.route,
      zeroTokens: trace.zeroTokens,
      notes: [...trace.notes],
      steps: [...trace.steps],
      applied: trace.applied,
      failed: trace.failed,
      situation: getSituation(),
      factsConsulted: drainFactScope(),
      owner: trace.owner ?? null,
      confidence: trace.confidence ?? null,
      startedAt: trace.startedAt ?? null,
      actions: trace.actions ? [...trace.actions] : [],
      candidates: trace.candidates ? [...trace.candidates] : []
    }
  });
}

// ── The `editor` producer (ADR-017) ──────────────────────────────────────────────────────

/** Shared envelope wiring for both editor entry points. */
function pushAction(payload: ActionPayload, consequence: number): ActionEvent {
  ensureHydrated();
  const at = Date.now();
  const signals = pendingSignals;
  pendingSignals = [];
  return push({
    producer: "editor",
    kind: "action",
    t: at,
    tauInputs: { base: TAU_BASE, consequence, surprise: null },
    signals,
    // ORIS-17: the session row carries this row's buildId/seatId/coverage, so it may not be
    // evicted while this row survives.
    refs: state.sessionEventId ? [state.sessionEventId] : [],
    payload
  });
}

/**
 * One COMMITTED user gesture (ADR-017 U3).
 *
 * The caller must invoke this only when a history entry was actually pushed. That is the U3
 * signal, and the two nearby properties are both wrong: a parameter drag makes ~20 graph
 * writes and all of them are "history-recording", so keying on either would record twenty
 * user actions for one gesture. Measured, not assumed — see plans/oris-outcome-seam-design.md §14.
 */
export function appendEditCommit(args: {
  initiator: "ai" | "user" | null;
  actionIds: string[];
  summary: string | null;
  graphVersion: number;
  undoDepth: number;
}): ActionEvent {
  return pushAction({ operation: "commit", ...args }, 1);
}

/**
 * An undo or redo OCCURRED (ADR-017 U5).
 *
 * Records that it happened, never what it reversed: the history stack holds whole-composition
 * snapshots, so the target was never witnessed. Consequence is 0 — an undo returns the world
 * to a state it already occupied, so τ does not advance. That is a judgement, which is exactly
 * why it is stored as a τ INPUT under a named policy rather than baked into τ.
 */
export function appendHistoryAction(args: {
  operation: "undo" | "redo";
  graphVersion: number;
  undoDepth: number;
}): ActionEvent {
  return pushAction(
    { operation: args.operation, initiator: null, actionIds: [], summary: null, graphVersion: args.graphVersion, undoDepth: args.undoDepth },
    0
  );
}

/**
 * ORIS-17 — **no dangling references.** A row is never evicted while any surviving row
 * references it, transitively. Session pinning is one instance of this, not the rule: when
 * outcome rows reference decisions and predictions reference decisions, the same closure
 * keeps those chains intact with no further code.
 *
 * PRECEDENCE, stated because the two rules genuinely conflict: **provenance beats the
 * ceiling.** If the pinned closure cannot fit under MAX_EVENTS, the stream exceeds it and
 * reports the overflow (`experienceStats().pinned`) rather than silently breaking a chain.
 * A ceiling violation is visible and recoverable; a dangling reference corrupts every
 * analysis that touches it, forever.
 */
function evictIfOverflowing(): void {
  if (state.events.length <= MAX_EVENTS) {
    return;
  }
  const target = state.events.length - MAX_EVENTS;
  const byId = new Map(state.events.map((event) => [event.id, event] as const));

  // Transitive closure of everything the survivors depend on.
  const pinned = new Set<string>();
  const queue: string[] = [];
  for (let i = target; i < state.events.length; i += 1) {
    queue.push(...state.events[i]!.refs);
  }
  while (queue.length > 0) {
    const id = queue.pop()!;
    if (pinned.has(id)) {
      continue;
    }
    const referenced = byId.get(id);
    if (!referenced) {
      continue; // already gone — nothing left to conserve
    }
    pinned.add(id);
    queue.push(...referenced.refs);
  }

  const kept = state.events.filter((event, index) => index >= target || pinned.has(event.id));
  state.evicted += state.events.length - kept.length;
  state.events = kept;
}

// ── Retroactive segmentation (the reason Stage A ships before Stage C) ───────────────────

export interface SegmentationPolicy {
  id: string;
  /** Signal kinds that open a new episode. */
  openOn: BoundarySignalKind[];
  /** Wall-clock idle gap that opens a new episode. 0 disables. */
  idleGapMs: number;
  /** Baseline: fixed number of events per episode. 0 disables. */
  fixedEvents: number;
  /** Baseline: fixed wall-clock window per episode. 0 disables. */
  fixedWindowMs: number;
}

/** The baselines any proposed segmenter must beat (ORIS_RESEARCH_PROGRAMME.md §4.1). */
export const BASELINE_POLICIES: Record<string, SegmentationPolicy> = {
  fixed20: { id: "baseline.fixed-20-events", openOn: [], idleGapMs: 0, fixedEvents: 20, fixedWindowMs: 0 },
  fixed5m: { id: "baseline.fixed-5-min", openOn: [], idleGapMs: 0, fixedEvents: 0, fixedWindowMs: 5 * 60 * 1000 },
  session: { id: "baseline.session", openOn: ["session-start"], idleGapMs: 0, fixedEvents: 0, fixedWindowMs: 0 },
  activityGap: { id: "baseline.activity-gap-30m", openOn: [], idleGapMs: IDLE_GAP_MS, fixedEvents: 0, fixedWindowMs: 0 }
};

function outcomeOf(event: ExperienceEvent): { applied: number; failed: number } {
  return isDecision(event) ? { applied: event.payload.applied, failed: event.payload.failed } : { applied: 0, failed: 0 };
}

/**
 * Re-segment an existing corpus under ANY policy. Pure — no store access, no side effects.
 *
 * This is the function Stage C is built on, and shipping it now is the whole point of
 * logging features rather than conclusions: a corpus collected today can be re-cut tomorrow
 * under a hypothesis nobody has had yet.
 */
export function segment(
  events: readonly ExperienceEvent[],
  policy: SegmentationPolicy
): EpisodeSummary[] {
  const episodes: EpisodeSummary[] = [];
  let current: EpisodeSummary | null = null;
  let sinceOpen = 0;
  let intentClass = "";

  for (const event of events) {
    // Witnessed signals (stored) ∪ derived signals (computed here, ADR-016 I3). A policy's
    // `openOn` cannot tell them apart, and should not have to — the difference is about what
    // the CORPUS is entitled to hold, not about what a segmenter may consider.
    const derived = deriveReadTimeSignals(event, intentClass);
    if (isDecision(event)) {
      intentClass = intentClassOf(event.payload.prompt);
    }
    const opener = [...event.signals, ...derived].find((signal) => policy.openOn.includes(signal.kind));
    // Annotated, not inferred: `openReason` below reads these back out of the same loop, and
    // TS walks that into a circular initializer (TS7022) without the explicit type.
    const idleBreak: boolean =
      policy.idleGapMs > 0 && current !== null && event.t - current.endedAt >= policy.idleGapMs;
    const countBreak: boolean = policy.fixedEvents > 0 && sinceOpen >= policy.fixedEvents;
    const windowBreak: boolean =
      policy.fixedWindowMs > 0 && current !== null && event.t - current.startedAt >= policy.fixedWindowMs;

    if (current === null || opener || idleBreak || countBreak || windowBreak) {
      current = {
        id: `${policy.id}#${episodes.length + 1}`,
        startedAt: event.t,
        endedAt: event.t,
        startedTau: event.tau,
        endedTau: event.tau,
        eventCount: 0,
        applied: 0,
        failed: 0,
        openReason: opener ? opener.kind : idleBreak ? "idle-gap" : "session-start"
      };
      episodes.push(current);
      sinceOpen = 0;
    }

    const outcome = outcomeOf(event);
    current.endedAt = event.t;
    current.endedTau = event.tau;
    current.eventCount += 1;
    current.applied += outcome.applied;
    current.failed += outcome.failed;
    sinceOpen += 1;
  }
  return episodes;
}

// ── Reads ────────────────────────────────────────────────────────────────────────────────

export function listExperience(): ExperienceEvent[] {
  ensureHydrated();
  return [...state.events];
}

/** Typed convenience for analysis and eval — the `ai` producer's rows only. */
export function listDecisions(): DecisionEvent[] {
  return listExperience().filter(isDecision);
}

/** Session-scoped facts, by session id — the join target for every other row. */
export function listSessions(): SessionEvent[] {
  return listExperience().filter(isSession);
}

/**
 * Episodes under the provisional cut. Derived on READ (schema v4) — nothing about episodes is
 * stored, so this is exactly `segment()` with one particular policy and carries no more
 * authority than any other.
 */
export function listEpisodes(): EpisodeSummary[] {
  return segment(listExperience(), PROVISIONAL_POLICY);
}

export interface ExperienceStats {
  events: number;
  decisions: number;
  sessions: number;
  episodes: number;
  evicted: number;
  tau: number;
  bytes: number;
  bytesPerEvent: number;
  firstAt: number | null;
  lastAt: number | null;
  ceiling: number;
  /**
   * How far the pinned reference closure pushes the stream past its ceiling (ORIS-17).
   * Zero in normal operation. A persistently rising value means reference chains are
   * out-living the retention window and the ceiling — or the chains — need revisiting.
   */
  pinned: number;
  /**
   * Facts observed with no open decision scope, or discarded by a re-opened one. Should be
   * ZERO. A rising value is a forgotten `beginDecision`/append pairing — loud here rather
   * than silently contaminating the next decision's evidence.
   */
  factsOrphaned: number;
  /**
   * Rows refused on load because they were malformed (ADR-016 I9). Should be ZERO. Non-zero
   * means the corpus is smaller than its own sequence numbers imply, and every rate, coverage,
   * and growth figure derived from it is understated by that amount.
   */
  malformed: number;
  schemaVersion: number;
}

/**
 * H7 (memory growth is sublinear) is measured from `bytesPerEvent`, plotted against
 * cumulative events. ORIS_RESEARCH_PROGRAMME.md §8 requires this from day one because it is
 * the failure most likely to be discovered late.
 */
export function experienceStats(): ExperienceStats {
  ensureHydrated();
  const bytes = JSON.stringify(state.events).length;
  const first = state.events[0];
  const last = state.events[state.events.length - 1];
  return {
    events: state.events.length,
    decisions: state.events.filter(isDecision).length,
    sessions: state.events.filter(isSession).length,
    episodes: listEpisodes().length,
    evicted: state.evicted,
    tau: state.tau,
    bytes,
    bytesPerEvent: state.events.length > 0 ? bytes / state.events.length : 0,
    firstAt: first ? first.t : null,
    lastAt: last ? last.t : null,
    ceiling: MAX_EVENTS,
    pinned: Math.max(0, state.events.length - MAX_EVENTS),
    factsOrphaned,
    malformed: malformedDropped,
    schemaVersion: SCHEMA_VERSION
  };
}

export function clearExperience(): void {
  state.events = [];
  state.nextSeq = 1;
  state.tau = 0;
  state.evicted = 0;
  pendingSignals = [];
  malformedDropped = 0;
  situation = { ...EMPTY_SITUATION };
  openScope = null;
  factsOrphaned = 0;
  hydrated = true; // an explicit clear must not resurrect persisted history
  openSession("cold-start");
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    // best-effort
  }
}

/** TEST-ONLY: drop memory + hydration flag so eval can simulate a page reload. */
export function __resetExperienceMemoryForTests(): void {
  state.events = [];
  state.nextSeq = 1;
  state.tau = 0;
  state.evicted = 0;
  pendingSignals = [];
  malformedDropped = 0;
  situation = { ...EMPTY_SITUATION };
  openScope = null;
  factsOrphaned = 0;
  hydrated = false;
}
