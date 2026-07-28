/**
 * Flarex node-canvas geometry + hit-testing (FLAREX.md Part 5) — pure math, no DOM/React, mirroring
 * the `editor/graph/graph-view.ts` "view state + px↔domain conversions + hit-test" split so the canvas
 * component stays imperative-draw only.
 *
 * World space = the comp's node coordinate plane (FlarexNode.ui.x/y, px). View maps world→screen with
 * pan (world px) + zoom.
 */

import { flarexNodeDefs, flarexNodeTypes, getFlarexNodeDefinition, type FlarexNodeDefinition, type FlarexNodeType, type FlarexSocketDef } from "@orreris/shared";
import type { FlarexComp, FlarexEdge, FlarexNode } from "@orreris/shared";

/** Node types the user can ADD (via palette, drag, or the F1 Tab search menu) — excludes the fixed
 *  comp OUTPUT (mediaOut; a comp has exactly one) and the types whose `lower()` is still unwired
 *  (aiMatte). `text` left this list once Text+ gained a real lowering (it is backed by a
 *  virtual text layer now, so it renders); an unlowered node in the palette is a node that silently
 *  does nothing. MediaIn IS addable (multi-clip MediaIn, FLAREX.md Phase 2). One canonical list so the
 *  palette and the search menu can never drift apart. */
// `tracker` became addable 2026-07-28 (match-move v1 lowers for real); `aiMatte` is still un-lowered.
//
// `timeSpeed` is DELIBERATELY held back (2026-07-28). Its evaluator substrate is complete and gated —
// a retime moves every animated param, generator and nested graph above it (ADR-011). What it does NOT
// yet move is VIDEO: `hostSourceDraw` and `resolveSourceDraw` are built by the caller at the timeline
// playhead, so retiming a media sample needs the loader to seek elsewhere, which is media-pipeline work
// beyond the compiler.
//
// Shipping it now would mean "TimeSpeed does not slow down video" — the single most expected use, and
// exactly the partial-but-implied-general shape ADR-011 rejected when it turned down option C. A node
// that silently ignores the thing you pointed it at is worse than no node. Un-gate when media sampling
// honours the transform.
const NOT_ADDABLE = new Set<FlarexNodeType>(["mediaOut", "aiMatte", "timeSpeed"]);
export const flarexAddableNodeTypes: FlarexNodeType[] = flarexNodeTypes.filter((t) => !NOT_ADDABLE.has(t));

// Node categories are a purely LOGICAL grouping (labels + order below). They deliberately carry NO
// color palette: the Node Editor is a consumer of the application's single accent/theme source, so
// selection and interaction are accent-only and everything else is neutral (removed the former
// per-category `GROUP_COLORS` rainbow, 2026-07-23).

/** Human labels + display order for the top-level categories (= node-def `group`). */
export const FLAREX_CATEGORY_LABELS: Record<FlarexNodeDefinition["group"], string> = {
  io: "Input / Output",
  generator: "Generator",
  composite: "Composite",
  color: "Color",
  filter: "Filter",
  mask: "Mask & Key",
  tracking: "Tracking",
  layout: "Layout",
};
const CATEGORY_ORDER: FlarexNodeDefinition["group"][] = [
  "io", "generator", "composite", "color", "filter", "mask", "tracking", "layout",
];

/** A curated set of "pinned" nodes for the icon-only toolbar strip — the everyday commons. Everything
 *  else (and, later, the whole node library) is reached through the Add-Node browser / search. Order
 *  here is the strip order; grouping/dividers come from each node's category. */
export const FLAREX_PINNED_NODES: FlarexNodeType[] = [
  "mediaIn",
  "merge", "transform",
  // `color` is THE grade node (all stages in one, Resolve's corrector) and leads the colour group;
  // the atoms behind it stay pinned for precise Fusion-style graphs.
  "color", "colorCorrect", "colorCurves",
  "blur", "glow", "sharpen",
  "chromaKey", "lumaKey",
  "rectMask", "ellipseMask", "polygonMask", "bezierMask", "matteControl",
];

