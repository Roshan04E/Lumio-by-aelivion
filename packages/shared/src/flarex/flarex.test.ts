/**
 * Standalone assert script for the Flarex contract (repo convention: no test framework —
 * exits non-zero on failure).
 *
 *   pnpm --filter @orreris/shared flarex:test
 *
 * Phase 0 coverage (FLAREX.md): registry round-trip through JSON persistence, node-def
 * param normalization, edge validation, cycle guard, healer behavior.
 */
import { compileFlarexComp, type FlarexLowerCtx } from "./compile-flarex";
import { computeFlarexContentHashes } from "./content-hash";
import {
  builtinFragmentEffectId,
  FLAREX_CHANNELS_ID,
  FLAREX_CROP_ID,
  FLAREX_GRAIN_ID,
  FLAREX_VIGNETTE_ID,
} from "../color/fragment-effects/builtins";
import { getFragmentEffect, listFragmentEffects } from "../color/fragment-effects/registry";
import { compileNodeGraphIntent, nodeGraphIntentSchema, type NodeGraphIntent } from "./node-graph-intent";
import { planArtifactEviction, type ArtifactRetentionCandidate, type SceneDraw, type SceneGroupDraw, type SceneLayerDraw } from "../color/scene-compositor";
import {
  createFlarexComp,
  getFlarexComp,
  healFlarexRegistry,
  isValidFlarexEdge,
  spliceFlarexNodeIntoEdge,
  stampFlarexComp,
  wouldCreateFlarexCycle,
} from "./registry";
import { createFlarexNode, flarexNodeDefs, parseFlarexNodeParams } from "./node-defs";
import {
  collectFlarexVirtualLayers,
  flarexVirtualLayerId,
  isFlarexGeneratorVirtualLayer,
  soloLayerComposition,
} from "./virtual-layers";
import { CREATIVE_LOOK_NAMES } from "../color/looks";
import type { FlarexComp, FlarexNodeType } from "./types";
import type { Mask, ProjectGraph, TimelineComposition, TimelineLayer } from "../types";
import type { SceneMaskMatteCache } from "../scene/scene-mask-matte";

let failures = 0;
function check(name: string, condition: boolean): void {
  if (condition) {
    console.log(`  ok  ${name}`);
  } else {
    failures += 1;
    console.error(`FAIL  ${name}`);
  }
}

function graphFixture(): ProjectGraph {
  return { projectId: "p1", effects: [], editableFields: {}, version: 1 };
}

// --- Default comp shape ------------------------------------------------------
{
  const comp = createFlarexComp("fx1", "Clip Comp");
  check("default comp has 2 nodes", Object.keys(comp.nodes).length === 2);
  check("default comp wires mediaIn -> mediaOut", comp.edges.length === 1 && isValidFlarexEdge(comp.nodes, comp.edges[0]!));
  check("default comp starts at version 1", comp.version === 1);
}

// --- Param normalization -----------------------------------------------------
{
  const params = parseFlarexNodeParams("merge", {});
  check("merge defaults blend=normal", params.blend === "normal");
  check("merge defaults opacity=1", params.opacity === 1);
  let rejected = false;
  try {
    parseFlarexNodeParams("merge", { nonsense: 1 });
  } catch {
    rejected = true;
  }
  check("strict schema rejects unknown params", rejected);
  const blur = createFlarexNode("blur", "b1");
  check("createFlarexNode fills defaults", blur.params.sigma === 8 && blur.enabled === true);
}

// --- Edge validation + cycle guard ------------------------------------------
{
  const comp = createFlarexComp("fx2", "C");
  const blur = createFlarexNode("blur", "b1");
  comp.nodes[blur.id] = blur;
  check("image->image edge valid", isValidFlarexEdge(comp.nodes, { id: "e1", from: { nodeId: "fx2_in", socket: "out" }, to: { nodeId: "b1", socket: "in" } }));
  check("image->matte edge invalid", !isValidFlarexEdge(comp.nodes, { id: "e2", from: { nodeId: "fx2_in", socket: "out" }, to: { nodeId: "b1", socket: "mask" } }));
  const rect = createFlarexNode("rectMask", "m1");
  comp.nodes[rect.id] = rect;
  check("matte->mask edge valid", isValidFlarexEdge(comp.nodes, { id: "e3", from: { nodeId: "m1", socket: "out" }, to: { nodeId: "b1", socket: "mask" } }));
  check("missing node edge invalid", !isValidFlarexEdge(comp.nodes, { id: "e4", from: { nodeId: "ghost", socket: "out" }, to: { nodeId: "b1", socket: "in" } }));
  comp.edges.push({ id: "e5", from: { nodeId: "fx2_in", socket: "out" }, to: { nodeId: "b1", socket: "in" } });
  check("self edge is a cycle", wouldCreateFlarexCycle(comp, "b1", "b1"));
  check("back edge is a cycle", wouldCreateFlarexCycle(comp, "b1", "fx2_in"));
  check("forward edge is not a cycle", !wouldCreateFlarexCycle(comp, "b1", "fx2_out"));
}

// --- Registry stamp + JSON round-trip ---------------------------------------
{
  let graph = graphFixture();
  const comp = createFlarexComp("fx3", "Round Trip");
  graph = stampFlarexComp(graph, comp);
  check("stamp bumps version", getFlarexComp(graph, "fx3")?.version === 2);
  const revived = JSON.parse(JSON.stringify(graph)) as ProjectGraph;
  check("round-trip deep-equal", JSON.stringify(revived.flarexComps) === JSON.stringify(graph.flarexComps));
  const healedSame = healFlarexRegistry(revived);
  check("healer is a no-op on a sound graph", healedSame === revived);
}

// --- Healer drops broken edges ----------------------------------------------
{
  let graph = graphFixture();
  const comp = createFlarexComp("fx4", "Broken");
  comp.edges.push({ id: "bad", from: { nodeId: "ghost", socket: "out" }, to: { nodeId: "fx4_out", socket: "in" } });
  graph = stampFlarexComp(graph, comp);
  const healed = healFlarexRegistry(graph);
  check("healer drops dangling edge", getFlarexComp(healed, "fx4")?.edges.length === 1);
  const legacy = { ...graph, flarexComps: { fx5: { id: "fx5", name: "Legacy", nodes: {}, edges: [] } as unknown as FlarexComp } };
  const healedLegacy = healFlarexRegistry(legacy as ProjectGraph);
  const fx5 = getFlarexComp(healedLegacy as ProjectGraph, "fx5");
  check("healer fills legacy fields", Array.isArray(fx5?.animations) && fx5?.version === 1);
}

// --- Every node def is internally consistent --------------------------------
{
  for (const def of Object.values(flarexNodeDefs)) {
    const params = parseFlarexNodeParams(def.type, {});
    const keyframeableOk = def.keyframeable.every((key) => typeof params[key] === "number");
    check(`def ${def.type}: keyframeable params are numbers with defaults`, keyframeableOk);
  }
}

// --- Lowering compiler (FLAREX.md Part 4) ------------------------------------
/** `sourceVersion` defaults to a stable number so the host raster is DESCRIBED (cacheable). Pass
 *  `null` — NOT `undefined`, which a JS default parameter would silently replace with the default —
 *  for the unversioned "content may change every frame" declaration; see the 3c-A block. */
function hostDraw(sourceVersion: number | null = 7): SceneLayerDraw {
  return {
    debugLayerId: "host",
    source: { texture: {} as WebGLTexture, width: 1920, height: 1080 },
    sourceWidth: 1920,
    sourceHeight: 1080,
    fit: "cover",
    transform: { x: 50, y: 50, scale: 1, rotation: 0, opacity: 100 },
    blendMode: "normal",
    sourceVersion: sourceVersion ?? undefined,
  };
}
function lowerCtx(host: SceneLayerDraw = hostDraw()): FlarexLowerCtx {
  return {
    compWidth: 1920,
    compHeight: 1080,
    renderScale: 1,
    timeSeconds: 1,
    frameTimeSeconds: 3,
    hostSourceDraw: host,
    matteCache: null,
  };
}
const isGroupDraw = (d: unknown): d is SceneGroupDraw => (d as SceneGroupDraw)?.kind === "group";

type ChainSpec = [FlarexNodeType, Record<string, string | number | boolean>];

/** Compile `mediaIn → [chain of single-input nodes] → mediaOut`. The workhorse for node-family
 *  tests: the interesting assertions are about what the chain COLLAPSES to, not about wiring. */
function chainComp(id: string, specs: ChainSpec[], ctx: FlarexLowerCtx = lowerCtx()) {
  const comp = createFlarexComp(id, id);
  comp.edges = [];
  let prev = `${id}_in`;
  specs.forEach(([type, params], i) => {
    const node = createFlarexNode(type, `${id}_n${i}`);
    node.params = { ...node.params, ...params };
    comp.nodes[node.id] = node;
    comp.edges.push({ id: `${id}_e${i}`, from: { nodeId: prev, socket: "out" }, to: { nodeId: node.id, socket: "in" } });
    prev = node.id;
  });
  comp.edges.push({ id: `${id}_eout`, from: { nodeId: prev, socket: "out" }, to: { nodeId: `${id}_out`, socket: "in" } });
  return compileFlarexComp(comp, ctx);
}

/** How many nested groups deep a result is — i.e. how many render targets the compositor allocates. */
function groupDepth(draw: SceneDraw | null): number {
  let depth = 0;
  let cursor = draw;
  while (cursor && (cursor as SceneGroupDraw).kind === "group") {
    depth += 1;
    cursor = (cursor as SceneGroupDraw).children[0] ?? null;
  }
  return depth;
}

{
  // Default comp (mediaIn → mediaOut) lowers to the host draw untouched (a clone, not the same object).
  const comp = createFlarexComp("c1", "Pass");
  const ctx = lowerCtx();
  const out = compileFlarexComp(comp, ctx);
  check("default comp lowers to a layer draw", Boolean(out) && !isGroupDraw(out));
  check("default comp preserves host source size", (out as SceneLayerDraw).sourceWidth === 1920);
  check("lowering clones (never returns ctx.hostSourceDraw itself)", out !== ctx.hostSourceDraw);
}

// --- Asset-source MediaIn (FLAREX.md Phase 2, Fusion Loader model) ------------
{
  // A SECOND MediaIn loading an asset ("assetA") merged over the host: the compiler must pull the
  // loader's draw through `resolveSourceDraw` (called with the node id + asset id) and place it as fg.
  const comp = createFlarexComp("cmi", "AssetIn");
  const srcIn = createFlarexNode("mediaIn", "cmi_srcin");
  srcIn.params = { ...srcIn.params, sourceAssetId: "assetA" };
  const merge = createFlarexNode("merge", "cmi_merge");
  comp.nodes[srcIn.id] = srcIn;
  comp.nodes[merge.id] = merge;
  comp.edges = [
    { id: "e1", from: { nodeId: "cmi_in", socket: "out" }, to: { nodeId: "cmi_merge", socket: "bg" } },
    { id: "e2", from: { nodeId: "cmi_srcin", socket: "out" }, to: { nodeId: "cmi_merge", socket: "fg" } },
    { id: "e3", from: { nodeId: "cmi_merge", socket: "out" }, to: { nodeId: "cmi_out", socket: "in" } },
  ];
  const requested: Array<[string, string]> = [];
  const source: SceneLayerDraw = { ...hostDraw(), debugLayerId: "assetA", sourceWidth: 640 };
  const out = compileFlarexComp(comp, {
    ...lowerCtx(),
    resolveSourceDraw: (nodeId, assetId) => {
      requested.push([nodeId, assetId]);
      return assetId === "assetA" ? source : null;
    },
  });
  check("asset mediaIn: resolver asked with (nodeId, assetId)", requested.some(([n, a]) => n === "cmi_srcin" && a === "assetA"));
  check("asset mediaIn lowers to a merge group", isGroupDraw(out));
  if (isGroupDraw(out)) {
    const bg = out.children[0] as SceneLayerDraw;
    const fg = out.children[1] as SceneLayerDraw;
    check("asset mediaIn: bg child is the host draw", bg.debugLayerId === "host");
    check("asset mediaIn: fg child is the resolved source (cloned)", fg.debugLayerId === "assetA" && fg.sourceWidth === 640 && fg !== source);
  }
}

{
  // A short source that has run past its own end (`resolveSourceDraw` returns "ended", DISTINCT from
  // null): the MediaIn produces nothing, so the merge drops the fg and only the host bg remains — NOT
  // a held last frame, and NOT a host fall-back for the ended node.
  const comp = createFlarexComp("cme2", "AssetEnded");
  const srcIn = createFlarexNode("mediaIn", "cme2_srcin");
  srcIn.params = { ...srcIn.params, sourceAssetId: "assetA" };
  const merge = createFlarexNode("merge", "cme2_merge");
  comp.nodes[srcIn.id] = srcIn;
  comp.nodes[merge.id] = merge;
  comp.edges = [
    { id: "e1", from: { nodeId: "cme2_in", socket: "out" }, to: { nodeId: "cme2_merge", socket: "bg" } },
    { id: "e2", from: { nodeId: "cme2_srcin", socket: "out" }, to: { nodeId: "cme2_merge", socket: "fg" } },
    { id: "e3", from: { nodeId: "cme2_merge", socket: "out" }, to: { nodeId: "cme2_out", socket: "in" } },
  ];
  const out = compileFlarexComp(comp, { ...lowerCtx(), resolveSourceDraw: () => "ended" });
  check("asset mediaIn: ended source drops the fg (bg-only, no group)", !isGroupDraw(out) && (out as SceneLayerDraw).debugLayerId === "host");
}

