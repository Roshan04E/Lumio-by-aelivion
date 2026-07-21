/**
 * Flarex node canvas (FLAREX.md Part 5) — a DPR-aware Canvas2D DAG editor in the GraphEditor
 * idiom (imperative draw, pointer gestures, no DOM-per-node). Gestures (the Fusion model):
 *   click node              → select (inspector); Shift/Ctrl+click → toggle in/out of selection
 *   drag background         → marquee box-select (touch = selected); click background → deselect
 *   drag a selected node    → move the WHOLE selection (draft local, ONE commit on release)
 *   drag output socket      → wire; drop on a type-matching input connects (replacing that input's wire)
 *   middle-drag / Alt+drag  → pan; wheel → cursor-anchored zoom
 *   Delete/Backspace        → remove every selected node (never MediaIn/Out)
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  createFlarexNode,
  getFlarexNodeDefinition,
  isValidFlarexEdge,
  spliceFlarexNodeIntoEdge,
  wouldCreateFlarexCycle,
  type FlarexComp,
  type FlarexEdge,
  type FlarexNode,
  type FlarexNodeType,
} from "@orreris/shared";
import {
  NODE_W,
  SOCKET_R,
  backdropSize,
  clampZoom,
  cloneFlarexNodes,
  flarexAddableNodeTypes,
  hitTest,
  hitTestWire,
  nodeHeight,
  nodeWidth,
  nodeSockets,
  screenToWorld,
  wirePath,
  worldToScreen,
  zoomAt,
  type FlarexViewState,
  type SocketRef,
} from "./flarex-canvas-model";

/** Module-level clipboard (not the system clipboard — a plain in-memory snapshot, same idiom as
 *  `flarexPaletteDrag`). Cross-comp paste is out of scope for v1: cleared whenever the active comp
 *  changes (see the effect below), so a paste only ever lands in the comp it was copied from. */
const flarexClipboard: { current: { compId: string; nodes: FlarexNode[]; edges: FlarexEdge[] } | null } = { current: null };

/** Same-window palette drag payload (HTML5 dataTransfer hides its data until drop — this ref is
 *  what lets the canvas validate + highlight the target wire DURING the hover). The toolbar sets
 *  it on dragstart and clears it on dragend. */
export const flarexPaletteDrag: { current: FlarexNodeType | null } = { current: null };

/** Last node type inserted via the F1 search menu (any tab) — shown first in the menu next time,
 *  a small memory that saves re-typing the same query repeatedly (F6.3). Session-lifetime only. */
const lastUsedNodeType: { current: FlarexNodeType | null } = { current: null };

/** "#rrggbb" / "#rgb" → "r,g,b" for rgba() template strings; non-hex values fall back to the
 *  default amber so a malformed theme var can never produce an invalid canvas color. */
function hexToRgbTriplet(hex: string): string {
  const m6 = /^#([0-9a-f]{6})$/i.exec(hex);
  if (m6) {
    const v = parseInt(m6[1] ?? "", 16);
    return `${(v >> 16) & 0xff},${(v >> 8) & 0xff},${v & 0xff}`;
  }
  const m3 = /^#([0-9a-f]{3})$/i.exec(hex);
  if (m3) {
    const v = parseInt(m3[1] ?? "", 16);
    const r = (v >> 8) & 0xf;
    const g = (v >> 4) & 0xf;
    const b = v & 0xf;
    return `${r * 17},${g * 17},${b * 17}`;
  }
  return "232,176,75";
}

/** Group accent colors — also used by the toolbar palette buttons (left border strip, N6) so the
 *  canvas and palette read as one system. */
export const GROUP_COLORS: Record<string, string> = {
  io: "#8a8f98",
  composite: "#e8b04b",
  color: "#5fb2e6",
  filter: "#b58fe0",
  mask: "#69c98a",
  generator: "#e0708a",
  tracking: "#d5cf6d",
  layout: "#7a8290",
};

export interface FlarexNodeCanvasProps {
  comp: FlarexComp;
  selectedNodeIds: string[];
  onSelectNodes: (nodeIds: string[]) => void;
  /** ONE call per finished gesture (move/connect/delete) — the caller stamps + persists. */
  onUpdateComp: (updater: (comp: FlarexComp) => FlarexComp) => void;
}

type Gesture =
  | { kind: "none" }
  | { kind: "pan"; startX: number; startY: number; panX: number; panY: number }
  | { kind: "marquee"; startX: number; startY: number; curX: number; curY: number; additive: boolean }
  | {
      kind: "moveNodes";
      /** World-space grab point + each dragged node's original position; drafts = orig + delta. */
      grabWX: number;
      grabWY: number;
      start: Record<string, { x: number; y: number }>;
      positions: Record<string, { x: number; y: number }>;
      /** Wire under the cursor that ACCEPTS the (single) dragged node — release splices into it. */
      hoverEdgeId: string | null;
    }
  | { kind: "wire"; from: SocketRef; toX: number; toY: number; target: SocketRef | null }
  | { kind: "backdropResize"; nodeId: string; startX: number; startY: number; startW: number; startH: number; curW: number; curH: number };

