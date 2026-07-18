/**
 * Standalone assert script for the group-move resolver (repo convention: no test framework —
 * exits non-zero on first failure).
 *
 *   pnpm --filter @orreris/shared resolver:test
 *
 * These lock the two invariants the old preview/commit split got wrong: a multi-clip move is
 * RIGID on both axes — the whole selection shifts by one shared delta clamped so every member
 * stays in bounds, so it never collapses onto one lane (track) or compresses at t=0 (time).
 */
import type { TimelineComposition } from "./types";
import type { TimelineLayer } from "./types";
import {
  applyEdgeTrim,
  applyGroupMovePlacements,
  applyMagneticTracks,
  applyOverlapPolicy,
  commitGroupMove,
  DEFAULT_EDITING_POLICY,
  resolveEdgeTrim,
  resolveGroupMove,
  type GroupMovePlacement
} from "./timeline-ops";

let failures = 0;
function check(name: string, condition: boolean): void {
  if (condition) {
    console.log(`  ok  ${name}`);
  } else {
    failures += 1;
    console.error(`FAIL  ${name}`);
  }
}

type AnyLayer = { id: string; trackId: string; type: string; startSeconds: number; durationSeconds: number; effects: []; keyframes: []; locked?: boolean; linkedGroupId?: string };
function clip(id: string, trackId: string, start: number, dur = 2, extra: Partial<AnyLayer> = {}): AnyLayer {
  return { id, trackId, type: trackId.startsWith("A") ? "audio" : "video", startSeconds: start, durationSeconds: dur, effects: [], keyframes: [], ...extra };
}
function intervalsOf(composition: TimelineComposition, trackId: string): Array<[number, number]> {
  const track = composition.tracks.find((t) => t.id === trackId)!;
  return track.layers
    .map((l) => [Number(l.startSeconds.toFixed(4)), Number((l.startSeconds + l.durationSeconds).toFixed(4))] as [number, number])
    .sort((a, b) => a[0] - b[0]);
}
function sameIntervals(a: Array<[number, number]>, b: Array<[number, number]>): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
function vtrack(id: string, layers: AnyLayer[], locked = false) {
  return { id, type: "video", name: id, locked, layers };
}
function atrack(id: string, layers: AnyLayer[], locked = false) {
  return { id, type: "audio", name: id, locked, layers };
}
function comp(tracks: ReturnType<typeof vtrack>[]): TimelineComposition {
  return { id: "c", name: "c", width: 1080, height: 1920, fps: 30, durationSeconds: 600, backgroundColor: "#000", tracks } as unknown as TimelineComposition;
}
function placement(res: { placements: GroupMovePlacement[] }, id: string): GroupMovePlacement | undefined {
  return res.placements.find((p) => p.layerId === id);
}

// 1. Group move DOWN clamps as a unit — clips never collapse onto one lane. -----------------------
{
  const composition = comp([vtrack("V1", [clip("A", "V1", 4)]), vtrack("V2", [clip("B", "V2", 4)]), vtrack("V3", [])]);
  // Want +2 rows, but B (on V2) can only go +1 before the bottom → whole group clamps to +1.
  const res = resolveGroupMove({ composition, movedLayerIds: ["A", "B"], primaryLayerId: "A", deltaSeconds: 0, trackDelta: 2 });
  check("group-down: applied track delta clamped to group (1, not 2)", res.appliedTrackDelta === 1);
  check("group-down: A moved V1→V2", placement(res, "A")?.trackId === "V2");
  check("group-down: B moved V2→V3 (NOT collapsed onto A)", placement(res, "B")?.trackId === "V3");
  // A is already on the top track (index 0), so the group can't move up → min 0; B caps the down move at +1.
  check("group-down: bounds reported", res.trackDeltaBounds.min === 0 && res.trackDeltaBounds.max === 1);
}

// 2. Time is rigid — a member hitting t=0 stops the group, it does NOT compress. ------------------
{
  const composition = comp([vtrack("V1", [clip("A", "V1", 1), clip("B", "V1", 3)])]);
  const res = resolveGroupMove({ composition, movedLayerIds: ["A", "B"], primaryLayerId: "A", deltaSeconds: -5, trackDelta: 0 });
  check("time-rigid: shared delta clamped to -1 (A's room to 0)", Math.abs(res.appliedDeltaSeconds + 1) < 1e-9);
  check("time-rigid: A lands at 0", Math.abs((placement(res, "A")?.startSeconds ?? -1) - 0) < 1e-9);
  check("time-rigid: B keeps the 2s gap (lands at 2, not 0)", Math.abs((placement(res, "B")?.startSeconds ?? -1) - 2) < 1e-9);
}

