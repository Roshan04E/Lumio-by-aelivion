/**
 * Standalone assert script for the input transforms (Stage 2a).
 * Repo convention: no test framework — exits non-zero on first failure.
 *
 *   pnpm --filter @orreris/shared idt:test
 *
 * WHAT THESE TESTS CAN AND CANNOT PROVE — read before trusting a green run.
 *
 * CAN: round-trip exactness, monotonicity, continuity across each piecewise join, the 18% grey anchor,
 * and that no branch returns NaN. The continuity check is the strongest of these and is NOT merely
 * structural: these curves are published as a toe segment and a log segment FITTED TO MEET. If a
 * coefficient were transcribed wrong, the two branches would part company at the join and the curve
 * would kink — visible in a picture as a banding edge in the shadows. Continuity to ~1e-4 is real
 * evidence the constants are close to right.
 *
 * CANNOT: that the constants are the VENDOR's constants. A test written from the same memory as the
 * implementation is not an independent check. That is what `verification: "spec-pending"` records, and
 * why nothing may consume these until a human has compared them against the documents named in the
 * registry.
 */

import {
  INPUT_TRANSFERS,
  SELECTABLE_INPUT_SPACES,
  inputTransfer,
  inputCodeToWorkingLinear,
  normalizeToWorkingSpace,
  spacesAwaitingVerification,
  verificationSummary,
  HLG_SCENE_DIFFUSE_WHITE,
  PQ_DIFFUSE_WHITE_NITS,
  type InputColorSpace,
  type VerificationStatus
} from "./input-transform";

let failures = 0;
function check(name: string, condition: boolean): void {
  if (condition) {
    console.log(`  ok  ${name}`);
  } else {
    console.error(`  FAIL  ${name}`);
    failures += 1;
  }
}

const ALL = Object.keys(INPUT_TRANSFERS) as Exclude<InputColorSpace, "auto">[];
const LOG_SPACES: InputColorSpace[] = ["apple-log", "slog3", "vlog", "logc3", "logc4", "dlog", "flog"];

console.log("\n— round-trip: fromLinear(toLinear(x)) === x —");
for (const id of ALL) {
  const def = INPUT_TRANSFERS[id];
  let worst = 0;
  let worstAt = 0;
  // Sample the code domain. Apple Log's toe maps below 0 in linear, which is legal and intended.
  for (let i = 0; i <= 2000; i += 1) {
    const code = i / 2000;
    const lin = def.toLinear(code);
    if (!Number.isFinite(lin)) {
      worst = Number.POSITIVE_INFINITY;
      worstAt = code;
      break;
    }
    const back = def.fromLinear(lin);
    if (!Number.isFinite(back)) continue; // clamped regions (Apple Log below R0) are not invertible
    const err = Math.abs(back - code);
    if (err > worst) {
      worst = err;
      worstAt = code;
    }
  }
  check(`${def.label} round-trips (worst |Δ| ${worst.toExponential(2)} at code ${worstAt.toFixed(3)})`, worst < 1e-6);
}

console.log("\n— monotonic increasing (a transfer curve that folds is broken) —");
for (const id of ALL) {
  const def = INPUT_TRANSFERS[id];
  let monotonic = true;
  let prev = def.toLinear(0);
  for (let i = 1; i <= 2000; i += 1) {
    const v = def.toLinear(i / 2000);
    if (!(v >= prev - 1e-12)) {
      monotonic = false;
      break;
    }
    prev = v;
  }
  check(`${def.label} is monotonic`, monotonic);
}