{
  // An unresolved asset (loader not decoded / bad id) soft-degrades to the host draw.
  const comp = createFlarexComp("cmf", "AssetFallback");
  const srcIn = createFlarexNode("mediaIn", "cmf_srcin");
  srcIn.params = { ...srcIn.params, sourceAssetId: "ghost" };
  comp.nodes[srcIn.id] = srcIn;
  comp.edges = [{ id: "e1", from: { nodeId: "cmf_srcin", socket: "out" }, to: { nodeId: "cmf_out", socket: "in" } }];
  const out = compileFlarexComp(comp, { ...lowerCtx(), resolveSourceDraw: () => null });
  check("asset mediaIn: unresolved asset falls back to host", Boolean(out) && !isGroupDraw(out) && (out as SceneLayerDraw).debugLayerId === "host");
}

{
  // An empty sourceAssetId is the host input — the resolver must NOT be consulted for it.
  const comp = createFlarexComp("cme", "AssetEmpty");
  let called = false;
  const out = compileFlarexComp(comp, {
    ...lowerCtx(),
    resolveSourceDraw: () => {
      called = true;
      return null;
    },
  });
  check("asset mediaIn: empty sourceAssetId never calls the resolver", !called);
  check("asset mediaIn: empty sourceAssetId lowers to host", !isGroupDraw(out) && (out as SceneLayerDraw).debugLayerId === "host");
}

// --- Virtual loader helper (collectFlarexVirtualLayers) -----------------------
{
  const comp = createFlarexComp("vc", "Virtual");
  const srcIn = createFlarexNode("mediaIn", "vc_srcin");
  srcIn.params = { ...srcIn.params, sourceAssetId: "asset_vid", sourceInSeconds: 2 };
  comp.nodes[srcIn.id] = srcIn;
  const host: TimelineLayer = { id: "hostclip", trackId: "t", type: "video", name: "Host", startSeconds: 5, durationSeconds: 8, flarexCompId: "vc" } as unknown as TimelineLayer;
  const virtuals = collectFlarexVirtualLayers([host], { vc: comp }, (id) => (id === "asset_vid" ? { type: "video", durationSeconds: 30 } : null));
  check("virtual loader: one built for the asset MediaIn", virtuals.length === 1);
  const v = virtuals[0]!;
  check("virtual loader: id is comp+node scoped", v.id === flarexVirtualLayerId("vc", "vc_srcin"));
  check("virtual loader: mirrors host time + carries asset + trim", v.startSeconds === 5 && v.durationSeconds === 8 && v.assetId === "asset_vid" && v.sourceInSeconds === 2 && v.type === "video");
  // The host MediaIn (empty asset) never produces a loader; an unresolved asset is skipped.
  const none = collectFlarexVirtualLayers([host], { vc: comp }, () => null);
  check("virtual loader: unresolved asset produces none", none.length === 0);
}

{
  // in → blur → transform → out : wrap-collapsing folds both into ONE group (blur ≥ transform stage order
  // is transform(4) < blur(5), so transform then blur collapses; blur then transform re-wraps).
  const comp = createFlarexComp("c2", "Chain");
  const t = createFlarexNode("transform", "t1");
  t.params = { ...t.params, x: 10, scale: 1.5 };
  const b = createFlarexNode("blur", "b1");
  b.params = { ...b.params, sigma: 12 };
  comp.nodes[t.id] = t;
  comp.nodes[b.id] = b;
  comp.edges = [
    { id: "e1", from: { nodeId: "c2_in", socket: "out" }, to: { nodeId: "t1", socket: "in" } },
    { id: "e2", from: { nodeId: "t1", socket: "out" }, to: { nodeId: "b1", socket: "in" } },
    { id: "e3", from: { nodeId: "b1", socket: "out" }, to: { nodeId: "c2_out", socket: "in" } },
  ];
  const out = compileFlarexComp(comp, lowerCtx());
  check("transform+blur lowers to one wrap group", isGroupDraw(out));
  if (isGroupDraw(out)) {
    check("wrap shell carries transform", out.shell.transform.x === 60 && out.shell.transform.scale === 1.5);
    check("wrap shell carries blur", out.shell.blurPx === 12);
    check("wrap has the host as its only child", out.children.length === 1);
  }
}

{
  // Keyed fg merged over bg: in → chromaKey → merge.fg, in → merge.bg, merge → out.
  const comp = createFlarexComp("c3", "Key");
  const k = createFlarexNode("chromaKey", "k1");
  const m = createFlarexNode("merge", "m1");
  m.params = { ...m.params, blend: "screen", opacity: 0.8 };
  comp.nodes[k.id] = k;
  comp.nodes[m.id] = m;
  comp.edges = [
    { id: "e1", from: { nodeId: "c3_in", socket: "out" }, to: { nodeId: "k1", socket: "in" } },
    { id: "e2", from: { nodeId: "c3_in", socket: "out" }, to: { nodeId: "m1", socket: "bg" } },
    { id: "e3", from: { nodeId: "k1", socket: "out" }, to: { nodeId: "m1", socket: "fg" } },
    { id: "e4", from: { nodeId: "m1", socket: "out" }, to: { nodeId: "c3_out", socket: "in" } },
  ];
  const out = compileFlarexComp(comp, lowerCtx());
  check("merge lowers to a group with 2 children", isGroupDraw(out) && out.children.length === 2);
  // Setting the blend on `fg` is NOT sufficient: the compositor's precompose rule renders every child
  // of a group as NORMAL, which silently degraded every merge mode to `normal` (a `screen` over a
  // black smoke plate drew an opaque black rectangle). The blend is only carried out if the group
  // ALSO opts out of that rule, so assert the opt-out, not just the value it protects.
  check("merge group preserves child blend", isGroupDraw(out) && out.preserveChildBlend === true);
  if (isGroupDraw(out)) {
    const fg = out.children[1]!;
    check("fg carries the keyer fragment pass", isGroupDraw(fg) && (fg.shell.fragmentPasses?.length ?? 0) === 1);
    if (isGroupDraw(fg)) {
      check("fg blend/opacity applied on its shell", fg.shell.blendMode === "screen" && Math.abs(fg.shell.transform.opacity - 80) < 1e-6);
      check("keyer pass resolves the registered def", fg.shell.fragmentPasses?.[0]?.def.id === "flarex.chromaKey");
    }
    // c3_in feeds BOTH k1.in and m1.bg (fan-out 2), but it is a BARE MediaIn — zero passes, so sealing it
    // would add an identity RTT that dedupes nothing. The cost term of the materialize decision (ADR-010
    // §3, added 2026-07-26 after `flarex:perf` measured this shape 37.5% slower + 7.9MB heavier when
    // fan-out alone forced the seal) leaves it folded. Cheap shared leaves stay layers.
    const bg = out.children[0]!;
    check("a cheap fanned-out MediaIn is NOT sealed (cost term gates fan-out)", !isGroupDraw(bg));
    if (isGroupDraw(bg)) {
      check("fan-out seal is an identity nest (host clone as its only child)", bg.children.length === 1 && !isGroupDraw(bg.children[0]!) && (bg.children[0] as SceneLayerDraw).sourceWidth === 1920);
    }
  }
}

{
  // Shared subtree isolation: one keyer feeding BOTH merge inputs must not cross-mutate.
  const comp = createFlarexComp("c4", "Shared");
  const k = createFlarexNode("chromaKey", "k1");
  const m = createFlarexNode("merge", "m1");
  comp.nodes[k.id] = k;
  comp.nodes[m.id] = m;
  comp.edges = [
    { id: "e1", from: { nodeId: "c4_in", socket: "out" }, to: { nodeId: "k1", socket: "in" } },
    { id: "e2", from: { nodeId: "k1", socket: "out" }, to: { nodeId: "m1", socket: "bg" } },
    { id: "e3", from: { nodeId: "k1", socket: "out" }, to: { nodeId: "m1", socket: "fg" } },
    { id: "e4", from: { nodeId: "m1", socket: "out" }, to: { nodeId: "c4_out", socket: "in" } },
  ];
  const out = compileFlarexComp(comp, lowerCtx());
  check("shared subtree feeds both merge inputs", isGroupDraw(out) && out.children.length === 2);
  if (isGroupDraw(out)) {
    check("consumers got distinct clones", out.children[0] !== out.children[1]);
    const bg = out.children[0]!;
    check("bg shell untouched by fg's blend", isGroupDraw(bg) && bg.shell.blendMode === "normal");
  }
}

{
  // Disabled node passes through; broken graph (no mediaOut input) returns null → caller falls back.
  const comp = createFlarexComp("c5", "Disabled");
  const b = createFlarexNode("blur", "b1");
  b.enabled = false;
  comp.nodes[b.id] = b;
  comp.edges = [
    { id: "e1", from: { nodeId: "c5_in", socket: "out" }, to: { nodeId: "b1", socket: "in" } },
    { id: "e2", from: { nodeId: "b1", socket: "out" }, to: { nodeId: "c5_out", socket: "in" } },
  ];
  const out = compileFlarexComp(comp, lowerCtx());
  check("disabled node passes through (host draw, no wrap)", Boolean(out) && !isGroupDraw(out));
  const broken = createFlarexComp("c6", "Broken");
  broken.edges = [];
  // Fusion contract: nothing wired into MediaOut = intentional "no output" — transparent, never
  // the leaked source (and never null, which would soft-degrade to the plain clip).
  const unwired = compileFlarexComp(broken, lowerCtx());
  check(
    "unwired mediaOut lowers to a transparent draw (no source leak)",
    Boolean(unwired) && (isGroupDraw(unwired!) ? unwired!.shell.transform.opacity === 0 : unwired!.transform.opacity === 0),
  );
  // A WIRED chain that fails deeper (dangling upstream node) keeps the null soft-degrade.
  const dangling = createFlarexComp("c6b", "Dangling");
  dangling.edges = [{ id: "e1", from: { nodeId: "ghost", socket: "out" }, to: { nodeId: "c6b_out", socket: "in" } }];
  check("broken upstream still lowers to null (soft-degrade fallback)", compileFlarexComp(dangling, lowerCtx()) === null);
}

{
  // Determinism: same comp + ctx twice → structurally identical output.
  const comp = createFlarexComp("c7", "Det");
  const g = createFlarexNode("glow", "g1");
  comp.nodes[g.id] = g;
  comp.edges = [
    { id: "e1", from: { nodeId: "c7_in", socket: "out" }, to: { nodeId: "g1", socket: "in" } },
    { id: "e2", from: { nodeId: "g1", socket: "out" }, to: { nodeId: "c7_out", socket: "in" } },
  ];
  const a = compileFlarexComp(comp, lowerCtx());
  const bOut = compileFlarexComp(comp, lowerCtx());
  const strip = (v: unknown) => JSON.stringify(v, (key, val) => (key === "source" ? undefined : val));
  check("lowering is deterministic", strip(a) === strip(bOut));
}

// --- NodeGraphIntent DSL (FLAREX.md Part 7) ----------------------------------
{
  const parsed = nodeGraphIntentSchema.safeParse({
    ops: [
      { op: "key", kind: "chroma", color: "#00b140", spill: 0.6 },
      { op: "glow", radius: 30 },
      { op: "composite", blend: "screen", opacity: 0.9 },
    ],
  });
  check("intent schema accepts a valid program", parsed.success);
  check("intent schema rejects unknown ops", !nodeGraphIntentSchema.safeParse({ ops: [{ op: "explode" }] }).success);
  check("intent schema rejects extra keys", !nodeGraphIntentSchema.safeParse({ ops: [{ op: "blur", sigma: 5, nonsense: 1 }] }).success);
  check("intent schema rejects empty programs", !nodeGraphIntentSchema.safeParse({ ops: [] }).success);

  if (parsed.success) {
    const base = createFlarexComp("aiC", "AI");
    const { comp, ops } = compileNodeGraphIntent(parsed.data as NodeGraphIntent, base);
    check("intent compiles 3 ops to 3 summaries", ops.length === 3);
    // mediaIn + mediaOut + chromaKey + glow + merge = 5 nodes.
    check("intent adds the expected nodes", Object.keys(comp.nodes).length === 5);
    const intoOut = comp.edges.find((e) => e.to.nodeId === "aiC_out");
    const merge = intoOut ? comp.nodes[intoOut.from.nodeId] : undefined;
    check("chain terminates at the merge into MediaOut", merge?.type === "merge");
    check("merge bg comes from clean MediaIn", comp.edges.some((e) => e.to.nodeId === merge?.id && e.to.socket === "bg" && e.from.nodeId === "aiC_in"));
    check("merge carries intent blend/opacity", merge?.params.blend === "screen" && merge?.params.opacity === 0.9);
    check("key node carries spill", Object.values(comp.nodes).some((n) => n.type === "chromaKey" && n.params.spillSuppression === 0.6));
    // Determinism: identical intent + identical base → identical graph JSON.
    const again = compileNodeGraphIntent(parsed.data as NodeGraphIntent, createFlarexComp("aiC", "AI"));
    check("intent compilation is deterministic", JSON.stringify(again.comp) === JSON.stringify(comp));
    // The compiled graph LOWERS (end-to-end: DSL → nodes → SceneDraw).
    const lowered = compileFlarexComp(comp, lowerCtx());
    check("compiled intent graph lowers to draws", lowered !== null && isGroupDraw(lowered));
  }

  // blurRegion builds mask + masked blur wiring.
  const regionParsed = nodeGraphIntentSchema.safeParse({ ops: [{ op: "blurRegion", shape: "ellipse", sigma: 20 }] });
  check("blurRegion parses with defaults", regionParsed.success);
  if (regionParsed.success) {
    const { comp } = compileNodeGraphIntent(regionParsed.data as NodeGraphIntent, createFlarexComp("aiR", "AI"));
    const maskNode = Object.values(comp.nodes).find((n) => n.type === "ellipseMask");
    const blurNode = Object.values(comp.nodes).find((n) => n.type === "blur");
    check("blurRegion creates mask + blur nodes", Boolean(maskNode && blurNode));
    check("mask wires into blur.mask", comp.edges.some((e) => e.from.nodeId === maskNode?.id && e.to.nodeId === blurNode?.id && e.to.socket === "mask"));
  }

  // Extending an EXISTING authored comp appends, never rebuilds.
  const authored = createFlarexComp("aiE", "AI");
  const existingBlur = createFlarexNode("blur", "preblur");
  authored.nodes[existingBlur.id] = existingBlur;
  authored.edges = [
    { id: "e1", from: { nodeId: "aiE_in", socket: "out" }, to: { nodeId: "preblur", socket: "in" } },
    { id: "e2", from: { nodeId: "preblur", socket: "out" }, to: { nodeId: "aiE_out", socket: "in" } },
  ];
  const extended = compileNodeGraphIntent({ ops: [{ op: "glow", radius: 24 }] } as NodeGraphIntent, authored);
  const glowNode = Object.values(extended.comp.nodes).find((n) => n.type === "glow");
  check("extension keeps the existing chain", Boolean(extended.comp.nodes.preblur));
  check("extension splices after the old tail", extended.comp.edges.some((e) => e.from.nodeId === "preblur" && e.to.nodeId === glowNode?.id));
  check("extension re-terminates at MediaOut", extended.comp.edges.some((e) => e.from.nodeId === glowNode?.id && e.to.nodeId === "aiE_out"));
}

