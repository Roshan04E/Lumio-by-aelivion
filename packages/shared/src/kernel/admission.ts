/**
 * Source Admission (ADR-012 §6.3, §6.11, §6.12 — slice S4.3) — WHO gets scarce decode capacity.
 *
 * ## The three decoder questions, and which one this is
 *
 * The runtime asks three different things about a decoder session and has historically answered all of
 * them in one function, which is why none of them could be reasoned about:
 *
 *   - **S4.3 (here)** — capacity is scarce; *who gets a slot?*
 *   - **S4.7** — a slot is granted; *which existing session can satisfy it without degrading service?*
 *   - **S4.4–S4.6** — a session is serving; *when is its frame ready to present?*
 *
 * This module answers the first and must not touch the others. In particular it **never consumes a
 * requested time**: §6.3's ranking inputs are visible contribution, and a module that ranked by time
 * would be re-deciding S4.7's question with worse information.
 *
 * ## Why arrival order had to go
 *
 * Today the pool allocates first-come, with two priority tiers and no knowledge of the graph. That is
 * not a policy, it is the absence of one: whichever MediaIn happens to mount first wins a hardware slot,
 * and a source contributing two occluded percent of the output can hold the session a full-frame source
 * is denied. Mount order is a React scheduling artifact, so which source looks broken can change between
 * two runs of the same project — and has.
 *
 * ## What ranks, and what deliberately does not
 *
 * §6.3 names the inputs: reachability from the active root, contributed area, opacity/blend
 * contribution, and whether the node sits under a disabled or zero-weight branch. All four are
 * properties of the GRAPH at an instant. None is a property of the consumer's history, its arrival, or
 * how long it has held a session — those would make ranking self-reinforcing, where whoever got in first
 * keeps winning because they got in first.
 *
 * Aging (§6.11) is the one exception and is deliberately NOT part of the contribution score: it is added
 * afterwards, so a low-contribution source rises over time without ever being able to claim it
 * contributes more than it does. Fairness is a separate term from merit, and mixing them makes both
 * unreadable.
 *
 * ## Hysteresis damps oscillation, not badness
 *
 * A ranked scheduler with no damping thrashes: two sources either side of the cap trade the slot every
 * frame, and each trade is a demux and a GOP window. Minimum residency fixes that.
 *
 * It must never be asked to do more. If a grant should not have been made, hysteresis makes the mistake
 * LAST LONGER — it is not a correction mechanism, and the slice's test asserts exactly this by requiring
 * that an under-budget comp with divergent trajectories produces no churn at all. Churn that residency
 * has to damp in an under-budget comp would mean the ranking is wrong, and damping it would hide that.
 *
 * ## Denial is a state, not a return value
 *
 * §6.12: exceeding a budget is REPORTED, and the excess is attributed. A denied source today is a `null`
 * return and a `capMisses` counter — a number with no subject, which cannot answer "which source, and
 * why". Every denial here carries its key, its rank, what it lost to, and how long it has been denied,
 * because "the fourth MediaIn never gets a decoder" and "the fourth MediaIn is denied at rank 5 of 8
 * behind three fully-occluded sources" are the same defect with and without a diagnosis.
 *
 * I-36: no DOM, no GL, no decoder API here. This module ranks records and returns a decision; the host
 * allocates. That is what lets an export, a worker and a headless harness share one admission policy.
 */

import { kernelDiagnostics } from "./diagnostics";
import type { FramePurpose } from "./frame-scheduler";
import type { RuntimeSession } from "./session";

/**
 * What makes a source visibly matter, per §6.3. Every field is a property of the graph at one instant.
 *
 * `undefined` is NOT zero — see {@link AdmissionCandidate.contribution}. A producer that cannot compute a
 * field omits the whole record rather than passing a plausible-looking default, because a default here
 * is a ranking claim made by whoever wrote the fallback rather than by whoever knows the graph.
 */
