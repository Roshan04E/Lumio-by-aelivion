import type { ProjectGraph, SpeedKeyframe, TimelineComposition, TimelineLayer, TimelineTrack, TrackAudioKeyframe } from "./types";

export type CompositionOrientation = "portrait" | "landscape";

const orientationPresets = {
  portrait: { width: 1080, height: 1920, fps: 30, preset: "vertical_1080x1920" as const },
  landscape: { width: 1920, height: 1080, fps: 30, preset: "landscape_1920x1080" as const }
};

export function createDefaultComposition(input: {
  id: string;
  name: string;
  durationSeconds: number;
  assetId?: string | undefined;
  orientation?: CompositionOrientation | undefined;
  /** Frame-rate override (create-only goal presets, e.g. Cinematic → 24). Defaults to the
   *  orientation preset's 30fps when omitted. */
  fps?: number | undefined;
  /** "Continue without a template": start with an empty timeline. Only the uploaded footage (if any)
   *  lands on the video track — no placeholder "Main clip" and no empty "Music bed" audio layer. */
  blank?: boolean | undefined;
}): TimelineComposition {
  const duration = clamp(input.durationSeconds, 6, 7200);
  const orientationFrame = orientationPresets[input.orientation ?? "portrait"];
  const frame = { ...orientationFrame, fps: input.fps ?? orientationFrame.fps };
  // Deliberately raw: the main clip carries no auto color-grade/grain and no fade-in
  // (see layer() below) - what the user uploaded is exactly what renders, frame 0
  // onward, full opacity, unaltered. No placeholder "Hook caption"/"CTA caption" text
  // is auto-inserted either; the text track starts empty for the user (or a tool's
  // Apply step) to fill in deliberately, not have copy appear they never asked for.
  //
  // Blank projects seed NO placeholder layers: a video layer only when real footage is attached.
  const includeMedia = !input.blank || Boolean(input.assetId);
  const mediaLayer = includeMedia
    ? layer({
        id: `${input.id}_media_1`,
        trackId: `${input.id}_track_video`,
        type: "video",
        name: "Main clip",
        startSeconds: 0,
        durationSeconds: duration,
        assetId: input.assetId,
        fit: "cover"
      })
    : undefined;
  // No auto "Music bed": it carried no asset, so it always surfaced as a FALSE empty audio clip
  // (worse when the source video has no audio at all). The audio track starts empty; the user or a
  // tool drops real audio onto it deliberately. The video layer still carries its own embedded audio.
  const audioLayer: TimelineLayer | undefined = undefined;

  return {
    id: `composition_${input.id}`,
    name: input.name,
    width: frame.width,
    height: frame.height,
    fps: frame.fps,
    durationSeconds: duration,
    backgroundColor: "#07080C",
    settings: {
      viewport: {
        preset: frame.preset,
        width: frame.width,
        height: frame.height,
        fps: frame.fps,
        backgroundColor: "#07080C",
        resizeBehavior: "keep-layout"
      },
      timeline: {
        baseDurationSeconds: duration,
        autoGrow: true,
        tailPaddingSeconds: 1,
        snapSeconds: 0.1,
        timeDisplay: "seconds"
      }
    },
    tracks: [
      track(`${input.id}_track_text`, "video", "Video 2", []),
      track(`${input.id}_track_video`, "video", "Video 1", mediaLayer ? [mediaLayer] : []),
      track(`${input.id}_track_audio`, "audio", "Audio 1", audioLayer ? [audioLayer] : [])
    ]
  };
}

export function ensureComposition(graph: ProjectGraph, input: { name: string; durationSeconds: number }): TimelineComposition {
  if (graph.composition) {
    return dedupeLayerIds(graph.composition);
  }

  return createDefaultComposition({
    id: graph.projectId,
    name: input.name,
    durationSeconds: input.durationSeconds,
    assetId: graph.sourceAssetId
  });
}

/**
 * Healing pass: layer ids MUST be unique (React keys, selection, per-id ops all assume it) — but
 * uniqueness is NEVER worth silently deleting user content. The original healer DROPPED later
 * occurrences, which turned any id collision into a delayed time bomb: the collision was created
 * silently (e.g. two layers minted in the same millisecond by the Date.now()-based id generator),
 * both clips rendered normally, and then the user's NEXT ordinary edit re-derived the composition
 * through this pass and one clip vanished — experienced as "I trimmed a clip and it got deleted"
 * (2026-07-04 report). Later occurrences are now RE-IDENTIFIED: content preserved, uniqueness
 * restored, incident loudly reported (console + globalThis.__rfHealedLayerIds) so collisions get
 * fixed at their source. Returns the same reference when nothing is wrong.
 */
function dedupeLayerIds(composition: TimelineComposition): TimelineComposition {
  const seen = new Set<string>();
  let healed = 0;
  const tracks = composition.tracks.map((track) => {
    let changed = false;
    const layers = track.layers.map((layer) => {
      if (!seen.has(layer.id)) {
        seen.add(layer.id);
        return layer;
      }
      healed += 1;
      let candidate = `${layer.id}__healed_${healed}`;
      while (seen.has(candidate)) {
        candidate = `${candidate}x`;
      }
      seen.add(candidate);
      changed = true;
      console.warn(`[timeline] duplicate layer id healed by re-id (content preserved): "${layer.id}" → "${candidate}" (${layer.type} "${layer.name}")`);
      const g = globalThis as { __rfHealedLayerIds?: Array<{ from: string; to: string; type: string; name: string }> };
      (g.__rfHealedLayerIds ??= []).push({ from: layer.id, to: candidate, type: layer.type, name: layer.name });
      return { ...layer, id: candidate };
    });
    return changed ? { ...track, layers } : track;
  });
  return healed > 0 ? { ...composition, tracks } : composition;
}

export function flattenTimelineLayers(composition: TimelineComposition): TimelineLayer[] {
  return composition.tracks.flatMap((trackItem) => trackItem.layers);
}