// --- View-any-node (previewNodeId re-root) -----------------------------------
{
  const comp = createFlarexComp("v1", "View");
  const b = createFlarexNode("blur", "b1");
  b.params = { ...b.params, sigma: 10 };
  comp.nodes[b.id] = b;
  comp.edges = [
    { id: "e1", from: { nodeId: "v1_in", socket: "out" }, to: { nodeId: "b1", socket: "in" } },
    { id: "e2", from: { nodeId: "b1", socket: "out" }, to: { nodeId: "v1_out", socket: "in" } },
  ];
  comp.previewNodeId = "v1_in";
  const previewed = compileFlarexComp(comp, lowerCtx());
  check("view dot on MediaIn shows the clean plate (no wrap)", Boolean(previewed) && !isGroupDraw(previewed));
  comp.previewNodeId = "ghost";
  const fallback = compileFlarexComp(comp, lowerCtx());
  check("dangling view dot falls back to MediaOut", isGroupDraw(fallback) && fallback.shell.blurPx === 10);
  const healed = healFlarexRegistry({ ...graphFixture(), flarexComps: { v1: comp } });
  check("healer clears a dangling previewNodeId", getFlarexComp(healed, "v1")?.previewNodeId === undefined);

  // Slice 4: the RUNTIME re-root that per-node thumbnails compile through. It must win over the
  // persisted view dot AND leave it untouched, or rendering a thumbnail would move the user's viewer.
  comp.previewNodeId = "v1_out";
  const rooted = compileFlarexComp(comp, { ...lowerCtx(), previewRootNodeId: "v1_in" });
  check("previewRootNodeId re-roots the compile", Boolean(rooted) && !isGroupDraw(rooted));
  check("previewRootNodeId does not mutate the persisted view dot", comp.previewNodeId === "v1_out");
  const rootedDangling = compileFlarexComp(comp, { ...lowerCtx(), previewRootNodeId: "nope" });
  check("a dangling runtime root falls back to MediaOut (a thumbnail pass can't blank the viewer)", isGroupDraw(rootedDangling) && rootedDangling.shell.blurPx === 10);
}

// --- Keyframed node params (Phase 1.5 S2) ------------------------------------
{
  // Blur sigma keyframed 0 → 20 over comp-local t=0..2: the lowered blurPx must track the
  // evaluator sample at each time (parity between what the inspector shows and what renders).
  const comp = createFlarexComp("kf1", "Keyed");
  const b = createFlarexNode("blur", "b1");
  comp.nodes[b.id] = b;
  comp.edges = [
    { id: "e1", from: { nodeId: "kf1_in", socket: "out" }, to: { nodeId: "b1", socket: "in" } },
    { id: "e2", from: { nodeId: "b1", socket: "out" }, to: { nodeId: "kf1_out", socket: "in" } },
  ];
  comp.animations = [
    { id: "k0", target: { scope: "flarexNode", effectId: "b1", property: "sigma" }, timeSeconds: 0, value: 0, interpolation: "linear", temporal: {} },
    { id: "k2", target: { scope: "flarexNode", effectId: "b1", property: "sigma" }, timeSeconds: 2, value: 20, interpolation: "linear", temporal: {} },
  ];
  const ctxAt = (t: number): FlarexLowerCtx => ({ ...lowerCtx(), timeSeconds: t });
  const at0 = compileFlarexComp(comp, ctxAt(0));
  const at1 = compileFlarexComp(comp, ctxAt(1));
  const at2 = compileFlarexComp(comp, ctxAt(2));
  const blurAt = (d: ReturnType<typeof compileFlarexComp>) => (isGroupDraw(d!) ? d!.shell.blurPx ?? 0 : 0);
  check("keyframed blur (sigma>0) lowers to a wrap group", isGroupDraw(at2!));
  check("keyframed blurPx differs across time", blurAt(at0) !== blurAt(at2));
  check("keyframed blurPx matches evaluator at t=0 (0)", Math.abs(blurAt(at0) - 0) < 1e-6);
  check("keyframed blurPx matches evaluator at t=2 (20)", Math.abs(blurAt(at2) - 20) < 1e-6);
  check("keyframed blurPx interpolates at t=1 (10)", Math.abs(blurAt(at1) - 10) < 1e-6);
}

// --- Polygon / Bezier mask nodes (Phase 1.5 S3) ------------------------------
// The compiler only rasterizes a matte through ctx.matteCache (null in `lowerCtx()` = soft
// degrade, no matte attached — the compositor-agnostic contract these tests want to verify).
// A stub cache records what `Mask[]` it was asked to rasterize, so we can assert on the vector
// matte structure the polygon/bezier/matteControl nodes BUILD, without a real GL canvas.
function stubMatteCache(): { cache: SceneMaskMatteCache; calls: Mask[][] } {
  const calls: Mask[][] = [];
  const cache = {
    get(layerLike: { masks: Mask[] }) {
      calls.push(layerLike.masks);
      return {} as TexImageSource;
    },
    versionOf() {
      return 1;
    },
  } as unknown as SceneMaskMatteCache;
  return { cache, calls };
}

{
  // Polygon node lowers to a matte with the parsed point count, points scaled to comp px.
  const comp = createFlarexComp("m1", "Poly");
  const poly = createFlarexNode("polygonMask", "p1");
  poly.params = { ...poly.params, points: "[[0.1,0.1],[0.9,0.1],[0.9,0.9],[0.1,0.9],[0.5,0.5]]" };
  const blur = createFlarexNode("blur", "b1");
  comp.nodes[poly.id] = poly;
  comp.nodes[blur.id] = blur;
  comp.edges = [
    { id: "e1", from: { nodeId: "m1_in", socket: "out" }, to: { nodeId: "b1", socket: "in" } },
    { id: "e2", from: { nodeId: "p1", socket: "out" }, to: { nodeId: "b1", socket: "mask" } },
    { id: "e3", from: { nodeId: "b1", socket: "out" }, to: { nodeId: "m1_out", socket: "in" } },
  ];
  const { cache, calls } = stubMatteCache();
  const out = compileFlarexComp(comp, { ...lowerCtx(), matteCache: cache });
  // Masked blur lowers to a region pass (not shell.mask — that's the whole-shell mask path used
  // by nodes without their own masked-region primitive), carrying the rasterized matte texture.
  check("polygon mask wires into blur.mask (region pass carries the matte)", isGroupDraw(out!) && Boolean(out!.shell.regionPasses?.[0]?.mask));
  check("polygon node lowers to a matte with 5 points", calls[0]?.[0]?.points.length === 5);
  check("polygon points scale to comp px", calls[0]?.[0]?.points[0]?.x === 0.1 * 1920 && calls[0]?.[0]?.points[0]?.y === 0.1 * 1080);
}

{
  // Bad points JSON soft-degrades to the default 3-point triangle — never throws.
  const comp = createFlarexComp("m2", "BadPoly");
  const poly = createFlarexNode("polygonMask", "p1");
  poly.params = { ...poly.params, points: "not json{{{" };
  const blur = createFlarexNode("blur", "b1");
  comp.nodes[poly.id] = poly;
  comp.nodes[blur.id] = blur;
  comp.edges = [
    { id: "e1", from: { nodeId: "m2_in", socket: "out" }, to: { nodeId: "b1", socket: "in" } },
    { id: "e2", from: { nodeId: "p1", socket: "out" }, to: { nodeId: "b1", socket: "mask" } },
    { id: "e3", from: { nodeId: "b1", socket: "out" }, to: { nodeId: "m2_out", socket: "in" } },
  ];
  const { cache, calls } = stubMatteCache();
  let threw = false;
  try {
    compileFlarexComp(comp, { ...lowerCtx(), matteCache: cache });
  } catch {
    threw = true;
  }
  check("bad points JSON never throws", !threw);
  check("bad points JSON soft-degrades to the default triangle (3 points)", calls[0]?.[0]?.points.length === 3);
}

{
  // MatteControl combines a polygon matte with a rect matte (2 masks reach the rasterizer).
  const comp = createFlarexComp("m3", "Combine");
  const poly = createFlarexNode("polygonMask", "p1");
  const rect = createFlarexNode("rectMask", "r1");
  const mc = createFlarexNode("matteControl", "mc1");
  const blur = createFlarexNode("blur", "b1");
  comp.nodes[poly.id] = poly;
  comp.nodes[rect.id] = rect;
  comp.nodes[mc.id] = mc;
  comp.nodes[blur.id] = blur;
  comp.edges = [
    { id: "e1", from: { nodeId: "p1", socket: "out" }, to: { nodeId: "mc1", socket: "a" } },
    { id: "e2", from: { nodeId: "r1", socket: "out" }, to: { nodeId: "mc1", socket: "b" } },
    { id: "e3", from: { nodeId: "m3_in", socket: "out" }, to: { nodeId: "b1", socket: "in" } },
    { id: "e4", from: { nodeId: "mc1", socket: "out" }, to: { nodeId: "b1", socket: "mask" } },
    { id: "e5", from: { nodeId: "b1", socket: "out" }, to: { nodeId: "m3_out", socket: "in" } },
  ];
  const { cache, calls } = stubMatteCache();
  const out = compileFlarexComp(comp, { ...lowerCtx(), matteCache: cache });
  check("matteControl combines a polygon matte with a rect matte", isGroupDraw(out!) && calls[0]?.length === 2);
}

// --- spliceFlarexNodeIntoEdge (Sonnet round 2, N5 — round-1 leftover) --------
{
  // Valid splice: blur wired in -> out; splicing sharpen into that edge produces 2 valid edges
  // (in -> sharpen -> out) and removes the original.
  const comp = createFlarexComp("sp1", "Splice");
  const sharpen = createFlarexNode("sharpen", "sh1");
  comp.nodes[sharpen.id] = sharpen;
  const originalEdge = { id: "e1", from: { nodeId: "sp1_in", socket: "out" }, to: { nodeId: "sp1_out", socket: "in" } };
  comp.edges = [originalEdge];
  const spliced = spliceFlarexNodeIntoEdge(comp, "sh1", "e1");
  check("valid splice returns a comp", spliced !== null);
  if (spliced) {
    check("original edge is removed", !spliced.edges.some((e) => e.id === "e1"));
    check("splice produces exactly 2 edges", spliced.edges.length === 2);
    check("both new edges are valid", spliced.edges.every((e) => isValidFlarexEdge(spliced.nodes, e)));
    check("in -> sharpen edge exists", spliced.edges.some((e) => e.from.nodeId === "sp1_in" && e.to.nodeId === "sh1"));
    check("sharpen -> out edge exists", spliced.edges.some((e) => e.from.nodeId === "sh1" && e.to.nodeId === "sp1_out"));
  }

  // Matte-only node (rectMask, image-in-image-out has no image input) on an IMAGE wire -> null.
  const comp2 = createFlarexComp("sp2", "MatteOnSplice");
  const rect = createFlarexNode("rectMask", "r1");
  comp2.nodes[rect.id] = rect;
  comp2.edges = [{ id: "e1", from: { nodeId: "sp2_in", socket: "out" }, to: { nodeId: "sp2_out", socket: "in" } }];
  check("matte-only node on an image wire -> null", spliceFlarexNodeIntoEdge(comp2, "r1", "e1") === null);

  // Already-wired input: the target node's only image input is already taken by another wire.
  const comp3 = createFlarexComp("sp3", "AlreadyWired");
  const blurA = createFlarexNode("blur", "bA");
  const blurB = createFlarexNode("blur", "bB");
  comp3.nodes[blurA.id] = blurA;
  comp3.nodes[blurB.id] = blurB;
  comp3.edges = [
    { id: "e1", from: { nodeId: "sp3_in", socket: "out" }, to: { nodeId: "bA", socket: "in" } },
    { id: "e2", from: { nodeId: "bA", socket: "out" }, to: { nodeId: "bB", socket: "in" } },
    { id: "e3", from: { nodeId: "bB", socket: "out" }, to: { nodeId: "sp3_out", socket: "in" } },
  ];
  // bA's "in" socket is already wired (e1) — splicing it into e3 (bB -> out) has no free input.
  check("already-wired input -> null", spliceFlarexNodeIntoEdge(comp3, "bA", "e3") === null);

  // Edge endpoint IS the node itself -> null (splicing a node into its own wire is nonsensical).
  const comp4 = createFlarexComp("sp4", "SelfEdge");
  const blur4 = createFlarexNode("blur", "b1");
  comp4.nodes[blur4.id] = blur4;
  comp4.edges = [
    { id: "e1", from: { nodeId: "sp4_in", socket: "out" }, to: { nodeId: "b1", socket: "in" } },
    { id: "e2", from: { nodeId: "b1", socket: "out" }, to: { nodeId: "sp4_out", socket: "in" } },
  ];
  check("edge endpoint = the node itself -> null", spliceFlarexNodeIntoEdge(comp4, "b1", "e1") === null);
  check("edge endpoint = the node itself -> null (other side)", spliceFlarexNodeIntoEdge(comp4, "b1", "e2") === null);
}

