/**
 * Host integration for incremental Flarex evaluation (ADR-012 slices S6.4/S6.5/S6.6).
 *
 * This is the consumer the Phase 6 kernel modules were built for. The kernel can say which nodes are
 * dirty and whether a record exists; only the host knows what actually changed between two frames and
 * whether a cached draw's textures are still alive. That split is deliberate — see `evaluation-planner.ts`.
 *
 * ## Why reuse is safe at all: the key already folds time
 *
 * `evalKey` is `${nodeId}@${timeSeconds.toFixed(6)}`, so a record can only ever be served to an
 * evaluation at the IDENTICAL comp-local time. A time change does not risk a stale hit; it produces a
 * miss. Reuse is therefore structurally confined to a still playhead, which is exactly the case worth
 * optimising (a paused editor, a settled capture) and the case the done-when names.
 *
 * That property is load-bearing enough to say plainly: the axis bookkeeping below is a second line of
 * defence, not the first. If every axis mark here were wrong in the permissive direction, a moving
 * playhead would still miss on every node.
 *
 * ## Conservative by construction, per the Phase 6 completion plan
 *
 * Where a signal is unavailable or ambiguous, this over-invalidates:
 *
 *   content — per-node signature (type, enabled, raw params). A rewire is caught by `declareNode`,
 *             which treats a changed upstream set as a content change on its own.
 *   context — declared by EVERY node and marked on any renderScale or dimension change. Context
 *             changes are rare, so blanket invalidation costs nothing measurable and removes a class
 *             of reasoning about which nodes read resolution.
 *   time    — declared by EVERY node and marked whenever frame time moves. This deliberately gives up
 *             reuse during playback rather than enumerating which node types read time. `uTime` in a
 *             fragment pass comes from `frameTimeSeconds`, not comp-local time, and the two can be
 *             decoupled; rather than reason about when, the whole graph is dirty when either moves.
 *   source  — declared by MediaIn nodes and marked when any media pool entry's content version changes.
 *             A decoded frame is a change nothing in the graph records.
 *
 * Tightening any of these is a MEASUREMENT exercise, not a reasoning one, and must not begin until the
 * pixel gate is green with the flag on.
 */

import {
  checkHandle,
  clearDirty,
  declareNode,
  defaultSession,
  dirtyClosure,
  isSceneTextureSource,
  markAxisDirty,
  markDirty,
  noteEvaluation,
  reuseDecision,
  type EvaluationRecord,
  type FlarexComp,
  type FlarexValue,
  type SceneDraw,
} from "@orreris/shared";

/** Node ids are comp-local, so two comps' `n0` would share a record without this. */
const scoped = (compId: string, nodeId: string): string => `${compId} ${nodeId}`;

interface FrameState {
  /** Per-node content signature from the previous frame. */
  readonly signatures: Map<string, string>;
  contextKey: string;
  frameTime: number;
  mediaEpoch: number;
  started: boolean;
}

const state: FrameState = {
  signatures: new Map(),
  contextKey: "",
  frameTime: Number.NaN,
  mediaEpoch: -1,
  started: false,
};

export interface IncrementalStats {
  reused: number;
  evaluated: number;
  recorded: number;
  staleResources: number;
  dirtyNodes: number;
  declaredNodes: number;
  frames: number;
  /**
   * DEBT-022 — reuses refused because the node's `NodeContentHash` moved while the axes read clean.
   *
   * Counted separately from `evaluated` because it is the ONLY reading that distinguishes "the content
   * gate is doing work the axes could not do" from "the content gate is inert". A fix whose counter
   * never moves is indistinguishable from one that never shipped, which is this register's own
   * recurring lesson (DEBT-012: count the reasons, never infer which branch fired).
   */
  contentHashMisses: number;
}

const stats: IncrementalStats = {
  reused: 0,
  evaluated: 0,
  recorded: 0,
  staleResources: 0,
  dirtyNodes: 0,
  declaredNodes: 0,
  frames: 0,
  contentHashMisses: 0,
};

export function incrementalStats(): IncrementalStats {
  return { ...stats };
}

/**
 * `__rfIncremental` — the console read-out, and the only way to tell "reuse does not pay off here"
 * from "reuse never engaged". A getter rather than a snapshot so it is always live, and defined once
 * so a hot reload cannot throw on redefinition.
 */
if (typeof globalThis === "object" && !Object.getOwnPropertyDescriptor(globalThis, "__rfIncremental")) {
  Object.defineProperty(globalThis, "__rfIncremental", { get: () => incrementalStats(), configurable: true });
}

/**
 * A node's OWN content, independent of upstream and of time.
 *
 * Raw params, not params resolved at `t`: a keyframed value changes every frame by design, and folding
 * it here would mark the node content-dirty forever. Time is the time axis's business, and — see the
 * header — the evaluation key's before that.
 */
