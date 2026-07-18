/**
 * Standalone assert script for Graphics-stack drag-reorder (§4). Repo convention: no test framework —
 * exits non-zero on first failure.
 *
 *   pnpm --filter @orreris/web stack:reorder:test
 *
 * Draw order within a track is ARRAY order — higher index renders on top. "front-of" reinserts after
 * the target (on top), "behind" reinserts before it (under). Cross-track drops are rejected.
 */
import { moveLayerWithinTrack, type TimelineComposition, type TimelineLayer } from "@orreris/shared";

let failures = 0;
function check(name: string, condition: boolean): void {
  if (condition) {
    console.log(`  ok  ${name}`);
  } else {
    failures += 1;
    console.error(`FAIL  ${name}`);
  }
}

function layer(id: string, trackId: string): TimelineLayer {
  return {
    id,
    trackId,
    type: "shape",
    name: id,
    startSeconds: 0,
    durationSeconds: 3,
    transform: { position: { x: 50, y: 50 }, scale: 1, rotation: 0, opacity: 100 },
    effects: [],
    keyframes: []
  } as TimelineLayer;
}

function comp(tracks: { id: string; layerIds: string[] }[]): TimelineComposition {
  return {
    id: "c",
    name: "c",
    width: 1920,
    height: 1080,
    fps: 30,
    durationSeconds: 3,
    backgroundColor: "#000",
    tracks: tracks.map((t) => ({ id: t.id, name: t.id, type: "video", layers: t.layerIds.map((id) => layer(id, t.id)) }))
  } as unknown as TimelineComposition;
}

const order = (c: TimelineComposition, trackId: string) =>
  c.tracks.find((t) => t.id === trackId)!.layers.map((l) => l.id).join(",");

// Track order [a,b,c] = a bottom, c top (array index = Z).
// --- front-of: move a in front of b → a lands right after b -----------------------------
{
  const out = moveLayerWithinTrack(comp([{ id: "T", layerIds: ["a", "b", "c"] }]), "a", "b", "front-of");
  check("front-of: a→front of b gives b,a,c", order(out, "T") === "b,a,c");
}

// --- behind: move c behind b → c lands right before b -----------------------------------
{
  const out = moveLayerWithinTrack(comp([{ id: "T", layerIds: ["a", "b", "c"] }]), "c", "b", "behind");
  check("behind: c→behind b gives a,c,b", order(out, "T") === "a,c,b");
}

// --- front-of the top layer → becomes the new top --------------------------------------
{
  const out = moveLayerWithinTrack(comp([{ id: "T", layerIds: ["a", "b", "c"] }]), "a", "c", "front-of");
  check("front-of top: a→front of c gives b,c,a", order(out, "T") === "b,c,a");
}

// --- behind the bottom layer → becomes the new bottom ----------------------------------
{
  const out = moveLayerWithinTrack(comp([{ id: "T", layerIds: ["a", "b", "c"] }]), "c", "a", "behind");
  check("behind bottom: c→behind a gives c,a,b", order(out, "T") === "c,a,b");
}

// --- cross-track drop is rejected (identity) -------------------------------------------
{
  const c = comp([
    { id: "T1", layerIds: ["a", "b"] },
    { id: "T2", layerIds: ["x", "y"] }
  ]);
  const out = moveLayerWithinTrack(c, "a", "x", "front-of");
  check("cross-track: rejected (identity ===)", out === c);
}

// --- self drop is a no-op (identity) ---------------------------------------------------
{
  const c = comp([{ id: "T", layerIds: ["a", "b", "c"] }]);
  check("self: a onto a is identity", moveLayerWithinTrack(c, "a", "a", "front-of") === c);
}

// --- only the owning track changes; other tracks untouched -----------------------------
{
  const c = comp([
    { id: "T1", layerIds: ["a", "b", "c"] },
    { id: "T2", layerIds: ["x", "y"] }
  ]);
  const out = moveLayerWithinTrack(c, "a", "c", "front-of");
  check("isolation: T1 reordered", order(out, "T1") === "b,c,a");
  check("isolation: T2 untouched", order(out, "T2") === "x,y");
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll stack-reorder checks passed");