/** Track mixer fader gain: 0..2 linear, 1 = unity. Normalizes absent/garbage values. */
export function getTrackAudioGain(track: Pick<TimelineTrack, "volume">): number {
  const raw = track.volume;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) return 1;
  return Math.min(2, raw);
}

/** Track stereo pan: −1 (left) .. 1 (right), 0 = center. Normalizes absent/garbage values. */
export function getTrackPan(track: Pick<TimelineTrack, "pan">): number {
  const raw = track.pan;
  if (typeof raw !== "number" || !Number.isFinite(raw)) return 0;
  return Math.min(1, Math.max(-1, raw));
}

/** Linear interpolation over track audio keyframes (absolute comp seconds); flat outside the range. */
function evaluateTrackAudioKeyframes(keyframes: readonly TrackAudioKeyframe[], timeSeconds: number): number {
  const sorted = [...keyframes].filter((k) => Number.isFinite(k.timeSeconds) && Number.isFinite(k.value)).sort((a, b) => a.timeSeconds - b.timeSeconds);
  if (!sorted.length) return Number.NaN;
  if (timeSeconds <= sorted[0]!.timeSeconds) return sorted[0]!.value;
  const last = sorted[sorted.length - 1]!;
  if (timeSeconds >= last.timeSeconds) return last.value;
  for (let i = 1; i < sorted.length; i += 1) {
    const b = sorted[i]!;
    if (timeSeconds <= b.timeSeconds) {
      const a = sorted[i - 1]!;
      const span = b.timeSeconds - a.timeSeconds;
      const f = span <= 0 ? 1 : (timeSeconds - a.timeSeconds) / span;
      return a.value + (b.value - a.value) * f;
    }
  }
  return last.value;
}

/** Fader gain at `timeSeconds`: automation when present (linear v1), else the static fader. */
export function getTrackAudioGainAt(track: Pick<TimelineTrack, "volume" | "volumeKeyframes">, timeSeconds: number): number {
  if (track.volumeKeyframes?.length) {
    const value = evaluateTrackAudioKeyframes(track.volumeKeyframes, timeSeconds);
    if (Number.isFinite(value)) return Math.min(2, Math.max(0, value));
  }
  return getTrackAudioGain(track);
}

/** Stereo pan at `timeSeconds`: automation when present (linear v1), else the static pan. */
export function getTrackPanAt(track: Pick<TimelineTrack, "pan" | "panKeyframes">, timeSeconds: number): number {
  if (track.panKeyframes?.length) {
    const value = evaluateTrackAudioKeyframes(track.panKeyframes, timeSeconds);
    if (Number.isFinite(value)) return Math.min(1, Math.max(-1, value));
  }
  return getTrackPan(track);
}

/** True when the track's fader or pan is keyframed (drives export envelope sampling + cloud post-mix). */
export function trackHasAudioAutomation(track: Pick<TimelineTrack, "volumeKeyframes" | "panKeyframes">): boolean {
  return Boolean(track.volumeKeyframes?.length || track.panKeyframes?.length);
}

/** Sane clamp for rate stretch — matches Premiere's practical speed range. */
export const MIN_LAYER_SPEED = 0.05;
export const MAX_LAYER_SPEED = 16;

/**
 * The clip's constant playback rate (rate stretch). 1 = normal. ALWAYS read speed through this —
 * it normalizes absent/zero/garbage values so `sourceTime = sourceIn + local * speed` stays finite.
 * S2 (2026-07-17): NEGATIVE rates are legal — the clip plays in reverse (source time decreases);
 * magnitude clamps to the same [MIN, MAX] band. Callers that need a magnitude (durations, element
 * playbackRate, headroom divisions) must take Math.abs — the sign is DIRECTION, not a scalar.
 */
export function getLayerSpeed(layer: Pick<TimelineLayer, "speed">): number {
  const raw = layer.speed;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw === 0) return 1;
  const magnitude = Math.min(MAX_LAYER_SPEED, Math.max(MIN_LAYER_SPEED, Math.abs(raw)));
  return raw < 0 ? -magnitude : magnitude;
}

/**
 * Rate stretch as a PURE op (Premiere's Clip Speed dialog, non-ripple) — extracted verbatim
 * from EditorPage's `handleChangeLayerSpeed` (2026-07-18) so the editor dialog and the
 * `setClipSpeed` registry action share ONE implementation instead of forking semantics:
 * duration re-derives so the clip keeps playing the SAME source span (duration = span/speed),
 * tail growth clamps at the next clip on each affected track, linked companions (video+audio
 * pairs) move together, and a sign flip swaps the in-point to the current OUT so the visible
 * span plays backward (symmetric — reversing twice restores the origin; media clips without
 * ramps only, since ramps carry their own signed authoring).
 *
 * Returns null when the layer doesn't exist or the speed is already there (a no-op is the
 * caller's decision to surface, not a mutation).
 */
