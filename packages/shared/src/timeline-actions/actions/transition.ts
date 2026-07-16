import { z } from "zod";
import type { TimelineComposition, TimelineKeyframeV2, TimelineLayer, TransitionDirection, TransitionKind, TransitionSpec } from "../../types";
import { getTransition } from "../../color/transitions/registry";
import { flattenTimelineLayers } from "../../timeline";
import { actionResult, runMutation, runReplace } from "../patches";
import { assertLayerExists } from "../validation";
import type { TimelineActionDefinition, ValidationIssue } from "../types";
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
  const end = layer.durationSeconds;
  // A single-direction fade may span up to the WHOLE clip minus any opposing fade (fadeIn +
  // fadeOut ≤ duration) so the ramps never cross. crossDissolve writes both sides, so each keeps
  // the half-duration cap.
  const requested = durationSeconds ?? 0.5;
  const opposingFade = (marker: string, atEnd: boolean): number => {
    const key = (layer.animations ?? []).find((item) => item.id.includes(marker));
    if (!key) return 0;
    return Math.max(0, atEnd ? end - key.timeSeconds : key.timeSeconds);
  };
  const fade =
    kind === "crossDissolve"
      ? Math.min(requested, end / 2)
      : kind === "fadeIn"
        ? Math.min(requested, Math.max(0, end - opposingFade(`${TRANSITION_MARKER}out_0`, true)))
        : Math.min(requested, Math.max(0, end - opposingFade(`${TRANSITION_MARKER}in_1`, false)));
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
  description: "Strip a clip's transition keyframes and its transition spec.",
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

/* ------------------------------------------------------------------------------------------------
 * Junction transitions — the professional, handle-based model shared by the editor UI and the
 * action surface. Lifted verbatim from the editor's junction engine (EditorPage) so the timeline
 * strip, the transition gallery/popover, AND AI actions all mutate the cut through ONE code path.
 * ---------------------------------------------------------------------------------------------- */

export const DEFAULT_CROSS_DISSOLVE_SECONDS = 0.5;
/** Legacy shape-based dip implementation's overlay track — removal still cleans it up. */
const OVERLAY_TRACK_ID = "track_transitions";

/** A junction transition kind is anything the GPU transition engine registers (excludes edge fades). */
export function isJunctionTransitionKind(kind: TransitionKind): boolean {
  return getTransition(kind) !== undefined;
}

function dipLayerId(leftId: string, rightId: string): string {
  return `${leftId}__dip__${rightId}`;
}

/** The clip immediately before `rightId` on the same track that touches/overlaps its start, or null. */
export function findLeftNeighbor(composition: TimelineComposition, rightId: string): TimelineLayer | null {
  const track = composition.tracks.find((item) => item.layers.some((layer) => layer.id === rightId));
  const right = track?.layers.find((layer) => layer.id === rightId);
  if (!track || !right) {
    return null;
  }
  const epsilon = 1 / (Math.round(composition.fps) || 30) + 1e-3;
  let best: TimelineLayer | null = null;
  for (const layer of track.layers) {
    if (layer.id === rightId || layer.startSeconds >= right.startSeconds) {
      continue;
    }
    // Touching or overlapping the cut, and the nearest such clip to the left.
    if (layer.startSeconds + layer.durationSeconds >= right.startSeconds - epsilon) {
      if (!best || layer.startSeconds > best.startSeconds) {
        best = layer;
      }
    }
  }
  return best;
}

/** The clip immediately after `leftId` on the same track that touches/overlaps its end, or null. */
export function findRightNeighbor(composition: TimelineComposition, leftId: string): TimelineLayer | null {
  const track = composition.tracks.find((item) => item.layers.some((layer) => layer.id === leftId));
  const left = track?.layers.find((layer) => layer.id === leftId);
  if (!track || !left) {
    return null;
  }
  const epsilon = 1 / (Math.round(composition.fps) || 30) + 1e-3;
  const cut = left.startSeconds + left.durationSeconds;
  let best: TimelineLayer | null = null;
  for (const layer of track.layers) {
    if (layer.id === leftId || layer.startSeconds <= left.startSeconds) {
      continue;
    }
    if (layer.startSeconds <= cut + epsilon) {
      if (!best || layer.startSeconds < best.startSeconds) {
        best = layer;
      }
    }
  }
  return best;
}