// 3. Linked companions follow the time shift (member=false), and constrain the group. ------------
{
  const composition = comp([
    vtrack("V1", [clip("A", "V1", 5, 2, { linkedGroupId: "g1" })]),
    atrack("A1", [clip("C", "A1", 1, 2, { linkedGroupId: "g1" })])
  ]);
  // Only A is selected; C is its linked companion sitting at t=1, so the group can't move left past -1.
  const res = resolveGroupMove({ composition, movedLayerIds: ["A"], primaryLayerId: "A", deltaSeconds: -3, trackDelta: 0 });
  check("linked: companion pulled in as follower", placement(res, "C")?.member === false);
  check("linked: shared delta clamped by companion (-1)", Math.abs(res.appliedDeltaSeconds + 1) < 1e-9);
  check("linked: A lands at 4, C at 0 — offset preserved", placement(res, "A")?.startSeconds === 4 && placement(res, "C")?.startSeconds === 0);
  check("linked: follower keeps its own track", placement(res, "C")?.trackId === "A1");
}

// 4. Cross-family group: one shared row delta, clamped by the tightest family. --------------------
{
  const composition = comp([vtrack("V1", [clip("A", "V1", 4)]), vtrack("V2", []), atrack("A1", [clip("D", "A1", 4)])]);
  // Video could go +1 but audio family has a single lane (D can't move), so the group can't move rows.
  const res = resolveGroupMove({ composition, movedLayerIds: ["A", "D"], primaryLayerId: "A", deltaSeconds: 0, trackDelta: 1 });
  check("cross-family: track delta clamped to 0 by audio family", res.appliedTrackDelta === 0);
  check("cross-family: A stays on V1", placement(res, "A")?.trackId === "V1");
  check("cross-family: D stays on A1", placement(res, "D")?.trackId === "A1");
}

// 5. No movement → invalid (feeds the no-op-click guard). ----------------------------------------
{
  const composition = comp([vtrack("V1", [clip("A", "V1", 4)])]);
  const res = resolveGroupMove({ composition, movedLayerIds: ["A"], primaryLayerId: "A", deltaSeconds: 0, trackDelta: 0 });
  check("no-op: valid=false", res.valid === false && res.reason === "No movement");
}

// 6. Locked clips / tracks are never moved. ------------------------------------------------------
{
  const composition = comp([vtrack("V1", [clip("A", "V1", 4, 2, { locked: true })]), vtrack("V2", [clip("B", "V2", 4)])]);
  const res = resolveGroupMove({ composition, movedLayerIds: ["A", "B"], primaryLayerId: "B", deltaSeconds: 2, trackDelta: 0 });
  check("locked: locked clip A excluded from placements", placement(res, "A") === undefined);
  check("locked: B still moves", Math.abs((placement(res, "B")?.startSeconds ?? -1) - 6) < 1e-9);
}

// 7. applyGroupMovePlacements relocates clips across tracks. --------------------------------------
{
  const composition = comp([vtrack("V1", [clip("A", "V1", 4)]), vtrack("V2", [clip("B", "V2", 4)]), vtrack("V3", [])]);
  const res = resolveGroupMove({ composition, movedLayerIds: ["A", "B"], primaryLayerId: "A", deltaSeconds: 1, trackDelta: 1 });
  const next = applyGroupMovePlacements(composition, res.placements);
  const trackOf = (id: string) => next.tracks.find((t) => t.layers.some((l) => l.id === id))?.id;
  const startOf = (id: string) => next.tracks.flatMap((t) => t.layers).find((l) => l.id === id)?.startSeconds;
  check("apply: A now on V2", trackOf("A") === "V2");
  check("apply: B now on V3", trackOf("B") === "V3");
  check("apply: both shifted +1s in time", startOf("A") === 5 && startOf("B") === 5);
  check("apply: no clip duplicated", next.tracks.flatMap((t) => t.layers).length === 2);
}

