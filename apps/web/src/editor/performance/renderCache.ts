import type { TimelineComposition } from "@reelforge/shared";

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

export type CachedPreviewSpanStatus = "ready" | "pending" | "dirty" | "failed";

export interface CachedPreviewSpan {
  id: string;
  signature: string;
  startSeconds: number;
  endSeconds: number;
  reason: AdaptiveCacheSpanReason;
  status: CachedPreviewSpanStatus;
  priority: number;
  layerIds: string[];
  renderScale: number;
  createdAt: number;
  lastUsedAt: number;
  byteSize: number;
  url?: string | undefined;
  error?: string | undefined;
}

export interface PreviewRenderCacheStore {
  getReadySpan: (timeSeconds: number, signature: string, renderScale: number) => CachedPreviewSpan | undefined;
  upsert: (span: CachedPreviewSpan) => void;
  markDirty: (range: TimelineInterval) => number;
  removeSignature: (signature: string) => number;
  reconcile: (plan: readonly AdaptiveCacheSpan[], signature: string, renderScale: number, now?: number) => CachedPreviewSpan[];
  nextPending: () => CachedPreviewSpan | undefined;
  clear: () => void;
  readonly entries: CachedPreviewSpan[];
  readonly size: number;
  readonly byteSize: number;
}

export interface PreviewRenderCacheStoreOptions {
  maxEntries?: number | undefined;
  maxBytes?: number | undefined;
}

export interface PreviewCacheControllerUpdate {
  composition: TimelineComposition;
  renderScale: number;
  playheadSeconds: number;
  dirtyLayerIds?: readonly string[] | undefined;
  minSpanSeconds?: number | undefined;
  maxSimpleSpanSeconds?: number | undefined;
  maxComplexSpanSeconds?: number | undefined;
  now?: number | undefined;
}

export interface PreviewCacheControllerSnapshot {
  signature: string;
  renderScale: number;
  playheadSeconds: number;
  plannedSpans: AdaptiveCacheSpan[];
  pendingSpans: CachedPreviewSpan[];
  readySpan?: CachedPreviewSpan | undefined;
  nextPending?: CachedPreviewSpan | undefined;
  entries: CachedPreviewSpan[];
  byteSize: number;
}

export interface PreviewCacheController {
  update: (input: PreviewCacheControllerUpdate) => PreviewCacheControllerSnapshot;
  markDirty: (range: TimelineInterval) => number;
  clear: () => void;
  readonly store: PreviewRenderCacheStore;
}