/** The cut a clip participates in (preferring its right cut), for "add transition to this clip" flows. */
export function findTransitionCutForClip(
  composition: TimelineComposition,
  clipId: string
): { left: TimelineLayer; right: TimelineLayer; side: "left" | "right" } | null {
  const clip = flattenTimelineLayers(composition).find((layer) => layer.id === clipId);
  if (!clip || clip.type === "audio") {
    return null;
  }
  const right = findRightNeighbor(composition, clipId);
  if (right) {
    return { left: clip, right, side: "right" };
  }
  const left = findLeftNeighbor(composition, clipId);
  if (left) {
    return { left, right: clip, side: "left" };
  }
  return null;
}

/**
 * Apply (or replace) a junction transition between two touching same-track clips — the professional,
 * handle-based model: a transition is **pure metadata** on the cut. NOTHING on the timeline moves or
 * changes length. R3: the transition spans `[cut - D/2, cut + D/2]` (cut = incoming start, centered on
 * it — see `getActiveTransition`'s doc): the incoming clip reveals in (opacity for dissolve, transform
 * keyframes for slide/zoom, or the shader spec for wipe/iris/dip) while playing its own head handle for
 * the first half, and the renderers render the OUTGOING clip into the second half from its tail handle
 * (clamped to the asset → real handle frames, or a held/repeated frame when the clip has no spare media —
 * exactly like Premiere). The `transitionIn` spec on the incoming clip is the single source of truth;
 * resizing only rewrites its `durationSeconds`, so clip lengths/positions never change.
 */
export function applyJunctionTransition(
  composition: TimelineComposition,
  leftId: string,
  rightId: string,
  spec: TransitionSpec
): TimelineComposition {
  if (!isJunctionTransitionKind(spec.kind)) {
    return composition;
  }
  const track = composition.tracks.find(
    (item) => item.layers.some((layer) => layer.id === leftId) && item.layers.some((layer) => layer.id === rightId)
  );
  const left = track?.layers.find((layer) => layer.id === leftId);
  const right = track?.layers.find((layer) => layer.id === rightId);
  if (!track || !left || !right) {
    return composition;
  }
  const frameStep = 1 / (Math.round(composition.fps) || 30);
  // The window can't exceed either clip (so the reveal + the outgoing post-roll stay within the cut).
  const duration = Math.max(frameStep, Math.min(spec.durationSeconds, left.durationSeconds, right.durationSeconds));
  const appliedSpec: TransitionSpec = { ...spec, durationSeconds: duration };
  return {
    ...composition,
    tracks: composition.tracks.map((item) => {
      if (item.id !== track.id) {
        return item;
      }
      return {
        ...item,
        layers: item.layers.map((layer) => {
          // Outgoing clip is untouched (no extend) — only clear any stale fade-out keyframes.
          if (layer.id === leftId) {
            const cleaned = (layer.animations ?? []).filter((kf) => !kf.id.includes(`${TRANSITION_MARKER}out`));
            return cleaned.length === (layer.animations?.length ?? 0) ? layer : { ...layer, animations: cleaned };
          }
          // Incoming clip carries the spec. The unified GPU engine drives the entire reveal from the
          // spec + time (no per-clip keyframes), so strip any stale `_transition_` keyframes from the
          // legacy keyframe path so they can't double-apply once the window ends.
          if (layer.id === rightId) {
            const cleaned = (layer.animations ?? []).filter((kf) => !kf.id.includes(TRANSITION_MARKER));
            return { ...layer, transitionIn: appliedSpec, animations: cleaned };
          }
          return layer;
        })
      };
    })
  };
}

/**
 * Remove a junction transition: clear the incoming clip's spec + reveal keyframes and any stale fade-out
 * on the outgoing clip. Metadata-only — no clip length/position changes. Also cleans up any legacy
 * shape-based dip overlay layer/track from the earlier implementation.
 */
export function removeJunctionTransition(composition: TimelineComposition, leftId: string, rightId: string): TimelineComposition {
  const track = composition.tracks.find(
    (item) => item.layers.some((layer) => layer.id === leftId) && item.layers.some((layer) => layer.id === rightId)
  );
  if (!track) {
    return composition;
  }
  const legacyDipId = dipLayerId(leftId, rightId);
  const tracks = composition.tracks
    .map((item) => {
      if (item.id === track.id) {
        return {
          ...item,
          layers: item.layers.map((layer) => {
            if (layer.id === leftId) {
              return { ...layer, animations: (layer.animations ?? []).filter((kf) => !kf.id.includes(`${TRANSITION_MARKER}out`)) };
            }
            if (layer.id === rightId) {
              return {
                ...layer,
                transitionIn: undefined,
                animations: (layer.animations ?? []).filter((kf) => !kf.id.includes(`${TRANSITION_MARKER}in`))
              };
            }
            return layer;
          })
        };
      }
      // Legacy cleanup: drop any shape-based dip layer for this pair from the old overlay track.
      if (item.id === OVERLAY_TRACK_ID) {
        return { ...item, layers: item.layers.filter((layer) => layer.id !== legacyDipId) };
      }
      return item;
    })
    .filter((item) => item.id !== OVERLAY_TRACK_ID || item.layers.length > 0);

  return { ...composition, tracks };
}

