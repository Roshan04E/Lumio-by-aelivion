/**
 * Orreris OS — Blueprint IR acceptance suite (K3). Run: `pnpm --filter @orreris/web blueprint:eval`
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
  listMoodPlannerStages,
  matchLookInText,
  planMoodBlueprint,
  registerBlueprintDialect,
  registerMoodRecipe,
  resolveLookName,
  resolveMoodRecipe,
  timelineActionRegistry,
  type Blueprint,
  type CompositionTextEvidence,
  type MoodFactSource,
  type TimelineComposition,
  type TimelineLayer
} from "@orreris/shared";
import { clearFactStore } from "./fact-store";
import { registerObserver } from "./observers";
import { textSummaryObserver } from "./observers/text-summary";
import {
  clearPendingMoodClarify,
  parseMoodClarifyAnswer,
  peekPendingMoodClarify,
  routeMoodAskWithContext,
  routePromptHypothesis,
  setPendingMoodClarify
} from "./hypothesis-route";

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

// ---------------------------------------------------------------------------
// K4 — hypothesis-stage planner (ORRERIS_OS.md → Layer 3)
// ---------------------------------------------------------------------------

async function runK4(): Promise<void> {
  console.log("K4 hypothesis pipeline (pure, stub fact source):");

  const declineSource: MoodFactSource = {
    fetchCompositionText: async () => null,
    fetchMediaLook: async () => null
  };
  const textFacts = (value: Partial<CompositionTextEvidence>): MoodFactSource => ({
    fetchCompositionText: async () => ({
      value: { textLayerCount: 2, wordCount: 12, coveredSeconds: 5, timelineSeconds: 10, ...value },
      path: "text-summary@test"
    }),
    fetchMediaLook: async () => null
  });
  const moodyRecipe = resolveMoodRecipe("moody")!;
  const dramaticRecipe = resolveMoodRecipe("dramatic")!;

  check("mood registry: 'moody' resolves, aliases too", resolveMoodRecipe("brooding")?.mood === "moody");
  check("mood registry: 'faster' is NOT a mood (precision-first)", resolveMoodRecipe("faster") === null);

  // K5: moods registered as pure data rows must close end to end with zero runtime changes.
  for (const word of ["vintage", "retro", "gritty", "edgy"]) {
    const recipe = resolveMoodRecipe(word);
    check(`K5 data row: '${word}' resolves to a recipe`, recipe !== null);
  }
  const vintage = await planMoodBlueprint(
    "make it vintage",
    resolveMoodRecipe("vintage")!,
    { hasVisualMedia: true, hasText: true },
    textFacts({ coveredSeconds: 2, wordCount: 3 })
  );
  check(
    "K5: 'vintage' closes (Faded Film grade + Caption Pill titles) with NO runtime change",
    vintage.kind === "blueprint" &&
      vintage.closed.some((g) => g.repairs.some((r) => r.includes("Faded Film"))) &&
      vintage.blueprint.goals.some((goal) => goal.dialect === "text")
  );
  const gritty = await planMoodBlueprint("make it gritty", resolveMoodRecipe("gritty")!, { hasVisualMedia: true, hasText: false }, declineSource);
  check(
    "K5: 'gritty' closes with the shake emphasis accent",
    gritty.kind === "blueprint" && gritty.closed.some((g) => g.actions[0]?.actionId === "applyMotion")
  );

  // Visual-only timeline → dominant without buying anything (structural elimination).
  const visualOnly = await planMoodBlueprint("make it moody", moodyRecipe, { hasVisualMedia: true, hasText: false }, declineSource);
  check("visual-only: blueprint, no facts bought (elimination was free)", visualOnly.kind === "blueprint" && visualOnly.trace.factsConsulted.length === 0);
  if (visualOnly.kind === "blueprint") {
    check("visual-only: single color goal, closed with the moody→Noir repair", visualOnly.closed.length === 1 && visualOnly.closed[0]!.repairs.some((r) => r.includes("Noir")));
  }

  // Incidental captions → cheap fact bought, grade dominates, titles ride along as accent.
  const incidental = await planMoodBlueprint(
    "make it moody",
    moodyRecipe,
    { hasVisualMedia: true, hasText: true },
    textFacts({ coveredSeconds: 2, wordCount: 3 })
  );
  check("incidental titles: composition-text bought, then dominant", incidental.kind === "blueprint" && incidental.trace.factsConsulted.some((f) => f.id === "composition-text"));
  if (incidental.kind === "blueprint") {
    const dialects = incidental.blueprint.goals.map((goal) => goal.dialect);
    check("incidental titles: MULTI-GOAL blueprint (color + text accent)", dialects.includes("color") && dialects.includes("text"));
  }

  // Dramatic adds the motion accent — three dialects closed atomically.
  const dramatic = await planMoodBlueprint(
    "make this feel dramatic",
    dramaticRecipe,
    { hasVisualMedia: true, hasText: true },
    textFacts({ coveredSeconds: 2, wordCount: 3 })
  );
  check(
    "dramatic: color + motion + text goals close atomically",
    dramatic.kind === "blueprint" && dramatic.blueprint.goals.length === 3 && dramatic.closed.some((g) => g.actions[0]?.actionId === "applyMotion")
  );

  // Text-dominant middle band → the ECONOMIC CLARIFY rule (never bought the expensive fact).
  const tied = await planMoodBlueprint(
    "make it moody",
    moodyRecipe,
    { hasVisualMedia: true, hasText: true },
    textFacts({ coveredSeconds: 6, wordCount: 20 })
  );
  check("near-tie: clarify (economic rule), not a guess", tied.kind === "clarify");
  if (tied.kind === "clarify") {
    check("clarify never bought the expensive shape fact", !tied.trace.factsConsulted.some((f) => f.id === "media-look"));
    check("clarify offers tier-0 phrasings for BOTH readings", /apply the moody look/.test(tied.question) && /apply the Minimal look/.test(tied.question));
  }

  // Title-driven timeline → the text hypothesis wins OUTRIGHT (no clarify).
  const titleDriven = await planMoodBlueprint(
    "make it moody",
    moodyRecipe,
    { hasVisualMedia: true, hasText: true },
    textFacts({ coveredSeconds: 9, wordCount: 30 })
  );
  check("title-driven: text treatment wins outright", titleDriven.kind === "blueprint" && titleDriven.blueprint.goals.every((goal) => goal.dialect === "text"));

  // Shaping: footage already measured dark → gentler grade, honestly noted.
  const darkSource: MoodFactSource = {
    fetchCompositionText: async () => null,
    fetchMediaLook: async () => ({
      value: { avgLuma: 0.12, contrast: 0.3, temperature: 0, saturation: 0.2, exposure: "dark" },
      path: "cached"
    })
  };
  const shaped = await planMoodBlueprint("make it moody", moodyRecipe, { hasVisualMedia: true, hasText: false }, darkSource);
  check("shape fact bought only for the winning visual hypothesis", shaped.kind === "blueprint" && shaped.trace.factsConsulted.some((f) => f.id === "media-look"));
  if (shaped.kind === "blueprint") {
    const payload = shaped.blueprint.goals[0]!.payload as { lookIntensity?: number };
    check("already-dark footage → gentler intensity + honest note", payload.lookIntensity === 40 && shaped.trace.notes.some((n) => n.includes("gentler grade")));
  }

  // Text-only / empty timelines.
  const textOnly = await planMoodBlueprint("make it moody", moodyRecipe, { hasVisualMedia: false, hasText: true }, declineSource);
  check("text-only timeline: text goal only", textOnly.kind === "blueprint" && textOnly.blueprint.goals.every((goal) => goal.dialect === "text"));
  const nothing = await planMoodBlueprint("make it moody", moodyRecipe, { hasVisualMedia: false, hasText: false }, declineSource);
  check("empty timeline: decline (nothing to land on)", nothing.kind === "decline");

  console.log("K4 route (world-tier wiring):");
  registerObserver(textSummaryObserver);
  clearFactStore();

  const textLayerA = {
    id: "txt_a",
    trackId: "t1",
    type: "text",
    name: "Title A",
    startSeconds: 0,
    durationSeconds: 2,
    text: "hello there",
    effects: [],
    transform: { position: { x: 50, y: 50 }, scale: 1, rotation: 0, opacity: 1 }
  } as unknown as TimelineLayer;
  const routeComposition: TimelineComposition = {
    ...fixtureComposition,
    tracks: [...fixtureComposition.tracks, { id: "t1", type: "text", name: "t1", layers: [textLayerA] }]
  };
  const brainContext = { composition: routeComposition, selection: [], nowSeconds: 0 };
  const worldCtx = { composition: routeComposition, assets: [] };

  const routed = await routeMoodAskWithContext("make it moody", brainContext, worldCtx, "moody");
  check("route: 'make it moody' → a bound world-tier plan", routed.kind === "plan" && routed.tier === "world" && routed.ruleId === "k4.mood-blueprint");
  if (routed.kind === "plan") {
    const actionIds = routed.plan.steps.map((step) => step.actionId);
    check("route: grade bound to the video, text look bound to the title", actionIds.includes("addEffect") && actionIds.includes("applyTextLook"));
    check(
      "route: every step names a real layer id",
      routed.plan.steps.every((step) => step.params && typeof (step.params as { layerId?: unknown }).layerId === "string")
    );
    check("route: honest provenance note (facts + 0 tokens)", (routed.plan.notes ?? []).some((note) => note.includes("0 tokens")));
  }

  const escalated = await routePromptHypothesis("make it faster", brainContext);
  check("route: 'make it faster' escalates silently (not a mood)", escalated.kind === "escalate");
  const notAnchored = await routePromptHypothesis("please make it moody thanks", brainContext);
  check("route: unanchored phrasing escalates (whole-string discipline)", notAnchored.kind === "escalate");

  // ---- Conversational clarify resume (K4 tail) ----
  console.log("K4 conversational clarify resume:");

  // The answer grammar — whole-string, precision-first.
  check("answer parse: 'the picture' → visual", parseMoodClarifyAnswer("the picture") === "visual");
  check("answer parse: 'titles' → text", parseMoodClarifyAnswer("titles") === "text");
  check("answer parse: 'the text' → text", parseMoodClarifyAnswer("the text") === "text");
  check("answer parse: 'both' → visual (grade carries the title accent)", parseMoodClarifyAnswer("both") === "visual");
  check("answer parse: an unrelated ask is NOT an answer", parseMoodClarifyAnswer("cut clip 2") === null);
  check("answer parse: 'the picture is too dark' is NOT an answer (whole-string)", parseMoodClarifyAnswer("the picture is too dark") === null);

  // Pending slot: single, TTL-bounded.
  const t0 = 1_000_000;
  setPendingMoodClarify("moody", "make it moody", t0);
  check("pending: alive inside the window", peekPendingMoodClarify(t0 + 60_000)?.mood === "moody");
  check("pending: expires after the TTL", peekPendingMoodClarify(t0 + 3 * 60_000) === null);
  clearPendingMoodClarify();

  // Forced winner in the pure planner: the user's answer replaces expansion AND clarify.
  const tiedEvidence = textFacts({ coveredSeconds: 6, wordCount: 20 });
  const forcedVisual = await planMoodBlueprint("make it moody", moodyRecipe, { hasVisualMedia: true, hasText: true }, tiedEvidence, "visual");
  check(
    "forced 'visual': blueprint (no re-clarify), color goal, honest 'you answered' note",
    forcedVisual.kind === "blueprint" &&
      forcedVisual.blueprint.goals.some((goal) => goal.dialect === "color") &&
      forcedVisual.trace.notes.some((note) => note.includes("you answered"))
  );
  const forcedText = await planMoodBlueprint("make it moody", moodyRecipe, { hasVisualMedia: true, hasText: true }, tiedEvidence, "text");
  check("forced 'text': text-only goals", forcedText.kind === "blueprint" && forcedText.blueprint.goals.every((goal) => goal.dialect === "text"));
  const forcedImpossible = await planMoodBlueprint("make it moody", moodyRecipe, { hasVisualMedia: false, hasText: true }, tiedEvidence, "visual");
  check("forced 'visual' with no visual media: honest decline", forcedImpossible.kind === "decline" && forcedImpossible.reason.includes("no video"));

  // Registered stages: the planner is an ordered table, and the trace carries its own
  // pipeline provenance (which stages ran, in order).
  check(
    "stage table: hypothesize → clarify-answer → expand → clarify → shape → resolve → close",
    listMoodPlannerStages().join(",") === "hypothesize,clarify-answer,expand,clarify,shape,resolve,close"
  );
  check(
    "stage provenance: a resolved plan ran ALL stages in order",
    forcedVisual.kind === "blueprint" && (forcedVisual.trace.stagesRun ?? []).join(",") === listMoodPlannerStages().join(",")
  );
  const tiedAgain = await planMoodBlueprint("make it moody", moodyRecipe, { hasVisualMedia: true, hasText: true }, tiedEvidence);
  check(
    "stage provenance: a clarify stopped AT the clarify stage",
    tiedAgain.kind === "clarify" && (tiedAgain.trace.stagesRun ?? []).slice(-1)[0] === "clarify"
  );

  // Route seam end to end: clarify parks the pending ask; the answer resumes into a plan.
  const wordyTitle = {
    ...textLayerA,
    id: "txt_wordy",
    durationSeconds: 6,
    text: "one two three four five six seven eight nine"
  } as unknown as TimelineLayer;
  const tiedComposition: TimelineComposition = {
    ...fixtureComposition,
    id: "c_tied",
    tracks: [...fixtureComposition.tracks, { id: "t1", type: "text", name: "t1", layers: [wordyTitle] }]
  };
  const tiedBrainContext = { composition: tiedComposition, selection: [], nowSeconds: 0 };
  const tiedWorldCtx = { composition: tiedComposition, assets: [] };
  const clarified = await routeMoodAskWithContext("make it moody", tiedBrainContext, tiedWorldCtx, "moody");
  check("route: middle-band timeline → clarify answer surfaced", clarified.kind === "answer" && clarified.ruleId === "k4.mood-clarify");
  check("route: clarify offers plain answers", clarified.kind === "answer" && clarified.text.includes('"the picture"'));
  const parked = peekPendingMoodClarify();
  check("route: clarify parked the pending ask (mood + original prompt)", parked?.mood === "moody" && parked?.prompt === "make it moody");
  if (parked) {
    const resumed = await routeMoodAskWithContext(parked.prompt, tiedBrainContext, tiedWorldCtx, parked.mood, parseMoodClarifyAnswer("the titles")!);
    check(
      "route: 'the titles' resumes into a text-only plan named after the ORIGINAL ask",
      resumed.kind === "plan" &&
        resumed.plan.steps.every((step) => step.actionId === "applyTextLook") &&
        resumed.plan.steps.length > 0
    );
    check("route: a resolved plan clears the pending slot", peekPendingMoodClarify() === null);
  }
  clearPendingMoodClarify();

  // ---- SDK v1 registration contract (ORRERIS_SDK.md) ----
  console.log("SDK v1 registration contract:");
  check(
    "mood recipe with an empty gradeLook rejected",
    registerMoodRecipe({ mood: "gloomy", aliases: [], gradeLook: "", textLook: "Subtitle" }) === false
  );
  check(
    "mood word must be a single word",
    registerMoodRecipe({ mood: "very moody", aliases: [], gradeLook: "Noir", textLook: "Subtitle" }) === false
  );
  check(
    "valid recipe registers, mood canonicalized to lowercase",
    registerMoodRecipe({ mood: "Gloomy", aliases: ["sombre"], gradeLook: "Noir", textLook: "Minimal" }) === true &&
      resolveMoodRecipe("gloomy") !== null
  );
  check(
    "dialect without close() rejected",
    registerBlueprintDialect({ id: "bogus", schema: undefined as never, close: undefined as never }) === false
  );
  check("rejected dialect never joined the registry", !listBlueprintDialects().includes("bogus"));
}

runK4()
  .catch((error) => {
    failures += 1;
    console.error(`  ✗ K4 suite crashed — ${String(error)}`);
  })
  .finally(() => {
    console.log(failures === 0 ? "\nblueprint:eval PASS" : `\nblueprint:eval FAIL — ${failures} failure(s)`);
    process.exit(failures === 0 ? 0 : 1);
  });