export function FlarexNodeCanvas({ comp, selectedNodeIds, onSelectNodes, onUpdateComp }: FlarexNodeCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [view, setView] = useState<FlarexViewState>(() => ({
    panX: comp.view?.panX ?? -40,
    panY: comp.view?.panY ?? -40,
    zoom: clampZoom(comp.view?.zoom ?? 1),
  }));
  const [gesture, setGesture] = useState<Gesture>({ kind: "none" });
  const [size, setSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  /** Palette drag-over state: ghost position + the wire that would accept the dropped node. */
  const [paletteHover, setPaletteHover] = useState<{ sx: number; sy: number; edgeId: string | null } | null>(null);
  /** A clicked wire (beside node selection, mutually exclusive — an edge click clears node
   *  selection and vice versa); Delete removes it. */
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  /** F1: the add-node search menu (Tab or right-click empty canvas). `wx/wy` = world insert
   *  position; `sx/sy` = screen anchor for the DOM overlay. */
  const [nodeMenu, setNodeMenu] = useState<{ sx: number; sy: number; wx: number; wy: number; query: string; activeIndex: number } | null>(null);
  /** F1.3: minimal right-click-on-node context menu (Rename/Enable-Disable/Delete/View). */
  const [nodeContextMenu, setNodeContextMenu] = useState<{ sx: number; sy: number; nodeId: string } | null>(null);
  /** F5.1: inline rename — an absolutely-positioned input over the canvas at the node's screen rect. */
  const [renaming, setRenaming] = useState<{ nodeId: string; draft: string } | null>(null);
  // Last known pointer position (updated on every hover, not just mid-gesture) — Tab needs it to
  // anchor the search menu at the cursor even though hovering alone doesn't start a gesture.
  const lastPointerRef = useRef<{ sx: number; sy: number }>({ sx: 0, sy: 0 });

  // Latest values in refs so pointer handlers + the draw pass never rebind.
  const stateRef = useRef({ comp, view, gesture, selectedNodeIds, size, selectedEdgeId });
  stateRef.current = { comp, view, gesture, selectedNodeIds, size, selectedEdgeId };

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return undefined;
    const observer = new ResizeObserver(() => {
      setSize({ w: wrap.clientWidth, h: wrap.clientHeight });
    });
    observer.observe(wrap);
    setSize({ w: wrap.clientWidth, h: wrap.clientHeight });
    return () => observer.disconnect();
  }, []);

  // Theme switches swap --nle-accent via the data-orreris-theme attribute on .editor-page; the
  // draw pass resolves the var imperatively, so a switch while the canvas is idle needs a redraw.
  const [themeTick, setThemeTick] = useState(0);
  useEffect(() => {
    const page = wrapRef.current?.closest(".editor-page");
    if (!page) return undefined;
    const observer = new MutationObserver(() => setThemeTick((t) => t + 1));
    observer.observe(page, { attributes: true, attributeFilter: ["data-orreris-theme"] });
    return () => observer.disconnect();
  }, []);

  // ── Imperative draw ─────────────────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || size.w === 0 || size.h === 0) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(size.w * dpr);
    canvas.height = Math.round(size.h * dpr);
    const g = canvas.getContext("2d");
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, size.w, size.h);

    // Theme accent (the Theme selector swaps --nle-accent per theme): Canvas2D can't consume CSS
    // vars, so every highlight color (selection, splice wire, marquee, view dot, drop ghost) is
    // resolved here per draw pass instead of hardcoding the amber default.
    const accentHex = getComputedStyle(canvas).getPropertyValue("--nle-accent").trim() || "#e8b04b";
    const accentRgb = hexToRgbTriplet(accentHex);

    // World-locked line grid — very subtle minor lines with slightly firmer major lines every 5th.
    const step = 28 * view.zoom;
    if (step > 6) {
      const gridPass = (spacing: number, alpha: number) => {
        const ox = ((-view.panX * view.zoom) % spacing + spacing) % spacing;
        const oy = ((-view.panY * view.zoom) % spacing + spacing) % spacing;
        g.strokeStyle = `rgba(255,255,255,${alpha})`;
        g.lineWidth = 1;
        g.beginPath();
        for (let x = ox; x < size.w; x += spacing) {
          g.moveTo(x + 0.5, 0);
          g.lineTo(x + 0.5, size.h);
        }
        for (let y = oy; y < size.h; y += spacing) {
          g.moveTo(0, y + 0.5);
          g.lineTo(size.w, y + 0.5);
        }
        g.stroke();
      };
      gridPass(step, 0.022);
      gridPass(step * 5, 0.04);
    }

    const draftPos = (node: FlarexNode): { x: number; y: number } =>
      gesture.kind === "moveNodes" ? gesture.positions[node.id] ?? node.ui : node.ui;

    /** Live-resize preview: the backdrop being dragged follows the draft size, not the committed one. */
    const draftBackdropSize = (node: FlarexNode): { w: number; h: number } =>
      gesture.kind === "backdropResize" && gesture.nodeId === node.id ? { w: gesture.curW, h: gesture.curH } : backdropSize(node);

    const socketPos = (nodeId: string, socketId: string, kind: "input" | "output"): [number, number] | null => {
      const node = comp.nodes[nodeId];
      if (!node) return null;
      const ref = nodeSockets(node).find((s) => s.socket === socketId && s.kind === kind);
      if (!ref) return null;
      // Live-move preview: dragged nodes' sockets follow the draft positions.
      const pos = draftPos(node);
      return worldToScreen(view, ref.x + (pos.x - node.ui.x), ref.y + (pos.y - node.ui.y));
    };

    // Backdrops (F2, round 3): LOW z-order — drawn before wires/nodes so they always sit behind
    // everything else. Only translucent fill + titlebar + resize handle; no sockets (it has none).
    for (const node of Object.values(comp.nodes)) {
      if (node.type !== "backdrop") continue;
      const pos = draftPos(node);
      const { w: bw, h: bh } = draftBackdropSize(node);
      const [x, y] = worldToScreen(view, pos.x, pos.y);
      const w = bw * view.zoom;
      const h = bh * view.zoom;
      const color = typeof node.params.color === "string" ? node.params.color : "#3a3f4a";
      const selected = selectedNodeIds.includes(node.id);
      g.beginPath();
      g.roundRect(x, y, w, h, 6 * view.zoom);
      g.fillStyle = `rgba(${hexToRgbTriplet(color)},0.22)`;
      g.fill();
      g.lineWidth = selected ? 2 : 1;
      g.strokeStyle = selected ? accentHex : `rgba(${hexToRgbTriplet(color)},0.55)`;
      g.stroke();
      // Titlebar strip (the draggable band).
      const titleH = Math.min(h, 22 * view.zoom);
      g.beginPath();
      g.roundRect(x, y, w, titleH, [6 * view.zoom, 6 * view.zoom, 0, 0]);
      g.fillStyle = `rgba(${hexToRgbTriplet(color)},0.5)`;
      g.fill();
      if (view.zoom > 0.35) {
        g.fillStyle = "rgba(235,240,247,0.85)";
        g.font = `${Math.max(9, 11 * view.zoom)}px Inter, system-ui, sans-serif`;
        g.textBaseline = "middle";
        g.fillText(typeof node.params.title === "string" ? node.params.title : "Backdrop", x + 8 * view.zoom, y + titleH / 2, w - 16 * view.zoom);
      }
      // Resize handle glyph (bottom-right corner).
      const handle = 10 * view.zoom;
      g.strokeStyle = "rgba(255,255,255,0.35)";
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(x + w - handle, y + h - 2);
      g.lineTo(x + w - 2, y + h - handle);
      g.moveTo(x + w - handle * 0.6, y + h - 2);
      g.lineTo(x + w - 2, y + h - handle * 0.6);
      g.stroke();
    }

    // Wires under nodes. The splice-target wire (node or palette drag hovering it) draws amber.
    const spliceHoverId = paletteHover?.edgeId ?? (gesture.kind === "moveNodes" ? gesture.hoverEdgeId : null);
    for (const edge of comp.edges) {
      const a = socketPos(edge.from.nodeId, edge.from.socket, "output");
      const b = socketPos(edge.to.nodeId, edge.to.socket, "input");
      if (!a || !b) continue;
      const [x0, y0, c0x, c0y, c1x, c1y, x1, y1] = wirePath(a[0], a[1], b[0], b[1]);
      const isSpliceTarget = edge.id === spliceHoverId;
      const isSelected = edge.id === selectedEdgeId;
      g.lineWidth = Math.max(1.25, (isSpliceTarget || isSelected ? 2.5 : 1.5) * view.zoom);
      g.strokeStyle = isSpliceTarget ? `rgba(${accentRgb},0.95)` : isSelected ? "rgba(120,190,255,0.95)" : "rgba(190,200,215,0.55)";
      g.beginPath();
      g.moveTo(x0, y0);
      g.bezierCurveTo(c0x, c0y, c1x, c1y, x1, y1);
      g.stroke();
    }
    // In-progress wire.
    if (gesture.kind === "wire") {
      const a = socketPos(gesture.from.nodeId, gesture.from.socket, gesture.from.kind);
      if (a) {
        const [x0, y0, c0x, c0y, c1x, c1y, x1, y1] = wirePath(a[0], a[1], gesture.toX, gesture.toY);
        g.strokeStyle = gesture.target ? "rgba(120,220,150,0.9)" : "rgba(190,200,215,0.8)";
        g.setLineDash([5, 4]);
        g.beginPath();
        g.moveTo(x0, y0);
        g.bezierCurveTo(c0x, c0y, c1x, c1y, x1, y1);
        g.stroke();
        g.setLineDash([]);
      }
    }

    // Nodes.
    for (const node of Object.values(comp.nodes)) {
      // Backdrop already got its own LOW-z-order pass above; skip its generic box here.
      if (node.type === "backdrop") continue;
      const def = getFlarexNodeDefinition(node.type);
      const pos = draftPos(node);
      const [x, y] = worldToScreen(view, pos.x, pos.y);
      const isReroute = node.type === "reroute";
      const w = nodeWidth(node) * view.zoom;
      const h = nodeHeight(node) * view.zoom;
      const selected = selectedNodeIds.includes(node.id);
      const accent = GROUP_COLORS[def.group] ?? "#8a8f98";
      // Reroute renders as a small dot — no body box, no label, no accent strip, no view dot.
      if (isReroute) {
        g.beginPath();
        g.arc(x + w / 2, y + h / 2, Math.max(3, (w / 2) * 0.9), 0, Math.PI * 2);
        g.fillStyle = node.enabled ? "rgba(138,143,152,0.9)" : "rgba(138,143,152,0.4)";
        g.fill();
        g.lineWidth = selected ? 2 : 1;
        g.strokeStyle = selected ? accentHex : "rgba(255,255,255,0.25)";
        g.stroke();
        for (const socket of nodeSockets(node)) {
          const [sxp, syp] = worldToScreen(view, socket.x + (pos.x - node.ui.x), socket.y + (pos.y - node.ui.y));
          const r = Math.max(2.5, SOCKET_R * view.zoom);
          g.beginPath();
          g.arc(sxp, syp, r, 0, Math.PI * 2);
          g.fillStyle = "#5fb2e6";
          g.fill();
          g.lineWidth = 1;
          g.strokeStyle = "rgba(10,12,16,0.8)";
          g.stroke();
        }
        continue;
      }
      g.beginPath();
      g.roundRect(x, y, w, h, 5 * view.zoom);
      g.fillStyle = node.enabled ? "rgba(38,42,50,0.96)" : "rgba(38,42,50,0.55)";
      g.fill();
      g.lineWidth = selected ? 2 : 1;
      g.strokeStyle = selected ? accentHex : "rgba(255,255,255,0.16)";
      g.stroke();
      // Group accent strip.
      g.fillStyle = accent;
      g.globalAlpha = node.enabled ? 0.9 : 0.4;
      g.fillRect(x, y, Math.max(2, 3 * view.zoom), h);
      g.globalAlpha = 1;
      // Label.
      if (view.zoom > 0.45) {
        g.fillStyle = node.enabled ? "rgba(235,240,247,0.92)" : "rgba(235,240,247,0.45)";
        g.font = `${Math.max(9, 11 * view.zoom)}px Inter, system-ui, sans-serif`;
        g.textBaseline = "middle";
        g.fillText(node.label ?? def.label, x + 9 * view.zoom, y + h / 2, w - 14 * view.zoom);
      }
      // Fusion view dot: this node's output is what the viewer shows (double-click toggles).
      if (comp.previewNodeId === node.id) {
        g.beginPath();
        g.arc(x + 10 * view.zoom, y + h - 7 * view.zoom, Math.max(2.5, 3.5 * view.zoom), 0, Math.PI * 2);
        g.fillStyle = accentHex;
        g.fill();
        g.lineWidth = 1;
        g.strokeStyle = "rgba(10,12,16,0.9)";
        g.stroke();
      }
      // Sockets. While dragging a wire, every type-compatible candidate (opposite kind, matching
      // socket type, not the source node) gets a low-alpha halo ring so the drop targets are
      // visible before the cursor is even over them — the direct hover target gets its own
      // brighter ring (drawn separately below).
      for (const socket of nodeSockets(node)) {
        const [sxp, syp] = worldToScreen(view, socket.x + (pos.x - node.ui.x), socket.y + (pos.y - node.ui.y));
        const r = Math.max(2.5, SOCKET_R * view.zoom);
        const isCandidate =
          gesture.kind === "wire" &&
          socket.kind !== gesture.from.kind &&
          socket.def.type === gesture.from.def.type &&
          socket.nodeId !== gesture.from.nodeId;
        const isDirectTarget = isCandidate && gesture.target?.nodeId === socket.nodeId && gesture.target?.socket === socket.socket;
        if (isCandidate && !isDirectTarget) {
          g.beginPath();
          g.arc(sxp, syp, r + 3.5 * view.zoom, 0, Math.PI * 2);
          g.strokeStyle = "rgba(120,220,150,0.35)";
          g.lineWidth = 1.5;
          g.stroke();
        }
        g.beginPath();
        g.arc(sxp, syp, r, 0, Math.PI * 2);
        g.fillStyle = socket.def.type === "matte" ? "#69c98a" : socket.def.type === "number" ? "#d5cf6d" : "#5fb2e6";
        g.fill();
        g.lineWidth = isDirectTarget ? 2 : 1;
        g.strokeStyle = isDirectTarget ? "rgba(120,220,150,0.95)" : "rgba(10,12,16,0.8)";
        g.stroke();
      }
    }

    // Palette-drag ghost (screen space): outline where the node will land.
    if (paletteHover && flarexPaletteDrag.current) {
      const def = getFlarexNodeDefinition(flarexPaletteDrag.current);
      const w = NODE_W * view.zoom;
      const h = 36 * view.zoom;
      const x = paletteHover.sx - w / 2;
      const y = paletteHover.sy - h / 2;
      g.beginPath();
      g.roundRect(x, y, w, h, 5 * view.zoom);
      g.fillStyle = `rgba(${accentRgb},0.10)`;
      g.fill();
      g.setLineDash([4, 3]);
      g.strokeStyle = `rgba(${accentRgb},0.8)`;
      g.lineWidth = 1;
      g.stroke();
      g.setLineDash([]);
      if (view.zoom > 0.45) {
        g.fillStyle = "rgba(235,240,247,0.7)";
        g.font = `${Math.max(9, 11 * view.zoom)}px Inter, system-ui, sans-serif`;
        g.textBaseline = "middle";
        g.fillText(def.label, x + 9 * view.zoom, y + h / 2, w - 14 * view.zoom);
      }
    }

    // Marquee (screen space, on top).
    if (gesture.kind === "marquee") {
      const x = Math.min(gesture.startX, gesture.curX);
      const y = Math.min(gesture.startY, gesture.curY);
      const w = Math.abs(gesture.curX - gesture.startX);
      const h = Math.abs(gesture.curY - gesture.startY);
      g.fillStyle = `rgba(${accentRgb},0.08)`;
      g.fillRect(x, y, w, h);
      g.strokeStyle = `rgba(${accentRgb},0.8)`;
      g.lineWidth = 1;
      g.setLineDash([4, 3]);
      g.strokeRect(x + 0.5, y + 0.5, w, h);
      g.setLineDash([]);
    }
  }, [comp, view, gesture, selectedNodeIds, size, paletteHover, selectedEdgeId, themeTick]);

  // ── Fit view (open + F key): the graph must NEVER open half-cut off-screen ──
  const fitView = () => {
    const { comp: c, size: s } = stateRef.current;
    const nodes = Object.values(c.nodes);
    if (nodes.length === 0 || s.w === 0 || s.h === 0) return;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const n of nodes) {
      x0 = Math.min(x0, n.ui.x);
      y0 = Math.min(y0, n.ui.y);
      x1 = Math.max(x1, n.ui.x + nodeWidth(n));
      y1 = Math.max(y1, n.ui.y + nodeHeight(n));
    }
    const pad = 60;
    const zoom = clampZoom(Math.min(s.w / (x1 - x0 + pad * 2), s.h / (y1 - y0 + pad * 2), 1));
    setView({ zoom, panX: (x0 + x1) / 2 - s.w / (2 * zoom), panY: (y0 + y1) / 2 - s.h / (2 * zoom) });
  };
  const fittedCompRef = useRef<string | null>(null);
  useEffect(() => {
    if (size.w === 0 || fittedCompRef.current === comp.id) return;
    fittedCompRef.current = comp.id;
    fitView();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [comp.id, size.w, size.h]);

  // "F" fits all nodes in view — scoped to when the canvas is hovered (mirrors the capture-phase
  // Delete handler's input-focus guard: never fire while typing in an inspector field).
  const hoveredRef = useRef(false);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "f" && event.key !== "F") return;
      if (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return; // Shift+F = page switch
      if (!hoveredRef.current) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      event.preventDefault();
      fitView();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // F1: Tab opens the add-node search menu anchored at the cursor (same hover/input guard as "F").
  // A single selected node auto-wires (Fusion "insert after selected") once a type is chosen.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      if (!hoveredRef.current) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      event.preventDefault();
      const { sx, sy } = lastPointerRef.current;
      const [wx, wy] = screenToWorld(stateRef.current.view, sx, sy);
      setNodeMenu({ sx, sy, wx, wy, query: "", activeIndex: 0 });
      setNodeContextMenu(null);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // F5.1: F2 (the universal OS rename shortcut — double-click stays the view-dot toggle, an
  // already-shipped gesture this round doesn't touch) starts inline rename on the ONE selected node.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "F2") return;
      if (!hoveredRef.current) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      const ids = stateRef.current.selectedNodeIds;
      if (ids.length !== 1) return;
      const node = stateRef.current.comp.nodes[ids[0]!];
      if (!node) return;
      event.preventDefault();
      setRenaming({ nodeId: node.id, draft: node.label ?? getFlarexNodeDefinition(node.type).label });
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // F5.3: "1" toggles solo/view on the ONE selected node (same target as the double-click view
  // dot — this is the keyboard path). Pressing it again on the same node clears back to MediaOut.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "1") return;
      if (!hoveredRef.current) return;
      if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      const ids = stateRef.current.selectedNodeIds;
      if (ids.length !== 1) return;
      const nodeId = ids[0]!;
      const node = stateRef.current.comp.nodes[nodeId];
      if (!node || node.type === "mediaOut") return;
      event.preventDefault();
      onUpdateComp((current) => ({ ...current, previewNodeId: current.previewNodeId === nodeId ? undefined : nodeId }));
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onUpdateComp]);

  // ── Gestures ────────────────────────────────────────────────────────────────
  const localPoint = (event: { clientX: number; clientY: number }): [number, number] => {
    const rect = canvasRef.current?.getBoundingClientRect();
    return rect ? [event.clientX - rect.left, event.clientY - rect.top] : [0, 0];
  };

  /** Node ids whose body rect touches the screen-space marquee rect. */
  const marqueeNodeIds = (m: { startX: number; startY: number; curX: number; curY: number }): string[] => {
    const { comp: c, view: v } = stateRef.current;
    const [wx0, wy0] = screenToWorld(v, Math.min(m.startX, m.curX), Math.min(m.startY, m.curY));
    const [wx1, wy1] = screenToWorld(v, Math.max(m.startX, m.curX), Math.max(m.startY, m.curY));
    return Object.values(c.nodes)
      .filter((n) => n.ui.x + nodeWidth(n) >= wx0 && n.ui.x <= wx1 && n.ui.y + nodeHeight(n) >= wy0 && n.ui.y <= wy1)
      .map((n) => n.id);
  };

  const onPointerDown = (event: React.PointerEvent) => {
    if (event.button !== 0 && event.button !== 1) return;
    const [sx, sy] = localPoint(event);
    const hit = hitTest(comp, view, sx, sy);
    (event.target as Element).setPointerCapture(event.pointerId);
    // Pan is EXPLICIT (middle-drag, or Alt+left-drag) — left button is selection (the Fusion model).
    if (event.button === 1 || event.altKey) {
      setGesture({ kind: "pan", startX: sx, startY: sy, panX: view.panX, panY: view.panY });
      return;
    }
    if (hit.kind === "background") {
      // A wire click SELECTS it (Delete removes it) — an edge click clears node selection and
      // vice versa. Only when no wire is under the cursor does the drag start a marquee.
      const edgeId = hitTestWire(comp, view, sx, sy);
      if (edgeId) {
        setSelectedEdgeId(edgeId);
        onSelectNodes([]);
        return;
      }
      setSelectedEdgeId(null);
      // Marquee box-select; a click (no drag) resolves to deselect on release. Shift = ADD the
      // touched nodes to the existing selection instead of replacing it.
      setGesture({ kind: "marquee", startX: sx, startY: sy, curX: sx, curY: sy, additive: event.shiftKey });
      return;
    }
    setSelectedEdgeId(null);
    if (hit.kind === "socket") {
      // A socket press is still an interaction with that node — select it (the socket hit zone
      // overlaps the node body's edges, so without this an edge click starts a wire and the node
      // never selects).
      onSelectNodes([hit.socket.nodeId]);
      setGesture({ kind: "wire", from: hit.socket, toX: sx, toY: sy, target: null });
      return;
    }
    if (hit.kind === "backdropResize") {
      const backdrop = comp.nodes[hit.nodeId];
      if (!backdrop) return;
      const { w, h } = backdropSize(backdrop);
      onSelectNodes([hit.nodeId]);
      setGesture({ kind: "backdropResize", nodeId: hit.nodeId, startX: sx, startY: sy, startW: w, startH: h, curW: w, curH: h });
      return;
    }
    const node = comp.nodes[hit.nodeId];
    if (!node) return;
    if (event.shiftKey || event.ctrlKey || event.metaKey) {
      // Toggle membership; no drag from a toggle click.
      onSelectNodes(
        selectedNodeIds.includes(hit.nodeId) ? selectedNodeIds.filter((id) => id !== hit.nodeId) : [...selectedNodeIds, hit.nodeId],
      );
      return;
    }
    // Dragging a node that is already part of a multi-selection moves the WHOLE selection;
    // otherwise the click re-selects just this node.
    const dragIds = selectedNodeIds.includes(hit.nodeId) ? selectedNodeIds : [hit.nodeId];
    if (!selectedNodeIds.includes(hit.nodeId)) onSelectNodes([hit.nodeId]);
    const [wx, wy] = screenToWorld(view, sx, sy);
    const start: Record<string, { x: number; y: number }> = {};
    for (const id of dragIds) {
      const n = comp.nodes[id];
      if (n) start[id] = { x: n.ui.x, y: n.ui.y };
    }
    setGesture({ kind: "moveNodes", grabWX: wx, grabWY: wy, start, positions: { ...start }, hoverEdgeId: null });
  };

  const onPointerMove = (event: React.PointerEvent) => {
    const [sx, sy] = localPoint(event);
    lastPointerRef.current = { sx, sy };
    const g = stateRef.current.gesture;
    if (g.kind === "none") return;
    if (g.kind === "pan") {
      setView((v) => ({ ...v, panX: g.panX - (sx - g.startX) / v.zoom, panY: g.panY - (sy - g.startY) / v.zoom }));
      return;
    }
    if (g.kind === "marquee") {
      setGesture({ ...g, curX: sx, curY: sy });
      return;
    }
    if (g.kind === "backdropResize") {
      const zoom = stateRef.current.view.zoom;
      const curW = Math.max(80, Math.round(g.startW + (sx - g.startX) / zoom));
      const curH = Math.max(60, Math.round(g.startH + (sy - g.startY) / zoom));
      setGesture({ ...g, curW, curH });
      return;
    }
    if (g.kind === "moveNodes") {
      const [wx, wy] = screenToWorld(stateRef.current.view, sx, sy);
      const dx = wx - g.grabWX;
      const dy = wy - g.grabWY;
      const positions: Record<string, { x: number; y: number }> = {};
      for (const [id, p] of Object.entries(g.start)) {
        positions[id] = { x: Math.round(p.x + dx), y: Math.round(p.y + dy) };
      }
      // Drop-on-wire (single node only): highlight the wire under the cursor IF it accepts this
      // node — the splice helper doubles as the validation predicate.
      const dragIds = Object.keys(g.start);
      let hoverEdgeId: string | null = null;
      if (dragIds.length === 1) {
        const edgeId = hitTestWire(stateRef.current.comp, stateRef.current.view, sx, sy);
        if (edgeId && spliceFlarexNodeIntoEdge(stateRef.current.comp, dragIds[0]!, edgeId)) hoverEdgeId = edgeId;
      }
      setGesture({ ...g, positions, hoverEdgeId });
      return;
    }
    if (g.kind === "wire") {
      const hit = hitTest(stateRef.current.comp, stateRef.current.view, sx, sy);
      let target: SocketRef | null = null;
      if (hit.kind === "socket" && hit.socket.kind !== g.from.kind && hit.socket.nodeId !== g.from.nodeId) {
        const output = g.from.kind === "output" ? g.from : hit.socket;
        const input = g.from.kind === "output" ? hit.socket : g.from;
        const candidate: FlarexEdge = {
          id: "candidate",
          from: { nodeId: output.nodeId, socket: output.socket },
          to: { nodeId: input.nodeId, socket: input.socket },
        };
        if (isValidFlarexEdge(stateRef.current.comp.nodes, candidate) && !wouldCreateFlarexCycle(stateRef.current.comp, output.nodeId, input.nodeId)) {
          target = hit.socket;
        }
      }
      setGesture({ ...g, toX: sx, toY: sy, target });
    }
  };

  const onPointerUp = () => {
    const g = stateRef.current.gesture;
    setGesture({ kind: "none" });
    if (g.kind === "marquee") {
      // A real drag selects everything the box touches; a plain click (tiny box) deselects.
      const dragged = Math.abs(g.curX - g.startX) > 3 || Math.abs(g.curY - g.startY) > 3;
      if (!dragged) {
        onSelectNodes([]);
        return;
      }
      const touched = marqueeNodeIds(g);
      // Shift = ADD to the existing selection instead of replacing it.
      onSelectNodes(g.additive ? Array.from(new Set([...stateRef.current.selectedNodeIds, ...touched])) : touched);
      return;
    }
    if (g.kind === "backdropResize") {
      if (g.curW !== g.startW || g.curH !== g.startH) {
        onUpdateComp((current) => {
          const node = current.nodes[g.nodeId];
          if (!node) return current;
          return { ...current, nodes: { ...current.nodes, [g.nodeId]: { ...node, params: { ...node.params, w: g.curW, h: g.curH } } } };
        });
      }
      return;
    }
    if (g.kind === "moveNodes") {
      const changed = Object.entries(g.positions).filter(([id, p]) => {
        const n = stateRef.current.comp.nodes[id];
        return n && (n.ui.x !== p.x || n.ui.y !== p.y);
      });
      const spliceNodeId = g.hoverEdgeId && Object.keys(g.start).length === 1 ? Object.keys(g.start)[0]! : null;
      if (changed.length > 0 || spliceNodeId) {
        onUpdateComp((current) => {
          const nodes = { ...current.nodes };
          for (const [id, p] of changed) {
            const n = nodes[id];
            if (n) nodes[id] = { ...n, ui: { x: p.x, y: p.y } };
          }
          const moved = { ...current, nodes };
          // Move + splice = ONE commit (one undo step); splice re-validates on the moved comp.
          if (spliceNodeId && g.hoverEdgeId) return spliceFlarexNodeIntoEdge(moved, spliceNodeId, g.hoverEdgeId) ?? moved;
          return moved;
        });
      }
      return;
    }
    if (g.kind === "wire" && g.target) {
      const output = g.from.kind === "output" ? g.from : g.target;
      const input = g.from.kind === "output" ? g.target : g.from;
      onUpdateComp((current) => {
        const edge: FlarexEdge = {
          id: `e_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
          from: { nodeId: output.nodeId, socket: output.socket },
          to: { nodeId: input.nodeId, socket: input.socket },
        };
        if (!isValidFlarexEdge(current.nodes, edge) || wouldCreateFlarexCycle(current, edge.from.nodeId, edge.to.nodeId)) return current;
        // An input socket holds ONE wire — replace any existing one.
        const edges = current.edges.filter((e) => !(e.to.nodeId === edge.to.nodeId && e.to.socket === edge.to.socket));
        return { ...current, edges: [...edges, edge] };
      });
    }
  };

  // Double-click a node = toggle the Fusion "view dot" (the compiler re-roots the viewer there).
  const onDoubleClick = (event: React.MouseEvent) => {
    const [sx, sy] = localPoint(event);
    const hit = hitTest(stateRef.current.comp, stateRef.current.view, sx, sy);
    if (hit.kind !== "node") return;
    const node = stateRef.current.comp.nodes[hit.nodeId];
    if (!node || node.type === "mediaOut") return;
    onUpdateComp((current) => ({
      ...current,
      previewNodeId: current.previewNodeId === hit.nodeId ? undefined : hit.nodeId,
    }));
  };

  const onWheel = (event: React.WheelEvent) => {
    const [sx, sy] = localPoint(event);
    setView((v) => zoomAt(v, sx, sy, Math.exp(-event.deltaY * 0.0015)));
  };

  // F1: right-click empty canvas opens the add-node search menu; right-click ON a node opens the
  // minimal node context menu (Rename/Enable-Disable/Delete/View).
  const onContextMenu = (event: React.MouseEvent) => {
    event.preventDefault();
    const [sx, sy] = localPoint(event);
    const hit = hitTest(stateRef.current.comp, stateRef.current.view, sx, sy);
    if (hit.kind === "node" || hit.kind === "backdropResize") {
      setNodeContextMenu({ sx, sy, nodeId: hit.nodeId });
      setNodeMenu(null);
      return;
    }
    if (hit.kind === "socket") return;
    const [wx, wy] = screenToWorld(stateRef.current.view, sx, sy);
    setNodeMenu({ sx, sy, wx, wy, query: "", activeIndex: 0 });
    setNodeContextMenu(null);
  };

  // F1: fuzzy-filter the addable node types by label/group; empty query floats the last-used type
  // to the top (F6.3) so re-adding the same thing repeatedly needs no typing at all.
  const nodeMenuItems = useMemo(() => {
    if (!nodeMenu) return [];
    const q = nodeMenu.query.trim().toLowerCase();
    const defs = flarexAddableNodeTypes.map((t) => getFlarexNodeDefinition(t));
    const filtered = q ? defs.filter((d) => `${d.label} ${d.group}`.toLowerCase().includes(q)) : defs.slice();
    if (!q && lastUsedNodeType.current) {
      const idx = filtered.findIndex((d) => d.type === lastUsedNodeType.current);
      if (idx > 0) {
        const [item] = filtered.splice(idx, 1);
        filtered.unshift(item!);
      }
    }
    return filtered;
  }, [nodeMenu]);

  /** Insert the chosen type at the menu's world position. If exactly one node is selected, auto-
   *  wire its first compatible output into the new node's first compatible input (Fusion "insert
   *  after selected") — skipped silently when no socket types match. ONE commit. */
  const insertNodeFromMenu = (type: FlarexNodeType) => {
    const menu = nodeMenu;
    if (!menu) return;
    const selected = stateRef.current.selectedNodeIds;
    const id = `n_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    onUpdateComp((current) => {
      const node = createFlarexNode(type, id, Math.round(menu.wx - NODE_W / 2), Math.round(menu.wy - 18));
      let next: FlarexComp = { ...current, nodes: { ...current.nodes, [id]: node } };
      if (selected.length === 1) {
        const source = current.nodes[selected[0]!];
        if (source) {
          const sourceDef = getFlarexNodeDefinition(source.type);
          const newDef = getFlarexNodeDefinition(type);
          for (const output of sourceDef.outputs) {
            const input = newDef.inputs.find((inSocket) => inSocket.type === output.type);
            if (!input) continue;
            const edge: FlarexEdge = {
              id: `e_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
              from: { nodeId: source.id, socket: output.id },
              to: { nodeId: id, socket: input.id },
            };
            if (isValidFlarexEdge(next.nodes, edge) && !wouldCreateFlarexCycle(next, source.id, id)) {
              next = { ...next, edges: [...next.edges, edge] };
              break;
            }
          }
        }
      }
      return next;
    });
    onSelectNodes([id]);
    lastUsedNodeType.current = type;
    setNodeMenu(null);
  };

  const commitRename = () => {
    const r = renaming;
    setRenaming(null);
    if (!r) return;
    onUpdateComp((current) => {
      const node = current.nodes[r.nodeId];
      if (!node) return current;
      const trimmed = r.draft.trim();
      const def = getFlarexNodeDefinition(node.type);
      return { ...current, nodes: { ...current.nodes, [r.nodeId]: { ...node, label: trimmed && trimmed !== def.label ? trimmed : undefined } } };
    });
  };

  // ── Palette drag-and-drop (toolbar → canvas; drop on a wire splices into it) ─
  const onDragOver = (event: React.DragEvent) => {
    const type = flarexPaletteDrag.current;
    if (!type) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    const [sx, sy] = localPoint(event);
    const { comp: c, view: v } = stateRef.current;
    // Would the wire under the cursor accept this node type? Trial-splice with a phantom node.
    let edgeId = hitTestWire(c, v, sx, sy);
    if (edgeId) {
      const phantom = { ...c, nodes: { ...c.nodes, __dragPhantom: createFlarexNode(type, "__dragPhantom", 0, 0) } };
      if (!spliceFlarexNodeIntoEdge(phantom, "__dragPhantom", edgeId)) edgeId = null;
    }
    setPaletteHover({ sx, sy, edgeId });
  };

  const onDragLeave = () => setPaletteHover(null);

  const onDrop = (event: React.DragEvent) => {
    const type = flarexPaletteDrag.current;
    setPaletteHover(null);
    if (!type) return;
    event.preventDefault();
    const [sx, sy] = localPoint(event);
    const { comp: c, view: v } = stateRef.current;
    const [wx, wy] = screenToWorld(v, sx, sy);
    const id = `n_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const edgeId = hitTestWire(c, v, sx, sy);
    onUpdateComp((current) => {
      const node = createFlarexNode(type, id, Math.round(wx - NODE_W / 2), Math.round(wy - 18));
      const withNode: FlarexComp = { ...current, nodes: { ...current.nodes, [id]: node } };
      if (edgeId) return spliceFlarexNodeIntoEdge(withNode, id, edgeId) ?? withNode;
      return withNode;
    });
    onSelectNodes([id]);
  };

  // Clipboard is comp-scoped: switching to a different clip's comp drops any pending copy.
  useEffect(() => {
    if (flarexClipboard.current && flarexClipboard.current.compId !== comp.id) {
      flarexClipboard.current = null;
    }
  }, [comp.id]);

  /** Selected nodes (minus MediaIn/Out) + the edges wholly BETWEEN them — the copy snapshot. */
  const buildClipboardSnapshot = (): { compId: string; nodes: FlarexNode[]; edges: FlarexEdge[] } | null => {
    const { comp: c, selectedNodeIds: ids } = stateRef.current;
    const copyIds = ids.filter((id) => {
      const n = c.nodes[id];
      return n && n.type !== "mediaIn" && n.type !== "mediaOut";
    });
    if (copyIds.length === 0) return null;
    const idSet = new Set(copyIds);
    const nodes = copyIds.map((id) => c.nodes[id]!);
    const edges = c.edges.filter((e) => idSet.has(e.from.nodeId) && idSet.has(e.to.nodeId));
    return { compId: c.id, nodes, edges };
  };

  /** Paste is ONE `onUpdateComp` commit; fresh ids + +24/+24 offset via `cloneFlarexNodes`, new
   *  selection = the pasted nodes. */
  const pasteSnapshot = (snapshot: { compId: string; nodes: FlarexNode[]; edges: FlarexEdge[] }) => {
    if (snapshot.compId !== stateRef.current.comp.id) return; // comp changed since copy — no cross-comp paste (v1)
    const prefix = `n_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 5)}`;
    const { nodes: newNodes, edges: newEdges } = cloneFlarexNodes(snapshot.nodes, snapshot.edges, prefix);
    if (newNodes.length === 0) return;
    onUpdateComp((current) => ({
      ...current,
      nodes: { ...current.nodes, ...Object.fromEntries(newNodes.map((n) => [n.id, n])) },
      edges: [...current.edges, ...newEdges],
    }));
    onSelectNodes(newNodes.map((n) => n.id));
  };

  // Copy / paste / duplicate / pass-through toggle — Ctrl (Cmd on Mac) + C / V / D / P.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const isMac = navigator.platform.toLowerCase().includes("mac");
      if ((isMac && !event.metaKey) || (!isMac && !event.ctrlKey)) return;
      const key = event.key.toLowerCase();
      if (key !== "c" && key !== "v" && key !== "d" && key !== "p") return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      if (key === "c") {
        const snapshot = buildClipboardSnapshot();
        if (!snapshot) return;
        event.preventDefault();
        flarexClipboard.current = snapshot;
        return;
      }
      if (key === "v") {
        if (!flarexClipboard.current) return;
        event.preventDefault();
        pasteSnapshot(flarexClipboard.current);
        return;
      }
      if (key === "p") {
        // Fusion Ctrl+P: toggle enabled/pass-through on every selected node (guard MediaIn/Out —
        // the graph's fixed endpoints, same guard Delete uses).
        const ids = stateRef.current.selectedNodeIds.filter((id) => {
          const n = stateRef.current.comp.nodes[id];
          return n && n.type !== "mediaIn" && n.type !== "mediaOut";
        });
        if (ids.length === 0) return;
        event.preventDefault();
        onUpdateComp((current) => {
          const nodes = { ...current.nodes };
          for (const id of ids) {
            const n = nodes[id];
            if (n) nodes[id] = { ...n, enabled: !n.enabled };
          }
          return { ...current, nodes };
        });
        return;
      }
      // Ctrl+D: copy + paste in one step, independent of whatever's on the clipboard.
      const snapshot = buildClipboardSnapshot();
      if (!snapshot) return;
      event.preventDefault();
      pasteSnapshot(snapshot);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onSelectNodes, onUpdateComp]);

  // Delete the selection (guard MediaIn/Out — the graph's fixed endpoints).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Delete" && event.key !== "Backspace") return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      const ids = stateRef.current.selectedNodeIds.filter((id) => {
        const node = stateRef.current.comp.nodes[id];
        return node && node.type !== "mediaIn" && node.type !== "mediaOut";
      });
      const edgeId = stateRef.current.selectedEdgeId;
      if (ids.length === 0 && !edgeId) return;
      event.preventDefault();
      event.stopPropagation();
      onSelectNodes([]);
      setSelectedEdgeId(null);
      onUpdateComp((current) => {
        const nodes = { ...current.nodes };
        for (const id of ids) delete nodes[id];
        return {
          ...current,
          nodes,
          edges: current.edges.filter((e) => !ids.includes(e.from.nodeId) && !ids.includes(e.to.nodeId) && e.id !== edgeId),
        };
      });
    };
    // Capture phase so the editor's global Delete-clip handler never sees it while Flarex is up.
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onSelectNodes, onUpdateComp]);

  const cursor = useMemo(() => {
    if (gesture.kind === "pan") return "grabbing";
    if (gesture.kind === "moveNodes") return "move";
    if (gesture.kind === "wire") return "crosshair";
    if (gesture.kind === "marquee") return "crosshair";
    if (gesture.kind === "backdropResize") return "nwse-resize";
    return "default";
  }, [gesture.kind]);

  const renamingNode = renaming ? comp.nodes[renaming.nodeId] : undefined;
  const renameRect = renamingNode
    ? (() => {
        const [x, y] = worldToScreen(view, renamingNode.ui.x, renamingNode.ui.y);
        return { x, y, w: Math.max(80, nodeWidth(renamingNode) * view.zoom), h: nodeHeight(renamingNode) * view.zoom };
      })()
    : null;
  const contextMenuNode = nodeContextMenu ? comp.nodes[nodeContextMenu.nodeId] : undefined;

  return (
    <div ref={wrapRef} className="flarex-canvas-wrap">
      <canvas
        ref={canvasRef}
        className="flarex-canvas"
        style={{ width: "100%", height: "100%", cursor }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={onDoubleClick}
        onWheel={onWheel}
        onContextMenu={onContextMenu}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        onPointerEnter={() => {
          hoveredRef.current = true;
        }}
        onPointerLeave={() => {
          hoveredRef.current = false;
        }}
      />
      {/* Click-away backdrop for both popup menus. */}
      {nodeMenu || nodeContextMenu ? (
        <div
          className="flarex-menu-backdrop"
          onPointerDown={() => {
            setNodeMenu(null);
            setNodeContextMenu(null);
          }}
        />
      ) : null}
      {/* F1: add-node search menu. */}
      {nodeMenu ? (
        <div className="flarex-node-menu" style={{ left: nodeMenu.sx, top: nodeMenu.sy }}>
          <input
            className="flarex-node-menu-input"
            autoFocus
            placeholder="Add node…"
            value={nodeMenu.query}
            onChange={(e) => setNodeMenu((m) => (m ? { ...m, query: e.target.value, activeIndex: 0 } : m))}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.stopPropagation();
                setNodeMenu(null);
                return;
              }
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setNodeMenu((m) => (m ? { ...m, activeIndex: Math.min(nodeMenuItems.length - 1, m.activeIndex + 1) } : m));
                return;
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setNodeMenu((m) => (m ? { ...m, activeIndex: Math.max(0, m.activeIndex - 1) } : m));
                return;
              }
              if (e.key === "Enter") {
                e.preventDefault();
                const item = nodeMenuItems[nodeMenu.activeIndex];
                if (item) insertNodeFromMenu(item.type);
              }
            }}
          />
          <div className="flarex-node-menu-list">
            {nodeMenuItems.length === 0 ? <div className="flarex-node-menu-empty">No matches</div> : null}
            {nodeMenuItems.map((def, index) => (
              <button
                key={def.type}
                type="button"
                className={`flarex-node-menu-item${index === nodeMenu.activeIndex ? " is-active" : ""}`}
                style={{ borderLeft: `3px solid ${GROUP_COLORS[def.group] ?? "#8a8f98"}` }}
                onPointerDown={(e) => e.preventDefault()}
                onClick={() => insertNodeFromMenu(def.type)}
              >
                <span>{def.label}</span>
                <span className="flarex-node-menu-group">{def.group}</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}
      {/* F1.3: minimal node context menu. */}
      {nodeContextMenu && contextMenuNode ? (
        <div className="flarex-node-menu flarex-node-context-menu" style={{ left: nodeContextMenu.sx, top: nodeContextMenu.sy }}>
          <button
            type="button"
            onClick={() => {
              setRenaming({ nodeId: contextMenuNode.id, draft: contextMenuNode.label ?? getFlarexNodeDefinition(contextMenuNode.type).label });
              setNodeContextMenu(null);
            }}
          >
            Rename
          </button>
          {contextMenuNode.type !== "mediaIn" && contextMenuNode.type !== "mediaOut" ? (
            <button
              type="button"
              onClick={() => {
                // F6.3: wires straight into the existing Ctrl+C/V clipboard — a single-node snapshot
                // (no internal edges to preserve; unlike Ctrl+C this doesn't depend on selection state).
                flarexClipboard.current = { compId: stateRef.current.comp.id, nodes: [contextMenuNode], edges: [] };
                onSelectNodes([contextMenuNode.id]);
                setNodeContextMenu(null);
              }}
            >
              Copy
            </button>
          ) : null}
          {contextMenuNode.type !== "mediaIn" && contextMenuNode.type !== "mediaOut" ? (
            <button
              type="button"
              onClick={() => {
                const id = contextMenuNode.id;
                onUpdateComp((current) => {
                  const node = current.nodes[id];
                  if (!node) return current;
                  return { ...current, nodes: { ...current.nodes, [id]: { ...node, enabled: !node.enabled } } };
                });
                setNodeContextMenu(null);
              }}
            >
              {contextMenuNode.enabled ? "Disable" : "Enable"}
            </button>
          ) : null}
          {contextMenuNode.type !== "mediaOut" ? (
            <button
              type="button"
              onClick={() => {
                const id = contextMenuNode.id;
                onUpdateComp((current) => ({ ...current, previewNodeId: current.previewNodeId === id ? undefined : id }));
                setNodeContextMenu(null);
              }}
            >
              {comp.previewNodeId === contextMenuNode.id ? "Clear view" : "View"}
            </button>
          ) : null}
          {contextMenuNode.type !== "mediaIn" && contextMenuNode.type !== "mediaOut" ? (
            <button
              type="button"
              onClick={() => {
                const id = contextMenuNode.id;
                onSelectNodes([]);
                onUpdateComp((current) => ({
                  ...current,
                  nodes: Object.fromEntries(Object.entries(current.nodes).filter(([nid]) => nid !== id)),
                  edges: current.edges.filter((e) => e.from.nodeId !== id && e.to.nodeId !== id),
                }));
                setNodeContextMenu(null);
              }}
            >
              Delete
            </button>
          ) : null}
        </div>
      ) : null}
      {/* F5.1: inline rename. */}
      {renaming && renameRect ? (
        <input
          key={renaming.nodeId}
          className="flarex-node-rename-input"
          style={{ left: renameRect.x, top: renameRect.y, width: renameRect.w, height: renameRect.h }}
          autoFocus
          value={renaming.draft}
          onChange={(e) => setRenaming((r) => (r ? { ...r, draft: e.target.value } : r))}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            else if (e.key === "Escape") {
              e.stopPropagation();
              setRenaming(null);
            }
          }}
        />
      ) : null}
    </div>
  );
}

/** Drop-in helper for the toolbar: place a new node just right of the rightmost non-output node. */
export function nextNodePosition(comp: FlarexComp): { x: number; y: number } {
  let maxX = 0;
  let y = 0;
  for (const node of Object.values(comp.nodes)) {
    if (node.type === "mediaOut") continue;
    if (node.ui.x >= maxX) {
      maxX = node.ui.x;
      y = node.ui.y;
    }
  }
  return { x: maxX + NODE_W + 48, y };
}

export type { FlarexNode };