export interface FlarexCatalogSub { subcategory: string; defs: FlarexNodeDefinition[]; }
export interface FlarexCatalogCategory { group: FlarexNodeDefinition["group"]; label: string; subs: FlarexCatalogSub[]; }

/** Build the category → subcategory → nodes tree for the Add-Node browser, over the given addable
 *  types (defaults to `flarexAddableNodeTypes`). Ordered by CATEGORY_ORDER, then type order within. */
export function buildFlarexCatalog(types: FlarexNodeType[] = flarexAddableNodeTypes): FlarexCatalogCategory[] {
  const byCat = new Map<string, Map<string, FlarexNodeDefinition[]>>();
  for (const t of types) {
    const def = flarexNodeDefs[t];
    const subs = byCat.get(def.group) ?? new Map<string, FlarexNodeDefinition[]>();
    const list = subs.get(def.subcategory) ?? [];
    list.push(def);
    subs.set(def.subcategory, list);
    byCat.set(def.group, subs);
  }
  const cats: FlarexCatalogCategory[] = [];
  for (const group of CATEGORY_ORDER) {
    const subs = byCat.get(group);
    if (!subs) continue;
    cats.push({ group, label: FLAREX_CATEGORY_LABELS[group], subs: [...subs.entries()].map(([subcategory, defs]) => ({ subcategory, defs })) });
  }
  return cats;
}

/** Flat fuzzy match for the browser's search mode — matches label / category / subcategory / type. */
export function searchFlarexNodes(query: string, types: FlarexNodeType[] = flarexAddableNodeTypes): FlarexNodeDefinition[] {
  const defs = types.map((t) => flarexNodeDefs[t]);
  const q = query.trim().toLowerCase();
  if (!q) return defs;
  return defs.filter((d) => `${d.label} ${d.group} ${d.subcategory} ${d.type}`.toLowerCase().includes(q));
}

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

/** Horizontal gap between a node and one auto-placed after it — wide enough that the connecting wire
 *  reads as a link rather than the two bodies touching. */
export const NODE_PLACE_GAP_X = 44;
/** Vertical step used when the slot to the right is already occupied. */
export const NODE_PLACE_STEP_Y = NODE_H + 22;

/**
 * Where a node added "after" `sourceId` should land: immediately to its RIGHT, which is the direction
 * a Fusion-style graph reads and the direction the auto-wire runs (source output → new input). Placing
 * at the cursor instead — what the menu did before — meant a keyboard-driven add dropped the node
 * wherever the pointer happened to rest, often on top of existing nodes and rarely near the thing it
 * was just wired to.
 *
 * Occupied slots step DOWNWARD rather than rightward: adding three nodes off one source is a fan-out,
 * and a fan reads as a column. Stepping right would build a chain the graph does not have.
 *
 * Pure, so the placement rule is gated without a canvas.
 */
export function placeAfterNode(
  nodes: Record<string, { ui: { x: number; y: number } }>,
  sourceId: string
): { x: number; y: number } | null {
  const source = nodes[sourceId];
  if (!source) return null;
  const x = Math.round(source.ui.x + NODE_W + NODE_PLACE_GAP_X);
  const others = Object.entries(nodes).filter(([id]) => id !== sourceId).map(([, n]) => n.ui);
  // Overlap is judged on the node BODY, not its centre: two nodes 1px apart do not overlap, and a
  // strict-equality check would have let a near-miss stack visually while reporting the slot free.
  const collides = (candidateY: number): boolean =>
    others.some((other) => Math.abs(other.x - x) < NODE_W && Math.abs(other.y - candidateY) < NODE_H);
  let y = Math.round(source.ui.y);
  // Bounded: a graph dense enough to fill 24 slots straight down is better served by dropping the node
  // than by scanning forever, and the caller still gets a usable position.
  for (let step = 0; step < 24 && collides(y); step += 1) {
    y = Math.round(source.ui.y + (step + 1) * NODE_PLACE_STEP_Y);
  }
  return { x, y };
}

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
  /** Outward normal along X: +1 = socket sits on the node's RIGHT edge (wire leaves/arrives from the
   *  right), -1 = LEFT edge. Drives the wire's control-point direction so a flipped socket curves the
   *  right way. Canonical layout = inputs -1 (left), outputs +1 (right). */
  dir: 1 | -1;
}