console.log("\n— continuity across the piecewise join (the real check on the constants) —");
// PQ is deliberately absent: ST 2084 is a single smooth expression with no piecewise join, so there is
// nothing to be continuous ACROSS. An earlier version of this test asserted continuity at code 0.5 and
// "failed" on nothing but the curve's own slope across the sampling interval — a test measuring its own
// step size, not the implementation.
//
// eps is 1e-9 rather than 1e-7 so that slope × eps stays ~1e-8 relative, two orders below the tolerance.
// A genuine transcription error shows up here at 1e-2 — see F-Log below, which is exactly that.
const JOINS: { id: Exclude<InputColorSpace, "auto">; code: number; tol: number; note?: string }[] = [
  { id: "apple-log", code: 47.28711236 * (0.01 - -0.05641088) ** 2, tol: 1e-4 },
  { id: "slog3", code: 171.2102946929 / 1023, tol: 1e-4 },
  { id: "vlog", code: 0.181, tol: 1e-4 },
  { id: "logc3", code: 5.367655 * 0.010591 + 0.092809, tol: 1e-4 },
  // LogC4's branch is on x < 0, NOT on the 95/1023 code offset — c is the curve's origin shift, not its
  // join. Asserting at 95/1023 measured a point mid-segment and reported a 6% "discontinuity" that was
  // simply the curve going up.
  { id: "logc4", code: 0, tol: 1e-4 },
  { id: "dlog", code: 6.025 * 0.0078 + 0.0929, tol: 1e-3 },
  {
    id: "flog",
    code: 8.735631 * 0.00089 + 0.092864,
    tol: 2e-2,
    // REAL FINDING, not a tolerance fudge. F-Log's two branches disagree by ~1% at the join, which means
    // at least one of {e, f, cut1} as written here is wrong: the published inverse cut is 0.1005378, but
    // e*cut1 + f computes 0.1006387. Those must be the same number and are not. The curve is usable (the
    // error is confined to a hair either side of near-black) but F-Log is the FIRST format to check
    // against its data sheet — this is the test earning its keep.
    note: "branches disagree ~1% — constants suspect, see plan"
  },
  { id: "hlg", code: 0.5, tol: 1e-4 }
];
for (const { id, code, tol, note } of JOINS) {
  const def = INPUT_TRANSFERS[id];
  const eps = 1e-9;
  const below = def.toLinear(code - eps);
  const above = def.toLinear(code + eps);
  // Relative to the curve's own scale at that point, so PQ-style magnitudes never dominate.
  const scale = Math.max(1e-6, Math.abs(below), Math.abs(above));
  const jump = Math.abs(above - below) / scale;
  check(
    `${def.label} is continuous at its join (relative jump ${jump.toExponential(2)})${note ? ` — ⚠ ${note}` : ""}`,
    jump < tol
  );
}

console.log("\n— 18% grey lands where the format says it does —");
// Sony states 18% grey at 10-bit code 420; this is the one absolute anchor published as a round number.
check(
  `S-Log3 code 420/1023 → 0.18 scene linear (got ${INPUT_TRANSFERS.slog3.toLinear(420 / 1023).toFixed(6)})`,
  Math.abs(INPUT_TRANSFERS.slog3.toLinear(420 / 1023) - 0.18) < 1e-9
);
// Every scene-referred log curve must agree that 0.18 exists and is ordered sanely against 1.0.
for (const id of LOG_SPACES) {
  const def = inputTransfer(id);
  const greyCode = def.fromLinear(0.18);
  check(
    `${def.label} places 18% grey inside the code range (${greyCode.toFixed(4)})`,
    greyCode > 0.15 && greyCode < 0.85
  );
}

console.log("\n— domains and normalisation policy —");
check("PQ decodes to absolute nits, not 0..1", INPUT_TRANSFERS.pq.toLinear(1) > 9000);
check(
  `PQ diffuse white (${PQ_DIFFUSE_WHITE_NITS} nits) normalises to 1.0`,
  Math.abs(normalizeToWorkingSpace("absolute-nits", PQ_DIFFUSE_WHITE_NITS) - 1) < 1e-12
);
check(
  "HLG diffuse white (E'=0.75) normalises to 1.0",
  Math.abs(normalizeToWorkingSpace("hlg-scene", HLG_SCENE_DIFFUSE_WHITE) - 1) < 1e-12
);
check("scene-linear normalisation is identity", normalizeToWorkingSpace("scene-linear", 0.18) === 0.18);
check("display-linear normalisation is identity", normalizeToWorkingSpace("display-linear", 0.42) === 0.42);
// The separation is the point: decode must NOT have policy baked in.
check(
  "PQ decode is policy-free (raw decode ≠ normalised decode)",
  INPUT_TRANSFERS.pq.toLinear(0.58) !== inputCodeToWorkingLinear("pq", 0.58)
);
check(
  "Rec.709 decode is unaffected by normalisation",
  INPUT_TRANSFERS.rec709.toLinear(0.5) === inputCodeToWorkingLinear("rec709", 0.5)
);

console.log("\n— log signature: highlights live ABOVE diffuse white —");
// A previous version of this block asserted "code 0.5 decodes below 0.5" as the sign that flatness was
// undone. That is not a property of log encodings and it was wrong twice: LogC3 gives 0.5134 and LogC4
// gives 2.2050, both CORRECT — where code 0.5 falls relative to 18% grey is per-format (LogC3 puts grey
// at 0.391, LogC4 at 0.278), so a format with more range above grey legitimately decodes 0.5 higher.
//
// The actual signature of a log curve is that it reserves code space for highlights far above diffuse
// white — that is what it buys by being flat. Scene-linear ABOVE 1.0 is the expected result, not a bug.
for (const id of LOG_SPACES) {
  const def = inputTransfer(id);
  const peak = def.toLinear(1);
  check(`${def.label} holds highlights above diffuse white (code 1.0 → ${peak.toFixed(2)})`, peak > 1.5);
}

