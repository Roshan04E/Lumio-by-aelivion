/**
 * Flarex comp registry seam (FLAREX.md Part 3) — the write/heal discipline mirrored from
 * `nesting.ts` (`stampCompositionRegistry`/`healCompositionRegistry`): comps live first-class
 * in `ProjectGraph.flarexComps`, clips reference them via `TimelineLayer.flarexCompId`, and
 * every write path goes through these helpers so a loaded graph is always structurally sound
 * (defaults filled, dangling edges dropped) before the compiler or UI touches it.
 */

import { kernelDiagnostics } from "../kernel/diagnostics";
import type { ProjectGraph, TimelineLayer } from "../types";
import { createFlarexNode, findFlarexInputSocket, findFlarexOutputSocket, getFlarexNodeDefinition } from "./node-defs";
import type { FlarexComp, FlarexEdge, FlarexNode } from "./types";

export function getFlarexComp(graph: ProjectGraph, compId: string | undefined): FlarexComp | undefined {
  return compId ? graph.flarexComps?.[compId] : undefined;
}

export function getLayerFlarexComp(graph: ProjectGraph, layer: Pick<TimelineLayer, "flarexCompId">): FlarexComp | undefined {
  return getFlarexComp(graph, layer.flarexCompId);
}

/** A new comp's default graph: MediaIn (host clip) wired straight to MediaOut. */
export function createFlarexComp(id: string, name: string): FlarexComp {
  const mediaIn = createFlarexNode("mediaIn", `${id}_in`, 0, 0);
  const mediaOut = createFlarexNode("mediaOut", `${id}_out`, 320, 0);
  const edge: FlarexEdge = {
    id: `${id}_e0`,
    from: { nodeId: mediaIn.id, socket: "out" },
    to: { nodeId: mediaOut.id, socket: "in" },
  };
  return {
    id,
    name,
    nodes: { [mediaIn.id]: mediaIn, [mediaOut.id]: mediaOut },
    edges: [edge],
    animations: [],
    version: 1,
  };
}

/**
 * Everything about a comp that a RENDERER can read, canonicalised — i.e. everything except node `ui`
 * and comp `view`.
 *
 * `compile-flarex.ts` states the rule this encodes in its own header: *"Determinism rule: node `ui` /
 * comp `view` are never read; same (comp, ctx) → structurally identical draws."* So two comps with the
 * same signature cannot produce different pixels, and a version bump between them invalidates render
 * caches for nothing.
 *
 * CONSERVATIVE BY CONSTRUCTION, and the direction is not symmetric: an unnecessary bump costs
 * performance, a missing one ships a stale pixel. So this strips exactly the two fields the compiler
 * documents as unread and keeps everything else — including `previewNodeId`, which the compiler no
 * longer reads but the viewer still turns into a per-frame `previewRootNodeId` (ADR-012 S1.2). A new
 * field on `FlarexComp` is therefore render-relevant by default, which is the safe way round.
 */
function flarexRenderSignature(comp: FlarexComp): string {
  const nodes = Object.keys(comp.nodes)
    .sort()
    .map((id) => {
      const { ui: _ui, ...rest } = comp.nodes[id]!;
      return [id, rest] as const;
    });
  const { nodes: _n, view: _view, version: _v, ...compRest } = comp as FlarexComp & { view?: unknown };
  return JSON.stringify([compRest, nodes]);
}

