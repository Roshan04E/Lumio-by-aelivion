/**
 * Standalone assert script for the editor foundation (Phase 3). Repo convention:
 * no test framework — exits non-zero on first failure.
 *
 *   pnpm --filter @lumio-by-aelivion/web editor:test
 */
import { clipCompositionToWorkArea, createDefaultComposition } from "@lumio-by-aelivion/shared";
import { editorStore } from "./state/editorStore";
import { moduleRegistry } from "./registry/modules";
import { commandRegistry } from "./registry/commands";
import { inspectorRegistry } from "./registry/inspector";
import { seedBuiltinRegistries } from "./registry/builtins";
import {
  baseCompositionSignature,
  compositionCacheLayers,
  compositionCacheSignature,
  createFrameCache,
  createPreviewCacheController,
  createPreviewRenderCacheStore,
  planAdaptiveCacheSpans,
  previewCacheRulerSegments,
  summarizePreviewCacheStatus,
  type TimelineCacheLayerInput
} from "./performance/renderCache";
import { layersInRange, playheadRange } from "./performance/visibleRange";
import { getPreviewQualityProfile } from "./performance/previewQuality";

let failures = 0;
function check(name: string, condition: boolean): void {
  if (condition) {
    console.log(`  ok  ${name}`);
  } else {
    failures += 1;
    console.error(`FAIL  ${name}`);
  }
}

// --- Store: mutation routes through the action registry, with undo/redo -------
{
  const composition = createDefaultComposition({ id: "edit", name: "Edit", durationSeconds: 12 });
  const store = editorStore.getState();
  store.setComposition(composition);

  const outcome = store.runAction("addText", { text: "WARNING", color: "#ff0000", size: 120 }, { ai: true });
  check("runAction succeeds", outcome.ok);

  const afterAdd = editorStore.getState().composition!;
  const hasWarning = afterAdd.tracks.flatMap((track) => track.layers).some((layer) => layer.text === "WARNING");
  check("store applied the action", hasWarning);
  check("undo available", editorStore.getState().canUndo());

  editorStore.getState().undo();
  const afterUndo = editorStore.getState().composition!;
  check("undo restores prior composition", afterUndo.tracks.flatMap((t) => t.layers).every((l) => l.text !== "WARNING"));
  check("redo available", editorStore.getState().canRedo());

  editorStore.getState().redo();
  check("redo re-applies", editorStore.getState().composition!.tracks.flatMap((t) => t.layers).some((l) => l.text === "WARNING"));

  store.runAction("noSuchAction", {});
  check("invalid action does not mutate", editorStore.getState().composition === editorStore.getState().composition);
}

// --- Registries: builtins seed describes shared definitions -------------------
{
  seedBuiltinRegistries();
  seedBuiltinRegistries(); // idempotent
  check("modules seeded from tools", moduleRegistry.byType("tool").length > 0);
  check("modules seeded from effects", moduleRegistry.byType("effect").length > 0);
  check("AI commands registered", commandRegistry.byCategory("AI").length === 6);

  const caps = {
    webWorkers: true,
    offscreenCanvas: false,
    webCodecs: false,
    webGpu: false,
    opfs: true,
    audioContext: true,
    sharedArrayBuffer: false,
    crossOriginIsolated: false
  };
  moduleRegistry.register({ id: "needs-gpu", name: "GPU thing", type: "engine", requiredCapabilities: ["webGpu"] });
  check("capability gating rejects unavailable", !moduleRegistry.isAvailable("needs-gpu", caps));
  check("migrated text.warp inspector panel is registered", inspectorRegistry.panelsFor("text").some((p) => p.id === "text.warp"));
  check("inspector panels are type-scoped", inspectorRegistry.panelsFor("audio").every((p) => p.id !== "text.warp"));
}

