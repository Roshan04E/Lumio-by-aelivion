/**
 * Orreris OS — World Model acceptance suite (K1). Run: `pnpm --filter @orreris/web world:eval`
 *
 * Covers the K1 laws (ORRERIS_OS.md → Layer 2):
 *  - memoization: a signature-stable fact is served from cache, the observer runs ONCE;
 *  - truth maintenance: signature change invalidates + re-observes; invalidation cascades
 *    through `dependencies` (derived facts die with their inputs);
 *  - access-path planning: cheapest sufficient path wins; (budget, minConfidence) that no
 *    path satisfies → DECLINE (null), never a fact the model can't stand behind;
 *  - the built-in metadata + text-summary observers measure correctly on synthetic fixtures;
 *  - the DOM-only look observer declines cleanly under node;
 *  - the world route is precision-first: non-matching / ambiguous prompts escalate.
 *
 * Standalone tsx assert script (no test framework), same convention as brain:eval.
 */

import type { SourceAsset, TimelineComposition, TimelineLayer, TimelineTrackType } from "@orreris/shared";

// K2 persistence tests need storage BEFORE any store access — a Map-backed localStorage fake
// (node has none). Set first so every lazily-loading module (fact store, feedback, ledger)
// sees the same fake.
const fakeStorage = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (key: string) => fakeStorage.get(key) ?? null,
  setItem: (key: string, value: string) => void fakeStorage.set(key, value),
  removeItem: (key: string) => void fakeStorage.delete(key),
  clear: () => fakeStorage.clear()
};

import { __resetFactStoreMemoryForTests, clearFactStore, getStoredFact, invalidateFact, listFacts, storeObservation } from "./fact-store";
import { queryFact } from "./knowledge";
import { registerObserver } from "./observers";
import { metadataObserver, MEDIA_METADATA_FACT, type MediaMetadataFact } from "./observers/metadata";
import { lookObserver, MEDIA_LOOK_FACT } from "./observers/look";
import { aggregateFaceSamples, facesObserver, MEDIA_FACES_FACT } from "./observers/faces";
import { classifyFormat, formatObserver, COMPOSITION_FORMAT_FACT } from "./observers/format";
import { classifyScene, sceneObserver, MEDIA_SCENE_FACT } from "./observers/scene";
import { textSummaryObserver, COMPOSITION_TEXT_FACT, type CompositionTextFact } from "./observers/text-summary";
import { characterObserver, COMPOSITION_CHARACTER_FACT, type CompositionCharacterFact } from "./observers/character";
import { systemObserver, SYSTEM_CAPABILITIES_FACT, SYSTEM_TARGET_ID, type SystemCapabilitiesFact } from "./observers/system";
import { userProfileObserver, USER_AI_PROFILE_FACT, USER_TARGET_ID, type UserAiProfileFact } from "./observers/user-profile";
import { projectMediaObserver, PROJECT_MEDIA_FACT, PROJECT_TARGET_ID, type ProjectMediaFact } from "./observers/project-media";
import { recordRuleFired, recordRuleRejected, clearRuleStats } from "../brain/feedback";
import { describeAppliedTreatment, routePromptWorld } from "./route";
import type { BrainContext } from "../brain/router";
import type { WorldContext, WorldObserver } from "./types";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let failures = 0;

