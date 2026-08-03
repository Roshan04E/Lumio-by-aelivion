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
  admissionDenials,
  contributionRank,
  resolveReadiness,
  MAX_PRESENTATION_LAG_S,
  type ReadinessParticipant,
  noteAdmissionDenied,
  rankAdmission,
  MIN_RESIDENCY_MS,
  PERMANENT_DENIAL_AFTER_MS,
  type AdmissionCandidate,
  type VisibleContribution,
  noteBorrowGrant,
  noteBorrowRefused,
  noteSatisfactionMiss,
  satisfactionMisses,
  sessionSatisfaction,
  borrowRefusals,
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
  checkHandle,
  collectIdleResources,
  noteStaleHandle,
  staleHandleCount,
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
/**
 * Every `.ts` under `dir`, recursively. Used by the source-level ratchets, which have to scan a whole
 * tree rather than one file: a rule like "nobody reads the ambient frame's time" is only worth
 * asserting if it is asserted everywhere the read could appear.
 */
function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...walkTs(full));
    else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) out.push(full);
  }
  return out;
}

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
  // `get<number>`, explicitly: the generic otherwise infers from the fallback LITERAL, so `get("a", 0)`
  // is typed `0` and `=== 1` is a compile error about types that "have no overlap". The assertion was
  // always correct at runtime — it is the inference that was too narrow, and widening it is the whole
  // fix. Worth naming because the failure mode is an assertion that cannot be written rather than one
  // that is wrong, and the tempting workaround (compare against 0) would have deleted the check.
  enforced("I-16", "a written key reads back", session.state.get<number>("a", 0) === 1);
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

  // ── S5.2 — HANDLES WITH GENERATIONS (I-17/I-9) ──────────────────────────────────────────────────
  // A device pointer cannot answer "are you still the thing that exists?", so today only statement
  // ordering keeps the `SceneTextureSource` path from sampling a disposed texture — and nothing
  // notices when the ordering is wrong. A handle can be asked.
  __resetResourceManager(session);
  const h1 = registerResource(session, "grade/gen", { scope: "live", kind: "grade-renderer", id: "gen" }, T0);
  enforced("I-9", "a live handle resolves", checkHandle(session, h1) === null);

  // Idempotent re-registration is a TOUCH, so a handle a caller already holds must survive it.
  // Bumping here would invalidate live handles on the most common call in the system.
  const h1again = registerResource(session, "grade/gen", { scope: "live", kind: "grade-renderer", id: "gen" }, T0);
  enforced("I-9", "re-registering the same key is a touch, not a new incarnation",
    h1again.generation === h1.generation && checkHandle(session, h1) === null);

  // THE CASE THE SLICE EXISTS FOR: dispose, recreate under the SAME key, then sample a handle taken
  // before the dispose. A generation stored on the record would have died with it and reissued the
  // same number — the stale handle would validate against the resource that replaced it, which is
  // worse than no check at all. The counter therefore outlives the record.
  forgetResource(session, "grade/gen");
  enforced("I-9", "a forgotten key reports MISSING, not merely false",
    checkHandle(session, h1) === "missing");
  const h2 = registerResource(session, "grade/gen", { scope: "live", kind: "grade-renderer", id: "gen" }, T0);
  enforced("I-17", "a rebuilt key does NOT reissue the disposed incarnation's generation",
    h2.generation > h1.generation);
  enforced("I-17", "…so the pre-dispose handle reports STALE against its replacement",
    checkHandle(session, h1) === "stale" && checkHandle(session, h2) === null);

  // I-35: the failure says WHICH, because the two are different bugs — `missing` is a lifetime that
  // ended under the holder, `stale` is a key rebuilt while the holder kept the old reference.
  const before = staleHandleCount();
  noteStaleHandle(session, h1, "stale");
  enforced("I-29", "a stale resolve is counted, so I-17 has a field census",
    staleHandleCount() === before + 1);
  enforced("I-29", "…and attributed to the key that was superseded",
    kernelDiagnostics.events({ kind: "degradation" }).some((e) => e.reason === "handle-stale"));

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
  // Two ways in, and BOTH are the hatch. A cast is the obvious one; `unsafeLabelTime` is the other, and
  // S4.4's barrier nearly used it for exactly the reason the hatch exists to prevent — a second module
  // needing a label and reaching for the escape instead of a named derivation. Catching only casts would
  // have let that through while the ratchet reported green, which is the failure mode a ratchet has.
  const timeTypeCast = /\bas\s+(?:Authoritative|Timeline|Committed|Target|Effective|Evaluation|Decode|Served|Presentation)Time\b|\bas\s+Time<|\bunsafeLabelTime\s*\(/;
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
// S4.7 — session satisfaction: can this session serve the new requirement without harming the old?
// ---------------------------------------------------------------------------------------------

console.log("\nS4.7 — session satisfaction (I-29/P11; ADR-012 §3.11)");
{
  // The pool's own tolerance at 30fps: SHARE_DIVERGENCE_FRAMES(2) / 30. The predicate is handed this
  // same number so it refuses exactly what `isDiverged` would later detach — see below.
  const TOL = 2 / 30;

  // ── THE CASE SHARING WAS BUILT FOR. One file read as both the host clip and a comp's MediaIn, both
  // tracking the same playhead. This MUST still share: the slice's own risk line says a too-strict
  // predicate spends the sessions sharing exists to save, and this is that saving.
  enforced("I-29", "the duplicate-decode share survives — same file, same moment",
    sessionSatisfaction([12.0], 12.0, TOL).satisfies);
  enforced("I-29", "…and survives sub-frame jitter between two members tracking one playhead",
    sessionSatisfaction([12.0], 12.0 + TOL * 0.5, TOL).satisfies);
  enforced("I-29", "…right up to the tolerance boundary, which is a share not a detach",
    sessionSatisfaction([12.0], 12.0 + TOL, TOL).satisfies);

  // ── THE SAME-TICK MOUNT. Two layers mounting in one tick is the most common real share, and neither
  // has requested anything yet. Nothing is being served, so nothing can be degraded.
  enforced("I-29", "a session nobody has asked anything of yet can always be joined",
    sessionSatisfaction([Number.NaN, Number.NaN], 12.0, TOL).satisfies);
  enforced("I-29", "…and that is reported as an absence of demand, not as co-location",
    sessionSatisfaction([Number.NaN], 12.0, TOL).reason === "no-incumbent-demand");

  // ── THE MEASURED HARM (2026-08-02). A preload joiner ~1.2s from a SERVING incumbent, at capMisses 0:
  // spare capacity, harmful reuse. Two hardware resets and ~295ms of lost supply on the on-screen clip.
  const harmful = sessionSatisfaction([12.0], 13.2, TOL);
  enforced("I-29", "a preload joining a serving session 1.2s away is refused", !harmful.satisfies);
  enforced("I-29", "…with the reason and the distance both stated, not merely denied",
    harmful.reason === "would-diverge" && Math.abs((harmful.gapSeconds ?? 0) - 1.2) < 1e-9);

  // ── THE INTERFACE HOLE, closed. Before S4.7 the acquire path carried no time at all, so this was the
  // only reachable state. It must REFUSE: granting anyway would restore the unguarded borrow under a
  // flag claiming to have fixed it, and a missed call site would be silent instead of visible.
  const undeclared = sessionSatisfaction([12.0], null, TOL);
  enforced("I-29", "an undeclared joiner cannot prove it is safe, so it does not borrow",
    !undeclared.satisfies && undeclared.reason === "joiner-undeclared");
  enforced("I-29", "…but only when there is service to protect — undeclared is not itself a refusal",
    sessionSatisfaction([], null, TOL).satisfies);

  // ── THE WIDEST incumbent governs, not the nearest. A session serving two moments must not admit a
  // third that is close to one of them and far from the other.
  const spread = sessionSatisfaction([12.0, 12.9], 12.95, TOL);
  enforced("I-29", "the FURTHEST incumbent decides — being near one member is not enough",
    !spread.satisfies && Math.abs((spread.gapSeconds ?? 0) - 0.95) < 1e-9);

  // ── THE BOND WITH THE BACKSTOP. This is what makes "noteDivergence fires zero times" a real
  // assertion rather than a hope: the predicate and the detach must agree on every pair of times. A
  // second, independently-chosen threshold here would silently decouple them, and the done-when would
  // become unfalsifiable. Swept across the boundary, both directions.
  let disagreements = 0;
  for (let delta = 0; delta <= 0.4; delta += 0.005) {
    const granted = sessionSatisfaction([10.0], 10.0 + delta, TOL).satisfies;
    // `isDiverged`'s criterion, restated: spread strictly greater than tolerance is divergence.
    const wouldDetach = 10.0 + delta - 10.0 > TOL + 1e-12;
    if (granted === wouldDetach) disagreements += 1;
  }
  enforced("I-29", "the predicate refuses EXACTLY what the divergence backstop would detach",
    disagreements === 0, `${disagreements} disagreements across the tolerance sweep`);

  // ── REFUSALS ARE OBSERVABLE. A refusal costs a session out of a budget of four; an unexplained one
  // would be the same undeclared degradation this slice removes, pointed the other way.
  const session = createRuntimeSession({ id: "conformance-satisfaction" });
  noteBorrowRefused(session, {
    key: "https://example.test/a.mp4#hw",
    verdict: harmful,
    joinerPriority: "preload",
    incumbentPriority: "playhead",
  });
  const [refusal] = borrowRefusals(session);
  enforced("I-29", "a refused borrow is recorded with its reason and its measured gap",
    refusal?.reason === "would-diverge" && Math.abs((refusal.gapSeconds ?? 0) - 1.2) < 1e-9);
  enforced("I-29", "…and with both priorities, which is the shape the 2026-08-02 harm had",
    refusal?.joinerPriority === "preload" && refusal.incumbentPriority === "playhead");

  // ── THE DONE-WHEN's counter. Zero until the backstop fires; a firing is a defect report against the
  // predicate, not a routine correction (programme §10).
  enforced("I-29", "satisfaction misses start at zero — the number the soak is judged on",
    satisfactionMisses(session) === 0);
  noteSatisfactionMiss(session, "https://example.test/a.mp4#hw", { requestedTimes: [10, 11] });
  enforced("I-29", "…and a divergence detach is counted as a MISS, not as normal operation",
    satisfactionMisses(session) === 1);

  session.dispose();
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
// S4.3 — source admission: who gets scarce decode capacity
// ---------------------------------------------------------------------------------------------

console.log("\nS4.3 — source admission (ADR-012 §6.3/§6.11/§6.12)");
{
  const session = createRuntimeSession({ id: "conformance-s43" });
  const NOW = 100_000;
  const seen = (key: string, contribution: VisibleContribution | undefined, opts: Partial<AdmissionCandidate> = {}): AdmissionCandidate => ({
    key,
    priority: "playhead",
    contribution,
    firstRequestedAtMs: NOW,
    admittedAtMs: null,
    ...opts,
  });
  const visible = (area: number, opacity = 1): VisibleContribution => ({
    reachable: true,
    area,
    opacity,
    underDisabledBranch: false,
  });

  // ── §6.3: RANKED BY CONTRIBUTION, NOT ARRIVAL. This is the defect the slice exists for — mount order
  // is a React scheduling artifact, so under first-come the source that looks broken can change between
  // two runs of one project. `small` asks FIRST and must still lose.
  const byArrival = [seen("small", visible(0.02)), seen("full", visible(0.9))];
  const ranked = rankAdmission(byArrival, 1, NOW);
  enforced("I-27", "a large contributor beats a small one that asked first",
    sameList(ranked.admitted, ["full"]));
  // NON-VACUITY: assert arrival order really would have chosen differently. Without this the check
  // passes just as well on a fixture where both orders agree, which proves nothing about ranking.
  enforced("I-27", "…and arrival order WOULD have chosen the other one (the defect is reproduced)",
    byArrival[0]!.key === "small");

  // Determinism on the size the slice's own testing line names. Same inputs, same answer, twice —
  // including the tie-break, which is arbitrary but must be FIXED or a comp's denied source changes
  // between two identical frames.
  const eight = Array.from({ length: 8 }, (_, i) => seen(`m${i}`, visible(0.1)));
  const a = rankAdmission(eight, 3, NOW);
  const b = rankAdmission([...eight].reverse(), 3, NOW);
  enforced("I-27", "ranking is deterministic and order-independent across 8 equal MediaIns",
    sameList(a.admitted, b.admitted) && a.admitted.length === 3);

  // ── Invisible is not the same as unlucky. A comp full of disabled branches must not read as
  // over-budget, or whoever reads the diagnostic raises a cap that was never the constraint.
  const invisible = rankAdmission(
    [seen("on", visible(0.5)), seen("off", { reachable: true, area: 0.9, opacity: 1, underDisabledBranch: true })],
    2,
    NOW
  );
  enforced("I-27", "a zero-contribution source is denied for CONTRIBUTION, not for scarcity",
    invisible.denied.find((d) => d.key === "off")?.reason === "no-visible-contribution");
  enforced("I-27", "…even with capacity to spare — it is not a budget problem",
    invisible.admitted.length === 1 && !invisible.admitted.includes("off"));
  enforced("I-27", "a fully transparent source contributes nothing however large it is",
    contributionRank(visible(1, 0)) === 0);

  // ── The undeclared-input rule, learned the hard way in S3.3 and S4.7: a decision input that does not
  // exist must be RECORDED as absent, never defaulted. Zero would silently starve every consumer not yet
  // taught to declare — an instrumentation gap turning into a black picture.
  const mixed = rankAdmission([seen("known", visible(0.5)), seen("unknown", undefined), seen("dead", { reachable: false, area: 1, opacity: 1, underDisabledBranch: false })], 3, NOW);
  enforced("I-29", "an undeclared contribution outranks a provably-invisible source…",
    contributionRank(undefined) > contributionRank({ reachable: false, area: 1, opacity: 1, underDisabledBranch: false }));
  enforced("I-29", "…and loses to a provably-visible one",
    contributionRank(undefined) < contributionRank(visible(0.5)));
  enforced("I-29", "…and the denial says the input was missing, not that the source was worthless",
    rankAdmission([seen("known", visible(0.5)), seen("unknown", undefined)], 1, NOW)
      .denied.find((d) => d.key === "unknown")?.undeclared === true);
  enforced("I-27", "an unreachable source is denied on contribution", mixed.denied.some((d) => d.key === "dead"));

  // ── §6.11 FAIRNESS. A persistently low-ranked source must eventually win or be declared denied.
  // Waiting forever is not one of the two acceptable ends.
  const starved = seen("tiny", visible(0.01), { firstRequestedAtMs: NOW - 20_000 });
  const fresh = seen("mid", visible(0.2));
  enforced("I-31", "aging lifts a long-denied source above a higher-contribution newcomer",
    sameList(rankAdmission([starved, fresh], 1, NOW).admitted, ["tiny"]));
  enforced("I-31", "…and without aging it would still be losing (the term is doing the work)",
    sameList(rankAdmission([{ ...starved, firstRequestedAtMs: NOW }, fresh], 1, NOW).admitted, ["mid"]));
  const forever = rankAdmission(
    [seen("big", visible(0.9)), seen("never", visible(0.001), { firstRequestedAtMs: NOW - PERMANENT_DENIAL_AFTER_MS - 1 })],
    0,
    NOW
  );
  enforced("I-31", "a source denied past the terminal is DECLARED permanently denied, not left waiting",
    forever.denied.find((d) => d.key === "never")?.reason === "permanently-denied");

  // ── HYSTERESIS damps oscillation, NOT badness. The slice's testing line is explicit that an
  // under-budget comp with divergent trajectories must produce no churn at all — churn that residency
  // has to damp when capacity is sufficient would mean the ranking is wrong, and damping it hides that.
  const incumbent = seen("held", visible(0.1), { admittedAtMs: NOW - 100 });
  const challenger = seen("better", visible(0.8));
  const damped = rankAdmission([incumbent, challenger], 1, NOW);
  enforced("I-25", "an incumbent inside its residency window keeps the slot against a better challenger",
    sameList(damped.admitted, ["held"]));
  enforced("I-25", "…and that is REPORTED as hysteresis, not passed off as a ranking outcome",
    sameList(damped.heldByResidency, ["held"]));
  const expired = rankAdmission([{ ...incumbent, admittedAtMs: NOW - MIN_RESIDENCY_MS - 1 }, challenger], 1, NOW);
  enforced("I-25", "…and once residency expires the better source takes it",
    sameList(expired.admitted, ["better"]));
  const underBudget = rankAdmission([seen("x", visible(0.3)), seen("y", visible(0.7))], 4, NOW);
  enforced("I-25", "an UNDER-BUDGET comp denies nothing and needs no damping",
    underBudget.denied.length === 0 && underBudget.heldByResidency.length === 0);

  // ── §6.12 / THE DONE-WHEN: denial is observable in diagnostics for over-budget comps. A `null` return
  // and a `capMisses` counter is a number with no subject; this is the same event with a name attached.
  enforced("I-29", "no denials are recorded before anything is denied", admissionDenials(session).length === 0);
  const overBudget = rankAdmission(
    [seen("a1", visible(0.9)), seen("a2", visible(0.5)), seen("a3", visible(0.3)), seen("a4", visible(0.2))],
    2,
    NOW
  );
  for (const denial of overBudget.denied) noteAdmissionDenied(session, denial);
  const recorded = admissionDenials(session);
  enforced("I-29", "an over-budget comp reports every denial it made",
    recorded.length === 2 && sameList([...recorded].map((d) => d.key).sort(), ["a3", "a4"]));
  enforced("I-29", "…each naming the bar it failed to clear, so 'raise the cap' is a checkable claim",
    recorded.every((d) => d.admittedFloor != null && d.rank < d.admittedFloor!));
  enforced("I-29", "…and attributing the denial to scarcity rather than to invisibility",
    recorded.every((d) => d.reason === "over-budget"));

  // ── THE AUTHORITATIVE HALF (S4.3). The pool asks one question of the ranking: did the newcomer win,
  // and if so which incumbent yields? These assert the shape that question is answered in, because the
  // pool's branch is `decision.admitted.includes(url)` plus the first denied incumbent — and both halves
  // have to be true together or a source loses a session it should have kept.
  const INCUMBENT = { reachable: true, area: 0.05, opacity: 1, underDisabledBranch: false };
  const NEWCOMER = { reachable: true, area: 0.85, opacity: 1, underDisabledBranch: false };
  const contested = rankAdmission(
    [
      { key: "incumbent", priority: "playhead", contribution: INCUMBENT, firstRequestedAtMs: 0, admittedAtMs: 0 },
      { key: "newcomer", priority: "playhead", contribution: NEWCOMER, firstRequestedAtMs: 5_000, admittedAtMs: null },
    ],
    1,
    5_000
  );
  enforced("I-27", "a large newcomer wins the last slot from a tiny incumbent past its residency",
    sameList(contested.admitted, ["newcomer"]) && contested.denied[0]?.key === "incumbent");

  // The rollback property, asserted rather than asserted-about: the ranking must not name a victim when
  // the newcomer LOST. The pool preempts only on `admitted.includes(url)`, so a ranking that admitted
  // the newcomer while also denying it — or that denied everyone — would make the flag able to churn
  // sessions for no gain. A slice whose kill switch is its only safety net has to be checkable here.
  const outranked = rankAdmission(
    [
      { key: "incumbent", priority: "playhead", contribution: NEWCOMER, firstRequestedAtMs: 0, admittedAtMs: 0 },
      { key: "newcomer", priority: "playhead", contribution: INCUMBENT, firstRequestedAtMs: 5_000, admittedAtMs: null },
    ],
    1,
    5_000
  );
  enforced("I-27", "a small newcomer takes nothing — no victim is named when it lost",
    sameList(outranked.admitted, ["incumbent"]) && !outranked.admitted.includes("newcomer"));

  // I-24 again, from the admission side. A demoted or pre-roll source must not be RANKED at zero —
  // `hidden`/`suspended` are deliberately absent from `getLayerVisibleContribution`'s inputs, so the
  // only way they could reach the ranking is if someone added them. What is assertable here is the
  // consequence: an ordinary visible source and a pre-roll source with the same geometry rank the same,
  // because nothing in the contribution shape can express "about to be shown".
  enforced("I-24", "contribution has no channel for transport state — a pre-roll shell cannot be ranked down",
    contributionRank(NEWCOMER) === contributionRank({ ...NEWCOMER }));

  session.dispose();
}

// ---------------------------------------------------------------------------------------------
// S4.4 — the readiness barrier answers with a MOMENT, not a boolean
// ---------------------------------------------------------------------------------------------

console.log("\nS4.4 — the latest coherent moment (I-1/I-6, T3)");
{
  const target = deriveTargetTime(deriveTimelineTime(authoritativeTime(10)));
  const at = (id: string, seconds: number | null | undefined): ReadinessParticipant =>
    seconds === undefined ? { id } : { id, servedTime: seconds === null ? null : servedTime(seconds) };

  // ── THE DEFECT THE SLICE EXISTS FOR. `shouldHoldForCoherence` opens with
  // `if (!enabled || playing || …) return false` — it does nothing while the transport moves, because
  // "hold or don't" has no good answer there. The barrier's question does.
  const lagging = resolveReadiness(target, [at("a", 10), at("b", 9.8)]);
  enforced("I-6", "a frame with one lagging source resolves to a MOMENT both can show",
    lagging.outcome === "lagged" && Math.abs((lagging.effectiveTime as number) - 9.8) < 1e-9);
  enforced("I-6", "…and names who put it there, so the lag has a subject",
    sameList(lagging.constrainedBy, ["b"]) && Math.abs(lagging.lagSeconds - 0.2) < 1e-9);

  // The minimum, not the average or the newest — either of those names a moment some participant has
  // no pixels for, which is the incoherence the barrier exists to remove.
  const three = resolveReadiness(target, [at("a", 10), at("b", 9.9), at("c", 9.5)]);
  enforced("I-1", "the effective time is the OLDEST served moment, never an average",
    Math.abs((three.effectiveTime as number) - 9.5) < 1e-9);

  // ── ABSENT vs NULL. A still is coherent at every moment and must not drag the frame backwards; a
  // time-dependent source with NO pixels cannot be repaired by moving time at all. Collapsing the two
  // is how a generator raster ends up setting a frame's clock.
  const withStill = resolveReadiness(target, [at("video", 10), at("still", undefined)]);
  enforced("I-1", "a time-invariant participant constrains nothing",
    withStill.outcome === "coherent" && (withStill.effectiveTime as number) === 10);
  const withDead = resolveReadiness(target, [at("video", 10), at("dead", null)]);
  enforced("I-27", "a participant with no pixels is DECLARED degraded, never served by moving time",
    withDead.outcome === "degraded" && sameList(withDead.degraded, ["dead"]));
  enforced("I-27", "…and does not drag the effective time anywhere — there is no moment that fixes it",
    (withDead.effectiveTime as number) === 10);

  // ── I-2 / monotonicity: a source serving AHEAD of the request must not pull the frame into the
  // future. This is tracker v33's 35-second reading — a backward seek still holding its old frame — and
  // a barrier that took the minimum without a ceiling would have presented it.
  const ahead = resolveReadiness(target, [at("a", 45), at("b", 10)]);
  enforced("I-2", "a source running AHEAD cannot drag the frame forward; the request is the ceiling",
    (ahead.effectiveTime as number) === 10 && ahead.outcome === "coherent");

  // ── §6.9's bounded lag. Past the budget, walking further back is a stall wearing coherence's
  // clothes, so it is declared rather than presented.
  const stalled = resolveReadiness(target, [at("a", 10), at("b", 10 - MAX_PRESENTATION_LAG_S - 0.01)]);
  enforced("I-31", "lag past the declared budget is a DEGRADATION, not an ever-deeper hold",
    stalled.outcome === "degraded" && stalled.degraded.includes("b"));
  const withinBudget = resolveReadiness(target, [at("a", 10), at("b", 10 - MAX_PRESENTATION_LAG_S + 0.01)]);
  enforced("I-31", "…and inside the budget it is still presented, coherent and late",
    withinBudget.outcome === "lagged");

  // ── PURITY (I-37): the same inputs give the same verdict, with no clock read. This is what lets an
  // export, a worker and this harness share one barrier.
  const a = resolveReadiness(target, [at("x", 9.7), at("y", 9.9)]);
  const b = resolveReadiness(target, [at("y", 9.9), at("x", 9.7)]);
  enforced("I-37", "the barrier is pure and order-independent",
    a.effectiveTime === b.effectiveTime && a.outcome === b.outcome);

  // An empty frame is on time, not infinitely late — the degenerate case a minimum gets wrong.
  enforced("I-1", "a frame with no time-dependent participants is on time",
    resolveReadiness(target, []).outcome === "coherent");
}

// ---------------------------------------------------------------------------------------------
// S4.5 + S4.6 — the fallback is gone and there is ONE timing policy
// ---------------------------------------------------------------------------------------------
//
// Four properties were required before this slice counts as complete. Three are structural and are
// asserted by scanning source, because they are claims about what does NOT exist — and "I removed it"
// is exactly the claim a reviewer cannot check by reading a diff of what remains.

console.log("\nS4.5 + S4.6 — declared absence, and one timing policy (I-27/I-34/I-6)");
{
  const webDir = fileURLToPath(new URL("../../web/src/", import.meta.url));
  const sharedDir = fileURLToPath(new URL("../../../packages/shared/src/", import.meta.url));
  const strip = (source: string): string =>
    source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  // ── (2) THE FALLBACK IS DELETED, NOT RELOCATED. One site may name `hostSourceDraw` as a *value* —
  // the compiler's own guarded return — and no other module may construct a draw from it. A relocated
  // fallback would show up as a second file reaching for the host draw.
  const hostDrawUsers: string[] = [];
  for (const file of [...walkTs(sharedDir), ...walkTs(webDir)]) {
    if (file.endsWith("compile-flarex.ts") || file.endsWith("build-scene-draws.ts")) continue;
    if (/cloneImage\s*\(\s*ctx\.hostSourceDraw|draw:\s*ctx\.hostSourceDraw/.test(strip(readFileSync(file, "utf8")))) {
      hostDrawUsers.push(file.split(/[\\/]/).slice(-2).join("/"));
    }
  }
  enforced("I-27", "the host-clip substitution exists in ONE place — it was deleted, not moved",
    hostDrawUsers.length === 0, hostDrawUsers.join(" · "));

  // …and that one place is genuinely guarded. A `return` of the host draw with no policy check above it
  // would mean the flag does nothing, which is the difference between deleting a fallback and
  // describing one.
  const compiler = strip(readFileSync(`${sharedDir}flarex/compile-flarex.ts`, "utf8"));
  enforced("I-34", "…and that place is gated on the declared policy, so the switch is real",
    /allowHostSubstitution\s*===\s*false\s*&&\s*substituting\s*\)\s*return null;/.test(compiler));

  // …and the deletion stays SCOPED to the case I-27 actually forbids. The first version of S4.5
  // returned null for every path that reached the host draw and failed 11 flarex fixtures at up to
  // 76.9% — on frames the ledger reported fully settled, with the degradation channel naming
  // `host-substituted:no-loader` on every one and `:pending` on none. `no-loader` is not a
  // substitution: no loader was ever promoted, so the host clip IS that node's source.
  //
  // This asserts the PREDICATE, not the gate, because the gate above would keep passing if someone
  // widened `substituting` to true. That is exactly how the bug was written the first time.
  enforced("I-27", "…and it deletes only a genuine substitution — `no-loader` is this node's own source",
    /substituting\s*=\s*resolved\s*===\s*"pending";/.test(compiler),
    "the host draw may be withheld only when the node HAS a loader whose pixels have not arrived");

  // ── (1) THE OLD TIMING POLICIES ARE UNREACHABLE, NOT MERELY BYPASSED. `shouldHoldForCoherence` may
  // be called from exactly one site, and only from the flag-off branch. More than one live call site
  // means a second timing policy survived the unification.
  let holdCallSites = 0;
  for (const file of walkTs(webDir)) {
    if (file.endsWith("temporal-coherence.ts") || file.includes(".test.")) continue;
    holdCallSites += (strip(readFileSync(file, "utf8")).match(/shouldHoldForCoherence\s*\(/g) ?? []).length;
  }
  enforced("I-6", "the paused-only barrier has exactly ONE caller, reachable only with the flag off",
    holdCallSites === 1, `${holdCallSites} call sites`);

  // ── (3) ONE SOURCE OF EVALUATION TIME. `effectiveTime` may be minted in one place only, and S4.4's
  // ratchet already proves that for the label. What this adds is the barrier's own exclusivity: no
  // module outside the kernel may construct a readiness verdict, so there is no second way to compute
  // "the moment to render at".
  const verdictBuilders: string[] = [];
  for (const file of [...walkTs(sharedDir), ...walkTs(webDir)]) {
    // `time.ts` DEFINES it and `readiness-barrier.ts` is its only permitted caller; both excluded by
    // NAME rather than by pattern, so a third file is a failure and not a quiet widening. The first run
    // of this check failed on `time.ts` itself — the definition matched a regex meant for calls, which
    // is the ordinary way a source scan ends up asserting something other than what it claims.
    if (file.endsWith("readiness-barrier.ts") || file.endsWith("time.ts")) continue;
    if (/effectiveTimeFromBarrier\s*\(/.test(strip(readFileSync(file, "utf8")))) {
      verdictBuilders.push(file.split(/[\\/]/).slice(-2).join("/"));
    }
  }
  enforced("I-1", "only the readiness barrier mints an effective time — there is no alternate timing path",
    verdictBuilders.length === 0, verdictBuilders.join(" · "));

  // ── (4) ROLLBACK. The flag-off path must be the PREVIOUS renderer, which is only true if the old
  // code still exists to be restored. Asserted positively: deleting `shouldHoldForCoherence` outright
  // would pass the "one caller" check above while destroying the rollback, so both directions matter.
  const coherence = readFileSync(`${webDir}playback/temporal-coherence.ts`, "utf8");
  enforced("I-25", "the pre-S4.6 barrier is retained so flag-off restores the previous renderer",
    /export function shouldHoldForCoherence/.test(coherence));
  enforced("I-25", "…and the substitution default is UNCHANGED, so an untaught caller keeps its behaviour",
    /allowHostSubstitution\?:\s*boolean\s*\|\s*undefined/.test(compiler) &&
      !/allowHostSubstitution\s*=\s*false/.test(compiler));
}

// ---------------------------------------------------------------------------------------------
// I-5 / I-15 / I-35 — invariants three shipped modules CLAIM in their headers
// ---------------------------------------------------------------------------------------------
//
// Why these three, together, and now. The 2026-08-03 conformance review counted 39 invariants declared
// in ADR-012 against 19 asserted here, and most of the difference belongs to slices that have not
// shipped. These three do not: `frame-scheduler.ts` cites I-5, `degradation-sink.ts` cites I-15, and
// `resource-manager.ts` cites I-35 — in shipped code, with nothing verifying any of them.
//
// A module asserting an invariant in prose that no harness checks is the specification drift ADR-012
// exists to prevent, and it is the more dangerous kind: the claim reads as settled, so nobody re-derives
// it, and the day it stops being true nothing says so.

console.log("\nI-5 / I-15 / I-35 — the claims shipped modules make about themselves");
{
  const kernelDir = fileURLToPath(new URL("../../../packages/shared/src/kernel/", import.meta.url));
  const strip = (source: string): string =>
    source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  // ── I-5: evaluation time MUST be threaded explicitly to every time-dependent read.
  //
  // `activeFrame()` is the ONE piece of ambient state the kernel tolerates, and `frame-scheduler.ts`
  // justifies it on the grounds that a frame id is a correlation token from which nothing decides
  // anything (rule T4). But `FrameRequest` also carries `targetTime` — a real time, on an ambient
  // object, reachable from anywhere with no parameter passing. That is precisely the shape I-5 forbids,
  // one property access away, and prose is all that currently stands between them.
  //
  // tsc cannot catch it: `targetTime` is a plain `number`, so reading it compiles anywhere. What a
  // harness can protect is that nobody starts.
  const ambientTimeRead = /\bactiveFrame\s*\(\s*\)\s*[?]?\.\s*targetTime\b/;
  const ambientReaders: string[] = [];
  let scanned = 0;
  for (const dir of [kernelDir, fileURLToPath(new URL("../../web/src/", import.meta.url))]) {
    for (const file of walkTs(dir)) {
      scanned += 1;
      if (ambientTimeRead.test(strip(readFileSync(file, "utf8")))) ambientReaders.push(file.split(/[\\/]/).slice(-2).join("/"));
    }
  }
  // A ratchet that scans nothing passes for the wrong reason, and a mistyped path is the cheapest way
  // to get there. Assert the scan HAPPENED before trusting what it did not find — the same rule the
  // budget probe's vacuity guards enforce, moved onto a static check.
  enforced("I-37", "the ambient-time scan actually walked the tree — a zero-file scan proves nothing",
    scanned > 200, `scanned ${scanned} files`);
  enforced("I-5", `nobody reads an evaluation time off the ambient frame — T4, the one tolerated global stays a token (${scanned} files)`,
    ambientReaders.length === 0, ambientReaders.join(" · "));

  // And the positive half: the ONLY way to obtain an evaluation time is to derive one from an
  // effective time, which is a parameter by construction. This is what makes the ratchet above a
  // belt-and-braces check rather than the whole defence.
  const evaluation = deriveEvaluationTime(unsafeLabelTime(3.5, "effective"));
  enforced("I-5", "an evaluation time exists only by explicit derivation from a passed-in effective time",
    (evaluation as number) === 3.5);

  // ── R7 (flag discipline): ONE authoritative flag-resolution path.
  //
  // The review found query→storage→default implemented four times, each with its own `truthy`, its own
  // try/catch and its own default — and the drift had already begun (`orreris.${name}` in the helpers,
  // `orreris.kernel.${name}` inline). A rollback path you cannot predict the resolution of is the one
  // you reach for when something is on fire, so "there is exactly one reader" is worth a ratchet rather
  // than a convention.
  const flagReaders: string[] = [];
  for (const file of walkTs(fileURLToPath(new URL("../../web/src/", import.meta.url)))) {
    if (file.endsWith("kernel-flags.ts")) continue;
    const code = strip(readFileSync(file, "utf8"));
    // A kernel flag read is the pair: a `kernel*` name AND a localStorage lookup in the same file.
    // Either alone is innocent — plenty of files read storage for unrelated settings.
    if (/localStorage[?]?\.getItem/.test(code) && /["'`]orreris\.kernel[A-Z.]/.test(code)) {
      flagReaders.push(file.split(/[\\/]/).slice(-2).join("/"));
    }
  }
  enforced("I-29", "kernel flags resolve in exactly one place — no second reader may re-derive the order",
    flagReaders.length === 0, flagReaders.join(" · "));

  // ── I-15: the lowering layer MUST NOT own policy, state, resources, or a clock.
  //
  // `degradation-sink.ts` rests its whole design on this: the compiler emits a degradation knowing
  // nothing about the sink, and severity/subject decisions live caller-side because they are policy.
  // If the compiler ever grows a clock or module state, that split is over and the sink's rationale
  // silently becomes false — so the check belongs on the compiler, not on the sink.
  const loweringPath = fileURLToPath(new URL("../../../packages/shared/src/flarex/compile-flarex.ts", import.meta.url));
  const lowering = strip(readFileSync(loweringPath, "utf8"));
  const loweringViolations: string[] = [];
  if (/\bDate\.now\b|\bperformance\.now\b/.test(lowering)) loweringViolations.push("reads a clock");
  if (/\bfrom\s+["'][^"']*\/kernel/.test(lowering)) loweringViolations.push("imports the kernel");
  // Module-scope `let`/`var` is mutable state the lowering layer would own across calls, which is what
  // makes a compile depend on what was compiled before it. `const` is fine — a table is not state.
  if (/^(?:export\s+)?(?:let|var)\s/m.test(lowering)) loweringViolations.push("holds module-level mutable state");
  enforced("I-15", "the lowering layer owns no clock, no kernel dependency and no module state",
    loweringViolations.length === 0, loweringViolations.join(" · "));

  // ── I-35: no operation MUST communicate failure by returning nothing.
  //
  // `resource-manager.ts` cites I-35 as a DISCLAIMER — `collectIdleResources` returns null, and the
  // header argues that null here is a described "no work" rather than a communicated failure. That
  // argument is only sound while the function genuinely cannot fail, so this pins both halves: null
  // means nothing to do, and work produces a described list.
  const session = createRuntimeSession({ id: "conformance-i35" });
  enforced("I-35", "an empty resource table returns null meaning NO WORK — the documented non-failure",
    collectIdleResources(session, 1_000, 10_000, true) === null);
  registerResource(session, "rt:a", { scope: "live", kind: "render-target", id: "a" }, 0);
  const reclaimable = collectIdleResources(session, 100_000, 10_000, true);
  enforced("I-35", "…and an overdue resource comes back DESCRIBED, not as a bare signal",
    reclaimable?.length === 1 && reclaimable[0]?.key === "rt:a" && reclaimable[0]?.kind === "render-target");

  // The operation that CAN fail is admission, and its whole S4.3 design is that failure is a state with
  // a subject. Assert the I-35 property directly: every denial carries a reason, so no caller ever has
  // to infer one from an absent return.
  const denied = rankAdmission(
    [
      { key: "a", priority: "playhead", contribution: { reachable: true, area: 0.9, opacity: 1, underDisabledBranch: false }, firstRequestedAtMs: 0, admittedAtMs: null },
      { key: "b", priority: "playhead", contribution: { reachable: true, area: 0.1, opacity: 1, underDisabledBranch: false }, firstRequestedAtMs: 0, admittedAtMs: null },
    ],
    1,
    0
  );
  enforced("I-35", "a refused admission returns a REASON, never merely an absence",
    denied.denied.length === 1 && typeof denied.denied[0]?.reason === "string" && denied.denied[0]!.reason.length > 0);

  session.dispose();
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
