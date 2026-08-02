/**
 * ADR-012 Runtime Kernel — headless conformance harness (slice S0.4).
 *
 *   pnpm --filter @orreris/worker kernel:conform
 *
 * ## What this is
 *
 * The permanent home for ADR-012 Part 12 invariant assertions. It runs the REAL shared code
 * (`compileFlarexComp`, `healFlarexRegistry`, the kernel diagnostics sink) with synthetic time and
 * synthetic media, outside a browser, with no renderer attached. That is invariant I-37 — the kernel
 * must be drivable headlessly — and it is what turns the 2026-08-01 audit's prose findings into
 * something CI can hold onto.
 *
 * Repo convention: no test framework. Assert, print, exit non-zero on failure.
 *
 * ## The two tiers, and why `pending` asserts the BUG
 *
 * - **enforced** — an invariant that is satisfied today. It must pass. It may never be disabled,
 *   skipped, or weakened (governance §7 C2). The set of enforced assertions only ever grows.
 *
 * - **pending(SLICE)** — a known violation the migration has not reached yet. The assertion is
 *   written the other way round: it asserts the DEFECT still reproduces. That is deliberate. It
 *   means the day a slice fixes the defect, the pending check fails loudly and the engineer must
 *   promote it to `enforced` in the same PR — so a fix can never land without the ratchet noticing.
 *   A pending check that fails is therefore *good news that requires work*, not a broken build; it
 *   is reported separately and does NOT fail the run.
 *
 * ## Scope today (Phase 0)
 *
 * Three audit findings reproduced headlessly, each pinned to the slice that retires it:
 *   F1  graph cardinality is not enforced by the model                        → S1.1
 *   F2  the persisted view dot changes compiled output (I-26)                 → S1.2
 *   F3  scarcity is resolved by substituting the host clip, unobservably      → S0.2 / S4.5
 *
 * Plus the enforced properties of the diagnostics sink itself (S0.1).
 */

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  __resetFrameScheduler,
  activeFrame,
  createRuntimeSession,
  declareMediaSources,
  getMediaSources,
  suppressMediaSources,
  demoteMediaSources,
  holdDecoderSession,
  isMediaSourceDemoted,
  noteBorrowGrant,
  BORROW_RULE_INHERITED,
  releaseDecoderHold,
  DECODER_RETENTION_MS,
  bindDecoderSource,
  decoderLedger,
  decoderReleaseVerdict,
  noteDecoderRetentionExpired,
  noteDecoderSessionClosed,
  noteDecoderSessionOpened,
  RESOURCE_IDLE_MS,
  __resetResourceManager,
  collectIdleResources,
  forgetResource,
  registerResource,
  resourceLedger,
  resourcesInScope,
  touchResource,
  assumeLiveFromCommitted,
  authoritativeTime,
  coherenceGap,
  commitTimelineTime,
  deriveDecodeTime,
  deriveEvaluationTime,
  derivePresentationTime,
  deriveTargetTime,
  deriveTimelineTime,
  servedTime,
  unsafeLabelTime,
  awaitFrameSettled,
  beginFrame,
  classifyComposite,
  compileFlarexComp,
  frameSchedulerStats,
  onFrameCompleted,
  createFlarexComp,
  createFlarexNode,
  healFlarexRegistry,
  isValidFlarexEdge,
  kernelDiagnostics,
  endFrame,
  noteHeld,
  notePresent,
  parseFlarexSourceSubject,
  presentLedger,
  recordFlarexDegradation,
  stampFlarexComp,
  subjectKey,
  summarizeFlarexDegradations,
  type FlarexComp,
  type FlarexCompProxyFrame,
  type SceneTextureSource,
  type ServedTime,
  type FlarexDegradation,
  type FlarexLowerCtx,
  type ProjectGraph,
  type SceneLayerDraw,
} from "@orreris/shared";

// ---------------------------------------------------------------------------------------------
// Assertion tiers
// ---------------------------------------------------------------------------------------------

let enforcedFailures = 0;
let pendingResolved = 0;
const pendingNotes: string[] = [];

/** Ordered list equality, for assertions about sets the kernel promises to keep sorted. */
function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** An invariant that holds today. Must pass; failing it fails the run. */
function enforced(invariant: string, name: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`  ok    [${invariant}] ${name}`);
  } else {
    enforcedFailures += 1;
    console.error(`  FAIL  [${invariant}] ${name}`);
    // A structural check knows WHICH file broke it; printing that is the difference between a failure
    // someone can fix and one they have to re-derive.
    if (detail) console.error(`        ${detail}`);
  }
}

/**
 * A known violation. `stillBroken` must be TRUE while the defect exists. When it flips false, the
 * slice that fixed it must promote this to {@link enforced} — see the module header.
 */
function pending(slice: string, name: string, stillBroken: boolean): void {
  if (stillBroken) {
    console.log(`  pend  [${slice}] ${name} — reproduces, as expected`);
  } else {
    pendingResolved += 1;
    pendingNotes.push(`[${slice}] ${name}`);
    console.log(`  DONE  [${slice}] ${name} — NO LONGER REPRODUCES: promote to enforced()`);
  }
}

// ---------------------------------------------------------------------------------------------
// Fixtures — synthetic media, synthetic time, no renderer
// ---------------------------------------------------------------------------------------------

/** A stand-in for a decoded frame. Nothing here samples it; only identity and size matter. */
function syntheticDraw(id: string): SceneLayerDraw {
  return {
    debugLayerId: id,
    source: { texture: {} as WebGLTexture, width: 1920, height: 1080 },
    sourceWidth: 1920,
    sourceHeight: 1080,
    fit: "cover",
    transform: { x: 50, y: 50, scale: 1, rotation: 0, opacity: 100 },
    blendMode: "normal",
    sourceVersion: 7,
  };
}

function lowerCtx(overrides: Partial<FlarexLowerCtx> = {}): FlarexLowerCtx {
  return {
    compWidth: 1920,
    compHeight: 1080,
    renderScale: 1,
    timeSeconds: 1,
    frameTimeSeconds: 1,
    hostSourceDraw: syntheticDraw("host"),
    matteCache: null,
    ...overrides,
  };
}

function graphFixture(comp: FlarexComp): ProjectGraph {
  return { projectId: "p1", effects: [], editableFields: {}, version: 1, flarexComps: { [comp.id]: comp } };
}

/** `mediaIn → blur → mediaOut`. The blur makes "did the dot re-root?" observable in the output. */
function blurComp(id: string): FlarexComp {
  const comp = createFlarexComp(id, id);
  const blur = createFlarexNode("blur", `${id}_blur`);
  comp.nodes[blur.id] = blur;
  comp.edges = [
    { id: `${id}_e1`, from: { nodeId: `${id}_in`, socket: "out" }, to: { nodeId: blur.id, socket: "in" } },
    { id: `${id}_e2`, from: { nodeId: blur.id, socket: "out" }, to: { nodeId: `${id}_out`, socket: "in" } },
  ];
  return comp;
}

// ---------------------------------------------------------------------------------------------
// S0.1 — Diagnostics sink (enforced)
// ---------------------------------------------------------------------------------------------

console.log("\nS0.1 — Diagnostics sink");
{
  kernelDiagnostics.reset();
  const wasEnabled = kernelDiagnostics.enabled;

  // One identity namespace: the join the audit had to do by hand must now be mechanical.
  enforced(
    "I-29",
    "a Flarex virtual source id folds onto its node subject",
    (() => {
      const parsed = parseFlarexSourceSubject("flarexsrc:comp7:node3");
      return (
        parsed !== null &&
        subjectKey({ kind: "node", compId: parsed.compId, nodeId: parsed.nodeId }) === "node:comp7/node3"
      );
    })(),
  );
  enforced("I-29", "an ordinary layer source id is not mistaken for a Flarex one", parseFlarexSourceSubject("layer_42") === null);
  enforced(
    "I-29",
    "subject keys are stable and distinct across kinds",
    subjectKey({ kind: "comp", compId: "c" }) !== subjectKey({ kind: "node", compId: "c", nodeId: "c" }),
  );

  // Recording, aggregation, and the query surface.
  kernelDiagnostics.enabled = true;
  kernelDiagnostics.reset();
  for (let i = 0; i < 3; i++) {
    kernelDiagnostics.record({
      kind: "degradation",
      severity: "warn",
      subject: { kind: "node", compId: "c1", nodeId: "n1" },
      reason: "source-pending",
    });
  }
  kernelDiagnostics.record({
    kind: "denial",
    severity: "warn",
    subject: { kind: "source", sourceId: "flarexsrc:c1:n2" },
    reason: "no-session-available",
  });

  enforced("I-29", "events are recorded in order with monotonic seq", (() => {
    const events = kernelDiagnostics.events();
    return events.length === 4 && events.every((e, i) => e.seq === i);
  })());
  enforced("I-29", "events are filterable by kind", kernelDiagnostics.events({ kind: "denial" }).length === 1);
  enforced("I-29", "repeated causes aggregate rather than multiply", (() => {
    const row = kernelDiagnostics.summary().find((r) => r.reason === "source-pending");
    return row?.count === 3 && row.subject === "node:c1/n1";
  })());
  enforced("I-29", "degradation and denial are DISTINCT kinds", (() => {
    const kinds = new Set(kernelDiagnostics.summary().map((r) => r.kind));
    return kinds.has("degradation") && kinds.has("denial");
  })());

  // The no-perturbation rule (governance G14 / programme risk R1). The disabled path must not
  // record; call sites additionally guard on `.enabled` so the argument is never even built.
  kernelDiagnostics.reset();
  kernelDiagnostics.enabled = false;
  kernelDiagnostics.record({ kind: "degradation", severity: "info", subject: { kind: "runtime" }, reason: "ignored" });
  enforced("R1", "a disabled sink records nothing", kernelDiagnostics.events().length === 0);
  kernelDiagnostics.enabled = wasEnabled;
}

