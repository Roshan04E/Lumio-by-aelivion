import assert from "node:assert/strict";
import {
  evaluateAnimatedValue,
  evaluateTimelineEffectParam,
  evaluateTimelineTransform,
  migrateTimelineKeyframes,
  type TimelineKeyframe,
  type TimelineKeyframeV2
} from "@orreris/shared";

const oldKeyframes: TimelineKeyframe[] = [
  { id: "old_1", property: "opacity", timeSeconds: 2, value: 0, easing: "linear" },
  { id: "old_2", property: "opacity", timeSeconds: 3, value: 100, easing: "linear" }
];

const migrated = migrateTimelineKeyframes(oldKeyframes, 2);
assert.equal(migrated[0]!.target.property, "transform.opacity");
assert.equal(migrated[0]!.timeSeconds, 0);
assert.equal(migrated[1]!.timeSeconds, 1);

const scaleKeyframes: TimelineKeyframeV2[] = [
  {
    id: "scale_1",
    target: { scope: "layer", property: "transform.scale" },
    timeSeconds: 0,
    value: 1,
    interpolation: "linear",
    temporal: {}
  },
  {
    id: "scale_2",
    target: { scope: "layer", property: "transform.scale" },
    timeSeconds: 2,
    value: 3,
    interpolation: "linear",
    temporal: {}
  }
];

assert.equal(
  evaluateAnimatedValue({
    baseValue: 1,
    keyframes: scaleKeyframes,
    property: "transform.scale",
    timeSeconds: 1
  }),
  2
);

const holdKeyframes: TimelineKeyframeV2[] = [
  { ...scaleKeyframes[0]!, interpolation: "hold" },
  scaleKeyframes[1]!
];
assert.equal(
  evaluateAnimatedValue({
    baseValue: 1,
    keyframes: holdKeyframes,
    property: "transform.scale",
    timeSeconds: 1.9
  }),
  1
);

// Two-sided interpolation contract (2026-07-12, Premiere/AE semantics): easeIn eases the
// ARRIVAL into its keyframe (the segment BEFORE it — progress runs ahead mid-segment,
// then slows into the key); easeOut eases the DEPARTURE from its keyframe (the segment
// AFTER it — progress lags mid-segment). Previously only the outgoing keyframe's
// interpolation shaped a segment, so "Ease In" acted on the wrong side.
const easeInArrival = evaluateAnimatedValue({
  baseValue: 0,
  keyframes: [
    { id: "ease_1", target: { scope: "layer", property: "transform.opacity" }, timeSeconds: 0, value: 0, interpolation: "linear", temporal: {} },
    { id: "ease_2", target: { scope: "layer", property: "transform.opacity" }, timeSeconds: 1, value: 100, interpolation: "easeIn", temporal: {} }
  ],
  property: "transform.opacity",
  timeSeconds: 0.5
});
assert.ok(easeInArrival > 50);

const easeOutDeparture = evaluateAnimatedValue({
  baseValue: 0,
  keyframes: [
    { id: "ease_3", target: { scope: "layer", property: "transform.opacity" }, timeSeconds: 0, value: 0, interpolation: "easeOut", temporal: {} },
    { id: "ease_4", target: { scope: "layer", property: "transform.opacity" }, timeSeconds: 1, value: 100, interpolation: "linear", temporal: {} }
  ],
  property: "transform.opacity",
  timeSeconds: 0.5
});
assert.ok(easeOutDeparture < 50);

const manualBezierValue = evaluateAnimatedValue({
  baseValue: 0,
  keyframes: [
    {
      id: "bezier_1",
      target: { scope: "layer", property: "transform.opacity" },
      timeSeconds: 0,
      value: 0,
      interpolation: "bezier",
      temporal: { out: { dx: 0.85, dy: 0 } }
    },
    {
      id: "bezier_2",
      target: { scope: "layer", property: "transform.opacity" },
      timeSeconds: 1,
      value: 100,
      interpolation: "linear",
      temporal: { in: { dx: -0.15, dy: -1 } }
    }
  ],
  property: "transform.opacity",
  timeSeconds: 0.5
});
assert.ok(manualBezierValue < 35);

const animatedEffectParam = evaluateTimelineEffectParam({
  animations: [
    {
      id: "effect_param_1",
      target: { scope: "effect", effectId: "basic_1", property: "exposure" },
      timeSeconds: 0,
      value: 0,
      interpolation: "linear",
      temporal: {}
    },
    {
      id: "effect_param_2",
      target: { scope: "effect", effectId: "basic_1", property: "exposure" },
      timeSeconds: 2,
      value: 100,
      interpolation: "linear",
      temporal: {}
    }
  ],
  baseValue: 0,
  effectId: "basic_1",
  paramKey: "exposure",
  timeSeconds: 1
});
assert.equal(animatedEffectParam, 50);

const transform = evaluateTimelineTransform({
  transform: {
    position: { x: 50, y: 50 },
    scale: 1,
    rotation: 0,
    opacity: 100
  },
  animations: scaleKeyframes,
  timeSeconds: 1
});
assert.equal(transform.scale, 2);
assert.equal(transform.opacity, 100);

console.log("Animation evaluator contract passed.");
