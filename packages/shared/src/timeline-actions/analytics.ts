/**
 * Action + AI analytics (swappable sink). Keeps live counters the registry,
 * planner, executor, and the P7 "Missing Capability Dashboard" all read. The
 * store is in-memory but exposes a hydrate/subscribe seam so a host (the web app)
 * can persist it to localStorage without this package depending on the DOM.
 */

export interface UnsupportedRequest {
  /** The raw user prompt the planner couldn't fully satisfy. */
  prompt: string;
  /** Best guess at the capability that was missing (tool/effect/intent keyword). */
  missingCapability: string;
  /** Whether the user accepted an approximate plan instead. */
  acceptedApproximation: boolean;
  /** Epoch ms. */
  at: number;
}

export interface ActionAnalyticsSnapshot {
  /** Per-action successful-execution count. */
  actionUsage: Record<string, number>;
  /** Per-tool requested count (how often a plan included this tool). */
  toolDemand: Record<string, number>;
  /** Per-effect requested count. */
  effectDemand: Record<string, number>;
  /** Of the executed actions, how many were AI-generated. */
  aiGeneratedCount: number;
  /** Actions that threw while executing. */
  failedCount: number;
  /** Actions the registry refused before executing (unknown id / bad params / failed validation). */
  rejectedCount: number;
  /** Plans the user approved (Apply). */
  plansAccepted: number;
  /** Plans the user dismissed (Cancel). */
  plansRejected: number;
  /** Execution durations in ms (one per completed plan). */
  executionMs: number[];
  /** Prompts that hit a missing capability, for the demand dashboard. */
  unsupported: UnsupportedRequest[];
}

function freshState(): ActionAnalyticsSnapshot {
  return {
    actionUsage: {},
    toolDemand: {},
    effectDemand: {},
    aiGeneratedCount: 0,
    failedCount: 0,
    rejectedCount: 0,
    plansAccepted: 0,
    plansRejected: 0,
    executionMs: [],
    unsupported: []
  };
}

let state = freshState();

type Listener = (snapshot: ActionAnalyticsSnapshot) => void;
const listeners = new Set<Listener>();

function notify(): void {
  if (listeners.size === 0) {
    return;
  }
  const snapshot = getActionAnalytics();
  for (const listener of listeners) {
    listener(snapshot);
  }
}

export function recordExecuted(actionId: string, options: { ai?: boolean | undefined } = {}): void {
  state.actionUsage[actionId] = (state.actionUsage[actionId] ?? 0) + 1;
  if (options.ai) {
    state.aiGeneratedCount += 1;
  }
  notify();
}

export function recordFailed(actionId: string): void {
  state.failedCount += 1;
  void actionId;
  notify();
}

export function recordRejected(actionId: string): void {
  state.rejectedCount += 1;
  void actionId;
  notify();
}

/** A plan included a tool / effect (demand signal, recorded at plan time). */
export function recordToolDemand(toolSlug: string): void {
  state.toolDemand[toolSlug] = (state.toolDemand[toolSlug] ?? 0) + 1;
  notify();
}

export function recordEffectDemand(effectType: string): void {
  state.effectDemand[effectType] = (state.effectDemand[effectType] ?? 0) + 1;
  notify();
}

/** The user accepted (apply=true) or rejected (apply=false) a reviewed plan. */
export function recordPlanReviewed(accepted: boolean): void {
  if (accepted) {
    state.plansAccepted += 1;
  } else {
    state.plansRejected += 1;
  }
  notify();
}

/** Wall-clock duration of one executed plan, in ms. */
export function recordExecutionTime(ms: number): void {
  if (Number.isFinite(ms) && ms >= 0) {
    // keep the last 200 so the snapshot stays bounded
    state.executionMs = [...state.executionMs.slice(-199), Math.round(ms)];
    notify();
  }
}

export function logUnsupported(entry: Omit<UnsupportedRequest, "at">): void {
  state.unsupported = [...state.unsupported.slice(-99), { ...entry, at: Date.now() }];
  notify();
}

export function getActionAnalytics(): ActionAnalyticsSnapshot {
  return {
    actionUsage: { ...state.actionUsage },
    toolDemand: { ...state.toolDemand },
    effectDemand: { ...state.effectDemand },
    aiGeneratedCount: state.aiGeneratedCount,
    failedCount: state.failedCount,
    rejectedCount: state.rejectedCount,
    plansAccepted: state.plansAccepted,
    plansRejected: state.plansRejected,
    executionMs: [...state.executionMs],
    unsupported: state.unsupported.map((item) => ({ ...item }))
  };
}

export function resetActionAnalytics(): void {
  state = freshState();
  notify();
}

/**
 * Replace the live counters from a persisted snapshot (host hydration on boot).
 * Unknown/missing fields fall back to the fresh defaults so older persisted
 * payloads stay forward-compatible.
 */
export function hydrateActionAnalytics(snapshot: Partial<ActionAnalyticsSnapshot> | null | undefined): void {
  if (!snapshot) {
    return;
  }
  const base = freshState();
  state = {
    actionUsage: { ...base.actionUsage, ...snapshot.actionUsage },
    toolDemand: { ...base.toolDemand, ...snapshot.toolDemand },
    effectDemand: { ...base.effectDemand, ...snapshot.effectDemand },
    aiGeneratedCount: snapshot.aiGeneratedCount ?? base.aiGeneratedCount,
    failedCount: snapshot.failedCount ?? base.failedCount,
    rejectedCount: snapshot.rejectedCount ?? base.rejectedCount,
    plansAccepted: snapshot.plansAccepted ?? base.plansAccepted,
    plansRejected: snapshot.plansRejected ?? base.plansRejected,
    executionMs: Array.isArray(snapshot.executionMs) ? [...snapshot.executionMs] : base.executionMs,
    unsupported: Array.isArray(snapshot.unsupported) ? snapshot.unsupported.map((item) => ({ ...item })) : base.unsupported
  };
}

/** Subscribe to any analytics change (host persists on notify). Returns an unsubscribe. */
export function subscribeActionAnalytics(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
