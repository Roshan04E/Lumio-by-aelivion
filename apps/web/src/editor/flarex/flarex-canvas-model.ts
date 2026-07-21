/**
 * Flarex node-canvas geometry + hit-testing (FLAREX.md Part 5) — pure math, no DOM/React, mirroring
 * the `editor/graph/graph-view.ts` "view state + px↔domain conversions + hit-test" split so the canvas
 * component stays imperative-draw only.
 *
 * World space = the comp's node coordinate plane (FlarexNode.ui.x/y, px). View maps world→screen with
 * pan (world px) + zoom.
 */

import { getFlarexNodeDefinition, type FlarexSocketDef } from "@orreris/shared";
import type { FlarexComp, FlarexNode } from "@orreris/shared";

export interface FlarexViewState {
  panX: number;
  panY: number;
  zoom: number;
}

export const NODE_W = 132;
export const NODE_H = 36;
export const SOCKET_R = 5;
export const SOCKET_GAP = 14;

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

/** Socket world positions: inputs down the left edge, outputs down the right edge. */
export function nodeSockets(node: FlarexNode): SocketRef[] {
  const def = getFlarexNodeDefinition(node.type);
  const refs: SocketRef[] = [];
  def.inputs.forEach((socket, i) => {
    refs.push({ nodeId: node.id, socket: socket.id, kind: "input", def: socket, x: node.ui.x, y: node.ui.y + 12 + i * SOCKET_GAP });
  });
  def.outputs.forEach((socket, i) => {
    refs.push({ nodeId: node.id, socket: socket.id, kind: "output", def: socket, x: node.ui.x + NODE_W, y: node.ui.y + 12 + i * SOCKET_GAP });
  });
  return refs;
}

/** Node body height grows with its socket count so wires never overlap the box edge. */
export function nodeHeight(node: FlarexNode): number {
  const def = getFlarexNodeDefinition(node.type);
  const rows = Math.max(def.inputs.length, def.outputs.length, 1);
  return Math.max(NODE_H, 10 + rows * SOCKET_GAP);
}

export type FlarexHit =
  | { kind: "node"; nodeId: string }
  | { kind: "socket"; socket: SocketRef }
  | { kind: "background" };

/** Hit priority: sockets (generous radius) > node bodies (topmost = later in draw order) > background. */
export function hitTest(comp: FlarexComp, view: FlarexViewState, sx: number, sy: number): FlarexHit {
  const [wx, wy] = screenToWorld(view, sx, sy);
  const socketHitR = (SOCKET_R + 4) / view.zoom + 4;
  // Socket centers sit ON the node's left/right edges, so the generous grab radius reaches into the
  // body — a click on the label would start a wire instead of selecting. Inside a body, only the
  // socket disc itself wins; the generous radius applies outside (where wires are aimed).
  const insideBody = (x: number, y: number): boolean =>
    Object.values(comp.nodes).some((n) => x >= n.ui.x && x <= n.ui.x + NODE_W && y >= n.ui.y && y <= n.ui.y + nodeHeight(n));
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
    if (wx >= node.ui.x && wx <= node.ui.x + NODE_W && wy >= node.ui.y && wy <= node.ui.y + nodeHeight(node)) {
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
