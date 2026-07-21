/**
 * Flarex comp registry seam (FLAREX.md Part 3) — the write/heal discipline mirrored from
 * `nesting.ts` (`stampCompositionRegistry`/`healCompositionRegistry`): comps live first-class
 * in `ProjectGraph.flarexComps`, clips reference them via `TimelineLayer.flarexCompId`, and
 * every write path goes through these helpers so a loaded graph is always structurally sound
 * (defaults filled, dangling edges dropped) before the compiler or UI touches it.
 */

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

/** Write-through seam: store/replace a comp in the registry with its version bumped.
 *  Call on EVERY comp mutation (the flarex.* actions funnel through this). */
export function stampFlarexComp(graph: ProjectGraph, comp: FlarexComp): ProjectGraph {
  const stamped: FlarexComp = { ...comp, version: (comp.version ?? 0) + 1 };
  return { ...graph, flarexComps: { ...(graph.flarexComps ?? {}), [stamped.id]: stamped } };
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
    const edges = (comp.edges ?? []).filter((edge) => isValidFlarexEdge(nodes, edge));
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
