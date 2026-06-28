import assert from "node:assert/strict";
import {
  evaluateAnimatedValue,
  evaluateTimelineEffectParam,
  evaluateTimelineTransform,
  migrateTimelineKeyframes,
  type TimelineKeyframe,
  type TimelineKeyframeV2
} from "@reelforge/shared";

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

const easeInValue = evaluateAnimatedValue({
  baseValue: 0,
  keyframes: [
    { id: "ease_1", target: { scope: "layer", property: "transform.opacity" }, timeSeconds: 0, value: 0, interpolation: "easeIn", temporal: {} },
    { id: "ease_2", target: { scope: "layer", property: "transform.opacity" }, timeSeconds: 1, value: 100, interpolation: "linear", temporal: {} }
  ],
  property: "transform.opacity",
  timeSeconds: 0.5
});
assert.ok(easeInValue < 50);

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
