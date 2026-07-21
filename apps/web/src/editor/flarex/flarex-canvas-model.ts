/**
 * Flarex node-canvas geometry + hit-testing (FLAREX.md Part 5) — pure math, no DOM/React, mirroring
 * the `editor/graph/graph-view.ts` "view state + px↔domain conversions + hit-test" split so the canvas
 * component stays imperative-draw only.
 *
 * World space = the comp's node coordinate plane (FlarexNode.ui.x/y, px). View maps world→screen with
 * pan (world px) + zoom.
 */

import { flarexNodeTypes, getFlarexNodeDefinition, type FlarexNodeType, type FlarexSocketDef } from "@orreris/shared";
import type { FlarexComp, FlarexEdge, FlarexNode } from "@orreris/shared";

/** Node types the user can ADD (via palette, drag, or the F1 Tab search menu) — excludes the two
 *  fixed comp endpoints (mediaIn/mediaOut) and the three Fable-fenced types whose `lower()` stays
 *  unwired this round (text, aiMatte, tracker; see plans/flarex-sonnet-execution-3.md FENCE). One
 *  canonical list so the palette and the search menu can never drift apart. */
const NOT_ADDABLE = new Set<FlarexNodeType>(["mediaIn", "mediaOut", "text", "aiMatte", "tracker"]);
export const flarexAddableNodeTypes: FlarexNodeType[] = flarexNodeTypes.filter((t) => !NOT_ADDABLE.has(t));

export interface FlarexViewState {
  panX: number;
  panY: number;
  zoom: number;
}

export const NODE_W = 132;
export const NODE_H = 36;
export const SOCKET_R = 5;
export const SOCKET_GAP = 14;
/** Reroute renders as a small dot node (F2, round 3) — its own fixed body size. */
export const REROUTE_SIZE = 18;
/** Backdrop's draggable titlebar strip height + resize-handle hit box (F2, round 3). */
export const BACKDROP_TITLEBAR_H = 22;
export const BACKDROP_RESIZE_HANDLE = 14;

export const clampZoom = (zoom: number): number => Math.min(2.5, Math.max(0.25, zoom));

export const worldToScreen = (view: FlarexViewState, wx: number, wy: number): [number, number] => [
  (wx - view.panX) * view.zoom,
  (wy - view.panY) * view.zoom,
];

export const screenToWorld = (view: FlarexViewState, sx: number, sy: number): [number, number] => [
  sx / view.zoom + view.panX,
  sy / view.zoom + view.panY,
];

/** Cursor-anchored wheel zoom (same behavior as graph-view's zoom). */
export function zoomAt(view: FlarexViewState, sx: number, sy: number, factor: number): FlarexViewState {
  const zoom = clampZoom(view.zoom * factor);
  const [wx, wy] = screenToWorld(view, sx, sy);
  return { zoom, panX: wx - sx / zoom, panY: wy - sy / zoom };
}

export interface SocketRef {
  nodeId: string;
  socket: string;
  kind: "input" | "output";
  def: FlarexSocketDef;
  /** World position of the socket center. */
  x: number;
  y: number;
}

/** Backdrop's own size lives in its params (w/h), not `ui` — `ui` stays the generic top-left
 *  position every node shares. Soft-defaults mirror the node-def's Zod defaults. */
export function backdropSize(node: FlarexNode): { w: number; h: number } {
  const w = typeof node.params.w === "number" ? node.params.w : 320;
  const h = typeof node.params.h === "number" ? node.params.h : 200;
  return { w, h };
}

/** Per-node body width — reroute and backdrop deviate from the standard `NODE_W` box. */
export function nodeWidth(node: FlarexNode): number {
  if (node.type === "reroute") return REROUTE_SIZE;
  if (node.type === "backdrop") return backdropSize(node).w;
  return NODE_W;
}

