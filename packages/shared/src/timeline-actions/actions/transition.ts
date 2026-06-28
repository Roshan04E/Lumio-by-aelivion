import { z } from "zod";
import type { TimelineKeyframeV2, TransitionDirection, TransitionKind, TransitionSpec } from "../../types";
import { actionResult, runMutation } from "../patches";
import { assertLayerExists } from "../validation";
import type { TimelineActionDefinition } from "../types";
import { locateLayer } from "./shared";

/**
 * Transitions are realised as `_transition_`-tagged opacity/transform keyframes (V2 animations) for
 * the dissolve/fade/slide/push/zoom kinds — so the existing animation evaluator and all three
 * renderers drive them with no renderer change and they stay fully editable. The `wipe`/`iris` kinds
 * carry no keyframes: they are GPU reveals driven by the layer's `transitionIn` spec + the shared
 * `getCompositionTransition` progress. `dip` is a transient solid-colour layer inserted at the cut
 * (handled by the editor's junction engine, not here). Transition keyframes are tagged with a
 * `_transition_` id marker — and an `in`/`out` substring per side — so removal finds exactly them.
 */

export const TRANSITION_MARKER = "_transition_";

/** Re-export for callers that import the kind from the action module (legacy import site). */
export type { TransitionKind, TransitionSpec } from "../../types";

type TransformProperty =
  | "transform.opacity"
  | "transform.position.x"
  | "transform.position.y"
  | "transform.scale";

function tKey(
  layerId: string,
  suffix: string,
  timeSeconds: number,
  value: number,
  property: TransformProperty = "transform.opacity"
): TimelineKeyframeV2 {
  return {
    id: `${layerId}${TRANSITION_MARKER}${suffix}`,
    target: { scope: "layer", property },
    timeSeconds: Math.max(0, timeSeconds),
    value,
    interpolation: "easeInOut",
    temporal: {}
  };
}

/**
 * Pure builder for a layer's transition opacity keyframes (the edge fades + the simple
 * cross-dissolve). Returns the layer's full next `animations` array; existing keyframes for the SAME
 * direction are replaced (a fade-in and fade-out coexist; crossDissolve owns both directions, so it
 * clears all transition keyframes). Kept for the Effects-tab single-clip fade in/out path.
 */
export function buildTransitionKeyframes(
  layer: { id: string; durationSeconds: number; animations?: TimelineKeyframeV2[] | undefined },
  kind: "fadeIn" | "fadeOut" | "crossDissolve",
  durationSeconds?: number
): TimelineKeyframeV2[] {
  const fade = Math.min(durationSeconds ?? 0.5, layer.durationSeconds / 2);
  const end = layer.durationSeconds;
  const fresh: TimelineKeyframeV2[] = [];
  if (kind === "fadeIn" || kind === "crossDissolve") {
    fresh.push(tKey(layer.id, "in_0", 0, 0), tKey(layer.id, "in_1", fade, 100));
  }
  if (kind === "fadeOut" || kind === "crossDissolve") {
    fresh.push(tKey(layer.id, "out_0", end - fade, 100), tKey(layer.id, "out_1", end, 0));
  }
  const directionMarkers =
    kind === "crossDissolve"
      ? [TRANSITION_MARKER]
      : [`${TRANSITION_MARKER}${kind === "fadeIn" ? "in" : "out"}`];
  const kept = (layer.animations ?? []).filter((item) => !directionMarkers.some((marker) => item.id.includes(marker)));
  return [...kept, ...fresh];
}

/** Off-frame center offset (percent of comp) for a slide/push direction; the incoming clip starts here. */
function directionOffset(direction: TransitionDirection): { axis: "x" | "y"; delta: number } {
  switch (direction) {
    case "left":
      return { axis: "x", delta: -100 };
    case "right":
      return { axis: "x", delta: 100 };
    case "up":
      return { axis: "y", delta: -100 };
    case "down":
    default:
      return { axis: "y", delta: 100 };
  }
}

const ZOOM_FROM = 1.35; // incoming starts enlarged (covers the frame) and settles to rest.

/**
 * Build the `_transition_`-tagged animation keyframes for a junction transition on ONE clip.
 * `role` selects the incoming clip (the reveal, `in` side) or — for `push` — the outgoing clip (the
 * `out` side that slides away). Opacity kinds fade; slide/push move `transform.position`; zoom scales
 * (+a short opacity fade). `wipe`/`iris` carry no keyframes (GPU reveal) — they only clear this
 * side's stale transition keyframes. Returns the layer's full next `animations` array.
 */