export function changeLayerConstantSpeed(
  composition: TimelineComposition,
  layerId: string,
  requestedSpeed: number
): { composition: TimelineComposition; appliedSpeed: number } | null {
  const layer = flattenTimelineLayers(composition).find((item) => item.id === layerId);
  if (!layer || !Number.isFinite(requestedSpeed) || requestedSpeed === 0) {
    return null;
  }
  const newSpeedMagnitude = Math.min(MAX_LAYER_SPEED, Math.max(MIN_LAYER_SPEED, Math.abs(Number(requestedSpeed.toFixed(3)))));
  const newSpeed = requestedSpeed < 0 ? -newSpeedMagnitude : newSpeedMagnitude;
  const oldSpeed = getLayerSpeed(layer);
  if (Math.abs(newSpeed - oldSpeed) < 0.0005) {
    return null;
  }
  const frameSeconds = 1 / Math.min(120, Math.max(1, Math.round(composition.fps) || 30));
  const groupIds = new Set<string>(
    layer.linkedGroupId
      ? flattenTimelineLayers(composition)
          .filter((item) => item.linkedGroupId === layer.linkedGroupId)
          .map((item) => item.id)
      : [layerId]
  );
  const sourceSpan = layer.durationSeconds * Math.abs(oldSpeed);
  let newDuration = Math.max(frameSeconds, sourceSpan / newSpeedMagnitude);
  for (const track of composition.tracks) {
    for (const member of track.layers) {
      if (!groupIds.has(member.id)) continue;
      const nextStart = track.layers
        .filter((other) => !groupIds.has(other.id) && other.startSeconds >= member.startSeconds + member.durationSeconds - 0.02)
        .reduce<number | null>((best, other) => (best === null || other.startSeconds < best ? other.startSeconds : best), null);
      if (nextStart !== null) {
        newDuration = Math.min(newDuration, Math.max(frameSeconds, nextStart - member.startSeconds));
      }
    }
  }
  const next: TimelineComposition = {
    ...composition,
    tracks: composition.tracks.map((track) => ({
      ...track,
      layers: track.layers.map((item) => {
        if (!groupIds.has(item.id)) return item;
        const memberOldSpeed = getLayerSpeed(item);
        const signFlipped =
          Math.sign(memberOldSpeed) !== Math.sign(newSpeed) &&
          (item.type === "video" || item.type === "audio") &&
          Boolean(item.assetId) &&
          (item.speedKeyframes?.length ?? 0) === 0;
        const nextSourceIn = signFlipped
          ? Math.max(0, (item.sourceInSeconds ?? 0) + item.durationSeconds * memberOldSpeed)
          : item.sourceInSeconds;
        return {
          ...item,
          speed: newSpeed,
          durationSeconds: Number(newDuration.toFixed(3)),
          ...(signFlipped ? { sourceInSeconds: Number((nextSourceIn ?? 0).toFixed(3)) } : {})
        };
      })
    }))
  };
  return { composition: next, appliedSpeed: newSpeed };
}

// ── Speed ramps / time remap ─────────────────────────────────────────────────
// `speedKeyframes` (layer-local seconds → rate) override constant `speed`. Segments are LINEAR by
// default; S1 (2026-07-17) adds optional bezier easing per point (`inHandle`/`outHandle`). BOTH
// integrate in closed form — linear as trapezoids, eased segments as the exact polynomial
// ∫ y(s)·x′(s) ds over the bezier parameter (degree ≤5 integrand → exact antiderivative) — so the
// timeline→source mapping stays exact and identical in preview, local export, and the cloud worker.
// No numerical stepping anywhere; the only iteration is inverting the MONOTONIC time cubic x(s)=t
// (Newton with bisection bracketing — deterministic fixed loop, same doubles in every runtime).

// S2: ramp point values are SIGNED — negative = reverse, and a ramp may cross 0 (the crossing
// itself is a momentary freeze; a point AT 0 holds the frame). Only the magnitude extreme clamps;
// sub-MIN magnitudes are legal inside ramps (near-freeze) — the closed-form integral handles them.
const clampSpeed = (v: number) =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(MAX_LAYER_SPEED, Math.max(-MAX_LAYER_SPEED, v)) : 1;

const sanitizeSpeedHandle = (
  raw: SpeedKeyframe["inHandle"],
  direction: -1 | 1
): SpeedKeyframe["inHandle"] => {
  if (!raw || typeof raw.dx !== "number" || typeof raw.dy !== "number" || !Number.isFinite(raw.dx) || !Number.isFinite(raw.dy)) {
    return undefined;
  }
  // Fractional convention (see SpeedHandle): out-handles reach forward (dx ∈ [0,1]), in-handles
  // backward (dx ∈ [−1,0]); dy loosely bounded like the graph's own clamp.
  const dx = direction > 0 ? Math.min(1, Math.max(0, raw.dx)) : Math.max(-1, Math.min(0, raw.dx));
  return { dx, dy: Math.max(-10, Math.min(10, raw.dy)) };
};

/** Sanitized, time-sorted ramp points, or null when the layer has no usable ramp. */
export function getSpeedRamp(layer: Pick<TimelineLayer, "speedKeyframes">): SpeedKeyframe[] | null {
  const raw = layer.speedKeyframes;
  if (!raw?.length) return null;
  const points = raw
    .filter((kf) => typeof kf?.timeSeconds === "number" && Number.isFinite(kf.timeSeconds))
    .map((kf) => ({
      id: kf.id,
      timeSeconds: Math.max(0, kf.timeSeconds),
      value: clampSpeed(kf.value),
      ...(sanitizeSpeedHandle(kf.inHandle, -1) ? { inHandle: sanitizeSpeedHandle(kf.inHandle, -1) } : {}),
      ...(sanitizeSpeedHandle(kf.outHandle, 1) ? { outHandle: sanitizeSpeedHandle(kf.outHandle, 1) } : {}),
      ...(kf.handlesLinked ? { handlesLinked: true } : {})
    }))
    .sort((a, b) => a.timeSeconds - b.timeSeconds);
  return points.length ? points : null;
}

// ── S1 eased-segment machinery (private) ─────────────────────────────────────

/** The four (time, value) bezier control points of an eased segment, or null when both sides are
 *  linear (the trapezoid fast path). Guarantees: x-controls are ordered (monotonic time — each
 *  handle's |dt| is clamped to the span and the COMBINED influence rescaled to ≤ span, AE-style),
 *  and y-controls are clamped to the legal speed range (bezier hull ⇒ y(s) stays in range too).
 *  A missing handle on one side defaults to the LINEAR control (⅓ along the chord), so a cubic
 *  with both defaults reproduces the straight segment exactly. */