/**
 * Write-through seam: store/replace a comp in the registry, bumping its version **when the write can
 * change a pixel**.
 *
 * Call on EVERY comp mutation (the flarex.* actions funnel through this).
 *
 * ## Why the bump is conditional (2026-08-05)
 *
 * `comp.version` is not a change counter, it is the **render dirty key**: it keys
 * `FlarexSourceDrawCache` (`(layerId, comp.version, renderScale)`) and the comp-proxy identity. It used
 * to bump on every write, including a node DRAG — a change to `ui.x/ui.y`, which no renderer reads.
 *
 * Measured consequence, from a user trace: six position-only writes (versions 41-46, node and edge
 * counts identical throughout) each invalidated the source-draw template of every asset-source
 * MediaIn. The rebuild landed on a frame whose graded media was not consumed, `pruneDepartedSceneResources`
 * read "absent this frame" as "departed", disposed the loader's media resource and forgot it — and the
 * kernel logged `handle-missing` on `media/flarexsrc:...` with the generation climbing 1, 2, 3 in
 * lockstep with the drags. A forgotten handle resolves to a null texture, the MediaIn drew nothing, the
 * comp lowered to null, and `buildSceneDraws`' `lowered ?? draw` put the HOST clip on screen for that
 * frame. Dragging a node made the node's own picture flash the host clip underneath it.
 *
 * `dependency-graph.ts` names this defect in its own header — *"`comp.version` bumps on ANY edit and
 * invalidates the whole comp"* — and per-axis tracking (S6.5) is the real answer. This is the narrow,
 * doctrine-backed half of it: not "invalidate less", but "do not invalidate on a field the contract
 * says is unread".
 */
export function stampFlarexComp(graph: ProjectGraph, comp: FlarexComp): ProjectGraph {
  // I-20 enforced at the WRITE, not at the gesture. Every mutation path funnels through here — drag,
  // paste, AI intent, keyframe edits, node insertion — so this is the one place that can guarantee the
  // invariant regardless of which one produced the comp. See `dedupeFlarexEdges`.
  const deduped = dedupeFlarexEdges(comp.edges ?? [], comp.nodes ?? {});
  if (deduped) {
    reportEdgeRepair(comp.id, (comp.edges?.length ?? 0) - deduped.length, "write");
  }
  const next: FlarexComp = { ...comp, edges: deduped ?? comp.edges };
  // Compared against what is ALREADY in the registry, not against the caller's input: the caller hands
  // us a whole comp and cannot be trusted to say what it changed. An absent previous comp is a new
  // registration and always bumps.
  const previous = graph.flarexComps?.[next.id];
  const renderUnchanged = previous !== undefined && flarexRenderSignature(previous) === flarexRenderSignature(next);
  const stamped: FlarexComp = renderUnchanged
    ? { ...next, version: previous.version ?? 0 }
    : { ...next, version: (comp.version ?? 0) + 1 };
  return { ...graph, flarexComps: { ...(graph.flarexComps ?? {}), [stamped.id]: stamped } };
}

/** Repairs are reported, never silent: a graph that changed on load is something a user may notice. */
function reportEdgeRepair(compId: string, dropped: number, at: "write" | "load"): void {
  if (dropped <= 0 || !kernelDiagnostics.enabled) return;
  kernelDiagnostics.record({
    kind: "repair",
    severity: "warn",
    subject: { kind: "comp", compId },
    reason: "duplicate-input-edge",
    detail: { dropped, at },
  });
}