/** Socket world positions: inputs down the left edge, outputs down the right edge. */
export function nodeSockets(node: FlarexNode): SocketRef[] {
  const def = getFlarexNodeDefinition(node.type);
  const refs: SocketRef[] = [];
  def.inputs.forEach((socket, i) => {
    refs.push({ nodeId: node.id, socket: socket.id, kind: "input", def: socket, x: node.ui.x, y: node.ui.y + 12 + i * SOCKET_GAP });
  });
  def.outputs.forEach((socket, i) => {
    refs.push({ nodeId: node.id, socket: socket.id, kind: "output", def: socket, x: node.ui.x + nodeWidth(node), y: node.ui.y + 12 + i * SOCKET_GAP });
  });
  return refs;
}

/** Node body height grows with its socket count so wires never overlap the box edge. Reroute and
 *  backdrop deviate from the standard socket-count-driven formula. */
export function nodeHeight(node: FlarexNode): number {
  if (node.type === "reroute") return REROUTE_SIZE;
  if (node.type === "backdrop") return backdropSize(node).h;
  const def = getFlarexNodeDefinition(node.type);
  const rows = Math.max(def.inputs.length, def.outputs.length, 1);
  return Math.max(NODE_H, 10 + rows * SOCKET_GAP);
}

/**
 * Pure clone helper for node clipboard (copy/paste/duplicate, N3): remaps ids to fresh ones under
 * `idPrefix`, offsets every cloned node +24/+24 (so a paste never lands exactly on top of the
 * original), and keeps only the edges whose BOTH endpoints are in the input node list (edges
 * crossing outside the copied set have no home in the clone). MediaIn/Out are never clonable — the
 * graph's fixed endpoints — so they're filtered out even if the caller passes them in.
 */
export function cloneFlarexNodes(
  nodes: FlarexNode[],
  edges: FlarexEdge[],
  idPrefix: string,
): { nodes: FlarexNode[]; edges: FlarexEdge[] } {
  const cloneable = nodes.filter((n) => n.type !== "mediaIn" && n.type !== "mediaOut");
  const idMap = new Map<string, string>();
  const clonedNodes = cloneable.map((n, i) => {
    const newId = `${idPrefix}_${i}`;
    idMap.set(n.id, newId);
    return { ...n, id: newId, ui: { ...n.ui, x: n.ui.x + 24, y: n.ui.y + 24 } };
  });
  const clonedEdges = edges
    .filter((e) => idMap.has(e.from.nodeId) && idMap.has(e.to.nodeId))
    .map((e, i) => ({
      id: `${idPrefix}_e${i}`,
      from: { nodeId: idMap.get(e.from.nodeId)!, socket: e.from.socket },
      to: { nodeId: idMap.get(e.to.nodeId)!, socket: e.to.socket },
    }));
  return { nodes: clonedNodes, edges: clonedEdges };
}

export type FlarexAlignMode = "left" | "centerH" | "right" | "top" | "middleV" | "bottom" | "distributeH" | "distributeV";

/**
 * Pure position-math helper for the F5 align/distribute toolbar: given the selected nodes, returns
 * the new `{x,y}` for each (by id) — the caller applies it as ONE `onUpdateComp` commit. Align
 * modes need 2+ nodes; distribute modes need 3+ (2 nodes have no meaningful "middle" to space) and
 * no-op (empty result) otherwise.
 */
