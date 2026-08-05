/**
 * ADR-013 Phase 0 / Stage 0 — the admission observer, watched working.
 *
 * ## Why this file exists, when `kernel:conform` and typecheck are already green
 *
 * ADR-017 U12 is the house standard and it was paid for: five files wired, typecheck clean, every
 * negative test passing, while a wrapper silently dropped the value. A field ships only after its
 * observer has been WATCHED WORKING, and "I read the call path" is a read, not a measurement.
 *
 * `admission.scored` is about to become the sole evidence base for M1 and M5 — the metrics that decide
 * OQ1 and OQ5. Two of its fields are assertions about the runtime (C1, C2) whose failure invalidates
 * Stage 1's analysis. An instrument in that position that has only been typechecked is exactly the
 * shape U12 punished.
 *
 * ## What is asserted, and what is deliberately NOT
 *
 * This proves the observer REPORTS correctly on constructed inputs. It cannot prove C1 or C2 hold in
 * the live runtime — that is what the browser run measures, and conflating the two would be the same
 * substitution of a read for a measurement. Here the C1/C2 cases are constructed BOTH ways, so the
 * assertions are shown to fire as well as to pass. An assertion never seen failing is not known to work.
 *
 *   pnpm --filter @orreris/worker admission:observer
 */
import {
  rankAdmission,
  UNDECLARED_RANK,
  MIN_RESIDENCY_MS,
  type AdmissionCandidate,
  type AdmissionScoredDecision,
  type VisibleContribution,
} from "@orreris/shared";

let failures = 0;
let checks = 0;