/**
 * ONE WIRE PER INPUT SOCKET (ADR-012 I-20, slice S1.1).
 *
 * Drops every edge but the LAST into any given `to.nodeId:to.socket`, preserving order otherwise, and
 * returns the SAME array when nothing needed dropping (so a healthy graph costs one pass and no
 * allocation).
 *
 * ## Why this has to live in the model
 *
 * The rule was previously enforced in exactly one place: a pointer-drag handler in `FlarexNodeCanvas`.
 * Paste, AI node-graph intent, project import and load all bypassed it, and a duplicate is not
 * detectable downstream because every individual edge is perfectly valid — both endpoints exist and
 * both socket types match, which is all `isValidFlarexEdge` (and therefore the healer) ever checked.
 *
 * A duplicate then makes three consumers disagree about what the graph *is*:
 *
 *   - `compile-flarex`'s `edgeInto` is a Map keyed by socket, so the LAST edge silently wins and the
 *     other is invisible to lowering;
 *   - its `fanout` counter increments per EDGE, so a duplicate inflates the fan-out of the upstream
 *     node and can trip the ADR-008 materialize decision — a node seals into a render target because
 *     of a wire nobody can see;
 *   - `resolveFlarexMediaInRetimes` walks EVERY incoming edge by design, so a TimeSpeed reaching a
 *     MediaIn through the invisible edge retimes a loader that lowering never reads.
 *
 * Three answers to one question. Deduping here makes all three agree by construction.
 *
 * ## Why "last wins" and not "first"
 *
 * It matches `edgeInto`'s Map-overwrite semantics exactly, so healing an already-loaded graph cannot
 * change which wire lowering was already using — the repair is invisible in the picture, which is the
 * only safe direction for a load-time fixup. It also matches the drag handler this replaces, whose
 * filter-then-append kept the newly dropped wire.
 *
 * NOTE: multiple edges into DIFFERENT sockets of one node are correct and untouched — `merge` has
 * in/bg, `matteControl` has a/b. The rule is per socket, never per node.
 */
export function dedupeFlarexEdges(edges: readonly FlarexEdge[], nodes?: Record<string, FlarexNode>): FlarexEdge[] | null {
  // Pass 1: the last edge per socket, and separately the last edge per socket whose endpoints exist.
  // The split matters. "Last wins" alone lets a DANGLING edge displace a real wire — a pasted or
  // imported comp carrying a stale edge into an occupied socket would silently disconnect the node,
  // and the graph would look correct in the editor while lowering read nothing. A dangling edge is not
  // a wire and may never outrank one; it is left for the healer to drop on its own terms.
  const lastBySocket = new Map<string, number>();
  const lastConnectedBySocket = nodes ? new Map<string, number>() : null;
  for (let i = 0; i < edges.length; i++) {
    const key = `${edges[i]!.to.nodeId}:${edges[i]!.to.socket}`;
    lastBySocket.set(key, i);
    if (lastConnectedBySocket && nodes![edges[i]!.from.nodeId] && nodes![edges[i]!.to.nodeId]) {
      lastConnectedBySocket.set(key, i);
    }
  }
  if (lastBySocket.size === edges.length) return null; // already one-per-socket — no allocation

  const winner = (key: string): number => lastConnectedBySocket?.get(key) ?? lastBySocket.get(key)!;
  return edges.filter((edge, i) => winner(`${edge.to.nodeId}:${edge.to.socket}`) === i);
}

/** An edge is valid when both endpoints exist and the socket types match. */
export function isValidFlarexEdge(nodes: Record<string, FlarexNode>, edge: FlarexEdge): boolean {
  const fromNode = nodes[edge.from.nodeId];
  const toNode = nodes[edge.to.nodeId];
  if (!fromNode || !toNode) return false;
  const fromSocket = findFlarexOutputSocket(fromNode.type, edge.from.socket);
  const toSocket = findFlarexInputSocket(toNode.type, edge.to.socket);
  if (!fromSocket || !toSocket) return false;
  return fromSocket.type === toSocket.type;
}

/** Would connecting `from` → `to` create a cycle? (Edges point downstream toward MediaOut.) */
export function wouldCreateFlarexCycle(comp: FlarexComp, fromNodeId: string, toNodeId: string): boolean {
  if (fromNodeId === toNodeId) return true;
  const visited = new Set<string>();
  const stack = [fromNodeId];
  // Walk UPSTREAM from `from`; if we reach `to`, the new edge would close a loop.
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (id === toNodeId) return true;
    if (visited.has(id)) continue;
    visited.add(id);
    for (const edge of comp.edges) {
      if (edge.to.nodeId === id) stack.push(edge.from.nodeId);
    }
  }
  return false;
}

/**
 * Insert `nodeId` INTO an existing wire (the Fusion drop-on-wire splice): the edge A→B becomes
 * A→node.in and node.out→B. Returns null when the node can't legally sit on that wire — no free
 * input of the wire's type, no same-type output, endpoints touching the node itself, or a cycle.
 * Pure + validated, so the canvas can also use it as the drag-hover "will accept" predicate.
 */
