import { TimelineActionRegistry } from "../registry";
import type { TimelineActionDefinition } from "../types";
import { clipActions } from "./clip";
import { effectActions } from "./effect";
import { keyframeActions } from "./keyframe";
import { layerActions } from "./layer";
import { markerActions } from "./marker";
import { maskActions } from "./mask";
import { textActions } from "./text";
import { trackActions } from "./track";
import { transitionActions } from "./transition";

export { buildTransitionAnimations, buildTransitionKeyframes, TRANSITION_MARKER, type TransitionKind, type TransitionSpec } from "./transition";

/** Every built-in timeline action, grouped by file. */
export const allTimelineActions: TimelineActionDefinition<unknown>[] = [
  ...textActions,
  ...layerActions,
  ...clipActions,
  ...effectActions,
  ...keyframeActions,
  ...transitionActions,
  ...trackActions,
  ...maskActions,
  ...markerActions
] as TimelineActionDefinition<unknown>[];

/** Build a registry pre-loaded with all built-in actions (used for tests/isolation). */
export function createTimelineActionRegistry(): TimelineActionRegistry {
  const registry = new TimelineActionRegistry();
  for (const action of allTimelineActions) {
    registry.register(action);
  }
  return registry;
}

/** The shared singleton registry — the one approved gate for timeline mutation. */
export const timelineActionRegistry = createTimelineActionRegistry();