function segmentControls(
  a: SpeedKeyframe,
  b: SpeedKeyframe
): { x: [number, number, number, number]; y: [number, number, number, number] } | null {
  if (!a.outHandle && !b.inHandle) return null;
  const span = b.timeSeconds - a.timeSeconds;
  if (span <= 0) return null;
  const delta = b.value - a.value;
  // Fractions → absolute control offsets (handles are fractions of THIS segment's span/delta).
  let dt0 = a.outHandle ? Math.min(Math.max(0, a.outHandle.dx), 1) * span : span / 3;
  let dt1 = b.inHandle ? Math.min(Math.max(0, -b.inHandle.dx), 1) * span : span / 3;
  const combined = dt0 + dt1;
  if (combined > span && combined > 0) {
    const k = span / combined;
    dt0 *= k;
    dt1 *= k;
  }
  const clampV = (v: number) => Math.min(MAX_LAYER_SPEED, Math.max(-MAX_LAYER_SPEED, v)); // signed (S2)
  const y1 = clampV(a.value + (a.outHandle ? a.outHandle.dy * delta : delta / 3));
  const y2 = clampV(b.value + (b.inHandle ? b.inHandle.dy * delta : -delta / 3));
  return {
    x: [a.timeSeconds, a.timeSeconds + dt0, b.timeSeconds - dt1, b.timeSeconds],
    y: [a.value, y1, y2, b.value]
  };
}

/** Cubic bezier → power-basis coefficients [c0..c3]: B(s) = c0 + c1·s + c2·s² + c3·s³. */
function powerBasis(p: [number, number, number, number]): [number, number, number, number] {
  return [
    p[0],
    3 * (p[1] - p[0]),
    3 * (p[2] - 2 * p[1] + p[0]),
    p[3] - 3 * p[2] + 3 * p[1] - p[0]
  ];
}

function evalPoly(c: readonly number[], s: number): number {
  let acc = 0;
  for (let i = c.length - 1; i >= 0; i -= 1) acc = acc * s + c[i]!;
  return acc;
}

/** Invert the MONOTONIC time cubic: the s ∈ [0,1] with x(s) = t. Deterministic fixed-iteration
 *  Newton, bracketed by bisection so it can never diverge (x′ ≥ 0 by the control ordering, but it
 *  may touch 0 at the ends). */
function solveSegmentParam(xc: [number, number, number, number], t: number): number {
  const x0 = evalPoly(xc, 0);
  const x1 = evalPoly(xc, 1);
  if (t <= x0) return 0;
  if (t >= x1) return 1;
  const dxc = [xc[1], 2 * xc[2], 3 * xc[3]];
  let lo = 0;
  let hi = 1;
  let s = (t - x0) / Math.max(1e-12, x1 - x0);
  for (let i = 0; i < 24; i += 1) {
    const err = evalPoly(xc, s) - t;
    if (Math.abs(err) < 1e-10) break;
    if (err > 0) hi = s;
    else lo = s;
    const slope = evalPoly(dxc, s);
    let next = slope > 1e-9 ? s - err / slope : (lo + hi) / 2;
    if (!(next > lo && next < hi)) next = (lo + hi) / 2;
    s = next;
  }
  return s;
}

/** EXACT ∫₀^s y(σ)·x′(σ) dσ for one eased segment — y·x′ is a degree-5 polynomial (closed form). */
function segmentIntegralAt(xc: [number, number, number, number], yc: [number, number, number, number], s: number): number {
  // x′ coefficients: [xc1, 2·xc2, 3·xc3]; product with y (degree 3) → degree 5.
  const d = [xc[1], 2 * xc[2], 3 * xc[3]];
  const p = new Array<number>(6).fill(0);
  for (let i = 0; i < 4; i += 1) {
    for (let j = 0; j < 3; j += 1) {
      p[i + j]! += yc[i]! * d[j]!;
    }
  }
  let acc = 0;
  for (let k = 5; k >= 0; k -= 1) acc = acc * s + p[k]! / (k + 1);
  return acc * s;
}

/** True when the clip's rate varies over time (≥2 ramp points at different values or times). */
export function hasSpeedRamp(layer: Pick<TimelineLayer, "speedKeyframes">): boolean {
  return (getSpeedRamp(layer)?.length ?? 0) > 0;
}

/**
 * Add (or replace-at-time) a ramp point — the single write rule for `speedKeyframes`, extracted so
 * every surface that edits a ramp (the inspector's `ClipSpeedControl` today, a future graph lane) writes
 * through the SAME dedupe-by-time + resort logic instead of drifting apart. Points within 0.02s of
 * `timeSeconds` are replaced (matches the inspector's existing tolerance for "drag near an existing
 * point" vs. "new point").
 */
export function upsertSpeedRampPoint(
  layer: Pick<TimelineLayer, "speedKeyframes">,
  timeSeconds: number,
  value: number
): SpeedKeyframe[] {
  const existing = (layer.speedKeyframes ?? []).find((kf) => Math.abs(kf.timeSeconds - timeSeconds) <= 0.02);
  const points = (layer.speedKeyframes ?? []).filter((kf) => Math.abs(kf.timeSeconds - timeSeconds) > 0.02);
  // Preserve the replaced point's id (graph-lane drag continuity) AND its easing handles.
  const id = existing?.id ?? (globalThis.crypto?.randomUUID?.().slice(0, 8) ?? Math.random().toString(36).slice(2, 10));
  return [...points, { ...(existing ?? {}), id, timeSeconds, value }].sort((a, b) => a.timeSeconds - b.timeSeconds);
}

/** Remove the ramp point at `timeSeconds` (exact match), or `undefined` when none remain. */
export function removeSpeedRampPoint(
  layer: Pick<TimelineLayer, "speedKeyframes">,
  timeSeconds: number
): SpeedKeyframe[] | undefined {
  const points = (layer.speedKeyframes ?? []).filter((kf) => Math.abs(kf.timeSeconds - timeSeconds) > 1e-4);
  return points.length ? points : undefined;
}

