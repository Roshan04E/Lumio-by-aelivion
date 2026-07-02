import type { TimelineComposition } from "@lumio-by-aelivion/shared";

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
  sourceInSeconds?: number | undefined;
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
  /**
   * Hash of ONLY the layers overlapping this span's time range (and their render-relevant props). Two
   * plans agree on a span iff its time range AND content signature match — so an edit invalidates only the
   * spans it actually overlaps, leaving distant ready proxies untouched.
   */
  contentSignature: string;
}

export interface AdaptiveCachePlanOptions {
  durationSeconds: number;
  layers: readonly TimelineCacheLayerInput[];
  playheadSeconds?: number | undefined;
  targetRange?: TimelineInterval | undefined;
  dirtyLayerIds?: readonly string[] | undefined;
  minSpanSeconds?: number | undefined;
  maxSimpleSpanSeconds?: number | undefined;
  maxComplexSpanSeconds?: number | undefined;
}

export type CachedPreviewSpanStatus = "ready" | "pending" | "dirty" | "failed";
export type PreviewCacheRulerSegmentStatus = CachedPreviewSpanStatus | "live";

export interface CachedPreviewSpan {
  id: string;
  /** Base composition signature (comp id + resolution + fps + render scale) — NOT layer content. */
  signature: string;
  /** Content signature of the layers overlapping this span; drives per-span invalidation. */
  contentSignature: string;
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
  /** Ranges successfully rendered by live preview playback. Telemetry only, not playable media. */
  liveRanges?: TimelineInterval[] | undefined;
  url?: string | undefined;
  error?: string | undefined;
}

export interface PreviewRenderCacheStore {
  getReadySpan: (timeSeconds: number, signature: string, renderScale: number) => CachedPreviewSpan | undefined;
  upsert: (span: CachedPreviewSpan) => void;
  markDirty: (range: TimelineInterval) => number;
  removeSignature: (signature: string) => number;
  reconcile: (plan: readonly AdaptiveCacheSpan[], signature: string, renderScale: number, now?: number, scope?: TimelineInterval | undefined) => CachedPreviewSpan[];
  markFrameRendered: (input: { signature: string; renderScale: number; timeSeconds: number; frameDurationSeconds: number; now?: number | undefined }) => CachedPreviewSpan | undefined;
  /** Seal a span with its finalized proxy media (from the background generator). */
  markSpanReady: (input: { id: string; signature: string; contentSignature: string; url: string; byteSize: number; now?: number | undefined }) => CachedPreviewSpan | undefined;
  /** Look up ready proxy media covering a time, for playback substitution. */
  getReadySpanMedia: (timeSeconds: number, signature: string, renderScale: number) => { url: string; spanStartSeconds: number; spanId: string } | undefined;
  markFailed: (id: string, error: string) => void;
  nextPending: () => CachedPreviewSpan | undefined;
  clear: () => void;
  readonly entries: CachedPreviewSpan[];
  readonly size: number;
  readonly byteSize: number;
}

export interface PreviewRenderCacheStoreOptions {
  maxEntries?: number | undefined;
  maxBytes?: number | undefined;
  /**
   * Called when a span's backing proxy media should be released — on eviction, invalidation (dirty),
   * signature change, or clear. Lets the owner delete the OPFS/blob without the pure store importing it.
   */
  onDisposeSpanMedia?: ((span: CachedPreviewSpan) => void) | undefined;
}

export interface PreviewCacheControllerUpdate {
  composition: TimelineComposition;
  renderScale: number;
  playheadSeconds: number;
  targetRange?: TimelineInterval | undefined;
  dirtyLayerIds?: readonly string[] | undefined;
  minSpanSeconds?: number | undefined;
  maxSimpleSpanSeconds?: number | undefined;
  maxComplexSpanSeconds?: number | undefined;
  pluginSignature?: string | undefined;
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
  markFrameRendered: (input: { signature: string; renderScale: number; timeSeconds: number; frameDurationSeconds: number; now?: number | undefined }) => CachedPreviewSpan | undefined;
  markDirty: (range: TimelineInterval) => number;
  clear: () => void;
  readonly store: PreviewRenderCacheStore;
}

export interface PreviewCacheRulerSegment {
  id: string;
  startPercent: number;
  endPercent: number;
  status: PreviewCacheRulerSegmentStatus;
  reason: AdaptiveCacheSpanReason;
  priority: number;
}

