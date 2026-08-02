/**
 * ORIS Stage A — Experience Stream acceptance suite.
 * Run: `pnpm --filter @orreris/web experience:eval`
 *
 * Stage A's acceptance is OBSERVABILITY, not intelligence, so these checks are about whether
 * the corpus is trustworthy and re-analysable — never about whether the system is smart:
 *
 *  - ONE LOG, MANY PRODUCERS: events are envelopes with typed payloads, so a session or
 *    outcome row never carries decision-shaped fields, and ordering stays global;
 *  - session-scoped facts (schemaVersion/buildId/seatId) are NORMALISED onto the session row
 *    rather than duplicated per event — and eviction never orphans that join (L8);
 *  - τ is re-derivable: `tauInputs` is sufficient to recompute the whole stream under a
 *    different model (the property H2 will be tested with, once the Ledger exists);
 *  - the surprise term is honestly NULL, not silently 1.0 — a stub that reads as a
 *    measurement is worse than no stub;
 *  - signals are recorded as EVIDENCE, including kinds the provisional segmenter ignores;
 *  - RETROACTIVE SEGMENTATION: the same corpus re-cuts under any policy, and a policy using
 *    a signal the provisional one ignored produces genuinely different boundaries. This is
 *    the load-bearing check — it is what makes Stage C possible without re-collecting data.
 *  - ceilings + eviction are honest (ORIS-9), and growth is measurable from day one (H7).
 *
 * Standalone tsx assert script (no test framework), same convention as world:eval.
 */

// Storage fake must exist before any lazily-hydrating module touches it (node has none).
const fakeStorage = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (key: string) => fakeStorage.get(key) ?? null,
  setItem: (key: string, value: string) => void fakeStorage.set(key, value),
  removeItem: (key: string) => void fakeStorage.delete(key),
  clear: () => fakeStorage.clear()
};

import * as streamModule from "./stream";
import {
  BASELINE_POLICIES,
  BUILD_COVERAGE,
  COVERAGE_POLICY_ID,
  INTENT_CLASS_POLICY_ID,
  PRODUCER_KINDS,
  PROVISIONAL_POLICY,
  PROVISIONAL_POLICY_ID,
  PROVISIONAL_POLICY_V1,
  SCHEMA_VERSION,
  __resetExperienceMemoryForTests,
  appendDecisionEvent,
  appendEditCommit,
  appendHistoryAction,
  beginDecision,
  clearExperience,
  configureExperience,
  experienceStats,
  isAction,
  isDecision,
  isSession,
  listDecisions,
  listEpisodes,
  listExperience,
  listSessions,
  noteBoundarySignal,
  observeFact,
  recomputeTau,
  segment,
  setSituation,
  subscribeExperience,
  TAU_POLICY_ID,
  TAU_POLICY_V1_ID,
  tauAdvance,
  type SegmentationPolicy
} from "./stream";
import { recordDecisionTrace } from "../decision-trace";
import type { DecisionTrace } from "../decision-trace";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** All synthetic events land after the real-clock session row, so `t` ordering stays sane. */
const T0 = Date.now() + 60_000;

let failures = 0;
let passes = 0;

/**
 * The suite must not silently SHRINK. A green run with fewer checks than yesterday is a
 * regression that reports success — the same false-confidence failure as an eval outside the
 * compiler. Raise this when checks are added; never lower it without saying why.
 */
const EXPECTED_MIN_CHECKS = 111;

