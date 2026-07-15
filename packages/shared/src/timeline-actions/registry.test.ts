/**
 * Standalone assert script for the Timeline Action Registry (repo convention:
 * no test framework — exits non-zero on first failure).
 *
 *   pnpm --filter @kimera-by-aelivion/shared actions:test
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

// --- Trim suite actions: roll / slide / ripple-trim / slip ------------------
{
  const base = fixture();
  const mediaLayerId = base.tracks.flatMap((t) => t.layers).find((l) => l.type === "video")!.id;

  // Two touching clips via a split (the left half keeps the original id).
  const split1 = registry.execute("splitClip", { layerId: mediaLayerId, atSeconds: 4 }, ctxFor(base));
  check("trim-suite: seed split ok", split1.ok);
  const twoClips = split1.ok ? split1.result.after : base;
  const trackLayers = twoClips.tracks.find((t) => t.layers.some((l) => l.id === mediaLayerId))!.layers;
  const leftId = mediaLayerId;
  const rightId = trackLayers.find((l) => l.id !== mediaLayerId)!.id;

  const roll = registry.execute("rollEdit", { leftLayerId: leftId, rightLayerId: rightId, deltaSeconds: 1 }, ctxFor(twoClips));
  check("rollEdit succeeds on a touching cut", roll.ok);
  if (roll.ok) {
    const left = roll.result.after.tracks.flatMap((t) => t.layers).find((l) => l.id === leftId)!;
    check("rollEdit extends the left tail by ~1s", Math.abs(left.durationSeconds - 5) < 1e-6);
    check("rollEdit undo round-trips", equal(applyPatch(roll.result.after, roll.result.undoPatch), twoClips));
  }
  const rollBad = registry.execute("rollEdit", { leftLayerId: leftId, rightLayerId: "not_a_layer", deltaSeconds: 1 }, ctxFor(twoClips));
  check("rollEdit rejects a missing / non-touching pair", !rollBad.ok);

  // Three touching clips so the middle has neighbours on both sides.
  const split2 = registry.execute("splitClip", { layerId: rightId, atSeconds: 8 }, ctxFor(twoClips));
  const threeClips = split2.ok ? split2.result.after : twoClips;
  const slide = registry.execute("slideClip", { layerId: rightId, deltaSeconds: -1 }, ctxFor(threeClips));
  check("slideClip succeeds with neighbours on both sides", slide.ok);
  if (slide.ok) check("slideClip undo round-trips", equal(applyPatch(slide.result.after, slide.result.undoPatch), threeClips));
  const slideFree = registry.execute("slideClip", { layerId: leftId, deltaSeconds: 1 }, ctxFor(threeClips));
  check("slideClip rejects a clip with a free edge", !slideFree.ok);

  const ripple = registry.execute("rippleTrimClip", { layerId: leftId, atSeconds: 1, side: "head" }, ctxFor(twoClips));
  check("rippleTrimClip head succeeds", ripple.ok);
  if (ripple.ok) {
    const left = ripple.result.after.tracks.flatMap((t) => t.layers).find((l) => l.id === leftId)!;
    check("rippleTrimClip shortens the head by ~1s", Math.abs(left.durationSeconds - 3) < 1e-6);
    check("rippleTrimClip undo round-trips", equal(applyPatch(ripple.result.after, ripple.result.undoPatch), twoClips));
  }
  const rippleOob = registry.execute("rippleTrimClip", { layerId: leftId, atSeconds: 99, side: "tail" }, ctxFor(twoClips));
  check("rippleTrimClip rejects an out-of-bounds time", !rippleOob.ok);

  const slip = registry.execute("slipClip", { layerId: mediaLayerId, deltaSeconds: 0.5 }, ctxFor(base));
  check("slipClip succeeds", slip.ok);
  if (slip.ok) {
    const before = base.tracks.flatMap((t) => t.layers).find((l) => l.id === mediaLayerId)!;
    const after = slip.result.after.tracks.flatMap((t) => t.layers).find((l) => l.id === mediaLayerId)!;
    check("slipClip advances sourceInSeconds", (after.sourceInSeconds ?? 0) === 0.5);
    check("slipClip leaves the clip in place", after.startSeconds === before.startSeconds && after.durationSeconds === before.durationSeconds);
  }
}

// --- moveLayers editing policy: overlap allow / overwrite / reject ----------
{
  const base = fixture();
  const mediaLayerId = base.tracks.flatMap((t) => t.layers).find((l) => l.type === "video")!.id;
  // Two touching clips [0,4) + [4,12); moving the left one +2s makes it overlap the right at [4,6).
  const seed = registry.execute("splitClip", { layerId: mediaLayerId, atSeconds: 4 }, ctxFor(base));
  const two = seed.ok ? seed.result.after : base;

  const reject = registry.execute("moveLayers", { layerIds: [mediaLayerId], deltaSeconds: 2, overlap: "reject" }, ctxFor(two));
  check("moveLayers overlap=reject refuses with a summary", reject.ok && reject.result.summary.includes("refused"));
  if (reject.ok) {
    const left = reject.result.after.tracks.flatMap((t) => t.layers).find((l) => l.id === mediaLayerId)!;
    check("moveLayers reject leaves the clip in place", left.startSeconds === 0);
  }

  const overwrite = registry.execute("moveLayers", { layerIds: [mediaLayerId], deltaSeconds: 2, overlap: "overwrite" }, ctxFor(two));
  check("moveLayers overlap=overwrite succeeds", overwrite.ok);
  if (overwrite.ok) {
    const clips = overwrite.result.after.tracks.flatMap((t) => t.layers);
    const left = clips.find((l) => l.id === mediaLayerId)!;
    // The carved neighbour survives with a NEW id (split keeps the original id on the deleted left half),
    // so identify it by position: the non-moved clip now starting at 6s.
    const neighbour = clips.find((l) => l.id !== mediaLayerId);
    check("moveLayers overwrite: moved clip lands at 2s", Math.abs(left.startSeconds - 2) < 1e-6);
    check("moveLayers overwrite: neighbour head carved to 6s", Boolean(neighbour) && Math.abs(neighbour!.startSeconds - 6) < 1e-6);
  }
}

// --- moveLayers magnetic mode: touched track compacts gapless ---------------
{
  const base = fixture();
  const mediaLayerId = base.tracks.flatMap((t) => t.layers).find((l) => l.type === "video")!.id;
  // Split into [0,4) + [4,12); trim nothing — then move the right clip far right WITH magnetic on: the
  // track must compact back to gapless.
  const seed = registry.execute("splitClip", { layerId: mediaLayerId, atSeconds: 4 }, ctxFor(base));
  const two = seed.ok ? seed.result.after : base;
  const rightId = two.tracks.find((t) => t.layers.some((l) => l.id === mediaLayerId))!.layers.find((l) => l.id !== mediaLayerId)!.id;

  const magnetic = registry.execute("moveLayers", { layerIds: [rightId], deltaSeconds: 10, magnetic: true }, ctxFor(two));
  check("moveLayers magnetic: succeeds", magnetic.ok);
  if (magnetic.ok) {
    const track = magnetic.result.after.tracks.find((t) => t.layers.some((l) => l.id === mediaLayerId))!;
    const ends = [...track.layers].sort((a, b) => a.startSeconds - b.startSeconds);
    const gapless = ends.every((l, i) => i === 0 || Math.abs(l.startSeconds - (ends[i - 1]!.startSeconds + ends[i - 1]!.durationSeconds)) < 1e-6);
    check("moveLayers magnetic: track is gapless after the move", gapless);
    check("moveLayers magnetic: right clip butts the left at 4s", Math.abs((ends[1]?.startSeconds ?? -1) - 4) < 1e-6);
  }
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll timeline action registry checks passed");
