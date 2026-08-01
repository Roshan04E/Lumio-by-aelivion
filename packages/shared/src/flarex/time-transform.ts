/**
 * Flarex evaluation-context TIME TRANSFORM (ADR-011) — the static, graph-level half of TimeSpeed.
 *
 * `compile-flarex.ts` retimes everything it EVALUATES: animated params, generators, nested graphs.
 * It cannot retime video, because a MediaIn's picture does not come from the compiler at all — the
 * caller decodes it and hands the compiler a finished draw through `resolveSourceDraw`, positioned by
 * the timeline playhead. A decoder sits at ONE time per frame, so "the same source at a different t"
 * is a different decode, decided before compiling begins.
 *
 * So the media half is resolved HERE, statically, and applied to the virtual loader that backs each
 * MediaIn (`virtual-layers.ts`) as a plain `speed` + shifted `sourceInSeconds` — the SAME
 * `getLayerSpeed`/`layerSourceTimeSeconds` path the inspector's proven speed ramp already runs
 * through in preview, local export and the cloud worker. No second retime implementation to drift
 * from the first.
 *
 * WHY STATIC (and why `speed`/`offset` are not keyframeable): a loader carries one rate, resolved
 * before any frame is drawn. An animated TimeSpeed would retime the parameters (compiler, per-frame)
 * and the picture (loader, resolved once) by different amounts — picture and grade sliding apart, the
 * silent-divergence class ADR-007 exists to make impossible. A ramped retime is expressible on this
 * same substrate (`speedKeyframes` + `integrateRamp`, both halves integrating the same curve), but it
 * is a separate slice; until then the params are constants and the two halves agree exactly.
 */

import { getLayerSpeedAt, getSpeedRamp, layerSourceTimeSeconds } from "../timeline";
import type { SpeedKeyframe, TimelineLayer } from "../types";
import type { FlarexComp, FlarexNode } from "./types";

/**
 * `t_input = t_output * speed + offset` — an AFFINE map, which is what makes the media half
 * expressible as a loader rate at all. Composition of affine maps is affine, so an arbitrarily deep
 * nest of TimeSpeeds collapses to one `(speed, offset)` pair with no loss.
 */
export interface FlarexTimeTransform {
  speed: number;
  offset: number;
}

export const FLAREX_IDENTITY_TIME_TRANSFORM: FlarexTimeTransform = { speed: 1, offset: 0 };

export function isIdentityFlarexTimeTransform(t: FlarexTimeTransform): boolean {
  return t.speed === 1 && t.offset === 0;
}

/**
 * Compose an OUTER transform (already accumulated on the way up from the output) with the INNER one a
 * TimeSpeed applies to its own inputs.
 *
 * outer(t) = t·So + Oo, and the inner node then evaluates its input at outer(t)·Si + Oi, so
 * composed = (t·So + Oo)·Si + Oi = t·(So·Si) + (Oo·Si + Oi). Order is NOT symmetric — the offset
 * picks up the inner speed, not the outer one.
 */
export function composeFlarexTimeTransform(outer: FlarexTimeTransform, inner: FlarexTimeTransform): FlarexTimeTransform {
  return { speed: outer.speed * inner.speed, offset: outer.offset * inner.speed + inner.offset };
}

/** A finite number param, or the fallback — mirrors the compiler's `num()` for the STATIC case. */
function staticNum(node: FlarexNode, key: string, fallback: number): number {
  const raw = node.params[key];
  return typeof raw === "number" && Number.isFinite(raw) ? raw : fallback;
}

/** The transform one TimeSpeed node applies to its input, read from static params. */
export function flarexNodeTimeTransform(node: FlarexNode): FlarexTimeTransform {
  if (node.type !== "timeSpeed" || !node.enabled) return FLAREX_IDENTITY_TIME_TRANSFORM;
  const speed = staticNum(node, "speed", 1);
  const offset = staticNum(node, "offset", 0);
  // A zero rate is a FREEZE, not a degenerate loader: it would make the source-remaining division
  // below infinite and `getLayerSpeed` normalize it back to 1 (i.e. silently NOT frozen). Treat it as
  // identity here and leave freezing to MediaIn's own `freeze` knob, which the renderers already
  // implement. Non-finite values are malformed params, not intent.
  if (!Number.isFinite(speed) || speed === 0 || !Number.isFinite(offset)) return FLAREX_IDENTITY_TIME_TRANSFORM;
  return { speed, offset };
}

