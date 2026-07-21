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
  clampZoom,
  hitTest,
  hitTestWire,
  nodeHeight,
  nodeSockets,
  screenToWorld,
  wirePath,
  worldToScreen,
  zoomAt,
  type FlarexViewState,
  type SocketRef,
} from "./flarex-canvas-model";

/** Same-window palette drag payload (HTML5 dataTransfer hides its data until drop — this ref is
 *  what lets the canvas validate + highlight the target wire DURING the hover). The toolbar sets
 *  it on dragstart and clears it on dragend. */
export const flarexPaletteDrag: { current: FlarexNodeType | null } = { current: null };

const GROUP_COLORS: Record<string, string> = {
  io: "#8a8f98",
  composite: "#e8b04b",
  color: "#5fb2e6",
  filter: "#b58fe0",
  mask: "#69c98a",
  generator: "#e0708a",
  tracking: "#d5cf6d",
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
  | { kind: "marquee"; startX: number; startY: number; curX: number; curY: number }
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
  | { kind: "wire"; from: SocketRef; toX: number; toY: number; target: SocketRef | null };

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

    const socketPos = (nodeId: string, socketId: string, kind: "input" | "output"): [number, number] | null => {
      const node = comp.nodes[nodeId];
      if (!node) return null;
      const ref = nodeSockets(node).find((s) => s.socket === socketId && s.kind === kind);
      if (!ref) return null;
      // Live-move preview: dragged nodes' sockets follow the draft positions.
      const pos = draftPos(node);
      return worldToScreen(view, ref.x + (pos.x - node.ui.x), ref.y + (pos.y - node.ui.y));
    };

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
      g.strokeStyle = isSpliceTarget ? "rgba(232,176,75,0.95)" : isSelected ? "rgba(120,190,255,0.95)" : "rgba(190,200,215,0.55)";
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
      const def = getFlarexNodeDefinition(node.type);
      const pos = draftPos(node);
      const [x, y] = worldToScreen(view, pos.x, pos.y);
      const w = NODE_W * view.zoom;
      const h = nodeHeight(node) * view.zoom;
      const selected = selectedNodeIds.includes(node.id);
      const accent = GROUP_COLORS[def.group] ?? "#8a8f98";
      g.beginPath();
      g.roundRect(x, y, w, h, 5 * view.zoom);
      g.fillStyle = node.enabled ? "rgba(38,42,50,0.96)" : "rgba(38,42,50,0.55)";
      g.fill();
      g.lineWidth = selected ? 2 : 1;
      g.strokeStyle = selected ? "#e8b04b" : "rgba(255,255,255,0.16)";
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
        g.fillStyle = "#e8b04b";
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
      g.fillStyle = "rgba(232,176,75,0.10)";
      g.fill();
      g.setLineDash([4, 3]);
      g.strokeStyle = "rgba(232,176,75,0.8)";
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
      g.fillStyle = "rgba(232,176,75,0.08)";
      g.fillRect(x, y, w, h);
      g.strokeStyle = "rgba(232,176,75,0.8)";
      g.lineWidth = 1;
      g.setLineDash([4, 3]);
      g.strokeRect(x + 0.5, y + 0.5, w, h);
      g.setLineDash([]);
    }
  }, [comp, view, gesture, selectedNodeIds, size, paletteHover, selectedEdgeId]);

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
      x1 = Math.max(x1, n.ui.x + NODE_W);
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
      .filter((n) => n.ui.x + NODE_W >= wx0 && n.ui.x <= wx1 && n.ui.y + nodeHeight(n) >= wy0 && n.ui.y <= wy1)
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
      // Marquee box-select; a click (no drag) resolves to deselect on release.
      setGesture({ kind: "marquee", startX: sx, startY: sy, curX: sx, curY: sy });
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
    const g = stateRef.current.gesture;
    if (g.kind === "none") return;
    const [sx, sy] = localPoint(event);
    if (g.kind === "pan") {
      setView((v) => ({ ...v, panX: g.panX - (sx - g.startX) / v.zoom, panY: g.panY - (sy - g.startY) / v.zoom }));
      return;
    }
    if (g.kind === "marquee") {
      setGesture({ ...g, curX: sx, curY: sy });
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
      onSelectNodes(dragged ? marqueeNodeIds(g) : []);
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
    return "default";
  }, [gesture.kind]);

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