// 8. Overlap policy: allow is a no-op, reject refuses, overwrite carves the stationary clip. --------
{
  // Stationary S spans [0,10) on V1; moved clip M lands INSIDE it at [4,6).
  const withMovedInside = () => comp([vtrack("V1", [clip("S", "V1", 0, 10), clip("M", "V1", 4, 2)])]);

  const allow = applyOverlapPolicy(withMovedInside(), ["M"], "allow");
  check("overlap allow: no-op (S + M both intact)", allow.accepted && sameIntervals(intervalsOf(allow.composition, "V1"), [[0, 10], [4, 6]]));

  const reject = applyOverlapPolicy(withMovedInside(), ["M"], "reject");
  check("overlap reject: not accepted", reject.accepted === false && reject.reason !== null);

  const overwrite = applyOverlapPolicy(withMovedInside(), ["M"], "overwrite");
  check("overlap overwrite: S carved into [0,4)+[6,10), M kept", sameIntervals(intervalsOf(overwrite.composition, "V1"), [[0, 4], [4, 6], [6, 10]]));
  check("overlap overwrite: no stationary clip still overlaps M", overwrite.composition.tracks[0]!.layers.filter((l) => l.id !== "M").every((l) => l.startSeconds + l.durationSeconds <= 4 + 1e-6 || l.startSeconds >= 6 - 1e-6));
}

// 9. Overwrite edge cases: fully-covered removes, head/tail trims. --------------------------------
{
  const covered = applyOverlapPolicy(comp([vtrack("V1", [clip("S", "V1", 4, 2), clip("M", "V1", 0, 10)])]), ["M"], "overwrite");
  check("overwrite fully-covered: S removed, only M remains", sameIntervals(intervalsOf(covered.composition, "V1"), [[0, 10]]));

  const head = applyOverlapPolicy(comp([vtrack("V1", [clip("S", "V1", 4, 6), clip("M", "V1", 0, 6)])]), ["M"], "overwrite");
  check("overwrite head overlap: S trimmed to [6,10)", sameIntervals(intervalsOf(head.composition, "V1"), [[0, 6], [6, 10]]));

  const tail = applyOverlapPolicy(comp([vtrack("V1", [clip("S", "V1", 0, 6), clip("M", "V1", 4, 6)])]), ["M"], "overwrite");
  check("overwrite tail overlap: S trimmed to [0,4)", sameIntervals(intervalsOf(tail.composition, "V1"), [[0, 4], [4, 10]]));
}

// 10. commitGroupMove threads placements → policy; reject returns the ORIGINAL (unmoved). ----------
{
  // S sits on V1 [0,10); M starts on V2, gets moved onto V1 at start 4.
  const base = comp([vtrack("V1", [clip("S", "V1", 0, 10)]), vtrack("V2", [clip("M", "V2", 4, 2)])]);
  const placements: GroupMovePlacement[] = [{ layerId: "M", startSeconds: 4, trackId: "V1", member: true }];

  const allow = commitGroupMove(base, placements, ["M"], DEFAULT_EDITING_POLICY);
  check("commit allow: M now on V1, S untouched", allow.accepted && intervalsOf(allow.composition, "V1").length === 2 && intervalsOf(allow.composition, "V2").length === 0);

  const overwrite = commitGroupMove(base, placements, ["M"], { ...DEFAULT_EDITING_POLICY, overlap: "overwrite" });
  check("commit overwrite: S carved around M on V1", sameIntervals(intervalsOf(overwrite.composition, "V1"), [[0, 4], [4, 6], [6, 10]]));

  const reject = commitGroupMove(base, placements, ["M"], { ...DEFAULT_EDITING_POLICY, overlap: "reject" });
  check("commit reject: refused → original composition (M still on V2)", reject.accepted === false && intervalsOf(reject.composition, "V2").length === 1 && intervalsOf(reject.composition, "V1").length === 1);
}