// --- Curves / Hue-Sat nodes lower for real (Sonnet round 2, N2) -------------
{
  // A strong S-curve master channel must produce a REAL (non-identity) color pipeline wrap —
  // guards the node-storage-key vs. effect-registry-param-key mismatch (`curve` vs `curves`).
  const comp = createFlarexComp("cc1", "Curves");
  const curves = createFlarexNode("colorCurves", "cv1");
  curves.params = {
    ...curves.params,
    curves: JSON.stringify({ master: [{ x: 0, y: 0 }, { x: 0.25, y: 0.05 }, { x: 0.75, y: 0.95 }, { x: 1, y: 1 }] }),
  };
  comp.nodes[curves.id] = curves;
  comp.edges = [
    { id: "e1", from: { nodeId: "cc1_in", socket: "out" }, to: { nodeId: "cv1", socket: "in" } },
    { id: "e2", from: { nodeId: "cv1", socket: "out" }, to: { nodeId: "cc1_out", socket: "in" } },
  ];
  const out = compileFlarexComp(comp, lowerCtx());
  check("colorCurves node lowers to a pipeline wrap", isGroupDraw(out!) && Boolean(out!.pipeline) && out!.pipeline?.identity !== true);

  const comp2 = createFlarexComp("hs1", "HueSat");
  const hueSat = createFlarexNode("hueSat", "hs1");
  hueSat.params = {
    ...hueSat.params,
    hueCurves: JSON.stringify({ hueVsSat: [{ x: 0, y: 0.2 }, { x: 1, y: 0.8 }] }),
  };
  comp2.nodes[hueSat.id] = hueSat;
  comp2.edges = [
    { id: "e1", from: { nodeId: "hs1_in", socket: "out" }, to: { nodeId: "hs1", socket: "in" } },
    { id: "e2", from: { nodeId: "hs1", socket: "out" }, to: { nodeId: "hs1_out", socket: "in" } },
  ];
  const out2 = compileFlarexComp(comp2, lowerCtx());
  check("hueSat node lowers to a pipeline wrap", isGroupDraw(out2!) && Boolean(out2!.pipeline) && out2!.pipeline?.identity !== true);

  // Empty payload still passes through untouched (no throw, no wrap).
  const comp3 = createFlarexComp("cc2", "EmptyCurves");
  const emptyCurves = createFlarexNode("colorCurves", "cv2");
  comp3.nodes[emptyCurves.id] = emptyCurves;
  comp3.edges = [
    { id: "e1", from: { nodeId: "cc2_in", socket: "out" }, to: { nodeId: "cv2", socket: "in" } },
    { id: "e2", from: { nodeId: "cv2", socket: "out" }, to: { nodeId: "cc2_out", socket: "in" } },
  ];
  const out3 = compileFlarexComp(comp3, lowerCtx());
  check("empty colorCurves payload passes through untouched", Boolean(out3) && !isGroupDraw(out3));
}

// --- Colour node family + pipeline coalescing (P1) --------------------------
{
  const WHEELS = JSON.stringify({
    shadows: { x: 0, y: 0, master: 0 },
    midtones: { x: 0.25, y: -0.2, master: 0.15 },
    highlights: { x: 0, y: 0, master: 0 },
  });
  const SECONDARY = JSON.stringify({ hueCenter: 0.35, hueWidth: 0.08, softness: 0.05, satScale: 0 });
  const CURVES = JSON.stringify({ master: [{ x: 0, y: 0 }, { x: 0.25, y: 0.05 }, { x: 0.75, y: 0.95 }, { x: 1, y: 1 }] });
  const HUE_CURVES = JSON.stringify({ hueVsSat: [{ x: 0, y: 0.5 }, { x: 0.35, y: 0.8 }, { x: 1, y: 0.5 }] });

  const chain = chainComp;

  // THE regression test for the shipped Color Correct default bug: a freshly added node must be a
  // NO-OP. Its saturation default used to be 1 on a scale where 100 is neutral, so every new Color
  // Correct node silently desaturated the image to ~1%.
  const fresh = chain("ccdef", [["colorCorrect", {}]]);
  check("fresh Color Correct is a no-op (saturation default is on the effect's own scale)", Boolean(fresh) && !isGroupDraw(fresh));

  // …and it still grades when actually dialled in.
  const graded = chain("ccval", [["colorCorrect", { exposure: 40, saturation: 140 }]]);
  check("Color Correct with values lowers to a real pipeline", isGroupDraw(graded!) && graded!.pipeline?.identity !== true);

  // Each new table-driven colour node reaches the grade engine with the right effect param key.
  const wheels = chain("cw", [["colorWheels", { wheels: WHEELS }]]);
  check("colorWheels node lowers to a pipeline wrap", isGroupDraw(wheels!) && wheels!.pipeline?.identity !== true);
  const qualifier = chain("hq", [["hslQualifier", { secondary: SECONDARY }]]);
  check("hslQualifier node lowers to a pipeline wrap", isGroupDraw(qualifier!) && qualifier!.pipeline?.identity !== true);
  const look = chain("lk", [["look", { look: CREATIVE_LOOK_NAMES[0] ?? "" }]]);
  check("look node lowers to a pipeline wrap", isGroupDraw(look!) && look!.pipeline?.identity !== true);

  // Unconfigured payloads pass through untouched (never a wrap, never a throw).
  check("empty wheels payload passes through", !isGroupDraw(chain("cw0", [["colorWheels", {}]])));
  check("empty qualifier payload passes through", !isGroupDraw(chain("hq0", [["hslQualifier", {}]])));
  check("empty look passes through", !isGroupDraw(chain("lk0", [["look", {}]])));
  check("empty LUT passes through", !isGroupDraw(chain("lut0", [["lut", {}]])));

  // P1 — the whole point: four DIFFERENT colour nodes in series must bake into ONE pipeline on ONE
  // group. Before coalescing this was four nested groups = four RTTs + four full-frame composites,
  // which is what made a grade chain unusable on an integrated GPU.
  const coalesced = chain("coal", [
    ["colorWheels", { wheels: WHEELS }],
    ["colorCurves", { curves: CURVES }],
    ["hslQualifier", { secondary: SECONDARY }],
    ["colorCorrect", { exposure: 25 }],
  ]);
  check("P1: a 4-node colour chain coalesces into ONE group", groupDepth(coalesced) === 1);
  check("P1: the coalesced group carries a real pipeline", isGroupDraw(coalesced!) && coalesced!.pipeline?.identity !== true);

  // Refusals — each must open a fresh nest rather than silently reorder the grade.
  // (a) Two of the SAME stage: the engine would collapse them, so they must not fold together.
  const sameStage = chain("same", [["colorCorrect", { exposure: 30 }], ["colorCorrect", { saturation: 150 }]]);
  check("P1: two Color Corrects do NOT coalesce (one stage cannot hold both)", groupDepth(sameStage) === 2);
  // (b) A later-stage op already landed on the wrap: the pipeline runs FIRST in shell order, so
  //     folding in would jump the colour node ahead of the transform the user put before it.
  const afterTransform = chain("ord", [
    ["colorWheels", { wheels: WHEELS }],
    ["transform", { scale: 1.4 }],
    ["colorCorrect", { exposure: 30 }],
  ]);
  check("P1: a colour node after a Transform opens a new nest (order is preserved)", groupDepth(afterTransform) === 2);

  // Determinism (the compiler's core contract) holds for the coalesced path too.
  const strip = (v: unknown) => JSON.stringify(v, (key, val) => (key === "source" ? undefined : val));
  const detSpecs: ChainSpec[] = [["colorWheels", { wheels: WHEELS }], ["colorCorrect", { exposure: 25 }]];
  check("P1: coalesced lowering is deterministic", strip(chain("det", detSpecs)) === strip(chain("det", detSpecs)));

  // ── The unified `color` node ───────────────────────────────────────────────
  // THE gate for the whole idea: one Color node carrying every stage must lower to the SAME grade as
  // the equivalent chain of atomic nodes. If this holds, the unified node is a new UI over the same
  // math — not a second colour implementation that can drift from the first.
  const unified = chain("uni", [[
    "color",
    {
      exposure: 25, saturation: 140,
      wheels: WHEELS, curves: CURVES, hueCurves: HUE_CURVES, secondary: SECONDARY,
      look: CREATIVE_LOOK_NAMES[0] ?? "",
    },
  ]]);
  // The atoms, wired in the order `buildUnifiedColorEffects` declares (primary → wheels → curves →
  // hue/sat → qualifier → LUT → look). That order IS the contract this pins.
  const equivalent = chain("eqv", [
    ["colorCorrect", { exposure: 25, saturation: 140 }],
    ["colorWheels", { wheels: WHEELS }],
    ["colorCurves", { curves: CURVES }],
    ["hueSat", { hueCurves: HUE_CURVES }],
    ["hslQualifier", { secondary: SECONDARY }],
    ["look", { look: CREATIVE_LOOK_NAMES[0] ?? "" }],
  ]);
  const pipelineOf = (d: SceneDraw | null) => (d && isGroupDraw(d) ? JSON.stringify(d.pipeline) : null);
  check("unified Color node lowers to ONE group (every stage in one pipeline)", groupDepth(unified) === 1);
  check("the equivalent 6-node chain also coalesces to one group", groupDepth(equivalent) === 1);
  check("UNIFIED == CHAIN: identical compiled pipeline", pipelineOf(unified) !== null && pipelineOf(unified) === pipelineOf(equivalent));

  // A fresh Color node must be a true pass-through — not an identity grade pass. It is the state
  // every newly-added node is in, and an RTT for "I haven't decided yet" is exactly the cost the
  // low-end target cannot afford.
  check("a fresh Color node is a no-op (no wrap at all)", !isGroupDraw(chain("uni0", [["color", {}]])));
  check("a Color node with only a neutral saturation is still a no-op",
    !isGroupDraw(chain("uni1", [["color", { saturation: 100 }]])));

  // Film stages ride as FRAGMENT PASSES (a group grade compiles with mediaEffects: null, so they can
  // never be pipeline stages) — and must not drag in a grade pipeline when they are the only thing set.
  const filmOnly = chain("unif", [["color", { vignetteAmount: 0.5, grainAmount: 0.2 }]]);
  check("film-only Color node emits fragment passes", isGroupDraw(filmOnly!) && (filmOnly!.shell.fragmentPasses ?? []).length === 2);
  check("film-only Color node has NO grade pipeline", isGroupDraw(filmOnly!) && !filmOnly!.pipeline);
  check("film passes get distinct effect keys",
    isGroupDraw(filmOnly!) &&
      new Set((filmOnly!.shell.fragmentPasses ?? []).map((p) => p.effectKey)).size === 2);
  check("grade + film share ONE group (film does not open a nest)",
    groupDepth(chain("unig", [["color", { exposure: 20, vignetteAmount: 0.4 }]])) === 1);

  // It coalesces with atoms too — the two families are one pipeline, in wiring order.
  check("a unified node and an atom downstream still make one group",
    groupDepth(chain("unic", [["color", { exposure: 10 }], ["colorCurves", { curves: CURVES }]])) === 1);
  // …and refuses when a stage type would repeat, exactly like the atoms do.
  check("a unified node followed by a REPEATED stage opens a nest",
    groupDepth(chain("unir", [["color", { wheels: WHEELS }], ["colorWheels", { wheels: WHEELS }]])) === 2);

  check("unified lowering is deterministic",
    strip(chain("unid", [["color", { exposure: 25, wheels: WHEELS }]])) === strip(chain("unid", [["color", { exposure: 25, wheels: WHEELS }]])));
}