export interface VisibleContribution {
  /** Is this source reachable from the active root? An unreachable node contributes nothing by definition. */
  reachable: boolean;
  /** Fraction of the output this source contributes, 0..1. Occlusion counted where the host can compute it. */
  area: number;
  /** Effective opacity/blend contribution, 0..1. A fully transparent source is visible in the graph only. */
  opacity: number;
  /** Under a disabled or zero-weight branch — present in the graph, contributing nothing to the picture. */
  underDisabledBranch: boolean;
}

/**
 * A source asking for capacity.
 *
 * `contribution` is optional and its absence is meaningful. The programme has now been bitten twice by a
 * decision input that did not exist at the decision point (S3.3's joiner time; S4.7's `requestedTime`),
 * and the lesson both times was to record the gap rather than synthesize a value. An undeclared
 * contribution is ranked as {@link UNDECLARED_RANK} — deliberately NOT zero, because zero would silently
 * starve every consumer that has not yet been taught to declare, turning an instrumentation gap into a
 * black picture.
 */
export interface AdmissionCandidate {
  key: string;
  priority: "playhead" | "preload";
  /**
   * WHAT this acquisition is for (ADR-012 §6.1) — C15's purpose class, threaded 2026-08-05 for
   * ADR-013 Phase 0 / M5.
   *
   * **Recorded, never ranked.** Nothing in {@link rankAdmission} reads it, and it is deliberately
   * absent from the scoring, the sort and the eligibility filter. M5 asks *who contends with whom* —
   * whether the observed contention is cross-class (`live` losing to a background `thumbnail`) or
   * intra-class (`live` losing to `live`) — because a per-class reservation can only express the first,
   * and if the contention is mostly the second then per-class reserves are not merely simpler, they are
   * insufficient (ADR-013 §4.4, OQ5).
   *
   * Carrying it as data is the whole point: **letting it influence the decision would be a mechanism
   * change in the middle of a measurement programme**, which is how a programme loses the ability to
   * interpret its own numbers. The reservation policy that eventually reads this is a slice, and it
   * comes after the magnitudes are settled.
   *
   * `priority` is NOT this. `playhead`/`preload` is a lease-ordering hint about *when* a source is
   * needed; purpose is *what the work is for*, and the two are independent — a `preload` shell for a
   * live frame is `live` purpose at `preload` priority.
   *
   * Optional, and absence is meaningful for the same reason {@link contribution}'s is: a call site that
   * has not been taught to declare says so, rather than having a plausible default invented on its
   * behalf. That distinction is exactly what DEBT-012 exists to name — a manufactured declaration reads
   * healthier than an absent one while carrying less information.
   */
  purpose?: FramePurpose | undefined;
  contribution?: VisibleContribution | undefined;
  /** Wall clock when this candidate first asked. Drives aging (§6.11); never drives merit. */
  firstRequestedAtMs: number;
  /** Wall clock when this candidate was last admitted, or null if it never has been. Drives residency. */
  admittedAtMs: number | null;
}

/**
 * Rank given to a candidate that declared no contribution.
 *
 * Above "contributes nothing" and below any real contribution, so an undeclared source outranks a
 * provably-invisible one and loses to a provably-visible one. That ordering is the honest reading of "we
 * do not know": it cannot be worse than a source we KNOW is under a disabled branch, and it cannot beat
 * a source we KNOW is on screen.
 */
export const UNDECLARED_RANK = 0.01;

/**
 * How long an admitted source keeps its slot before a higher-ranked challenger may take it.
 *
 * One second is far longer than the frame interval this damps (16ms) and far shorter than a shot. The
 * number is a budget and therefore configuration (§6.12); conformance to it is not.
 */
export const MIN_RESIDENCY_MS = 1_000;

/**
 * Rank added per second a candidate has been denied (§6.11 fairness).
 *
 * Sized so a fully-denied source overtakes a mid-contribution incumbent in a few seconds rather than a
 * few frames: fast enough that "eventually" is a real promise, slow enough that it cannot outrank a
 * genuinely full-frame source during ordinary playback.
 */
export const AGING_RANK_PER_SECOND = 0.05;