/**
 * How many seconds of SOURCE media a ramp/constant-speed clip consumes over its own
 * `durationSeconds` — the R5 "duration readout" (`integrateRamp` under the hood, but exposed through
 * the already-public `layerSourceTimeSeconds` so callers don't need the private integrator).
 */
export function layerSourceSecondsConsumed(layer: Pick<TimelineLayer, "speed" | "sourceInSeconds" | "speedKeyframes" | "durationSeconds">): number {
  return layerSourceTimeSeconds(layer, layer.durationSeconds) - layerSourceTimeSeconds(layer, 0);
}

/**
 * Instantaneous playback rate at `localSeconds` (time since clip start). Ramp overrides constant
 * speed; before the first / after the last point the edge value holds (Premiere semantics).
 */
export function getLayerSpeedAt(layer: Pick<TimelineLayer, "speed" | "speedKeyframes">, localSeconds: number): number {
  const ramp = getSpeedRamp(layer);
  if (!ramp) return getLayerSpeed(layer);
  const t = Math.max(0, localSeconds);
  if (t <= ramp[0]!.timeSeconds) return ramp[0]!.value;
  for (let i = 1; i < ramp.length; i += 1) {
    const prev = ramp[i - 1]!;
    const next = ramp[i]!;
    if (t <= next.timeSeconds) {
      const span = next.timeSeconds - prev.timeSeconds;
      if (span <= 0) return next.value;
      const controls = segmentControls(prev, next);
      if (controls) {
        const s = solveSegmentParam(powerBasis(controls.x), t);
        return clampSpeed(evalPoly(powerBasis(controls.y), s));
      }
      const f = (t - prev.timeSeconds) / span;
      return prev.value + (next.value - prev.value) * f;
    }
  }
  return ramp[ramp.length - 1]!.value;
}

/** Exact ∫₀ᵗ speed(τ)dτ over the ramp (closed-form trapezoids; edge values hold outside the points). */
function integrateRamp(ramp: SpeedKeyframe[], localSeconds: number): number {
  const t = Math.max(0, localSeconds);
  let integral = 0;
  // Before the first point: constant at the first value.
  const first = ramp[0]!;
  integral += Math.min(t, first.timeSeconds) * first.value;
  if (t <= first.timeSeconds) return integral;
  for (let i = 1; i < ramp.length; i += 1) {
    const a = ramp[i - 1]!;
    const b = ramp[i]!;
    const span = b.timeSeconds - a.timeSeconds;
    if (span <= 0) continue;
    const controls = segmentControls(a, b);
    if (controls) {
      // Eased segment: exact polynomial integral of y·x′ over the bezier parameter.
      const xc = powerBasis(controls.x);
      const yc = powerBasis(controls.y);
      if (t >= b.timeSeconds) {
        integral += segmentIntegralAt(xc, yc, 1);
      } else {
        integral += segmentIntegralAt(xc, yc, solveSegmentParam(xc, t));
        return integral;
      }
      continue;
    }
    if (t >= b.timeSeconds) {
      integral += (span * (a.value + b.value)) / 2;
    } else {
      const dt = t - a.timeSeconds;
      const vEnd = a.value + ((b.value - a.value) * dt) / span;
      integral += (dt * (a.value + vEnd)) / 2;
      return integral;
    }
  }
  // After the last point: constant at the last value.
  const last = ramp[ramp.length - 1]!;
  integral += (t - last.timeSeconds) * last.value;
  return integral;
}

/**
 * Timeline seconds → source-media seconds for a clip (speed- AND ramp-aware). `localSeconds` is
 * time since clip start. THE mapping every renderer must use for ramped clips.
 */
export function layerSourceTimeSeconds(
  layer: Pick<TimelineLayer, "speed" | "sourceInSeconds" | "speedKeyframes">,
  localSeconds: number
): number {
  const ramp = getSpeedRamp(layer);
  if (!ramp) return (layer.sourceInSeconds ?? 0) + Math.max(0, localSeconds) * getLayerSpeed(layer);
  return (layer.sourceInSeconds ?? 0) + integrateRamp(ramp, localSeconds);
}

/** Sanitized frame-hold fps (2..30), or null when the layer has no hold. */
export function getLayerHoldFps(layer: Pick<TimelineLayer, "holdFps">): number | null {
  const raw = layer.holdFps;
  if (typeof raw !== "number" || !Number.isFinite(raw)) return null;
  if (raw < 2 || raw > 30) return null;
  return raw;
}

/**
 * Frame hold ("animating on twos"): quantize LOCAL time to the layer's hold grid — N distinct
 * images per timeline second, held between grid points. VIDEO SAMPLING ONLY: audio consumers keep
 * using raw local time. Quantizing local (not source) time means a speed-ramped clip still shows
 * exactly `holdFps` new images per second of playback — the animation-camera model. Pure floor
 * math ⇒ bit-identical across every renderer.
 */
export function layerHeldLocalSeconds(layer: Pick<TimelineLayer, "holdFps">, localSeconds: number): number {
  const fps = getLayerHoldFps(layer);
  if (!fps) return localSeconds;
  return Math.floor(Math.max(0, localSeconds) * fps) / fps;
}

/**
 * Rebase a ramp after cutting `headSeconds` off the clip's head (split right half, head trim,
 * work-area clip): points shift left; the segment value AT the cut becomes a new first point so
 * the remaining clip plays identically. Returns undefined when the layer has no ramp.
 */
