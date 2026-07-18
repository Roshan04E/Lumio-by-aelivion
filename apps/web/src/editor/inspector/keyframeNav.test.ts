/**
 * Keyframe prev/next NAVIGATION — standalone assert script (repo convention: no test framework,
 * exits non-zero on failure).
 *
 *   pnpm --filter @orreris/web keyframe:nav:test
 *
 * Guards the falsy-zero trap that disabled the "previous keyframe" button whenever the previous key
 * sat at layer-local time 0 — the clip's first frame, where the first key of most ramps lives. The
 * finders return the KEYFRAME (always truthy when present), never its `timeSeconds` (0 is falsy and
 * a legitimate hit). See project-tracker/editor.md v1.
 */

import type { TimelineKeyframeV2, TimelineLayer } from "@orreris/shared";
import { findKeyframeIn, findLayerPropertyKeyframe, findTransformKeyframe } from "./keyframeUtils";

let failures = 0;
function check(name: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`  ok  ${name}${detail ? ` (${detail})` : ""}`);
    return;
  }
  failures += 1;
  console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
}

function key(property: string, timeSeconds: number, value: number): TimelineKeyframeV2 {
  return {
    id: `kf_${property}_${timeSeconds}`,
    target: { scope: "layer", property },
    timeSeconds,
    value,
    interpolation: "linear",
    temporal: {}
  };
}

/** A clip that does NOT start at 0 — keyframe times are layer-local, so the first key is still t=0. */
function layerWith(animations: TimelineKeyframeV2[]): TimelineLayer {
  return {
    id: "layer_1",
    type: "image",
    name: "Layer",
    startSeconds: 5,
    durationSeconds: 4,
    effects: [],
    keyframes: [],
    animations
  } as unknown as TimelineLayer;
}

console.log("findKeyframeIn — the shared prev/next lookup");
{
  const keys = [key("graphicDuration", 0, 0.3), key("graphicDuration", 3, 4)];
  const previous = findKeyframeIn(keys, 3, -1);
  const next = findKeyframeIn(keys, 0, 1);

  // THE REGRESSION: a key at layer-local 0 is a real hit. Returning `0` made `Boolean(t)` false, so
  // the "<" button was disabled and you could never navigate back to the first key of a ramp.
  check("finds the previous keyframe sitting at layer-local t=0", previous?.timeSeconds === 0, String(previous?.timeSeconds));
  check("that keyframe is TRUTHY (the check every caller reaches for)", Boolean(previous));
  check("the old time-returning API would have been falsy here", !previous?.timeSeconds);

  check("finds the next keyframe", next?.timeSeconds === 3, String(next?.timeSeconds));
  check("no previous keyframe before the first", findKeyframeIn(keys, 0, -1) === undefined);
  check("no next keyframe after the last", findKeyframeIn(keys, 3, 1) === undefined);

  // Strictly-before / strictly-after: the key AT the playhead is neither prev nor next (the diamond
  // owns it), and the tolerance window must not let it leak into navigation.
  check("the key at the playhead is not its own 'previous'", findKeyframeIn(keys, 0.01, -1) === undefined);
  check("the key at the playhead is not its own 'next'", findKeyframeIn(keys, 2.99, 1) === undefined);
}

console.log("\nthe panel-facing finders (layer property + transform)");
{
  const layer = layerWith([
    key("graphicProgress", 0, 0),
    key("graphicProgress", 2, 0.5),
    key("transform.opacity", 0, 100)
  ]);

  const previousProgress = findLayerPropertyKeyframe(layer, "graphicProgress", 2, -1);
  check("Graphic panel: '<' from t=2 reaches the key at 0", Boolean(previousProgress) && previousProgress?.timeSeconds === 0);

  const previousOpacity = findTransformKeyframe(layer, "transform.opacity", 2, -1);
  check("Transform panel: '<' reaches the opacity key at 0", Boolean(previousOpacity) && previousOpacity?.timeSeconds === 0);

  // Property isolation: an opacity key must not answer a graphicProgress lookup.
  check("finders don't cross properties", findLayerPropertyKeyframe(layer, "graphicProgress", 2, 1) === undefined);
  check("un-keyframed property has no neighbours", findTransformKeyframe(layer, "transform.scale", 2, -1) === undefined);
}

console.log(failures === 0 ? "\nAll keyframe navigation checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