function check(label: string, ok: boolean, detail?: string): void {
  if (ok) {
    passes += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failures += 1;
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function trace(over: Partial<DecisionTrace> = {}): DecisionTrace {
  return {
    prompt: "make it moody",
    route: "⚡ Instant local tier (t0.apply-look)",
    zeroTokens: true,
    notes: [],
    steps: ["Applied Noir @ 55%"],
    applied: 1,
    failed: 0,
    at: T0,
    ...over
  };
}

async function main(): Promise<void> {
  console.log("\nORIS Stage A — Experience Stream (envelope schema v" + SCHEMA_VERSION + ")\n");

  // ── envelope + producers ───────────────────────────────────────────────────────────────
  console.log("one log, many producers");
  configureExperience({ buildId: "test-build-abc123" });
  clearExperience();
  check("opening the stream writes a session row", listSessions().length === 1);
  check("the session row is produced by `system`, not `ai`", listSessions()[0]!.producer === "system");

  const first = appendDecisionEvent(trace());
  check("a decision row is produced by `ai`", first.producer === "ai");
  check("payload is namespaced, not flattened onto the envelope", first.payload.prompt === "make it moody");
  check("envelope carries id/seq/t/tau/session", first.seq > 0 && first.sessionId.length > 0);
  check(
    "the envelope carries NO episode — it failed the admission test (v4)",
    !("episodeId" in first) && !("openedEpisode" in first),
    "a producer never witnesses an episode; boundaries are a function over signals under a policy"
  );
  check("τ names the policy that derived it (L12)", first.tauPolicy === TAU_POLICY_ID);
  check("kinds share one ordered log", listExperience().length === 2 && listExperience()[0]!.kind === "session");
  check("isDecision / isSession narrow the union", listExperience().filter(isDecision).length === 1 && listExperience().filter(isSession).length === 1);

  // ── session-scoped facts, normalised ───────────────────────────────────────────────────
  console.log("\nsession-scoped facts (normalised, not duplicated)");
  const session = listSessions()[0]!;
  check("session carries schemaVersion", session.payload.schemaVersion === SCHEMA_VERSION);
  check("session carries buildId (§12 item 11)", session.payload.buildId === "test-build-abc123");
  check("session carries a stable non-PII seatId (§12 item 12)", session.payload.seatId.startsWith("seat-"));
  check("session records COVERAGE — what this build could observe (U8/I12)", session.payload.coverage.length > 0);
  check("coverage names its vocabulary version", session.payload.coveragePolicy === COVERAGE_POLICY_ID, "absence is only readable against a version");
  check(
    "coverage claims the editor seams that are actually wired",
    ["editor.commit", "editor.undo", "editor.redo"].every((t) => session.payload.coverage.includes(t))
  );
  check(
    "coverage does NOT claim the human-side gaps ADR-017 leaves open",
    !session.payload.coverage.includes("human.initiator") && !session.payload.coverage.includes("human.operationIdentity"),
    "a token present means the build COULD produce it; claiming one it cannot is the I10 fabrication"
  );
  check(
    "coverage does not claim the unwired decision fields",
    !session.payload.coverage.includes("decision.situation") && !session.payload.coverage.includes("decision.facts"),
    "they read null today; coverage is what makes that legible as unwired rather than measured"
  );
  check("the exported vocabulary and the recorded row agree", BUILD_COVERAGE.join() === session.payload.coverage.join());
  check("decision rows join by sessionId, never duplicate the facts", first.sessionId === session.sessionId && !("buildId" in first.payload));

  const second = appendDecisionEvent(trace({ at: T0 + 500, prompt: "make it moodier" }));
  check("seq increments across kinds", second.seq === first.seq + 1);

  // ── ORIS-17 / ORIS-18 — the two producer-contract invariants ──────────────────────────
  console.log("\nreference conservation (ORIS-17) + producer boundaries (ORIS-18)");
  check("a decision declares its reference to the session row", first.refs.includes(session.id));
  check("the session row references nothing", session.refs.length === 0);
  check(
    "no generic append is exported — the boundary is STRUCTURAL, not documentary",
    !("push" in streamModule) && !("append" in streamModule) && !("appendEvent" in streamModule),
    "a generic append would let any producer fabricate any other producer's observations"
  );
  check("the producer table names each boundary", PRODUCER_KINDS.ai.join() === "decision" && PRODUCER_KINDS.system.join() === "session");
  check(
    "the editor producer claims `action`, and NOT `outcome`",
    PRODUCER_KINDS.editor.join() === "action",
    "ADR-017 U1: nobody witnesses an outcome, so there is no outcome kind to claim"
  );
  check(
    "a genuinely unwired producer still claims nothing",
    PRODUCER_KINDS.ledger.length === 0,
    "ledger→prediction is declared in prose, not yet observed"
  );
  check(
    "no producer may emit another's kind",
    !PRODUCER_KINDS.ai.includes("action") && !PRODUCER_KINDS.editor.includes("decision"),
    "ORIS-18 — the editor never claims a confidence, the AI never claims a committed mutation"
  );

  // ── τ ──────────────────────────────────────────────────────────────────────────────────
  console.log("\nsubjective time (τ)");
  check("a session start does not advance τ", session.dTau === 0, "opening the app changes nothing about the world");
  check("τ advances on decisions", second.tau > first.tau);
  check("dTau is consequence-weighted", first.dTau === tauAdvance(first.tauInputs));
  const failing = appendDecisionEvent(trace({ at: T0 + 1000, applied: 0, failed: 2 }));
  check("a failure advances τ more than a clean apply", failing.dTau > first.dTau, `${failing.dTau} vs ${first.dTau}`);
  check("the surprise term is honestly null (no Ledger yet)", first.tauInputs.surprise === null, "a stub that reads as a measurement is worse than no stub");

  const corpus = listExperience();
  const rederived = recomputeTau(corpus, (inputs) => inputs.base * inputs.consequence);
  check("recomputeTau reproduces the live τ under the same model", rederived[rederived.length - 1]!.tau === corpus[corpus.length - 1]!.tau);
  const surpriseModel = recomputeTau(corpus, (inputs, event) => inputs.base * inputs.consequence * (isDecision(event) && event.payload.failed > 0 ? 5 : 1));
  check("recomputeTau re-derives the corpus under a DIFFERENT model", surpriseModel[surpriseModel.length - 1]!.tau !== corpus[corpus.length - 1]!.tau, "stored τ inputs are sufficient to re-run history");

  // ── signals: witnessed are written, derived are computed (ADR-016 I3) ──────────────────
  console.log("\nboundary signals (witnessed → written · derived → read-time)");
  clearExperience();
  appendDecisionEvent(trace({ at: T0, prompt: "grade this warmer" }));
  const afterGap = appendDecisionEvent(trace({ at: T0 + 45 * 60 * 1000, prompt: "grade the next one" }));
  check("an idle gap is NOT written to the corpus (I6 — timestamp arithmetic is a derivation)", !afterGap.signals.some((s) => s.kind === "idle-gap"));
  check("the gap still cuts an episode, from the policy's own threshold", segment(listExperience(), PROVISIONAL_POLICY).length === 2, "nothing is lost by moving it to read time — that is the whole test");
  check("the superseded policy is RETAINED and still runnable (I8)", PROVISIONAL_POLICY_V1.id === "provisional.strong-signals.v1" && segment(listExperience(), PROVISIONAL_POLICY_V1).length >= 1, "a policy id that resolves to nothing is a decoration, not a citation");
  check("the current provisional policy names its own version", PROVISIONAL_POLICY.id.endsWith(".v2"));

  clearExperience();
  appendDecisionEvent(trace({ at: T0, prompt: "grade this warmer" }));
  const switched = appendDecisionEvent(trace({ at: T0 + 100, prompt: "cut this clip shorter" }));
  check("a classifier's output is NOT written to the corpus (I3/I4)", !switched.signals.some((s) => s.kind === "intent-class-change"), "a keyword table is a policy; two honest observers populate it differently");
  check("intent-class-change is still expressible, from the stored prompt", segment(listExperience(), { id: "t.intent", openOn: ["intent-class-change"], idleGapMs: 0, fixedEvents: 0, fixedWindowMs: 0 }).length === 2);
  check("intent-class-change does not cut under the provisional policy", segment(listExperience(), PROVISIONAL_POLICY).length === 1, "strong signals only; Stage C may disagree — and can, because nothing was frozen into the rows");
  check("the classifier names and versions itself", INTENT_CLASS_POLICY_ID.endsWith(".v1"));

  const errored = appendDecisionEvent(trace({ at: T0 + 200, applied: 0, failed: 1 }));
  check("outcome-error is NOT written — it restates payload.failed, which is stored", !errored.signals.some((s) => s.kind === "outcome-error"));
  check("outcome-error is still derivable from that stored field", segment(listExperience(), { id: "t.err", openOn: ["outcome-error"], idleGapMs: 0, fixedEvents: 0, fixedWindowMs: 0 }).length === 2);

  clearExperience();
  appendDecisionEvent(trace({ at: T0 }));
  noteBoundarySignal("project-switch", "opened Vance reel");
  const afterSwitch = appendDecisionEvent(trace({ at: T0 + 100 }));
  check("an emitted signal attaches to the next event", afterSwitch.signals.some((s) => s.kind === "project-switch"));
  check("a strong signal cuts a new episode ON READ", listEpisodes().length === 2);
  check("the provisional cut names itself, and holds no privilege", listEpisodes()[0]!.id.startsWith(PROVISIONAL_POLICY_ID));
  const afterDrain = appendDecisionEvent(trace({ at: T0 + 200 }));
  check("emitted signals drain (never attach twice)", !afterDrain.signals.some((s) => s.kind === "project-switch"));
  check("provisional episodes are listable", listEpisodes().length === 2);

  // ── the editor producer (ADR-017) ─────────────────────────────────────────────────────
  console.log("\nthe editor producer — committed mutations, never outcomes");
  clearExperience();
  const commit = appendEditCommit({
    initiator: "ai",
    actionIds: ["addEffect", "setEffectParam"],
    summary: "Color grade (2 effects)",
    graphVersion: 7,
    undoDepth: 1
  });
  check("an action row is produced by `editor`", commit.producer === "editor" && commit.kind === "action");
  check("isAction narrows the union", listExperience().filter(isAction).length === 1);
  check("a commit records the declared initiator", commit.payload.initiator === "ai");
  check("actionIds is a LIST, so a multi-action commit keeps all of them", commit.payload.actionIds.length === 2, "a scalar would silently keep only the last");
  check("the action row references the session row (ORIS-17)", commit.refs.length === 1);
  check("an action row carries NO decision fields", !("prompt" in commit.payload) && !("confidence" in commit.payload));
  check(
    "an action row carries no outcome class, verdict, or causal ref (U11)",
    !("outcome" in commit.payload) && !("accepted" in commit.payload) && !("refDecision" in commit.payload),
    "nobody witnesses acceptance; it is derived at read time or not at all"
  );

  const undeclared = appendEditCommit({ initiator: null, actionIds: [], summary: null, graphVersion: 8, undoDepth: 2 });
  check(
    "an undeclared commit records null, NEVER 'user' (U6)",
    undeclared.payload.initiator === null,
    "treating an omitted declaration as evidence of a human is the I10 fabrication"
  );

  const undone = appendHistoryAction({ operation: "undo", graphVersion: 7, undoDepth: 1 });
  check("an undo is recorded as an OCCURRENCE", undone.payload.operation === "undo");
  check(
    "an undo records no target and no initiator (U5/U9)",
    undone.payload.actionIds.length === 0 && undone.payload.initiator === null,
    "the history stack holds snapshots, not commits — the target was never witnessed"
  );
  check("an undo does not advance τ", undone.dTau === 0, "it returns the world to a state it already occupied");
  check("a commit DOES advance τ", commit.dTau > 0);
  check("the superseded τ policy is retained and distinct (I8)", TAU_POLICY_V1_ID !== TAU_POLICY_ID && TAU_POLICY_V1_ID.endsWith(".v1"));

  // ── situation: state, not an event ────────────────────────────────────────────────────
  console.log("\nsituation (standing state, snapshotted at append)");
  clearExperience();
  const unwired = appendDecisionEvent(trace({ at: T0 }));
  check("an unwired situation reads null, never a plausible default", unwired.payload.situation.projectId === null, "null must stay distinguishable from a measured absence");
  setSituation({ projectId: "proj-vance", focusPanel: "timeline", selectionCount: 2 });
  const situated = appendDecisionEvent(trace({ at: T0 + 100 }));
  check("a set situation is snapshotted onto the decision", situated.payload.situation.projectId === "proj-vance" && situated.payload.situation.selectionCount === 2);
  setSituation({ selectionCount: 5 });
  const merged = appendDecisionEvent(trace({ at: T0 + 200 }));
  check("situation persists until changed (it is state, not an event)", merged.payload.situation.projectId === "proj-vance" && merged.payload.situation.selectionCount === 5);
  check("the earlier snapshot is unaffected by a later change", situated.payload.situation.selectionCount === 2);

  // ── fact scope: a fact belongs to exactly one decision ────────────────────────────────
  console.log("\nfact scope (a fact belongs to exactly ONE decision)");
  clearExperience();
  const fact = (id: string) => ({
    factId: id,
    type: "media.look",
    target: "clip-3",
    value: { mean: 0.21 },
    confidence: 0.9,
    observerId: "look@world",
    observerVersion: 2,
    inputSignature: "sig-abc",
    accessPath: "cached",
    costMs: 0
  });

  check("a fact observed with NO open scope is REJECTED", observeFact(fact("f0")) === false, "never buffered forward — that is the contamination bug");
  check("the rejection is counted, not swallowed", experienceStats().factsOrphaned === 1);

  beginDecision("turn-1");
  observeFact(fact("f1"));
  observeFact(fact("f2"));
  const withFacts = appendDecisionEvent(trace({ at: T0 }));
  check("an open scope's facts attach to its decision", withFacts.payload.factsConsulted.length === 2);
  check("the snapshot keeps the value AS CONSULTED", JSON.stringify(withFacts.payload.factsConsulted[0]!.value) === JSON.stringify({ mean: 0.21 }), "the fact store will cascade-invalidate this; the snapshot is all that survives");

  const nextDecision = appendDecisionEvent(trace({ at: T0 + 100 }));
  check("the scope CLOSES on append — no leakage into the next decision", nextDecision.payload.factsConsulted.length === 0);

  const orphansBefore = experienceStats().factsOrphaned;
  beginDecision("turn-2");
  observeFact(fact("f3"));
  beginDecision("turn-3-forgot-to-append");
  const afterReopen = appendDecisionEvent(trace({ at: T0 + 200 }));
  check("re-opening a scope DISCARDS the old facts, never merges them", afterReopen.payload.factsConsulted.length === 0);
  check("a forgotten drain is loud in the metrics", experienceStats().factsOrphaned === orphansBefore + 1, "months-later 'attribution looks strange' is exactly what this prevents");

  // ── decision enrichment ───────────────────────────────────────────────────────────────
  console.log("\ndecision enrichment (§12.1 items 5–7, 9)");
  clearExperience();
  const enriched = appendDecisionEvent(
    trace({
      at: T0 + 900,
      startedAt: T0 + 500,
      owner: { tier: "reflex", ruleId: "t0.apply-look", recipeId: "moody", provider: null },
      confidence: { label: "Exact", percent: null },
      actions: [{ actionId: "addEffect", targetLayerIds: ["layer-1"], ok: true, error: null }],
      candidates: [
        { id: "grade-the-picture", score: 0.72, chosen: true, whyRejected: null },
        { id: "restyle-the-titles", score: 0.28, chosen: false, whyRejected: "text-light timeline" }
      ]
    })
  );
  check("owner is structured, not a parsed display string", enriched.payload.owner?.ruleId === "t0.apply-look");
  check("the claim is recorded (H5 needs it)", enriched.payload.confidence?.label === "Exact");
  check("start and finish are a PAIR, not a duration", enriched.payload.startedAt === T0 + 500 && enriched.t === T0 + 900);
  check("latency stays derivable from the pair", enriched.t - enriched.payload.startedAt! === 400);
  check("actions are structured alongside the prose steps", enriched.payload.actions[0]?.actionId === "addEffect" && enriched.payload.steps.length > 0);
  check("REJECTED candidates are preserved, not just the winner", enriched.payload.candidates.filter((c) => !c.chosen).length === 1, "0.72/0.28 and 0.72/0.71 are radically different internal states");
  const bare = appendDecisionEvent(trace({ at: T0 + 1000 }));
  check("an un-enriched trace records nulls, not defaults", bare.payload.owner === null && bare.payload.confidence === null && bare.payload.startedAt === null);

  // ── live subscription (the ?aiThinkingShow=1 viewport) ────────────────────────────────
  console.log("\nlive subscription");
  let seen = 0;
  const unsubscribe = subscribeExperience(() => {
    seen += 1;
  });
  appendDecisionEvent(trace({ at: T0 + 1100 }));
  check("subscribers see appends", seen === 1);
  const throwingOff = subscribeExperience(() => {
    throw new Error("viewer blew up");
  });
  let viewerBroke = false;
  try {
    appendDecisionEvent(trace({ at: T0 + 1200 }));
  } catch {
    viewerBroke = true;
  }
  check("a throwing viewer can never break the stream", !viewerBroke && seen === 2);
  throwingOff();
  unsubscribe();
  appendDecisionEvent(trace({ at: T0 + 1300 }));
  check("unsubscribe detaches", seen === 2);

  // ── retroactive segmentation — the reason Stage A ships before Stage C ─────────────────
  console.log("\nretroactive segmentation");
  clearExperience();
  for (let i = 0; i < 50; i += 1) {
    if (i === 25) {
      noteBoundarySignal("export-started", "delivered v3");
    }
    appendDecisionEvent(
      trace({
        at: T0 + i * 60_000,
        prompt: i % 2 === 0 ? "grade this warmer" : "cut this shorter",
        failed: i === 40 ? 1 : 0
      })
    );
  }
  const decisions = listDecisions();
  check("corpus built", decisions.length === 50);
  check("segmentation runs over the whole log, mixed kinds included", listExperience().length === 51);

  const fixed20 = segment(decisions, BASELINE_POLICIES.fixed20!);
  check("fixed-20-events baseline cuts 3 episodes", fixed20.length === 3, `got ${fixed20.length}`);
  const fixed5m = segment(decisions, BASELINE_POLICIES.fixed5m!);
  check("fixed-5-min baseline cuts 10 episodes", fixed5m.length === 10, `got ${fixed5m.length}`);
  const gap = segment(decisions, BASELINE_POLICIES.activityGap!);
  check("activity-gap baseline finds no gaps in dense work", gap.length === 1, `got ${gap.length}`);

  // The load-bearing check: a policy keyed on a signal the PROVISIONAL segmenter ignored
  // must produce different boundaries from the same stored corpus.
  const intentPolicy: SegmentationPolicy = {
    id: "candidate.intent-class-change",
    openOn: ["intent-class-change"],
    idleGapMs: 0,
    fixedEvents: 0,
    fixedWindowMs: 0
  };
  const byIntent = segment(decisions, intentPolicy);
  const provisional = listEpisodes();
  check("a corpus re-cuts under a policy the writer never used", byIntent.length > provisional.length, `intent-change ${byIntent.length} vs provisional ${provisional.length}`);

  const errorPolicy: SegmentationPolicy = {
    id: "candidate.error-spike",
    openOn: ["outcome-error"],
    idleGapMs: 0,
    fixedEvents: 0,
    fixedWindowMs: 0
  };
  check("the EST hypothesis (error-spike boundaries) is expressible today", segment(decisions, errorPolicy).length === 2);
  check("episode summaries carry outcomes for scoring", fixed20[0]!.applied > 0 && fixed20[0]!.eventCount === 20);

  // ── wiring ─────────────────────────────────────────────────────────────────────────────
  console.log("\nwiring + robustness");
  clearExperience();
  recordDecisionTrace(trace({ at: T0, prompt: "why did you do that?" }));
  check("recordDecisionTrace appends to the stream", listDecisions().length === 1);
  const malformed = { ...trace({ at: T0 + 100 }), notes: null } as unknown as DecisionTrace;
  let threw = false;
  try {
    recordDecisionTrace(malformed);
  } catch {
    threw = true;
  }
  check("a stream failure never breaks the caller", !threw, "observability must not take down what it observes");

  // ── ceiling + growth (ORIS-9, H7, L8) ─────────────────────────────────────────────────
  console.log("\nceiling + growth");
  clearExperience();
  const ceiling = experienceStats().ceiling;
  for (let i = 0; i < ceiling + 25; i += 1) {
    appendDecisionEvent(trace({ at: T0 + i * 1_000 }));
  }
  const stats = experienceStats();
  check("the stream is bounded", stats.decisions === ceiling, `${stats.decisions} vs ${ceiling}`);
  check("eviction is counted, never silent", stats.evicted === 25, `${stats.evicted}`);
  check("a referenced row is PINNED against eviction (ORIS-17)", stats.sessions === 1, "otherwise survivors lose their buildId/seatId join");
  check(
    "provenance beats the ceiling, and the overflow is REPORTED",
    stats.pinned === 1 && stats.events === ceiling + 1,
    `pinned=${stats.pinned} events=${stats.events} — a ceiling breach is visible and recoverable; a dangling ref is not`
  );
  check("no surviving row has a dangling reference", listExperience().every((event) => event.refs.every((ref) => listExperience().some((other) => other.id === ref))));
  check("seq is never renumbered after eviction", listDecisions()[0]!.seq === 27, `${listDecisions()[0]!.seq}`);
  check("bytes/event is measurable from day one (H7)", stats.bytesPerEvent > 0);
  console.log(`    · ${stats.bytesPerEvent.toFixed(0)} bytes/event · ${(stats.bytes / 1024).toFixed(0)} KB at ceiling · τ=${stats.tau.toFixed(0)}`);

  // ── persistence ────────────────────────────────────────────────────────────────────────
  console.log("\npersistence");
  clearExperience();
  appendDecisionEvent(trace({ at: T0, prompt: "persisted ask" }));
  await sleep(900);
  __resetExperienceMemoryForTests();
  const reloaded = listDecisions();
  check("history survives a reload", reloaded.length === 1 && reloaded[0]!.payload.prompt === "persisted ask");
  const sessionsAfter = listSessions();
  check("a reload writes its own session row", sessionsAfter.length === 2, `${sessionsAfter.length}`);
  check("the reload is labelled as such, not as a cold start", sessionsAfter[1]!.payload.reason === "reload");
  const reopened = appendDecisionEvent(trace({ at: T0 + 100 }));
  check("a reload opens a new session", reopened.sessionId !== reloaded[0]!.sessionId);
  check("a reload therefore cuts a new episode on read", listEpisodes().length === 2);
  check("seq continues across a reload", reopened.seq > reloaded[0]!.seq);

  // ── admitting a stored corpus (ADR-016 I9, I10) ───────────────────────────────────────
  console.log("\nload-time admission (I9 refuse loudly · I10 never fabricate)");
  const storageKey = [...fakeStorage.keys()].find((key) => key.startsWith("orreris.oris.experience"));
  check("the corpus has a storage key to admit from", storageKey !== undefined);

  // One well-formed row, one that fails the shape check. The bad row must be REFUSED and
  // COUNTED — the old behaviour dropped it silently, making the corpus quietly smaller than
  // its own seq numbers imply.
  fakeStorage.set(
    storageKey!,
    JSON.stringify({
      events: [
        { id: "xp-good", seq: 1, sessionId: "s-x", t: T0, tau: 0, dTau: 0, tauInputs: { base: 1, consequence: 0, surprise: null }, tauPolicy: TAU_POLICY_ID, producer: "system", kind: "session", refs: [], signals: [], payload: { reason: "cold-start", schemaVersion: SCHEMA_VERSION, buildId: "b", seatId: "s", startedAt: T0 } },
        { id: "xp-bad", seq: 2 } // no payload — malformed
      ],
      nextSeq: 3,
      tau: 0,
      evicted: 0
    })
  );
  __resetExperienceMemoryForTests();
  const admitted = listExperience();
  check("a malformed row is refused, not admitted", !admitted.some((event) => event.id === "xp-bad"));
  check("the well-formed row is admitted", admitted.some((event) => event.id === "xp-good"));
  check("the refusal is COUNTED, never silent (I9)", experienceStats().malformed === 1, "a corpus that silently shrinks is worse than one that loudly breaks");

  // Unparseable storage: witnessed = "the read failed". NOT witnessed = "this is a cold start".
  fakeStorage.set(storageKey!, "{ this is not json");
  __resetExperienceMemoryForTests();
  const recovered = listSessions();
  check(
    "unreadable storage is recorded as such, not as a cold start (I10)",
    recovered[recovered.length - 1]!.payload.reason === "storage-unreadable",
    "the error path may not fabricate an observation about what kind of start this was"
  );

  fakeStorage.delete(storageKey!);
  clearExperience();
  if (failures === 0 && passes < EXPECTED_MIN_CHECKS) {
    console.error(
      `
❌ suite shrank: ${passes} checks ran, expected at least ${EXPECTED_MIN_CHECKS}. ` +
        `A green run with fewer checks is a regression that reports success.
`
    );
    process.exit(1);
  }
  console.log(
    failures === 0
      ? `\n✅ Stage A observatory green — the corpus is trustworthy and re-analysable.\n`
      : `\n❌ ${failures} check(s) failed.\n`
  );
  process.exit(failures === 0 ? 0 : 1);
}

void main();