/**
 * After this long denied, a candidate is declared PERMANENTLY denied rather than left waiting.
 *
 * §6.11 offers exactly two acceptable ends for a persistently low-ranked source — it receives a session,
 * or it is declared permanently denied. Waiting forever is not one of them, and an unbounded wait with a
 * rising rank that never wins is precisely the silent starvation the invariant exists to forbid.
 */
export const PERMANENT_DENIAL_AFTER_MS = 30_000;

export type DenialReason =
  /** Capacity is full and this candidate ranked below the admitted set. */
  | "over-budget"
  /** Reachable-but-invisible: zero area, zero opacity, or under a disabled branch. Not a scarcity denial. */
  | "no-visible-contribution"
  /** Denied continuously past {@link PERMANENT_DENIAL_AFTER_MS}; §6.11's declared terminal. */
  | "permanently-denied";

export interface AdmissionDenial {
  key: string;
  reason: DenialReason;
  /** This candidate's effective rank, aging included. */
  rank: number;
  /** The lowest rank that WAS admitted — the bar this candidate failed to clear. Null if capacity was 0. */
  admittedFloor: number | null;
  deniedForMs: number;
  /** True when the contribution was not declared and {@link UNDECLARED_RANK} stood in for it. */
  undeclared: boolean;
  /** C15 purpose class, or null where undeclared. Attribution only — never a denial reason. */
  purpose?: FramePurpose | null | undefined;
}

export interface AdmissionDecision {
  admitted: readonly string[];
  denied: readonly AdmissionDenial[];
  /** Candidates that kept a slot only because of minimum residency — the hysteresis, made visible. */
  heldByResidency: readonly string[];
}

/**
 * Merit alone, 0..1. Aging and residency are applied by {@link rankAdmission}, never folded in here.
 *
 * Multiplicative, not additive: a source at full area and zero opacity contributes nothing, and any
 * scheme where a large invisible source outranks a small visible one has the sign of the whole slice
 * backwards.
 */