function check(label: string, ok: boolean, detail?: string): void {
  if (ok) {
    console.log(`  ✓ ${label}`);
  } else {
    failures += 1;
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function layer(
  partial: Partial<TimelineLayer> & Pick<TimelineLayer, "id" | "type" | "startSeconds" | "durationSeconds">
): TimelineLayer {
  return { trackId: "t", name: partial.id, ...partial } as TimelineLayer;
}

function comp(tracks: { type: TimelineTrackType; layers: TimelineLayer[] }[]): TimelineComposition {
  return {
    id: "c",
    name: "c",
    width: 1080,
    height: 1920,
    fps: 30,
    durationSeconds: 30,
    backgroundColor: "#000000",
    tracks: tracks.map((track, index) => ({ id: `track_${index}`, type: track.type, name: `track_${index}`, layers: track.layers }))
  };
}

const asset: SourceAsset = {
  id: "a1",
  userId: "u",
  fileName: "shot.mp4",
  fileType: "video/mp4",
  fileUrl: "",
  durationSeconds: 12.5,
  width: 1920,
  height: 1080,
  status: "ready",
  createdAt: "2026-07-18",
  fps: 25,
  sizeBytes: 42 * 1024 * 1024
};

const textComp = comp([
  {
    type: "video",
    layers: [layer({ id: "vid_a", type: "video", startSeconds: 0, durationSeconds: 10, assetId: "a1" })]
  },
  {
    type: "text",
    layers: [
      layer({ id: "t1", type: "text", startSeconds: 0, durationSeconds: 4, text: "hello brave new world" }),
      // Overlaps t1 → interval union must count 0–6s once, not 4+4.
      layer({ id: "t2", type: "text", startSeconds: 2, durationSeconds: 4, text: "of measured facts" })
    ]
  }
]);

const ctx: WorldContext = { composition: textComp, assets: [asset] };

// ---------------------------------------------------------------------------
// Synthetic observers for planner mechanics
// ---------------------------------------------------------------------------

let syntheticSignature = "sig-1";
let syntheticRuns = 0;

const syntheticObserver: WorldObserver = {
  id: "synthetic@test",
  version: 1,
  factTypes: ["test.value"],
  fidelity: 0,
  estCostMs: 5,
  estConfidence: 0.95,
  signature: (target) => (target.kind === "asset" ? syntheticSignature : null),
  observe: async () => {
    syntheticRuns += 1;
    return [{ type: "test.value", value: syntheticRuns, confidence: 0.95 }];
  }
};

let cheapRuns = 0;
let heavyRuns = 0;
const cheapObserver: WorldObserver = {
  id: "cheap@test",
  version: 1,
  factTypes: ["test.tiered"],
  fidelity: 1,
  estCostMs: 1,
  estConfidence: 0.5,
  signature: () => "cheap",
  observe: async () => {
    cheapRuns += 1;
    return [{ type: "test.tiered", value: "cheap", confidence: 0.5 }];
  }
};
const heavyObserver: WorldObserver = {
  id: "heavy@test",
  version: 1,
  factTypes: ["test.tiered"],
  fidelity: 3,
  estCostMs: 100,
  estConfidence: 0.99,
  signature: () => "heavy",
  observe: async () => {
    heavyRuns += 1;
    return [{ type: "test.tiered", value: "heavy", confidence: 0.99 }];
  }
};

registerObserver(syntheticObserver);
registerObserver(cheapObserver);
registerObserver(heavyObserver);
registerObserver(metadataObserver);
registerObserver(lookObserver);
registerObserver(textSummaryObserver);
registerObserver(systemObserver);
registerObserver(userProfileObserver);
registerObserver(projectMediaObserver);
registerObserver(characterObserver);
registerObserver(facesObserver);
registerObserver(formatObserver);
registerObserver(sceneObserver);

const assetTarget = { kind: "asset" as const, id: "a1" };
const compTarget = { kind: "composition" as const, id: "c" };

async function run(): Promise<void> {
  // ---- Memoization + truth maintenance ----
  console.log("memoization + truth maintenance:");
  clearFactStore();
  const first = await queryFact<number>({ type: "test.value", target: assetTarget }, ctx);
  check("first query observes", first?.path === "synthetic@test" && first.fact.value === 1);
  const second = await queryFact<number>({ type: "test.value", target: assetTarget }, ctx);
  check("second query is cached (observer ran once)", second?.path === "cached" && syntheticRuns === 1);
  syntheticSignature = "sig-2";
  const third = await queryFact<number>({ type: "test.value", target: assetTarget }, ctx);
  check("signature change invalidates + re-observes", third?.path === "synthetic@test" && syntheticRuns === 2);
  check(
    "provenance records the new signature",
    getStoredFact("test.value", "asset:a1")?.provenance.inputSignature === "sig-2"
  );

  // ---- Dependency cascade ----
  console.log("dependency cascade:");
  const parent = getStoredFact("test.value", "asset:a1")!;
  storeObservation(
    syntheticObserver,
    compTarget,
    "derived-sig",
    [{ type: "test.derived", value: "meaning", confidence: 0.8 }],
    [parent.id]
  );
  check("derived fact stored", getStoredFact("test.derived", "composition:c") !== undefined);
  invalidateFact(parent.id);
  check("invalidation cascades to derived fact", getStoredFact("test.derived", "composition:c") === undefined);

  // ---- Access-path planning ----
  console.log("access-path planning:");
  clearFactStore();
  const cheapest = await queryFact({ type: "test.tiered", target: assetTarget }, ctx);
  check("no constraints → cheapest path wins", cheapest?.path === "cheap@test" && heavyRuns === 0);
  clearFactStore();
  const confident = await queryFact({ type: "test.tiered", target: assetTarget, minConfidence: 0.9 }, ctx);
  check("minConfidence 0.9 → heavy path chosen", confident?.path === "heavy@test" && confident.fact.value === "heavy");
  clearFactStore();
  const impossible = await queryFact({ type: "test.tiered", target: assetTarget, minConfidence: 0.9, budgetMs: 50 }, ctx);
  check("no path satisfies (budget, minConfidence) → DECLINE (null)", impossible === null);
  check("declined query ran no observer", heavyRuns === 1 && cheapRuns === 1);

  // ---- Built-in observers ----
  console.log("built-in observers:");
  clearFactStore();
  const metadata = await queryFact<MediaMetadataFact>({ type: MEDIA_METADATA_FACT, target: assetTarget }, ctx);
  check(
    "metadata observer reads the import record",
    metadata?.fact.value.width === 1920 && metadata.fact.value.fps === 25 && metadata.fact.value.durationSeconds === 12.5
  );
  const metadataMissing = await queryFact<MediaMetadataFact>(
    { type: MEDIA_METADATA_FACT, target: { kind: "asset", id: "ghost" } },
    ctx
  );
  check("unknown asset → decline", metadataMissing === null);

  const text = await queryFact<CompositionTextFact>({ type: COMPOSITION_TEXT_FACT, target: compTarget }, ctx);
  check("text summary counts words", text?.fact.value.wordCount === 7, `got ${text?.fact.value.wordCount}`);
  check("text summary unions overlapping coverage (0–6s = 6s)", text?.fact.value.coveredSeconds === 6);
  check("text summary sees timeline length", text?.fact.value.timelineSeconds === 10);
  const textCached = await queryFact<CompositionTextFact>({ type: COMPOSITION_TEXT_FACT, target: compTarget }, ctx);
  check("text summary memoizes on content signature", textCached?.path === "cached");
  const editedComp: TimelineComposition = {
    ...textComp,
    tracks: textComp.tracks.map((track) =>
      track.type === "text"
        ? { ...track, layers: track.layers.map((l) => (l.id === "t1" ? { ...l, text: "hello" } : l)) }
        : track
    )
  };
  const textEdited = await queryFact<CompositionTextFact>(
    { type: COMPOSITION_TEXT_FACT, target: compTarget },
    { ...ctx, composition: editedComp }
  );
  check("editing text invalidates + re-measures", textEdited?.path === "text-summary@builtin" && textEdited.fact.value.wordCount === 4);

  check("DOM-only look observer declines under node", (await queryFact({ type: MEDIA_LOOK_FACT, target: assetTarget }, ctx)) === null);

  // ---- K5: face-presence observer (first browser-ML; the WASM path declines under node,
  // ---- so eval covers the PURE aggregation math + the decline discipline) ----
  console.log("K5 face presence (media.faces):");
  check(
    "ML observer declines under node (no DOM/model — no guessing)",
    (await queryFact({ type: MEDIA_FACES_FACT, target: assetTarget }, ctx)) === null
  );
  check("aggregate: zero samples → null (decline upstream)", aggregateFaceSamples([]) === null);
  const talkingHead = aggregateFaceSamples([
    { faces: [{ centerX: 0.5, areaShare: 0.2 }] },
    { faces: [{ centerX: 0.52, areaShare: 0.24 }] },
    { faces: [{ centerX: 0.48, areaShare: 0.22 }] },
    { faces: [] }
  ]);
  check(
    "aggregate: talking head → 75% presence, centered",
    talkingHead?.presenceShare === 0.75 && talkingHead.dominantRegion === "center" && talkingHead.maxFaces === 1
  );
  check(
    "aggregate: area averaged over face-bearing frames only",
    talkingHead !== null && Math.abs(talkingHead.avgFaceAreaShare - 0.22) < 1e-9
  );
  const crowd = aggregateFaceSamples([
    { faces: [{ centerX: 0.2, areaShare: 0.01 }, { centerX: 0.3, areaShare: 0.02 }, { centerX: 0.25, areaShare: 0.015 }] },
    { faces: [{ centerX: 0.22, areaShare: 0.01 }] }
  ]);
  check("aggregate: crowd on the left → maxFaces 3, left region", crowd?.maxFaces === 3 && crowd.dominantRegion === "left");
  const empty = aggregateFaceSamples([{ faces: [] }, { faces: [] }]);
  check(
    "aggregate: faceless footage is a REAL fact (0 presence, region none)",
    empty?.presenceShare === 0 && empty.dominantRegion === "none" && empty.avgFaceAreaShare === 0
  );
  // REAL report 2026-07-18: a night-city skyline "grew" a face — one detection across 7
  // sampled frames is noise, not a person (corroboration rule).
  const skylineBlip = aggregateFaceSamples([
    { faces: [] },
    { faces: [{ centerX: 0.2, areaShare: 0.05 }] },
    { faces: [] },
    { faces: [] },
    { faces: [] },
    { faces: [] },
    { faces: [] }
  ]);
  check(
    "aggregate: SINGLE-frame detection across 3+ samples is suppressed as noise",
    skylineBlip?.presenceShare === 0 && skylineBlip.dominantRegion === "none" && skylineBlip.maxFaces === 0
  );
  const corroborated = aggregateFaceSamples([
    { faces: [{ centerX: 0.5, areaShare: 0.05 }] },
    { faces: [{ centerX: 0.52, areaShare: 0.05 }] },
    { faces: [] },
    { faces: [] },
    { faces: [] },
    { faces: [] },
    { faces: [] }
  ]);
  check("aggregate: TWO corroborating frames keep the detection", corroborated !== null && corroborated.presenceShare > 0.2 && corroborated.maxFaces === 1);
  const singleImage = aggregateFaceSamples([{ faces: [{ centerX: 0.5, areaShare: 0.2 }] }]);
  check("aggregate: a single-frame IMAGE keeps its face (corroboration needs 3+ samples)", singleImage?.presenceShare === 1);

  // ---- K5: inference rules (L4 — derived facts, confidence-propagated, cascade-invalidated) ----
  console.log("K5 inference (composition.character):");
  clearFactStore();
  const character = await queryFact<CompositionCharacterFact>({ type: COMPOSITION_CHARACTER_FACT, target: compTarget }, ctx);
  check(
    "character derives from the text-summary fact (mixed / moderate on the fixture)",
    character?.fact.value.profile === "mixed" && character.fact.value.pacing === "moderate",
    `${character?.fact.value.profile}/${character?.fact.value.pacing}`
  );
  check(
    "confidence propagates (rule prior × input confidence, never ≥ the evidence)",
    character !== null && character.fact.confidence < 0.95 && Math.abs(character.fact.confidence - 0.8 * 0.95) < 1e-9
  );
  const textInput = getStoredFact(COMPOSITION_TEXT_FACT, "composition:c");
  check("derived fact records its input's id as a dependency", character?.fact.dependencies[0] === textInput?.id);
  const characterCached = await queryFact<CompositionCharacterFact>({ type: COMPOSITION_CHARACTER_FACT, target: compTarget }, ctx);
  check("inference memoizes like any fact", characterCached?.path === "cached");
  // Cascade: editing the text invalidates the text summary → the derived character DIES WITH IT.
  const editedCharacterComp: TimelineComposition = {
    ...textComp,
    tracks: textComp.tracks.map((track) =>
      track.type === "text"
        ? { ...track, layers: track.layers.map((l) => (l.id === "t1" ? { ...l, text: "short" } : l)) }
        : track
    )
  };
  await queryFact<CompositionTextFact>({ type: COMPOSITION_TEXT_FACT, target: compTarget }, { ...ctx, composition: editedCharacterComp });
  check(
    "input invalidation CASCADES to the derived fact (store no longer holds character)",
    getStoredFact(COMPOSITION_CHARACTER_FACT, "composition:c") === undefined
  );
  const characterAfter = await queryFact<CompositionCharacterFact>(
    { type: COMPOSITION_CHARACTER_FACT, target: compTarget },
    { ...ctx, composition: editedCharacterComp }
  );
  check("re-query re-derives fresh from the new evidence", characterAfter?.path === "character-inference@builtin");

  // ---- K2: state-branch observers ----
  console.log("K2 state branches:");
  const hasNavigator = typeof navigator !== "undefined";
  const system = await queryFact<SystemCapabilitiesFact>(
    { type: SYSTEM_CAPABILITIES_FACT, target: { kind: "system", id: SYSTEM_TARGET_ID } },
    ctx
  );
  if (hasNavigator) {
    check("system observer detects capabilities", system !== null && system.fact.value.hardwareConcurrency >= 1);
  } else {
    check("system observer declines without navigator", system === null);
  }

  clearRuleStats();
  recordRuleFired("t0.test-rule");
  recordRuleFired("t0.test-rule");
  recordRuleRejected("t0.test-rule");
  const profile = await queryFact<UserAiProfileFact>(
    { type: USER_AI_PROFILE_FACT, target: { kind: "user", id: USER_TARGET_ID } },
    ctx
  );
  check(
    "user profile summarizes feedback stats",
    profile?.fact.value.rulesTracked === 1 && profile.fact.value.totalFired === 2 && profile.fact.value.totalRejected === 1
  );
  recordRuleRejected("t0.test-rule");
  const profileAfter = await queryFact<UserAiProfileFact>(
    { type: USER_AI_PROFILE_FACT, target: { kind: "user", id: USER_TARGET_ID } },
    ctx
  );
  check(
    "new feedback auto-invalidates the profile fact (signature change)",
    profileAfter?.path === "user-profile@builtin" && profileAfter.fact.value.totalRejected === 2
  );

  const secondAsset: SourceAsset = { ...asset, id: "a2", fileType: "image/png", durationSeconds: 0, sizeBytes: 1024 * 1024, source: "pexels" };
  const projectCtx: WorldContext = { composition: textComp, assets: [asset, secondAsset] };
  const media = await queryFact<ProjectMediaFact>(
    { type: PROJECT_MEDIA_FACT, target: { kind: "project", id: PROJECT_TARGET_ID } },
    projectCtx
  );
  check(
    "project media summary counts kinds/footage/sources",
    media?.fact.value.assetCount === 2 &&
      media.fact.value.videoCount === 1 &&
      media.fact.value.imageCount === 1 &&
      media.fact.value.totalFootageSeconds === 12.5 &&
      media.fact.value.bySource["pexels"] === 1 &&
      media.fact.value.bySource["local"] === 1
  );
  const mediaChanged = await queryFact<ProjectMediaFact>(
    { type: PROJECT_MEDIA_FACT, target: { kind: "project", id: PROJECT_TARGET_ID } },
    { ...projectCtx, assets: [asset] }
  );
  check("bin change invalidates the project summary", mediaChanged?.path === "project-media@builtin" && mediaChanged.fact.value.assetCount === 1);

  // ---- K2: persistence (survives a simulated reload; clear really clears) ----
  console.log("K2 persistence:");
  clearFactStore();
  syntheticSignature = "sig-persist";
  await queryFact<number>({ type: "test.value", target: assetTarget }, ctx);
  await sleep(650); // let the debounced persist flush
  __resetFactStoreMemoryForTests(); // simulate a page reload
  const revived = getStoredFact("test.value", "asset:a1");
  check("facts survive a reload via storage", revived?.provenance.inputSignature === "sig-persist");
  const cachedAfterReload = await queryFact<number>({ type: "test.value", target: assetTarget }, ctx);
  const runsBeforeReloadQuery = syntheticRuns;
  check("reloaded fact serves from cache (signature still valid)", cachedAfterReload?.path === "cached" && syntheticRuns === runsBeforeReloadQuery);
  clearFactStore();
  __resetFactStoreMemoryForTests();
  check("clear removes persisted facts too", getStoredFact("test.value", "asset:a1") === undefined);

  // ---- SDK reference inference (media.scene — asset-level, single input) ----
  console.log("SDK reference inference (media.scene):");
  const dark = classifyScene({ avgLuma: 0.2, temperature: -0.1, saturation: 0.1 });
  check("classify: dark cool muted footage", dark.lighting === "low-light" && dark.palette === "cool" && dark.energy === "muted");
  const golden = classifyScene({ avgLuma: 0.7, temperature: 0.12, saturation: 0.5 });
  check("classify: bright warm vivid footage", golden.lighting === "bright" && golden.palette === "warm" && golden.energy === "vivid");
  const plain = classifyScene({ avgLuma: 0.45, temperature: 0, saturation: 0.3 });
  check("classify: unremarkable footage stays standard/neutral/moderate", plain.lighting === "standard" && plain.palette === "neutral" && plain.energy === "moderate");
  check(
    "scene observer declines under node (its look input path doesn't exist here)",
    (await queryFact({ type: MEDIA_SCENE_FACT, target: assetTarget, budgetMs: 12_000 }, ctx)) === null
  );

  // ---- Source-vs-applied honesty (user question 2026-07-18: "will it detect MY
  // ---- saturation boost?" — measurement is source pixels; treatment is data) ----
  console.log("source-vs-applied honesty (describeAppliedTreatment):");
  const bareLayer = { effects: [] } as unknown as Parameters<typeof describeAppliedTreatment>[0];
  check("untreated clip → no Applied line", describeAppliedTreatment(bareLayer) === null);
  const treatedLayer = {
    effects: [
      { id: "fx1", type: "creativeLook", name: "Creative Look", enabled: true, intensity: 80, params: { look: "Noir" } },
      { id: "fx2", type: "blur", name: "Gaussian Blur", enabled: false, intensity: 45, params: {} },
      { id: "fx3", type: "brightnessContrast", name: "Basic Color Correction", enabled: true, intensity: 50, params: { saturation: 220 } }
    ],
    speed: -2
  } as unknown as Parameters<typeof describeAppliedTreatment>[0];
  check(
    "look name, intensities, reverse speed described; DISABLED effects skipped",
    describeAppliedTreatment(treatedLayer) === "Noir look @ 80, Basic Color Correction @ 50, reversed at 200%",
    describeAppliedTreatment(treatedLayer) ?? "null"
  );
  const rampedLayer = { effects: [], speedKeyframes: [{ timeSeconds: 0, rate: 1 }] } as unknown as Parameters<typeof describeAppliedTreatment>[0];
  check("speed ramp named as such", describeAppliedTreatment(rampedLayer) === "speed ramp");

  // ---- SDK v1 registration contract (ORRERIS_SDK.md) ----
  console.log("SDK v1 registration contract:");
  const sdkProbe = (patch: Partial<WorldObserver>): WorldObserver =>
    ({
      id: "sdk-probe@eval",
      version: 1,
      factTypes: ["sdk.probe"],
      fidelity: 0,
      estCostMs: 1,
      estConfidence: 0.5,
      signature: () => null,
      observe: async () => [],
      ...patch
    }) as WorldObserver;
  check("valid observer registers (true)", registerObserver(sdkProbe({})) === true);
  check("id without @namespace rejected", registerObserver(sdkProbe({ id: "no-namespace" })) === false);
  check("empty factTypes rejected", registerObserver(sdkProbe({ factTypes: [] })) === false);
  check("fidelity outside 0–4 rejected", registerObserver(sdkProbe({ fidelity: 7 as never })) === false);
  check("free lunch rejected (estCostMs 0)", registerObserver(sdkProbe({ estCostMs: 0 })) === false);
  check("overconfidence rejected (estConfidence 1.2)", registerObserver(sdkProbe({ estConfidence: 1.2 })) === false);
  check("version 0 rejected (memo key needs ≥ 1)", registerObserver(sdkProbe({ version: 0 })) === false);

  // ---- World route precision (must-escalate corpus) ----
  console.log("world route precision:");
  const brainContext: BrainContext = { composition: textComp, selection: [], nowSeconds: 3 };
  for (const prompt of [
    "analyze the pacing",
    "analyze my footage style",
    "make it pop",
    "what does the intro look like",
    "analyze clip",
    "blur clip 2",
    "analyze my system settings",
    "analyze my career",
    "show my feelings"
  ]) {
    const routed = await routePromptWorld(prompt, brainContext);
    check(`escalates: "${prompt}"`, routed.kind === "escalate");
  }
  const noMedia = await routePromptWorld("analyze clip 2", brainContext);
  check(
    "clip without media source → honest answer, no measurement",
    noMedia.kind === "answer" && noMedia.text.includes("text layer"),
    noMedia.kind
  );

  // ---- P1 (real transcript 2026-07-18): face-count questions + compound analyze asks ----
  console.log("world route questions (faces + compound):");
  const noSuchClip = await routePromptWorld("how many people can you see in clip 9", brainContext);
  check("faces question on a missing clip → honest bounds answer", noSuchClip.kind === "answer" && noSuchClip.text.includes("no clip 9"));
  const facesOnText = await routePromptWorld("how many persons are there in clip 2", brainContext);
  check("faces question on a TEXT clip → honest 'no media' answer", facesOnText.kind === "answer" && facesOnText.text.includes("no faces to detect"));
  const facesNoContext = await routePromptWorld("how many faces in clip 1", brainContext);
  check("faces question, no world context (node) → clean escalate", facesNoContext.kind === "escalate");
  const facesDeictic = await routePromptWorld("how many people can you see", brainContext);
  check("faces question without a clip ref (deictic) → escalates", facesDeictic.kind === "escalate");
  const compoundSummary = await routePromptWorld("analyze clip 2 and give me a summary in very short", brainContext);
  check(
    "compound 'analyze clip N + summary tail' still routes to the measured path",
    compoundSummary.kind === "answer" && compoundSummary.text.includes("text layer")
  );
  const compoundEdit = await routePromptWorld("analyze clip 2 and make it red", brainContext);
  check("compound with an EDIT tail escalates (never a silent partial answer)", compoundEdit.kind === "escalate");

  // ---- K5 two-input inference (composition.format) — pure classifier under node ----
  console.log("K5 format inference (composition.format):");
  check("classify: steady medium face → talking-head", classifyFormat({ presenceShare: 0.9, avgFaceAreaShare: 0.12 }) === "talking-head");
  check("classify: barely any faces → b-roll", classifyFormat({ presenceShare: 0.1, avgFaceAreaShare: 0.2 }) === "b-roll");
  check("classify: people present but not presenting → mixed", classifyFormat({ presenceShare: 0.5, avgFaceAreaShare: 0.1 }) === "mixed");
  check("classify: constant but TINY faces (crowd b-roll) → not talking-head", classifyFormat({ presenceShare: 0.9, avgFaceAreaShare: 0.01 }) === "mixed");
  check(
    "format observer declines under node (its ML input path doesn't exist here)",
    (await queryFact({ type: COMPOSITION_FORMAT_FACT, target: compTarget, budgetMs: 12_000 }, ctx)) === null
  );
  // Under node the world context can't load (no Vite env) → these must escalate, never throw.
  for (const prompt of ["analyze clip 1", "analyze my system", "analyze the project", "show my ai usage"]) {
    const routed = await routePromptWorld(prompt, brainContext);
    check(`no world context → clean escalate: "${prompt}"`, routed.kind === "escalate");
  }

  console.log(failures === 0 ? `\nworld:eval PASS (${listFacts().length} facts live)` : `\nworld:eval FAIL — ${failures} failure(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

// Loud-exit guard: if the event loop drains before run() completes (e.g. a scheduler
// deadlock leaves promises forever-pending — real bug, 2026-07-18), node exits WITHOUT
// reaching the explicit process.exit — this default turns that silent pass into a failure.
process.exitCode = 1;
void run();