export interface ProxyCacheStatus {
  ready: number;
  pending: number;
  dirty: number;
  failed: number;
  readyWithUrl: number;
  live: number;
  liveSeconds: number;
  total: number;
  byteSize: number;
  /** 0..1 fraction of spans that are ready. */
  readyRatio: number;
  /** True while any span is still pending/dirty (i.e. generation in flight or outstanding). */
  generating: boolean;
}

/** Aggregate span counts + storage size for the timeline proxy status indicator. */
export function summarizePreviewCacheStatus(entries: readonly CachedPreviewSpan[]): ProxyCacheStatus {
  let ready = 0;
  let pending = 0;
  let dirty = 0;
  let failed = 0;
  let readyWithUrl = 0;
  let live = 0;
  let liveSeconds = 0;
  let byteSize = 0;
  for (const span of entries) {
    byteSize += span.byteSize;
    if (span.liveRanges && span.liveRanges.length > 0) {
      live += 1;
      liveSeconds += span.liveRanges.reduce((total, range) => total + Math.max(0, range.endSeconds - range.startSeconds), 0);
    }
    switch (span.status) {
      case "ready":
        ready += 1;
        if (span.url !== undefined) {
          readyWithUrl += 1;
        }
        break;
      case "pending":
        pending += 1;
        break;
      case "dirty":
        dirty += 1;
        break;
      case "failed":
        failed += 1;
        break;
    }
  }
  const total = entries.length;
  return {
    ready,
    pending,
    dirty,
    failed,
    readyWithUrl,
    live,
    liveSeconds,
    total,
    byteSize,
    readyRatio: total > 0 ? readyWithUrl / total : 0,
    generating: pending + dirty > 0
  };
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
const PREVIEW_PROXY_RENDER_VERSION = 3;

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

function mergeLiveRanges(ranges: readonly TimelineInterval[], next: TimelineInterval): TimelineInterval[] {
  const mergeToleranceSeconds = 0.12;
  const sorted = [...ranges, next]
    .filter((range) => range.endSeconds > range.startSeconds)
    .sort((a, b) => a.startSeconds - b.startSeconds);
  const merged: TimelineInterval[] = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (!last || range.startSeconds > last.endSeconds + mergeToleranceSeconds) {
      merged.push({ ...range });
      continue;
    }
    last.endSeconds = Math.max(last.endSeconds, range.endSeconds);
  }
  return merged;
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
  const targetStartSeconds = clamp(options.targetRange?.startSeconds ?? 0, 0, durationSeconds);
  const targetEndSeconds = clamp(options.targetRange?.endSeconds ?? durationSeconds, 0, durationSeconds);
  if (targetEndSeconds <= targetStartSeconds) {
    return [];
  }

  const minSpanSeconds = Math.max(0.25, options.minSpanSeconds ?? DEFAULT_MIN_SPAN_SECONDS);
  const maxSimpleSpanSeconds = Math.max(minSpanSeconds, options.maxSimpleSpanSeconds ?? DEFAULT_MAX_SIMPLE_SPAN_SECONDS);
  const maxComplexSpanSeconds = Math.max(minSpanSeconds, options.maxComplexSpanSeconds ?? DEFAULT_MAX_COMPLEX_SPAN_SECONDS);
  const dirtyLayerIds = new Set(options.dirtyLayerIds ?? []);
  const boundaries = new Set<number>([Number(targetStartSeconds.toFixed(3)), Number(targetEndSeconds.toFixed(3))]);
  const transitionIntervals: TimelineInterval[] = [];
  const addTargetBoundary = (value: number): void => {
    if (value > targetStartSeconds && value < targetEndSeconds) {
      addBoundary(boundaries, value, durationSeconds);
    }
  };

  for (const layer of options.layers) {
    const interval = layerInterval(layer, durationSeconds);
    const targetInterval = { startSeconds: targetStartSeconds, endSeconds: targetEndSeconds };
    if (!interval || !overlaps(interval, targetInterval)) {
      continue;
    }
    addTargetBoundary(interval.startSeconds);
    addTargetBoundary(interval.endSeconds);

    const transition = transitionInterval(layer, durationSeconds);
    if (transition && overlaps(transition, targetInterval)) {
      transitionIntervals.push(transition);
      addTargetBoundary(transition.startSeconds);
      addTargetBoundary(layer.startSeconds);
      addTargetBoundary(transition.endSeconds);
    }
  }

  // A STABLE, absolute-time grid is what keeps invalidation local. Because grid lines sit at fixed
  // multiples of `gridStep` (measured from t=0), inserting a clip/overlay only re-cuts the one cell it
  // lands in — every distant cell keeps the exact same [start,end] range (and therefore the same span id
  // and cached proxy). Without this, subdividing each inter-boundary segment by equal parts would shift
  // every downstream range on any edit, orphaning the whole timeline's proxies.
  const hasComplexContent = options.layers.some(
    (layer) => isOverlayLayer(layer) || isEffectLayer(layer) || (layer.transitionIn?.durationSeconds ?? 0) > 0
  );
  const gridStep = Math.max(minSpanSeconds, hasComplexContent ? maxComplexSpanSeconds : maxSimpleSpanSeconds);
  for (let mark = Math.ceil(targetStartSeconds / gridStep) * gridStep; mark < targetEndSeconds; mark += gridStep) {
    addTargetBoundary(Number(mark.toFixed(3)));
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

    const startRounded = Number(startSeconds.toFixed(3));
    const endRounded = Number(endSeconds.toFixed(3));
    spans.push({
      // Grid-stable id: purely time+reason, no layer content — so an edit elsewhere can't change it.
      id: `${startRounded.toFixed(3)}-${endRounded.toFixed(3)}-${reason}`,
      startSeconds: startRounded,
      endSeconds: endRounded,
      reason,
      priority: scoreSpan(interval, reason, options.playheadSeconds),
      layerIds: activeLayers.map((layer) => layer.id),
      contentSignature: spanContentSignature(activeLayers)
    });
  }

  return spans;
}