export function contributionRank(contribution: VisibleContribution | undefined): number {
  if (!contribution) return UNDECLARED_RANK;
  if (!contribution.reachable || contribution.underDisabledBranch) return 0;
  const area = clamp01(contribution.area);
  const opacity = clamp01(contribution.opacity);
  return area * opacity;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/**
 * Decide who gets `capacity` slots.
 *
 * Deterministic given its inputs — the slice's own test requires a stable ranking on a 5–8 MediaIn comp,
 * and a ranker that consulted wall clock, iteration order or a Map's insertion sequence for anything but
 * the declared aging term could not provide it. Ties break on `key`, which is arbitrary but FIXED; the
 * alternative is a comp whose denied source changes between two identical frames.
 */
export function rankAdmission(
  candidates: readonly AdmissionCandidate[],
  capacity: number,
  nowMs: number,
  observe?: AdmissionObserver | undefined
): AdmissionDecision {
  const scored = candidates.map((candidate) => {
    const merit = contributionRank(candidate.contribution);
    const deniedForMs = Math.max(0, nowMs - candidate.firstRequestedAtMs);
    // Aging applies to candidates that have never been admitted OR are back asking again; an incumbent's
    // own residency is handled separately below. Merit and fairness stay separate terms (see the header).
    const aging = candidate.admittedAtMs == null ? (deniedForMs / 1000) * AGING_RANK_PER_SECOND : 0;
    return {
      candidate,
      merit,
      deniedForMs,
      rank: merit + aging,
      undeclared: candidate.contribution == null,
      // Residency protects an admitted source from being displaced, but never resurrects one that has
      // already lost its slot: `admittedAtMs` is cleared by the host on release.
      residencyProtected:
        candidate.admittedAtMs != null && nowMs - candidate.admittedAtMs < MIN_RESIDENCY_MS,
    };
  });

  // Sort by rank desc, then residency-protected first at equal rank, then key for determinism.
  const order = [...scored].sort((a, b) => {
    if (b.rank !== a.rank) return b.rank - a.rank;
    if (a.residencyProtected !== b.residencyProtected) return a.residencyProtected ? -1 : 1;
    return a.candidate.key < b.candidate.key ? -1 : a.candidate.key > b.candidate.key ? 1 : 0;
  });

  const slots = Math.max(0, Math.floor(capacity));
  const admitted: string[] = [];
  const heldByResidency: string[] = [];
  const pending: typeof order = [];

  /**
   * A source that provably contributes nothing is NEVER admitted, however much capacity is free.
   *
   * This was wrong in the first draft — spare slots were handed out in rank order, so a MediaIn under a
   * disabled branch got a hardware decoder purely because nobody else wanted one. That is the waste the
   * slice exists to stop: graph knowledge is the whole difference between this and first-come, and
   * "decode it anyway, there was room" throws that knowledge away at the one moment it is actionable.
   *
   * `undeclared` is deliberately NOT eligible for this exclusion. Zero merit here means *we know it
   * contributes nothing*; an absent input means *we do not know*, and refusing on ignorance would starve
   * every consumer not yet taught to declare.
   */
  const eligible = order.filter((entry) => entry.merit > 0 || entry.undeclared);
  const ineligible = order.filter((entry) => !(entry.merit > 0 || entry.undeclared));

  // Residency-protected incumbents claim their slots FIRST — that is what makes them protected. A
  // protected incumbent that would have been admitted on rank anyway is not "held by residency"; only
  // one that displaced a higher-ranked challenger is, and only those are reported as hysteresis.
  for (const entry of eligible) {
    if (entry.residencyProtected && admitted.length < slots) {
      admitted.push(entry.candidate.key);
    } else {
      pending.push(entry);
    }
  }
  for (const entry of pending) {
    if (admitted.length < slots) admitted.push(entry.candidate.key);
  }
  // Report as hysteresis any protected incumbent that outranked nobody: a denied candidate with a
  // strictly higher rank is the evidence the slot was held by the clock rather than by merit.
  const admittedSet = new Set(admitted);
  // Only ELIGIBLE denials count as evidence of hysteresis. A zero-contribution source outranking nobody
  // is not a slot held by the clock, and counting it would report residency on every frame of a comp
  // that merely has a disabled branch in it.
  const bestDeniedRank = eligible
    .filter((entry) => !admittedSet.has(entry.candidate.key))
    .reduce((best, entry) => Math.max(best, entry.rank), Number.NEGATIVE_INFINITY);
  for (const entry of eligible) {
    if (entry.residencyProtected && admittedSet.has(entry.candidate.key) && entry.rank < bestDeniedRank) {
      heldByResidency.push(entry.candidate.key);
    }
  }

  const admittedFloor = admitted.length
    ? order.filter((entry) => admittedSet.has(entry.candidate.key)).reduce((min, entry) => Math.min(min, entry.rank), Infinity)
    : null;

  const denied: AdmissionDenial[] = [];
  for (const entry of [...eligible, ...ineligible]) {
    if (admittedSet.has(entry.candidate.key)) continue;
    // A source that contributes nothing was not denied by SCARCITY, and conflating the two would make a
    // comp full of disabled branches read as over-budget — sending whoever reads the diagnostic to raise
    // a cap that was never the constraint.
    const reason: DenialReason =
      entry.merit === 0 && !entry.undeclared
        ? "no-visible-contribution"
        : entry.deniedForMs >= PERMANENT_DENIAL_AFTER_MS
          ? "permanently-denied"
          : "over-budget";
    denied.push({
      key: entry.candidate.key,
      reason,
      rank: entry.rank,
      admittedFloor: admittedFloor === Infinity ? null : admittedFloor,
      deniedForMs: entry.deniedForMs,
      undeclared: entry.undeclared,
      purpose: entry.candidate.purpose ?? null,
    });
  }

  // ADR-013 Phase 0 / M1. Everything below the guard is measurement: the decision is already made and
  // is returned unchanged whether or not anyone is observing. `observe` is undefined unless the host
  // resolved diagnostics on, so the disabled cost is one undefined check (R1).
  if (observe !== undefined) {
    observe(
      buildScoredDecision(scored, admittedSet, heldByResidency, eligible, slots, nowMs)
    );
  }

  return { admitted, denied, heldByResidency };
}

// ── ADR-013 Phase 0 measurement surface (M1, M5) ────────────────────────────
//
// This section records HOW a decision was reached. It computes nothing the decision consumed, and
// `rankAdmission` returns byte-identical results with it absent — which is the property that makes it
// an observability control rather than behaviour wearing a diagnostics guard (S7.2's classification
// rule: does the runtime do something different with the flag off?).

/** One candidate as the ranker actually scored it. */
export interface AdmissionScoredEntry {
  readonly key: string;
  /** Contribution merit alone, 0..1. `UNDECLARED_RANK` when nothing was declared. */
  readonly merit: number;
  /** The §6.11 fairness term. See {@link AdmissionScoredDecision.agingAllZero}. */
  readonly aging: number;
  readonly rank: number;
  readonly undeclared: boolean;
  readonly residencyProtected: boolean;
  /** `admittedAtMs != null` — this candidate already holds capacity. Splits every M1/M5 census. */
  readonly incumbent: boolean;
  readonly admitted: boolean;
  /** What `rankAdmission` computed as this candidate's denial duration. Asserted by C2. */
  readonly deniedForMs: number;
  /**
   * C15's purpose class, or `null` where the call site has not declared one.
   *
   * `null` is reported as `undeclared`, never folded into `live`. Defaulting it would manufacture the
   * very intra-class contention M5 is trying to measure — DEBT-012's shape, arriving inside the
   * instrument built to detect it.
   */
  readonly purpose: FramePurpose | null;
}

/**
 * Which level of the comparator decided the admitted/denied boundary.
 *
 * TRI-VALUED, and that is the point (ADR-013 Phase 0 §2). The sort has three levels — rank, then
 * residency-protection, then `key` — so a boolean "was it a tie-break" would merge *damped by
 * hysteresis, as designed* with *decided alphabetically*, which are the opposite findings. M1's whole
 * result turns on telling them apart.
 */
export type AdmissionTieBreak =
  /** Ranks differed at the boundary: the ordering ordered. */
  | "rank"
  /** Minimum residency held a slot a challenger would otherwise have taken. */
  | "residency"
  /** Ranks and protection were equal; the `key` string comparator decided. */
  | "key"
  /** Nothing eligible was denied — capacity was not contended. */
  | "uncontended";

/** Whether the boundary sat between declared candidates, undeclared ones, or across the two. */
export type AdmissionBoundaryDeclaration = "declared" | "undeclared" | "mixed" | "none";

export interface AdmissionScoredDecision {
  readonly capacity: number;
  readonly tieBroken: AdmissionTieBreak;
  /**
   * Classifies the decision for M1's split. Only `declared` boundaries contribute to *T*_declared;
   * `undeclared` ones feed *T*_undeclared; `mixed` is counted and excluded from both, because a
   * boundary between a declared and an undeclared candidate is evidence about neither.
   */
  readonly boundary: AdmissionBoundaryDeclaration;
  readonly entries: readonly AdmissionScoredEntry[];
  /**
   * **C1 assertion.** True when every aging term in this decision is exactly zero.
   *
   * The reading this design is built on (`preview-frame-pool.ts:1345-1353`) is that incumbents always
   * carry `admittedAtMs`, and the sole null-valued candidate is a newcomer whose `firstRequestedAtMs`
   * is `now` — so the §6.11 fairness term is structurally inert on the live path. That is a READ, and
   * ADR-017 U12 is the standing reminder that a read is not a measurement: five files were wired and
   * typecheck was clean while a wrapper silently dropped the value. This field is how the read gets
   * watched working. `false` means the call path has changed and M1's analysis needs revisiting.
   */
  readonly agingAllZero: boolean;
  /**
   * **C2 assertion.** True when every incumbent's `deniedForMs` equals its residency age.
   *
   * `deniedForMs` means time-since-first-denial for a newcomer and time-since-acquire for an
   * incumbent, which is why a long-held incumbent that loses its slot is labelled
   * `"permanently-denied"`. M5's census split depends on that being the semantics; `false` means the
   * split is invalid and M5 must be re-derived BEFORE its decision rule is applied.
   */
  readonly incumbentDeniedForMsIsResidency: boolean;
}

export type AdmissionObserver = (decision: AdmissionScoredDecision) => void;

interface ScoredInternal {
  readonly candidate: AdmissionCandidate;
  readonly merit: number;
  readonly deniedForMs: number;
  readonly rank: number;
  readonly undeclared: boolean;
  readonly residencyProtected: boolean;
}

function buildScoredDecision(
  scored: readonly ScoredInternal[],
  admittedSet: ReadonlySet<string>,
  heldByResidency: readonly string[],
  eligible: readonly ScoredInternal[],
  capacity: number,
  nowMs: number
): AdmissionScoredDecision {
  const entries: AdmissionScoredEntry[] = scored.map((entry) => ({
    key: entry.candidate.key,
    merit: entry.merit,
    aging: entry.rank - entry.merit,
    rank: entry.rank,
    undeclared: entry.undeclared,
    residencyProtected: entry.residencyProtected,
    incumbent: entry.candidate.admittedAtMs != null,
    admitted: admittedSet.has(entry.candidate.key),
    deniedForMs: entry.deniedForMs,
    purpose: entry.candidate.purpose ?? null,
  }));

  // The boundary is the lowest-ranked ADMITTED against the highest-ranked ELIGIBLE DENIED. Not
  // `order[i]` vs `order[i+1]`: residency-protected incumbents claim slots before the rank walk, so
  // adjacency in the sorted array is not adjacency at the decision boundary.
  let lastAdmitted: ScoredInternal | undefined;
  let firstDenied: ScoredInternal | undefined;
  for (const entry of eligible) {
    if (admittedSet.has(entry.candidate.key)) {
      if (lastAdmitted === undefined || entry.rank < lastAdmitted.rank) lastAdmitted = entry;
    } else if (firstDenied === undefined || entry.rank > firstDenied.rank) {
      firstDenied = entry;
    }
  }

  let tieBroken: AdmissionTieBreak;
  if (firstDenied === undefined || lastAdmitted === undefined) {
    tieBroken = "uncontended";
  } else if (heldByResidency.length > 0) {
    // The strong case: a protected incumbent kept a slot a strictly higher-ranked candidate wanted.
    // Checked first because it subsumes the equal-rank case below.
    tieBroken = "residency";
  } else if (lastAdmitted.rank !== firstDenied.rank) {
    tieBroken = "rank";
  } else if (lastAdmitted.residencyProtected !== firstDenied.residencyProtected) {
    tieBroken = "residency";
  } else {
    tieBroken = "key";
  }

  const boundary: AdmissionBoundaryDeclaration =
    firstDenied === undefined || lastAdmitted === undefined
      ? "none"
      : lastAdmitted.undeclared === firstDenied.undeclared
        ? lastAdmitted.undeclared
          ? "undeclared"
          : "declared"
        : "mixed";

  let agingAllZero = true;
  let incumbentDeniedForMsIsResidency = true;
  for (const entry of scored) {
    if (entry.rank !== entry.merit) agingAllZero = false;
    const admittedAt = entry.candidate.admittedAtMs;
    if (admittedAt != null && entry.deniedForMs !== Math.max(0, nowMs - admittedAt)) {
      incumbentDeniedForMsIsResidency = false;
    }
  }

  return {
    capacity,
    tieBroken,
    boundary,
    entries,
    agingAllZero,
    incumbentDeniedForMsIsResidency,
  };
}

const KEY_SCORED = "admission.scored";
const MAX_SCORED_RECORDS = 256;

/**
 * Record one scored decision. Caller must already have checked {@link kernelDiagnostics}.enabled —
 * this is the ring copy the S7.2 audit flagged as genuinely expensive, and the guard has to be at the
 * call site to be worth anything.
 *
 * The C1/C2 assertions are recorded as `repair`-severity events rather than thrown. A throw here would
 * be a behaviour change smuggled in behind a diagnostics guard, which is the exact thing the retained
 * flag exists to keep impossible.
 */
export function noteAdmissionScored(session: RuntimeSession, decision: AdmissionScoredDecision): void {
  if (!kernelDiagnostics.enabled) return;
  const prev = session.state.get<AdmissionScoredDecision[]>(KEY_SCORED, []);
  session.state.set(
    KEY_SCORED,
    prev.length >= MAX_SCORED_RECORDS ? [...prev.slice(1), decision] : [...prev, decision]
  );
  kernelDiagnostics.record({
    kind: "denial",
    severity: "info",
    subject: { kind: "resource", resourceKind: "decode-session" },
    reason: `admission-scored:${decision.tieBroken}`,
    detail: {
      capacity: decision.capacity,
      candidates: decision.entries.length,
      boundary: decision.boundary,
      agingAllZero: decision.agingAllZero,
      incumbentDeniedForMsIsResidency: decision.incumbentDeniedForMsIsResidency,
    },
  });
  // Assertion failures get their own reason so they aggregate in `__rfKernel.summary()` rather than
  // hiding in a detail field nobody groups by. C1 and C2 are the two premises Stage 1's analysis
  // rests on; if either stops holding, the run that shows it must be impossible to miss.
  if (!decision.agingAllZero) {
    kernelDiagnostics.record({
      kind: "repair",
      severity: "warn",
      subject: { kind: "resource", resourceKind: "decode-session" },
      reason: "admission-assert-c1-aging-nonzero",
    });
  }
  if (!decision.incumbentDeniedForMsIsResidency) {
    kernelDiagnostics.record({
      kind: "repair",
      severity: "warn",
      subject: { kind: "resource", resourceKind: "decode-session" },
      reason: "admission-assert-c2-deniedforms-not-residency",
    });
  }
}

export function admissionScored(session: RuntimeSession): readonly AdmissionScoredDecision[] {
  return session.state.get<AdmissionScoredDecision[]>(KEY_SCORED, []);
}

// ── Diagnostics (§6.12: report the excess, attribute it) ────────────────────
const KEY_DENIALS = "admission.denials";
const MAX_DENIAL_RECORDS = 64;

/**
 * Record a denial. Allocation-free when diagnostics are off (programme risk R1: the instrument must not
 * be the thing being measured).
 */
export function noteAdmissionDenied(session: RuntimeSession, denial: AdmissionDenial): void {
  // R1: the ring copy below is an allocation on the cap-miss path. `kernelDiagnostics.record` gates
  // itself, but only after the payload is built, so the check has to be here to be worth anything.
  if (!kernelDiagnostics.enabled) return;
  const prev = session.state.get<AdmissionDenial[]>(KEY_DENIALS, []);
  session.state.set(
    KEY_DENIALS,
    prev.length >= MAX_DENIAL_RECORDS ? [...prev.slice(1), denial] : [...prev, denial]
  );
  kernelDiagnostics.record({
    kind: "denial",
    // WARN only for the §6.11 terminal. An over-budget denial is the slice WORKING — capacity really is
    // finite and something has to lose — so warning on it would train the reader to ignore the channel
    // that carries the one denial nobody should ever see.
    severity: denial.reason === "permanently-denied" ? "warn" : "info",
    subject: { kind: "resource", resourceKind: "decode-session" },
    reason: `admission-denied:${denial.reason}`,
    detail: {
      key: denial.key,
      rank: denial.rank,
      admittedFloor: denial.admittedFloor,
      deniedForMs: denial.deniedForMs,
      undeclared: denial.undeclared,
    },
  });
}

export function admissionDenials(session: RuntimeSession): readonly AdmissionDenial[] {
  return session.state.get<AdmissionDenial[]>(KEY_DENIALS, []);
}
