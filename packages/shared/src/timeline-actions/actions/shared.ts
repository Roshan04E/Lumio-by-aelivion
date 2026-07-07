import type {
  TimelineComposition,
  TimelineKeyframeV2,
  TimelineLayer,
  TimelineLayerType,
  MaskPoint,
  ShapeKind,
  TimelineTrack,
  TimelineTransform,
  TimelineVector2
} from "../../types";

/** Fresh id matching the convention used by `timeline-ops.ts`. */
export function freshId(prefix: string): string {
  const suffix = globalThis.crypto?.randomUUID?.().slice(0, 8) ?? Math.random().toString(36).slice(2, 10);
  return `${prefix}_${suffix}`;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * The minimum clip length is a single frame — not an arbitrary fraction of a second.
 * `ABSOLUTE_MIN_CLIP_SECONDS` is the static floor for input validation (one frame at the
 * highest fps we support); `minClipDurationSeconds` gives the real per-composition floor.
 */
export const ABSOLUTE_MIN_CLIP_SECONDS = 1 / 240;
export function minClipDurationSeconds(composition: { fps: number }): number {
  return 1 / clamp(Math.round(composition.fps) || 30, 1, 240);
}

export function defaultTransform(overrides: Partial<TimelineTransform> = {}): TimelineTransform {
  return {
    position: overrides.position ?? { x: 50, y: 50 },
    scale: overrides.scale ?? 1,
    rotation: overrides.rotation ?? 0,
    opacity: overrides.opacity ?? 100
  };
}

/** Pick the most appropriate destination track for a new layer of `type`. */
export function pickTrackForLayer(
  composition: TimelineComposition,
  type: TimelineLayerType,
  trackId?: string
): TimelineTrack | undefined {
  if (trackId) {
    return composition.tracks.find((track) => track.id === trackId);
  }
  if (type === "audio") {
    return composition.tracks.find((track) => track.type === "audio");
  }
  if (type === "text") {
    return (
      composition.tracks.find((track) => track.type === "text") ??
      composition.tracks.find((track) => track.type !== "audio")
    );
  }
  return composition.tracks.find((track) => track.type !== "audio");
}

interface NewLayerTiming {
  startSeconds: number;
  durationSeconds: number;
}

export function resolveTiming(
  composition: TimelineComposition,
  nowSeconds: number,
  requested: { startSeconds?: number | undefined; durationSeconds?: number | undefined },
  defaultDuration = 3
): NewLayerTiming {
  const minDur = minClipDurationSeconds(composition);
  const start = clamp(requested.startSeconds ?? nowSeconds, 0, Math.max(0, composition.durationSeconds - minDur));
  const duration = Math.max(minDur, requested.durationSeconds ?? Math.min(defaultDuration, composition.durationSeconds - start));
  return { startSeconds: start, durationSeconds: duration };
}

export function createTextLayer(
  track: TimelineTrack,
  composition: TimelineComposition,
  nowSeconds: number,
  params: {
    text: string;
    color?: string | undefined;
    size?: number | undefined;
    fontFamily?: string | undefined;
    bold?: boolean | undefined;
    italic?: boolean | undefined;
    align?: "left" | "center" | "right" | undefined;
    startSeconds?: number | undefined;
    durationSeconds?: number | undefined;
    x?: number | undefined;
    y?: number | undefined;
  }
): TimelineLayer {
  const timing = resolveTiming(composition, nowSeconds, params);
  // The box is centre-anchored (translate(-50%,-50%)), so a raw 15 %/85 % from a
  // "top left"/"bottom" request pushes half the box off-frame. Keep the centre
  // inside a safe inset so the whole box stays visible.
  const position = clampToSafeArea(params.x, params.y);
  return {
    id: freshId("layer_text"),
    trackId: track.id,
    type: "text",
    name: params.text.slice(0, 24) || "Text",
    startSeconds: timing.startSeconds,
    durationSeconds: timing.durationSeconds,
    text: params.text,
    fontFamily: params.fontFamily ?? "Inter",
    fontSize: params.size ?? 72,
    ...(params.bold !== undefined ? { fontWeight: params.bold ? 900 : 400 } : {}),
    ...(params.italic !== undefined ? { italic: params.italic } : {}),
    textAlign: params.align ?? "center",
    textWidthPercent: 0,
    color: params.color ?? "#FFFFFF",
    strokeWidth: 0,
    transform: defaultTransform({ position }),
    effects: [],
    keyframes: []
  };
}

/**
 * Keep a new layer's centre within a safe inset of the frame. Directional words
 * map to ~22–78 % (not 15/85), so a centre-anchored text/shape box doesn't clip
 * off the top/bottom/left/right edge. Undefined axes default to centre / lower-third.
 */
function clampToSafeArea(x: number | undefined, y: number | undefined): TimelineVector2 {
  const safe = (value: number) => clamp(value, 22, 78);
  return {
    x: x === undefined ? 50 : safe(x),
    y: y === undefined ? 62 : safe(y)
  };
}

function defaultShapePathPoints(idPrefix: string): MaskPoint[] {
  const points = [
    { id: freshId(`${idPrefix}_pt`), x: 50, y: 4 },
    { id: freshId(`${idPrefix}_pt`), x: 96, y: 50 },
    { id: freshId(`${idPrefix}_pt`), x: 50, y: 96 },
    { id: freshId(`${idPrefix}_pt`), x: 4, y: 50 }
  ];
  return points.map((point, index) => {
    const prev = points[(index - 1 + points.length) % points.length]!;
    const next = points[(index + 1) % points.length]!;
    const dx = (next.x - prev.x) * 0.33;
    const dy = (next.y - prev.y) * 0.33;
    return {
      ...point,
      inTangent: { x: -dx, y: -dy },
      outTangent: { x: dx, y: dy },
      lockedTangents: true
    };
  });
}

export function createShapeLayer(
  track: TimelineTrack,
  composition: TimelineComposition,
  nowSeconds: number,
  params: {
    color?: string | undefined;
    x?: number | undefined;
    y?: number | undefined;
    widthPercent?: number | undefined;
    heightPercent?: number | undefined;
    shapeKind?: ShapeKind | undefined;
    shapePath?: MaskPoint[] | undefined;
    borderRadius?: number | undefined;
    startSeconds?: number | undefined;
    durationSeconds?: number | undefined;
  }
): TimelineLayer {
  const timing = resolveTiming(composition, nowSeconds, params, 2);
  const shapeKind = params.shapeKind ?? "rounded-rectangle";
  return {
    id: freshId("layer_shape"),
    trackId: track.id,
    type: "shape",
    name: "Shape",
    startSeconds: timing.startSeconds,
    durationSeconds: timing.durationSeconds,
    // Shape fill is `color` (what both renderers read); `backgroundColor` is the
    // text-box background only — writing the fill there left every shape the default.
    color: params.color ?? "#C9FF4A",
    widthPercent: params.widthPercent ?? 40,
    heightPercent: params.heightPercent ?? 24,
    shapeKind,
    ...(shapeKind === "pen" ? { shapePath: params.shapePath ?? defaultShapePathPoints("shape") } : {}),
    borderRadius: params.borderRadius ?? 12,
    transform: defaultTransform({ position: clampToSafeArea(params.x, params.y ?? 50), opacity: 82 }),
    effects: [],
    keyframes: []
  };
}

/** Friendly keyframe property names → canonical V2 target property strings. */
export const KEYFRAME_PROPERTY_MAP: Record<string, string> = {
  "position.x": "transform.position.x",
  "position.y": "transform.position.y",
  scale: "transform.scale",
  rotation: "transform.rotation",
  opacity: "transform.opacity"
};

export function createLayerKeyframe(
  property: string,
  timeSeconds: number,
  value: number,
  interpolation: TimelineKeyframeV2["interpolation"],
  idPrefix: string
): TimelineKeyframeV2 {
  const canonical = KEYFRAME_PROPERTY_MAP[property] ?? property;
  const component = canonical.endsWith(".x") ? "x" : canonical.endsWith(".y") ? "y" : undefined;
  return {
    id: freshId(idPrefix),
    target: { scope: "layer", property: canonical, ...(component ? { component } : {}) },
    timeSeconds: Math.max(0, timeSeconds),
    value,
    interpolation,
    temporal: {}
  };
}

/** Find a layer + its containing track inside a draft, returning live references. */
export function locateLayer(
  composition: TimelineComposition,
  layerId: string
): { track: TimelineTrack; layer: TimelineLayer; layerIndex: number } | null {
  for (const track of composition.tracks) {
    const layerIndex = track.layers.findIndex((item) => item.id === layerId);
    if (layerIndex !== -1) {
      return { track, layer: track.layers[layerIndex]!, layerIndex };
    }
  }
  return null;
}

export type { TimelineVector2 };
