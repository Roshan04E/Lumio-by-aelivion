/**
 * Gate for DEBT-016: a Flarex asset-source MediaIn's cached draw must track the HOST clip's transform
 * across cache hits, not just its media handle.
 *
 * WHY THIS EXISTS. `FlarexSourceDrawCache` (source-draw-cache.ts) keys a bare virtual loader's cached
 * template on `(layerId, comp.version, renderScale)`. `comp.version` bumps only on a Flarex-GRAPH edit
 * (a node/edge/param change inside the comp) — it does NOT bump when the HOST CLIP's own transform is
 * edited from the timeline inspector. Since ADR-020 slice B (38b9c73) a bare loader's transform is
 * INHERITED from the host (`transform: host.transform ?? …`, virtual-layers.ts) rather than a hardcoded
 * identity constant — so a host transform edit changes what the virtual layer's transform SHOULD be,
 * without changing the cache key. The result: the first render after the comp is built populates the
 * cache with whatever the host's transform was at that moment; every subsequent render — including
 * after the user scales/moves the host clip — is a cache HIT that serves the OLD transform. The host's
 * own draw rebuilds fresh every frame (so it moves correctly); the MediaIn inside its comp does not,
 * until something invalidates the cache (a comp-graph edit, or a full reload — a fresh cache instance).
 *
 * This is exactly the founder's repro: drop a clip → scale it → open Flarex, create a comp → add a
 * second media as an asset-source MediaIn → back to the timeline → scale the clip AGAIN. The second
 * scale is the one that exposes it — the comp already exists and its cache is already warm.
 *
 * WHY NO EXISTING FIXTURE CAUGHT THIS. `render:compare:pixels` renders each fixture exactly ONCE per
 * process — structurally unable to exercise a SECOND render against an already-warm cache, regardless
 * of what transform the fixture's host carries. This gate renders the SAME `FlarexSourceDrawCache`
 * instance twice — once to populate it, once after mutating the host's transform — which is the one
 * sequence a single-frame fixture cannot express. (This mirrors flarex-cache-gate.ts's reasoning for
 * why a sequence gate exists alongside the single-frame pixel gate.)
 *
 * FALSIFIED BEFORE THE FIX: with build-scene-draws.ts's `cachedPreFlarexDraw` hit path unpatched (spreads
 * `...template` without rebinding `transform`/`rotateX`/`rotateY`/`perspective`/`z`), the second render's
 * MediaIn transform below reads identity (30/30/0.5 promised, 50/50/1 delivered) — this gate fails.
 *
 * Run: pnpm --filter @orreris/shared sourceCacheTransform:test
 */
import { buildSceneDraws } from "./build-scene-draws";
import { createFlarexComp } from "../flarex/registry";
import { createFlarexNode } from "../flarex/node-defs";
import { collectFlarexVirtualLayers } from "../flarex/virtual-layers";
import { FlarexSourceDrawCache } from "../flarex/source-draw-cache";
import type { SceneLayerDraw } from "../color/scene-compositor";
import type { TimelineLayer } from "../types";

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (ok) console.log(`  ok  ${label}`);
  else {
    failures += 1;
    console.error(`FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const COMP_ID = "comp_srccache_gate";
const HOST_ID = "host_srccache_gate";
const ASSET_ID = "asset_srccache_gate";

/** Comp: ONE asset-source MediaIn wired straight to comp_out (bypasses comp_in — the original
 *  mediaIn(host)/mediaOut nodes stay in `comp.nodes`, unused, exactly like the mismatched-aspect pixel
 *  fixture's construction). The comp's entire output IS this one MediaIn, so `buildSceneDraws` returns
 *  its resolved draw directly at `draws[0]` — no merge/group indirection to unpack. */
function buildComp() {
  const comp = createFlarexComp(COMP_ID, "Source cache transform gate");
  const srcIn = createFlarexNode("mediaIn", `${COMP_ID}_srcin`);
  srcIn.params = { ...srcIn.params, sourceAssetId: ASSET_ID };
  comp.nodes[srcIn.id] = srcIn;
  comp.edges = [
    { id: `${COMP_ID}_e1`, from: { nodeId: srcIn.id, socket: "out" }, to: { nodeId: `${COMP_ID}_out`, socket: "in" } },
  ];
  return comp;
}

function hostLayer(transform: TimelineLayer["transform"]): TimelineLayer {
  return {
    id: HOST_ID,
    trackId: "t",
    type: "video",
    name: "host",
    startSeconds: 0,
    durationSeconds: 5,
    assetId: "host_asset_srccache_gate",
    fit: "cover",
    transform,
    effects: [],
    keyframes: [],
    flarexCompId: COMP_ID,
  };
}

const identityTransform: TimelineLayer["transform"] = { position: { x: 50, y: 50 }, scale: 1, rotation: 0, opacity: 100 };
const movedTransform: TimelineLayer["transform"] = { position: { x: 30, y: 30 }, scale: 0.5, rotation: 0, opacity: 100 };

/** A 1x1 stand-in for every graded media handle — buildSceneDraws never decodes pixels, only reads dims. */
const fakeSource = { width: 1, height: 1 } as unknown as CanvasImageSource;

const comp = buildComp();
const cache = new FlarexSourceDrawCache();
const lookupAsset = () => ({ type: "video" as const, durationSeconds: 5 });

function render(transform: TimelineLayer["transform"]) {
  const layer = hostLayer(transform);
  const virtualLayers = collectFlarexVirtualLayers([layer], { [COMP_ID]: comp }, lookupAsset);
  const draws = buildSceneDraws({
    layers: [layer],
    width: 1080,
    height: 1920,
    currentTime: 1,
    renderScale: 1,
    transitions: [],
    rasterizer: null,
    matteCache: null,
    gradeRenderers: new Map(),
    getMediaGraded: () => fakeSource as never,
    createCanvas: () => ({ width: 0, height: 0 }) as never,
    flarexComps: { [COMP_ID]: comp },
    flarexVirtualLayers: virtualLayers,
    flarexSourceDrawCache: cache,
  });
  return draws[0] as SceneLayerDraw | undefined;
}

// ── Render 1: comp at an IDENTITY host transform — populates the cache (a MISS). ──────────────────────
const draw1 = render(identityTransform);
check("first render (comp just built) produced a draw", Boolean(draw1));
check(
  "first render's MediaIn sits at the host's identity transform",
  draw1?.transform.x === 50 && draw1?.transform.y === 50 && draw1?.transform.scale === 1,
  JSON.stringify(draw1?.transform)
);
check("the cache was populated by the first render", cache.size === 1, `cache.size=${cache.size}`);

// ── Render 2: the HOST clip's transform is mutated — same layer id, same comp (same .version), same
// renderScale, so the cache KEY is unchanged. This is the exact sequence a single-frame fixture cannot
// express: the comp already exists and its cache is already warm when the host is edited. ─────────────
const draw2 = render(movedTransform);
check("second render (host scaled) produced a draw", Boolean(draw2));
check(
  "the cache entry was REUSED across the host-transform edit (same key — proves this exercised the hit path, not a fresh miss)",
  cache.size === 1,
  `cache.size=${cache.size}`
);
check(
  "second render's MediaIn transform reflects the MUTATED host transform, not the one cached on the first render",
  draw2?.transform.x === 30 && draw2?.transform.y === 30 && draw2?.transform.scale === 0.5,
  `got ${JSON.stringify(draw2?.transform)} — a stale value here (50/50/scale 1) means the cache hit served the FIRST render's frozen template`
);

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nflarex source-draw cache transform gate: all checks passed");
