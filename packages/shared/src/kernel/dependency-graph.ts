/**
 * Dependency tracking + dirty propagation (ADR-012 §5.5, slice S6.5; ADR-009 R2/R3).
 *
 * ## What this replaces
 *
 * Today invalidation is a guess in two places. `comp.version` bumps on ANY edit and invalidates the
 * whole comp, so moving one slider re-lowers a hundred untouched nodes. And the 600ms settle window
 * exists because nothing could say when the picture had stopped changing — a timer standing in for an
 * answer. Both are the same missing fact: *which nodes can still change?*
 *
 * A node's output is a function of four independent axes, and an edit almost never touches more than
 * one of them:
 *
 *   content  — the node's own type/params/enabled, and its upstream content (the ADR-009 Merkle fold)
 *   time     — evaluation time; a node with no keyframes and no time-varying source ignores it
 *   context  — render resolution, colour space, comp dimensions (ADR-009's ContextVersion)
 *   source   — the decoded bytes behind a MediaIn, which change with no graph edit at all
 *
 * Per-axis tracking is the whole point: a resolution change must dirty the nodes that read resolution,
 * not every node in the comp, and a new decoded frame must dirty the MediaIn's downstream cone without
 * touching a sibling branch that shares nothing with it.
 *
 * ## The error direction is not symmetric, so conservatism is STRUCTURAL here
 *
 * Over-approximating the dirty set costs performance. Under-approximating it ships a stale pixel —
 * ADR-009 calls that unforgivable, and it is invisible in exactly the cases you would ship. So this
 * module is built so that the **absence of information is dirty**, never clean:
 *
 *   - A node the caller never declared is dirty. Not "assumed clean because nobody said otherwise" —
 *     `dirtyClosure` takes the caller's full node list precisely so an undeclared node is DETECTABLE
 *     rather than merely absent from a map.
 *   - A node that declares an axis it cannot describe is dirty on that axis.
 *   - A node reachable from any dirty node is dirty, transitively, with no depth limit.
 *   - Every unknown in between resolves toward dirty.
 *
 * The property test that guards this asserts a SUPERSET relation (closure ⊇ actually-changed), never
 * equality, because equality is the direction that would let an under-approximation pass.
 *
 * ## Node-blind (ADR-010), and no clock (I-15)
 *
 * This reads declarations, never node types — there is no `if (node.type === "mediaIn")` here and
 * there must never be. It also owns no clock and no rendering handle (I-36): the caller supplies frame
 * ids and axis marks, because only the caller knows what changed. A tracker that inferred change by
 * sampling would be a tracker with its own idea of the truth.
 */

import { kernelDiagnostics } from "./diagnostics";
import type { RuntimeSession } from "./session";

/**
 * The four independent reasons a node's output can differ between two frames.
 *
 * Deliberately closed and small. A fifth axis is a contract change that must invalidate everything
 * once (the same escape hatch `FLAREX_CONTENT_HASH_CONTRACT_VERSION` provides one layer up), not a
 * quiet addition — which is why callers pass axes by name and an unknown name is rejected below.
 */
export type DependencyAxis = "content" | "time" | "context" | "source";

export const DEPENDENCY_AXES: readonly DependencyAxis[] = ["content", "time", "context", "source"];

const isAxis = (value: string): value is DependencyAxis =>
  (DEPENDENCY_AXES as readonly string[]).includes(value);

/**
 * What a node told us about itself.
 *
 * `upstream` is the node ids it READS. The downstream index is derived from it rather than declared,
 * so the two can never disagree — a caller cannot accidentally register an edge in one direction only,
 * which would silently break the closure in the unsafe direction.
 */
export interface DependencyDeclaration {
  readonly nodeId: string;
  readonly upstream: readonly string[];
  /** The axes this node's own output responds to. Omitting an axis is a CLAIM of independence. */
  readonly axes: ReadonlySet<DependencyAxis>;
}

interface GraphStore {
  readonly declarations: Map<string, DependencyDeclaration>;
  /** node → nodes that read it. Derived from `upstream`; rebuilt whenever a declaration changes. */
  readonly downstream: Map<string, Set<string>>;
  /** Seeds per axis: nodes whose OWN input on that axis changed, before propagation. */
  readonly seeds: Map<DependencyAxis, Set<string>>;
  /** Nodes explicitly declared unable to describe an axis they depend on — permanently dirty on it. */
  readonly opaque: Set<string>;
  closures: number;
  undeclaredSeen: number;
  lastClosureSize: number;
}

const stores = new WeakMap<RuntimeSession, GraphStore>();

function storeOf(session: RuntimeSession): GraphStore {
  let store = stores.get(session);
  if (!store) {
    store = {
      declarations: new Map(),
      downstream: new Map(),
      seeds: new Map(),
      opaque: new Set(),
      closures: 0,
      undeclaredSeen: 0,
      lastClosureSize: 0,
    };
    stores.set(session, store);
  }
  return store;
}