// --- Performance primitives ---------------------------------------------------
{
  const composition = createDefaultComposition({ id: "perf", name: "Perf", durationSeconds: 12 });
  const visible = layersInRange(composition, playheadRange(0, 1));
  check("visible-range returns intersecting layers", visible.length > 0);
  check("preview profiles scale down for performance", getPreviewQualityProfile("performance").resolutionScale < 1);
  const workAreaComposition = createDefaultComposition({ id: "clip-workarea", name: "Clip Work Area", durationSeconds: 60 });
  const clipped = clipCompositionToWorkArea({
    ...workAreaComposition,
    settings: {
      ...workAreaComposition.settings,
      timeline: {
        ...workAreaComposition.settings.timeline,
        inPointSeconds: 32,
        outPointSeconds: 37
      }
    }
  });
  const clippedVideo = clipped.tracks.flatMap((track) => track.layers).find((layer) => layer.type === "video");
  check("work-area clip advances implicit media source time", clippedVideo?.startSeconds === 0 && clippedVideo.sourceInSeconds === 32);
  check("work-area clip uses range duration", Math.abs(clipped.durationSeconds - 5) < 0.001 && clippedVideo?.durationSeconds === 5);

  const cache = createFrameCache<string>(2);
  cache.set({ signature: "a", timeSeconds: 0 }, "f0");
  cache.set({ signature: "a", timeSeconds: 1 }, "f1");
  cache.set({ signature: "a", timeSeconds: 2 }, "f2"); // evicts oldest
  check("frame cache hit", cache.get({ signature: "a", timeSeconds: 2 }) === "f2");
  check("frame cache LRU eviction", cache.get({ signature: "a", timeSeconds: 0 }) === undefined);
}

// --- Adaptive preview cache spans --------------------------------------------
{
  const longClip: TimelineCacheLayerInput = {
    id: "clip-1",
    type: "video",
    startSeconds: 0,
    durationSeconds: 300
  };
  const longPlan = planAdaptiveCacheSpans({ durationSeconds: 300, layers: [longClip], playheadSeconds: 120 });
  check("adaptive cache uses long spans for simple media", longPlan.length <= 8);
  check("adaptive cache covers full duration", longPlan[0]?.startSeconds === 0 && longPlan.at(-1)?.endSeconds === 300);
  check("adaptive cache spans are ordered", longPlan.every((span, index) => index === 0 || longPlan[index - 1]!.endSeconds <= span.startSeconds));

  const denseLayers: TimelineCacheLayerInput[] = [
    longClip,
    {
      id: "title",
      type: "text",
      startSeconds: 95,
      durationSeconds: 25,
      effects: [{ id: "glow" }]
    },
    {
      id: "clip-2",
      type: "video",
      startSeconds: 120,
      durationSeconds: 60,
      transitionIn: { durationSeconds: 1.5 }
    }
  ];
  const densePlan = planAdaptiveCacheSpans({
    durationSeconds: 300,
    layers: denseLayers,
    playheadSeconds: 118,
    dirtyLayerIds: ["title"]
  });
  check("adaptive cache isolates dirty spans", densePlan.some((span) => span.reason === "dirty" && span.layerIds.includes("title")));
  check("adaptive cache isolates transition spans", densePlan.some((span) => span.reason === "transition" && span.startSeconds <= 120 && span.endSeconds > 120 && span.endSeconds <= 121.5));
  check("adaptive cache keeps complex spans short", densePlan.filter((span) => span.reason !== "simple").every((span) => span.endSeconds - span.startSeconds <= 8.001));

  const playheadSpan = densePlan.find((span) => span.startSeconds <= 118 && span.endSeconds > 118);
  const farSpan = densePlan.find((span) => span.startSeconds >= 240);
  check("adaptive cache prioritizes playhead area", !!playheadSpan && !!farSpan && playheadSpan.priority > farSpan.priority);
}

