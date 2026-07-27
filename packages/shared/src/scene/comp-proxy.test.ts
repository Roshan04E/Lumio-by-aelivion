/**
 * Gate for the Flarex comp-proxy substitution (plans/flarex-comp-proxy.md, S2).
 *
 * Two invariants that nothing else protects, and that are both invisible in ordinary use — a broken one
 * shows up as "the preview looks a bit wrong" or, worse, as a silently different EXPORT.
 *
 *   1. EXPORT ISOLATION. A proxy is a lossy derivative; the render manifest is the product contract.
 *      Export must always re-render from the graph. Today that holds because no export path passes
 *      `flarexCompProxies` — a structural fact, so it is asserted structurally, at the source level.
 *      Without this, someone later "helpfully" threading the proxy into export to speed it up would be
 *      a silent correctness regression that every pixel fixture would happily pass, because the fixture
 *      would be rendering through the proxy too.
 *
 *   2. THE PROXY DRAW IS A CLEAN FULL-FRAME QUAD. The flarex hook runs at the END of the layer's draw
 *      build, so the clip's transform, opacity, blend, masks and passes are ALREADY baked into the
 *      comp's MediaIn — and therefore into the rendered proxy. A proxy draw that inherited any of them
 *      would apply them twice. This is the specific mistake avoided by building the draw fresh instead
 *      of spreading the host draw, and it would be near-impossible to spot by eye on a centred,
 *      unrotated clip at 100% opacity.
 *
 * Run: pnpm --filter @orreris/shared compproxy:test
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildSceneDraws } from "./build-scene-draws";
import { createFlarexComp } from "../flarex/registry";
import type { SceneLayerDraw } from "../color/scene-compositor";
import type { TimelineLayer } from "../types";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (ok) console.log(`  ok  ${label}`);
  else {
    failures += 1;
    console.error(`FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

// ── 1. Export isolation ────────────────────────────────────────────────────────────────────────────
// Every renderer that produces a DELIVERABLE. The web preview is deliberately absent: it is the one
// consumer that is supposed to pass proxies.
const EXPORT_PATHS = [
  "apps/web/src/export/export-core.ts",
  "apps/web/src/export/local-export.ts",
  "apps/web/src/export/scene-frame-compositor.ts",
  "apps/worker/src/remotion/SceneStage.tsx",
  "packages/render-templates/src/index.ts",
];

for (const rel of EXPORT_PATHS) {
  let source = "";
  try {
    source = readFileSync(path.join(repoRoot, rel), "utf8");
  } catch {
    // A renamed/removed file must FAIL, not silently pass — a vacuous guard is worse than none.
    check(`export path exists: ${rel}`, false, "could not be read; update EXPORT_PATHS");
    continue;
  }
  check(
    `${rel} never passes flarexCompProxies`,
    !source.includes("flarexCompProxies"),
    "an export path must re-render from the graph — the manifest is the product contract"
  );
}

// ── 2. The substituted draw ────────────────────────────────────────────────────────────────────────
const COMP_ID = "comp_gate";
const HOST_ID = "host_gate";

function hostLayer(overrides: Partial<TimelineLayer> = {}): TimelineLayer {
  return {
    id: HOST_ID,
    trackId: "t",
    type: "video",
    name: "host",
    startSeconds: 0,
    durationSeconds: 5,
    assetId: "asset_gate",
    fit: "fill",
    // Deliberately RICH, and deliberately NOT identity. Every one of these is already baked into the
    // rendered proxy, so each is a field the proxy draw must NOT carry. An earlier version of this gate
    // used a bare layer and consequently passed even when the host draw was spread into the proxy draw —
    // the exact bug it exists to catch. The blur and content transform are what make the leak visible.
    transform: { position: { x: 30, y: 70 }, scale: 1.8, rotation: 25, opacity: 40 },
    effects: [{ id: "e_blur", type: "blur", enabled: true, params: { amount: 40 } }],
    content: { scale: 1.4, pan: { x: 10, y: 5 }, crop: { top: 1, right: 2, bottom: 3, left: 4 } },
    keyframes: [],
    flarexCompId: COMP_ID,
    ...overrides,
  } as TimelineLayer;
}

/** A 1x1 stand-in for both the host's graded media and the decoded proxy frame. */
const fakeSource = { width: 1, height: 1 } as unknown as CanvasImageSource;