// 11. Edge trim resolver: source-aware head/tail limits + non-source squeeze. --------------------
{
  const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;
  // Source-bound media clip: start 5, dur 3, only 2s of head material revealed (sourceIn 2).
  const media = { id: "m", trackId: "V1", type: "video", assetId: "a1", startSeconds: 5, durationSeconds: 3, sourceInSeconds: 2, effects: [], keyframes: [] } as unknown as TimelineLayer;

  // Head extend LEFT is capped by available head material (THE snap-back bug): can reveal only 2s.
  const headExtend = resolveEdgeTrim(media, { startSeconds: 0, durationSeconds: 8 }, { maxDurationSeconds: 20, minDurationSeconds: 0.04 });
  check("edge head-extend: start capped at 3 (only 2s of source head)", near(headExtend.startSeconds, 3));
  check("edge head-extend: duration grows to 5, sourceIn floors at 0", near(headExtend.durationSeconds, 5) && near(headExtend.sourceInSeconds ?? -1, 0));
  // Idempotent — feeding the resolved edges back changes nothing (preview→commit stability).
  const again = resolveEdgeTrim(media, { startSeconds: headExtend.startSeconds, durationSeconds: headExtend.durationSeconds }, { maxDurationSeconds: 20, minDurationSeconds: 0.04 });
  check("edge head-extend: idempotent", near(again.startSeconds, 3) && near(again.durationSeconds, 5));

  // Head trim INWARD advances the in-point.
  const headTrim = resolveEdgeTrim(media, { startSeconds: 7, durationSeconds: 1 }, { maxDurationSeconds: 20, minDurationSeconds: 0.04 });
  check("edge head-trim: sourceIn advances to 4", near(headTrim.sourceInSeconds ?? -1, 4) && near(headTrim.startSeconds, 7) && near(headTrim.durationSeconds, 1));

  // Tail extend is capped by material left from the in-point (maxDuration − sourceIn).
  const tailExtend = resolveEdgeTrim(media, { startSeconds: 5, durationSeconds: 40 }, { maxDurationSeconds: 10, minDurationSeconds: 0.04 });
  check("edge tail-extend: duration capped at 8 (10 − 2 sourceIn)", near(tailExtend.durationSeconds, 8));

  // Non-source (text) clip squeezes; no source in-point; left-drag past the max pins the start.
  const text = { id: "t", trackId: "V1", type: "text", startSeconds: 5, durationSeconds: 3, effects: [], keyframes: [] } as unknown as TimelineLayer;
  const textTrim = resolveEdgeTrim(text, { startSeconds: 5, durationSeconds: 2 }, { maxDurationSeconds: 100, minDurationSeconds: 0.04 });
  check("edge non-source: no sourceIn, duration honored", textTrim.sourceInSeconds === undefined && textTrim.sourceBound === false && near(textTrim.durationSeconds, 2));
  const textPin = resolveEdgeTrim(text, { startSeconds: 0, durationSeconds: 8 }, { maxDurationSeconds: 4, minDurationSeconds: 0.04 });
  check("edge non-source: left-drag past max pins start (end − max)", near(textPin.startSeconds, 4) && near(textPin.durationSeconds, 4));

  // applyEdgeTrim writes the resolved edges + sets sourceIn for source-bound clips.
  const written = applyEdgeTrim(media, headTrim);
  check("applyEdgeTrim: writes start/duration/sourceIn", near(written.startSeconds, 7) && near(written.durationSeconds, 1) && near(written.sourceInSeconds ?? -1, 4));
  const writtenText = applyEdgeTrim(text, textTrim);
  check("applyEdgeTrim: non-source leaves sourceIn untouched", writtenText.sourceInSeconds === undefined);
}

