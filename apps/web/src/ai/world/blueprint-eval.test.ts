/**
 * Kimera OS — Blueprint IR acceptance suite (K3). Run: `pnpm --filter @kimera-by-aelivion/web blueprint:eval`
 *
 * The founding regression: "make it moody" → the LLM emitted `look:"Moody"`, the schema
 * passed, the exact-match look registry returned nothing, and the user saw a silent
 * "Applied 0 · skipped" (2026-07-18 transcript). Closure law: an unfulfillable goal is a
 * COMPILE ERROR with reasons/suggestions; a repairable one is repaired with an honest note;
 * emptiness never reaches execution.
 *
 * Standalone tsx assert script, same convention as world:eval / brain:eval.
 */

import {
  closeBlueprint,
  closeColorGrade,
  compileGradeIntent,
  listBlueprintDialects,
  resolveLookName,
  type Blueprint
} from "@kimera-by-aelivion/shared";

let failures = 0;

function check(label: string, ok: boolean, detail?: string): void {
  if (ok) {
    console.log(`  ✓ ${label}`);
  } else {
    failures += 1;
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

console.log("dialect registry:");
check("color dialect registered on import", listBlueprintDialects().includes("color"));

console.log("the moody regression (founding case):");
const moody = closeColorGrade({ look: "Moody" });
check("'Moody' closes via alias repair (NOT a silent no-op)", moody.ok);
if (moody.ok) {
  check("repair is recorded honestly", moody.closed.repairs.some((repair) => repair.includes("Noir")), moody.closed.repairs.join("; "));
  check("repaired goal lowers to a real effect stack", moody.closed.actions.length > 0);
  check(
    "alias intensity fills in (softer Noir, not full strength)",
    moody.closed.goal.payload.lookIntensity !== undefined && moody.closed.goal.payload.lookIntensity < 100
  );
}

console.log("canonicalization:");
const lower = closeColorGrade({ look: "noir" });
check("case-insensitive look resolves with a repair note", lower.ok && lower.closed.repairs.length === 1 && lower.closed.goal.payload.look === "Noir");
const ampersand = closeColorGrade({ look: "Teal and Orange" });
check("'Teal and Orange' ≡ 'Teal & Orange'", ampersand.ok && ampersand.closed.goal.payload.look === "Teal & Orange");
const exact = closeColorGrade({ look: "Cinematic" });
check("exact match closes with NO repairs", exact.ok && exact.closed.repairs.length === 0);
const explicitIntensity = closeColorGrade({ look: "moody", lookIntensity: 90 });
check(
  "explicit intensity beats the alias default",
  explicitIntensity.ok && explicitIntensity.closed.goal.payload.lookIntensity === 90
);

console.log("compile errors (never silent):");
const unknown = closeColorGrade({ look: "XyzVibe" });
check("unknown look → compile error", !unknown.ok);
if (!unknown.ok) {
  check("error carries code + suggestions", unknown.issues[0]?.code === "unknown-capability" && (unknown.issues[0]?.suggestions ?? []).includes("Noir"));
}
const empty = closeColorGrade({});
check("all-neutral grade → empty-goal compile error", !empty.ok && empty.issues[0]?.code === "empty-goal");
const neutralTone = closeColorGrade({ tone: { contrast: 0, lift: 0 } });
check("neutral-valued tone → still empty-goal", !neutralTone.ok && neutralTone.issues[0]?.code === "empty-goal");
const malformed = closeColorGrade({ look: 42 });
check("malformed payload → invalid-payload error", !malformed.ok && malformed.issues[0]?.code === "invalid-payload");

console.log("lowering parity:");
const direct = compileGradeIntent({ look: "Noir" });
const viaDialect = closeColorGrade({ look: "Noir" });
check(
  "dialect lowering ≡ compileGradeIntent (same stack length + effect order)",
  viaDialect.ok &&
    viaDialect.closed.actions.length === direct.length &&
    viaDialect.closed.actions.every(
      (action, index) => (action.params as { effectType: string }).effectType === direct[index]?.effectType
    )
);
const primaryOnly = closeColorGrade({ primary: { contrast: 20, temperature: -10 } });
check("primary-only intent closes without a look", primaryOnly.ok && primaryOnly.closed.actions.length === 1);

console.log("blueprint driver:");
const blueprint: Blueprint = {
  id: "bp_test",
  intent: "make it moody",
  goals: [
    { id: "g1", dialect: "color", summary: "Moody grade", payload: { look: "moody" } },
    { id: "g2", dialect: "motion", summary: "Slow push-in", payload: {} }
  ]
};
const driven = closeBlueprint(blueprint);
check("blueprint with an unknown dialect fails ATOMICALLY (no partial execution)", !driven.ok);
if (!driven.ok) {
  check("unknown-dialect issue names registered dialects", driven.issues[0]?.code === "unknown-dialect" && (driven.issues[0]?.suggestions ?? []).includes("color"));
}
const colorOnly = closeBlueprint({ ...blueprint, goals: [blueprint.goals[0]!] });
check("all-color blueprint closes end to end", colorOnly.ok && colorOnly.ok === true && colorOnly.closed[0]!.actions.length > 0);

console.log(failures === 0 ? "\nblueprint:eval PASS" : `\nblueprint:eval FAIL — ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