function check(label: string, condition: boolean, detail?: string): void {
  checks += 1;
  if (condition) {
    console.log(`  ok    ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const full: VisibleContribution = { reachable: true, area: 1, opacity: 1, underDisabledBranch: false };
const half: VisibleContribution = { reachable: true, area: 0.25, opacity: 1, underDisabledBranch: false };
const invisible: VisibleContribution = { reachable: true, area: 0, opacity: 0, underDisabledBranch: false };

/** Capture the one scored decision `rankAdmission` emits for these inputs. */
function observe(
  candidates: readonly AdmissionCandidate[],
  capacity: number,
  nowMs: number
): AdmissionScoredDecision {
  let captured: AdmissionScoredDecision | null = null;
  rankAdmission(candidates, capacity, nowMs, (decision) => {
    captured = decision;
  });
  if (captured === null) throw new Error("observer was never called — the seam is not wired");
  return captured;
}

console.log("\nADR-013 Phase 0 · Stage 0 — admission observer\n");

// ── The observer must not change the decision (the whole basis for calling it an instrument) ──
console.log("R1 / S7.2 classification — observation changes nothing");
{
  const now = 10_000;
  const candidates: AdmissionCandidate[] = [
    { key: "a", priority: "playhead", contribution: full, firstRequestedAtMs: 0, admittedAtMs: 0 },
    { key: "b", priority: "playhead", contribution: half, firstRequestedAtMs: 0, admittedAtMs: 0 },
    { key: "c", priority: "playhead", contribution: full, firstRequestedAtMs: now, admittedAtMs: null },
  ];
  const withoutObserver = rankAdmission(candidates, 2, now);
  const withObserver = rankAdmission(candidates, 2, now, () => {});
  check(
    "the decision is byte-identical with and without an observer",
    JSON.stringify(withoutObserver) === JSON.stringify(withObserver),
    `${JSON.stringify(withoutObserver)} vs ${JSON.stringify(withObserver)}`
  );
}

// ── tieBroken is TRI-VALUED: the three levels must be distinguishable ──
console.log("\ntieBroken — three comparator levels, told apart");
{
  // Ranks differ at the boundary: the ordering ordered.
  const now = 10_000;
  const decision = observe(
    [
      { key: "a", priority: "playhead", contribution: full, firstRequestedAtMs: 0, admittedAtMs: 0 },
      { key: "b", priority: "playhead", contribution: half, firstRequestedAtMs: 0, admittedAtMs: 0 },
    ],
    1,
    now
  );
  check("distinct ranks at the boundary report `rank`", decision.tieBroken === "rank", decision.tieBroken);
}
{
  // Two full-frame declared sources, both long-resident: equal merit, equal (un)protection → key.
  // This is the case §3.1 predicts dominates the real runtime.
  const now = 10_000;
  const decision = observe(
    [
      { key: "a", priority: "playhead", contribution: full, firstRequestedAtMs: 0, admittedAtMs: 0 },
      { key: "b", priority: "playhead", contribution: full, firstRequestedAtMs: 0, admittedAtMs: 0 },
    ],
    1,
    now
  );
  check("equal rank and equal protection report `key`", decision.tieBroken === "key", decision.tieBroken);
  check("…and the boundary is classified `declared`", decision.boundary === "declared", decision.boundary);
}
{
  // A freshly-admitted low-contribution incumbent holds its slot against a higher-ranked challenger.
  const now = 10_000;
  const decision = observe(
    [
      { key: "a", priority: "playhead", contribution: half, firstRequestedAtMs: 0, admittedAtMs: now - 100 },
      { key: "b", priority: "playhead", contribution: full, firstRequestedAtMs: now, admittedAtMs: null },
    ],
    1,
    now
  );
  check(
    "minimum residency holding a slot reports `residency`",
    decision.tieBroken === "residency",
    decision.tieBroken
  );
}
{
  // Capacity exceeds eligible demand — nothing was contended.
  const now = 10_000;
  const decision = observe(
    [{ key: "a", priority: "playhead", contribution: full, firstRequestedAtMs: 0, admittedAtMs: 0 }],
    4,
    now
  );
  check("spare capacity reports `uncontended`", decision.tieBroken === "uncontended", decision.tieBroken);
  check("…and its boundary is `none`", decision.boundary === "none", decision.boundary);
}

// ── The T_declared / T_undeclared / mixed split ──
console.log("\nboundary classification — the M1 split");
{
  const now = 10_000;
  const decision = observe(
    [
      { key: "a", priority: "playhead", contribution: undefined, firstRequestedAtMs: 0, admittedAtMs: 0 },
      { key: "b", priority: "playhead", contribution: undefined, firstRequestedAtMs: 0, admittedAtMs: 0 },
    ],
    1,
    now
  );
  check(
    "two undeclared candidates tie at exactly UNDECLARED_RANK",
    decision.entries.every((entry) => entry.rank === UNDECLARED_RANK),
    JSON.stringify(decision.entries.map((entry) => entry.rank))
  );
  check(
    "…and their boundary is `undeclared`, never counted as evidence about `area`",
    decision.boundary === "undeclared",
    decision.boundary
  );
  check("…and they fall through to `key`", decision.tieBroken === "key", decision.tieBroken);
}
{
  // The confound made visible: a declared source against an undeclared one is evidence about neither.
  const now = 10_000;
  const decision = observe(
    [
      { key: "a", priority: "playhead", contribution: full, firstRequestedAtMs: 0, admittedAtMs: 0 },
      { key: "b", priority: "playhead", contribution: undefined, firstRequestedAtMs: 0, admittedAtMs: 0 },
    ],
    1,
    now
  );
  check("a declared/undeclared boundary is `mixed`", decision.boundary === "mixed", decision.boundary);
}

// ── C1: the assertion must PASS on the live-path shape and FAIL when aging fires ──
console.log("\nC1 — aging is inert on the live-path candidate shape");
{
  // The exact shape `reportAdmissionDenial` builds: incumbents carry `acquiredAt`, the newcomer's
  // firstRequestedAtMs is `now`.
  const now = 50_000;
  const decision = observe(
    [
      { key: "a", priority: "playhead", contribution: full, firstRequestedAtMs: 1_000, admittedAtMs: 1_000 },
      { key: "b", priority: "playhead", contribution: full, firstRequestedAtMs: 2_000, admittedAtMs: 2_000 },
      { key: "c", priority: "playhead", contribution: full, firstRequestedAtMs: now, admittedAtMs: null },
    ],
    2,
    now
  );
  check("the live-path shape reports agingAllZero = true", decision.agingAllZero, JSON.stringify(decision.entries));
  check(
    "…and every recorded aging term is literally 0",
    decision.entries.every((entry) => entry.aging === 0),
    JSON.stringify(decision.entries.map((entry) => entry.aging))
  );
}
{
  // A candidate that has never been admitted AND has been waiting: aging fires. If the live runtime
  // ever produces this, C1's premise is dead and M1 says so. Proving the assertion CAN fail is the
  // point — an assertion never seen failing is not known to work.
  const now = 50_000;
  const decision = observe(
    [
      { key: "a", priority: "playhead", contribution: full, firstRequestedAtMs: 1_000, admittedAtMs: 1_000 },
      { key: "b", priority: "playhead", contribution: half, firstRequestedAtMs: 1_000, admittedAtMs: null },
    ],
    1,
    now
  );
  check("a genuinely aged candidate reports agingAllZero = false", !decision.agingAllZero);
  const aged = decision.entries.find((entry) => entry.key === "b");
  check("…and its aging term is non-zero and separated from merit", (aged?.aging ?? 0) > 0, JSON.stringify(aged));
}

// ── C2: incumbent deniedForMs is residency age, and the mislabel it produces ──
console.log("\nC2 — deniedForMs means two different things");
{
  const now = 50_000;
  const decision = observe(
    [
      { key: "a", priority: "playhead", contribution: full, firstRequestedAtMs: 1_000, admittedAtMs: 1_000 },
      { key: "b", priority: "playhead", contribution: full, firstRequestedAtMs: 2_000, admittedAtMs: 2_000 },
      { key: "c", priority: "playhead", contribution: full, firstRequestedAtMs: now, admittedAtMs: null },
    ],
    2,
    now
  );
  check(
    "incumbent deniedForMs equals residency age",
    decision.incumbentDeniedForMsIsResidency,
    JSON.stringify(decision.entries)
  );
  const incumbent = decision.entries.find((entry) => entry.key === "a");
  check(
    "…which is 49s of HOLDING a slot, not 49s of being denied",
    incumbent?.deniedForMs === 49_000,
    String(incumbent?.deniedForMs)
  );
  check(
    "…and the incumbent flag is what lets M5 split the census on it",
    decision.entries.filter((entry) => entry.incumbent).length === 2,
    JSON.stringify(decision.entries.map((entry) => entry.incumbent))
  );
}
{
  // The consequence, demonstrated end-to-end: a long-held incumbent displaced on merit is reported as
  // PERMANENTLY DENIED — the inverse of its situation, on the one reason carrying severity "warn".
  const now = 50_000;
  const result = rankAdmission(
    [
      { key: "old-incumbent", priority: "playhead", contribution: half, firstRequestedAtMs: 1_000, admittedAtMs: 1_000 },
      { key: "newcomer", priority: "playhead", contribution: full, firstRequestedAtMs: now, admittedAtMs: null },
    ],
    1,
    now
  );
  const denial = result.denied.find((entry) => entry.key === "old-incumbent");
  check(
    "a 49s-resident incumbent displaced on merit is labelled `permanently-denied`",
    denial?.reason === "permanently-denied",
    JSON.stringify(denial)
  );
  check("…while it was never denied at all until this instant", denial?.deniedForMs === 49_000, String(denial?.deniedForMs));
}

// ── The zero-contribution exclusion must not be misread as a contention denial ──
console.log("\nsanity — invisible sources are not scarcity denials");
{
  const now = 10_000;
  const decision = observe(
    [
      { key: "a", priority: "playhead", contribution: full, firstRequestedAtMs: 0, admittedAtMs: 0 },
      { key: "b", priority: "playhead", contribution: invisible, firstRequestedAtMs: 0, admittedAtMs: 0 },
    ],
    1,
    now
  );
  check(
    "a provably-invisible source is excluded from the boundary, so this reads `uncontended`",
    decision.tieBroken === "uncontended",
    decision.tieBroken
  );
}

// ── Residency window boundary, so MIN_RESIDENCY_MS is not silently assumed ──
console.log("\nsanity — the residency window is the one the kernel declares");
{
  const now = 10_000;
  const justExpired = observe(
    [
      { key: "a", priority: "playhead", contribution: half, firstRequestedAtMs: 0, admittedAtMs: now - MIN_RESIDENCY_MS },
      { key: "b", priority: "playhead", contribution: full, firstRequestedAtMs: now, admittedAtMs: null },
    ],
    1,
    now
  );
  check(
    "protection has lapsed exactly at MIN_RESIDENCY_MS — merit wins",
    justExpired.tieBroken === "rank",
    justExpired.tieBroken
  );
}

// ── C15 purpose class: RECORDED, never RANKED ───────────────────────────────
//
// The whole justification for threading purpose during a measurement programme is that it is data and
// not policy. If it ever influenced the decision it would be a mechanism change mid-measurement, and
// every number collected before and after would stop being comparable. This asserts the property
// rather than trusting the comment that claims it.
console.log("\nC15 — purpose is recorded and never ranked");
{
  const now = 10_000;
  const base: AdmissionCandidate[] = [
    { key: "a", priority: "playhead", contribution: full, firstRequestedAtMs: 0, admittedAtMs: 0 },
    { key: "b", priority: "playhead", contribution: half, firstRequestedAtMs: 0, admittedAtMs: 0 },
    { key: "c", priority: "playhead", contribution: full, firstRequestedAtMs: now, admittedAtMs: null },
  ];
  const withPurpose: AdmissionCandidate[] = [
    { ...base[0]!, purpose: "thumbnail" },
    { ...base[1]!, purpose: "live" },
    { ...base[2]!, purpose: "analysis" },
  ];
  const plain = rankAdmission(base, 2, now);
  const tagged = rankAdmission(withPurpose, 2, now);
  check(
    "tagging every candidate with a purpose changes the decision NOT AT ALL",
    JSON.stringify(plain.admitted) === JSON.stringify(tagged.admitted) &&
      JSON.stringify(plain.heldByResidency) === JSON.stringify(tagged.heldByResidency),
    `${JSON.stringify(plain.admitted)} vs ${JSON.stringify(tagged.admitted)}`
  );
  check(
    "…including when the LOWEST-merit candidate is the only `live` one",
    tagged.denied.some((d) => d.key === "b"),
    JSON.stringify(tagged.denied.map((d) => d.key))
  );

  const decision = observe(withPurpose, 2, now);
  check(
    "…and the purpose is nevertheless recorded on every scored entry",
    decision.entries.every((e) => e.purpose !== undefined),
    JSON.stringify(decision.entries.map((e) => e.purpose))
  );
  check(
    "…faithfully, without being folded together",
    new Set(decision.entries.map((e) => e.purpose)).size === 3,
    JSON.stringify(decision.entries.map((e) => e.purpose))
  );
}
{
  // Absence stays absence. Defaulting an undeclared purpose to `live` would manufacture the intra-class
  // contention M5 exists to measure — DEBT-012's shape arriving inside the instrument built to find it.
  const now = 10_000;
  const decision = observe(
    [
      { key: "a", priority: "playhead", contribution: full, firstRequestedAtMs: 0, admittedAtMs: 0 },
      { key: "b", priority: "playhead", contribution: full, firstRequestedAtMs: 0, admittedAtMs: 0 },
    ],
    1,
    now
  );
  check(
    "an undeclared purpose records as null, NEVER as a default class",
    decision.entries.every((e) => e.purpose === null),
    JSON.stringify(decision.entries.map((e) => e.purpose))
  );
}

console.log(`\n${failures === 0 ? "admission:observer OK" : `admission:observer FAILED`} — ${checks - failures}/${checks} checks passed\n`);
process.exit(failures === 0 ? 0 : 1);