/** Backdrop's own size lives in its params (w/h), not `ui` — `ui` stays the generic top-left
 *  position every node shares. Soft-defaults mirror the node-def's Zod defaults. */
export function backdropSize(node: FlarexNode): { w: number; h: number } {
  const w = typeof node.params.w === "number" ? node.params.w : 320;
  const h = typeof node.params.h === "number" ? node.params.h : 200;
  return { w, h };
}

/** Group titlebar height + the padding its auto-fit box leaves around its members. */
export const GROUP_TITLEBAR_H = 22;
export const GROUP_PADDING = 18;
/** A collapsed Group is a fixed-size title chip — its members are hidden, so there is nothing to fit. */
export const GROUP_COLLAPSED_W = 168;
export const GROUP_COLLAPSED_H = GROUP_TITLEBAR_H;

/** Member node ids of a Group (JSON id array). Soft-fails to none — a malformed payload must never
 *  throw mid-draw; the group just renders empty. */
export function groupMembers(node: FlarexNode): string[] {
  const raw = typeof node.params.members === "string" ? node.params.members : "";
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

export function groupIsCollapsed(node: FlarexNode): boolean {
  return node.params.collapsed === true;
}

/**
 * A Group's world rect. Expanded, it AUTO-FITS its members (plus padding and a titlebar), so there is
 * no stored size that can drift away from where the members actually are — move a member and the box
 * follows. Collapsed, it is a fixed title chip anchored at the group's own `ui` position.
 *
 * `posOf` lets the caller substitute in-flight drag positions so the box tracks a live move.
 */
export function groupRect(
  comp: FlarexComp,
  node: FlarexNode,
  posOf: (n: FlarexNode) => { x: number; y: number } = (n) => n.ui,
): { x: number; y: number; w: number; h: number } {
  const self = posOf(node);
  if (groupIsCollapsed(node)) return { x: self.x, y: self.y, w: GROUP_COLLAPSED_W, h: GROUP_COLLAPSED_H };
  const members = groupMembers(node)
    .map((id) => comp.nodes[id])
    .filter((n): n is FlarexNode => Boolean(n) && n!.type !== "group");
  if (members.length === 0) return { x: self.x, y: self.y, w: GROUP_COLLAPSED_W, h: GROUP_COLLAPSED_H + GROUP_PADDING };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const member of members) {
    const pos = posOf(member);
    minX = Math.min(minX, pos.x);
    minY = Math.min(minY, pos.y);
    maxX = Math.max(maxX, pos.x + nodeWidth(member, comp));
    maxY = Math.max(maxY, pos.y + nodeHeight(member, comp));
  }
  return {
    x: minX - GROUP_PADDING,
    y: minY - GROUP_PADDING - GROUP_TITLEBAR_H,
    w: maxX - minX + GROUP_PADDING * 2,
    h: maxY - minY + GROUP_PADDING * 2 + GROUP_TITLEBAR_H,
  };
}

/**
 * Node id → the id of the COLLAPSED group hiding it. Hidden nodes are skipped by hit-testing and the
 * draw pass, and their wires re-anchor onto the group's box (see `socketAnchor`) so a collapsed group
 * still shows what flows in and out of it.
 *
 * A node listed by several groups belongs to the first that claims it — membership is a set, not a
 * hierarchy, and this keeps the resolution total and order-stable.
 */
export function collapsedMemberOwners(comp: FlarexComp): Map<string, string> {
  const owners = new Map<string, string>();
  for (const node of Object.values(comp.nodes)) {
    if (node.type !== "group" || !groupIsCollapsed(node)) continue;
    for (const id of groupMembers(node)) if (!owners.has(id)) owners.set(id, node.id);
  }
  return owners;
}

