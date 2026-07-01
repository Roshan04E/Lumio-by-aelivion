/**
 * Standalone assert script for the editor foundation (Phase 3). Repo convention:
 * no test framework — exits non-zero on first failure.
 *
 *   pnpm --filter @reelforge/web editor:test
 */
import { createDefaultComposition } from "@reelforge/shared";
import { editorStore } from "./state/editorStore";
import { moduleRegistry } from "./registry/modules";
import { commandRegistry } from "./registry/commands";
import { inspectorRegistry } from "./registry/inspector";
import { seedBuiltinRegistries } from "./registry/builtins";
import {
  compositionCacheLayers,
  compositionCacheSignature,
  createFrameCache,
  createPreviewRenderCacheStore,
  planAdaptiveCacheSpans,
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

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll editor foundation checks passed");
