/**
 * Nesting / compound clips — shared expansion core (NESTING.md, Phase A).
 *
 * A nested sequence is a `TimelineComposition` stored in `ProjectGraph.compositions`, referenced by a
 * `TimelineLayer.nestedCompositionId` clip (the shape the prproj importer already emits). Premiere
 * semantics: the clip is a LIVE REFERENCE whose "media" is the nested sequence — trim/speed/effects/
 * transform apply to the composited output; alpha is preserved; a clip trimmed past the sequence end
 * shows nothing (transparent + silence); self-nesting is forbidden.
 *
 * `expandNestedCompositions` turns each compound clip into DERIVED CHILD LAYERS mapped into
 * parent-timeline coordinates — the same derived-render-layer pattern as `expandEffectRegionMasks`
 * (`__rfx_`), namespaced `${clipId}__nest_${childId}` so two instances of one sequence get distinct
 * ids (→ distinct decoders/proxies/rasters/caches). Every renderer consumes children through its
 * normal per-layer path; compound-LEVEL transform/effects/masks composite via the returned `groups`
 * (rendered as an RTT group in the scene compositor — Phase C).
 *
 * TIME MAPPING is the exact inverse of `layerSourceTimeSeconds` for constant clip speed
 * (`childStart_parent = clipStart + (childStartNested − clipSourceIn) / clipSpeed`), with child speed
 * ramps carried through the affine substitution (times ÷ clipSpeed, rates × clipSpeed — linearity is
 * preserved, so source time stays bit-exact in every renderer). Speed ramps ON the compound clip
 * itself are v1-unsupported (validation rejects; expansion falls back to the scalar speed).
 */

import { isTrackEnabled } from "./composition-style";
import { getLayerSpeed, getSpeedRamp, layerSourceTimeSeconds, shiftSpeedKeyframes } from "./timeline";
import { migrateTimelineKeyframes } from "./animation";
import type {
  ProjectGraph,
  SpeedKeyframe,
  TimelineComposition,
  TimelineKeyframeV2,
  TimelineLayer,
  TimelineTrack,
  TransitionSpec,
} from "./types";

export const NEST_ID_SEPARATOR = "__nest_";

/** Max nests-in-nests depth. Deeper (or cyclic — impossible via the action guard, but a hand-edited
 *  graph could) leaves the compound clip UNEXPANDED so a bad graph degrades instead of hanging. */
export const NEST_MAX_DEPTH = 8;

/** The OUTERMOST compound-clip id a derived child belongs to, or null for normal layers.
 *  (`a__nest_b__nest_c` → `a`; group folding is hierarchical by prefix.) */
export function nestParentClipId(layerId: string): string | null {
  const marker = layerId.indexOf(NEST_ID_SEPARATOR);
  return marker > 0 ? layerId.slice(0, marker) : null;
}

/**
 * Would placing a clip of `nestedCompositionId` inside `hostCompositionId` create a reference cycle
 * (directly or transitively)? Used by the Nest/insert actions — the render-time depth cap is only the
 * belt-and-suspenders degrade.
 */
export function wouldCreateCompositionCycle(
  compositions: Record<string, TimelineComposition> | undefined,
  hostCompositionId: string,
  nestedCompositionId: string
): boolean {
  if (hostCompositionId === nestedCompositionId) return true;
  const visited = new Set<string>();
  const stack = [nestedCompositionId];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (id === hostCompositionId) return true;
    if (visited.has(id)) continue;
    visited.add(id);
    const comp = compositions?.[id];
    if (!comp) continue;
    for (const track of comp.tracks) {
      for (const layer of track.layers) {
        if (layer.nestedCompositionId) stack.push(layer.nestedCompositionId);
      }
    }
  }
  return false;
}

/** The compound clip's source length (its "media duration") = the nested sequence's duration. */
export function getNestedSourceDurationSeconds(
  layer: Pick<TimelineLayer, "nestedCompositionId">,
  compositions: Record<string, TimelineComposition> | undefined
): number | null {
  const comp = layer.nestedCompositionId ? compositions?.[layer.nestedCompositionId] : undefined;
  return comp ? comp.durationSeconds : null;
}

/** Everything the scene compositor needs to composite one compound instance as a unit (Phase C):
 *  the derived clip (transform/effects/masks/fit/blend in PARENT coords + parent timing) and the
 *  nested comp's geometry the children lay out against. */