/** Both layers exist, share a track, and `rightLayerId` is the touching clip after `leftLayerId`. */
function assertJunctionPair(params: { leftLayerId: string; rightLayerId: string }, composition: TimelineComposition): ValidationIssue[] {
  const issues: ValidationIssue[] = [
    ...assertLayerExists({ composition, nowSeconds: 0, selection: [] }, params.leftLayerId, "leftLayerId"),
    ...assertLayerExists({ composition, nowSeconds: 0, selection: [] }, params.rightLayerId, "rightLayerId")
  ];
  if (issues.length > 0) {
    return issues;
  }
  const right = findRightNeighbor(composition, params.leftLayerId);
  if (!right || right.id !== params.rightLayerId) {
    issues.push({
      code: "not_a_junction",
      message: `Layers "${params.leftLayerId}" and "${params.rightLayerId}" are not touching neighbors on the same track`,
      path: "rightLayerId"
    });
  }
  return issues;
}

const setJunctionTransitionSchema = z.object({
  leftLayerId: z.string(),
  rightLayerId: z.string(),
  /** Open union — any kind the transition registry knows, including registered plugin transitions. */
  kind: z.string(),
  durationSeconds: z.number().min(0.01).max(10).optional(),
  direction: z.enum(["left", "right", "up", "down"]).optional(),
  mode: z.enum(["in", "out"]).optional(),
  softness: z.number().min(0).max(1).optional(),
  color: z.string().optional(),
  params: z.record(z.union([z.number(), z.array(z.number()), z.boolean()])).optional()
});

const setJunctionTransition: TimelineActionDefinition<z.infer<typeof setJunctionTransitionSchema>> = {
  id: "setJunctionTransition",
  name: "Set junction transition",
  description:
    "Apply or replace a GPU junction transition (crossDissolve, wipe, push, whipPan, ...) on the cut between two touching clips. " +
    "Metadata-only: nothing moves or changes length. Plugin transition kinds must already be registered in the project.",
  category: "transition",
  inputSchema: setJunctionTransitionSchema,
  validationRules: (params, ctx) => {
    const issues = assertJunctionPair(params, ctx.composition);
    if (!isJunctionTransitionKind(params.kind)) {
      issues.push({ code: "unknown_transition_kind", message: `Unknown transition kind "${params.kind}"`, path: "kind" });
    }
    return issues;
  },
  canUndo: true,
  execute: (params, ctx) => {
    const spec: TransitionSpec = {
      kind: params.kind,
      durationSeconds:
        params.durationSeconds ?? getTransition(params.kind)?.defaultDurationSeconds ?? DEFAULT_CROSS_DISSOLVE_SECONDS,
      direction: params.direction,
      mode: params.mode,
      softness: params.softness,
      color: params.color,
      params: params.params
    };
    const mutation = runReplace(ctx.composition, (before) =>
      applyJunctionTransition(before, params.leftLayerId, params.rightLayerId, spec)
    );
    return actionResult(ctx.composition, mutation, `Set ${params.kind} transition on the cut`);
  }
};

const removeJunctionTransitionSchema = z.object({ leftLayerId: z.string(), rightLayerId: z.string() });

const removeJunctionTransitionAction: TimelineActionDefinition<z.infer<typeof removeJunctionTransitionSchema>> = {
  id: "removeJunctionTransition",
  name: "Remove junction transition",
  description: "Remove the junction transition from the cut between two touching clips (metadata-only).",
  category: "transition",
  inputSchema: removeJunctionTransitionSchema,
  validationRules: (params, ctx) => assertJunctionPair(params, ctx.composition),
  canUndo: true,
  execute: (params, ctx) => {
    const mutation = runReplace(ctx.composition, (before) =>
      removeJunctionTransition(before, params.leftLayerId, params.rightLayerId)
    );
    return actionResult(ctx.composition, mutation, "Remove junction transition");
  }
};

export const transitionActions = [addTransition, removeTransition, setJunctionTransition, removeJunctionTransitionAction];