export function alignFlarexNodes(nodes: FlarexNode[], mode: FlarexAlignMode): Record<string, { x: number; y: number }> {
  if (nodes.length < 2) return {};
  const rects = nodes.map((n) => ({ id: n.id, x: n.ui.x, y: n.ui.y, w: nodeWidth(n), h: nodeHeight(n) }));
  const result: Record<string, { x: number; y: number }> = {};
  switch (mode) {
    case "left": {
      const minX = Math.min(...rects.map((r) => r.x));
      for (const r of rects) result[r.id] = { x: minX, y: r.y };
      break;
    }
    case "right": {
      const maxRight = Math.max(...rects.map((r) => r.x + r.w));
      for (const r of rects) result[r.id] = { x: Math.round(maxRight - r.w), y: r.y };
      break;
    }
    case "centerH": {
      const minX = Math.min(...rects.map((r) => r.x));
      const maxRight = Math.max(...rects.map((r) => r.x + r.w));
      const cx = (minX + maxRight) / 2;
      for (const r of rects) result[r.id] = { x: Math.round(cx - r.w / 2), y: r.y };
      break;
    }
    case "top": {
      const minY = Math.min(...rects.map((r) => r.y));
      for (const r of rects) result[r.id] = { x: r.x, y: minY };
      break;
    }
    case "bottom": {
      const maxBottom = Math.max(...rects.map((r) => r.y + r.h));
      for (const r of rects) result[r.id] = { x: r.x, y: Math.round(maxBottom - r.h) };
      break;
    }
    case "middleV": {
      const minY = Math.min(...rects.map((r) => r.y));
      const maxBottom = Math.max(...rects.map((r) => r.y + r.h));
      const cy = (minY + maxBottom) / 2;
      for (const r of rects) result[r.id] = { x: r.x, y: Math.round(cy - r.h / 2) };
      break;
    }
    case "distributeH": {
      if (rects.length < 3) break;
      const sorted = [...rects].sort((a, b) => a.x - b.x);
      const first = sorted[0]!;
      const last = sorted[sorted.length - 1]!;
      const step = (last.x - first.x) / (sorted.length - 1);
      sorted.forEach((r, i) => {
        result[r.id] = { x: Math.round(first.x + step * i), y: r.y };
      });
      break;
    }
    case "distributeV": {
      if (rects.length < 3) break;
      const sorted = [...rects].sort((a, b) => a.y - b.y);
      const first = sorted[0]!;
      const last = sorted[sorted.length - 1]!;
      const step = (last.y - first.y) / (sorted.length - 1);
      sorted.forEach((r, i) => {
        result[r.id] = { x: r.x, y: Math.round(first.y + step * i) };
      });
      break;
    }
  }
  return result;
}

export type FlarexHit =
  | { kind: "node"; nodeId: string }
  | { kind: "socket"; socket: SocketRef }
  /** Backdrop's bottom-right resize handle (F2, round 3). */
  | { kind: "backdropResize"; nodeId: string }
  | { kind: "background" };

/** Hit priority: sockets (generous radius) > regular node bodies (topmost = later in draw order)
 *  > backdrop titlebar/resize handle > background. Backdrops are checked LAST and only respond
 *  inside their titlebar strip or resize handle — everywhere else in a (possibly huge) backdrop
 *  rect counts as background, so marquee-select and clicks-through to nodes drawn over it are
 *  never swallowed. */
export function hitTest(comp: FlarexComp, view: FlarexViewState, sx: number, sy: number): FlarexHit {
  const [wx, wy] = screenToWorld(view, sx, sy);
  const socketHitR = (SOCKET_R + 4) / view.zoom + 4;
  // Socket centers sit ON the node's left/right edges, so the generous grab radius reaches into the
  // body — a click on the label would start a wire instead of selecting. Inside a body, only the
  // socket disc itself wins; the generous radius applies outside (where wires are aimed).
  const insideBody = (x: number, y: number): boolean =>
    Object.values(comp.nodes).some(
      (n) => n.type !== "backdrop" && x >= n.ui.x && x <= n.ui.x + nodeWidth(n) && y >= n.ui.y && y <= n.ui.y + nodeHeight(n),
    );
  const hitR = insideBody(wx, wy) ? Math.max(SOCKET_R, SOCKET_R / view.zoom) : socketHitR;
  const nodes = Object.values(comp.nodes);
  for (let i = nodes.length - 1; i >= 0; i -= 1) {
    for (const socket of nodeSockets(nodes[i]!)) {
      const dx = wx - socket.x;
      const dy = wy - socket.y;
      if (dx * dx + dy * dy <= hitR * hitR) return { kind: "socket", socket };
    }
  }
  for (let i = nodes.length - 1; i >= 0; i -= 1) {
    const node = nodes[i]!;
    if (node.type === "backdrop") continue;
    if (wx >= node.ui.x && wx <= node.ui.x + nodeWidth(node) && wy >= node.ui.y && wy <= node.ui.y + nodeHeight(node)) {
      return { kind: "node", nodeId: node.id };
    }
  }
  for (let i = nodes.length - 1; i >= 0; i -= 1) {
    const node = nodes[i]!;
    if (node.type !== "backdrop") continue;
    const { w, h } = backdropSize(node);
    if (wx >= node.ui.x + w - BACKDROP_RESIZE_HANDLE && wx <= node.ui.x + w && wy >= node.ui.y + h - BACKDROP_RESIZE_HANDLE && wy <= node.ui.y + h) {
      return { kind: "backdropResize", nodeId: node.id };
    }
    if (wx >= node.ui.x && wx <= node.ui.x + w && wy >= node.ui.y && wy <= node.ui.y + BACKDROP_TITLEBAR_H) {
      return { kind: "node", nodeId: node.id };
    }
  }
  return { kind: "background" };
}