export function buildTransitionAnimations(
  layer: {
    id: string;
    durationSeconds: number;
    transform: { position: { x: number; y: number }; scale: number };
    animations?: TimelineKeyframeV2[] | undefined;
  },
  spec: TransitionSpec,
  role: "incoming" | "outgoing"
): TimelineKeyframeV2[] {
  const side = role === "incoming" ? "in" : "out";
  const sideMarker = `${TRANSITION_MARKER}${side}`;
  const kept = (layer.animations ?? []).filter((item) => !item.id.includes(sideMarker));
  const window = Math.min(spec.durationSeconds, layer.durationSeconds);
  const fresh: TimelineKeyframeV2[] = [];
  // The reveal window is layer-relative: incoming = [0, window]; outgoing (push) = [end-window, end].
  const t0 = role === "incoming" ? 0 : Math.max(0, layer.durationSeconds - window);
  const t1 = role === "incoming" ? window : layer.durationSeconds;
  const id = (s: string) => `${side}_${s}`;

  if (spec.kind === "crossDissolve" && role === "incoming") {
    fresh.push(tKey(layer.id, id("op0"), 0, 0), tKey(layer.id, id("op1"), window, 100));
  } else if (spec.kind === "slide" && role === "incoming") {
    const { axis, delta } = directionOffset(spec.direction ?? "right");
    const base = axis === "x" ? layer.transform.position.x : layer.transform.position.y;
    const prop = axis === "x" ? "transform.position.x" : "transform.position.y";
    fresh.push(tKey(layer.id, id("p0"), t0, base + delta, prop), tKey(layer.id, id("p1"), t1, base, prop));
  } else if (spec.kind === "push") {
    const { axis, delta } = directionOffset(spec.direction ?? "right");
    const base = axis === "x" ? layer.transform.position.x : layer.transform.position.y;
    const prop = axis === "x" ? "transform.position.x" : "transform.position.y";
    if (role === "incoming") {
      // Enters from the offset edge, settles to rest.
      fresh.push(tKey(layer.id, id("p0"), t0, base + delta, prop), tKey(layer.id, id("p1"), t1, base, prop));
    } else {
      // Exits the opposite edge at the same velocity (locked push).
      fresh.push(tKey(layer.id, id("p0"), t0, base, prop), tKey(layer.id, id("p1"), t1, base - delta, prop));
    }
  } else if (spec.kind === "zoom" && role === "incoming") {
    const base = layer.transform.scale || 1;
    const from = (spec.mode ?? "in") === "out" ? base * (1 / ZOOM_FROM) : base * ZOOM_FROM;
    fresh.push(
      tKey(layer.id, id("s0"), 0, from, "transform.scale"),
      tKey(layer.id, id("s1"), window, base, "transform.scale"),
      tKey(layer.id, id("op0"), 0, 0),
      tKey(layer.id, id("op1"), Math.min(window, window * 0.6), 100)
    );
  }
  // wipe / iris: no keyframes — the shader reveal is driven by transitionIn + getCompositionTransition.
  return [...kept, ...fresh];
}

const transitionKinds = [
  "fadeIn",
  "fadeOut",
  "crossDissolve",
  "dip",
  "slide",
  "push",
  "zoom",
  "wipe",
  "iris"
] as const;

const addTransitionSchema = z.object({
  layerId: z.string(),
  kind: z.enum(transitionKinds),
  durationSeconds: z.number().min(0.05).max(10).optional()
});

const addTransition: TimelineActionDefinition<z.infer<typeof addTransitionSchema>> = {
  id: "addTransition",
  name: "Add transition",
  description: "Add a fade in / out / cross dissolve to a clip (as opacity keyframes).",
  category: "transition",
  inputSchema: addTransitionSchema,
  validationRules: (params, ctx) => assertLayerExists(ctx, params.layerId),
  canUndo: true,
  execute: (params, ctx) => {
    const mutation = runMutation(ctx.composition, (draft) => {
      const target = locateLayer(draft, params.layerId)?.layer;
      if (!target) {
        return;
      }
      // The action surface handles the simple per-clip opacity transitions; junction kinds
      // (slide/push/zoom/wipe/iris/dip) are applied through the editor's junction engine.
      const opacityKind = params.kind === "fadeOut" ? "fadeOut" : params.kind === "fadeIn" ? "fadeIn" : "crossDissolve";
      target.animations = buildTransitionKeyframes(target, opacityKind, params.durationSeconds);
    });
    return actionResult(ctx.composition, mutation, `Add ${params.kind} transition`);
  }
};

const removeTransitionSchema = z.object({ layerId: z.string() });

const removeTransition: TimelineActionDefinition<z.infer<typeof removeTransitionSchema>> = {
  id: "removeTransition",
  name: "Remove transition",
  description: "Strip a layer's transition keyframes and its transition spec.",
  category: "transition",
  inputSchema: removeTransitionSchema,
  validationRules: (params, ctx) => assertLayerExists(ctx, params.layerId),
  canUndo: true,
  execute: (params, ctx) => {
    const mutation = runMutation(ctx.composition, (draft) => {
      const layer = locateLayer(draft, params.layerId)?.layer;
      if (layer?.animations) {
        layer.animations = layer.animations.filter((item) => !item.id.includes(TRANSITION_MARKER));
      }
      if (layer) {
        layer.transitionIn = undefined;
      }
    });
    return actionResult(ctx.composition, mutation, `Remove transition`);
  }
};

export const transitionActions = [addTransition, removeTransition];
