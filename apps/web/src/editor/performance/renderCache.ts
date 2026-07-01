/**
 * Frame render cache (Phase 3 interface + a small LRU impl; wired in Phase 5).
 * Memoizes rendered preview frames keyed by (composition signature, time,
 * quality) so scrubbing back over unchanged regions is free. Any edit changes
 * the signature and naturally invalidates stale frames.
 */
export interface RenderCacheKey {
  /** Cheap signature of the inputs that affect this frame (layer hashes, quality). */
  signature: string;
  timeSeconds: number;
}

export interface FrameCache<T> {
  get: (key: RenderCacheKey) => T | undefined;
  set: (key: RenderCacheKey, value: T) => void;
  clear: () => void;
  readonly size: number;
}

export interface TimelineCacheLayerInput {
  id: string;
  type: string;
  startSeconds: number;
  durationSeconds: number;
  assetId?: string | undefined;
  transitionIn?: { durationSeconds: number } | undefined;
  effects?: readonly unknown[] | undefined;
  masks?: readonly unknown[] | undefined;
  keyframes?: readonly unknown[] | undefined;
  animations?: readonly unknown[] | undefined;
}

export type AdaptiveCacheSpanReason = "simple" | "overlay" | "effect" | "transition" | "dirty";

export interface AdaptiveCacheSpan {
  id: string;
  startSeconds: number;
  endSeconds: number;
  reason: AdaptiveCacheSpanReason;
  priority: number;
  layerIds: string[];
}

export interface AdaptiveCachePlanOptions {
  durationSeconds: number;
  layers: readonly TimelineCacheLayerInput[];
  playheadSeconds?: number | undefined;
  dirtyLayerIds?: readonly string[] | undefined;
  minSpanSeconds?: number | undefined;
  maxSimpleSpanSeconds?: number | undefined;
  maxComplexSpanSeconds?: number | undefined;
}

function keyString(key: RenderCacheKey): string {
  return `${key.signature}@${key.timeSeconds.toFixed(3)}`;
}

/** Simple LRU. Generic over the frame payload (ImageBitmap, canvas, dataURL, …). */
export function createFrameCache<T>(capacity = 60): FrameCache<T> {
  const map = new Map<string, T>();
  return {
    get(key) {
      const id = keyString(key);
      const value = map.get(id);
      if (value !== undefined) {
        map.delete(id);
        map.set(id, value); // bump to most-recent
      }
      return value;
    },
    set(key, value) {
      const id = keyString(key);
      map.delete(id);
      map.set(id, value);
      while (map.size > capacity) {
        const oldest = map.keys().next().value;
        if (oldest === undefined) {
          break;
        }
        map.delete(oldest);
      }
    },
    clear() {
      map.clear();
    },
    get size() {
      return map.size;
    }
  };
}

const DEFAULT_MIN_SPAN_SECONDS = 2;
const DEFAULT_MAX_SIMPLE_SPAN_SECONDS = 45;
const DEFAULT_MAX_COMPLEX_SPAN_SECONDS = 8;