function signatureOf(comp: FlarexComp, nodeId: string): string {
  const node = comp.nodes[nodeId];
  if (!node) return "∅";
  const keys = Object.keys(node.params).sort();
  let out = `${node.type}|${node.enabled}`;
  for (const key of keys) out += `|${key}=${JSON.stringify(node.params[key])}`;
  return out;
}

/**
 * GATE 3 — is every texture this cached draw holds still alive?
 *
 * S5.2's generations are what make this answerable at all: a raw `WebGLTexture` could only be compared
 * by identity, and a pool entry recycled for a different layer keeps the same object. A handle whose
 * generation moved reports STALE, which is the whole reason that slice was atomic.
 *
 * Anything unrecognised counts as NOT reusable. A draw shape this walker does not understand is a draw
 * whose resources it cannot vouch for, and the instruction is explicit: missing or invalid handles
 * disable reuse, never silently reuse stale resources.
 */
function texturesAlive(value: unknown): boolean {
  const seen = new Set<unknown>();
  const walk = (draw: unknown): boolean => {
    if (!draw || typeof draw !== "object") return true;
    if (seen.has(draw)) return true;
    seen.add(draw);
    const node = draw as { source?: unknown; children?: unknown[] };
    if (node.source !== undefined) {
      const source = node.source;
      // A null/absent source is not a source we can vouch for either — the point of gate 3 is that
      // anything we cannot positively confirm is alive disables reuse.
      if (source === null || typeof source !== "object") return false;
      if (!isSceneTextureSource(source as never)) return false; // unrecognised source ⇒ cannot vouch
      if (checkHandle(defaultSession, (source as { handle: never }).handle) !== null) return false;
    }
    for (const child of node.children ?? []) if (!walk(child)) return false;
    return true;
  };
  const v = value as FlarexValue | null;
  if (!v || typeof v !== "object") return false;
  if (v.kind === "matte") return true; // vector mattes hold no device resources
  if (v.kind !== "image") return false;
  return walk(v.draw as SceneDraw);
}

export interface IncrementalChannels {
  readonly onEvaluated: (compId: string, nodeId: string, contextKey: string, value: unknown, contentHash?: string | undefined) => void;
  readonly reuseValue: (compId: string, nodeId: string, contextKey: string, contentHash?: string | undefined) => FlarexValue | null;
}

/**
 * DEBT-022 — the CONTENT identity a recorded value was produced under, keyed exactly like the record
 * it shadows (`${scopedNodeId} ${contextKey}`).
 *
 * WHY A SECOND MAP RATHER THAN A FIELD ON THE RECORD. The record store is kernel-owned
 * (`evaluation-records.ts`) and its `value` is deliberately `unknown` — "the kernel owns the lifetime
 * and the identity, the caller owns the meaning". Wrapping the value to carry a hash would change what
 * every other reader of `record.value` sees, including `texturesAlive`'s draw walk. A side map keyed
 * identically costs one string key per live record and leaves the kernel's contract alone.
 *
 * Bounded by the same eviction: entries are dropped when their node's record is overwritten, and the
 * whole map is cleared on reset. It cannot outgrow `MAX_EVALUATION_RECORDS` by more than the records
 * that have since been evicted kernel-side, which the `staleHashKeys` reading below makes visible.
 */
const contentHashes = new Map<string, string>();
const hashKey = (scopedNodeId: string, contextKey: string): string => `${scopedNodeId} ${contextKey}`;

export interface BeginFrameInputs {
  readonly comps: Readonly<Record<string, FlarexComp>> | undefined;
  readonly renderScale: number;
  readonly width: number;
  readonly height: number;
  readonly frameTimeSeconds: number;
  /** Sum of media pool content versions — any change means some decoded frame is new. */
  readonly mediaEpoch: number;
  readonly frameId: number;
  readonly nowMs: number;
  /**
   * Editor grade-compare divider, or null when compare is off. A RENDER-CONTEXT input, exactly like
   * renderScale/size: it changes the pixels a colour node produces without changing the graph, the
   * time, or any decoded source — so without it in the context key, dragging the divider would reuse
   * cached node values and the wipe would not move.
   */
  readonly gradeCompareKey: string;
}

/**
 * Declare the graph, mark what changed, and hand back the two channels.
 *
 * Declaration runs EVERY frame and is idempotent by design (`declareNode` returns early on an identical
 * declaration), so there is no incremental-declaration bookkeeping to get wrong. That is a deliberate
 * trade of a little per-frame work for the removal of a whole class of bug: a stale declaration is a
 * wrong dirty closure, and a wrong dirty closure is a stale pixel.
 */
