/**
 * Clip reference test.
 *
 * Covers the three pure functions that make natural-language clip targeting work
 * (packages/shared/src/clip-reference.ts):
 *   - computeLayerOrdinals: positional numbers in eye order (start time, then top track first),
 *     counted per spoken kind (clip/text/audio/shape), adjustment layers excluded;
 *   - parseClipReference: forgiving parse of "clip 4" / "the 4th clip" / "second caption";
 *   - resolveTargetLayer: the priority ladder explicit > reference > single selection >
 *     single playhead > ambiguous > none — the "if no clip named, use selection/playhead" promise.
 */

import assert from "node:assert/strict";
import {
  computeLayerOrdinals,
  parseClipReference,
  resolveTargetLayer,
  type TimelineComposition,
  type TimelineLayer,
  type TimelineTrackType
} from "@kimera-by-aelivion/shared";

function layer(partial: Partial<TimelineLayer> & Pick<TimelineLayer, "id" | "type" | "startSeconds" | "durationSeconds">): TimelineLayer {
  return {
    trackId: "t",
    name: partial.id,
    ...partial
  } as TimelineLayer;
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

// A montage: 3 video clips on one track, one caption + one music clip on others.
const montage = comp([
  {
    type: "video",
    layers: [
      layer({ id: "vid_a", type: "video", startSeconds: 0, durationSeconds: 5 }),
      layer({ id: "vid_b", type: "video", startSeconds: 5, durationSeconds: 5 }),
      layer({ id: "vid_c", type: "video", startSeconds: 10, durationSeconds: 5 })
    ]
  },
  { type: "text", layers: [layer({ id: "cap_1", type: "text", startSeconds: 2, durationSeconds: 3 })] },
  { type: "audio", layers: [layer({ id: "aud_1", type: "audio", startSeconds: 0, durationSeconds: 15 })] }
]);

// 1. Ordinals: one GLOBAL sequence in eye order (start time, then top track first) across all clips.
//    Eye order here: vid_a(0,t0), aud_1(0,t2), cap_1(2,t1), vid_b(5,t0), vid_c(10,t0).
{
  const ord = computeLayerOrdinals(montage);
  assert.equal(ord.get("vid_a")!.label, "clip 1");
  assert.equal(ord.get("aud_1")!.ordinal, 2, "audio at t=0 is the 2nd item (top track first tie-break)");
  assert.equal(ord.get("cap_1")!.ordinal, 3);
  assert.equal(ord.get("vid_b")!.label, "clip 4");
  assert.equal(ord.get("vid_c")!.label, "clip 5");
}

// 2. Eye order tie-break: two clips starting at the same time → top track first.
{
  const stacked = comp([
    { type: "video", layers: [layer({ id: "top", type: "video", startSeconds: 0, durationSeconds: 4 })] },
    { type: "overlay", layers: [layer({ id: "bottom", type: "video", startSeconds: 0, durationSeconds: 4 })] }
  ]);
  const ord = computeLayerOrdinals(stacked);
  assert.equal(ord.get("top")!.ordinal, 1, "top track wins the tie");
  assert.equal(ord.get("bottom")!.ordinal, 2);
}

// 3. Adjustment layers get no ordinal.
{
  const withAdjustment = comp([
    { type: "video", layers: [layer({ id: "adj", type: "adjustment", startSeconds: 0, durationSeconds: 5 }), layer({ id: "v", type: "video", startSeconds: 0, durationSeconds: 5 })] }
  ]);
  const ord = computeLayerOrdinals(withAdjustment);
  assert.equal(ord.has("adj"), false, "adjustment layer is not numbered");
  assert.equal(ord.get("v")!.label, "clip 1");
}

// 4. parseClipReference: the common spoken/typed forms (flat — any clip-noun → the Nth clip).
{
  assert.deepEqual(parseClipReference("remove background from clip 4"), { ordinal: 4 });
  assert.deepEqual(parseClipReference("blur the 2nd clip"), { ordinal: 2 });
  assert.deepEqual(parseClipReference("edit the second layer"), { ordinal: 2 });
  assert.deepEqual(parseClipReference("clip #3 needs a fade"), { ordinal: 3 });
  assert.deepEqual(parseClipReference("change clip number 5 to hello"), { ordinal: 5 });
  assert.equal(parseClipReference("remove the background"), undefined, "no clip named → undefined");
  assert.equal(parseClipReference("make it 2x bigger"), undefined, "bare number without a clip-noun → undefined");
}

// 5. resolveTargetLayer ladder.
{
  // explicit id wins.
  assert.deepEqual(
    resolveTargetLayer(montage, { selection: ["vid_b"], nowSeconds: 12, explicitLayerId: "vid_a" }),
    { layerId: "vid_a", reason: "explicit" }
  );
  // spoken reference resolves the GLOBAL ordinal (clip 4 → vid_b in eye order).
  assert.deepEqual(
    resolveTargetLayer(montage, { selection: [], nowSeconds: 12, reference: { ordinal: 4 } }),
    { layerId: "vid_b", reason: "reference" }
  );
  // a reference to a non-existent ordinal → none.
  assert.equal(resolveTargetLayer(montage, { selection: [], nowSeconds: 0, reference: { ordinal: 9 } }).reason, "none");
  // single selection.
  assert.deepEqual(resolveTargetLayer(montage, { selection: ["vid_c"], nowSeconds: 99 }), { layerId: "vid_c", reason: "selection" });
  // no selection, playhead over exactly one visual clip (at t=12 only vid_c is active).
  assert.deepEqual(resolveTargetLayer(montage, { selection: [], nowSeconds: 12 }), { layerId: "vid_c", reason: "playhead" });
  // nothing selected, playhead past everything → none.
  assert.equal(resolveTargetLayer(montage, { selection: [], nowSeconds: 99 }).reason, "none");
}

// 6b. Type-agnostic playhead: parked on a TEXT clip (no selection) resolves it — edits like blur
//     apply to text too, so "this clip" must not be video-only.
{
  const textOnly = comp([{ type: "text", layers: [layer({ id: "txt", type: "text", startSeconds: 0, durationSeconds: 5 })] }]);
  assert.deepEqual(resolveTargetLayer(textOnly, { selection: [], nowSeconds: 2 }), { layerId: "txt", reason: "playhead" });
  // a shape under the playhead also resolves.
  const shapeOnly = comp([{ type: "overlay", layers: [layer({ id: "shp", type: "shape", startSeconds: 0, durationSeconds: 5 })] }]);
  assert.deepEqual(resolveTargetLayer(shapeOnly, { selection: [], nowSeconds: 2 }), { layerId: "shp", reason: "playhead" });
  // audio under the playhead is NOT auto-targeted (spans everything → poor "this clip" guess).
  const audioOnly = comp([{ type: "audio", layers: [layer({ id: "aud", type: "audio", startSeconds: 0, durationSeconds: 5 })] }]);
  assert.equal(resolveTargetLayer(audioOnly, { selection: [], nowSeconds: 2 }).reason, "none");
}

// 6. Ambiguous: two clips overlap under the playhead → ambiguous, top track as default.
{
  const overlap = comp([
    { type: "video", layers: [layer({ id: "top", type: "video", startSeconds: 0, durationSeconds: 10 })] },
    { type: "overlay", layers: [layer({ id: "bottom", type: "video", startSeconds: 0, durationSeconds: 10 })] }
  ]);
  const result = resolveTargetLayer(overlap, { selection: [], nowSeconds: 5 });
  assert.equal(result.reason, "ambiguous");
  assert.equal(result.layerId, "top", "top track is the ambiguous default");
  assert.deepEqual(result.candidates?.sort(), ["bottom", "top"]);
}

console.log("clip-reference-test: OK");