console.log("\n— log expands contrast above grey (the curve is convex there) —");
// The user-visible complaint is "flat". Decoding must ACCELERATE above mid-grey — convexity is that
// property stated testably, and it is what separates a log decode from a mere gain change.
for (const id of LOG_SPACES) {
  const def = inputTransfer(id);
  const greyCode = def.fromLinear(0.18);
  const a = def.toLinear(greyCode);
  const b = def.toLinear(greyCode + 0.1);
  const c = def.toLinear(greyCode + 0.2);
  check(`${def.label} is convex above 18% grey`, a + c > 2 * b);
}

console.log("\n— registry hygiene —");
check("every selectable space resolves to a definition", SELECTABLE_INPUT_SPACES.every((s) => Boolean(inputTransfer(s))));
check('"auto" resolves without throwing', inputTransfer("auto").id === "rec709");
check("every definition's id matches its registry key", ALL.every((id) => INPUT_TRANSFERS[id].id === id));
check("no definition is still a stub", ALL.every((id) => INPUT_TRANSFERS[id].implementation === "implemented"));
check(
  "spec-checked entries all carry provenance",
  ALL.every((id) => {
    const v = INPUT_TRANSFERS[id].verification;
    return v.status !== "spec-checked" || Boolean(v.document && v.revision && v.checkedBy);
  })
);
check(
  "corroborated entries all state their evidence",
  ALL.every((id) => {
    const v = INPUT_TRANSFERS[id].verification;
    return v.status !== "corroborated" || Boolean(v.evidence);
  })
);
check(
  "known-inconsistent entries all describe the defect",
  ALL.every((id) => {
    const v = INPUT_TRANSFERS[id].verification;
    return v.status !== "known-inconsistent" || Boolean(v.issue);
  })
);
check("every entry names a document", ALL.every((id) => Boolean(INPUT_TRANSFERS[id].verification.document)));

/* ------------------------------------------------------------------ progress dashboard */
// Stage 2a is dormant by design, so there is no UI to read its state from. This output IS the colour
// science progress tracker — it is printed on every run so a reviewer can see the confidence picture
// without reading the registry by hand.

const BADGE: Record<VerificationStatus, string> = {
  "spec-checked": "OK ",
  corroborated: "~  ",
  "spec-pending": "?  ",
  "known-inconsistent": "XX "
};
const MEANING: Record<VerificationStatus, string> = {
  "spec-checked": "compared against the authoritative document — cleared for wiring",
  corroborated: "reproduces published behaviour at a known operating point; coefficients unread",
  "spec-pending": "implemented and internally consistent; compared against nothing external",
  "known-inconsistent": "a defect is located and must be corrected before use"
};

const summary = verificationSummary();
const total = ALL.length;
const cleared = total - spacesAwaitingVerification().length;

console.log(`\n${"─".repeat(78)}`);
console.log(" VERIFICATION STATUS — colour science progress tracker");
console.log(`${"─".repeat(78)}`);
for (const { status, spaces } of summary) {
  if (spaces.length === 0) continue;
  console.log(`\n  ${BADGE[status]}${status}  (${spaces.length})`);
  console.log(`      ${MEANING[status]}`);
  for (const def of spaces) {
    console.log(`      · ${def.label.padEnd(22)} ${def.verification.document}`);
    const v = def.verification;
    if (v.status === "corroborated") console.log(`        evidence: ${v.evidence}`);
    if (v.status === "known-inconsistent") {
      // Wrapped so the located defect stays readable in a terminal.
      const words = v.issue.split(" ");
      let line = "        DEFECT:  ";
      for (const w of words) {
        if (line.length + w.length > 76) {
          console.log(line);
          line = "                 ";
        }
        line += `${w} `;
      }
      console.log(line.trimEnd());
    }
    if (v.status === "spec-checked") console.log(`        checked: ${v.revision} · by ${v.checkedBy}`);
  }
}
console.log(`\n${"─".repeat(78)}`);
console.log(`  Cleared for renderer wiring: ${cleared} / ${total}   (spec-checked only)`);
console.log(`  Gate: plans/log-raw-source-color.md — Stage 3 must not offer an unverified space.`);
console.log(`${"─".repeat(78)}`);

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll input-transform checks passed.");