// --- Generator nodes (Text+ / Background) ----------------------------------
{
  // A generator is backed by a virtual TEXT/SHAPE layer that the renderers rasterize, pulled through
  // the SAME `resolveSourceDraw` seam as an asset-source MediaIn.
  const host: TimelineLayer = {
    id: "host", trackId: "t1", type: "video", name: "host", startSeconds: 4, durationSeconds: 6,
    assetId: "asset_vid", flarexCompId: "gc",
  } as unknown as TimelineLayer;

  const comp = createFlarexComp("gc", "Generators");
  const text = createFlarexNode("text", "txt");
  text.params = { ...text.params, content: "Hello", fontSize: 120, color: "#ff0000", align: "left", x: 0.25, y: 0.75 };
  const bg = createFlarexNode("background", "bgn");
  bg.params = { ...bg.params, color: "#123456", opacity: 0.5 };
  comp.nodes[text.id] = text;
  comp.nodes[bg.id] = bg;

  const virtuals = collectFlarexVirtualLayers([host], { gc: comp }, () => null);
  check("generators produce virtual layers with no asset lookup", virtuals.length === 2);
  const textLayer = virtuals.find((l) => l.id === flarexVirtualLayerId("gc", "txt"));
  const bgLayer = virtuals.find((l) => l.id === flarexVirtualLayerId("gc", "bgn"));
  check("Text+ is backed by a TEXT layer carrying its content", textLayer?.type === "text" && textLayer?.text === "Hello");
  check("Text+ carries font + colour + align to the rasterizer", textLayer?.fontSize === 120 && textLayer?.color === "#ff0000" && textLayer?.textAlign === "left");
  check("Background is backed by a comp-filling SHAPE layer", bgLayer?.type === "shape" && bgLayer?.widthPercent === 100 && bgLayer?.heightPercent === 100 && bgLayer?.color === "#123456");
  // Placement/opacity must NOT be baked onto the layer — the compiler applies them, keyframe-aware.
  check("generator layers stay transform-neutral (placement is the compiler's job)",
    textLayer?.transform?.position.x === 50 && textLayer?.transform?.position.y === 50 && bgLayer?.transform?.opacity === 100);
  // A generator has no media of its own, so it spans the whole host clip and never "ends".
  check("generator layers span the host clip", textLayer?.startSeconds === 4 && textLayer?.durationSeconds === 6);
  // The mount guard: callers that attach decoders must skip these.
  check("generator layers are flagged as rasterized, not decoded",
    isFlarexGeneratorVirtualLayer(textLayer!) && isFlarexGeneratorVirtualLayer(bgLayer!));

  // Lowering: Background under Text through a Merge, with the generators resolved.
  const merge = createFlarexNode("merge", "mrg");
  comp.nodes[merge.id] = merge;
  comp.edges = [
    { id: "e1", from: { nodeId: "bgn", socket: "out" }, to: { nodeId: "mrg", socket: "bg" } },
    { id: "e2", from: { nodeId: "txt", socket: "out" }, to: { nodeId: "mrg", socket: "fg" } },
    { id: "e3", from: { nodeId: "mrg", socket: "out" }, to: { nodeId: "gc_out", socket: "in" } },
  ];
  const resolved = compileFlarexComp(comp, {
    ...lowerCtx(),
    resolveSourceDraw: (nodeId) => ({ ...hostDraw(), debugLayerId: nodeId }),
  });
  check("Text+ over Background lowers to a merge group", isGroupDraw(resolved!) && resolved!.children.length === 2);
  if (isGroupDraw(resolved)) {
    const bgDraw = resolved.children[0] as SceneLayerDraw;
    const txtDraw = resolved.children[1] as SceneLayerDraw;
    check("each generator pulls ITS OWN virtual layer", bgDraw.debugLayerId === "bgn" && txtDraw.debugLayerId === "txt");
    // x/y are comp fractions; the composite quad takes percent.
    check("Text+ placement is applied to the composite quad", txtDraw.transform.x === 25 && txtDraw.transform.y === 75);
    check("Background opacity is applied to the composite quad", bgDraw.transform.opacity === 50);
    // Free by construction: the generator is a bare layer draw, so placement opens no nest.
    check("generator placement costs no extra nest", groupDepth(resolved) === 1);
  }

  // An unresolved generator produces NOTHING — it must never fall back to the host clip the way an
  // asset-source MediaIn does (a Text node that showed the footage instead of the text would be worse
  // than a missing title). With only the Background resolving, the merge keeps just the background.
  const halfResolved = compileFlarexComp(comp, {
    ...lowerCtx(),
    resolveSourceDraw: (nodeId) => (nodeId === "bgn" ? { ...hostDraw(), debugLayerId: "bgn" } : null),
  });
  check("an unresolved generator drops out of the merge (never the host clip)",
    Boolean(halfResolved) && !isGroupDraw(halfResolved) && (halfResolved as SceneLayerDraw).debugLayerId === "bgn");

  // With NOTHING resolvable the graph yields no image at all → null, the compiler's documented
  // soft-degrade (the caller then draws the plain clip, so a broken comp never blacks out an export).
  check("a wholly unresolved generator comp degrades to null, not to a host draw",
    compileFlarexComp(comp, { ...lowerCtx(), resolveSourceDraw: () => null }) === null);
}

// --- Builtin-wrapping filter nodes -----------------------------------------
{
  const passesOf = (draw: ReturnType<typeof chainComp>) => (draw && isGroupDraw(draw) ? draw.shell.fragmentPasses ?? [] : []);

  // Each node resolves its builtin and scales its normalized param into the builtin's own range.
  const dir = passesOf(chainComp("fdb", [["directionalBlur", { amount: 0.5, angle: 45 }]]));
  check("directionalBlur node resolves its builtin", dir[0]?.def.id === builtinFragmentEffectId("directionalBlur"));
  check("directionalBlur scales 0..1 amount to the builtin's 0..100", dir[0]?.params.amount === 50 && dir[0]?.params.angle === 45);

  const rad = passesOf(chainComp("frb", [["radialBlur", { amount: 0.25, centerX: 0.25, centerY: 0.75 }]]));
  check("radialBlur node resolves its builtin", rad[0]?.def.id === builtinFragmentEffectId("radialBlur"));
  check("radialBlur maps comp-fraction centre to the builtin's percent", rad[0]?.params.centerX === 25 && rad[0]?.params.centerY === 75);

  const pix = passesOf(chainComp("fpx", [["pixelate", { blockSize: 32 }]]));
  check("pixelate node passes blockSize through in pixels", pix[0]?.def.id === builtinFragmentEffectId("pixelate") && pix[0]?.params.blockSize === 32);

  const pri = passesOf(chainComp("fpr", [["prism", { amount: 0.8 }]]));
  check("prism node resolves the chromatic-aberration builtin", pri[0]?.def.id === builtinFragmentEffectId("chromaticAberration"));
  check("prism scales its amount", pri[0]?.params.amount === 80);

  // P3 — the cheapness claim: four filters in series are four passes on ONE shell, not four nests.
  const stacked = chainComp("fst", [
    ["directionalBlur", { amount: 0.3 }],
    ["radialBlur", { amount: 0.3 }],
    ["pixelate", { blockSize: 8 }],
    ["prism", { amount: 0.2 }],
  ]);
  check("P3: four filter nodes stack on ONE group", groupDepth(stacked) === 1);
  check("P3: …as four fragment passes in order", passesOf(stacked).length === 4);

  // --- New Flarex GLSL builtins ---------------------------------------------
  const crop = passesOf(chainComp("fcr", [["crop", { left: 0.1, right: 0.2, top: 0.05, bottom: 0.3, softness: 0.02 }]]));
  check("crop node resolves the crop builtin", crop[0]?.def.id === FLAREX_CROP_ID);
  check("crop passes its insets as frame fractions", crop[0]?.params.left === 0.1 && crop[0]?.params.bottom === 0.3);
  // Crop must REPLACE the running image, not draw over it — otherwise the trimmed pixels stay visible.
  check("crop rewrites alpha (a cropped pixel is transparent, not composited over)", crop[0]?.def.rewritesAlpha === true);

  const channels = passesOf(chainComp("fch", [["channelBoolean", { red: "luma", green: "black", blue: "white", alpha: "luma", invertRgb: true }]]));
  check("channelBoolean node resolves the channels builtin", channels[0]?.def.id === FLAREX_CHANNELS_ID);
  // Named sources map to the shader's index vocabulary by position in `flarexChannelSources`.
  check("channelBoolean maps names to shader indices", channels[0]?.params.rFrom === 4 && channels[0]?.params.gFrom === 5 && channels[0]?.params.bFrom === 6);
  check("channelBoolean carries alpha←luma (the matte-from-plate case)", channels[0]?.params.aFrom === 4);
  check("channelBoolean carries its boolean", channels[0]?.params.invertRgb === true);
  check("channelBoolean defaults are the identity shuffle", (() => {
    const identity = passesOf(chainComp("fch0", [["channelBoolean", {}]]))[0];
    return identity?.params.rFrom === 0 && identity?.params.gFrom === 1 && identity?.params.bFrom === 2 && identity?.params.aFrom === 3;
  })());

  const vig = passesOf(chainComp("fvg", [["vignette", { amount: 0.5, roundness: 0.25 }]]));
  check("vignette node resolves the vignette builtin", vig[0]?.def.id === FLAREX_VIGNETTE_ID);
  check("vignette params stay normalized 0..1", vig[0]?.params.amount === 0.5 && vig[0]?.params.roundness === 0.25);

  const grn = passesOf(chainComp("fgr", [["grain", { amount: 0.4, size: 2 }]]));
  check("grain node resolves the grain builtin", grn[0]?.def.id === FLAREX_GRAIN_ID);
  check("grain params pass through", grn[0]?.params.amount === 0.4 && grn[0]?.params.size === 2);
  // Grain reads uTime, so the registry must have DERIVED a "time" dependency — that is what keeps the
  // content cache from serving one frozen grain frame forever (ADR-010).
  check("grain declares a time dependency (derived, not authored)", (grn[0]?.def.dependencies ?? []).includes("time"));
  check("vignette declares NO dependency (static, so it stays cacheable)", (vig[0]?.def.dependencies ?? []).length === 0);
}

// --- Filter node registry-driven UI/lowering (Sonnet round 2, N1) -----------
{
  // A filter node with a resolved effectId + params JSON override lowers to a fragment pass
  // carrying the OVERRIDDEN param values (not the def's defaults).
  const comp = createFlarexComp("f1", "Filter");
  const filter = createFlarexNode("filter", "flt1");
  filter.params = {
    ...filter.params,
    effectId: builtinFragmentEffectId("pixelate"),
    effectParams: JSON.stringify({ blockSize: 40 }),
  };
  comp.nodes[filter.id] = filter;
  comp.edges = [
    { id: "e1", from: { nodeId: "f1_in", socket: "out" }, to: { nodeId: "flt1", socket: "in" } },
    { id: "e2", from: { nodeId: "flt1", socket: "out" }, to: { nodeId: "f1_out", socket: "in" } },
  ];
  const out = compileFlarexComp(comp, lowerCtx());
  check("filter node lowers to a fragment pass", isGroupDraw(out!) && (out!.shell.fragmentPasses?.length ?? 0) === 1);
  const pass = out && isGroupDraw(out) ? out.shell.fragmentPasses?.[0] : undefined;
  check("filter pass resolves the chosen def", pass?.def.id === builtinFragmentEffectId("pixelate"));
  check("filter pass carries the JSON override value", pass?.params.blockSize === 40);

  // Unknown/garbage effectId never throws and passes the image through untouched.
  const comp2 = createFlarexComp("f2", "UnknownFilter");
  const filter2 = createFlarexNode("filter", "flt2");
  filter2.params = { ...filter2.params, effectId: "not.a.real.effect", effectParams: "" };
  comp2.nodes[filter2.id] = filter2;
  comp2.edges = [
    { id: "e1", from: { nodeId: "f2_in", socket: "out" }, to: { nodeId: "flt2", socket: "in" } },
    { id: "e2", from: { nodeId: "flt2", socket: "out" }, to: { nodeId: "f2_out", socket: "in" } },
  ];
  let threwUnknown = false;
  let outUnknown: ReturnType<typeof compileFlarexComp> = null;
  try {
    outUnknown = compileFlarexComp(comp2, lowerCtx());
  } catch {
    threwUnknown = true;
  }
  check("unknown effectId never throws", !threwUnknown);
  check("unknown effectId passes through (host draw, no wrap)", Boolean(outUnknown) && !isGroupDraw(outUnknown));
}

// --- Reroute + Backdrop nodes (Sonnet round 3, F2) ---------------------------
{
  // Reroute is a pure pass-through: in -> blur -> reroute -> out must lower IDENTICALLY to
  // in -> blur -> out (structurally, modulo the reroute's own absence from the draw tree).
  const direct = createFlarexComp("rr1", "Direct");
  const blurA = createFlarexNode("blur", "b1");
  blurA.params = { ...blurA.params, sigma: 15 };
  direct.nodes[blurA.id] = blurA;
  direct.edges = [
    { id: "e1", from: { nodeId: "rr1_in", socket: "out" }, to: { nodeId: "b1", socket: "in" } },
    { id: "e2", from: { nodeId: "b1", socket: "out" }, to: { nodeId: "rr1_out", socket: "in" } },
  ];
  const rerouted = createFlarexComp("rr2", "Rerouted");
  const blurB = createFlarexNode("blur", "b1");
  blurB.params = { ...blurB.params, sigma: 15 };
  const reroute = createFlarexNode("reroute", "r1");
  rerouted.nodes[blurB.id] = blurB;
  rerouted.nodes[reroute.id] = reroute;
  rerouted.edges = [
    { id: "e1", from: { nodeId: "rr2_in", socket: "out" }, to: { nodeId: "b1", socket: "in" } },
    { id: "e2", from: { nodeId: "b1", socket: "out" }, to: { nodeId: "r1", socket: "in" } },
    { id: "e3", from: { nodeId: "r1", socket: "out" }, to: { nodeId: "rr2_out", socket: "in" } },
  ];
  const strip = (v: unknown) => JSON.stringify(v, (key, val) => (key === "source" || key === "debugGroupId" ? undefined : val));
  const directOut = compileFlarexComp(direct, lowerCtx());
  const reroutedOut = compileFlarexComp(rerouted, lowerCtx());
  check("reroute lowers identically to a direct wire", strip(directOut) === strip(reroutedOut));

  // Backdrop never enters the DFS (no sockets to be reached through) — a stray backdrop must not
  // change lowering output at all vs. the same comp without it.
  // SAME comp id for both variants — `debugGroupId`/matte keys embed `comp.id`, so a differing
  // id would make the strip-compare fail for a reason that has nothing to do with the backdrop.
  const withoutBackdrop = createFlarexComp("bd", "NoBackdrop");
  const g1 = createFlarexNode("glow", "g1");
  withoutBackdrop.nodes[g1.id] = g1;
  withoutBackdrop.edges = [
    { id: "e1", from: { nodeId: "bd_in", socket: "out" }, to: { nodeId: "g1", socket: "in" } },
    { id: "e2", from: { nodeId: "g1", socket: "out" }, to: { nodeId: "bd_out", socket: "in" } },
  ];
  const withBackdrop = createFlarexComp("bd", "WithBackdrop");
  const g2 = createFlarexNode("glow", "g1");
  const backdrop = createFlarexNode("backdrop", "bd1");
  withBackdrop.nodes[g2.id] = g2;
  withBackdrop.nodes[backdrop.id] = backdrop;
  withBackdrop.edges = [
    { id: "e1", from: { nodeId: "bd_in", socket: "out" }, to: { nodeId: "g1", socket: "in" } },
    { id: "e2", from: { nodeId: "g1", socket: "out" }, to: { nodeId: "bd_out", socket: "in" } },
  ];
  const stripComp = (v: unknown) => JSON.stringify(v, (key, val) => (key === "source" ? undefined : val));
  check(
    "a stray backdrop never changes lowering output",
    stripComp(compileFlarexComp(withoutBackdrop, lowerCtx())) === stripComp(compileFlarexComp(withBackdrop, lowerCtx())),
  );
  check("backdrop has no sockets (unreachable by construction)", flarexNodeDefs.backdrop.inputs.length === 0 && flarexNodeDefs.backdrop.outputs.length === 0);
  check(
    "an edge can never reference a backdrop socket",
    !isValidFlarexEdge(withBackdrop.nodes, { id: "bad", from: { nodeId: "bd1", socket: "out" }, to: { nodeId: "g1", socket: "in" } }),
  );
}