/** Rebuild the reverse index for one node's edges. Called on every declaration change. */
function reindex(store: GraphStore, nodeId: string, previous: readonly string[], next: readonly string[]): void {
  for (const from of previous) {
    const readers = store.downstream.get(from);
    if (readers) {
      readers.delete(nodeId);
      if (readers.size === 0) store.downstream.delete(from);
    }
  }
  for (const from of next) {
    let readers = store.downstream.get(from);
    if (!readers) {
      readers = new Set();
      store.downstream.set(from, readers);
    }
    readers.add(nodeId);
  }
}

/**
 * Declare what a node reads and which axes it responds to.
 *
 * Idempotent: re-declaring identical dependencies is a no-op, so this can be called every frame from
 * the lowering pass without churning the index. Declaring FEWER axes than the node truly depends on is
 * the one way a caller can cause a stale pixel here, which is why `declareOpaque` exists as the
 * explicit escape for "I cannot describe this" — an honest opaque node stays correct, where a
 * hopeful narrow declaration does not.
 */
export function declareNode(
  session: RuntimeSession,
  nodeId: string,
  upstream: readonly string[],
  axes: readonly string[]
): void {
  const store = storeOf(session);
  const existing = store.declarations.get(nodeId);

  const validAxes = new Set<DependencyAxis>();
  for (const axis of axes) {
    if (isAxis(axis)) {
      validAxes.add(axis);
      continue;
    }
    // An axis we do not understand cannot be reasoned about, so the node becomes opaque rather than
    // being silently narrowed to the axes we DID recognise — which is the under-approximation.
    store.opaque.add(nodeId);
    if (kernelDiagnostics.enabled) {
      kernelDiagnostics.record({
        kind: "degradation",
        severity: "warn",
        // `runtime`, not `node`: the node subject is a (compId, nodeId) pair and this tracker is
        // deliberately comp-agnostic — it would have to invent a compId to use it, and an invented
        // identity is worse than a plain one.
        subject: { kind: "runtime" },
        reason: "dependency-axis-unknown",
        detail: { nodeId, axis },
      });
    }
  }

  if (existing && sameDeclaration(existing, upstream, validAxes)) return;

  reindex(store, nodeId, existing?.upstream ?? [], upstream);
  store.declarations.set(nodeId, { nodeId, upstream: [...upstream], axes: validAxes });

  // A changed declaration is itself a content change: rewiring a node changes its output even if every
  // param is untouched (ADR-009 R3 — topology is content).
  if (existing) markDirty(session, nodeId, "content");
}

function sameDeclaration(
  existing: DependencyDeclaration,
  upstream: readonly string[],
  axes: ReadonlySet<DependencyAxis>
): boolean {
  if (existing.upstream.length !== upstream.length) return false;
  for (let i = 0; i < upstream.length; i += 1) if (existing.upstream[i] !== upstream[i]) return false;
  if (existing.axes.size !== axes.size) return false;
  for (const axis of axes) if (!existing.axes.has(axis)) return false;
  return true;
}

/**
 * Declare that a node cannot describe its own dependencies — it is dirty on every frame, forever.
 *
 * This is the honest answer for a node whose output depends on something outside the graph (an async
 * result, a random seed, an external clock). It is strictly better than a narrow declaration: it costs
 * performance and stays correct, where a hopeful declaration is a stale pixel waiting for the right
 * edit. Opacity propagates like any other dirt, so the node's whole downstream cone is dirty too.
 */
export function declareOpaque(session: RuntimeSession, nodeId: string): void {
  storeOf(session).opaque.add(nodeId);
}

/** Forget a node entirely (it left the graph). Its edges leave the reverse index with it. */
export function undeclareNode(session: RuntimeSession, nodeId: string): void {
  const store = storeOf(session);
  const existing = store.declarations.get(nodeId);
  if (existing) reindex(store, nodeId, existing.upstream, []);
  store.declarations.delete(nodeId);
  store.opaque.delete(nodeId);
  for (const seeds of store.seeds.values()) seeds.delete(nodeId);
  // Its readers depended on something that no longer exists — a structural change, so they are dirty.
  for (const reader of store.downstream.get(nodeId) ?? []) markDirty(session, reader, "content");
  store.downstream.delete(nodeId);
}

/** Mark one node's own input on one axis as changed. Propagation happens in `dirtyClosure`. */
export function markDirty(session: RuntimeSession, nodeId: string, axis: DependencyAxis): void {
  const store = storeOf(session);
  let seeds = store.seeds.get(axis);
  if (!seeds) {
    seeds = new Set();
    store.seeds.set(axis, seeds);
  }
  seeds.add(nodeId);
}

/**
 * Mark an axis as changed for EVERY node that declared a dependency on it.
 *
 * The resolution/colour-space case: nothing about the graph changed, but every node that reads the
 * context now produces different pixels. Nodes that declared independence from the axis are untouched
 * — which is the entire performance argument for tracking axes separately, and the entire risk if a
 * declaration is wrong. Opaque nodes are always included; they declared nothing to be excluded by.
 */
