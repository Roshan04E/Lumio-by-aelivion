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
  timelineActionRegistry,
  type Blueprint,
  type TimelineComposition,
  type TimelineLayer
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

console.log("addEffect look-param closure (the 'Noir applied but nothing changed' regression):");
const fixtureComposition: TimelineComposition = {
  id: "c",
  name: "c",
  width: 1920,
  height: 1080,
  fps: 30,
  durationSeconds: 10,
  backgroundColor: "#000000",
  tracks: [
    {
      id: "t0",
      type: "video",
      name: "t0",
      layers: [
        {
          id: "vid_a",
          trackId: "t0",
          type: "video",
          name: "vid_a",
          startSeconds: 0,
          durationSeconds: 10,
          effects: [],
          transform: { position: { x: 50, y: 50 }, scale: 1, rotation: 0, opacity: 1 }
        } as unknown as TimelineLayer
      ]
    }
  ]
};
const actionContext = { composition: fixtureComposition, selection: [], nowSeconds: 0 };
const lowercase = timelineActionRegistry.execute(
  "addEffect",
  { layerId: "vid_a", effectType: "creativeLook", params: { look: "noir", intensity: 80 } },
  actionContext,
  { ai: true }
);
check("lowercase look ACCEPTED and canonicalized at the write seam", lowercase.ok);
if (lowercase.ok) {
  const stored = lowercase.result.after.tracks[0]!.layers[0]!.effects.find((effect) => effect.type === "creativeLook");
  check("stored param is the CANONICAL registry name (renderer + Color tab agree)", stored?.params["look"] === "Noir", String(stored?.params["look"]));
}
const aliasParam = timelineActionRegistry.execute(
  "addEffect",
  { layerId: "vid_a", effectType: "creativeLook", params: { look: "moody" } },
  actionContext,
  { ai: true }
);
check("alias look canonicalizes too ('moody' → Noir)", aliasParam.ok && (aliasParam.ok ? aliasParam.result.after.tracks[0]!.layers[0]!.effects.at(-1)?.params["look"] === "Noir" : false));
const unknownParam = timelineActionRegistry.execute(
  "addEffect",
  { layerId: "vid_a", effectType: "creativeLook", params: { look: "XyzVibe", intensity: 80 } },
  actionContext,
  { ai: true }
);
check("unknown look REJECTED at validation (never stored, never a silent no-op)", !unknownParam.ok);
check(
  "rejection message carries the look library",
  !unknownParam.ok && /Noir/.test(unknownParam.message ?? ""),
  unknownParam.ok ? "unexpectedly ok" : unknownParam.message
);

console.log(failures === 0 ? "\nblueprint:eval PASS" : `\nblueprint:eval FAIL — ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
