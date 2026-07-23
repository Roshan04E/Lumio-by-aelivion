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
import { builtinFragmentEffectId } from "../color/fragment-effects/builtins";
import { compileNodeGraphIntent, nodeGraphIntentSchema, type NodeGraphIntent } from "./node-graph-intent";
import type { SceneDraw, SceneGroupDraw, SceneLayerDraw } from "../color/scene-compositor";
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
import { collectFlarexVirtualLayers, flarexVirtualLayerId } from "./virtual-layers";
import type { FlarexComp } from "./types";
import type { Mask, ProjectGraph, TimelineLayer } from "../types";
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
function hostDraw(): SceneLayerDraw {
  return {
    debugLayerId: "host",
    source: { texture: {} as WebGLTexture, width: 1920, height: 1080 },
    sourceWidth: 1920,
    sourceHeight: 1080,
    fit: "cover",
    transform: { x: 50, y: 50, scale: 1, rotation: 0, opacity: 100 },
    blendMode: "normal",
  };
}
function lowerCtx(): FlarexLowerCtx {
  return {
    compWidth: 1920,
    compHeight: 1080,
    renderScale: 1,
    timeSeconds: 1,
    frameTimeSeconds: 3,
    hostSourceDraw: hostDraw(),
    matteCache: null,
  };
}
const isGroupDraw = (d: unknown): d is SceneGroupDraw => (d as SceneGroupDraw)?.kind === "group";

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
  if (isGroupDraw(out)) {
    const fg = out.children[1]!;
    check("fg carries the keyer fragment pass", isGroupDraw(fg) && (fg.shell.fragmentPasses?.length ?? 0) === 1);
    if (isGroupDraw(fg)) {
      check("fg blend/opacity applied on its shell", fg.shell.blendMode === "screen" && Math.abs(fg.shell.transform.opacity - 80) < 1e-6);
      check("keyer pass resolves the registered def", fg.shell.fragmentPasses?.[0]?.def.id === "flarex.chromaKey");
    }
    const bg = out.children[0]!;
    check("bg is an untouched host clone", !isGroupDraw(bg) && (bg as SceneLayerDraw).sourceWidth === 1920);
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

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nflarex contract: all checks passed");