// 12. Policy-driven locks + linked media (resolveGroupMove reads the rules from the policy). --------
{
  const place = (res: { placements: GroupMovePlacement[] }, id: string) => res.placements.find((p) => p.layerId === id);

  // lockedTracks: default "reject" skips a locked clip; "ignore" moves it anyway.
  const lockedComp = () => comp([vtrack("V1", [clip("A", "V1", 4, 2, { locked: true })]), vtrack("V2", [clip("B", "V2", 4)])]);
  const respected = resolveGroupMove({ composition: lockedComp(), movedLayerIds: ["A", "B"], primaryLayerId: "B", deltaSeconds: 2 });
  check("policy lockedTracks default: locked A excluded", place(respected, "A") === undefined && place(respected, "B") !== undefined);
  const ignored = resolveGroupMove({ composition: lockedComp(), movedLayerIds: ["A", "B"], primaryLayerId: "B", deltaSeconds: 2, policy: { lockedTracks: "ignore", linkedMedia: "moveTogether" } });
  check("policy lockedTracks=ignore: locked A now moves", place(ignored, "A") !== undefined && Math.abs((place(ignored, "A")?.startSeconds ?? -1) - 6) < 1e-9);

  // linkedMedia: default pulls the companion in; "allowBreak" leaves it (link breaks).
  const linkedComp = () => comp([
    vtrack("V1", [clip("A", "V1", 5, 2, { linkedGroupId: "g1" })]),
    atrack("A1", [clip("C", "A1", 5, 2, { linkedGroupId: "g1" })])
  ]);
  const together = resolveGroupMove({ composition: linkedComp(), movedLayerIds: ["A"], primaryLayerId: "A", deltaSeconds: 2 });
  check("policy linkedMedia default: companion C followed", place(together, "C")?.member === false);
  const broken = resolveGroupMove({ composition: linkedComp(), movedLayerIds: ["A"], primaryLayerId: "A", deltaSeconds: 2, policy: { lockedTracks: "reject", linkedMedia: "allowBreak" } });
  check("policy linkedMedia=allowBreak: companion C left behind", place(broken, "C") === undefined && place(broken, "A") !== undefined);
}

// 13. Magnetic timeline: gapless + overlap-free compaction, anchored at the earliest start. --------
{
  // Gap between A [0,2) and B [5,7): compaction pulls B left to butt A.
  const gap = applyMagneticTracks(comp([vtrack("V1", [clip("A", "V1", 0, 2), clip("B", "V1", 5, 2)])]), ["V1"]);
  check("magnetic: gap closed → [0,2)+[2,4)", sameIntervals(intervalsOf(gap, "V1"), [[0, 2], [2, 4]]));

  // Overlap A [0,4) / B [2,5): laid end-to-end in order, no overlap.
  const over = applyMagneticTracks(comp([vtrack("V1", [clip("A", "V1", 0, 4), clip("B", "V1", 2, 3)])]), ["V1"]);
  check("magnetic: overlap removed → [0,4)+[4,7)", sameIntervals(intervalsOf(over, "V1"), [[0, 4], [4, 7]]));

  // Anchored at the earliest start (does NOT slam to 0).
  const anchored = applyMagneticTracks(comp([vtrack("V1", [clip("A", "V1", 3, 2), clip("B", "V1", 8, 2)])]), ["V1"]);
  check("magnetic: keeps the block's left edge (3), not 0", sameIntervals(intervalsOf(anchored, "V1"), [[3, 5], [5, 7]]));

  // A track containing a locked clip is left untouched (v1 limitation).
  const locked = applyMagneticTracks(comp([vtrack("V1", [clip("A", "V1", 0, 2, { locked: true }), clip("B", "V1", 5, 2)])]), ["V1"]);
  check("magnetic: locked-anchor track skipped", sameIntervals(intervalsOf(locked, "V1"), [[0, 2], [5, 7]]));

  // Only the named tracks compact.
  const scoped = applyMagneticTracks(comp([vtrack("V1", [clip("A", "V1", 0, 2), clip("B", "V1", 5, 2)]), vtrack("V2", [clip("C", "V2", 0, 2), clip("D", "V2", 9, 2)])]), ["V1"]);
  check("magnetic: untouched track V2 keeps its gap", sameIntervals(intervalsOf(scoped, "V2"), [[0, 2], [9, 11]]));

  // commitGroupMove with magnetic policy: moving B far right still butts it against A (gap can't survive).
  const base = comp([vtrack("V1", [clip("A", "V1", 0, 2), clip("B", "V1", 5, 2)])]);
  const placements: GroupMovePlacement[] = [{ layerId: "B", startSeconds: 20, trackId: "V1", member: true }];
  const committed = commitGroupMove(base, placements, ["B"], { ...DEFAULT_EDITING_POLICY, magnetic: true });
  check("magnetic commit: B pulled back to butt A [2,4)", committed.accepted && sameIntervals(intervalsOf(committed.composition, "V1"), [[0, 2], [2, 4]]));
}

if (failures > 0) {
  console.error(`\n${failures} resolver check(s) failed`);
  process.exit(1);
}
console.log("\nAll resolveGroupMove checks passed");