/**
 * Hash of the layers overlapping one span. Deterministic (layers sorted by id) and limited to the props
 * that actually change the composited pixels, so re-ordering unrelated tracks or editing a distant layer
 * does not perturb an unaffected span's signature.
 */
function spanContentSignature(layers: readonly TimelineCacheLayerInput[]): string {
  const payload = [...layers]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((layer) => ({
      id: layer.id,
      type: layer.type,
      startSeconds: Number(layer.startSeconds.toFixed(3)),
      durationSeconds: Number(layer.durationSeconds.toFixed(3)),
      sourceInSeconds: Number((layer.sourceInSeconds ?? 0).toFixed(3)),
      assetId: layer.assetId ?? "",
      transitionSeconds: layer.transitionIn?.durationSeconds ?? 0,
      effects: layer.effects ?? [],
      masks: layer.masks ?? [],
      keyframes: layer.keyframes ?? [],
      animations: layer.animations ?? []
    }));
  return hashString(stableStringify(payload));
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
      ...(layer.sourceInSeconds !== undefined ? { sourceInSeconds: layer.sourceInSeconds } : {}),
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

/**
 * Base signature for a composition: identity + output format ONLY (no layer content, no duration). This
 * scopes the cache to a project+resolution; per-span `contentSignature` handles layer-level invalidation.
 * Changing quality (renderScale) or opening a different project flips this and prunes the whole store;
 * ordinary timeline edits do NOT.
 */
export function baseCompositionSignature(composition: TimelineComposition, renderScale: number): string {
  return hashString(
    stableStringify({
      compositionId: composition.id,
      width: composition.width,
      height: composition.height,
      fps: composition.fps,
      previewProxyRenderVersion: PREVIEW_PROXY_RENDER_VERSION,
      renderScale: Number(renderScale.toFixed(3))
    })
  );
}

export function previewPluginSignature(value: unknown): string {
  return hashString(stableStringify(value ?? null));
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

  // Release backing proxy media (OPFS/blob) for a span the owner no longer needs. Idempotent per call.
  const disposeMedia = (span: CachedPreviewSpan): void => {
    if (span.url !== undefined || span.byteSize > 0) {
      options.onDisposeSpanMedia?.(span);
    }
  };
  const deleteSpan = (span: CachedPreviewSpan): void => {
    disposeMedia(span);
    entries.delete(span.id);
  };

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
      deleteSpan(evictable);
    }
  };

  return {
    getReadySpan(timeSeconds, signature, renderScale) {
      const match = [...entries.values()]
        .filter((span) => span.signature === signature && span.renderScale === renderScale && span.status === "ready" && span.url !== undefined)
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
          // Media captured for the old content is now invalid — drop the blob but keep the entry so the
          // ruler still shows the range (as dirty) until it is re-rendered.
          disposeMedia(span);
          span.status = "dirty";
          span.url = undefined;
          span.byteSize = 0;
          delete span.liveRanges;
          count += 1;
        }
      }
      return count;
    },
    removeSignature(signature) {
      let count = 0;
      for (const span of [...entries.values()]) {
        if (span.signature === signature) {
          deleteSpan(span);
          count += 1;
        }
      }
      return count;
    },
    reconcile(plan, signature, renderScale, now = Date.now(), scope) {
      // Prune everything from a PREVIOUS composition/quality signature. Without this, changing resolution or
      // opening a different project would leave stale spans in the store. Ordinary edits keep the same base
      // signature (only per-span content signatures change), so this does NOT wipe the timeline on an edit.
      for (const span of [...entries.values()]) {
        if (span.signature !== signature || span.renderScale !== renderScale) {
          deleteSpan(span);
        }
      }

      const wantedIds = new Set<string>();
      const pending: CachedPreviewSpan[] = [];
      for (const planned of plan) {
        const id = cacheSpanKey(signature, renderScale, planned);
        wantedIds.add(id);
        const existing = entries.get(id);
        if (existing) {
          // Same time-range span already tracked. Keep its proxy iff the overlapping content is unchanged
          // AND it is still valid (ready/pending). A dirty/failed span is rebuilt (e.g. forced regen).
          if (
            existing.contentSignature === planned.contentSignature &&
            (existing.status === "ready" || existing.status === "pending")
          ) {
            existing.priority = planned.priority;
            existing.layerIds = planned.layerIds;
            continue;
          }
          // Content within THIS span changed (an edit overlapped it) — invalidate just this one.
          disposeMedia(existing);
          existing.contentSignature = planned.contentSignature;
          existing.reason = planned.reason;
          existing.priority = planned.priority;
          existing.layerIds = planned.layerIds;
          existing.status = "pending";
          existing.url = undefined;
          existing.byteSize = 0;
          delete existing.liveRanges;
          existing.createdAt = now;
          existing.lastUsedAt = now;
          delete existing.error;
          pending.push(existing);
          continue;
        }
        const span: CachedPreviewSpan = {
          id,
          signature,
          contentSignature: planned.contentSignature,
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
        if (wantedIds.has(span.id)) {
          continue;
        }
        // Drop spans the current plan no longer wants so counts reflect the current timeline. But a SCOPED
        // (In/Out) reconcile only planned spans inside `scope` — leave spans outside that window alone, or
        // regenerating a range would nuke the rest of the timeline's proxies.
        if (!scope || overlaps(span, scope)) {
          deleteSpan(span);
        }
      }
      evictIfNeeded();
      return pending.sort(sortByPriority);
    },
    markFrameRendered(input) {
      const frameDurationSeconds = Math.max(1 / 120, input.frameDurationSeconds);
      const frameRange = {
        startSeconds: input.timeSeconds,
        endSeconds: input.timeSeconds + frameDurationSeconds
      };
      const matches = [...entries.values()].filter(
        (span) =>
          span.signature === input.signature &&
          span.renderScale === input.renderScale &&
          span.status !== "ready" &&
          overlaps(span, frameRange)
      );
      let updated: CachedPreviewSpan | undefined;
      for (const span of matches) {
        const range = {
          startSeconds: clamp(Math.max(frameRange.startSeconds, span.startSeconds), span.startSeconds, span.endSeconds),
          endSeconds: clamp(Math.min(frameRange.endSeconds, span.endSeconds), span.startSeconds, span.endSeconds)
        };
        if (range.endSeconds <= range.startSeconds) {
          continue;
        }
        span.liveRanges = mergeLiveRanges(span.liveRanges ?? [], range);
        span.lastUsedAt = input.now ?? Date.now();
        updated = span;
      }
      return updated;
    },
    markSpanReady(input) {
      const span = entries.get(input.id);
      // Reject stale media: the span may have been pruned, or its content changed (an edit landed) while it
      // was rendering in the Worker. Sealing here would show an out-of-date proxy — drop the blob instead.
      if (!span || span.signature !== input.signature || span.contentSignature !== input.contentSignature) {
        options.onDisposeSpanMedia?.({ ...(span ?? ({} as CachedPreviewSpan)), id: input.id, url: input.url, byteSize: input.byteSize } as CachedPreviewSpan);
        return undefined;
      }
      span.url = input.url;
      span.byteSize = Math.max(0, input.byteSize);
      span.status = "ready";
      span.lastUsedAt = input.now ?? Date.now();
      delete span.liveRanges;
      evictIfNeeded();
      return span;
    },
    getReadySpanMedia(timeSeconds, signature, renderScale) {
      const match = [...entries.values()].find(
        (span) =>
          span.signature === signature &&
          span.renderScale === renderScale &&
          span.status === "ready" &&
          span.url !== undefined &&
          containsTime(span, timeSeconds)
      );
      if (!match || match.url === undefined) {
        return undefined;
      }
      match.lastUsedAt = Date.now();
      return { url: match.url, spanStartSeconds: match.startSeconds, spanId: match.id };
    },
    markFailed(id, error) {
      const span = entries.get(id);
      if (!span) {
        return;
      }
      disposeMedia(span);
      span.status = "failed";
      span.url = undefined;
      span.byteSize = 0;
      delete span.liveRanges;
      span.error = error;
    },
    nextPending() {
      return [...entries.values()].filter((span) => span.status === "pending").sort(sortByPriority)[0];
    },
    clear() {
      for (const span of entries.values()) {
        disposeMedia(span);
      }
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
      // Base signature only — per-span content signatures (inside the plan) drive invalidation, so an
      // ordinary edit re-renders just the overlapping spans instead of the whole store.
      const baseSignature = baseCompositionSignature(input.composition, input.renderScale);
      const signature = input.pluginSignature ? `${baseSignature}:${input.pluginSignature}` : baseSignature;
      const plannedSpans = planAdaptiveCacheSpans({
        durationSeconds: input.composition.durationSeconds,
        layers,
        playheadSeconds: input.playheadSeconds,
        ...(input.targetRange !== undefined ? { targetRange: input.targetRange } : {}),
        ...(input.dirtyLayerIds !== undefined ? { dirtyLayerIds: input.dirtyLayerIds } : {}),
        ...(input.minSpanSeconds !== undefined ? { minSpanSeconds: input.minSpanSeconds } : {}),
        ...(input.maxSimpleSpanSeconds !== undefined ? { maxSimpleSpanSeconds: input.maxSimpleSpanSeconds } : {}),
        ...(input.maxComplexSpanSeconds !== undefined ? { maxComplexSpanSeconds: input.maxComplexSpanSeconds } : {})
      });
      const pendingSpans = store.reconcile(plannedSpans, signature, input.renderScale, input.now, input.targetRange);
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
    markFrameRendered(input) {
      return store.markFrameRendered(input);
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
  const segments: PreviewCacheRulerSegment[] = [];
  for (const span of input.entries.filter((entry) => overlaps(entry, visibleRange))) {
    const startSeconds = clamp(Math.max(span.startSeconds, visibleRange.startSeconds), 0, durationSeconds);
    const endSeconds = clamp(Math.min(span.endSeconds, visibleRange.endSeconds), 0, durationSeconds);
    if (endSeconds > startSeconds) {
      const status = span.status === "ready" && span.url === undefined ? "pending" : span.status;
      segments.push({
        id: span.id,
        startPercent: (startSeconds / durationSeconds) * 100,
        endPercent: (endSeconds / durationSeconds) * 100,
        status,
        reason: span.reason,
        priority: span.priority
      });
      if (span.url === undefined) {
        for (const [index, liveRange] of (span.liveRanges ?? []).entries()) {
          const liveStartSeconds = clamp(Math.max(liveRange.startSeconds, visibleRange.startSeconds), 0, durationSeconds);
          const liveEndSeconds = clamp(Math.min(liveRange.endSeconds, visibleRange.endSeconds), 0, durationSeconds);
          if (liveEndSeconds > liveStartSeconds) {
            segments.push({
              id: `${span.id}:live:${index}`,
              startPercent: (liveStartSeconds / durationSeconds) * 100,
              endPercent: (liveEndSeconds / durationSeconds) * 100,
              status: "live",
              reason: span.reason,
              priority: span.priority
            });
          }
        }
      }
    }
  }
  return segments
    .filter((segment) => segment.endPercent > segment.startPercent)
    .sort((a, b) => {
      if (a.startPercent !== b.startPercent) {
        return a.startPercent - b.startPercent;
      }
      const rank = (status: PreviewCacheRulerSegmentStatus): number => (status === "ready" ? 3 : status === "live" ? 2 : 1);
      return rank(a.status) - rank(b.status);
    });
}