export interface FlarexMediaInRetime {
  transform: FlarexTimeTransform;
  /**
   * The node is reached by two paths carrying DIFFERENT transforms (a MediaIn feeding a retimed
   * branch and an un-retimed one). One loader carries one rate, so only `transform` is honoured — the
   * flag exists so callers/tests can see the compromise instead of inferring it from a wrong frame.
   */
  conflicting: boolean;
}

/**
 * Every MediaIn's accumulated retime, resolved by walking BACKWARDS from the comp's output.
 *
 * Roots mirror the compiler's own choice (`compile-flarex.ts`): the persisted view dot when set —
 * it re-roots preview AND export, so the loaders must follow it — then MediaOut, which the compiler
 * falls back to. First assignment wins, so a node reachable from both keeps the MediaOut answer only
 * if the view dot did not reach it first.
 *
 * NOT resolved: `ctx.previewRootNodeId`, the RUNTIME re-root used for node thumbnails. It is chosen
 * per-pass, after the loaders exist, so a thumbnail of a node upstream of a TimeSpeed shows that
 * node's picture at the retimed rate. Thumbnails only; the viewer and both exports are exact.
 *
 * Nodes not reachable from any root (a disconnected branch mid-edit) are absent from the map and read
 * as identity — the same picture they show today.
 */
export function resolveFlarexMediaInRetimes(
  comp: FlarexComp,
  previewRootNodeId?: string | undefined,
): Map<string, FlarexMediaInRetime> {
  const out = new Map<string, FlarexMediaInRetime>();
  const nodes = comp.nodes;
  // Inputs per node, in edge order — the compiler's `edgeInto` is keyed by socket and keeps one edge
  // per socket; here we want every incoming edge, since a retime reaches a MediaIn through whichever
  // socket happens to carry it.
  const incoming = new Map<string, string[]>();
  for (const edge of comp.edges) {
    if (!nodes[edge.from.nodeId] || !nodes[edge.to.nodeId]) continue;
    const list = incoming.get(edge.to.nodeId);
    if (list) list.push(edge.from.nodeId);
    else incoming.set(edge.to.nodeId, [edge.from.nodeId]);
  }

  const visit = (nodeId: string, transform: FlarexTimeTransform, seen: Set<string>): void => {
    const node = nodes[nodeId];
    if (!node || seen.has(nodeId)) return; // cycle guard: a malformed graph must not hang the walk
    if (node.type === "mediaIn") {
      const existing = out.get(nodeId);
      if (!existing) out.set(nodeId, { transform, conflicting: false });
      else if (existing.transform.speed !== transform.speed || existing.transform.offset !== transform.offset) {
        existing.conflicting = true;
      }
      return; // a MediaIn has no image input to carry the transform further
    }
    const next =
      node.type === "timeSpeed" && node.enabled
        ? composeFlarexTimeTransform(transform, flarexNodeTimeTransform(node))
        : transform;
    seen.add(nodeId);
    for (const from of incoming.get(nodeId) ?? []) visit(from, next, seen);
    seen.delete(nodeId);
  };

  // Preview root (ADR-012 §0.5, slice S1.2): a node being INSPECTED still needs its upstream loaders
  // retimed, or the viewer shows the right node at the wrong moment. But the root comes from the
  // runtime, not from the persisted `comp.previewNodeId` — a viewing affordance must not change what
  // any renderer resolves. Export passes nothing here and walks from MediaOut alone.
  const previewRoot = previewRootNodeId ? nodes[previewRootNodeId] : undefined;
  if (previewRoot && previewRoot.type !== "mediaOut") visit(previewRoot.id, FLAREX_IDENTITY_TIME_TRANSFORM, new Set());
  for (const node of Object.values(nodes)) {
    if (node.type === "mediaOut") visit(node.id, FLAREX_IDENTITY_TIME_TRANSFORM, new Set());
  }
  return out;
}