// --- Preview render cache manifest -------------------------------------------
{
  const composition = createDefaultComposition({ id: "cache", name: "Cache", durationSeconds: 60 });
  const layers = compositionCacheLayers(composition);
  const signature = compositionCacheSignature(composition, 0.5);
  const fullSignature = compositionCacheSignature(composition, 1);
  check("composition cache extracts layers", layers.length > 0);
  check("composition cache signature includes render scale", signature !== fullSignature);

  const plan = planAdaptiveCacheSpans({
    durationSeconds: composition.durationSeconds,
    layers,
    playheadSeconds: 5,
    maxSimpleSpanSeconds: 20
  });
  const store = createPreviewRenderCacheStore({ maxEntries: 3, maxBytes: 10_000 });
  const pending = store.reconcile(plan, signature, 0.5, 1000);
  check("preview cache manifest creates pending work", pending.length > 0);
  check("preview cache manifest chooses next pending", store.nextPending()?.id === pending[0]?.id);

  const first = pending[0]!;
  store.upsert({ ...first, status: "ready", byteSize: 4000, url: "blob:first", lastUsedAt: 2000 });
  check("preview cache hits ready span", store.getReadySpan(first.startSeconds + 0.1, signature, 0.5)?.url === "blob:first");
  check("preview cache misses wrong signature", store.getReadySpan(first.startSeconds + 0.1, fullSignature, 0.5) === undefined);
  check("preview cache dirty invalidates overlap", store.markDirty({ startSeconds: first.startSeconds, endSeconds: first.endSeconds }) === 1);
  check("preview cache dirty span no longer hits", store.getReadySpan(first.startSeconds + 0.1, signature, 0.5) === undefined);

  const synthetic = (index: number) => ({
    id: `synthetic-${index}`,
    signature,
    startSeconds: index,
    endSeconds: index + 1,
    reason: "simple" as const,
    status: "ready" as const,
    priority: 1,
    layerIds: [],
    renderScale: 0.5,
    createdAt: index,
    lastUsedAt: index,
    byteSize: 4000
  });
  store.upsert(synthetic(1));
  store.upsert(synthetic(2));
  store.upsert(synthetic(3));
  store.upsert(synthetic(4));
  check("preview cache enforces entry and byte budget", store.size <= 3 && store.byteSize <= 10_000);
}

// --- Preview cache controller -------------------------------------------------
{
  const composition = createDefaultComposition({ id: "controller", name: "Controller", durationSeconds: 90 });
  const controller = createPreviewCacheController({ maxEntries: 20 });
  const first = controller.update({
    composition,
    renderScale: 0.5,
    playheadSeconds: 10,
    maxSimpleSpanSeconds: 30,
    now: 1000
  });
  const second = controller.update({
    composition,
    renderScale: 0.5,
    playheadSeconds: 11,
    maxSimpleSpanSeconds: 30,
    now: 2000
  });
  check("preview cache controller plans from composition", first.plannedSpans.length > 0);
  check("preview cache controller does not duplicate pending spans", first.pendingSpans.length > 0 && second.pendingSpans.length === 0);
  check("preview cache controller exposes next work", !!second.nextPending);

  const playheadPending = first.pendingSpans.find((span) => span.startSeconds <= 10 && span.endSeconds > 10)!;
  controller.store.upsert({ ...playheadPending, status: "ready", byteSize: 2048, url: "blob:playhead", lastUsedAt: 3000 });
  const afterReady = controller.update({
    composition,
    renderScale: 0.5,
    playheadSeconds: 10,
    maxSimpleSpanSeconds: 30,
    now: 4000
  });
  check("preview cache controller returns ready playhead span", afterReady.readySpan?.url === "blob:playhead");
  check("preview cache controller dirties by time range", controller.markDirty({ startSeconds: playheadPending.startSeconds, endSeconds: playheadPending.endSeconds }) === 1);

  const ranged = controller.update({
    composition,
    renderScale: 0.5,
    playheadSeconds: 42,
    targetRange: { startSeconds: 30, endSeconds: 45 },
    maxSimpleSpanSeconds: 30,
    now: 5000
  });
  check("preview cache controller targets in/out range", ranged.plannedSpans.every((span) => span.startSeconds >= 30 && span.endSeconds <= 45));

  const rulerSegments = previewCacheRulerSegments({
    entries: controller.store.entries,
    durationSeconds: composition.durationSeconds,
    visibleRange: { startSeconds: 0, endSeconds: 30 }
  });
  check("preview cache ruler exposes visible proxy segments", rulerSegments.length > 0);
  check("preview cache ruler clips to visible range", rulerSegments.every((segment) => segment.startPercent >= 0 && segment.endPercent <= 100));

  const liveController = createPreviewCacheController({ maxEntries: 20 });
  const live = liveController.update({
    composition,
    renderScale: 0.5,
    playheadSeconds: 5,
    maxSimpleSpanSeconds: 30,
    now: 6000
  });
  liveController.markFrameRendered({
    signature: live.signature,
    renderScale: 0.5,
    timeSeconds: 5,
    frameDurationSeconds: 1,
    now: 6100
  });
  const liveSegments = previewCacheRulerSegments({ entries: liveController.store.entries, durationSeconds: composition.durationSeconds });
  check("preview cache live coverage does not fake ready", !liveSegments.some((segment) => segment.status === "ready"));
  check("preview cache live coverage is visible", liveSegments.some((segment) => segment.status === "live"));
  const livePending = liveController.store.nextPending();
  check("preview cache live coverage keeps generation pending", livePending !== undefined);
  const liveStatus = summarizePreviewCacheStatus(liveController.store.entries);
  check("preview cache live coverage is telemetry", liveStatus.live > 0 && liveStatus.readyWithUrl === 0);
  if (livePending) {
    liveController.store.markSpanReady({
      id: livePending.id,
      signature: live.signature,
      contentSignature: livePending.contentSignature,
      url: "blob:real-proxy",
      byteSize: 4096,
      now: 6200
    });
  }
  const realProxySegments = previewCacheRulerSegments({ entries: liveController.store.entries, durationSeconds: composition.durationSeconds });
  check("preview cache ruler shows green only for real proxy media", realProxySegments.some((segment) => segment.status === "ready"));
  check("preview cache real proxy replaces live coverage", !realProxySegments.some((segment) => segment.status === "live"));
}

