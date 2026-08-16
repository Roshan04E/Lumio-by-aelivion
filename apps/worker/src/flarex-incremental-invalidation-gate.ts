/**
 * ADR-021 step 3a closeout — does the SHIPPED per-node incremental reuse invalidate on every edit a
 * user can make?
 *
 * WHY A PURE GATE. `781ebf4` left two things unsettled about closing 3a, and the cheapest instrument
 * that can answer either is not a browser. `beginIncrementalFrame` is a pure function over a
 * `FlarexComp` plus a session; its reuse verdict can be interrogated directly, in milliseconds, with
 * no Chrome, no vite and no fixture. Per the gate-cost directive: push the load-bearing check down to
 * the cheapest instrument that can actually tell the answers apart.
 *
 * WHAT IT ASKS. `incremental-evaluation.ts` marks a node content-dirty from `signatureOf`, which is
 * `type | enabled | RAW params`. Three of the four edit classes a user performs are covered by
 * construction — a param drag changes `params`, a rewire changes the declared upstream set, a source
 * change moves `mediaEpoch`. The fourth is not obviously covered: **a Flarex keyframe lives in
 * `comp.animations`, not in `node.params`**, and `signatureOf` does not read `comp.animations`. If
 * nothing else marks the node, then editing a keyframe with the playhead stationary reuses the
 * previous value and the picture does not change.
 *
 * That is a question about a MECHANISM, so it is asked of the mechanism rather than reasoned about.
 * Both directions are asserted: an edit that MUST invalidate, and (as the counterweight this repo's
 * own rules demand) an edit that must NOT, so a gate that simply always reports "dirty" fails too.
 *
 * Run: pnpm --filter @orreris/worker flarex:incremental-gate
 */
import {
  computeFlarexContentHashes,
  createFlarexComp,
  createFlarexNode,
  type FlarexComp,
  type TimelineKeyframeV2,
} from "@orreris/shared";
import {
  beginIncrementalFrame,
  commitIncrementalFrame,
  resetIncrementalEvaluation,
} from "../../web/src/playback/incremental-evaluation.js";
import { applyNodeParamValueAtTime } from "../../web/src/editor/flarex/flarex-keyframes.js";