export function shiftSpeedKeyframes(
  layer: Pick<TimelineLayer, "speed" | "speedKeyframes">,
  headSeconds: number
): SpeedKeyframe[] | undefined {
  const ramp = getSpeedRamp(layer);
  if (!ramp) return undefined;
  if (headSeconds === 0) return ramp;
  if (headSeconds < 0) {
    // Head EXTENSION: points shift right; the edge-hold before the first point plays the new
    // material at the first value — matching the sourceIn math in adjustLayerHead. Handles are
    // RELATIVE offsets, so they ride along unchanged.
    return ramp.map((kf) => ({ ...kf, timeSeconds: kf.timeSeconds - headSeconds }));
  }
  const kept = ramp.filter((kf) => kf.timeSeconds > headSeconds).map((kf) => ({ ...kf, timeSeconds: kf.timeSeconds - headSeconds }));
  // If the cut lands INSIDE an eased segment, a plain "value at cut" point would flatten the
  // remaining half — de Casteljau subdivision at the cut parameter keeps the surviving curve
  // byte-identical to what it played before the trim (same guarantee the V2 keyframe glue gives).
  const after = ramp.find((kf) => kf.timeSeconds > headSeconds);
  const before = [...ramp].reverse().find((kf) => kf.timeSeconds <= headSeconds);
  if (before && after) {
    const controls = segmentControls(before, after);
    if (controls) {
      const s = solveSegmentParam(powerBasis(controls.x), headSeconds);
      const lerp = (p: number, q: number, f: number) => p + (q - p) * f;
      const sub = (pts: [number, number, number, number]) => {
        const q0 = lerp(pts[0], pts[1], s);
        const q1 = lerp(pts[1], pts[2], s);
        const q2 = lerp(pts[2], pts[3], s);
        const r0 = lerp(q0, q1, s);
        const r1 = lerp(q1, q2, s);
        return { at: lerp(r0, r1, s), r1, q2 };
      };
      const sx = sub(controls.x);
      const sy = sub(controls.y);
      const first = kept[0]!; // === `after`, shifted
      // Absolute subdivision offsets → the fractional handle convention, relative to the NEW
      // (cut → after) segment. Equal-value new segments can't carry a dy bulge in this convention
      // (same limitation as every other graph lane) — they fall back to flat.
      const newSpan = Math.max(1e-9, controls.x[3] - headSeconds);
      const newDelta = controls.y[3] - sy.at;
      const fracDy = (dv: number) => (Math.abs(newDelta) < 1e-6 ? 0 : dv / newDelta);
      const cutPoint: SpeedKeyframe = {
        timeSeconds: 0,
        value: clampSpeed(sy.at),
        outHandle: { dx: Math.min(1, Math.max(0, (sx.r1 - sx.at) / newSpan)), dy: fracDy(sy.r1 - sy.at) }
      };
      const firstWithSplitIn: SpeedKeyframe = {
        ...first,
        inHandle: { dx: Math.max(-1, Math.min(0, (sx.q2 - controls.x[3]) / newSpan)), dy: fracDy(sy.q2 - controls.y[3]) }
      };
      return [cutPoint, firstWithSplitIn, ...kept.slice(1)];
    }
  }
  const atCut = getLayerSpeedAt(layer, headSeconds);
  // Cut in the edge-hold region (before the first point): the synthesized point makes a flat lead-in
  // segment — drop the first kept point's in-handle so it can't bend a segment it never governed.
  const flatKept = !before && kept.length ? [{ ...kept[0]!, inHandle: undefined }, ...kept.slice(1)] : kept;
  return [{ timeSeconds: 0, value: atCut }, ...flatKept];
}

const KEYFRAME_TRIM_EPSILON = 0.0001;

/** Move a layer's ABSOLUTE (V1/legacy) keyframes with the clip when the whole timeline shifts left by
 *  `bySeconds`. V2 `animations` are layer-local and must NOT be touched by a pure move. */
function shiftAbsoluteKeyframes(layer: TimelineLayer, bySeconds: number): TimelineLayer["keyframes"] {
  if (!layer.keyframes.length || bySeconds === 0) return layer.keyframes;
  return layer.keyframes.map((keyframe) => ({ ...keyframe, timeSeconds: keyframe.timeSeconds - bySeconds }));
}

/**
 * THE rule for what a head trim does to a layer's keyframe tracks — the keyframe counterpart of
 * {@link shiftSpeedKeyframes}, and the single implementation behind both `trimLayerKeyframesTo`
 * (interactive edge trim / ripple / split) and `clipCompositionToWorkArea` (work-area export).
 *
 * Cutting `headDeltaSeconds` off the head moves the CONTENT, so anything pinned to that content must
 * move with it or it silently drifts by exactly the trim amount. The three tracks are pinned in
 * different time domains, which is the whole trap:
 *  - `animations` (V2) are LAYER-LOCAL → drop keys inside the removed window, then shift survivors by
 *    −delta. (A head EXTEND is delta < 0: nothing is dropped and keys shift right.)
 *  - `keyframes` (V1) are ABSOLUTE composition time → they don't rebase, they just re-filter against
 *    the new span. A caller that also moves the clip on the TIMELINE must shift these itself.
 *  - `speedKeyframes` rebase via `shiftSpeedKeyframes` (the value at the cut becomes the new point 0).
 *
 * Duplicating this rule is what broke the work-area export: it rebased `sourceInSeconds` and the ramp
 * but not the keyframes, so exporting with an in-point that cut into a keyframed clip rendered every
 * key `trimmedFromHead` seconds late (project-tracker/timeline.md v1).
 */
export function trimLayerKeyframeTracks(
  layer: TimelineLayer,
  headDeltaSeconds: number,
  nextDurationSeconds: number
): Pick<TimelineLayer, "keyframes" | "animations"> & { speedKeyframes?: TimelineLayer["speedKeyframes"] } {
  const headMoved = Math.abs(headDeltaSeconds) > KEYFRAME_TRIM_EPSILON;
  const nextStartSeconds = layer.startSeconds + headDeltaSeconds;
  const nextEndSeconds = nextStartSeconds + nextDurationSeconds;
  const animations = (layer.animations ?? [])
    .filter((animation) => animation.timeSeconds >= headDeltaSeconds - KEYFRAME_TRIM_EPSILON)
    .map((animation) =>
      headMoved ? { ...animation, timeSeconds: animation.timeSeconds - headDeltaSeconds } : animation
    )
    .filter((animation) => animation.timeSeconds <= nextDurationSeconds + KEYFRAME_TRIM_EPSILON);
  const keyframes = layer.keyframes.filter(
    (keyframe) =>
      keyframe.timeSeconds >= nextStartSeconds - KEYFRAME_TRIM_EPSILON &&
      keyframe.timeSeconds <= nextEndSeconds + KEYFRAME_TRIM_EPSILON
  );
  const ramp = headMoved ? shiftSpeedKeyframes(layer, headDeltaSeconds) : layer.speedKeyframes;
  return { keyframes, animations, ...(ramp ? { speedKeyframes: ramp } : {}) };
}

