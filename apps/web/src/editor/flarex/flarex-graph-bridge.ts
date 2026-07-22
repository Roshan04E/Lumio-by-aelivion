/**
 * Bridge: present ONE Flarex node's keyframeable params to the SHARED graph editor as a synthetic
 * `TimelineLayer`, then translate the editor's edits back onto the comp. This is what lets the exact
 * same GraphEditor (curves + dope-sheet, bezier handles, snapping, undo) drive Flarex node
 * animation with zero changes to its curve engine — the effect-param read/eval/write helpers operate
 * on the synthetic layer, and we map `{scope:"effect"}` ↔ `{scope:"flarexNode"}` at the seam.
 *
 * The synthetic layer's `effects[0].id` is the node id, so `getEffectParamBaseValue`/
 * `evaluateTimelineEffectParam`/`getEffectParamKeyframes` all resolve against the node. Times are
 * comp-local (same convention `compileFlarexComp` samples at); the layer starts at 0.
 */

import type { FlarexComp, FlarexNode, TimelineKeyframeV2, TimelineLayer, TimelineTransform } from "@orreris/shared";
import { getFlarexNodeDefinition } from "@orreris/shared";
import { flarexNodeGraphTargets } from "./flarex-param-meta";
import type { GraphTarget } from "../inspector/keyframeUtils";

// Identity transform for the synthetic layer — never evaluated (all targets are effect-kind), but
// the TimelineLayer type requires it.
const IDENTITY_TRANSFORM: TimelineTransform = { position: { x: 0, y: 0 }, scale: 1, rotation: 0, opacity: 100 };

function nodeLabel(node: FlarexNode): string {
  const base = getFlarexNodeDefinition(node.type).label;
  return node.label ? `${base} — ${node.label}` : base;
}

/** Build the synthetic layer + its graph targets for `node` (targets = its keyframeable params). */
export function buildFlarexGraphLayer(
  comp: FlarexComp,
  node: FlarexNode,
  durationSeconds: number,
  /** Host clip start (absolute). Set so the graph's playback-clock playhead maps clock→comp-local
   *  time as `clock − startSeconds`; keyframe times stay comp-local (0-based) on the axis. */
  startSeconds = 0
): { layer: TimelineLayer; targets: GraphTarget[] } {
  // Node keyframes → effect-scoped keyframes on the synthetic layer (effectId = node id).
  const animations: TimelineKeyframeV2[] = comp.animations
    .filter((kf) => kf.target.scope === "flarexNode" && kf.target.effectId === node.id)
    .map((kf) => ({ ...kf, target: { scope: "effect" as const, effectId: node.id, property: kf.target.property } }));

  const numericParams: Record<string, number> = {};
  for (const [key, value] of Object.entries(node.params)) {
    if (typeof value === "number") numericParams[key] = value;
  }

  const layer: TimelineLayer = {
    id: `flarexnode_${node.id}`,
    trackId: "flarex",
    type: "video",
    name: nodeLabel(node),
    startSeconds,
    durationSeconds: Math.max(0.1, durationSeconds),
    transform: IDENTITY_TRANSFORM,
    // The effect `type` is cosmetic here — the graph reads params by key (targets are supplied
    // explicitly via flarexNodeGraphTargets), never by looking the effect type up in the registry.
    effects: [{ id: node.id, type: "blur", name: node.type, enabled: node.enabled, intensity: 1, params: numericParams }],
    keyframes: [],
    animations,
  };
  return { layer, targets: flarexNodeGraphTargets(node) };
}

/**
 * Translate a graph-editor edit (a new synthetic layer) back onto the comp: remap this node's
 * effect-scoped keyframes to `flarexNode` scope (preserving every OTHER node's animations), and push
 * numeric base-param edits back onto `node.params`.
 */
export function applyFlarexGraphLayer(comp: FlarexComp, node: FlarexNode, nextLayer: TimelineLayer): FlarexComp {
  const remapped: TimelineKeyframeV2[] = (nextLayer.animations ?? [])
    .filter((kf) => kf.target.scope === "effect" && kf.target.effectId === node.id)
    .map((kf) => ({ ...kf, target: { scope: "flarexNode" as const, effectId: node.id, property: kf.target.property } }));
  const others = comp.animations.filter(
    (kf) => !(kf.target.scope === "flarexNode" && kf.target.effectId === node.id)
  );

  const nextParams = { ...node.params };
  const effect = nextLayer.effects.find((e) => e.id === node.id);
  if (effect?.params) {
    for (const [key, value] of Object.entries(effect.params)) {
      if (typeof value === "number") nextParams[key] = value;
    }
  }

  return {
    ...comp,
    animations: [...others, ...remapped].sort((a, b) => a.timeSeconds - b.timeSeconds),
    nodes: { ...comp.nodes, [node.id]: { ...node, params: nextParams } },
  };
}
