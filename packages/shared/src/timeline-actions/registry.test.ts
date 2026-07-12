/**
 * Standalone assert script for the Timeline Action Registry (repo convention:
 * no test framework — exits non-zero on first failure).
 *
 *   pnpm --filter @lumio-by-aelivion/shared actions:test
 */
import { createDefaultComposition } from "../timeline";
import type { TimelineComposition } from "../types";
import { applyPatch } from "./patches";
import { createTimelineActionRegistry } from "./actions";
import { getActionAnalytics, resetActionAnalytics } from "./analytics";
import type { ActionContext } from "./types";

let failures = 0;
function check(name: string, condition: boolean): void {
  if (condition) {
    console.log(`  ok  ${name}`);
  } else {
    failures += 1;
    console.error(`FAIL  ${name}`);
  }
}

function equal(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function fixture(): TimelineComposition {
  return createDefaultComposition({ id: "test", name: "Test", durationSeconds: 12 });
}

function ctxFor(composition: TimelineComposition, selection: string[] = []): ActionContext {
  return { composition, nowSeconds: 3, selection };
}

const registry = createTimelineActionRegistry();

// --- Acceptance: addText "WARNING" -----------------------------------------
{
  resetActionAnalytics();
  const before = fixture();
  const outcome = registry.execute("addText", { text: "WARNING", color: "#ff0000", size: 120 }, ctxFor(before), {
    ai: true
  });
  check("addText succeeds", outcome.ok);
  if (outcome.ok) {
    const layers = outcome.result.after.tracks.flatMap((track) => track.layers);
    const added = layers.find((layer) => layer.text === "WARNING");
    check("addText inserts a WARNING text layer", Boolean(added));
    check("addText applies color", added?.color === "#ff0000");
    check("addText applies size", added?.fontSize === 120);
    check("addText summary", outcome.result.summary === 'Add text "WARNING"');
    check("addText before is untouched", before.tracks.flatMap((t) => t.layers).every((l) => l.text !== "WARNING"));
    check("forward patch reproduces after", equal(applyPatch(before, outcome.result.patch), outcome.result.after));
    check("undo patch round-trips to before", equal(applyPatch(outcome.result.after, outcome.result.undoPatch), before));
  }
  const analytics = getActionAnalytics();
  check("analytics counts addText usage", analytics.actionUsage.addText === 1);
  check("analytics counts ai-generated", analytics.aiGeneratedCount === 1);
}

// --- Undo round-trips across a representative spread of actions -------------
{
  const base = fixture();
  const mediaLayerId = base.tracks.flatMap((track) => track.layers).find((layer) => layer.type === "video")!.id;
  const seedEffect = registry.execute("addEffect", { layerId: mediaLayerId, effectType: "blur" }, ctxFor(base));
  const withEffect = seedEffect.ok ? seedEffect.result.after : base;
  const effectId = withEffect.tracks.flatMap((t) => t.layers).flatMap((l) => l.effects)[0]?.id ?? "fx";

  const cases: Array<{ id: string; params: unknown; on: TimelineComposition }> = [
    { id: "addShape", params: { color: "#00ff00" }, on: base },
    { id: "addKeyframe", params: { layerId: mediaLayerId, property: "scale", value: 1.5 }, on: base },
    { id: "addTransition", params: { layerId: mediaLayerId, kind: "crossDissolve" }, on: base },
    { id: "createTrack", params: { type: "overlay" }, on: base },
    { id: "splitClip", params: { layerId: mediaLayerId, atSeconds: 4 }, on: base },
    { id: "deleteLayer", params: { layerId: mediaLayerId, ripple: true }, on: base },
    { id: "moveLayer", params: { layerId: mediaLayerId, startSeconds: 2 }, on: base },
    { id: "updateEffect", params: { layerId: mediaLayerId, effectId, intensity: 80 }, on: withEffect },
    { id: "attachMask", params: { layerId: mediaLayerId, artifactId: "artifact_1" }, on: base }
  ];

  for (const testCase of cases) {
    const outcome = registry.execute(testCase.id, testCase.params, ctxFor(testCase.on));
    check(`${testCase.id} succeeds`, outcome.ok);
    if (outcome.ok) {
      check(`${testCase.id} undo round-trips`, equal(applyPatch(outcome.result.after, outcome.result.undoPatch), testCase.on));
      check(`${testCase.id} forward patch matches`, equal(applyPatch(testCase.on, outcome.result.patch), outcome.result.after));
    }
  }
}

// --- Acceptance: reorderTrack "move V3 to the top" ---------------------------
{
  const base = fixture();
  // Grow to 3 tracks so there is a real stack to reorder.
  const withOne = registry.execute("createTrack", { type: "video", name: "Extra A" }, ctxFor(base));
  const afterOne = withOne.ok ? withOne.result.after : base;
  const withTwo = registry.execute("createTrack", { type: "video", name: "Extra B" }, ctxFor(afterOne));
  const stacked = withTwo.ok ? withTwo.result.after : afterOne;
  const last = stacked.tracks[stacked.tracks.length - 1]!;

  const outcome = registry.execute("reorderTrack", { trackId: last.id, position: "top" }, ctxFor(stacked));
  check("reorderTrack to top succeeds", outcome.ok);
  if (outcome.ok) {
    check("reorderTrack: track is now first (drawn on top)", outcome.result.after.tracks[0]?.id === last.id);
    check("reorderTrack: no track lost", outcome.result.after.tracks.length === stacked.tracks.length);
    check("reorderTrack summary names the track", outcome.result.summary.includes(last.name));
    check("reorderTrack undo round-trips", equal(applyPatch(outcome.result.after, outcome.result.undoPatch), stacked));
    check("reorderTrack forward patch matches", equal(applyPatch(stacked, outcome.result.patch), outcome.result.after));
  }

  const toIndex = registry.execute("reorderTrack", { trackId: stacked.tracks[0]!.id, toIndex: 2 }, ctxFor(stacked));
  check("reorderTrack toIndex succeeds", toIndex.ok);
  if (toIndex.ok) {
    check("reorderTrack: toIndex lands at index 2", toIndex.result.after.tracks[2]?.id === stacked.tracks[0]!.id);
  }

  const both = registry.execute("reorderTrack", { trackId: last.id, toIndex: 0, position: "top" }, ctxFor(stacked));
  check("reorderTrack rejects toIndex AND position", !both.ok);
  const missing = registry.execute("reorderTrack", { trackId: "no_such_track", position: "top" }, ctxFor(stacked));
  check("reorderTrack rejects unknown track", !missing.ok);
}

// --- Shape primitive params -------------------------------------------------
{
  const base = fixture();
  const outcome = registry.execute("addShape", { shapeKind: "triangle", widthPercent: 24, heightPercent: 24, borderRadius: 0 }, ctxFor(base));
  check("addShape accepts basic shape kind", outcome.ok);
  if (outcome.ok) {
    const added = outcome.result.after.tracks.flatMap((track) => track.layers).find((layer) => layer.type === "shape");
    check("addShape stores triangle primitive", added?.shapeKind === "triangle");
    check("addShape stores triangle proportions", added?.widthPercent === 24 && added?.heightPercent === 24);
  }
  const penOutcome = registry.execute("addShape", { shapeKind: "pen" }, ctxFor(base));
  check("addShape accepts pen primitive", penOutcome.ok);
  if (penOutcome.ok) {
    const added = penOutcome.result.after.tracks.flatMap((track) => track.layers).find((layer) => layer.type === "shape");
    check("addShape stores pen path points", added?.shapeKind === "pen" && (added.shapePath?.length ?? 0) >= 4);
  }
}

// --- Rejection paths --------------------------------------------------------
{
  const base = fixture();
  const ctx = ctxFor(base);

  const unknown = registry.execute("noSuchAction", {}, ctx);
  check("unknown action rejected", !unknown.ok && unknown.code === "unknown_action");

  const malformed = registry.execute("addText", { text: 123 }, ctx);
  check("malformed params rejected", !malformed.ok && malformed.code === "invalid_params");

  const layerId = base.tracks.flatMap((t) => t.layers)[0]!.id;
  const badEffect = registry.execute("addEffect", { layerId, effectType: "nonsense_effect" }, ctx);
  check("unknown effect type rejected", !badEffect.ok && badEffect.code === "validation_failed");

  const badParam = registry.execute("addEffect", { layerId, effectType: "blur", params: { radius: 99999 } }, ctx);
  check("out-of-range effect param rejected", !badParam.ok && badParam.code === "validation_failed");

  const badLayer = registry.execute("deleteLayer", { layerId: "does_not_exist" }, ctx);
  check("invalid layer reference rejected", !badLayer.ok && badLayer.code === "validation_failed");

  check("rejections did not mutate the composition", equal(base, fixture()));
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll timeline action registry checks passed");