// ---------------------------------------------------------------------------------------------
// F1 — graph cardinality is not enforced by the model (retired by S1.1)
// ---------------------------------------------------------------------------------------------

console.log("\nF1 — graph cardinality (I-20)");
{
  // Two edges into the SAME input socket. Every endpoint is real and every socket type matches, so
  // `isValidFlarexEdge` — the healer's only test — accepts both. The one-wire-per-input rule lives
  // in a UI drag handler, which paste, import, AI intent and load all bypass.
  const comp = blurComp("card");
  const second = createFlarexNode("mediaIn", "card_in2");
  comp.nodes[second.id] = second;
  const duplicate = { id: "card_dup", from: { nodeId: second.id, socket: "out" }, to: { nodeId: "card_blur", socket: "in" } };
  comp.edges.push(duplicate);

  enforced("I-20", "both duplicate edges are individually 'valid' by endpoint+type", isValidFlarexEdge(comp.nodes, duplicate));

  // PROMOTED from pending to enforced by S1.1 (2026-08-01).
  const healed = healFlarexRegistry(graphFixture(comp));
  const healedEdges = healed.flarexComps?.["card"]?.edges ?? [];
  const intoBlurIn = healedEdges.filter((e) => e.to.nodeId === "card_blur" && e.to.socket === "in").length;
  enforced("I-20", "the healer enforces one wire per input socket", intoBlurIn === 1);
  enforced("I-20", "it keeps the LAST wire, matching the compiler's edgeInto", (() => {
    const kept = healedEdges.find((e) => e.to.nodeId === "card_blur" && e.to.socket === "in");
    return kept?.id === "card_dup";
  })());

  // The write seam, not just the load path — paste, AI intent and node insertion all funnel here.
  const stamped = stampFlarexComp(graphFixture(blurComp("seam")), (() => {
    const c = blurComp("seam");
    c.edges.push({ id: "seam_dup", from: { nodeId: "seam_in", socket: "out" }, to: { nodeId: "seam_blur", socket: "in" } });
    return c;
  })());
  enforced("I-20", "the write seam enforces it too", (stamped.flarexComps?.["seam"]?.edges ?? []).filter((e) => e.to.nodeId === "seam_blur" && e.to.socket === "in").length === 1);

  // The hazard the first implementation of this slice actually hit: "last wins" alone let a DANGLING
  // edge displace a real wire, silently disconnecting a node while the editor still looked right.
  enforced("I-20", "a dangling edge never outranks a connected one", (() => {
    const c = blurComp("dang");
    c.edges.push({ id: "dang_ghost", from: { nodeId: "ghost", socket: "out" }, to: { nodeId: "dang_blur", socket: "in" } });
    const out = stampFlarexComp(graphFixture(c), c).flarexComps?.["dang"]?.edges ?? [];
    const kept = out.filter((e) => e.to.nodeId === "dang_blur" && e.to.socket === "in");
    return kept.length === 1 && kept[0]!.from.nodeId === "dang_in";
  })());

  // Multi-input nodes are NOT the target: merge has in/bg, matteControl has a/b. The rule is per
  // SOCKET. A per-node rule would silently break every composite in the product.
  enforced("I-20", "distinct sockets on one node are untouched", (() => {
    const c = createFlarexComp("multi", "multi");
    const merge = createFlarexNode("merge", "multi_merge");
    const bg = createFlarexNode("mediaIn", "multi_bg");
    c.nodes[merge.id] = merge;
    c.nodes[bg.id] = bg;
    c.edges = [
      { id: "m1", from: { nodeId: "multi_in", socket: "out" }, to: { nodeId: merge.id, socket: "fg" } },
      { id: "m2", from: { nodeId: bg.id, socket: "out" }, to: { nodeId: merge.id, socket: "bg" } },
      { id: "m3", from: { nodeId: merge.id, socket: "out" }, to: { nodeId: "multi_out", socket: "in" } },
    ];
    return (healFlarexRegistry(graphFixture(c)).flarexComps?.["multi"]?.edges ?? []).length === 3;
  })());

  // The point of the slice: three consumers previously disagreed about what the graph WAS. A healed
  // graph must be one-per-socket, which is what makes edgeInto, fanout and the retime walk agree.
  enforced("I-20", "a healed graph has no duplicate input sockets at all", (() => {
    const seen = new Set<string>();
    return healedEdges.every((e) => {
      const key = `${e.to.nodeId}:${e.to.socket}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  })());
}

// ---------------------------------------------------------------------------------------------
// F2 — the persisted view dot changes compiled output (retired by S1.2)
// ---------------------------------------------------------------------------------------------

console.log("\nF2 — view dot reaches the renderers (I-26)");
{
  // `previewNodeId` is persisted EDITOR state. Compiling the same graph with and without it set must
  // produce the same pixels once ADR-012 §0.5 lands: preview routing is runtime state supplied per
  // frame, render routing is a property of the graph. Today the compiler falls back to the persisted
  // field, so a saved view dot re-roots export as well as preview.
  const withoutDot = compileFlarexComp(blurComp("dot"), lowerCtx());

  const dotted = blurComp("dot");
  dotted.previewNodeId = "dot_in"; // inspect the MediaIn — upstream of the blur
  const withDot = compileFlarexComp(dotted, lowerCtx());

  enforced("I-26", "the un-dotted graph compiles to something", withoutDot !== null);

  // PROMOTED from pending to enforced by S1.2 (2026-08-01). A viewing affordance may not change
  // delivered pixels; export begins at the graph's output regardless of what is being inspected.
  enforced("I-26", "a persisted view dot does NOT change compiled output",
    JSON.stringify(withDot) === JSON.stringify(withoutDot));

  // The dot still has to WORK — as runtime state supplied by the viewer, not read from the document.
  const viewed = compileFlarexComp(blurComp("dot2"), { ...lowerCtx(), previewRootNodeId: "dot2_in" });
  enforced("I-26", "a RUNTIME preview root still re-roots the compile",
    JSON.stringify(viewed) !== JSON.stringify(compileFlarexComp(blurComp("dot2"), lowerCtx())));

  // The scalar→map distinction. A live frame can hold several comps, each with its own dot; a scalar
  // runtime root would re-root every comp in the frame to one node — worse than the bug being fixed.
  enforced("I-26", "preview roots are per comp, not global", (() => {
    const a = blurComp("mA");
    const b = blurComp("mB");
    a.previewNodeId = "mA_in";
    b.previewNodeId = "mB_in";
    const roots: Record<string, string> = { mA: "mA_in" }; // only A is being inspected
    const rootedA = compileFlarexComp(a, { ...lowerCtx(), previewRootNodeId: roots[a.id] });
    const rootedB = compileFlarexComp(b, { ...lowerCtx(), previewRootNodeId: roots[b.id] });
    const plain = compileFlarexComp(blurComp("mB"), lowerCtx());
    // A is re-rooted (no blur wrap); B is untouched and still lowers its full chain.
    return JSON.stringify(rootedA) !== JSON.stringify(rootedB) && JSON.stringify(rootedB) === JSON.stringify(plain);
  })());
}

// ---------------------------------------------------------------------------------------------
// F3 — scarcity resolves to substituted content, unobservably (retired by S0.2 / S4.5)
// ---------------------------------------------------------------------------------------------

console.log("\nF3 — host-clip substitution (I-27, I-34)");
{
  // An asset-backed MediaIn whose loader owns the node but has no picture yet. ADR-012 §0.3 says the
  // answer must be a DECLARED absence. Today two of `resolveSourceDraw`'s five outcomes silently
  // substitute the host clip — a different shot's pixels, presented as if they were this node's.
  const comp = createFlarexComp("sub", "sub");
  const asset = createFlarexNode("mediaIn", "sub_asset");
  asset.params = { ...asset.params, sourceAssetId: "asset-1" };
  comp.nodes[asset.id] = asset;
  comp.edges = [{ id: "sub_e", from: { nodeId: asset.id, socket: "out" }, to: { nodeId: "sub_out", socket: "in" } }];

  const host = syntheticDraw("host");
  const wasEnabled = kernelDiagnostics.enabled;
  kernelDiagnostics.enabled = true;
  kernelDiagnostics.reset();

  const out = compileFlarexComp(
    comp,
    lowerCtx({ hostSourceDraw: host, resolveSourceDraw: () => null }),
  );

  const substituted = out !== null && (out as SceneLayerDraw).debugLayerId === host.debugLayerId;
  pending("S4.5", "an unresolved asset MediaIn yields the HOST clip's pixels", substituted);

  // PROMOTED from pending to enforced by S0.2 (2026-08-01). The substitution still happens — that is
  // S4.5's job — but it is no longer silent, which is the precondition for deciding whether to delete
  // it on evidence rather than on principle.
  const degradations: FlarexDegradation[] = [];
  const outReported = compileFlarexComp(
    comp,
    lowerCtx({ hostSourceDraw: host, resolveSourceDraw: () => null, onDegrade: (d) => degradations.push(d) }),
  );

  enforced("I-34", "the host substitution is reported", degradations.length === 1);
  enforced("I-34", "it is attributed to the substituting node", degradations[0]?.nodeId === "sub_asset");
  enforced("I-34", "it is flagged as a SUBSTITUTION, not a plain absence", degradations[0]?.substituted === true);
  enforced("I-34", "its cause is distinguished (no loader, vs pending, vs no resolver)", degradations[0]?.reason === "host-substituted:no-loader");

  // The out-channel contract, and the whole reason S0.2 could land before S4.5: attaching it must not
  // change a single byte of the lowering result. This is the headless half of the pixel gate.
  enforced("S0.2", "attaching the out-channel is byte-identical", JSON.stringify(outReported) === JSON.stringify(out));

  // The bridge into the sink: one identity namespace, and the count that S4.5 will be judged against.
  kernelDiagnostics.reset();
  for (const d of degradations) recordFlarexDegradation("sub", d);
  const summary = summarizeFlarexDegradations();
  enforced("I-29", "the substitution census counts it", summary.substitutedTotal === 1);
  enforced("I-29", "it joins the node identity namespace", summary.substitutions[0]?.subject === "node:sub/sub_asset");

  kernelDiagnostics.enabled = wasEnabled;
  kernelDiagnostics.reset();
}

// ---------------------------------------------------------------------------------------------
// S0.2 — every degradation is named, and absence is distinguished from substitution
// ---------------------------------------------------------------------------------------------

console.log("\nS0.2 — degradation vocabulary (I-34)");
{
  const assetComp = (id: string, retimed: boolean): FlarexComp => {
    const comp = createFlarexComp(id, id);
    const asset = createFlarexNode("mediaIn", `${id}_asset`);
    asset.params = { ...asset.params, sourceAssetId: "asset-1" };
    comp.nodes[asset.id] = asset;
    if (!retimed) {
      comp.edges = [{ id: `${id}_e`, from: { nodeId: asset.id, socket: "out" }, to: { nodeId: `${id}_out`, socket: "in" } }];
      return comp;
    }
    // A TimeSpeed above the MediaIn moves the evaluation cursor off the frame time. That difference is
    // the whole distinction between an honest same-moment degrade and a different-moment substitution.
    const speed = createFlarexNode("timeSpeed", `${id}_speed`);
    speed.params = { ...speed.params, speed: 2 };
    comp.nodes[speed.id] = speed;
    comp.edges = [
      { id: `${id}_e1`, from: { nodeId: asset.id, socket: "out" }, to: { nodeId: speed.id, socket: "in" } },
      { id: `${id}_e2`, from: { nodeId: speed.id, socket: "out" }, to: { nodeId: `${id}_out`, socket: "in" } },
    ];
    return comp;
  };

  const reasonsFor = (comp: FlarexComp, resolve: FlarexLowerCtx["resolveSourceDraw"]): string[] => {
    const seen: FlarexDegradation[] = [];
    compileFlarexComp(comp, lowerCtx({ resolveSourceDraw: resolve, onDegrade: (d) => seen.push(d) }));
    return seen.map((d) => d.reason);
  };

  enforced("I-34", "a source past its own end declares absence, never substitution", (() => {
    const seen: FlarexDegradation[] = [];
    compileFlarexComp(assetComp("ended", false), lowerCtx({ resolveSourceDraw: () => "ended", onDegrade: (d) => seen.push(d) }));
    return seen.length === 1 && seen[0]!.reason === "source-ended" && seen[0]!.substituted === false;
  })());

  enforced("I-34", "no resolver at all is distinguished from a resolver that returned null",
    reasonsFor(assetComp("nores", false), undefined).includes("host-substituted:no-resolver"));

  enforced("I-34", "an UN-retimed pending substitutes the host, and says so",
    reasonsFor(assetComp("pend", false), () => "pending").includes("host-substituted:pending"));

  // The 2026-07-29 fix, now observable: under a retime the host draw is a DIFFERENT MOMENT, so the
  // node produces nothing instead. Same input, different answer, and the difference is now recorded.
  enforced("I-34", "a RETIMED pending produces nothing instead of another moment", (() => {
    const seen: FlarexDegradation[] = [];
    compileFlarexComp(assetComp("retimed", true), lowerCtx({ resolveSourceDraw: () => "pending", onDegrade: (d) => seen.push(d) }));
    const retimed = seen.find((d) => d.reason === "source-pending-retimed");
    return retimed !== undefined && retimed.substituted === false && retimed.atTimeSeconds !== retimed.frameTimeSeconds;
  })());

  enforced("I-34", "an unimplemented node type is named, not silently null", (() => {
    const comp = createFlarexComp("ai", "ai");
    const ai = createFlarexNode("aiMatte", "ai_node");
    comp.nodes[ai.id] = ai;
    comp.edges = [{ id: "ai_e", from: { nodeId: ai.id, socket: "out" }, to: { nodeId: "ai_out", socket: "in" } }];
    const seen: FlarexDegradation[] = [];
    compileFlarexComp(comp, lowerCtx({ onDegrade: (d) => seen.push(d) }));
    return seen.some((d) => d.reason === "node-unimplemented" && d.nodeType === "aiMatte");
  })());

  // Asserted with no exemptions: a channel that reports on a healthy graph is noise, and noise is how
  // an observability channel stops being read.
  enforced("S0.2", "no degradation is reported for a healthy graph",
    reasonsFor(blurComp("healthy"), () => syntheticDraw("src")).length === 0);
}

// ---------------------------------------------------------------------------------------------
// S0.3 — presented-frame ledger (I-2 observable)
// ---------------------------------------------------------------------------------------------

console.log("\nS0.3 — presented-frame ledger (I-2)");
{
  const wasEnabled = kernelDiagnostics.enabled;
  kernelDiagnostics.enabled = true;
  presentLedger.reset();

  const sample = (targetTime: number, staleIds: string[], playing = true) => ({
    targetTime,
    participants: 3,
    staleIds,
    notReadyIds: [] as string[],
    maxStalenessSeconds: staleIds.length > 0 ? 0.12 : 0,
    playing,
  });

  notePresent(sample(0.0, []));
  notePresent(sample(0.1, []));
  notePresent(sample(0.2, ["src-a"])); // presented despite disagreement
  noteHeld("coherence", sample(0.3, ["src-a"]));
  noteHeld("not-ready", sample(0.4, []));

  const s = presentLedger.summary();
  enforced("I-2", "presents and holds are counted apart", s.presented === 3 && s.total === 5);
  enforced("I-1", "a present with a stale source is classified incoherent", s.incoherent === 1 && s.coherent === 2);
  enforced("I-1", "the incoherence rate is over PRESENTED frames, not all composites", Math.abs(s.incoherenceRate - 1 / 3) < 1e-9);
  enforced("I-1", "the two hold gates are distinguished", s["held-coherence"] === 1 && s["held-not-ready"] === 1);
  enforced("I-1", "the worst coherence error on a presented frame is retained", Math.abs(s.worstPresentedStalenessSeconds - 0.12) < 1e-9);

  // The classification is the ledger's, not the caller's — a caller cannot record a frame as coherent
  // while handing over a non-empty stale set, because `notePresent` derives the outcome itself.
  enforced("I-1", "coherence is derived, never asserted by the caller",
    presentLedger.rows().filter((r) => r.outcome === "coherent" && r.stale > 0).length === 0);

  // I-2: a viewer that cannot keep up drops presents; it never reorders them.
  presentLedger.reset();
  notePresent(sample(1.0, []));
  notePresent(sample(1.5, []));
  enforced("I-2", "forward presents are monotonic", presentLedger.summary().nonMonotonicPresents === 0);
  notePresent(sample(1.2, [])); // backward while playing
  enforced("I-2", "a backward present while playing is detected", presentLedger.summary().nonMonotonicPresents === 1);

  // Scrubbing moves the playhead backward legitimately — only PLAYBACK is required to be monotonic.
  presentLedger.reset();
  notePresent(sample(2.0, [], false));
  notePresent(sample(1.0, [], false));
  enforced("I-2", "a paused seek backward is not a monotonicity violation", presentLedger.summary().nonMonotonicPresents === 0);

  presentLedger.reset();
  kernelDiagnostics.enabled = false;
  notePresent(sample(9.0, ["x"]));
  enforced("R1", "a disabled sink records no presents", presentLedger.summary().total === 0);
  kernelDiagnostics.enabled = wasEnabled;
  presentLedger.reset();
  kernelDiagnostics.reset();
}

// ---------------------------------------------------------------------------------------------
// S2.1 — frame identity, purpose and lifecycle
// ---------------------------------------------------------------------------------------------

console.log("\nS2.1 — frame scheduler (I-30 partial)");
{
  const wasEnabled = kernelDiagnostics.enabled;
  kernelDiagnostics.enabled = true;
  __resetFrameScheduler();
  kernelDiagnostics.reset();

  enforced("I-30", "there is no active frame outside one", activeFrame() === null);

  const a = beginFrame("live", 1.5);
  enforced("I-30", "a frame carries its target time and purpose", a.targetTime === 1.5 && a.purpose === "live");
  enforced("I-30", "the active frame is readable while building", activeFrame()?.id === a.id);
  enforced("I-30", "a live frame carries a deadline", a.deadlineMs !== null);
  endFrame("presented");
  enforced("I-30", "ending a frame clears it", activeFrame() === null);

  const b = beginFrame("live", 1.6);
  enforced("I-30", "frame ids are monotonic and never reused", b.id > a.id);
  endFrame("presented");

  // ADR-012 §6.8: an export frame has nothing to gain from being rushed and everything to lose from
  // being degraded, so it declares no deadline at all.
  const exp = beginFrame("export", 0);
  enforced("I-30", "an export frame declares NO deadline", exp.deadlineMs === null);
  endFrame("presented");

  // Overlap is a purpose-scope violation waiting to happen (I-32, S2.3). Until it is structurally
  // impossible it must at least be visible, never silently tolerated.
  kernelDiagnostics.reset();
  beginFrame("live", 2);
  beginFrame("thumbnail", 2);
  enforced("I-32", "a nested frame is reported as an overlap",
    kernelDiagnostics.summary().some((r) => r.reason === "frame-overlap"));
  endFrame("abandoned");

  // Correlation: a degradation recorded inside a frame carries that frame's id, without the call site
  // having to pass it. This is what makes "which frame did that substitution happen in?" answerable.
  kernelDiagnostics.reset();
  const framed = beginFrame("live", 3);
  recordFlarexDegradation("c1", {
    nodeId: "n1", nodeType: "mediaIn", reason: "host-substituted:no-loader",
    substituted: true, atTimeSeconds: 3, frameTimeSeconds: 3,
  });
  enforced("I-29", "a degradation inherits the active frame id",
    kernelDiagnostics.events({ kind: "degradation" })[0]?.frameId === framed.id);
  endFrame("presented");

  // Healthy frames must not flood the ring — the ledger counts those. Only late/held/failed frames
  // are recorded individually, or the interesting events get evicted by the boring ones.
  kernelDiagnostics.reset();
  for (let i = 0; i < 50; i++) { beginFrame("live", i); endFrame("presented"); }
  enforced("R1", "on-time presented frames are not recorded individually",
    kernelDiagnostics.events({ kind: "transition" }).length === 0);
  beginFrame("live", 99);
  endFrame("held");
  enforced("I-30", "a held frame IS recorded",
    kernelDiagnostics.events({ kind: "transition" }).some((e) => e.reason === "frame-held"));

  __resetFrameScheduler();
  kernelDiagnostics.enabled = wasEnabled;
  kernelDiagnostics.reset();
}

// ---------------------------------------------------------------------------------------------
// S2.2 — explicit frame completion
// ---------------------------------------------------------------------------------------------

console.log("\nS2.2 — frame completion (I-30, I-31)");
{
  const wasEnabled = kernelDiagnostics.enabled;
  kernelDiagnostics.enabled = true;
  __resetFrameScheduler();
  kernelDiagnostics.reset();

  // I-30: every frame that begins, ends. `begun - completed` is 1 inside a frame and 0 outside it, and
  // any other value is a missed `endFrame` — the leak that would mis-attribute every later event.
  enforced("I-30", "no frame is in flight at rest", frameSchedulerStats().begun === frameSchedulerStats().completed);
  beginFrame("live", 0);
  enforced("I-30", "exactly one frame is in flight inside one",
    frameSchedulerStats().begun - frameSchedulerStats().completed === 1);
  endFrame("presented", true);
  enforced("I-30", "every frame that begins, ends",
    frameSchedulerStats().begun === frameSchedulerStats().completed);

  // The distinction the slice exists for. A frame that did not present cannot have settled, and the
  // scheduler enforces that rather than trusting the caller — "held but settled" would let a consumer
  // wake on a frame that never reached the screen.
  const seen: { outcome: string; settled: boolean }[] = [];
  const off = onFrameCompleted((c) => seen.push({ outcome: c.outcome, settled: c.settled }));
  beginFrame("live", 1);
  endFrame("held", true);
  enforced("I-30", "a HELD frame can never report settled", seen[0]?.settled === false);
  beginFrame("live", 2);
  endFrame("presented", false);
  enforced("I-30", "a presented frame with work outstanding is not settled", seen[1]?.settled === false);
  beginFrame("live", 3);
  endFrame("presented", true);
  enforced("I-30", "a presented frame with nothing outstanding IS settled", seen[2]?.settled === true);
  enforced("I-30", "listeners are notified for EVERY frame, not just interesting ones", seen.length === 3);
  off();
  beginFrame("live", 4);
  endFrame("presented", true);
  enforced("I-30", "unsubscribing stops notification", seen.length === 3);

  // A subscriber that throws must not take down the draw loop that notified it — the loop is the only
  // thing keeping the viewer alive, and a diagnostic consumer is never worth it.
  kernelDiagnostics.reset();
  const offThrow = onFrameCompleted(() => { throw new Error("subscriber blew up"); });
  let survived = true;
  beginFrame("live", 5);
  try { endFrame("presented", true); } catch { survived = false; }
  offThrow();
  enforced("I-30", "a throwing listener cannot break the frame loop", survived);
  enforced("I-29", "a throwing listener is REPORTED, not swallowed",
    kernelDiagnostics.events({ kind: "transition" }).some((e) => e.reason === "frame-listener-threw"));

  // The pure classifier the viewer drives — the counts that decide whether the settle window can be
  // retired. `load-bearing` is the one that blocks the flag: a repaint only the timer caught.
  enforced("I-31", "playing composites are never charged to the settle window",
    classifyComposite({ playing: true, previousSettled: true, rearmedSinceSettled: false, settled: false }) === "playing");
  enforced("I-31", "compositing toward a first settlement is the window doing its job",
    classifyComposite({ playing: false, previousSettled: false, rearmedSinceSettled: false, settled: false }) === "converging");
  enforced("I-31", "a re-armed window is converging again, not waste",
    classifyComposite({ playing: false, previousSettled: true, rearmedSinceSettled: true, settled: true }) === "converging");
  enforced("I-31", "re-settling with nothing re-armed is pure surplus",
    classifyComposite({ playing: false, previousSettled: true, rearmedSinceSettled: false, settled: true }) === "surplus");
  enforced("I-31", "an UNsettled composite nothing re-armed is load-bearing — closing the window would lose it",
    classifyComposite({ playing: false, previousSettled: true, rearmedSinceSettled: false, settled: false }) === "load-bearing");

  __resetFrameScheduler();
  kernelDiagnostics.enabled = wasEnabled;
  kernelDiagnostics.reset();
}

// I-31 — a bounded wait's expiry must be REPORTED, never indistinguishable from its success. This is
// the exact property the 600ms settle window lacks, and the reason it cannot be reasoned about: a
// consumer receives `null` and knows it timed out, rather than receiving a frame that was never ready.
// Awaited at top level so a regression fails the harness instead of becoming an unhandled rejection.
{
  const wasEnabled = kernelDiagnostics.enabled;
  kernelDiagnostics.enabled = true;
  __resetFrameScheduler();
  kernelDiagnostics.reset();

  const timedOut = await awaitFrameSettled({ timeoutMs: 5 });
  enforced("I-31", "a wait that expires resolves null rather than lying", timedOut === null);
  enforced("I-29", "an expired wait is reported",
    kernelDiagnostics.events({ kind: "transition" }).some((e) => e.reason === "frame-await-timeout"));

  // And it must actually resolve on the real signal — a wait that only ever times out is not a signal.
  const settled = awaitFrameSettled({ timeoutMs: 1000 });
  beginFrame("live", 7);
  endFrame("presented", true);
  enforced("I-30", "a wait resolves on the settling frame", (await settled)?.frame.targetTime === 7);

  // Purpose-scoped: an export frame settling must not wake a consumer waiting on the live viewer.
  const liveOnly = awaitFrameSettled({ purpose: "live", timeoutMs: 50 });
  beginFrame("export", 8);
  endFrame("presented", true);
  enforced("I-32", "a wait scoped to a purpose ignores other purposes", (await liveOnly) === null);

  __resetFrameScheduler();
  kernelDiagnostics.enabled = wasEnabled;
  kernelDiagnostics.reset();
}

// ---------------------------------------------------------------------------------------------
// S2.3 — purpose-scoped frames
// ---------------------------------------------------------------------------------------------

console.log("\nS2.3 — purpose scoping (I-32)");
{
  const wasEnabled = kernelDiagnostics.enabled;
  kernelDiagnostics.enabled = true;
  __resetFrameScheduler();
  kernelDiagnostics.reset();

  // Purpose is not decoration: it is what lets a consumer, a budget or a resource scope tell a
  // thumbnail from the live frame. If a scratch frame were opened without one, every downstream
  // distinction this slice depends on would collapse to "some frame".
  const thumb = beginFrame("thumbnail", 4);
  enforced("I-32", "a thumbnail frame declares its purpose", thumb.purpose === "thumbnail");
  enforced("I-32", "a scratch frame is still deadline-bound", thumb.deadlineMs !== null);
  endFrame("presented");

  // A scratch frame must never claim settled. `settled` means "the picture is ready"; a thumbnail is
  // one consumer's private picture at its own time, and waking a live listener on it hands that
  // listener someone else's frame — the same class of error as `presented` vs `settled` in S2.2.
  const woke: string[] = [];
  const off = onFrameCompleted((c) => { if (c.settled) woke.push(c.frame.purpose); });
  beginFrame("thumbnail", 5);
  endFrame("presented", true);
  beginFrame("capture", 6);
  endFrame("presented", true);
  beginFrame("analysis", 6.5);
  endFrame("presented", true);
  beginFrame("export", 7);
  endFrame("presented", true);
  beginFrame("live", 7.5);
  endFrame("presented", true);
  off();
  enforced("I-32", "a scratch frame can NEVER report settled, even when its caller claims it",
    !woke.includes("thumbnail") && !woke.includes("capture") && !woke.includes("analysis"));
  enforced("I-30", "a delivering purpose still settles normally",
    woke.length === 2 && woke[0] === "export" && woke[1] === "live");

  // Overlap is the observable form of the violation: a scratch frame opened INSIDE a live frame is
  // reaching live state by definition, because it is running in the live frame's turn.
  kernelDiagnostics.reset();
  beginFrame("live", 8);
  beginFrame("capture", 8);
  enforced("I-32", "a capture opened inside a live frame is reported as an overlap",
    kernelDiagnostics.events({ kind: "transition" }).some((e) => e.reason === "frame-overlap"));
  endFrame("abandoned");

  __resetFrameScheduler();
  kernelDiagnostics.enabled = wasEnabled;
  kernelDiagnostics.reset();
}

// ---------------------------------------------------------------------------------------------
// S3.1 — kernel session + state registry
// ---------------------------------------------------------------------------------------------

console.log("\nS3.1 — runtime session and state registry (I-36)");
{
  // ── I-36, asserted MECHANICALLY ────────────────────────────────────────────────────────────────
  // A prose rule about imports is worth nothing the first time someone needs `document` in a hurry.
  // This reads the kernel's own source and greps it, so the invariant fails in CI rather than in a
  // review someone was rushing. It is the cheapest structural test in the suite and the one that
  // protects the property the whole design is paid for: the same kernel runs under React, headless
  // export, a worker and a future native host WITHOUT behaviour change.
  const kernelDir = fileURLToPath(new URL("../../../packages/shared/src/kernel/", import.meta.url));
  const kernelFiles = readdirSync(kernelDir).filter((f) => f.endsWith(".ts"));
  enforced("I-36", "the kernel directory is non-empty (the scan below is not vacuous)", kernelFiles.length >= 5);

  // `performance` and a guarded `globalThis` are permitted: both exist in Node, a worker and a browser,
  // so neither ties the kernel to a host. `window`/`document` are the DOM; `WebGL`/`canvas` are a
  // rendering API; `react` is a UI framework. Those are what I-36 actually forbids.
  const forbidden: { pattern: RegExp; what: string }[] = [
    { pattern: /\bfrom\s+["']react["']/, what: "a React import" },
    { pattern: /\bdocument\./, what: "the DOM (`document`)" },
    { pattern: /\bwindow\./, what: "the DOM (`window`)" },
    { pattern: /\brequestAnimationFrame\b/, what: "a host frame loop" },
    { pattern: /\bWebGL|HTMLCanvasElement|OffscreenCanvas\b/, what: "a rendering API" },
  ];
  const violations: string[] = [];
  for (const file of kernelFiles) {
    const source = readFileSync(kernelDir + file, "utf8");
    // Comments are prose and may legitimately NAME the forbidden things — this very file's headers
    // discuss React and the DOM at length. Stripping them is what keeps the check about code.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    for (const { pattern, what } of forbidden) {
      if (pattern.test(code)) violations.push(`${file} contains ${what}`);
    }
  }
  enforced("I-36", `no kernel file imports a UI framework, DOM or rendering API (${kernelFiles.length} files scanned)`,
    violations.length === 0, violations.join(" · "));

  // ── The registry's contract ────────────────────────────────────────────────────────────────────
  const session = createRuntimeSession({ id: "conformance" });
  const other = createRuntimeSession({ id: "conformance-2" });

  enforced("I-16", "an unwritten key reads its fallback", session.state.get("missing", 7) === 7);
  session.state.set("a", 1);
  enforced("I-16", "a written key reads back", session.state.get("a", 0) === 1);
  // The property that makes a session a session: two of them cannot see each other. Without this,
  // I-37 is unreachable — a runtime you can only have one of cannot be driven twice in one process.
  enforced("I-37", "sessions are isolated from one another", other.state.get("a", 0) === 0);

  const seen: number[] = [];
  const off = session.state.subscribe<number>("a", (v) => seen.push(v));
  enforced("I-16", "subscribing does not itself deliver a value", seen.length === 0);

  // Coalescing is the whole reason this is not just a Map: a frame writes many keys, and a subscriber
  // that renders must not render once per write.
  session.state.set("a", 2);
  session.state.set("a", 3);
  session.state.flush();
  enforced("I-16", "two writes in one turn notify ONCE, with the latest value",
    seen.length === 1 && seen[0] === 3);

  // A re-write of the same value is not a change. Without this, "subscribe" would mean "wake me every
  // frame", because a frame re-writes most of its state with what it already had.
  const before = session.state.versionOf("a");
  const changed = session.state.set("a", 3);
  session.state.flush();
  enforced("I-16", "writing an unchanged value is not a change",
    changed === false && seen.length === 1 && session.state.versionOf("a") === before);

  off();
  session.state.set("a", 4);
  session.state.flush();
  enforced("I-16", "unsubscribing stops delivery", seen.length === 1);

  // A subscriber that throws must not stop the others being told, nor take down the writer — which in
  // the live runtime is the draw loop.
  const after: number[] = [];
  const offBad = session.state.subscribe("b", () => { throw new Error("bad subscriber"); });
  const offGood = session.state.subscribe<number>("b", (v) => after.push(v));
  let writerSurvived = true;
  session.state.set("b", 9);
  try { session.state.flush(); } catch { writerSurvived = false; }
  offBad(); offGood();
  enforced("I-16", "a throwing subscriber cannot break the writer or its peers",
    writerSurvived && after.length === 1 && after[0] === 9);

  // Lifecycle: the callers that will drive this (React unmount, context-loss recovery, export
  // completion) can all fire twice. A lifetime that only survives being ended once is the shape that
  // produced the double-release decoder class.
  session.dispose();
  session.dispose();
  enforced("I-24", "dispose is idempotent and leaves the session disposed", session.isDisposed);
  enforced("I-24", "a disposed session accepts no further writes",
    session.state.set("a", 99) === false && session.state.get("a", 0) === 0);
  other.dispose();
}

// ---------------------------------------------------------------------------------------------
// S3.2 — the Media Manager owns which sources EXIST
// ---------------------------------------------------------------------------------------------

console.log("\nS3.2 — media source declaration (I-16)");
{
  const wasEnabled = kernelDiagnostics.enabled;
  kernelDiagnostics.enabled = true;
  kernelDiagnostics.reset();
  const session = createRuntimeSession({ id: "media" });

  const ids = ["flarexsrc:c1:n1", "flarexsrc:c1:n2", "flarexsrc:c2:n1"];
  enforced("I-16", "declaring a source set reports the change", declareMediaSources(session, ids) === true);
  enforced("I-16", "the declared set is sorted and de-duplicated",
    sameList(getMediaSources(session).declared, ["flarexsrc:c1:n1", "flarexsrc:c1:n2", "flarexsrc:c2:n1"]));

  // Re-declaring identical membership must be a no-op. The declaration is recomputed whenever the graph
  // or timeline changes — during an edit that is every frame — and a version that moved every time would
  // make "the source set changed" a signal with no information in it.
  enforced("I-16", "re-declaring the same membership changes nothing",
    declareMediaSources(session, [...ids].reverse()) === false);

  // ── THE INVARIANT ─────────────────────────────────────────────────────────────────────────────
  // A rendering decision may change a source's PRIORITY. It may not change whether the source EXISTS.
  // Today's proxy filter deletes sources from the set, which is why a comp whose proxy drops out has
  // neither a proxy nor warm decoders — they were not demoted, they were deleted.
  suppressMediaSources(session, ["flarexsrc:c1:n1"], "comp-proxy-serving");
  const afterSuppress = getMediaSources(session);
  enforced("I-16", "suppression does NOT remove a source from the declared set",
    afterSuppress.declared.length === 3 && afterSuppress.declared.includes("flarexsrc:c1:n1"));
  enforced("I-16", "suppression is visible as its own state, not as an absence",
    sameList(afterSuppress.suppressed, ["flarexsrc:c1:n1"]) && afterSuppress.active.length === 2);
  enforced("I-29", "a suppressed source is REPORTED with its reason",
    kernelDiagnostics.events({ kind: "denial" }).some((e) => e.reason === "source-suppressed:comp-proxy-serving"));

  // Re-suppressing an unchanged set must not re-report. Otherwise the count measures how often the
  // caller recomputes rather than how often a source actually disappeared — and only the second is
  // the number S3.5 will be judged against.
  const denialsBefore = kernelDiagnostics.events({ kind: "denial" }).length;
  suppressMediaSources(session, ["flarexsrc:c1:n1"], "comp-proxy-serving");
  enforced("I-29", "an unchanged suppression set does not re-report",
    kernelDiagnostics.events({ kind: "denial" }).length === denialsBefore);

  // Suppressing something never declared would make the kernel's count disagree with the graph, which
  // is the one thing this module must never do.
  suppressMediaSources(session, ["flarexsrc:ghost:n9"], "comp-proxy-serving");
  enforced("I-16", "an undeclared source cannot be suppressed into existence",
    !getMediaSources(session).suppressed.includes("flarexsrc:ghost:n9"));

  // Removing a source from the GRAPH is the only thing that removes it from the declared set.
  declareMediaSources(session, ["flarexsrc:c2:n1"]);
  enforced("I-16", "the graph, and only the graph, decides membership",
    sameList(getMediaSources(session).declared, ["flarexsrc:c2:n1"]));

  session.dispose();
  kernelDiagnostics.enabled = wasEnabled;
  kernelDiagnostics.reset();
}

// ---------------------------------------------------------------------------------------------
// S3.3 — the Decoder Manager owns session LIFETIME
// ---------------------------------------------------------------------------------------------

console.log("\nS3.3 — decoder session lifetime (I-24)");
{
  const wasEnabled = kernelDiagnostics.enabled;
  kernelDiagnostics.enabled = true;
  kernelDiagnostics.reset();
  const session = createRuntimeSession({ id: "decoder" });

  const HOST = "flarexsrc:c1:host";
  const LOADER = "flarexsrc:c1:n2";
  const KEY_A = "blob:asset-a";
  const KEY_B = "blob:asset-b";
  declareMediaSources(session, [HOST, LOADER]);

  // A binding the Media Manager never declared would make the kernel's view disagree with the graph —
  // the same rule S3.2 enforces for suppression, and for the same reason.
  enforced("I-16", "an undeclared source cannot bind a decoder",
    bindDecoderSource(session, "flarexsrc:ghost:n9", KEY_A) === false);
  enforced("I-24", "a declared source binds its decoder key", bindDecoderSource(session, HOST, KEY_A) === true);
  bindDecoderSource(session, LOADER, KEY_B);
  enforced("I-24", "re-binding the same key is not a change", bindDecoderSource(session, HOST, KEY_A) === false);

  // ── THE INVARIANT ─────────────────────────────────────────────────────────────────────────────
  // I-24: presentation policy MUST NOT change resource lifetime. A component unmounting is presentation
  // policy. Today it is also a decoder teardown, because the effect that acquires the session is keyed
  // on `[mediaType, src]` — so a `useMemo` recompute upstream throws away a demux, a sample index and a
  // GOP window for a source that never left the graph.
  enforced("I-24", "a lifecycle release of a STILL-DECLARED source does not end the session",
    decoderReleaseVerdict(session, KEY_A, "lifecycle") === "retain");
  enforced("I-29", "the retention is REPORTED, not silent",
    kernelDiagnostics.events({ kind: "transition" }).some((e) => e.reason === "decoder-retained:lifecycle"));

  // The other half, and the half that keeps this safe. A broken decoder must never be retained: parking
  // one hands the next consumer the same wedge, which is why `tearDownSession` disposes on preemption
  // rather than parking. Only a LIFECYCLE cause is ever overruled.
  for (const cause of ["preempted", "failed", "shutdown", "undeclared"] as const) {
    enforced("I-24", `a ${cause} release is honoured immediately`,
      decoderReleaseVerdict(session, KEY_A, cause) === "release");
  }

  // ── Lifetime follows the GRAPH ────────────────────────────────────────────────────────────────
  noteDecoderSessionOpened(session, KEY_A);
  noteDecoderSessionOpened(session, KEY_B);
  const held = decoderLedger(session);
  enforced("I-24", "every open session is required by a declared source",
    held.openCount === 2 && held.orphaned.length === 0 && held.unmet.length === 0);

  // The ONE thing that ends a session: the source leaving the declared set. Nothing about rendering,
  // nothing about mounting.
  declareMediaSources(session, [HOST]);
  enforced("I-24", "a source leaving the graph makes its decoder releasable",
    decoderReleaseVerdict(session, KEY_B, "lifecycle") === "release");
  const dropped = decoderLedger(session);
  enforced("I-29", "a session outliving its requirement is VISIBLE as orphaned, not silent",
    sameList(dropped.orphaned, [KEY_B]) && sameList(dropped.staleBindings, [LOADER]));

  noteDecoderSessionClosed(session, KEY_B, "undeclared");
  enforced("I-24", "closing the orphan returns the ledger to a clean state",
    decoderLedger(session).orphaned.length === 0 && decoderLedger(session).openCount === 1);

  // A key may legitimately be opened twice — an `exclusive` retimed loader refuses to share the host's
  // session by construction (ADR-011). A ledger that collapsed those to one would under-count real
  // decoders, which is the reading the whole slice is judged on.
  noteDecoderSessionOpened(session, KEY_A);
  enforced("I-24", "a key opened twice counts as two sessions", decoderLedger(session).openCount === 2);
  noteDecoderSessionClosed(session, KEY_A, "lifecycle");
  enforced("I-24", "closing one of two leaves the other open",
    decoderLedger(session).openCount === 1 && decoderLedger(session).open.length === 1);

  // A required key with no session is STARVATION, and retention must never be able to hide it — that is
  // admission's business in S4.3, and a number that reads healthy because a park exists would bury it.
  noteDecoderSessionClosed(session, KEY_A, "failed");
  enforced("I-29", "a required key with no session reports as unmet",
    sameList(decoderLedger(session).unmet, [KEY_A]) && decoderLedger(session).openCount === 0);
  enforced("I-29", "a non-lifecycle close is recorded with its cause",
    kernelDiagnostics.events({ kind: "write-off" }).some((e) => e.reason === "decoder-closed:failed"));

  // I-31: a bounded wait whose expiry is never reported is indistinguishable from one that always paid
  // off. The residency is the bound; this is the report.
  noteDecoderRetentionExpired(session, KEY_A);
  enforced("I-31", "a retention expiry is bounded and reported",
    DECODER_RETENTION_MS > 0 &&
      kernelDiagnostics.events({ kind: "pressure" }).some((e) => e.reason === "decoder-retention-expired"));

  session.dispose();
  kernelDiagnostics.enabled = wasEnabled;
  kernelDiagnostics.reset();
}

// ---------------------------------------------------------------------------------------------
// S3.4 — the Resource Manager owns derived-cache lifetime
// ---------------------------------------------------------------------------------------------

console.log("\nS3.4 — derived resource ownership and reclamation (I-8/I-33)");
{
  const wasEnabled = kernelDiagnostics.enabled;
  kernelDiagnostics.enabled = true;
  kernelDiagnostics.reset();
  const session = createRuntimeSession({ id: "resources" });
  __resetResourceManager(session);

  const T0 = 1_000_000;
  // The exact shape of the live viewer's pool: three owners' resources in one map, which until this
  // slice were told apart by parsing a prefix off the key in two independently-maintained predicates.
  registerResource(session, "grade/layer-a", { scope: "live", kind: "grade-renderer", id: "layer-a" }, T0);
  registerResource(session, "grade/capture:layer-a", { scope: "scratch:capture", kind: "grade-renderer", id: "capture:layer-a" }, T0);
  registerResource(session, "grade/thumb:node-1", { scope: "scratch:thumb", kind: "grade-renderer", id: "thumb:node-1" }, T0);
  // A layer id and a resolved source id are routinely the SAME string. A registry that keyed on the
  // host's id alone would collapse these two into one record, and one of two real GPU resources would
  // become invisible to every count and every sweep.
  registerResource(session, "media/layer-a", { scope: "live", kind: "media-renderer", id: "layer-a" }, T0);

  enforced("I-8", "two pools may hold the same id without colliding", resourceLedger(session, T0).total === 4);
  enforced("I-8", "ownership is a SCOPE, answerable without parsing a key",
    sameList(resourcesInScope(session, "scratch:capture").map((r) => r.id), ["capture:layer-a"]) &&
      sameList(resourcesInScope(session, "scratch:thumb").map((r) => r.id), ["thumb:node-1"]) &&
      resourcesInScope(session, "live").length === 2);
  // A reclaim hands back the host's own handle, so the host indexes its pool with it rather than
  // slicing a namespace off the registry key — the habit the slice exists to remove.
  enforced("I-8", "a record carries the pool and the handle the host will delete with",
    resourcesInScope(session, "scratch:capture")[0]?.kind === "grade-renderer" &&
      resourcesInScope(session, "scratch:capture")[0]?.id === "capture:layer-a");

  // Touching an unregistered key must NOT register it. A resource whose owner was never declared must
  // not be able to acquire one by being used — that is how the three-owner map got that way.
  touchResource(session, "grade/never-declared", T0);
  enforced("I-8", "using an undeclared resource does not give it an owner", resourceLedger(session, T0).total === 4);

  // ── THE INVARIANT ─────────────────────────────────────────────────────────────────────────────
  // I-33: reclamation MUST NOT depend on frames being presented. The live prune sits after the
  // coherence-hold early return, so a held frame reclaims nothing — and a held frame is exactly when
  // pressure is building. Aging is wall clock, so it runs when the frame loop has stopped delivering.
  const T_SOON = T0 + RESOURCE_IDLE_MS / 2;
  enforced("I-33", "nothing is reclaimed before the TTL",
    collectIdleResources(session, T_SOON, RESOURCE_IDLE_MS, false) === null);

  // The safety property that lets the sweep run above the hold gate at all: an entry used THIS frame
  // has age zero, whatever the frame's outcome turns out to be.
  const T_LATE = T0 + RESOURCE_IDLE_MS * 2;
  touchResource(session, "grade/layer-a", T_LATE);
  const reclaimed = collectIdleResources(session, T_LATE, RESOURCE_IDLE_MS, false);
  enforced("I-33", "a resource touched this frame is never reclaimed, in any outcome",
    reclaimed !== null && !reclaimed.some((r) => r.key === "grade/layer-a"));
  enforced("I-33", "reclamation happens on a frame that never presented",
    reclaimed !== null && reclaimed.length === 3);
  enforced("I-29", "…and is REPORTED as such, so the I-33 census is readable",
    kernelDiagnostics.events({ kind: "pressure" }).some((e) => e.reason === "idle-reclaim-unpresented"));
  enforced("I-33", "the unpresented reclaim count is the number the amplifier is measured by",
    resourceLedger(session, T_LATE).reclaimedWhileUnpresented === 3);

  // The sweep REPORTS; the host disposes. The kernel never owns the GL object (I-36), so a record must
  // survive until the host says it is gone — a sweep that forgot on its own would make a failed dispose
  // invisible and the resource unreachable forever.
  enforced("I-8", "collecting does not itself forget the record", resourceLedger(session, T_LATE).total === 4);
  for (const record of reclaimed ?? []) forgetResource(session, record.key);
  enforced("I-8", "the host forgetting is what ends the record",
    resourceLedger(session, T_LATE).total === 1 && resourcesInScope(session, "live").length === 1);

  // A healthy session reclaims NOTHING: the set-difference fast path already disposed everything this
  // would catch. If this ever starts returning entries in the common case, the sweep has become a
  // second reclamation policy rather than a backstop for the first — which is regression G5.
  enforced("I-33", "a session whose resources are all in use sweeps nothing",
    collectIdleResources(session, T_LATE, RESOURCE_IDLE_MS, true) === null);

  __resetResourceManager(session);
  session.dispose();
  kernelDiagnostics.enabled = wasEnabled;
  kernelDiagnostics.reset();
}

// ---------------------------------------------------------------------------------------------
// S3.5 — a proxy stops deleting the sources it stands in for
// ---------------------------------------------------------------------------------------------

console.log("\nS3.5 — proxy substitution as demotion, not deletion (I-16/I-24)");
{
  const wasEnabled = kernelDiagnostics.enabled;
  kernelDiagnostics.enabled = true;
  kernelDiagnostics.reset();
  const session = createRuntimeSession({ id: "proxy" });

  const A = "flarexsrc:c1:n1";
  const B = "flarexsrc:c1:n2";
  const OTHER = "flarexsrc:c2:n1";
  const KEY_A = "blob:a";
  declareMediaSources(session, [A, B, OTHER]);
  bindDecoderSource(session, A, KEY_A);
  noteDecoderSessionOpened(session, KEY_A);

  // ── THE DIFFERENCE, stated as an assertion ────────────────────────────────────────────────────
  // Suppression and demotion both mean "stop producing". Only one of them leaves anything to come
  // back to. This is the whole slice.
  demoteMediaSources(session, [A, B], "comp-proxy-serving");
  const demoted = getMediaSources(session);
  enforced("I-16", "a demoted source is still DECLARED", demoted.declared.length === 3);
  enforced("I-16", "a demoted source is still ACTIVE — demotion is a priority, not an absence",
    demoted.active.length === 3 && sameList(demoted.demoted, [A, B]));
  enforced("I-29", "the demotion is reported with its reason",
    kernelDiagnostics.events({ kind: "transition" }).some((e) => e.reason === "source-demoted:comp-proxy-serving"));

  // The consequence that makes this worth the risk: a demoted source's DECODER survives, so when the
  // proxy falters there is something warm to fall back to. Under suppression the source was deleted,
  // its layer unmounted, and the release was honoured — a demux, an index and a GOP window from cold.
  enforced("I-24", "a demoted source's decoder is retained on a lifecycle release",
    decoderReleaseVerdict(session, KEY_A, "lifecycle") === "retain");
  enforced("I-24", "…and the session is still counted as required, not orphaned",
    decoderLedger(session).orphaned.length === 0 && sameList(decoderLedger(session).required, [KEY_A]));

  // Contrast, asserted directly rather than described: this is what the old path did.
  suppressMediaSources(session, [A, B], "comp-proxy-serving");
  const suppressed = getMediaSources(session);
  enforced("I-16", "a SUPPRESSED source is removed from the active set — the state being retired",
    suppressed.active.length === 1 && sameList(suppressed.active, [OTHER]));
  suppressMediaSources(session, [], "comp-proxy-serving");

  // Restoring is a flag flip. Nothing is re-declared, nothing is re-acquired, and the decoder never
  // moved — which is what "a crossfade in resource terms, not a cut" actually means.
  enforced("I-24", "un-demoting restores the source with its decoder untouched",
    demoteMediaSources(session, [], "comp-proxy-serving") === true &&
      getMediaSources(session).demoted.length === 0 &&
      decoderLedger(session).openCount === 1);

  // ── A session with no declared source behind it is not automatically a leak ───────────────────
  // The comp proxy decodes a rendered blob no MediaIn points at. The first soak reported every proxy
  // as `orphaned` — the reading that is supposed to mean "a session leaked" — so the criterion's false
  // positives were the normal case, which is worse than having no criterion at all.
  const PROXY_KEY = "blob:comp-proxy";
  noteDecoderSessionOpened(session, PROXY_KEY);
  enforced("I-8", "an unheld, undeclared session reads as orphaned",
    decoderLedger(session).orphaned.includes(PROXY_KEY));
  holdDecoderSession(session, PROXY_KEY, "comp-proxy:c1");
  enforced("I-8", "a HELD session is accounted for, not orphaned",
    !decoderLedger(session).orphaned.includes(PROXY_KEY) && decoderLedger(session).held.includes(PROXY_KEY));
  // A hold is a real claim on capacity, so it survives a lifecycle release exactly as a binding does.
  enforced("I-24", "a held session is retained on a lifecycle release",
    decoderReleaseVerdict(session, PROXY_KEY, "lifecycle") === "retain");
  enforced("I-24", "…but a broken hold is still released", decoderReleaseVerdict(session, PROXY_KEY, "failed") === "release");
  releaseDecoderHold(session, PROXY_KEY);
  releaseDecoderHold(session, PROXY_KEY); // idempotent: teardown paths fire twice
  enforced("I-8", "releasing the hold returns it to orphaned", decoderLedger(session).orphaned.includes(PROXY_KEY));
  noteDecoderSessionClosed(session, PROXY_KEY, "shutdown");

  // Same discipline as suppression, for the same reasons — the census has to mean something.
  enforced("I-16", "an undeclared source cannot be demoted into existence",
    demoteMediaSources(session, ["flarexsrc:ghost:n9"], "comp-proxy-serving") === false);
  demoteMediaSources(session, [A], "comp-proxy-serving");
  const before = kernelDiagnostics.events({ kind: "transition" }).length;
  enforced("I-29", "an unchanged demotion set does not re-report",
    demoteMediaSources(session, [A], "comp-proxy-serving") === false &&
      kernelDiagnostics.events({ kind: "transition" }).length === before);

  // A REPORTER must be able to tell an intentional silence from a fault, cheaply, per source per frame.
  // Two of them failed to: the freeze watchdog "healed" demoted loaders twice a second, and the frame
  // profiler logged them as "decoder dropped/preempted" — the exact opposite of what happened. Both were
  // found in the field rather than here, so the predicate they now share gets a check of its own.
  enforced("I-29", "a demoted source is answerable as demoted, without building the declaration",
    isMediaSourceDemoted(session, A));
  enforced("I-29", "…and a declared, undemoted source is not",
    !isMediaSourceDemoted(session, OTHER));

  // And the graph still wins. A demoted source that leaves the graph is gone — demotion is a rendering
  // decision, and a rendering decision may never be the thing that keeps a source alive either.
  declareMediaSources(session, [OTHER]);
  enforced("I-16", "a demoted source that leaves the graph is no longer declared",
    !getMediaSources(session).declared.includes(A));
  enforced("I-24", "…and its decoder becomes releasable, demotion notwithstanding",
    decoderReleaseVerdict(session, KEY_A, "lifecycle") === "release");

  session.dispose();
  kernelDiagnostics.enabled = wasEnabled;
  kernelDiagnostics.reset();
}

// ---------------------------------------------------------------------------------------------
// S3.3 (revised) — borrow grants are RECORDED, and the rule stays inherited
// ---------------------------------------------------------------------------------------------

console.log("\nS3.3 (revised) — borrow observability, no borrow predicate (I-29)");
{
  const session = createRuntimeSession({ id: "conformance-borrow" });
  const KEY = "https://example.test/shared.mp4#hw";

  enforced("I-29", "a session that has granted no borrows reports none", decoderLedger(session).borrows.length === 0);

  noteBorrowGrant(session, {
    key: KEY,
    incumbentTimes: [4.5, Number.NaN],
    incumbentCount: 2,
    joinerPriority: "preload",
    incumbentPriority: "playhead",
    grounds: { keyMatched: true, softwareCompatible: true, joinerSoftware: false, incumbentSoftware: false },
  });
  const [grant] = decoderLedger(session).borrows;

  enforced("I-29", "the grant is on the ledger, beside the sessions it explains", grant !== undefined);
  enforced("I-29", "…carrying the key both participants share", grant?.key === KEY);
  enforced("I-29", "…and BOTH priorities, which is what makes preload-joins-playhead findable",
    grant?.joinerPriority === "preload" && grant?.incumbentPriority === "playhead");

  // The honesty clause. A joiner has not requested anything at grant time, and the record must SAY that
  // rather than default to 0, copy the incumbent, or leave an unexplained null. A fabricated time here
  // would corrupt the very census S4.7's predicate is supposed to be derived from.
  enforced("I-29", "the joiner's time is null — it has not asked for anything yet", grant?.joinerTime === null);
  enforced("I-29", "…and the record NAMES why, rather than leaving an unexplained null",
    grant?.joinerTimeUnavailable === "joiner-has-not-requested-yet");

  // Unknown incumbent times are dropped, not coerced — same reason.
  enforced("I-29", "unknown incumbent times are omitted, never coerced to a number",
    grant?.incumbentTimes.length === 1 && grant.incumbentTimes[0] === 4.5);
  enforced("I-29", "…while the member COUNT still reports the ones with no known time",
    grant?.incumbentCount === 2);

  enforced("I-29", "the grounds explain why the borrow was offered", grant?.grounds.keyMatched === true);

  // THE BOUNDARY. S3.3 records; S4.7 decides. A rule string that ever stops saying INHERITED means a
  // predicate has been written, and this assertion is what makes that impossible to do quietly.
  enforced("I-29", "every grant is stamped with the INHERITED rule — S4.7 owns the decision",
    grant?.rule === BORROW_RULE_INHERITED && /INHERITED, not endorsed/.test(BORROW_RULE_INHERITED));

  // Bounded: a census, not a journal.
  for (let i = 0; i < 80; i++) {
    noteBorrowGrant(session, {
      key: `${KEY}/${i}`,
      incumbentTimes: [],
      incumbentCount: 1,
      joinerPriority: "playhead",
      incumbentPriority: "playhead",
      grounds: { keyMatched: true, softwareCompatible: true, joinerSoftware: true, incumbentSoftware: true },
    });
  }
  const bounded = decoderLedger(session).borrows;
  enforced("I-31", "the borrow record is bounded — an unbounded census is a leak of its own",
    bounded.length === 64 && bounded[bounded.length - 1]?.key === `${KEY}/79`);

  // And recording changes NOTHING about lifetime: this commit is behaviour-neutral by construction, so
  // the verdict for a key nobody declared must read exactly as it did before any borrow was recorded.
  enforced("I-24", "recording a borrow does not make its key required",
    decoderReleaseVerdict(session, KEY, "lifecycle") === "release");

  session.dispose();
}

// ---------------------------------------------------------------------------------------------
// S4.1 — time provenance (ADR-012 Part 7)
// ---------------------------------------------------------------------------------------------

console.log("\nS4.1 — time provenance: one authority, named derivations (T1-T5)");
{
  // The labels are compile-time brands, so the invariant that MATTERS here — an unlabelled number
  // cannot be passed where a labelled time is expected — is enforced by `tsc`, which is this repo's
  // lint step. What a runtime harness can still protect is the thing tsc cannot see: that the escape
  // hatch stays a hatch. `unsafeLabelTime` is deliberately the only unchecked way in, and its value is
  // entirely in being rare; a second unaudited cast anywhere in the kernel silently restores the
  // inference T2 forbids. So the ratchet is structural, and it is the reason this section exists at all.
  const kernelDir = fileURLToPath(new URL("../../../packages/shared/src/kernel/", import.meta.url));
  const timeTypeCast = /\bas\s+(?:Authoritative|Timeline|Committed|Target|Effective|Evaluation|Decode|Served|Presentation)Time\b|\bas\s+Time</;
  const casters: string[] = [];
  for (const file of readdirSync(kernelDir).filter((f) => f.endsWith(".ts") && f !== "time.ts")) {
    const code = readFileSync(kernelDir + file, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    if (timeTypeCast.test(code)) casters.push(file);
  }
  enforced("I-4", "only time.ts mints labelled times — every other module derives them",
    casters.length === 0, casters.join(" · "));

  // T1/T2: the crossings exist and are named. Numerically these are identities today (composition
  // coordinates equal transport seconds), which is exactly why they need to be functions: an identity
  // with a name is a seam, an identity without one is an assumption nobody can find later.
  const authoritative = authoritativeTime(12.5);
  const timeline = deriveTimelineTime(authoritative);
  const target = deriveTargetTime(timeline);
  enforced("I-4", "authoritative → timeline → target preserves the moment", (target as number) === 12.5);

  // The 2026-07-03 defect, stated as a type: `committed` and `timeline` are different labels precisely
  // because they hold different values. Asserting they can DIVERGE is what keeps someone from later
  // "simplifying" them into one alias on the grounds that both are numbers of seconds.
  const committed = commitTimelineTime(deriveTimelineTime(authoritativeTime(12.4)));
  enforced("I-4", "committed time is a distinct derivation that may trail the live one",
    (committed as number) !== (timeline as number));
  enforced("I-4", "…and reading it as live is an explicit, greppable claim",
    (assumeLiveFromCommitted(committed) as number) === 12.4);

  // T4: evaluation time is a parameter derived through the context transform, never an ambient cursor.
  const effective = unsafeLabelTime(12.0, "effective");
  enforced("I-4", "evaluation time defaults to the effective time it came from",
    (deriveEvaluationTime(effective) as number) === 12.0);
  enforced("I-4", "…and an ADR-011 context transform applies at that one crossing",
    (deriveEvaluationTime(effective, (s) => s * 2) as number) === 24.0);

  // The decode clamp is not incidental: an unclamped decode time past a source's available media is
  // the tail ping-pong / seek storm already paid for once in WebglMediaLayer.
  const evaluation = deriveEvaluationTime(effective);
  enforced("I-4", "decode time applies in-point and rate",
    (deriveDecodeTime(evaluation, { sourceInSeconds: 2, rate: 1 }) as number) === 14.0);
  enforced("I-4", "decode time clamps to the source's available media",
    (deriveDecodeTime(evaluation, { durationSeconds: 5 }) as number) === 5);
  enforced("I-4", "decode time never goes negative",
    (deriveDecodeTime(unsafeLabelTime(-3, "evaluation")) as number) === 0);
  enforced("I-4", "an unknown duration does not clamp",
    (deriveDecodeTime(evaluation) as number) === 12.0);

  // T5, and the sign convention the staleness report got wrong until 2026-08-01: POSITIVE means the
  // delivered frame is BEHIND the moment it was meant to represent.
  enforced("I-3", "a frame behind its target reports a positive coherence gap",
    coherenceGap(target, servedTime(12.0)) > 0);
  enforced("I-3", "a frame at its target reports no gap",
    coherenceGap(target, servedTime(12.5)) === 0);

  // T8's operand. The barrier that enforces monotonicity does not exist yet (S4.4), so this asserts
  // only that presentation time is reachable from effective time and from nothing else.
  enforced("I-4", "presentation time derives from the effective time that produced the frame",
    (derivePresentationTime(effective) as number) === 12.0);
}

// ---------------------------------------------------------------------------------------------
// S4.2 — servedTime survives the grade and the proxy
// ---------------------------------------------------------------------------------------------

console.log("\nS4.2 — a texture is pixels-at-a-moment (T5/T7, I-3)");
{
  // The grade stage's contract, exercised through the same helper shape both producers use: a known
  // reading becomes a labelled time; an unknowable one stays ABSENT rather than becoming a number.
  const label = (seconds: number | null): { servedTime?: ServedTime } =>
    seconds == null || !Number.isFinite(seconds) ? {} : { servedTime: servedTime(seconds) };

  const graded: SceneTextureSource = { texture: {} as never, width: 1920, height: 1080, ...label(4.25) };
  enforced("I-3", "a graded media texture carries the moment its pixels represent", graded.servedTime === 4.25);

  // The distinction the whole slice turns on. `servedTime: undefined` and an ABSENT key are different
  // under exactOptionalPropertyTypes, and only the absent form can mean "this path cannot say" without
  // a reader mistaking it for a time. A still or a generator raster is coherent at every playhead and
  // must produce the absent form, never 0 — which would read as "coherent at t=0" and be wrong at every
  // other moment.
  const timeless: SceneTextureSource = { texture: {} as never, width: 8, height: 8, ...label(null) };
  enforced("I-3", "a time-invariant source omits the field rather than claiming a time",
    !("servedTime" in timeless));
  enforced("I-3", "…and a non-finite reading is treated as unknowable, not coerced",
    !("servedTime" in { ...label(Number.NaN) }));

  // T7: a proxy is a source. This is the participant that had a version and no time, so a whole comp's
  // stand-in could be arbitrarily behind the playhead and still read as ready.
  const proxied: FlarexCompProxyFrame = {
    source: {} as never,
    sourceWidth: 1920,
    sourceHeight: 1080,
    sourceVersion: 7,
    ...label(4.2),
  };
  enforced("I-3", "a proxy frame carries a served time — T7, a proxy is a source",
    proxied.servedTime === 4.2);

  // What the barrier will do with them (S4.4 owns the decision; this asserts only that the operands
  // are now present and comparable). A held texture reports the grade's moment, not the request's —
  // which is the entire reason the field exists.
  const target = deriveTargetTime(deriveTimelineTime(authoritativeTime(4.5)));
  enforced("I-3", "a held texture's gap from the frame it should represent is now computable",
    Math.abs(coherenceGap(target, servedTime(graded.servedTime!)) - 0.25) < 1e-9);
  enforced("I-3", "…for the proxy participant too, in the same units",
    Math.abs(coherenceGap(target, servedTime(proxied.servedTime!)) - 0.3) < 1e-9);
}

// ---------------------------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------------------------

console.log("");
if (pendingResolved > 0) {
  console.log(`${pendingResolved} pending check(s) no longer reproduce — promote to enforced():`);
  for (const note of pendingNotes) console.log(`  - ${note}`);
  console.log("");
}
if (enforcedFailures > 0) {
  console.error(`kernel:conform FAILED — ${enforcedFailures} enforced invariant(s) broken`);
  process.exit(1);
}
console.log("kernel:conform OK — all enforced invariants hold");