// --- AI intent: mask / matte ops (Sonnet round 3, F4) ------------------------
{
  // `mask` wires the shape node into the CURRENT tail's mask input when it has one (blur does).
  const blurred = nodeGraphIntentSchema.safeParse({
    ops: [{ op: "blur", sigma: 10 }, { op: "mask", shape: "ellipse", region: { x: 0.5, y: 0.5, w: 0.3, h: 0.3 } }],
  });
  check("mask op schema parses", blurred.success);
  if (blurred.success) {
    const { comp } = compileNodeGraphIntent(blurred.data as NodeGraphIntent, createFlarexComp("m1", "M"));
    const blurNode = Object.values(comp.nodes).find((n) => n.type === "blur");
    const maskNode = Object.values(comp.nodes).find((n) => n.type === "ellipseMask");
    check("mask op adds an ellipseMask node", Boolean(maskNode));
    check(
      "mask op wires the mask node into the blur's mask input",
      comp.edges.some((e) => e.from.nodeId === maskNode?.id && e.to.nodeId === blurNode?.id && e.to.socket === "mask"),
    );
  }

  // `mask` on a tail with NO mask socket (mediaIn, fresh comp) adds the node unwired, never throws.
  const bareMask = nodeGraphIntentSchema.safeParse({ ops: [{ op: "mask", shape: "rect" }] });
  check("bare mask op schema parses with defaults", bareMask.success);
  if (bareMask.success) {
    let threw = false;
    let result: ReturnType<typeof compileNodeGraphIntent> | null = null;
    try {
      result = compileNodeGraphIntent(bareMask.data as NodeGraphIntent, createFlarexComp("m2", "M2"));
    } catch {
      threw = true;
    }
    check("mask op on an unmaskable tail never throws", !threw);
    const maskNode = result ? Object.values(result.comp.nodes).find((n) => n.type === "rectMask") : undefined;
    check("mask node is still added, just unwired", Boolean(maskNode) && !result!.comp.edges.some((e) => e.from.nodeId === maskNode?.id));
  }

  // `matte combine` needs 2+ prior mask ops — with only 1, it skips silently (never throws).
  const insufficientCombine = nodeGraphIntentSchema.safeParse({
    ops: [{ op: "mask", shape: "ellipse" }, { op: "matte", action: "combine" }],
  });
  check("matte combine schema parses", insufficientCombine.success);
  if (insufficientCombine.success) {
    let threw = false;
    let result: ReturnType<typeof compileNodeGraphIntent> | null = null;
    try {
      result = compileNodeGraphIntent(insufficientCombine.data as NodeGraphIntent, createFlarexComp("m3", "M3"));
    } catch {
      threw = true;
    }
    check("matte combine with insufficient history never throws", !threw);
    check("matte combine with insufficient history adds no matteControl node", !Object.values(result!.comp.nodes).some((n) => n.type === "matteControl"));
  }

  // `matte combine` with 2 prior masks DOES produce a matteControl wired a/b.
  const validCombine = nodeGraphIntentSchema.safeParse({
    ops: [
      { op: "mask", shape: "ellipse", region: { x: 0.3, y: 0.3, w: 0.2, h: 0.2 } },
      { op: "mask", shape: "rect", region: { x: 0.7, y: 0.7, w: 0.2, h: 0.2 } },
      { op: "matte", action: "combine" },
    ],
  });
  check("valid combine schema parses", validCombine.success);
  if (validCombine.success) {
    const { comp } = compileNodeGraphIntent(validCombine.data as NodeGraphIntent, createFlarexComp("m4", "M4"));
    const combineNode = Object.values(comp.nodes).find((n) => n.type === "matteControl");
    check("matte combine adds a matteControl node", Boolean(combineNode));
    check("matteControl has both a and b wired", comp.edges.filter((e) => e.to.nodeId === combineNode?.id).length === 2);
  }

  // `matte invert` refines the last mask (invert=true on a new matteControl wired to it).
  const invertParsed = nodeGraphIntentSchema.safeParse({ ops: [{ op: "mask", shape: "rect" }, { op: "matte", action: "invert" }] });
  check("matte invert schema parses", invertParsed.success);
  if (invertParsed.success) {
    const { comp } = compileNodeGraphIntent(invertParsed.data as NodeGraphIntent, createFlarexComp("m5", "M5"));
    const invertNode = Object.values(comp.nodes).find((n) => n.type === "matteControl");
    check("matte invert adds a matteControl node", invertNode?.params.invert === true);
  }

  check("intent schema rejects unknown matte action", !nodeGraphIntentSchema.safeParse({ ops: [{ op: "matte", action: "explode" }] }).success);
  check("intent schema rejects a curves op (intentionally not exposed)", !nodeGraphIntentSchema.safeParse({ ops: [{ op: "curves", points: [] }] }).success);
}

// --- Slice 1: materialization boundary (runtime node identity) ----------------
// Runtime-only opt-in (ctx.materializeNodeIds); NO persisted flag. Verifies the sealed wrap is a
// true two-sided optimization barrier, emits evaluationKey, nests correctly, and is pixel-neutral by
// construction — and that preserving __flarexSealed through cloneImage adds NO spurious barriers.
{
  // A chain: mediaIn -> transform(t1) -> blur(b1) [-> glow(g1)] -> mediaOut.
  const buildChain = (compId: string, withGlow: boolean): FlarexComp => {
    const comp = createFlarexComp(compId, "Materialize test");
    comp.nodes["t1"] = createFlarexNode("transform", "t1");
    comp.nodes["b1"] = createFlarexNode("blur", "b1");
    comp.edges = [
      { id: "e1", from: { nodeId: `${compId}_in`, socket: "out" }, to: { nodeId: "t1", socket: "in" } },
      { id: "e2", from: { nodeId: "t1", socket: "out" }, to: { nodeId: "b1", socket: "in" } },
    ];
    if (withGlow) {
      comp.nodes["g1"] = createFlarexNode("glow", "g1");
      comp.edges.push(
        { id: "e3", from: { nodeId: "b1", socket: "out" }, to: { nodeId: "g1", socket: "in" } },
        { id: "e4", from: { nodeId: "g1", socket: "out" }, to: { nodeId: `${compId}_out`, socket: "in" } },
      );
    } else {
      comp.edges.push({ id: "e3", from: { nodeId: "b1", socket: "out" }, to: { nodeId: `${compId}_out`, socket: "in" } });
    }
    return comp;
  };
  const evalKeyOf = (d: SceneDraw | undefined): string | undefined => (d as SceneGroupDraw | undefined)?.evaluationKey;
  const lowerWith = (compId: string, ids: string[] | null, withGlow = false) =>
    compileFlarexComp(buildChain(compId, withGlow), ids ? { ...lowerCtx(), materializeNodeIds: new Set(ids) } : lowerCtx());

  // (1) BASELINE REGRESSION: no policy -> transform+blur FOLD into one group, host is the direct
  // child (no barrier), and no group carries an evaluationKey.
  {
    const base = lowerWith("mtz", null);
    check("baseline: chain lowers to a single folded group", isGroupDraw(base) && base.children.length === 1);
    if (isGroupDraw(base)) {
      check("baseline: blur folded onto the wrap shell", base.shell.blurPx === 8);
      check("baseline: child is the host LAYER (folded, no barrier)", !isGroupDraw(base.children[0]!));
      check("baseline: no evaluationKey emitted without a policy", base.evaluationKey === undefined && evalKeyOf(base.children[0]) === undefined);
    }
  }

  // (2) evaluationKey EMISSION: materialize t1 -> t1's output is a sealed group stamped
  // flarex_<comp>_<node>; the outer blur wrap is NOT sealed (no leak).
  {
    const out = lowerWith("mtz", ["t1"]);
    check("materialize: output is a group", isGroupDraw(out));
    if (isGroupDraw(out)) {
      check("materialize: outer blur wrap is NOT sealed (no evaluationKey)", out.evaluationKey === undefined);
      check("materialize: t1 output sealed into its own group", isGroupDraw(out.children[0]!));
      check("materialize: sealed group carries evaluationKey flarex_mtz_t1", evalKeyOf(out.children[0]) === "flarex_mtz_t1");
    }
  }

  // (3) FOLD BARRIER BEHAVIOR: the seal is a true optimization barrier at t1 ONLY.
  //  - downstream of a sealed node does NOT fold into it (child becomes a group, not a layer);
  //  - the SAME op still folds when the node is not sealed (baseline above);
  //  - materializing t1 does NOT leak a seal onto b1/g1 -> blur+glow still fold together (the
  //    converse: no spurious barrier from cloneImage preserving __flarexSealed).
  {
    const folded = lowerWith("mtz", null);
    const barrier = lowerWith("mtz", ["t1"]);
    check(
      "barrier: same op folds without a seal but NOT across a sealed node",
      isGroupDraw(folded) && !isGroupDraw(folded.children[0]!) && isGroupDraw(barrier) && isGroupDraw(barrier.children[0]!),
    );
    const converse = lowerWith("mtz2", ["t1"], true);
    check(
      "barrier: blur+glow still fold together downstream of a sealed t1 (no spurious barrier)",
      isGroupDraw(converse) && converse.shell.blurPx === 8 && Boolean(converse.shell.glow) && converse.evaluationKey === undefined,
    );
    if (isGroupDraw(converse)) {
      check("barrier: exactly one barrier — the sealed t1 group", isGroupDraw(converse.children[0]!) && evalKeyOf(converse.children[0]) === "flarex_mtz2_t1");
    }
  }

  // (4) NESTED MATERIALIZATION: materialize BOTH t1 and b1 -> b1's sealed group wraps the blur wrap
  // wraps t1's sealed group (two barriers, correctly ordered).
  {
    const out = lowerWith("mtz", ["t1", "b1"]);
    check("nested: outer group sealed as b1", isGroupDraw(out) && out.evaluationKey === "flarex_mtz_b1");
    if (isGroupDraw(out)) {
      const blurWrap = out.children[0];
      check("nested: middle is the (unsealed) blur wrap", isGroupDraw(blurWrap!) && blurWrap.evaluationKey === undefined && blurWrap.shell.blurPx === 8);
      if (isGroupDraw(blurWrap!)) {
        check("nested: inner is t1's sealed group", isGroupDraw(blurWrap.children[0]!) && evalKeyOf(blurWrap.children[0]) === "flarex_mtz_t1");
      }
    }
  }

  // (5) PIXEL-PARITY BY CONSTRUCTION: a sealed group is an IDENTITY nest — identity shell, no
  // pipeline/mask/blur/glow/passes — so its RTT is a 1:1 copy of its child. Materialization inserts
  // only identity nests, which the compositor renders pixel-exact (the same invariant the nesting
  // 0.000% parity gate proves). Structural proof; the rendered gate confirms empirically (step 4).
  {
    const out = lowerWith("mtz", ["t1"]);
    const sealed = isGroupDraw(out) && isGroupDraw(out.children[0]!) ? out.children[0] : null;
    const s = sealed?.shell;
    check(
      "parity: sealed group has an identity shell (fit/blend/transform)",
      Boolean(s) && s!.fit === "fill" && s!.blendMode === "normal" &&
        s!.transform.x === 50 && s!.transform.y === 50 && s!.transform.scale === 1 && s!.transform.rotation === 0 && s!.transform.opacity === 100,
    );
    check(
      "parity: sealed group applies NO pixel op (no pipeline/mask/blur/glow/passes)",
      Boolean(sealed) && !sealed!.pipeline && !s!.mask && !s!.blurPx && !s!.glow && !s!.fragmentPasses && !s!.regionPasses,
    );
  }
}