/**
 * Node layout with thumbnails on (Slice 6, redesigned to the Resolve/Fusion idiom):
 *
 *        Color Wheels          ← label OUTSIDE, above the box (Resolve puts the name above the tile)
 *      ┌──────────────┐
 *      │▸  [picture] ▪│        ← the body IS the picture, in a thin bezel; sockets centred on it
 *      ├──────────────┤
 *      │ 03        ◆ ●│        ← footer: node index + status glyphs
 *      └──────────────┘
 *
 * With thumbnails OFF the node keeps the compact Fusion form (label INSIDE, socket-count-driven
 * height) — the same rule both references follow: the name lives outside only when a picture needs
 * the whole tile.
 */
export const NODE_THUMB_H = 74;
/** Footer strip under the picture: node index (left) + status glyphs (right). */
export const NODE_FOOTER_H = 17;
/** Inset between the node border and the picture, so the image reads as framed, not bled to the edge. */
export const NODE_BEZEL = 3;
/** Baseline offset of the outside label above the node's top edge. */
export const NODE_LABEL_GAP = 6;

/**
 * Whether nodes currently render a thumbnail strip — a VIEW MODE, in the same category as pan/zoom,
 * which is why it lives in the view model rather than in project data (a preview preference must not
 * be a graph mutation, and it must not travel between machines with the file).
 *
 * Module-scoped rather than threaded through every geometry call deliberately: `nodeHeight` feeds
 * `nodeSockets`, `groupRect`, `hitTest` and `socketAnchor`, and a parameter missed at ONE of those
 * sites would put a node's wires somewhere its body is not. One switch, read in one place, cannot
 * disagree with itself. `FlarexNodeCanvas` owns the setter; tests must restore the previous value.
 */
let thumbnailsOn = false;
export function setFlarexNodeThumbnails(on: boolean): void {
  thumbnailsOn = on;
}
export function flarexNodeThumbnailsEnabled(): boolean {
  return thumbnailsOn;
}

/** Whether this node type shows a picture. Layout chrome (backdrop/group) and the reroute dot have no
 *  output of their own to preview; every other type lowers to something renderable. */
export function nodeHasThumbnail(node: FlarexNode): boolean {
  return node.type !== "backdrop" && node.type !== "group" && node.type !== "reroute";
}

/** Per-node body width — reroute, backdrop and group deviate from the standard `NODE_W` box.
 *  `comp` is only needed for a Group (its box is derived from its members). */
export function nodeWidth(node: FlarexNode, comp?: FlarexComp): number {
  if (node.type === "reroute") return REROUTE_SIZE;
  if (node.type === "backdrop") return backdropSize(node).w;
  if (node.type === "group") return comp ? groupRect(comp, node).w : GROUP_COLLAPSED_W;
  return NODE_W;
}

/** Per-type VISUAL vertical order of input sockets (top → bottom), overriding declaration order.
 *  Merge: foreground sits ABOVE background so the stack reads like a layer list (fg over bg), which
 *  is what users expect — the def order stays bg,fg,mask (bg is still the primary/auto-wire input),
 *  this ONLY moves the dots. Any socket id not listed falls back to its declaration index. */
const INPUT_SOCKET_VISUAL_ORDER: Partial<Record<FlarexNodeType, string[]>> = {
  merge: ["fg", "bg", "mask"],
};

/**
 * Which horizontal side each socket bank sits on ("Auto left/right flip"): an OUTPUT hops to the side
 * facing its destination(s), an INPUT to the side facing its source(s). ONLY horizontal — sockets never
 * move to top/bottom, and their vertical ORDER is preserved. A full node-width dead zone (the flip
 * fires only when the other node clears this node's opposite edge) keeps the dot from jittering while
 * nodes overlap horizontally — stable hit-testing, no moving target during small nudges. No `comp` (or
 * no connections) → the canonical layout (inputs left, outputs right).
 */