let failures = 0;
let checks = 0;
function check(label: string, ok: boolean, detail = ""): void {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `   — ${detail}` : ""}`);
}

/** `mediaIn → colorCorrect → mediaOut`, with `colorCorrect.exposure` keyframed. */
function buildComp(): FlarexComp {
  const comp = createFlarexComp("cInc", "Incremental");
  const node = createFlarexNode("colorCorrect", "nBright");
  node.params = { ...node.params, exposure: 0 };
  comp.nodes[node.id] = node;
  comp.edges = [
    { id: "e1", from: { nodeId: "cInc_in", socket: "out" }, to: { nodeId: "nBright", socket: "in" } },
    { id: "e2", from: { nodeId: "nBright", socket: "out" }, to: { nodeId: "cInc_out", socket: "in" } },
  ];
  const kf = (timeSeconds: number, value: number): TimelineKeyframeV2 => ({
    id: `k${timeSeconds}`,
    target: { scope: "flarexNode", effectId: "nBright", property: "exposure" },
    timeSeconds,
    value,
    interpolation: "linear",
    temporal: {},
  });
  comp.animations = [kf(0, 0), kf(2, 100)];
  return comp;
}

const CONTEXT = { renderScale: 1, width: 1920, height: 1080, mediaEpoch: 7, gradeCompareKey: "" };

/**
 * Run one frame at `t`, record a value for the node, and commit. Returns nothing — the point is the
 * SIDE EFFECT on the session, which the next frame's reuse verdict reads.
 */
function recordFrame(comp: FlarexComp, t: number, frameId: number, value: unknown): void {
  const ch = beginIncrementalFrame({ comps: { [comp.id]: comp }, ...CONTEXT, frameTimeSeconds: t, frameId, nowMs: frameId * 16 });
  if (!ch) throw new Error("no channels");
  // The compiler keys records on `evalKey` = `${nodeId}@${t.toFixed(6)}` and hands the node's
  // `NodeContentHash` at ITS comp-local time alongside. Both are reproduced here rather than faked, so
  // this gate exercises the real contract instead of a convenient subset of it.
  ch.onEvaluated(comp.id, "nBright", `nBright@${t.toFixed(6)}`, value, computeFlarexContentHashes(comp, t).get("nBright"));
  commitIncrementalFrame();
}

/** Would the node be REUSED on a frame at `t`? True = the evaluator skips it. */
function wouldReuse(comp: FlarexComp, t: number, frameId: number): boolean {
  const ch = beginIncrementalFrame({ comps: { [comp.id]: comp }, ...CONTEXT, frameTimeSeconds: t, frameId, nowMs: frameId * 16 });
  if (!ch) throw new Error("no channels");
  // A vector matte holds no device resources, so gate 3 (`texturesAlive`) passes without a GL session —
  // which isolates this gate to the INVALIDATION question rather than to resource liveness.
  const reused = ch.reuseValue(comp.id, "nBright", `nBright@${t.toFixed(6)}`, computeFlarexContentHashes(comp, t).get("nBright")) !== null;
  commitIncrementalFrame();
  return reused;
}

const MATTE = { kind: "matte", matte: { kind: "vector", masks: [] } };
const T = 1.0;

console.log("ADR-021 step 3a — incremental reuse invalidation, per edit class\n");

// ── Counterweight first: with NOTHING changed, reuse MUST happen. ────────────────────────────────
// Without this a gate that reported "invalidated" unconditionally would pass every case below and
// prove nothing (the DEBT-012 shape: a check that cannot distinguish the answers).
{
  resetIncrementalEvaluation();
  const comp = buildComp();
  recordFrame(comp, T, 1, MATTE);
  check("BASELINE: an unchanged comp at an unchanged time REUSES", wouldReuse(comp, T, 2));
}

// ── 1. param drag — `node.params` changes, so `signatureOf` changes. ─────────────────────────────
{
  resetIncrementalEvaluation();
  const comp = buildComp();
  recordFrame(comp, T, 1, MATTE);
  comp.nodes["nBright"]!.params = { ...comp.nodes["nBright"]!.params, exposure: 25 };
  check("param drag invalidates", !wouldReuse(comp, T, 2));
}

// ── 2. rewire — the declared upstream set changes, which `declareNode` treats as content. ────────
{
  resetIncrementalEvaluation();
  const comp = buildComp();
  recordFrame(comp, T, 1, MATTE);
  const extra = createFlarexNode("colorCorrect", "nOther");
  comp.nodes[extra.id] = extra;
  comp.edges[0] = { id: "e1", from: { nodeId: "nOther", socket: "out" }, to: { nodeId: "nBright", socket: "in" } };
  check("rewire invalidates", !wouldReuse(comp, T, 2));
}

// ── 3. source change — a new decoded frame moves `mediaEpoch`. ───────────────────────────────────
{
  resetIncrementalEvaluation();
  const comp = buildComp();
  recordFrame(comp, T, 1, MATTE);
  const ch = beginIncrementalFrame({
    comps: { [comp.id]: comp },
    ...CONTEXT,
    mediaEpoch: CONTEXT.mediaEpoch + 1,
    frameTimeSeconds: T,
    frameId: 2,
    nowMs: 32,
  });
  const reused = ch!.reuseValue(comp.id, "nBright", `nBright@${T.toFixed(6)}`, computeFlarexContentHashes(comp, T).get("nBright")) !== null;
  commitIncrementalFrame();
  // NOTE: `colorCorrect` declares content/context/time and NOT `source` — only a mediaIn declares it.
  // Whether the source axis reaches this node is exactly what is being asked.
  check("source change invalidates a downstream node", !reused);
}

// ── 4. THE ONE UNDER SUSPICION: a keyframe edit at a stationary playhead. ────────────────────────
// The keyframe lives in `comp.animations`; `signatureOf` reads `type | enabled | params`.
{
  resetIncrementalEvaluation();
  const comp = buildComp();
  recordFrame(comp, T, 1, MATTE);
  // Change what `exposure` RESOLVES TO at t=1.0 (50 -> 5) without touching any param.
  comp.animations = comp.animations.map((k) => (k.timeSeconds === 2 ? { ...k, value: 10 } : k));
  comp.version += 1; // the editor's documented invalidation counter, bumped exactly as an edit would
  check("KEYFRAME VALUE edit invalidates", !wouldReuse(comp, T, 2));
}

// ── 5. Same class, different mutation: MOVING a keyframe in time. ────────────────────────────────
{
  resetIncrementalEvaluation();
  const comp = buildComp();
  recordFrame(comp, T, 1, MATTE);
  comp.animations = comp.animations.map((k) => (k.timeSeconds === 2 ? { ...k, timeSeconds: 8 } : k));
  comp.version += 1;
  check("KEYFRAME MOVE invalidates", !wouldReuse(comp, T, 2));
}

// ── 6. Same class again: DELETING a keyframe. ────────────────────────────────────────────────────
{
  resetIncrementalEvaluation();
  const comp = buildComp();
  recordFrame(comp, T, 1, MATTE);
  comp.animations = comp.animations.filter((k) => k.timeSeconds !== 2);
  comp.version += 1;
  check("KEYFRAME DELETE invalidates", !wouldReuse(comp, T, 2));
}

// ── 7. THE PRODUCT'S OWN WRITE PATH, not a simulation of it. ─────────────────────────────────────
// The cases above mutate `comp.animations` directly, which invites the objection that the editor
// might also touch `node.params` and thereby invalidate. It does not, and this asserts it through the
// real helper: `applyNodeParamValueAtTime`'s documented four-way rule says that for an ALREADY
// ANIMATED param it inserts or updates a keyframe and "never touch[es] the base". So dragging a
// slider on an animated Flarex param produces a comp whose `nodes` are byte-identical.
{
  resetIncrementalEvaluation();
  let comp = buildComp();
  recordFrame(comp, T, 1, MATTE);
  const before = comp.nodes["nBright"]!.params["exposure"];
  comp = applyNodeParamValueAtTime(comp, "nBright", "exposure", T, 42);
  const after = comp.nodes["nBright"]!.params["exposure"];
  check("editor's write path leaves node.params untouched for an animated param", before === after, `${String(before)} → ${String(after)}`);
  check("SLIDER DRAG on an ANIMATED param invalidates", !wouldReuse(comp, T, 2));
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) {
  console.log(
    "\nA FAILING 'keyframe ... invalidates' check means the shipped per-node reuse cannot see a\n" +
      "keyframe edit: `signatureOf` reads `type | enabled | raw params` and a Flarex keyframe lives in\n" +
      "`comp.animations`. With the playhead stationary the node is clean on every axis, so the\n" +
      "evaluator skips its whole subtree and the viewer keeps the previous picture."
  );
}
process.exit(failures ? 1 : 0);