// --- Slice 2: node content hashing (ADR-009 R1 + R3) -------------------------
// NodeContentHash = type + enabled + params RESOLVED to values at t (R1) folded with upstream
// content hashes in socket order (R3). Pure node content — no render resolution / frame time
// (that is the separate ContextVersion axis). Identity-free: same content → same hash.
{
  const buildTB = (compId: string, tx: number, sigma: number): FlarexComp => {
    const comp = createFlarexComp(compId, "Hash");
    const t = createFlarexNode("transform", "t1");
    t.params = { ...t.params, x: tx };
    const b = createFlarexNode("blur", "b1");
    b.params = { ...b.params, sigma };
    comp.nodes["t1"] = t;
    comp.nodes["b1"] = b;
    comp.edges = [
      { id: "e1", from: { nodeId: `${compId}_in`, socket: "out" }, to: { nodeId: "t1", socket: "in" } },
      { id: "e2", from: { nodeId: "t1", socket: "out" }, to: { nodeId: "b1", socket: "in" } },
      { id: "e3", from: { nodeId: "b1", socket: "out" }, to: { nodeId: `${compId}_out`, socket: "in" } },
    ];
    return comp;
  };

  const h1 = computeFlarexContentHashes(buildTB("h", 10, 8), 0);
  const h2 = computeFlarexContentHashes(buildTB("h", 10, 8), 0);
  check("content hash is deterministic", h1.get("t1") === h2.get("t1") && h1.get("b1") === h2.get("b1"));
  check("content hash is defined for every node", h1.get("h_in") !== undefined && h1.get("t1") !== undefined && h1.get("b1") !== undefined && h1.get("h_out") !== undefined);

  // R1: a param change rehashes that node AND everything downstream (Merkle), never upstream.
  const txChanged = computeFlarexContentHashes(buildTB("h", 25, 8), 0);
  check("R1: changing transform.x rehashes t1", txChanged.get("t1") !== h1.get("t1"));
  check("R1: downstream blur rehashes (Merkle propagation)", txChanged.get("b1") !== h1.get("b1"));
  check("R1: unaffected upstream MediaIn hash is stable", txChanged.get("h_in") === h1.get("h_in"));
  const sigChanged = computeFlarexContentHashes(buildTB("h", 10, 20), 0);
  check("downstream blur change leaves upstream t1 untouched", sigChanged.get("t1") === h1.get("t1"));
  check("downstream blur change rehashes b1", sigChanged.get("b1") !== h1.get("b1"));

  // R3: topology is content — a rewire changes the downstream hash even with identical node params.
  const buildMerge = (bgNode: string, fgNode: string): FlarexComp => {
    const comp = createFlarexComp("hm", "HashMerge");
    const t1 = createFlarexNode("transform", "t1");
    t1.params = { ...t1.params, x: 10 };
    const t2 = createFlarexNode("transform", "t2");
    t2.params = { ...t2.params, x: 90 };
    const m = createFlarexNode("merge", "m1");
    comp.nodes["t1"] = t1;
    comp.nodes["t2"] = t2;
    comp.nodes["m1"] = m;
    comp.edges = [
      { id: "e1", from: { nodeId: "hm_in", socket: "out" }, to: { nodeId: "t1", socket: "in" } },
      { id: "e2", from: { nodeId: "hm_in", socket: "out" }, to: { nodeId: "t2", socket: "in" } },
      { id: "e3", from: { nodeId: bgNode, socket: "out" }, to: { nodeId: "m1", socket: "bg" } },
      { id: "e4", from: { nodeId: fgNode, socket: "out" }, to: { nodeId: "m1", socket: "fg" } },
      { id: "e5", from: { nodeId: "m1", socket: "out" }, to: { nodeId: "hm_out", socket: "in" } },
    ];
    return comp;
  };
  const straight = computeFlarexContentHashes(buildMerge("t1", "t2"), 0);
  const swapped = computeFlarexContentHashes(buildMerge("t2", "t1"), 0);
  check("R3: swapping merge bg/fg upstreams rehashes the merge (fan-in order is content)", straight.get("m1") !== swapped.get("m1"));

  // R1 (resolve drivers to values): a keyframed param hashes by its VALUE at t, so equal values at
  // different times hash equal (reuse) and differing values hash differently (invalidation).
  const kf = createFlarexComp("hkf", "HashKF");
  const kb = createFlarexNode("blur", "b1");
  kf.nodes["b1"] = kb;
  kf.edges = [
    { id: "e1", from: { nodeId: "hkf_in", socket: "out" }, to: { nodeId: "b1", socket: "in" } },
    { id: "e2", from: { nodeId: "b1", socket: "out" }, to: { nodeId: "hkf_out", socket: "in" } },
  ];
  kf.animations = [
    { id: "k0", target: { scope: "flarexNode", effectId: "b1", property: "sigma" }, timeSeconds: 0, value: 0, interpolation: "linear", temporal: {} },
    { id: "k2", target: { scope: "flarexNode", effectId: "b1", property: "sigma" }, timeSeconds: 2, value: 20, interpolation: "linear", temporal: {} },
  ];
  const kfAt0 = computeFlarexContentHashes(kf, 0);
  const kfAt2 = computeFlarexContentHashes(kf, 2);
  check("R1: keyframed blur hashes differently at t=0 vs t=2 (resolved value differs)", kfAt0.get("b1") !== kfAt2.get("b1"));

  const constKf = createFlarexComp("hkc", "HashConst");
  const cb = createFlarexNode("blur", "b1");
  constKf.nodes["b1"] = cb;
  constKf.edges = [
    { id: "e1", from: { nodeId: "hkc_in", socket: "out" }, to: { nodeId: "b1", socket: "in" } },
    { id: "e2", from: { nodeId: "b1", socket: "out" }, to: { nodeId: "hkc_out", socket: "in" } },
  ];
  constKf.animations = [
    { id: "k0", target: { scope: "flarexNode", effectId: "b1", property: "sigma" }, timeSeconds: 0, value: 5, interpolation: "linear", temporal: {} },
    { id: "k2", target: { scope: "flarexNode", effectId: "b1", property: "sigma" }, timeSeconds: 2, value: 5, interpolation: "linear", temporal: {} },
  ];
  check(
    "R1: a constant-value keyframe hashes equal across time (reuse, not a spurious miss)",
    computeFlarexContentHashes(constKf, 0.5).get("b1") === computeFlarexContentHashes(constKf, 1.5).get("b1"),
  );

  // Identity-free: the same content (type/params/upstream) hashes equal regardless of node/comp id.
  const idA = createFlarexComp("ida", "A");
  idA.nodes["b1"] = createFlarexNode("blur", "b1");
  idA.edges = [
    { id: "e1", from: { nodeId: "ida_in", socket: "out" }, to: { nodeId: "b1", socket: "in" } },
    { id: "e2", from: { nodeId: "b1", socket: "out" }, to: { nodeId: "ida_out", socket: "in" } },
  ];
  const idB = createFlarexComp("idb", "B");
  idB.nodes["bZ"] = createFlarexNode("blur", "bZ");
  idB.edges = [
    { id: "e1", from: { nodeId: "idb_in", socket: "out" }, to: { nodeId: "bZ", socket: "in" } },
    { id: "e2", from: { nodeId: "bZ", socket: "out" }, to: { nodeId: "idb_out", socket: "in" } },
  ];
  check(
    "content hash is identity-free (same type/params/upstream → same hash across ids)",
    computeFlarexContentHashes(idA, 0).get("b1") === computeFlarexContentHashes(idB, 0).get("bZ"),
  );

  // Disabled state is content (a disabled node passes through — different output).
  const enabledComp = buildTB("he", 10, 8);
  const disabledComp = buildTB("he", 10, 8);
  disabledComp.nodes["b1"]!.enabled = false;
  check(
    "toggling node.enabled rehashes the node (pass-through is different content)",
    computeFlarexContentHashes(enabledComp, 0).get("b1") !== computeFlarexContentHashes(disabledComp, 0).get("b1"),
  );

  // Cycle safety: a self/back edge must still produce a defined hash (never hang).
  const cyc = createFlarexComp("hcy", "Cycle");
  const cb1 = createFlarexNode("blur", "b1");
  const cb2 = createFlarexNode("glow", "g1");
  cyc.nodes["b1"] = cb1;
  cyc.nodes["g1"] = cb2;
  cyc.edges = [
    { id: "e1", from: { nodeId: "g1", socket: "out" }, to: { nodeId: "b1", socket: "in" } },
    { id: "e2", from: { nodeId: "b1", socket: "out" }, to: { nodeId: "g1", socket: "in" } },
  ];
  let cycThrew = false;
  let cycHashes: Map<string, string> | null = null;
  try {
    cycHashes = computeFlarexContentHashes(cyc, 0);
  } catch {
    cycThrew = true;
  }
  check("cycle never hangs or throws (stable sentinel)", !cycThrew && cycHashes!.get("b1") !== undefined && cycHashes!.get("g1") !== undefined);
}

// --- Slice 2 (commit 3a): content-cache metadata plumbing (dormant) ----------
// Registry derives semantic dependsOn(time) from the shader; the compiler stamps contentHash
// (validity key) + dependency declarations (facts) onto sealed groups. All unread by the
// compositor until 3b/3c → render output is byte-identical (green by construction).
{
  // (a) Registry derivation is exactly the set of effects whose shader references uTime — and the
  //     declaration is SEMANTIC ("time"), so nothing above the registry ever sees the token.
  const all = listFragmentEffects();
  const declaredTime = all.filter((d) => (d.dependencies ?? []).includes("time")).map((d) => d.id).sort();
  const usesUTime = all
    .filter((d) => /\buTime\b/.test(d.glsl) || (d.passes ?? []).some((p) => /\buTime\b/.test(p.glsl)))
    .map((d) => d.id).sort();
  check("3a registry: dependsOn(time) derived exactly from shader uTime usage", JSON.stringify(declaredTime) === JSON.stringify(usesUTime));
  check("3a registry: at least one time-varying effect exists", usesUTime.length > 0);
  check("3a registry: a static effect declares no time dependency", (getFragmentEffect(builtinFragmentEffectId("pixelate"))?.dependencies ?? []).length === 0);
  check("3a registry: a time-varying effect declares time", (getFragmentEffect(builtinFragmentEffectId("glitchFx"))?.dependencies ?? []).includes("time"));

  // (b) materialize stamps the node's content hash as the sealed group's validity key — distinct
  //     from the identity evaluationKey (ADR-008: identity ≠ validity).
  const comp = createFlarexComp("h3a", "Stamp");
  comp.nodes["b1"] = createFlarexNode("blur", "b1");
  comp.edges = [
    { id: "e1", from: { nodeId: "h3a_in", socket: "out" }, to: { nodeId: "b1", socket: "in" } },
    { id: "e2", from: { nodeId: "b1", socket: "out" }, to: { nodeId: "h3a_out", socket: "in" } },
  ];
  const out = compileFlarexComp(comp, { ...lowerCtx(), materializeNodeIds: new Set(["b1"]) }) as SceneGroupDraw;
  const expected = computeFlarexContentHashes(comp, lowerCtx().timeSeconds).get("b1");
  check("3a: sealed group carries the node's content hash as its validity key", isGroupDraw(out) && out.contentHash === expected && Boolean(expected));
  check("3a: content hash is distinct from the identity evaluationKey", isGroupDraw(out) && out.contentHash !== out.evaluationKey);

  // (c) A materialized time-varying filter declares dependsOn(time); a static one declares nothing.
  const mkFilter = (compId: string, effect: string): FlarexComp => {
    const c = createFlarexComp(compId, "Filter");
    const f = createFlarexNode("filter", "flt1");
    f.params = { ...f.params, effectId: builtinFragmentEffectId(effect), effectParams: "" };
    c.nodes["flt1"] = f;
    c.edges = [
      { id: "e1", from: { nodeId: `${compId}_in`, socket: "out" }, to: { nodeId: "flt1", socket: "in" } },
      { id: "e2", from: { nodeId: "flt1", socket: "out" }, to: { nodeId: `${compId}_out`, socket: "in" } },
    ];
    return c;
  };
  const timeOut = compileFlarexComp(mkFilter("h3t", "glitchFx"), { ...lowerCtx(), materializeNodeIds: new Set(["flt1"]) }) as SceneGroupDraw;
  check("3a: materialized time-varying filter declares dependsOn(time)", isGroupDraw(timeOut) && (timeOut.dependencies ?? []).includes("time"));
  const staticOut = compileFlarexComp(mkFilter("h3s", "pixelate"), { ...lowerCtx(), materializeNodeIds: new Set(["flt1"]) }) as SceneGroupDraw;
  check("3a: materialized static filter declares no time dependency", isGroupDraw(staticOut) && staticOut.dependencies === undefined);
}

// --- Slice 2 (commit 3b): opaque dependency-version payload in the cache identity --------------
// A materialized time-varying artifact folds an OPAQUE resolved dependency token into its identity so
// the cache key FULLY determines its pixels: same NodeContentHash, but a per-frame dependencyVersions.
// A static artifact folds nothing → identity stable across frames (cross-frame reuse). The compositor
// never interprets the payload; these assertions are the compiler side (the GL cache is gated by
// render:compare:pixels).
{
  const mkFilter = (compId: string, effect: string, frameTimeSeconds: number): SceneGroupDraw => {
    const c = createFlarexComp(compId, "F");
    const f = createFlarexNode("filter", "flt1");
    f.params = { ...f.params, effectId: builtinFragmentEffectId(effect), effectParams: "" };
    c.nodes["flt1"] = f;
    c.edges = [
      { id: "e1", from: { nodeId: `${compId}_in`, socket: "out" }, to: { nodeId: "flt1", socket: "in" } },
      { id: "e2", from: { nodeId: "flt1", socket: "out" }, to: { nodeId: `${compId}_out`, socket: "in" } },
    ];
    return compileFlarexComp(c, { ...lowerCtx(), frameTimeSeconds, materializeNodeIds: new Set(["flt1"]) }) as SceneGroupDraw;
  };

  const timeA = mkFilter("gA", "glitchFx", 3);
  const timeB = mkFilter("gA", "glitchFx", 5);
  check("3b: time-varying artifact folds an opaque dependency-version payload", isGroupDraw(timeA) && typeof timeA.dependencyVersions === "string" && timeA.dependencyVersions.length > 0);
  check("3b: dependency-version payload changes with frame time (per-frame cache identity)", timeA.dependencyVersions !== timeB.dependencyVersions);
  check("3b: content hash is INVARIANT across frame time (time is a dependency, not content)", Boolean(timeA.contentHash) && timeA.contentHash === timeB.contentHash);

  const staticA = mkFilter("gS", "pixelate", 3);
  const staticB = mkFilter("gS", "pixelate", 5);
  // 3c-A revised this: a static artifact folds no TIME token, but it does fold its source-content
  // version (that axis is what stops a live raster being served stale). The invariant that matters is
  // that nothing in its identity varies with frame time — asserted on the next line.
  check("3b: static artifact folds no time token (only the source-content version)", isGroupDraw(staticA) && staticA.dependencyVersions === "v7");
  check("3b: static artifact identity is stable across frame time (cross-frame reuse)", Boolean(staticA.contentHash) && staticA.contentHash === staticB.contentHash && staticA.dependencyVersions === staticB.dependencyVersions);
}