/**
 * Premiere-style work area: when in/out points are set on the timeline, clip the composition to that
 * sub-range. Layers fully outside the range are dropped; layers straddling an edge are trimmed (with
 * `sourceInSeconds` advanced by the trimmed head so the media stays in sync); everything is shifted so
 * the in-point becomes t=0; and `durationSeconds` collapses to the range length. Returns the
 * composition UNCHANGED (same reference) when no in/out point is set — so the full-project export path
 * stays byte-identical. Mirrors the cloud render path (`buildRenderManifest`) so local export honors
 * the work area the same way. The returned composition has its in/out points cleared (already applied).
 */
export function clipCompositionToWorkArea(composition: TimelineComposition): TimelineComposition {
  const inRaw = composition.settings?.timeline.inPointSeconds;
  const outRaw = composition.settings?.timeline.outPointSeconds;
  if (inRaw === undefined && outRaw === undefined) return composition;

  const clampRange = (value: number, lo: number, hi: number) => Math.min(Math.max(value, lo), hi);
  const inPoint = clampRange(inRaw ?? 0, 0, composition.durationSeconds);
  const outPoint = clampRange(outRaw ?? composition.durationSeconds, inPoint, composition.durationSeconds);
  const rangeDurationSeconds = Math.max(1 / composition.fps, outPoint - inPoint);
  const preserveTimingLayerIds = new Set<string>();
  const visualEndSecondsByLayerId = new Map<string, number>();

  const overlapsRange = (startSeconds: number, endSeconds: number) => startSeconds < outPoint && inPoint < endSeconds;
  for (const trackItem of composition.tracks) {
    for (const incoming of trackItem.layers) {
      const transition = incoming.transitionIn;
      if (!transition || incoming.type === "audio") continue;
      const incomingStart = incoming.startSeconds;
      const transitionDuration = Math.max(0, Math.min(transition.durationSeconds, incoming.durationSeconds));
      const transitionEnd = incomingStart + transitionDuration;
      if (!overlapsRange(incomingStart, transitionEnd)) continue;
      preserveTimingLayerIds.add(incoming.id);
      const outgoing = trackItem.layers.find((layer) => {
        if (layer.id === incoming.id || layer.type === "audio") return false;
        const layerEnd = layer.startSeconds + layer.durationSeconds;
        return Math.abs(layerEnd - incomingStart) < 0.05;
      });
      if (outgoing) {
        preserveTimingLayerIds.add(outgoing.id);
        visualEndSecondsByLayerId.set(outgoing.id, Math.max(visualEndSecondsByLayerId.get(outgoing.id) ?? 0, transitionEnd));
      }
    }
  }

  const tracks: TimelineTrack[] = composition.tracks.map((trackItem) => ({
    ...trackItem,
    layers: trackItem.layers.flatMap((layer) => {
      const layerStart = layer.startSeconds;
      const layerEnd = layer.startSeconds + layer.durationSeconds;
      const visualEnd = Math.max(layerEnd, visualEndSecondsByLayerId.get(layer.id) ?? layerEnd);
      if (visualEnd <= inPoint || layerStart >= outPoint) return [];
      if (preserveTimingLayerIds.has(layer.id) && layerStart < inPoint) {
        // Timing preserved (the clip feeds a transition): no head trim, so LAYER-LOCAL keys stay put.
        // The clip still MOVES on the timeline, so absolute (V1) keys must follow it.
        return [{ ...layer, startSeconds: layerStart - inPoint, keyframes: shiftAbsoluteKeyframes(layer, inPoint) }];
      }
      const clippedStart = Math.max(layerStart, inPoint);
      const clippedEnd = Math.min(layerEnd, outPoint);
      const trimmedFromHeadSeconds = clippedStart - layerStart;
      // Rebase every keyframe track onto the trimmed head, then shift the surviving ABSOLUTE (V1) keys
      // by the in-point like the clip itself. V2 keys are layer-local and already handled by the trim.
      const trimmed = trimLayerKeyframeTracks(layer, trimmedFromHeadSeconds, clippedEnd - clippedStart);
      const next: TimelineLayer = {
        ...layer,
        startSeconds: clippedStart - inPoint,
        durationSeconds: clippedEnd - clippedStart,
        animations: trimmed.animations,
        keyframes: trimmed.keyframes.map((keyframe) => ({ ...keyframe, timeSeconds: keyframe.timeSeconds - inPoint }))
      };
      if (trimmed.speedKeyframes) next.speedKeyframes = trimmed.speedKeyframes;
      if (layer.type === "video" || layer.type === "audio" || layer.sourceInSeconds !== undefined) {
        // Head trim consumes source media at the clip's playback rate (rate stretch / ramp integral).
        next.sourceInSeconds = layerSourceTimeSeconds(layer, trimmedFromHeadSeconds);
      }
      return [next];
    })
  }));

  return {
    ...composition,
    durationSeconds: rangeDurationSeconds,
    tracks,
    ...(composition.settings
      ? { settings: { ...composition.settings, timeline: { ...composition.settings.timeline, inPointSeconds: undefined, outPointSeconds: undefined } } }
      : {})
  };
}