function socketSides(node: FlarexNode, comp?: FlarexComp): { input: 1 | -1; output: 1 | -1 } {
  if (!comp) return { input: -1, output: 1 };
  const left = node.ui.x;
  const right = node.ui.x + nodeWidth(node);
  const centerOf = (n: FlarexNode) => n.ui.x + nodeWidth(n) / 2;
  let destSum = 0;
  let destN = 0;
  let srcSum = 0;
  let srcN = 0;
  for (const e of comp.edges) {
    if (e.from.nodeId === node.id) {
      const d = comp.nodes[e.to.nodeId];
      if (d) {
        destSum += centerOf(d);
        destN += 1;
      }
    }
    if (e.to.nodeId === node.id) {
      const s = comp.nodes[e.from.nodeId];
      if (s) {
        srcSum += centerOf(s);
        srcN += 1;
      }
    }
  }
  // Output flips LEFT only when every destination (on average) clears this node's left edge; input flips
  // RIGHT only when the sources clear the right edge. Otherwise stay canonical.
  const output: 1 | -1 = destN > 0 && destSum / destN < left ? -1 : 1;
  const input: 1 | -1 = srcN > 0 && srcSum / srcN > right ? 1 : -1;
  return { input, output };
}

/**
 * The vertical band sockets are laid out in: the PICTURE area when a node has one (so the dots line up
 * with the image, as in Resolve, instead of bunching against the top edge above it), otherwise the
 * whole compact body. Never the footer — a wire must never appear to land on the index/glyph strip.
 */
function socketBand(node: FlarexNode): { top: number; h: number } {
  if (thumbnailsOn && nodeHasThumbnail(node)) return { top: node.ui.y, h: NODE_THUMB_H };
  return { top: node.ui.y, h: nodeHeight(node) };
}

/** Socket world positions. Each BANK is CENTRED in the socket band (so a lone output sits exactly at
 *  mid-height) and stacks top→bottom at a fixed vertical order; each bank sits on the horizontal side
 *  facing its connections (see `socketSides`) — pass `comp` to enable the flip. */
export function nodeSockets(node: FlarexNode, comp?: FlarexComp): SocketRef[] {
  const def = getFlarexNodeDefinition(node.type);
  const refs: SocketRef[] = [];
  const w = nodeWidth(node);
  const sides = socketSides(node, comp);
  const visualOrder = INPUT_SOCKET_VISUAL_ORDER[node.type];
  const band = socketBand(node);
  // Each bank centres on its OWN count, so a 1-in/1-out node has both dots on the centre line.
  const bankTop = (count: number): number => band.top + Math.max(6, (band.h - Math.max(0, count - 1) * SOCKET_GAP) / 2);
  const inTop = bankTop(def.inputs.length);
  const outTop = bankTop(def.outputs.length);
  def.inputs.forEach((socket, i) => {
    const slot = visualOrder ? (visualOrder.indexOf(socket.id) >= 0 ? visualOrder.indexOf(socket.id) : i) : i;
    const x = sides.input === 1 ? node.ui.x + w : node.ui.x;
    refs.push({ nodeId: node.id, socket: socket.id, kind: "input", def: socket, x, y: inTop + slot * SOCKET_GAP, dir: sides.input });
  });
  def.outputs.forEach((socket, i) => {
    const x = sides.output === 1 ? node.ui.x + w : node.ui.x;
    refs.push({ nodeId: node.id, socket: socket.id, kind: "output", def: socket, x, y: outTop + i * SOCKET_GAP, dir: sides.output });
  });
  return refs;
}

/** Node body height grows with its socket count so wires never overlap the box edge. Reroute,
 *  backdrop and group deviate from the standard socket-count-driven formula. */
export function nodeHeight(node: FlarexNode, comp?: FlarexComp): number {
  if (node.type === "reroute") return REROUTE_SIZE;
  if (node.type === "backdrop") return backdropSize(node).h;
  if (node.type === "group") return comp ? groupRect(comp, node).h : GROUP_COLLAPSED_H;
  // Picture nodes are [picture | footer] — a fixed tile, like Resolve. The socket count no longer
  // drives the height because the picture band is already taller than any bank of sockets.
  if (thumbnailsOn && nodeHasThumbnail(node)) return NODE_THUMB_H + NODE_FOOTER_H;
  const def = getFlarexNodeDefinition(node.type);
  const rows = Math.max(def.inputs.length, def.outputs.length, 1);
  return Math.max(NODE_H, 10 + rows * SOCKET_GAP);
}