export function spliceFlarexNodeIntoEdge(comp: FlarexComp, nodeId: string, edgeId: string): FlarexComp | null {
  const edge = comp.edges.find((e) => e.id === edgeId);
  const node = comp.nodes[nodeId];
  if (!edge || !node) return null;
  if (edge.from.nodeId === nodeId || edge.to.nodeId === nodeId) return null;
  const fromNode = comp.nodes[edge.from.nodeId];
  if (!fromNode) return null;
  const wireType = findFlarexOutputSocket(fromNode.type, edge.from.socket)?.type;
  if (!wireType) return null;
  const def = getFlarexNodeDefinition(node.type);
  // First UNWIRED input of the wire's type (an input holds one wire; outputs may fan out freely).
  const taken = new Set(comp.edges.map((e) => `${e.to.nodeId}:${e.to.socket}`));
  const input = def.inputs.find((s) => s.type === wireType && !taken.has(`${nodeId}:${s.id}`));
  const output = def.outputs.find((s) => s.type === wireType);
  if (!input || !output) return null;
  if (wouldCreateFlarexCycle(comp, edge.from.nodeId, nodeId) || wouldCreateFlarexCycle(comp, nodeId, edge.to.nodeId)) return null;
  const stamp = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const eIn: FlarexEdge = { id: `e_${stamp}_a`, from: edge.from, to: { nodeId, socket: input.id } };
  const eOut: FlarexEdge = { id: `e_${stamp}_b`, from: { nodeId, socket: output.id }, to: edge.to };
  if (!isValidFlarexEdge(comp.nodes, eIn) || !isValidFlarexEdge(comp.nodes, eOut)) return null;
  return { ...comp, edges: [...comp.edges.filter((e) => e.id !== edgeId), eIn, eOut] };
}

/**
 * Load-time healer: fills missing fields on legacy/hand-edited comps, drops edges whose
 * endpoints or socket types no longer resolve, and prunes comps with no MediaOut reachable.
 * Returns the same graph object when nothing needed healing (cheap no-op on every load).
 */
export function healFlarexRegistry(graph: ProjectGraph): ProjectGraph {
  const comps = graph.flarexComps;
  if (!comps) return graph;
  let changed = false;
  const healed: Record<string, FlarexComp> = {};
  for (const [id, comp] of Object.entries(comps)) {
    const nodes = comp.nodes ?? {};
    const valid = (comp.edges ?? []).filter((edge) => isValidFlarexEdge(nodes, edge));
    // I-20 on the LOAD path (S1.1). Endpoint+type validity was never sufficient: a duplicate edge into
    // one socket passes `isValidFlarexEdge` twice, and the three consumers then disagree about the
    // graph — see `dedupeFlarexEdges`. Hand-edited, imported and AI-generated comps all arrive here.
    const deduped = dedupeFlarexEdges(valid);
    if (deduped) reportEdgeRepair(comp.id ?? id, valid.length - deduped.length, "load");
    const edges = deduped ?? valid;
    const previewValid = !comp.previewNodeId || Boolean(nodes[comp.previewNodeId]);
    const next: FlarexComp = {
      ...comp,
      id: comp.id ?? id,
      name: comp.name ?? "Comp",
      nodes,
      edges,
      animations: comp.animations ?? [],
      version: typeof comp.version === "number" ? comp.version : 1,
      previewNodeId: previewValid ? comp.previewNodeId : undefined,
    };
    if (
      edges.length !== (comp.edges ?? []).length ||
      comp.nodes === undefined ||
      comp.animations === undefined ||
      typeof comp.version !== "number" ||
      !previewValid
    ) {
      changed = true;
    }
    healed[id] = next;
  }
  return changed ? { ...graph, flarexComps: healed } : graph;
}