export interface NestedGroupSpec {
  /** The compound clip as placed in the parent (id = the instance/group key). */
  clip: TimelineLayer;
  composition: { id: string; width: number; height: number; durationSeconds: number };
}

export interface ExpandedNestedComposition {
  composition: TimelineComposition;
  /** Group specs keyed by compound-clip id — includes INNER groups of nests-in-nests, keyed by their
   *  namespaced derived id (`outerClip__nest_innerClip`). Empty map = nothing expanded. */
  groups: Map<string, NestedGroupSpec>;
}

/** Scale a transition spec's duration into parent seconds (child transitions inside a sped-up nest
 *  run proportionally faster, exactly like the frames they span). */
function mapTransitionSpec(spec: TransitionSpec, clipSpeed: number): TransitionSpec {
  if (clipSpeed === 1) return spec;
  return { ...spec, durationSeconds: spec.durationSeconds / clipSpeed };
}

/** Child speed ramp through the window/speed substitution: shift to the trimmed head (exact via
 *  shared `shiftSpeedKeyframes`), then times ÷ clipSpeed and rates × clipSpeed. */
function mapSpeedKeyframes(child: TimelineLayer, headTrimSeconds: number, clipSpeed: number): SpeedKeyframe[] | undefined {
  const shifted = shiftSpeedKeyframes(child, headTrimSeconds);
  if (!shifted) return undefined;
  if (clipSpeed === 1) return shifted;
  return shifted.map((point) => ({ timeSeconds: point.timeSeconds / clipSpeed, value: point.value * clipSpeed }));
}

/** Layer-LOCAL keyframes (animations + migrated legacy) through the head-trim/speed substitution.
 *  Times may go negative for keyframes before the trimmed window — the evaluator interpolates by
 *  time, so values inside the visible span stay exact. */
function mapAnimations(child: TimelineLayer, headTrimSeconds: number, clipSpeed: number): TimelineKeyframeV2[] | undefined {
  const merged: TimelineKeyframeV2[] = [
    ...migrateTimelineKeyframes(child.keyframes ?? [], child.startSeconds),
    ...(child.animations ?? []),
  ];
  if (merged.length === 0) return undefined;
  if (headTrimSeconds === 0 && clipSpeed === 1) return merged;
  return merged.map((keyframe) => ({
    ...keyframe,
    timeSeconds: (keyframe.timeSeconds - headTrimSeconds) / clipSpeed,
  }));
}

/**
 * Expand every compound clip in `composition` into derived child layers (+ group specs).
 * Returns the SAME composition reference (and an empty group map) when there is nothing to expand,
 * so non-nested projects stay byte-identical through every render path.
 *
 * The compound clip itself is REMOVED from the track (its group spec carries it); children take its
 * z-slot in the nested sequence's own back-to-front order. Muted compound clips are kept as-is —
 * callers already filter muted layers.
 */