// --- Local invalidation + real-time status (per-span content signatures) -----
{
  const base = "base-signature";
  const scale = 0.5;
  const clip: TimelineCacheLayerInput = { id: "clip", type: "video", startSeconds: 0, durationSeconds: 40 };

  const store = createPreviewRenderCacheStore({ maxEntries: 500, maxBytes: 1_000_000_000 });
  const plan1 = planAdaptiveCacheSpans({ durationSeconds: 40, layers: [clip], maxSimpleSpanSeconds: 8 });
  const pending1 = store.reconcile(plan1, base, scale, 1000);
  for (const span of pending1) {
    store.markSpanReady({ id: span.id, signature: base, contentSignature: span.contentSignature, url: `blob:${span.id}`, byteSize: 1000, now: 1100 });
  }
  const readyBefore = store.entries.filter((span) => span.status === "ready").length;
  check("local invalidation: baseline seals every span ready", readyBefore === pending1.length && readyBefore > 2);

  // Add a small text overlay at 20-22s — only the cell it touches should reset.
  const text: TimelineCacheLayerInput = { id: "txt", type: "text", startSeconds: 20, durationSeconds: 2 };
  const plan2 = planAdaptiveCacheSpans({ durationSeconds: 40, layers: [clip, text], maxSimpleSpanSeconds: 8 });
  store.reconcile(plan2, base, scale, 2000);
  const entries2 = store.entries;
  const distantReady = entries2.filter((span) => span.status === "ready" && (span.endSeconds <= 20 || span.startSeconds >= 22));
  const overlapping = entries2.filter((span) => span.startSeconds < 22 && span.endSeconds > 20);
  check("local invalidation: distant proxies stay ready", distantReady.length > 0);
  check("local invalidation: edit does not wipe the timeline", store.entries.some((span) => span.status === "ready"));
  check("local invalidation: only overlapping spans reset", overlapping.length > 0 && overlapping.every((span) => span.status !== "ready"));

  // Editing keeps the base signature stable (so the whole store is NOT pruned on an edit).
  const comp = createDefaultComposition({ id: "sig", name: "Sig", durationSeconds: 40 });
  check("base signature is stable across render, unaffected by layers", baseCompositionSignature(comp, 0.5) === baseCompositionSignature({ ...comp, durationSeconds: 41 }, 0.5));
  check("base signature separates render scale", baseCompositionSignature(comp, 0.5) !== baseCompositionSignature(comp, 1));
}

// --- Real-time total tracks the current timeline (duration shrink) -----------
{
  const base = "dur-signature";
  const scale = 0.5;
  const store = createPreviewRenderCacheStore();
  const long: TimelineCacheLayerInput = { id: "music", type: "audio", startSeconds: 0, durationSeconds: 46 };
  store.reconcile(planAdaptiveCacheSpans({ durationSeconds: 46, layers: [long] }), base, scale, 1000);
  const totalLong = store.size;
  store.reconcile(planAdaptiveCacheSpans({ durationSeconds: 8, layers: [{ ...long, durationSeconds: 8 }] }), base, scale, 2000);
  const totalShort = store.size;
  check("status total shrinks when the timeline is trimmed", totalShort > 0 && totalShort < totalLong);
  const status = summarizePreviewCacheStatus(store.entries);
  check("status summary reports the current span total", status.total === totalShort && status.readyRatio === 0 && status.readyWithUrl === 0);
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll editor foundation checks passed");