// --- Slice 2 (commit 3c-A): SOURCE CONTENT is part of the cache identity ------------------------
// REGRESSION GUARD for a shipped freeze: dependencies were harvested from fragment passes ONLY, so a
// subtree whose only dynamic input was a live media raster keyed identically every frame. The
// compositor's hit path skips the children render outright, so a materialized MediaIn served its first
// decoded frame FOREVER. An unversioned raster must now make the artifact uncacheable, and a versioned
// one must fold its version into the identity so a new frame re-keys.
{
  const sealed = (host: SceneLayerDraw, nodeIds = ["flt1"]): SceneGroupDraw => {
    const c = createFlarexComp("srcid", "S");
    const f = createFlarexNode("filter", "flt1");
    f.params = { ...f.params, effectId: builtinFragmentEffectId("pixelate"), effectParams: "" };
    c.nodes["flt1"] = f;
    c.edges = [
      { id: "e1", from: { nodeId: "srcid_in", socket: "out" }, to: { nodeId: "flt1", socket: "in" } },
      { id: "e2", from: { nodeId: "flt1", socket: "out" }, to: { nodeId: "srcid_out", socket: "in" } },
    ];
    return compileFlarexComp(c, { ...lowerCtx(host), materializeNodeIds: new Set(nodeIds) }) as SceneGroupDraw;
  };

  // An UNVERSIONED raster ("always re-upload" — live media) cannot be described by any key we can build.
  const unversioned = sealed(hostDraw(null));
  check("3c-A: unversioned source makes the artifact UNCACHEABLE (no stale hit)", isGroupDraw(unversioned) && unversioned.contentHash === undefined);
  check("3c-A: an uncacheable artifact is still sealed + materialized (only caching is withheld)", isGroupDraw(unversioned) && unversioned.evaluationKey === "flarex_srcid_flt1");

  // A VERSIONED raster stays cacheable, and the version participates in the identity.
  const v1a = sealed(hostDraw(1));
  const v1b = sealed(hostDraw(1));
  const v2 = sealed(hostDraw(2));
  check("3c-A: versioned source stays cacheable", isGroupDraw(v1a) && Boolean(v1a.contentHash));
  check("3c-A: identical source version ⇒ identical identity (cross-frame reuse survives)", v1a.contentHash === v1b.contentHash && v1a.dependencyVersions === v1b.dependencyVersions);
  check("3c-A: a NEW source version re-keys the artifact (the freeze fix)", v1a.dependencyVersions !== v2.dependencyVersions);
  check("3c-A: source version is a DEPENDENCY, not content (contentHash invariant)", Boolean(v1a.contentHash) && v1a.contentHash === v2.contentHash);
  check("3c-A: source versions never leak into the declared dependency FACTS", isGroupDraw(v1a) && (v1a.dependencies ?? []).every((d) => d === "time"));

  // The actual shipped-freeze shape. The shared node must be EXPENSIVE enough to clear the cost term
  // (a bare MediaIn no longer seals — see the cost-hint block), so a filter feeds two merge inputs.
  // With a live (unversioned) media raster underneath it, the seal must refuse to cache rather than
  // pin frame 1 forever.
  const fan = createFlarexComp("fan", "Fan");
  const fanFx = createFlarexNode("filter", "fan_fx");
  fanFx.params = { ...fanFx.params, effectId: builtinFragmentEffectId("pixelate"), effectParams: "" };
  fan.nodes["fan_fx"] = fanFx;
  fan.nodes["fan_merge"] = createFlarexNode("merge", "fan_merge");
  fan.edges = [
    { id: "f0", from: { nodeId: "fan_in", socket: "out" }, to: { nodeId: "fan_fx", socket: "in" } },
    { id: "f1", from: { nodeId: "fan_fx", socket: "out" }, to: { nodeId: "fan_merge", socket: "bg" } },
    { id: "f2", from: { nodeId: "fan_fx", socket: "out" }, to: { nodeId: "fan_merge", socket: "fg" } },
    { id: "f3", from: { nodeId: "fan_merge", socket: "out" }, to: { nodeId: "fan_out", socket: "in" } },
  ];
  const collectSealed = (root: SceneDraw): SceneGroupDraw[] => {
    const found: SceneGroupDraw[] = [];
    (function walk(d: SceneDraw) {
      if (!d || (d as SceneGroupDraw).kind !== "group") return;
      const g = d as SceneGroupDraw;
      if (g.evaluationKey !== undefined) found.push(g);
      for (const child of g.children) walk(child);
    })(root);
    return found;
  };
  const liveSealed = collectSealed(compileFlarexComp(fan, lowerCtx(hostDraw(null))) as SceneDraw);
  check("3c-A: an EXPENSIVE fanned-out node materializes (fanout > 1 ∧ cost)", liveSealed.length > 0);
  check("3c-A: …and a LIVE media source is never cached there (no permanently frozen clip)", liveSealed.every((g) => g.contentHash === undefined));
  const versionedSealed = collectSealed(compileFlarexComp(fan, lowerCtx(hostDraw(4))) as SceneDraw);
  check("3c-A: …while the same seal on a VERSIONED source stays cacheable", versionedSealed.some((g) => Boolean(g.contentHash)));
}

// --- Materialization cost hint (ADR-010 §3, measured 2026-07-26) --------------------------------
// `fanout > 1` alone sealed trivial shared leaves into identity RTTs that dedupe nothing. `flarex:perf`
// measured that shape 37.5% slower and 7.9MB heavier with the cache on, while a dense comp gained 42%
// on p95 for 2.0MB. Materialization is now gated on the subtree's structural pass count.
{
  const fanTo = (id: string, buildShared: (comp: ReturnType<typeof createFlarexComp>) => string) => {
    const comp = createFlarexComp(id, "F");
    const sharedId = buildShared(comp);
    comp.nodes[`${id}_m`] = createFlarexNode("merge", `${id}_m`);
    comp.edges.push(
      { id: "mb", from: { nodeId: sharedId, socket: "out" }, to: { nodeId: `${id}_m`, socket: "bg" } },
      { id: "mf", from: { nodeId: sharedId, socket: "out" }, to: { nodeId: `${id}_m`, socket: "fg" } },
    );
    comp.edges = comp.edges.filter((e) => e.to.nodeId !== `${id}_out`);
    comp.edges.push({ id: "eo", from: { nodeId: `${id}_m`, socket: "out" }, to: { nodeId: `${id}_out`, socket: "in" } });
    const sealed: string[] = [];
    (function walk(d: SceneDraw) {
      if (!d || (d as SceneGroupDraw).kind !== "group") return;
      const g = d as SceneGroupDraw;
      if (g.evaluationKey !== undefined) sealed.push(g.evaluationKey);
      for (const child of g.children) walk(child);
    })(compileFlarexComp(comp, lowerCtx()) as SceneDraw);
    return sealed;
  };

  // Cheap shared leaf: a bare MediaIn (zero passes) — sealing it buys nothing.
  const cheap = fanTo("costA", () => "costA_in");
  check("cost hint: a zero-pass shared leaf is NOT sealed", cheap.length === 0);

  // Expensive shared subtree: a filter pass — worth an RTT because the dedupe saves real work.
  const pricey = fanTo("costB", (comp) => {
    const fx = createFlarexNode("filter", "costB_fx");
    fx.params = { ...fx.params, effectId: builtinFragmentEffectId("pixelate"), effectParams: "" };
    comp.nodes["costB_fx"] = fx;
    comp.edges.push({ id: "fx", from: { nodeId: "costB_in", socket: "out" }, to: { nodeId: "costB_fx", socket: "in" } });
    return "costB_fx";
  });
  check("cost hint: a shared subtree with real GPU work IS sealed", pricey.includes("flarex_costB_costB_fx"));

  // The explicit override must bypass the cost term — node previews (Slice 4) need to materialize
  // any node on demand, however cheap.
  const forced = createFlarexComp("costC", "F");
  const forcedOut = compileFlarexComp(forced, { ...lowerCtx(), materializeNodeIds: new Set(["costC_in"]) });
  check("cost hint: explicit materializeNodeIds bypasses the cost gate", isGroupDraw(forcedOut) && forcedOut.evaluationKey === "flarex_costC_costC_in");
}

// --- Slice 2 (commit 3c-B): artifact retention policy ------------------------------------------
// The cache was unbounded: a per-frame-keyed artifact allocated a fresh ~8MB RTT EVERY frame during
// playback and nothing was ever freed. These pin the eviction DECISION (pure, GL-free) — the part the
// "same composition, less memory" claim rests on.
{
  const MB = 1024 * 1024;
  const cand = (cacheKey: string, lastAccessFrame: number, protectedTier = false, bytes = 8 * MB): ArtifactRetentionCandidate =>
    ({ cacheKey, bytes, lastAccessFrame, protectedTier });
  const state = (over: Partial<Parameters<typeof planArtifactEviction>[1]> = {}) =>
    ({ frame: 10, bytes: 40 * MB, entries: 5, budgetBytes: 96 * MB, maxEntries: 64, ...over });

  check("3c-B: under budget evicts nothing", planArtifactEviction([cand("a", 1), cand("b", 2)], state()).length === 0);

  // Rule 1 — an artifact touched THIS frame is load-bearing for intra-frame fan-out.
  const thisFrame = planArtifactEviction([cand("old", 1), cand("live", 10)], state({ bytes: 200 * MB, entries: 2 }));
  check("3c-B: never evicts an artifact touched on the current frame", !thisFrame.includes("live"));
  check("3c-B: does evict an idle artifact when over budget", thisFrame.includes("old"));

  // Rule 2 — the anti-pollution rule: playback churn must not flush proven-reusable artifacts.
  const tiers = planArtifactEviction(
    [cand("protected-old", 1, true), cand("probation-new", 9, false)],
    state({ bytes: 104 * MB, entries: 2 }),
  );
  check("3c-B: drains probation before protected (playback churn can't flush reusable artifacts)", tiers[0] === "probation-new");

  // Rule 3 — LRU within a tier.
  const lru = planArtifactEviction([cand("newer", 8), cand("older", 2)], state({ bytes: 104 * MB, entries: 2 }));
  check("3c-B: evicts least-recently-used first within a tier", lru[0] === "older");

  // Rule 4 — stop as soon as the budget is met; eviction is not a flush.
  const minimal = planArtifactEviction(
    [cand("a", 1), cand("b", 2), cand("c", 3), cand("d", 4)],
    state({ bytes: 100 * MB, entries: 4 }),
  );
  check("3c-B: evicts the MINIMUM needed to fit the budget", minimal.length === 1 && minimal[0] === "a");

  // The entry cap is an independent backstop for many-small-artifact comps.
  const capped = planArtifactEviction(
    [cand("a", 1, false, 16), cand("b", 2, false, 16), cand("c", 3, false, 16)],
    state({ bytes: 48, entries: 3, maxEntries: 2 }),
  );
  check("3c-B: entry cap evicts even when far under the byte budget", capped.length === 1 && capped[0] === "a");

  // The leak shape itself: N single-use per-frame artifacts, none reused, must bound to the budget.
  const churn = Array.from({ length: 40 }, (_, i) => cand(`f${i}`, i));
  const bounded = planArtifactEviction(churn, { frame: 40, bytes: 40 * 8 * MB, entries: 40, budgetBytes: 96 * MB, maxEntries: 64 });
  check("3c-B: per-frame churn is bounded to the budget (the shipped leak)", (40 - bounded.length) * 8 * MB <= 96 * MB);
}

// --- Flarex viewer isolation (user report 2026-07-26) ------------------------------------------
// The node page reuses the ONE shared viewer, so it was showing the finished timeline composite: a clip
// stacked above the Flarex host drew over the node output and you were not looking at your comp.
{
  const mkLayer = (id: string, type: TimelineLayer["type"], extra: Partial<TimelineLayer> = {}): TimelineLayer =>
    ({
      id,
      trackId: "t1",
      type,
      name: id,
      startSeconds: 0,
      durationSeconds: 5,
      transform: { position: { x: 50, y: 50 }, scale: 1, rotation: 0, opacity: 100 },
      effects: [],
      keyframes: [],
      ...extra,
    }) as TimelineLayer;

  const comp: TimelineComposition = {
    width: 1920,
    height: 1080,
    durationSeconds: 12,
    backgroundColor: "#000000",
    tracks: [
      { id: "t1", name: "V1", layers: [mkLayer("host", "video", { flarexCompId: "cx" }), mkLayer("sibling", "video")] },
      { id: "t2", name: "V2", layers: [mkLayer("overlay", "text"), mkLayer("music", "audio")] },
    ],
  } as unknown as TimelineComposition;

  const isolated = soloLayerComposition(comp, "host");
  const idsOf = (c: TimelineComposition) => c.tracks.flatMap((t) => t.layers.map((l) => l.id));

  check("isolation: the Flarex host survives", idsOf(isolated).includes("host"));
  check("isolation: a clip ABOVE the host is withheld (the reported bug)", !idsOf(isolated).includes("overlay"));
  check("isolation: a sibling clip on the host's own track is withheld", !idsOf(isolated).includes("sibling"));
  check("isolation: audio is KEPT (never silently mute the mix)", idsOf(isolated).includes("music"));
  check("isolation: duration/size are preserved (transport + frame ruler must still line up)", isolated.durationSeconds === 12 && isolated.width === 1920);
  check("isolation: track structure is preserved (no track is dropped)", isolated.tracks.length === comp.tracks.length);
  check("isolation: the input composition is not mutated", idsOf(comp).length === 4);

  // The host's asset-source MediaIns must still resolve from the isolated composition — they are
  // derived from the surviving host layer, so isolation must not starve the comp of its loaders.
  const fxComp = createFlarexComp("cx", "Cx");
  const loaderNode = createFlarexNode("mediaIn", "cx_srcin");
  loaderNode.params = { ...loaderNode.params, sourceAssetId: "assetA" };
  fxComp.nodes["cx_srcin"] = loaderNode;
  const virtuals = collectFlarexVirtualLayers(
    isolated.tracks.flatMap((t) => t.layers),
    { cx: fxComp },
    () => ({ type: "video", durationSeconds: 30 })
  );
  check("isolation: the host's virtual loaders still resolve", virtuals.some((v) => v.id === flarexVirtualLayerId("cx", "cx_srcin")));
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nflarex contract: all checks passed");