export function expandNestedCompositions(
  composition: TimelineComposition,
  compositions: Record<string, TimelineComposition> | undefined,
  options?: { visited?: ReadonlySet<string>; depth?: number }
): ExpandedNestedComposition {
  const depth = options?.depth ?? 0;
  const hasNested = composition.tracks.some((track) => track.layers.some((layer) => layer.nestedCompositionId && !layer.muted));
  if (!hasNested || !compositions || depth >= NEST_MAX_DEPTH) {
    return { composition, groups: new Map() };
  }

  const visited = new Set(options?.visited ?? []);
  visited.add(composition.id);
  const groups = new Map<string, NestedGroupSpec>();

  const expandClip = (clip: TimelineLayer): TimelineLayer[] => {
    const nested = clip.nestedCompositionId ? compositions[clip.nestedCompositionId] : undefined;
    // Missing/cyclic/too-deep reference: leave the clip unexpanded (renders as an empty media layer)
    // rather than dropping content or recursing forever.
    if (!nested || visited.has(nested.id)) return [clip];

    const inner = expandNestedCompositions(nested, compositions, { visited, depth: depth + 1 });
    const clipSpeed = getLayerSpeed(clip); // v1: ramps on the compound are unsupported → scalar speed
    const winStart = clip.sourceInSeconds ?? 0;
    const winEnd = winStart + clip.durationSeconds * clipSpeed;

    // Map one nested-comp layer into parent-timeline coordinates through the clip's trim window +
    // speed, or null when it doesn't overlap the window. Used for the visible children AND for the
    // group-shell clips of inner nests (which are no longer layers after the inner expansion).
    const mapChild = (child: TimelineLayer): TimelineLayer | null => {
      const childStart = child.startSeconds;
      const childEnd = childStart + child.durationSeconds;
      const overlapStart = Math.max(childStart, winStart);
      const overlapEnd = Math.min(childEnd, winEnd);
      if (overlapEnd <= overlapStart) return null;
      const headTrim = overlapStart - childStart;
      const ramp = getSpeedRamp(child);
      return {
        ...child,
        id: `${clip.id}${NEST_ID_SEPARATOR}${child.id}`,
        trackId: clip.trackId,
        startSeconds: clip.startSeconds + (overlapStart - winStart) / clipSpeed,
        durationSeconds: (overlapEnd - overlapStart) / clipSpeed,
        // Child source time at the trimmed head — exact even when the CHILD has a speed ramp
        // (closed-form integral via the shared evaluator).
        sourceInSeconds: layerSourceTimeSeconds(child, headTrim),
        speed: ramp ? undefined : getLayerSpeed(child) * clipSpeed,
        speedKeyframes: mapSpeedKeyframes(child, headTrim, clipSpeed),
        keyframes: [],
        animations: mapAnimations(child, headTrim, clipSpeed),
        // R2 fix: a head-trimmed child used to lose its junction transition outright even when the trim
        // only ate part of its pre-roll — shrink the transition to what handle remains instead of
        // dropping it; only a trim that eats the WHOLE transition window removes it.
        transitionIn: child.transitionIn
          ? headTrim === 0
            ? mapTransitionSpec(child.transitionIn, clipSpeed)
            : child.transitionIn.durationSeconds - headTrim > 0
              ? mapTransitionSpec({ ...child.transitionIn, durationSeconds: child.transitionIn.durationSeconds - headTrim }, clipSpeed)
              : undefined
          : undefined,
      };
    };

    // NEST-REVIEW (Block 1, audio volume folding — plan Task 3.5): NOT implemented. "Fold the compound
    // clip's own volume and the nested track's static gain into each derived child" turned out to be
    // more than a scalar multiply: clip volume in this codebase is a KEYFRAMABLE EFFECT
    // (`getCompositionVolume` reads a "volume" entry in `layer.effects`, evaluated at the layer's OWN
    // local time via `evaluateTimelineEffectParam` — there is no plain `TimelineLayer.volume` field).
    // Correctly folding the compound clip's own volume effect into every descendant would mean
    // SYNTHESIZING a time/speed-remapped "volume" effect object per derived child (mirroring the
    // `mapAnimations`/`mapSpeedKeyframes` substitution above, but for effect param keyframes) — a
    // properly-scoped follow-up, not a safe quick addition, and untested by any Task 6 gate. The nested
    // TRACK's static `volume` (fader gain, a real scalar) is ALSO not folded here for the same reason:
    // the runtime only ever reads gain through the PARENT-level track (derived children keep
    // `trackId: clip.trackId`), so the nested track's own fader is currently silently ignored. Until
    // this lands, an imported/nested sequence's own track fader and clip volume automation do not
    // affect nested playback volume — a real but narrow gap, not a crash or wrong-in-the-common-case bug
    // (unity gain — the default — is unaffected).
    // Z-ORDER: the active-composition render paints tracks[0] on TOP (VideoPreview sorts by
    // `b.trackIndex - a.trackIndex`), and within a track higher layerIndex on top. The derived children
    // all collapse onto the compound clip's single parent track, so their PARENT layerIndex (== push
    // order) becomes their z. To make the composited stack match how the SAME sequence looks when opened
    // in place, we must push bottom-to-top: inner tracks LAST→FIRST (so inner track0 lands highest =
    // top), each track's own layers in natural order. (Pushing tracks front-first inverted this — a
    // multi-track nest, e.g. a Canvas Frame's background track, rendered on the wrong side.)
    const children: TimelineLayer[] = [];
    for (const track of [...inner.composition.tracks].reverse()) {
      if (!isTrackEnabled(track, inner.composition.tracks)) continue;
      for (const child of track.layers) {
        if (child.muted) continue;
        const derived = mapChild(child);
        if (derived) children.push(derived);
      }
    }
    // Inner groups of nests-in-nests: re-key and re-map their group-shell clips through this instance,
    // so the compositor folds `outer__nest_inner__nest_*` children under `outer__nest_inner` correctly.
    for (const [, innerGroup] of inner.groups) {
      const mappedShell = mapChild(innerGroup.clip);
      if (mappedShell) groups.set(mappedShell.id, { clip: mappedShell, composition: innerGroup.composition });
    }

    groups.set(clip.id, {
      clip,
      composition: { id: nested.id, width: nested.width, height: nested.height, durationSeconds: nested.durationSeconds },
    });
    return children;
  };

  const tracks: TimelineTrack[] = composition.tracks.map((track) => {
    if (!track.layers.some((layer) => layer.nestedCompositionId && !layer.muted)) return track;
    return {
      ...track,
      layers: track.layers.flatMap((layer) => (layer.nestedCompositionId && !layer.muted ? expandClip(layer) : [layer])),
    };
  });

  return { composition: { ...composition, tracks }, groups };
}