/** Horizontal-bias cubic between two socket points (the Resolve/Fusion wire look). */
export function wirePath(x0: number, y0: number, x1: number, y1: number): [number, number, number, number, number, number, number, number] {
  const dx = Math.max(24, Math.abs(x1 - x0) * 0.5);
  return [x0, y0, x0 + dx, y0, x1 - dx, y1, x1, y1];
}

/** The screen-space cubic of one edge (same geometry the draw pass strokes), or null if an
 *  endpoint doesn't resolve. */
function edgeScreenCubic(
  comp: FlarexComp,
  view: FlarexViewState,
  edge: { from: { nodeId: string; socket: string }; to: { nodeId: string; socket: string } },
): [number, number, number, number, number, number, number, number] | null {
  const fromNode = comp.nodes[edge.from.nodeId];
  const toNode = comp.nodes[edge.to.nodeId];
  if (!fromNode || !toNode) return null;
  const a = nodeSockets(fromNode).find((s) => s.kind === "output" && s.socket === edge.from.socket);
  const b = nodeSockets(toNode).find((s) => s.kind === "input" && s.socket === edge.to.socket);
  if (!a || !b) return null;
  const [x0, y0] = worldToScreen(view, a.x, a.y);
  const [x1, y1] = worldToScreen(view, b.x, b.y);
  return wirePath(x0, y0, x1, y1);
}

function distToSegmentSq(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  const t = lenSq > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq)) : 0;
  const qx = ax + t * dx;
  const qy = ay + t * dy;
  return (px - qx) * (px - qx) + (py - qy) * (py - qy);
}

/**
 * Nearest wire under a screen point (drop-on-wire / wire selection). The cubic is flattened to 24
 * segments — plenty at node-editor scale. Returns the edge id or null beyond `tolPx`.
 */
export function hitTestWire(comp: FlarexComp, view: FlarexViewState, sx: number, sy: number, tolPx = 9): string | null {
  let best: string | null = null;
  let bestSq = tolPx * tolPx;
  for (const edge of comp.edges) {
    const cubic = edgeScreenCubic(comp, view, edge);
    if (!cubic) continue;
    const [x0, y0, c0x, c0y, c1x, c1y, x1, y1] = cubic;
    let px = x0;
    let py = y0;
    for (let i = 1; i <= 24; i += 1) {
      const t = i / 24;
      const u = 1 - t;
      const qx = u * u * u * x0 + 3 * u * u * t * c0x + 3 * u * t * t * c1x + t * t * t * x1;
      const qy = u * u * u * y0 + 3 * u * u * t * c0y + 3 * u * t * t * c1y + t * t * t * y1;
      const d = distToSegmentSq(sx, sy, px, py, qx, qy);
      if (d < bestSq) {
        bestSq = d;
        best = edge.id;
      }
      px = qx;
      py = qy;
    }
  }
  return best;
}