export interface PreviewCacheRulerSegment {
  id: string;
  startPercent: number;
  endPercent: number;
  status: CachedPreviewSpanStatus;
  reason: AdaptiveCacheSpanReason;
  priority: number;
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

export interface TimelineInterval {
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

function containsTime(span: TimelineInterval, timeSeconds: number): boolean {
  return timeSeconds >= span.startSeconds && timeSeconds < span.endSeconds;
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

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`)
    .join(",")}}`;
}

function hashString(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export function compositionCacheLayers(composition: TimelineComposition): TimelineCacheLayerInput[] {
  return composition.tracks.flatMap((track) =>
    track.layers.map((layer) => ({
      id: layer.id,
      type: layer.type,
      startSeconds: layer.startSeconds,
      durationSeconds: layer.durationSeconds,
      ...(layer.assetId !== undefined ? { assetId: layer.assetId } : {}),
      ...(layer.transitionIn !== undefined ? { transitionIn: { durationSeconds: layer.transitionIn.durationSeconds } } : {}),
      effects: layer.effects,
      masks: layer.masks,
      keyframes: layer.keyframes,
      animations: layer.animations
    }))
  );
}

export function timelineCacheSignature(input: {
  compositionId: string;
  durationSeconds: number;
  width: number;
  height: number;
  fps: number;
  layers: readonly TimelineCacheLayerInput[];
  renderScale: number;
}): string {
  const payload = {
    compositionId: input.compositionId,
    durationSeconds: Number(input.durationSeconds.toFixed(3)),
    width: input.width,
    height: input.height,
    fps: input.fps,
    renderScale: Number(input.renderScale.toFixed(3)),
    layers: input.layers.map((layer) => ({
      id: layer.id,
      type: layer.type,
      startSeconds: Number(layer.startSeconds.toFixed(3)),
      durationSeconds: Number(layer.durationSeconds.toFixed(3)),
      assetId: layer.assetId ?? "",
      transitionSeconds: layer.transitionIn?.durationSeconds ?? 0,
      effects: layer.effects ?? [],
      masks: layer.masks ?? [],
      keyframes: layer.keyframes ?? [],
      animations: layer.animations ?? []
    }))
  };
  return hashString(stableStringify(payload));
}

export function compositionCacheSignature(composition: TimelineComposition, renderScale: number): string {
  return timelineCacheSignature({
    compositionId: composition.id,
    durationSeconds: composition.durationSeconds,
    width: composition.width,
    height: composition.height,
    fps: composition.fps,
    layers: compositionCacheLayers(composition),
    renderScale
  });
}

function cacheSpanKey(signature: string, renderScale: number, span: TimelineInterval): string {
  return `${signature}:${renderScale.toFixed(3)}:${span.startSeconds.toFixed(3)}-${span.endSeconds.toFixed(3)}`;
}

function sortByPriority(a: CachedPreviewSpan, b: CachedPreviewSpan): number {
  if (b.priority !== a.priority) {
    return b.priority - a.priority;
  }
  return a.createdAt - b.createdAt;
}

export function createPreviewRenderCacheStore(options: PreviewRenderCacheStoreOptions = {}): PreviewRenderCacheStore {
  const maxEntries = Math.max(1, options.maxEntries ?? 120);
  const maxBytes = Math.max(1, options.maxBytes ?? 256 * 1024 * 1024);
  const entries = new Map<string, CachedPreviewSpan>();

  const currentByteSize = (): number => [...entries.values()].reduce((total, span) => total + span.byteSize, 0);

  const evictIfNeeded = (): void => {
    while (entries.size > maxEntries || currentByteSize() > maxBytes) {
      const evictable = [...entries.values()].sort((a, b) => {
        if (a.status !== b.status) {
          return a.status === "ready" ? 1 : -1;
        }
        return a.lastUsedAt - b.lastUsedAt;
      })[0];
      if (!evictable) {
        break;
      }
      entries.delete(evictable.id);
    }
  };

  return {
    getReadySpan(timeSeconds, signature, renderScale) {
      const match = [...entries.values()]
        .filter((span) => span.signature === signature && span.renderScale === renderScale && span.status === "ready")
        .find((span) => containsTime(span, timeSeconds));
      if (match) {
        match.lastUsedAt = Date.now();
      }
      return match;
    },
    upsert(span) {
      entries.set(span.id, span);
      evictIfNeeded();
    },
    markDirty(range) {
      let count = 0;
      for (const span of entries.values()) {
        if (span.status !== "dirty" && overlaps(span, range)) {
          span.status = "dirty";
          count += 1;
        }
      }
      return count;
    },
    removeSignature(signature) {
      let count = 0;
      for (const span of [...entries.values()]) {
        if (span.signature === signature) {
          entries.delete(span.id);
          count += 1;
        }
      }
      return count;
    },
    reconcile(plan, signature, renderScale, now = Date.now()) {
      const wantedIds = new Set<string>();
      const pending: CachedPreviewSpan[] = [];
      for (const planned of plan) {
        const id = cacheSpanKey(signature, renderScale, planned);
        wantedIds.add(id);
        const existing = entries.get(id);
        if (existing && existing.status !== "dirty" && existing.status !== "failed") {
          existing.priority = planned.priority;
          existing.layerIds = planned.layerIds;
          continue;
        }
        const span: CachedPreviewSpan = {
          id,
          signature,
          startSeconds: planned.startSeconds,
          endSeconds: planned.endSeconds,
          reason: planned.reason,
          status: "pending",
          priority: planned.priority,
          layerIds: planned.layerIds,
          renderScale,
          createdAt: now,
          lastUsedAt: now,
          byteSize: 0
        };
        entries.set(id, span);
        pending.push(span);
      }

      for (const span of [...entries.values()]) {
        if (span.signature === signature && span.renderScale === renderScale && !wantedIds.has(span.id)) {
          span.status = "dirty";
        }
      }
      evictIfNeeded();
      return pending.sort(sortByPriority);
    },
    nextPending() {
      return [...entries.values()].filter((span) => span.status === "pending").sort(sortByPriority)[0];
    },
    clear() {
      entries.clear();
    },
    get entries() {
      return [...entries.values()].sort((a, b) => a.startSeconds - b.startSeconds);
    },
    get size() {
      return entries.size;
    },
    get byteSize() {
      return currentByteSize();
    }
  };
}

export function createPreviewCacheController(options: PreviewRenderCacheStoreOptions = {}): PreviewCacheController {
  const store = createPreviewRenderCacheStore(options);
  return {
    update(input) {
      const layers = compositionCacheLayers(input.composition);
      const signature = timelineCacheSignature({
        compositionId: input.composition.id,
        durationSeconds: input.composition.durationSeconds,
        width: input.composition.width,
        height: input.composition.height,
        fps: input.composition.fps,
        layers,
        renderScale: input.renderScale
      });
      const plannedSpans = planAdaptiveCacheSpans({
        durationSeconds: input.composition.durationSeconds,
        layers,
        playheadSeconds: input.playheadSeconds,
        ...(input.dirtyLayerIds !== undefined ? { dirtyLayerIds: input.dirtyLayerIds } : {}),
        ...(input.minSpanSeconds !== undefined ? { minSpanSeconds: input.minSpanSeconds } : {}),
        ...(input.maxSimpleSpanSeconds !== undefined ? { maxSimpleSpanSeconds: input.maxSimpleSpanSeconds } : {}),
        ...(input.maxComplexSpanSeconds !== undefined ? { maxComplexSpanSeconds: input.maxComplexSpanSeconds } : {})
      });
      const pendingSpans = store.reconcile(plannedSpans, signature, input.renderScale, input.now);
      const readySpan = store.getReadySpan(input.playheadSeconds, signature, input.renderScale);
      const nextPending = store.nextPending();
      return {
        signature,
        renderScale: input.renderScale,
        playheadSeconds: input.playheadSeconds,
        plannedSpans,
        pendingSpans,
        ...(readySpan !== undefined ? { readySpan } : {}),
        ...(nextPending !== undefined ? { nextPending } : {}),
        entries: store.entries,
        byteSize: store.byteSize
      };
    },
    markDirty(range) {
      return store.markDirty(range);
    },
    clear() {
      store.clear();
    },
    get store() {
      return store;
    }
  };
}

export function previewCacheRulerSegments(input: {
  entries: readonly CachedPreviewSpan[];
  durationSeconds: number;
  visibleRange?: TimelineInterval | undefined;
}): PreviewCacheRulerSegment[] {
  const durationSeconds = Number.isFinite(input.durationSeconds) ? Math.max(0, input.durationSeconds) : 0;
  if (durationSeconds <= 0) {
    return [];
  }
  const visibleRange = input.visibleRange ?? { startSeconds: 0, endSeconds: durationSeconds };
  return input.entries
    .filter((span) => overlaps(span, visibleRange))
    .map((span) => {
      const startSeconds = clamp(Math.max(span.startSeconds, visibleRange.startSeconds), 0, durationSeconds);
      const endSeconds = clamp(Math.min(span.endSeconds, visibleRange.endSeconds), 0, durationSeconds);
      return {
        id: span.id,
        startPercent: (startSeconds / durationSeconds) * 100,
        endPercent: (endSeconds / durationSeconds) * 100,
        status: span.status,
        reason: span.reason,
        priority: span.priority
      };
    })
    .filter((segment) => segment.endPercent > segment.startPercent)
    .sort((a, b) => a.startPercent - b.startPercent);
}