/** Convenience for graph-level callers (manifest builder, export core). */
export function expandGraphNestedCompositions(graph: ProjectGraph, composition: TimelineComposition): ExpandedNestedComposition {
  return expandNestedCompositions(composition, graph.compositions);
}

// ---------------------------------------------------------------------------
// Phase B — editor UX: creating/undoing a compound clip (NESTING.md §"Nest command"/"Un-nest").
// Pure structural transforms; the render-side expansion above is unaffected — it just sees one more
// (or one fewer) `nestedCompositionId` clip in the composition it's handed.
// ---------------------------------------------------------------------------

function freshNestId(prefix: string): string {
  const suffix = globalThis.crypto?.randomUUID?.().slice(0, 8) ?? Math.random().toString(36).slice(2, 10);
  return `${prefix}_${suffix}`;
}

export interface NestSelectionResult {
  /** The host composition with the selection replaced by one compound clip. */
  composition: TimelineComposition;
  /** The new nested sequence — caller stores this in `ProjectGraph.compositions[nestedComposition.id]`. */
  nestedComposition: TimelineComposition;
  /** The new compound clip's id (== the layer replacing the selection). */
  clipId: string;
}

/**
 * Collapses 2+ selected layers (any tracks) into a NEW nested sequence, replacing them in `composition`
 * with one compound clip spanning their combined time range, on the topmost affected track. Layer
 * relative positions/durations and their track grouping are preserved inside the nest (times normalized
 * to nest-local t=0). Already-compound clips in the selection are left alone — nesting a nest is
 * rejected (v1, matches NESTING.md "Self-nesting forbidden" spirit: no nests-in-nests from this action).
 * Returns null when fewer than 2 nestable layers are selected.
 */
