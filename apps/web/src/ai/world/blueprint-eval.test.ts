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
  CREATIVE_LOOKS,
  listBlueprintDialects,
  matchLookInText,
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

function closeMotion(payload: unknown) {
  const result = closeBlueprint({ id: "bp_m", intent: "", goals: [{ id: "m", dialect: "motion", summary: "motion", payload }] });
  return result.ok ? ({ ok: true, closed: result.closed[0]! } as const) : ({ ok: false, issues: result.issues } as const);
}

const motionFixture = (): TimelineComposition => fixtureComposition;

console.log("motion dialect:");
const bounce = closeMotion({ kind: "entrance", style: "bounce" });
check("alias style closes with repair ('bounce' → pop)", bounce.ok && bounce.ok === true && bounce.closed.goal.payload.style === "pop" && bounce.closed.repairs.length === 1);
const unknownMotion = closeMotion({ kind: "exit", style: "explode" });
check(
  "unknown style → compile error with the per-kind vocabulary",
  !unknownMotion.ok && unknownMotion.issues[0]?.code === "unknown-capability" && (unknownMotion.issues[0]?.suggestions ?? []).includes("fade")
);
check("pop is entrance-only (exit vocabulary rejects it)", !closeMotion({ kind: "exit", style: "pop" }).ok);

console.log("blueprint driver:");
const blueprint: Blueprint = {
  id: "bp_test",
  intent: "make it moody with a gentle entrance",
  goals: [
    { id: "g1", dialect: "color", summary: "Moody grade", payload: { look: "moody" } },
    { id: "g2", dialect: "motion", summary: "Gentle entrance", payload: { kind: "entrance", style: "fade" } }
  ]
};
const driven = closeBlueprint(blueprint);
check(
  "MULTI-DOMAIN blueprint (color + motion) closes end to end",
  driven.ok && driven.ok === true && driven.closed.length === 2 && driven.closed[1]!.actions[0]!.actionId === "applyMotion"
);
const withBogus = closeBlueprint({
  ...blueprint,
  goals: [...blueprint.goals, { id: "g3", dialect: "audio", summary: "Duck music", payload: {} }]
});
check("blueprint with an unknown dialect fails ATOMICALLY (no partial execution)", !withBogus.ok);
if (!withBogus.ok) {
  check(
    "unknown-dialect issue names registered dialects",
    withBogus.issues[0]?.code === "unknown-dialect" && (withBogus.issues[0]?.suggestions ?? []).includes("color") && (withBogus.issues[0]?.suggestions ?? []).includes("motion")
  );
}
const colorOnly = closeBlueprint({ ...blueprint, goals: [blueprint.goals[0]!] });
check("all-color blueprint closes end to end", colorOnly.ok && colorOnly.ok === true && colorOnly.closed[0]!.actions.length > 0);

console.log("applyMotion action (compiler through the registry):");
{
  const result = timelineActionRegistry.execute(
    "applyMotion",
    { layerId: "vid_a", kind: "entrance", style: "bounce", durationSeconds: 0.6 },
    { composition: motionFixture(), selection: [], nowSeconds: 0 },
    { ai: true }
  );
  check("entrance 'bounce' applies via alias", result.ok);
  if (result.ok) {
    const animations = result.result.after.tracks[0]!.layers[0]!.animations ?? [];
    check(
      "emits scale + opacity keyframes",
      animations.some((kf) => kf.target.property === "transform.scale") && animations.some((kf) => kf.target.property === "transform.opacity")
    );
    check("all keyframes inside the entrance window", animations.length > 0 && animations.every((kf) => kf.timeSeconds <= 0.6 + 1e-9));
    check("settles at the layer's own base scale", animations.filter((kf) => kf.target.property === "transform.scale").some((kf) => kf.value === 1));
  }
}
{
  const result = timelineActionRegistry.execute(
    "applyMotion",
    { layerId: "vid_a", kind: "exit", style: "fade" },
    { composition: motionFixture(), selection: [], nowSeconds: 0 },
    { ai: true }
  );
  check("exit fade lands at the clip tail", result.ok);
  if (result.ok) {
    const animations = result.result.after.tracks[0]!.layers[0]!.animations ?? [];
    const times = animations.map((kf) => kf.timeSeconds).sort((a, b) => a - b);
    const values = [...animations].sort((a, b) => a.timeSeconds - b.timeSeconds).map((kf) => kf.value);
    check("exit keyframes sit in the last window and END transparent", times[0]! >= 10 - 0.6 - 1e-9 && values.at(-1) === 0);
  }
}
{
  const result = timelineActionRegistry.execute(
    "applyMotion",
    { layerId: "vid_a", kind: "entrance", style: "explode" },
    { composition: motionFixture(), selection: [], nowSeconds: 0 },
    { ai: true }
  );
  check("unknown style rejected with the vocabulary", !result.ok && /fade/.test(result.ok ? "" : (result.message ?? "")));
}

console.log("free-text look matching + look-data sanity (Teal & Orange @100 regression):");
{
  const moody = matchLookInText("apply a moody look to clip 1");
  check("'apply a moody look…' → Noir @ 55 via the shared resolver", moody?.look === "Noir" && moody.intensity === 55);
  check("'give it the faded film look' → Faded Film", matchLookInText("give it the faded film look")?.look === "Faded Film");
  check("'make it warm' (no 'look' phrase) → null (primary-correction vocabulary, not looks)", matchLookInText("make it warm") === null);
  check("'apply a vaporwave look' → null (unknown stays unknown)", matchLookInText("apply a vaporwave look") === null);
}
for (const look of CREATIVE_LOOKS) {
  if (!look.wheelsJson) continue;
  const wheels = JSON.parse(look.wheelsJson) as Record<string, { x: number; y: number; master: number }>;
  const sane = Object.values(wheels).every((wheel) => Math.abs(wheel.master) <= 1 && Math.abs(wheel.x) <= 1 && Math.abs(wheel.y) <= 1);
  check(`look "${look.name}" wheel values within unit range (master is -1..1, not percent)`, sane);
}

console.log("addEffect look-param closure (the 'Noir applied but nothing changed' regression):");
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