export function updateTimelineLayer(
  composition: TimelineComposition,
  layerId: string,
  updater: (layer: TimelineLayer) => TimelineLayer
): TimelineComposition {
  return {
    ...composition,
    tracks: composition.tracks.map((trackItem) => ({
      ...trackItem,
      layers: trackItem.layers.map((item) => (item.id === layerId ? updater(item) : item))
    }))
  };
}

/**
 * Same as {@link updateTimelineLayer} but applies the SAME updater to every layer in `layerIds`
 * (multiselect property editing) — each layer runs the updater against its OWN current value, so a
 * shared "set opacity to 80" broadcast is correct even when the selected clips started at different
 * values; a per-layer keyframe toggle likewise keyframes each clip's own value at the playhead.
 */
export function updateTimelineLayers(
  composition: TimelineComposition,
  layerIds: readonly string[],
  updater: (layer: TimelineLayer) => TimelineLayer
): TimelineComposition {
  const targets = new Set(layerIds);
  return {
    ...composition,
    tracks: composition.tracks.map((trackItem) => ({
      ...trackItem,
      layers: trackItem.layers.map((item) => (targets.has(item.id) ? updater(item) : item))
    }))
  };
}

function track(id: string, type: TimelineTrack["type"], name: string, layers: TimelineLayer[]): TimelineTrack {
  return { id, type, name, layers };
}

/** No default fade/animation - a freshly created layer is raw: full opacity from its own start, unanimated, until the user (or a tool) deliberately adds a keyframe. */
function layer(input: Partial<TimelineLayer> & Pick<TimelineLayer, "id" | "trackId" | "type" | "name">): TimelineLayer {
  return {
    startSeconds: 0,
    durationSeconds: 3,
    fontFamily: "Inter",
    fontSize: 64,
    color: "#FFFFFF",
    transform: {
      position: { x: 50, y: 50 },
      scale: 1,
      rotation: 0,
      opacity: 100
    },
    effects: [],
    keyframes: [],
    ...input
  };
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

/**
 * Build a reusable template composition from an edited project composition. Slot
 * layers (or, when none are marked, the primary media layer + every text layer,
 * auto-marked here) keep their styling/effects/keyframes but shed project-specific
 * bindings: `media` slots lose their `assetId`/`matte` so the template ships empty,
 * `text` slots keep their copy as the default. This is what `POST /templates`
 * persists in `Template.templateGraph.composition`.
 */
export function buildTemplateGraphFromProject(graph: ProjectGraph): ProjectGraph {
  const composition = graph.composition;
  if (!composition) {
    return graph;
  }
  const withSlots = ensureTemplateSlots(composition);
  const editableFields: Record<string, unknown> = { ...graph.editableFields };
  const tracks = withSlots.tracks.map((trackItem) => ({
    ...trackItem,
    layers: trackItem.layers.map((item) => {
      if (!item.slot) {
        return item;
      }
      if (item.slot.kind === "text") {
        editableFields[item.slot.key] = item.text ?? "";
        return item;
      }
      if (item.slot.kind === "color") {
        editableFields[item.slot.key] = item.color ?? "#FFFFFF";
        return item;
      }
      // media slot: ship empty so the user's asset fills it on instantiation.
      return { ...item, assetId: undefined, matte: undefined };
    })
  }));
  return {
    ...graph,
    editableFields,
    composition: { ...withSlots, tracks }
  };
}

/**
 * Auto-mark template slots when the author hasn't marked any: the first media
 * layer with an asset becomes the main media slot, and every text layer becomes a
 * text slot. Idempotent - if any slot already exists, the composition is returned
 * unchanged so manual marking always wins.
 */
export function ensureTemplateSlots(composition: TimelineComposition): TimelineComposition {
  const hasSlot = flattenTimelineLayers(composition).some((item) => item.slot);
  if (hasSlot) {
    return composition;
  }
  let mediaMarked = false;
  let textIndex = 0;
  return {
    ...composition,
    tracks: composition.tracks.map((trackItem) => ({
      ...trackItem,
      layers: trackItem.layers.map((item) => {
        if (!mediaMarked && (item.type === "video" || item.type === "image") && item.assetId) {
          mediaMarked = true;
          return { ...item, slot: { key: "media_main", label: "Main media", kind: "media" as const, replaceable: true } };
        }
        if (item.type === "text") {
          textIndex += 1;
          return { ...item, slot: { key: `text_${textIndex}`, label: item.name || `Text ${textIndex}`, kind: "text" as const, replaceable: true } };
        }
        return item;
      })
    }))
  };
}

/**
 * Instantiate a template's stored composition into a fresh project. Track/layer
 * ids are remapped from the template's project token to the new project id so the
 * `${projectId}_*` naming convention stays coherent; empty media slots are filled
 * with the user's uploaded asset. Durations, effects, keyframes, `sourceInSeconds`
 * and matte refs are preserved verbatim.
 */
export function instantiateTemplateComposition(
  templateComposition: TimelineComposition,
  newProjectId: string,
  options?: { sourceAssetId?: string | undefined; name?: string | undefined }
): TimelineComposition {
  const clone = structuredClone(templateComposition);
  const oldProjectToken = clone.id.replace(/^composition_/, "");
  const remapId = (id: string) => (oldProjectToken ? id.split(oldProjectToken).join(newProjectId) : id);
  return {
    ...clone,
    id: `composition_${newProjectId}`,
    name: options?.name ?? clone.name,
    tracks: clone.tracks.map((trackItem) => ({
      ...trackItem,
      id: remapId(trackItem.id),
      layers: trackItem.layers.map((item) => {
        const next: TimelineLayer = { ...item, id: remapId(item.id), trackId: remapId(item.trackId) };
        if (item.slot?.kind === "media" && item.slot.replaceable && options?.sourceAssetId && !item.assetId) {
          next.assetId = options.sourceAssetId;
        }
        return next;
      })
    }))
  };
}