export function beginIncrementalFrame(inputs: BeginFrameInputs): IncrementalChannels | null {
  const comps = inputs.comps;
  if (!comps) return null;

  const contextKey = `${inputs.renderScale}x${inputs.width}x${inputs.height}x${inputs.gradeCompareKey}`;
  if (contextKey !== state.contextKey) {
    state.contextKey = contextKey;
    markAxisDirty(defaultSession, "context");
  }
  if (inputs.frameTimeSeconds !== state.frameTime) {
    state.frameTime = inputs.frameTimeSeconds;
    markAxisDirty(defaultSession, "time");
  }
  if (inputs.mediaEpoch !== state.mediaEpoch) {
    state.mediaEpoch = inputs.mediaEpoch;
    markAxisDirty(defaultSession, "source");
  }

  const allIds: string[] = [];
  for (const comp of Object.values(comps)) {
    const upstreamOf = new Map<string, string[]>();
    for (const edge of comp.edges) {
      const list = upstreamOf.get(edge.to.nodeId);
      if (list) list.push(scoped(comp.id, edge.from.nodeId));
      else upstreamOf.set(edge.to.nodeId, [scoped(comp.id, edge.from.nodeId)]);
    }

    for (const nodeId of Object.keys(comp.nodes)) {
      const id = scoped(comp.id, nodeId);
      allIds.push(id);
      // Every node declares content, context and time; only a MediaIn reads a decoded source. Time is
      // deliberately NOT narrowed to keyframed nodes — see the header.
      const axes = comp.nodes[nodeId]?.type === "mediaIn"
        ? ["content", "context", "time", "source"]
        : ["content", "context", "time"];
      declareNode(defaultSession, id, upstreamOf.get(nodeId) ?? [], axes);

      const signature = signatureOf(comp, nodeId);
      if (state.signatures.get(id) !== signature) {
        state.signatures.set(id, signature);
        markDirty(defaultSession, id, "content");
      }
    }
  }

  const closure = dirtyClosure(defaultSession, allIds);
  stats.dirtyNodes = closure.dirty.size;
  stats.declaredNodes = allIds.length;
  stats.frames += 1;
  state.started = true;

  return {
    onEvaluated: (compId, nodeId, contextKey2, value, contentHash) => {
      stats.recorded += 1;
      const id = scoped(compId, nodeId);
      noteEvaluation(defaultSession, id, contextKey2, value, inputs.frameId, inputs.nowMs);
      // Record the content identity this value was produced under. `undefined` (a node the compiler
      // could not hash) DELETES rather than stores, so a later hashed evaluation of the same node is a
      // mismatch and re-evaluates — the safe direction, per `reuseValue`'s own asymmetry rule.
      if (contentHash === undefined) contentHashes.delete(hashKey(id, contextKey2));
      else contentHashes.set(hashKey(id, contextKey2), contentHash);
    },
    reuseValue: (compId, nodeId, contextKey2, contentHash) => {
      /**
       * DEBT-022 GATE, ahead of the axis machinery and deliberately so.
       *
       * The axes below cannot see a keyframe edit: `signatureOf` reads `type | enabled | RAW params`
       * and a Flarex keyframe lives in `comp.animations`. `contentHash` is ADR-009's `NodeContentHash`
       * computed by THIS frame's compile at ITS comp-local time, so it folds every param resolved at t
       * (R1) and every upstream hash (R3) — which makes both a keyframe edit and a rewire visible here
       * without the host knowing anything about either.
       *
       * MISMATCH ⇒ EVALUATE, and so does ABSENT-on-either-side. A wrong `null` costs work; a wrong
       * reuse is a stale pixel, and that asymmetry is the compiler's stated contract for this channel.
       */
      const previous = contentHashes.get(hashKey(scoped(compId, nodeId), contextKey2));
      if (contentHash === undefined || previous === undefined || previous !== contentHash) {
        if (previous !== undefined && contentHash !== undefined) stats.contentHashMisses += 1;
        stats.evaluated += 1;
        return null;
      }
      const decision = reuseDecision(defaultSession, {
        nodeId: scoped(compId, nodeId),
        contextKey: contextKey2,
        dirty: closure.dirty,
        isReusable: (record: EvaluationRecord) => {
          const alive = texturesAlive(record.value);
          if (!alive) stats.staleResources += 1;
          return alive;
        },
        nowMs: inputs.nowMs,
      });
      if (!decision.reuse) {
        stats.evaluated += 1;
        return null;
      }
      stats.reused += 1;
      return decision.record.value as FlarexValue;
    },
  };
}

/**
 * Clear the dirt — ONLY after a frame that actually rendered.
 *
 * `clearDirty` is an assertion that the work those marks described has been done. A frame that threw,
 * was held for coherence, or returned early has not done it, and clearing anyway would drop the only
 * record that those nodes still need evaluating — a stale pixel that survives until something else
 * happens to dirty them again. So the abort path deliberately does nothing: dirt is cheap, and it
 * carries forward into the next frame exactly as it should.
 */
export function commitIncrementalFrame(): void {
  if (!state.started) return;
  state.started = false;
  clearDirty(defaultSession);
}

export function abortIncrementalFrame(): void {
  state.started = false;
}

/** Test/teardown, and the flag flipping off mid-session. */
export function resetIncrementalEvaluation(): void {
  contentHashes.clear();
  state.signatures.clear();
  state.contextKey = "";
  state.frameTime = Number.NaN;
  state.mediaEpoch = -1;
  state.started = false;
}