/** The node's picture area in world space, or null when it has none (mode off / not a picture node). */
export function nodeThumbRect(node: FlarexNode): { x: number; y: number; w: number; h: number } | null {
  if (!thumbnailsOn || !nodeHasThumbnail(node)) return null;
  return { x: node.ui.x, y: node.ui.y, w: nodeWidth(node), h: NODE_THUMB_H };
}

/** The footer strip (index + status glyphs) under the picture, or null when the node has no picture. */
export function nodeFooterRect(node: FlarexNode): { x: number; y: number; w: number; h: number } | null {
  if (!thumbnailsOn || !nodeHasThumbnail(node)) return null;
  return { x: node.ui.x, y: node.ui.y + NODE_THUMB_H, w: nodeWidth(node), h: NODE_FOOTER_H };
}

/**
 * Display index per picture node ("01", "02", …) for the footer, in CREATION order — which is the
 * object's own key order, since every node is added by spreading the previous map. Resolve numbers its
 * nodes the same way, and a stable number is what lets people talk about "node 4" at all; deriving it
 * from POSITION instead would renumber the graph every time someone tidied the layout.
 */
export function flarexNodeIndices(comp: FlarexComp): Map<string, number> {
  const indices = new Map<string, number>();
  let n = 0;
  for (const id of Object.keys(comp.nodes)) {
    const node = comp.nodes[id];
    if (!node || !nodeHasThumbnail(node)) continue;
    n += 1;
    indices.set(id, n);
  }
  return indices;
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

/**
 * The nodes a drag of `ids` should actually move: the ids themselves, plus the members of any Group
 * among them. Dragging a group has to carry its contents — that is what makes it a container rather
 * than a floating label. Transitively closed (a group listing another group moves that one's members
 * too) and de-duplicated, so overlapping membership can't move a node twice.
 */
export function expandGroupDragSet(comp: FlarexComp, ids: string[]): string[] {
  const out = new Set<string>();
  const queue = [...ids];
  while (queue.length > 0) {
    const id = queue.pop()!;
    if (out.has(id)) continue;
    out.add(id);
    const node = comp.nodes[id];
    if (node?.type === "group") for (const member of groupMembers(node)) if (!out.has(member)) queue.push(member);
  }
  return [...out];
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
  // Nodes inside a COLLAPSED group are not on screen, so they must not be clickable either — their
  // wires re-anchor onto the group box (see `socketAnchor`) and the group itself takes the clicks.
  const hidden = collapsedMemberOwners(comp);
  const visible = (n: FlarexNode): boolean => !hidden.has(n.id);
  // Socket centers sit ON the node's left/right edges, so the generous grab radius reaches into the
  // body — a click on the label would start a wire instead of selecting. Inside a body, only the
  // socket disc itself wins; the generous radius applies outside (where wires are aimed).
  const insideBody = (x: number, y: number): boolean =>
    Object.values(comp.nodes).some(
      (n) =>
        n.type !== "backdrop" &&
        n.type !== "group" &&
        visible(n) &&
        x >= n.ui.x && x <= n.ui.x + nodeWidth(n, comp) && y >= n.ui.y && y <= n.ui.y + nodeHeight(n, comp),
    );
  const hitR = insideBody(wx, wy) ? Math.max(SOCKET_R, SOCKET_R / view.zoom) : socketHitR;
  const nodes = Object.values(comp.nodes);
  for (let i = nodes.length - 1; i >= 0; i -= 1) {
    if (!visible(nodes[i]!)) continue;
    for (const socket of nodeSockets(nodes[i]!, comp)) {
      const dx = wx - socket.x;
      const dy = wy - socket.y;
      if (dx * dx + dy * dy <= hitR * hitR) return { kind: "socket", socket };
    }
  }
  for (let i = nodes.length - 1; i >= 0; i -= 1) {
    const node = nodes[i]!;
    if (node.type === "backdrop" || node.type === "group" || !visible(node)) continue;
    if (wx >= node.ui.x && wx <= node.ui.x + nodeWidth(node, comp) && wy >= node.ui.y && wy <= node.ui.y + nodeHeight(node, comp)) {
      return { kind: "node", nodeId: node.id };
    }
  }
  // Groups: like Backdrop, only the TITLEBAR takes clicks, so the (possibly large) body never swallows
  // marquee-select or clicks meant for the members drawn inside it. A COLLAPSED group is all titlebar.
  for (let i = nodes.length - 1; i >= 0; i -= 1) {
    const node = nodes[i]!;
    if (node.type !== "group") continue;
    const rect = groupRect(comp, node);
    if (wx >= rect.x && wx <= rect.x + rect.w && wy >= rect.y && wy <= rect.y + GROUP_TITLEBAR_H) {
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

/** Horizontal-bias cubic between two socket points (the Resolve/Fusion wire look). `dir0`/`dir1` are the
 *  endpoints' outward-normal X (+1 right edge, -1 left edge, from `SocketRef.dir`): the control point
 *  leaves each socket along its facing side, so a flipped output/input still curves outward instead of
 *  cutting back through the node. Defaults reproduce the canonical output-right → input-left curve. */
export function wirePath(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  dir0: 1 | -1 = 1,
  dir1: 1 | -1 = -1,
): [number, number, number, number, number, number, number, number] {
  const dx = Math.max(24, Math.abs(x1 - x0) * 0.5);
  return [x0, y0, x0 + dir0 * dx, y0, x1 + dir1 * dx, y1, x1, y1];
}

/**
 * Where a socket's wire actually attaches, in world space.
 *
 * Normally that is the socket itself. But when the owning node is hidden inside a COLLAPSED group, the
 * wire attaches to the group's box instead — outputs on its right edge, inputs on its left — so a
 * collapsed group still shows everything flowing in and out of it rather than dropping those wires.
 * That is the whole difference between a Compound node and a box that merely hides things.
 *
 * `owners` is passed in (not recomputed) because the draw pass resolves every endpoint on every frame.
 */
export function socketAnchor(
  comp: FlarexComp,
  owners: Map<string, string>,
  nodeId: string,
  socketId: string,
  kind: "input" | "output",
  posOf: (n: FlarexNode) => { x: number; y: number } = (n) => n.ui,
): { x: number; y: number; dir: 1 | -1; def: FlarexSocketDef } | null {
  const node = comp.nodes[nodeId];
  if (!node) return null;
  const ref = nodeSockets(node, comp).find((s) => s.socket === socketId && s.kind === kind);
  if (!ref) return null;
  const ownerId = owners.get(nodeId);
  const owner = ownerId ? comp.nodes[ownerId] : undefined;
  if (owner) {
    const rect = groupRect(comp, owner, posOf);
    const dir: 1 | -1 = kind === "output" ? 1 : -1;
    return { x: dir === 1 ? rect.x + rect.w : rect.x, y: rect.y + rect.h / 2, dir, def: ref.def };
  }
  // Live-move preview: a dragged node's sockets follow its draft position.
  const pos = posOf(node);
  return { x: ref.x + (pos.x - node.ui.x), y: ref.y + (pos.y - node.ui.y), dir: ref.dir, def: ref.def };
}

/** The screen-space cubic of one edge (same geometry the draw pass strokes), or null if an
 *  endpoint doesn't resolve. */
function edgeScreenCubic(
  comp: FlarexComp,
  view: FlarexViewState,
  edge: { from: { nodeId: string; socket: string }; to: { nodeId: string; socket: string } },
): [number, number, number, number, number, number, number, number] | null {
  const owners = collapsedMemberOwners(comp);
  const a = socketAnchor(comp, owners, edge.from.nodeId, edge.from.socket, "output");
  const b = socketAnchor(comp, owners, edge.to.nodeId, edge.to.socket, "input");
  if (!a || !b) return null;
  const [x0, y0] = worldToScreen(view, a.x, a.y);
  const [x1, y1] = worldToScreen(view, b.x, b.y);
  return wirePath(x0, y0, x1, y1, a.dir, b.dir);
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