function build(withProxy: boolean) {
  const comp = createFlarexComp(COMP_ID, "Gate");
  const layer = hostLayer();
  return buildSceneDraws({
    layers: [layer],
    width: 640,
    height: 360,
    currentTime: 1,
    renderScale: 1,
    transitions: [],
    rasterizer: null,
    matteCache: null,
    gradeRenderers: new Map(),
    getMediaGraded: () => fakeSource as never,
    createCanvas: () => ({ width: 0, height: 0 }) as never,
    flarexComps: { [COMP_ID]: comp },
    ...(withProxy
      ? {
          flarexCompProxies: {
            [COMP_ID]: { source: fakeSource as never, sourceWidth: 640, sourceHeight: 360, sourceVersion: 7 },
          },
        }
      : {}),
  });
}

const withProxy = build(true);
const withoutProxy = build(false);

check("a proxied comp still emits exactly one draw", withProxy.length === 1, `got ${withProxy.length}`);

const proxyDraw = withProxy[0] as SceneLayerDraw | undefined;
if (!proxyDraw) {
  check("proxy draw exists", false);
} else {
  // The host's transform is scale 1.8 / rotation 25 / opacity 40 / position (30,70). Every one of those
  // is already inside the rendered proxy, so the draw that presents it must be neutral.
  const t = proxyDraw.transform;
  check("proxy draw is a full-frame identity quad", t.x === 50 && t.y === 50 && t.scale === 1 && t.rotation === 0, JSON.stringify(t));
  check("proxy draw is fully opaque (host opacity already baked in)", t.opacity === 100, String(t.opacity));
  check("proxy draw uses fit:fill", proxyDraw.fit === "fill", String(proxyDraw.fit));
  check("proxy draw blends normally (host blend already baked in)", proxyDraw.blendMode === "normal", String(proxyDraw.blendMode));
  check("proxy draw carries no inherited mask", !proxyDraw.mask, "a baked-in mask would apply twice");
  check("proxy draw carries no inherited region passes", !proxyDraw.regionPasses?.length);
  check("proxy draw carries no inherited fragment passes", !proxyDraw.fragmentPasses?.length);
  check("proxy draw carries no inherited content transform", !proxyDraw.content, JSON.stringify(proxyDraw.content));
  // The host carries a 40px blur; inheriting it would blur an already-blurred proxy.
  check("proxy draw carries no inherited blur", proxyDraw.blurPx === undefined, String(proxyDraw.blurPx));
  check("proxy draw carries no inherited glow", !proxyDraw.glow);
  // 3D fields ride along on a spread just as quietly as the visible ones.
  check(
    "proxy draw carries no inherited 3D transform",
    proxyDraw.rotateX === undefined && proxyDraw.rotateY === undefined && proxyDraw.perspective === undefined && proxyDraw.z === undefined,
    `rotateX=${proxyDraw.rotateX} rotateY=${proxyDraw.rotateY} perspective=${proxyDraw.perspective} z=${proxyDraw.z}`
  );
  check("proxy draw forwards sourceVersion (skips redundant uploads)", proxyDraw.sourceVersion === 7, String(proxyDraw.sourceVersion));
  check("proxy draw presents the proxy frame itself", proxyDraw.source === (fakeSource as never));
}

// The substitution must actually CHANGE something — a gate that passes because the proxy was ignored
// would assert nothing at all.
const livingDraw = withoutProxy[0] as SceneLayerDraw | undefined;
check(
  "without a proxy the same comp lowers live (the substitution is real)",
  Boolean(livingDraw) && livingDraw !== proxyDraw && livingDraw?.sourceVersion !== 7
);

// An unrelated comp id must not substitute anything — the map is keyed, not a global switch.
const otherComp = createFlarexComp("comp_other", "Other");
const unrelated = buildSceneDraws({
  layers: [hostLayer()],
  width: 640,
  height: 360,
  currentTime: 1,
  renderScale: 1,
  transitions: [],
  rasterizer: null,
  matteCache: null,
  gradeRenderers: new Map(),
  getMediaGraded: () => fakeSource as never,
  createCanvas: () => ({ width: 0, height: 0 }) as never,
  flarexComps: { [COMP_ID]: createFlarexComp(COMP_ID, "Gate"), comp_other: otherComp },
  flarexCompProxies: {
    comp_other: { source: fakeSource as never, sourceWidth: 640, sourceHeight: 360, sourceVersion: 99 },
  },
});
check(
  "a proxy for a DIFFERENT comp never substitutes this one",
  (unrelated[0] as SceneLayerDraw | undefined)?.sourceVersion !== 99
);

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nflarex comp-proxy gate: all checks passed");