interface TimelineInterval {
  startSeconds: number;
  endSeconds: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function isFinitePositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function overlaps(a: TimelineInterval, b: TimelineInterval): boolean {
  return a.startSeconds < b.endSeconds && b.startSeconds < a.endSeconds;
}

function layerInterval(layer: TimelineCacheLayerInput, durationSeconds: number): TimelineInterval | undefined {
  if (!isFinitePositive(layer.durationSeconds)) {
    return undefined;
  }
  const startSeconds = clamp(layer.startSeconds, 0, durationSeconds);
  const endSeconds = clamp(layer.startSeconds + layer.durationSeconds, 0, durationSeconds);
  if (endSeconds <= startSeconds) {
    return undefined;
  }
  return { startSeconds, endSeconds };
}

function addBoundary(boundaries: Set<number>, value: number, durationSeconds: number): void {
  if (Number.isFinite(value)) {
    boundaries.add(Number(clamp(value, 0, durationSeconds).toFixed(3)));
  }
}

function hasItems(value: readonly unknown[] | undefined): boolean {
  return Array.isArray(value) && value.length > 0;
}

function isOverlayLayer(layer: TimelineCacheLayerInput): boolean {
  return layer.type === "text" || layer.type === "shape" || layer.type === "adjustment";
}

function isEffectLayer(layer: TimelineCacheLayerInput): boolean {
  return hasItems(layer.effects) || hasItems(layer.masks) || hasItems(layer.keyframes) || hasItems(layer.animations);
}

function transitionInterval(layer: TimelineCacheLayerInput, durationSeconds: number): TimelineInterval | undefined {
  const transitionDuration = layer.transitionIn?.durationSeconds ?? 0;
  if (!isFinitePositive(transitionDuration)) {
    return undefined;
  }
  const startSeconds = clamp(layer.startSeconds - transitionDuration, 0, durationSeconds);
  const endSeconds = clamp(layer.startSeconds + transitionDuration, 0, durationSeconds);
  if (endSeconds <= startSeconds) {
    return undefined;
  }
  return { startSeconds, endSeconds };
}

function reasonRank(reason: AdaptiveCacheSpanReason): number {
  switch (reason) {
    case "dirty":
      return 5;
    case "transition":
      return 4;
    case "effect":
      return 3;
    case "overlay":
      return 2;
    case "simple":
      return 1;
  }
}

function strongerReason(a: AdaptiveCacheSpanReason, b: AdaptiveCacheSpanReason): AdaptiveCacheSpanReason {
  return reasonRank(a) >= reasonRank(b) ? a : b;
}

function scoreSpan(span: TimelineInterval, reason: AdaptiveCacheSpanReason, playheadSeconds: number | undefined): number {
  const base = reasonRank(reason) * 100;
  if (playheadSeconds === undefined || !Number.isFinite(playheadSeconds)) {
    return base;
  }
  if (playheadSeconds >= span.startSeconds && playheadSeconds < span.endSeconds) {
    return base + 60;
  }
  const distance = playheadSeconds < span.startSeconds ? span.startSeconds - playheadSeconds : playheadSeconds - span.endSeconds;
  return base + Math.max(0, 40 - Math.round(distance));
}

function splitInterval(interval: TimelineInterval, maxLength: number, minLength: number): TimelineInterval[] {
  const length = interval.endSeconds - interval.startSeconds;
  if (length <= maxLength) {
    return [interval];
  }
  const parts = Math.ceil(length / Math.max(maxLength, minLength));
  const partLength = length / parts;
  const spans: TimelineInterval[] = [];
  for (let index = 0; index < parts; index += 1) {
    const startSeconds = index === 0 ? interval.startSeconds : interval.startSeconds + partLength * index;
    const endSeconds = index === parts - 1 ? interval.endSeconds : interval.startSeconds + partLength * (index + 1);
    spans.push({
      startSeconds: Number(startSeconds.toFixed(3)),
      endSeconds: Number(endSeconds.toFixed(3))
    });
  }
  return spans;
}

/**
 * Plans preview/proxy cache spans from timeline dependency boundaries.
 *
 * The planner is intentionally deterministic and CPU-only: it never creates a
 * canvas or GL context. Simple continuous media can use long spans, while edits,
 * overlays, effects, masks, keyframes, and transitions force smaller spans.
 */
export function planAdaptiveCacheSpans(options: AdaptiveCachePlanOptions): AdaptiveCacheSpan[] {
  const durationSeconds = Number.isFinite(options.durationSeconds) ? Math.max(0, options.durationSeconds) : 0;
  if (durationSeconds <= 0) {
    return [];
  }

  const minSpanSeconds = Math.max(0.25, options.minSpanSeconds ?? DEFAULT_MIN_SPAN_SECONDS);
  const maxSimpleSpanSeconds = Math.max(minSpanSeconds, options.maxSimpleSpanSeconds ?? DEFAULT_MAX_SIMPLE_SPAN_SECONDS);
  const maxComplexSpanSeconds = Math.max(minSpanSeconds, options.maxComplexSpanSeconds ?? DEFAULT_MAX_COMPLEX_SPAN_SECONDS);
  const dirtyLayerIds = new Set(options.dirtyLayerIds ?? []);
  const boundaries = new Set<number>([0, Number(durationSeconds.toFixed(3))]);
  const transitionIntervals: TimelineInterval[] = [];

  for (const layer of options.layers) {
    const interval = layerInterval(layer, durationSeconds);
    if (!interval) {
      continue;
    }
    addBoundary(boundaries, interval.startSeconds, durationSeconds);
    addBoundary(boundaries, interval.endSeconds, durationSeconds);

    const transition = transitionInterval(layer, durationSeconds);
    if (transition) {
      transitionIntervals.push(transition);
      addBoundary(boundaries, transition.startSeconds, durationSeconds);
      addBoundary(boundaries, layer.startSeconds, durationSeconds);
      addBoundary(boundaries, transition.endSeconds, durationSeconds);
    }
  }

  const sortedBoundaries = [...boundaries].sort((a, b) => a - b);
  const spans: AdaptiveCacheSpan[] = [];

  for (let index = 0; index < sortedBoundaries.length - 1; index += 1) {
    const startSeconds = sortedBoundaries[index];
    const endSeconds = sortedBoundaries[index + 1];
    if (startSeconds === undefined || endSeconds === undefined) {
      continue;
    }
    if (endSeconds - startSeconds <= 0.001) {
      continue;
    }

    const interval = { startSeconds, endSeconds };
    const activeLayers = options.layers.filter((layer) => {
      const layerSpan = layerInterval(layer, durationSeconds);
      return layerSpan ? overlaps(interval, layerSpan) : false;
    });

    let reason: AdaptiveCacheSpanReason = "simple";
    for (const layer of activeLayers) {
      if (dirtyLayerIds.has(layer.id)) {
        reason = strongerReason(reason, "dirty");
      } else if (transitionIntervals.some((transition) => overlaps(interval, transition))) {
        reason = strongerReason(reason, "transition");
      } else if (isEffectLayer(layer)) {
        reason = strongerReason(reason, "effect");
      } else if (isOverlayLayer(layer)) {
        reason = strongerReason(reason, "overlay");
      }
    }

    const maxLength = reason === "simple" ? maxSimpleSpanSeconds : maxComplexSpanSeconds;
    for (const split of splitInterval(interval, maxLength, minSpanSeconds)) {
      spans.push({
        id: `${split.startSeconds.toFixed(3)}-${split.endSeconds.toFixed(3)}-${reason}`,
        startSeconds: split.startSeconds,
        endSeconds: split.endSeconds,
        reason,
        priority: scoreSpan(split, reason, options.playheadSeconds),
        layerIds: activeLayers.map((layer) => layer.id)
      });
    }
  }

  return spans;
}