/**
 * Rewrite a loader's source-time mapping under a retime.
 *
 * A loader maps `sourceTime = sourceIn + local·speed`. Wanted: the mapping evaluated at the
 * transformed local time, `sourceIn + (local·S + O)·speed`. Expanding gives a loader with
 * `speed' = speed·S` and `sourceIn' = sourceIn + O·speed` — still one constant rate, so nothing
 * downstream of `getLayerSpeed` needs to know a retime happened.
 *
 * `remainingSeconds` is how long the loader stays ACTIVE in comp-local seconds. Slowing a source down
 * makes it last longer (0.5× ⇒ twice the wall-clock) and speeding it up runs it out early, which is
 * the whole reason this can't be left at the un-retimed duration: the loader would go "ended" (and
 * the MediaIn transparent) while there was still footage to show.
 */
export function applyRetimeToLoaderTiming(
  sourceInSeconds: number,
  speed: number,
  transform: FlarexTimeTransform,
  sourceDurationSeconds: number | undefined
): { sourceInSeconds: number; speed: number; remainingSeconds: number } {
  const nextSpeed = speed * transform.speed;
  const nextIn = sourceInSeconds + transform.offset * speed;
  if (sourceDurationSeconds == null || !Number.isFinite(sourceDurationSeconds)) {
    return { sourceInSeconds: nextIn, speed: nextSpeed, remainingSeconds: Infinity };
  }
  // Forward playback runs out at the source's END; reverse playback runs out at its START (source
  // time counts DOWN from the in-point). Both measured in comp-local seconds, hence the |rate|.
  const runway = nextSpeed > 0 ? sourceDurationSeconds - nextIn : nextIn;
  return { sourceInSeconds: nextIn, speed: nextSpeed, remainingSeconds: Math.max(0, runway / Math.abs(nextSpeed)) };
}

/**
 * Compose a retime with a host clip that already carries a SPEED RAMP (the inspector's).
 *
 * The constant-rate rewrite above cannot express this: the result is a ramp, not a rate. But it is
 * still an EXACT ramp, because the retime is affine. The composed rate is
 *   r(L) = S · hostRate(L·S + O)
 * and the host's own breakpoint at host-local τ lands at composed-local (τ − O)/S with value v·S.
 * Between breakpoints the host curve is linear (or a bezier) in host-local time and L ↦ host-local is
 * affine, so linearity — and the handles, which are FRACTIONS of each segment's span and value delta,
 * both of which scale together — survive unchanged.
 *
 * FORWARD RETIMES ONLY (`transform.speed > 0`). A negative rate reverses the traversal, which flips
 * every segment's direction and so requires swapping and mirroring each point's in/out handles;
 * reversing an already-ramped clip from inside a comp is exotic enough that the caller declines to
 * promote instead (`null` here), leaving the picture un-retimed rather than subtly wrong.
 *
 * Returns null when the host has no ramp (the constant path handles it) or the retime reverses.
 */
export function composeRetimeWithSpeedRamp(
  host: Pick<TimelineLayer, "speed" | "speedKeyframes" | "sourceInSeconds">,
  transform: FlarexTimeTransform
): { speedKeyframes: SpeedKeyframe[]; sourceInSeconds: number } | null {
  const ramp = getSpeedRamp(host);
  if (!ramp || transform.speed <= 0) return null;
  const { speed: S, offset: O } = transform;
  const mapped: SpeedKeyframe[] = [];
  for (const point of ramp) {
    const local = (point.timeSeconds - O) / S;
    if (local <= 0) continue; // before the composed clip starts — the L=0 point below covers this span
    mapped.push({ ...point, timeSeconds: local, value: point.value * S });
  }
  // The composed ramp must be anchored at L=0 with the rate actually in force there; without it, the
  // edge-hold before the first point would replay a rate from the middle of the host ramp.
  mapped.unshift({ id: `${ramp[0]!.id}__retime0`, timeSeconds: 0, value: getLayerSpeedAt(host, O) * S });
  // The loader starts wherever the host clip HAD reached at host-local time O, which for a ramp is the
  // integral up to O — exposed as the already-public source-time mapping so this needs no integrator
  // of its own.
  return { speedKeyframes: mapped, sourceInSeconds: layerSourceTimeSeconds(host, O) };
}