export function markAxisDirty(session: RuntimeSession, axis: DependencyAxis): void {
  const store = storeOf(session);
  for (const declaration of store.declarations.values()) {
    if (declaration.axes.has(axis)) markDirty(session, declaration.nodeId, axis);
  }
  for (const nodeId of store.opaque) markDirty(session, nodeId, axis);
}

export interface DirtyClosure {
  /** Every node whose output may differ this frame. A SUPERSET of what actually changed, by design. */
  readonly dirty: ReadonlySet<string>;
  /** Nodes in `allNodeIds` with no declaration — dirty because unknown, and worth reporting. */
  readonly undeclared: ReadonlySet<string>;
  /** Seeds per axis before propagation, so a caller can say WHY a node is dirty. */
  readonly seedsByAxis: ReadonlyMap<DependencyAxis, ReadonlySet<string>>;
}

/**
 * The forward dirty closure over the whole node set.
 *
 * `allNodeIds` is required rather than inferred from the declaration table, and that is the safety
 * property: it is how an undeclared node becomes VISIBLE. If this walked only what it had been told
 * about, a node nobody declared would be absent from the dirty set and therefore treated as clean —
 * the exact under-approximation this module exists to prevent, arriving silently through an omission
 * rather than through a wrong answer.
 *
 * The walk is a breadth-first sweep over the reverse index with a visited set, so cycles terminate and
 * every node reachable from a seed is included regardless of depth.
 */
export function dirtyClosure(session: RuntimeSession, allNodeIds: readonly string[]): DirtyClosure {
  const store = storeOf(session);
  store.closures += 1;

  const dirty = new Set<string>();
  const undeclared = new Set<string>();
  const queue: string[] = [];

  const push = (nodeId: string): void => {
    if (dirty.has(nodeId)) return;
    dirty.add(nodeId);
    queue.push(nodeId);
  };

  // 1. Unknown ⇒ dirty. A node we were never told about could be anything.
  for (const nodeId of allNodeIds) {
    if (!store.declarations.has(nodeId)) {
      undeclared.add(nodeId);
      push(nodeId);
    }
  }
  if (undeclared.size > 0) {
    store.undeclaredSeen += undeclared.size;
    if (kernelDiagnostics.enabled) {
      kernelDiagnostics.record({
        kind: "degradation",
        severity: "info",
        subject: { kind: "runtime" },
        reason: "dependency-undeclared-nodes",
        detail: { count: undeclared.size },
      });
    }
  }

  // 2. Opaque ⇒ dirty, every frame. It told us it cannot be reasoned about.
  for (const nodeId of store.opaque) push(nodeId);

  // 3. Seeded on any axis ⇒ dirty.
  for (const seeds of store.seeds.values()) for (const nodeId of seeds) push(nodeId);

  // 4. Propagate FORWARD: anything that reads a dirty node is dirty.
  while (queue.length > 0) {
    const nodeId = queue.shift()!;
    for (const reader of store.downstream.get(nodeId) ?? []) push(reader);
  }

  store.lastClosureSize = dirty.size;

  const seedsByAxis = new Map<DependencyAxis, ReadonlySet<string>>();
  for (const [axis, seeds] of store.seeds) if (seeds.size > 0) seedsByAxis.set(axis, new Set(seeds));

  return { dirty, undeclared, seedsByAxis };
}

/**
 * Drop the seeds after a frame has consumed the closure.
 *
 * Separate from `dirtyClosure` on purpose: a caller that computes a closure and then FAILS to render
 * (an aborted frame, a thrown draw) must not have silently cleared the reason those nodes were dirty.
 * Clearing is an assertion that the work was done, so only the caller who did it may clear.
 */
export function clearDirty(session: RuntimeSession): void {
  storeOf(session).seeds.clear();
}

export interface DependencyStats {
  readonly declaredNodes: number;
  readonly edges: number;
  readonly opaqueNodes: number;
  readonly closures: number;
  readonly undeclaredSeen: number;
  readonly lastClosureSize: number;
  readonly pendingSeeds: number;
}

export function dependencyStats(session: RuntimeSession): DependencyStats {
  const store = storeOf(session);
  let edges = 0;
  for (const declaration of store.declarations.values()) edges += declaration.upstream.length;
  let pendingSeeds = 0;
  for (const seeds of store.seeds.values()) pendingSeeds += seeds.size;
  return {
    declaredNodes: store.declarations.size,
    edges,
    opaqueNodes: store.opaque.size,
    closures: store.closures,
    undeclaredSeen: store.undeclaredSeen,
    lastClosureSize: store.lastClosureSize,
    pendingSeeds,
  };
}

/** Test/teardown only. */
export function __resetDependencyGraph(session: RuntimeSession): void {
  stores.delete(session);
}