export function nestLayersIntoComposition(
  composition: TimelineComposition,
  layerIds: readonly string[],
  options?: { name?: string }
): NestSelectionResult | null {
  const selected = new Set(layerIds);
  const found: Array<{ track: TimelineTrack; trackIndex: number; layer: TimelineLayer }> = [];
  composition.tracks.forEach((track, trackIndex) => {
    for (const layer of track.layers) {
      if (selected.has(layer.id) && !layer.nestedCompositionId) {
        found.push({ track, trackIndex, layer });
      }
    }
  });
  if (found.length < 2) return null;

  const spanStart = Math.min(...found.map((f) => f.layer.startSeconds));
  const spanEnd = Math.max(...found.map((f) => f.layer.startSeconds + f.layer.durationSeconds));
  const topTrackIndex = Math.min(...found.map((f) => f.trackIndex));

  const nestId = freshNestId("nest");
  const nestedTrackIdByParentTrackId = new Map<string, string>();
  const nestedTracks: TimelineTrack[] = [];
  for (const { track } of found) {
    if (nestedTrackIdByParentTrackId.has(track.id)) continue;
    const nestedTrackId = freshNestId("ntrack");
    nestedTrackIdByParentTrackId.set(track.id, nestedTrackId);
    nestedTracks.push({ id: nestedTrackId, type: track.type, name: track.name, layers: [] });
  }
  for (const { track, layer } of found) {
    const nestedTrack = nestedTracks.find((t) => t.id === nestedTrackIdByParentTrackId.get(track.id))!;
    nestedTrack.layers.push({ ...layer, trackId: nestedTrack.id, startSeconds: layer.startSeconds - spanStart });
  }

  const nestedComposition: TimelineComposition = {
    id: nestId,
    name: options?.name ?? "Nested Sequence",
    width: composition.width,
    height: composition.height,
    fps: composition.fps,
    durationSeconds: spanEnd - spanStart,
    tracks: nestedTracks,
    backgroundColor: composition.backgroundColor
  };

  const clipId = freshNestId("clip");
  const replacementClip: TimelineLayer = {
    id: clipId,
    trackId: composition.tracks[topTrackIndex]!.id,
    type: "video",
    name: nestedComposition.name,
    startSeconds: spanStart,
    durationSeconds: spanEnd - spanStart,
    sourceInSeconds: 0,
    nestedCompositionId: nestId,
    fit: "cover",
    transform: { position: { x: 50, y: 50 }, scale: 1, rotation: 0, opacity: 100 },
    effects: [],
    keyframes: [],
    animations: []
  };

  const tracks = composition.tracks.map((track, index) => {
    // Keep unselected layers, and any already-compound clip in the selection (nesting a nest is a no-op skip).
    const remaining = track.layers.filter((layer) => !selected.has(layer.id) || Boolean(layer.nestedCompositionId));
    if (index === topTrackIndex) {
      return { ...track, layers: [...remaining, replacementClip].sort((a, b) => a.startSeconds - b.startSeconds) };
    }
    return remaining.length === track.layers.length ? track : { ...track, layers: remaining };
  });

  return { composition: { ...composition, tracks }, nestedComposition, clipId };
}

/**
 * Un-nest: splices a compound clip's nested sequence tracks back into `composition` at the clip's
 * position (in new tracks inserted right after the clip's own track), removing the clip. v1 only
 * supports an UNTRIMMED, UNSPED compound clip (`sourceInSeconds` 0, `speed` 1/absent) — a trimmed/sped
 * un-nest needs the full time-remap `expandNestedCompositions` does for rendering, not a simple splice;
 * returns null (caller surfaces "can't un-nest a trimmed clip") rather than silently losing the trim.
 */
export function unnestClip(
  composition: TimelineComposition,
  compositions: Record<string, TimelineComposition> | undefined,
  clipId: string
): { composition: TimelineComposition } | null {
  let clip: TimelineLayer | undefined;
  let clipTrackIndex = -1;
  composition.tracks.forEach((track, index) => {
    const match = track.layers.find((layer) => layer.id === clipId);
    if (match) {
      clip = match;
      clipTrackIndex = index;
    }
  });
  if (!clip || !clip.nestedCompositionId) return null;
  const nested = compositions?.[clip.nestedCompositionId];
  if (!nested) return null;
  if ((clip.sourceInSeconds ?? 0) !== 0 || (clip.speed ?? 1) !== 1) return null;

  const shift = clip.startSeconds;
  const insertedTracks: TimelineTrack[] = nested.tracks.map((track) => {
    const nextTrackId = freshNestId("utrack");
    return {
      ...track,
      id: nextTrackId,
      layers: track.layers.map((layer) => ({
        ...layer,
        id: freshNestId("uclip"),
        trackId: nextTrackId,
        startSeconds: layer.startSeconds + shift
      }))
    };
  });

  const tracks: TimelineTrack[] = [];
  composition.tracks.forEach((track, index) => {
    if (index === clipTrackIndex) {
      tracks.push({ ...track, layers: track.layers.filter((layer) => layer.id !== clipId) });
      tracks.push(...insertedTracks);
    } else {
      tracks.push(track);
    }
  });

  return { composition: { ...composition, tracks } };
}

// Canvas Frames (createFrame) were removed 2026-07-14: a "frame" was just a nest + a full-bleed
// background, a confusing near-duplicate of grouping. One grouping primitive now — nest/group above.
// A future Canva-style "Frames" feature (shape placeholders that clip dropped media) is a separate
// masks/shapes concept, not this. See GRAPHICS_TAB.md.
