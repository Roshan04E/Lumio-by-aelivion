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
  type FlarexSocketType,
} from "@orreris/shared";
import {
  GROUP_TITLEBAR_H,
  NODE_BEZEL,
  NODE_FOOTER_H,
  NODE_LABEL_GAP,
  NODE_THUMB_H,
  NODE_W,
  placeAfterNode,
  SOCKET_R,
  backdropSize,
  clampZoom,
  cloneFlarexNodes,
  collapsedMemberOwners,
  expandGroupDragSet,
  groupIsCollapsed,
  groupMembers,
  groupRect,
  hitTest,
  hitTestWire,
  flarexNodeIndices,
  flarexNodeThumbnailsEnabled,
  nodeHasThumbnail,
  nodeHeight,
  nodeWidth,
  nodeSockets,
  nodeThumbRect,
  screenToWorld,
  setFlarexNodeThumbnails,
  socketAnchor,
  wirePath,
  worldToScreen,
  zoomAt,
  type FlarexViewState,
  type SocketRef,
} from "./flarex-canvas-model";
import { FlarexNodeBrowser } from "./FlarexNodeBrowser";
import { clearFlarexThumbnails, getFlarexThumbnail, requestFlarexThumbnails } from "./flarex-node-thumbnails";
import type { SceneViewerCaptureHandle } from "../../components/ScenePreviewCanvas";

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

/** "#rrggbb" / "#rgb" → "r,g,b" for rgba() template strings; non-hex values fall back to a neutral
 *  text tone so a malformed theme var can never produce an invalid canvas color. */
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
  return "142,150,166"; // --nle-text-muted fallback (never the old amber default)
}

/**
 * The Node Editor canvas is the ONE surface that can't consume CSS custom properties directly
 * (Canvas2D takes literal color strings), so it reads the application's design tokens off the DOM
 * once per draw and paints from THOSE — it stays a consumer of the single theme/accent source rather
 * than defining its own palette. Every value here traces to a `--nle-*` token; there are no literal
 * UI colors and no per-category color palette (selection/interaction is accent-only).
 */
interface CanvasPalette {
  accent: string;
  accentRgb: string;
  text: string;
  textRgb: string;
  mutedRgb: string;
  dimRgb: string;
  borderRgb: string;
  panelRgb: string;
  bgRgb: string;
}

/**
 * How a socket of each DATA TYPE is drawn. Every socket is the app ACCENT — the node editor is a
 * consumer of the one accent/theme source, so nothing here may hard-code a hue (the old
 * `--flarex-socket-*` blue/green/amber scheme stayed fixed through every theme change, which is what
 * made the graph look off-brand).
 *
 * The type is carried by TREATMENT instead of hue, which survives theming and stays legible at low
 * zoom: image (the picture path, and the common case) is a solid disc; matte is a hollow ring; number
 * is a small solid dot. Same circular geometry throughout.
 */
const SOCKET_STYLE: Record<FlarexSocketType, { fill: number; radius: number; hollow: boolean }> = {
  image: { fill: 1, radius: 1, hollow: false },
  matte: { fill: 0.9, radius: 1, hollow: true },
  number: { fill: 0.85, radius: 0.66, hollow: false },
};
function resolveCanvasPalette(el: Element): CanvasPalette {
  const cs = getComputedStyle(el);
  const v = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
  const accent = v("--nle-accent", "#4f9cff");
  return {
    accent,
    accentRgb: hexToRgbTriplet(accent),
    text: v("--nle-text", "#d7dce5"),
    textRgb: hexToRgbTriplet(v("--nle-text", "#d7dce5")),
    mutedRgb: hexToRgbTriplet(v("--nle-text-muted", "#8e96a6")),
    dimRgb: hexToRgbTriplet(v("--nle-text-dim", "#626b7a")),
    borderRgb: hexToRgbTriplet(v("--nle-border", "#262b35")),
    panelRgb: hexToRgbTriplet(v("--nle-panel-2", "#1a1f29")),
    bgRgb: hexToRgbTriplet(v("--nle-bg", "#0b0d10")),
  };
}

/** Group accent colors — also used by the toolbar palette buttons (left border strip, N6) so the
 *  canvas and palette read as one system. */
export interface FlarexNodeCanvasProps {
  comp: FlarexComp;
  selectedNodeIds: string[];
  onSelectNodes: (nodeIds: string[]) => void;
  /** ONE call per finished gesture (move/connect/delete) — the caller stamps + persists. */
  onUpdateComp: (updater: (comp: FlarexComp) => FlarexComp) => void;
  /** Media-pool assets (id → name) so an asset dragged from the bin onto the canvas creates a MediaIn
   *  node loading it (asset-source MediaIn, FLAREX.md Phase 2), labeled with the asset name. */
  sourceAssets?: Array<{ id: string; name: string }>;
  /**
   * Node thumbnails (Slice 6). All four are needed for a thumbnail pass; ANY of them missing (no
   * capture handle, no host clip, mode off) simply means nodes render at their classic size with no
   * picture and no work scheduled — the feature is entirely additive.
   */
  thumbnails?: boolean;
  /** The viewer's capture handle — thumbnails render through the preview's own compositor. */
  thumbnailCapture?: React.MutableRefObject<SceneViewerCaptureHandle | null> | undefined;
  /** The clip carrying this comp, and the playhead in comp-local seconds (part of the cache key). */
  hostLayerId?: string | undefined;
  compTime?: number;
  /** Transport state — a hard gate on scheduling: playback must never contend for the compositor. */
  isPlaying?: boolean;
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

export function FlarexNodeCanvas({
  comp,
  selectedNodeIds,
  onSelectNodes,
  onUpdateComp,
  sourceAssets,
  thumbnails = false,
  thumbnailCapture,
  hostLayerId,
  compTime = 0,
  isPlaying = false,
}: FlarexNodeCanvasProps) {
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

  /** Bumped when a thumbnail lands, to repaint the nodes that now have a picture. */
  const [thumbTick, setThumbTick] = useState(0);

  // The thumbnail view mode is module-scoped in the canvas model (see `setFlarexNodeThumbnails`) so a
  // node's height, sockets, hit box and group box can never disagree about it. Writing it during render
  // — not in an effect — is what guarantees the geometry is already consistent by the time this frame's
  // draw pass and pointer handlers read it. Idempotent and derived purely from the prop.
  setFlarexNodeThumbnails(thumbnails);

  // A different comp's cached pictures are dead weight (and its node ids may collide conceptually with
  // what the user is now looking at). Thumbnails are pure derived data, so dropping them is always safe.
  useEffect(() => {
    clearFlarexThumbnails();
  }, [comp.id]);

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

    // Resolve the application's theme tokens once per draw (the Theme selector swaps --nle-accent and
    // friends per theme). Everything below paints from `pal` — one accent source, no literal colors.
    const pal = resolveCanvasPalette(canvas);
    const accentHex = pal.accent;
    const accentRgb = pal.accentRgb;

    // World-locked line grid — very subtle minor lines with slightly firmer major lines every 5th.
    const step = 28 * view.zoom;
    if (step > 6) {
      const gridPass = (spacing: number, alpha: number) => {
        const ox = ((-view.panX * view.zoom) % spacing + spacing) % spacing;
        const oy = ((-view.panY * view.zoom) % spacing + spacing) % spacing;
        g.strokeStyle = `rgba(${pal.textRgb},${alpha})`;
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

    // Members of a COLLAPSED group are off-screen; their wires re-anchor onto the group's box.
    const collapsedOwners = collapsedMemberOwners(comp);
    const isHidden = (node: FlarexNode): boolean => collapsedOwners.has(node.id);

    /** One socket disc. Accent-toned always; the DATA TYPE is the treatment (see SOCKET_STYLE), so a
     *  theme change re-tints the whole graph and nothing here is a fixed hue. */
    const drawSocket = (sxp: number, syp: number, type: FlarexSocketType, isTarget: boolean, enabled: boolean): void => {
      const style = SOCKET_STYLE[type];
      const r = Math.max(2.5, SOCKET_R * view.zoom) * style.radius;
      const alpha = (isTarget ? 1 : style.fill) * (enabled ? 1 : 0.45);
      g.beginPath();
      g.arc(sxp, syp, r, 0, Math.PI * 2);
      if (style.hollow && !isTarget) {
        // Filled with the canvas background first, so a wire routed underneath doesn't show through
        // the middle of the ring and read as a third socket state.
        g.fillStyle = `rgba(${pal.bgRgb},1)`;
        g.fill();
        g.lineWidth = Math.max(1.5, 2 * view.zoom);
        g.strokeStyle = `rgba(${accentRgb},${alpha})`;
        g.stroke();
        return;
      }
      g.fillStyle = `rgba(${accentRgb},${alpha})`;
      g.fill();
      g.lineWidth = isTarget ? 2 : 1;
      g.strokeStyle = isTarget ? `rgba(${accentRgb},0.95)` : `rgba(${pal.bgRgb},0.85)`;
      g.stroke();
    };

    // Footer data, computed ONCE per draw rather than per node (both are whole-comp scans).
    const nodeIndices = flarexNodeIndices(comp);
    const nodeAnimated = new Set(
      comp.animations.filter((kf) => kf.target.scope === "flarexNode" && kf.target.effectId).map((kf) => kf.target.effectId as string),
    );

    const socketScreen = (
      nodeId: string,
      socketId: string,
      kind: "input" | "output",
    ): { x: number; y: number; dir: 1 | -1; type: FlarexSocketType } | null => {
      // `socketAnchor` applies the auto left/right flip, the live-move draft position, AND the
      // collapsed-group re-anchor in one place, so wires and hit-testing can never disagree.
      const ref = socketAnchor(comp, collapsedOwners, nodeId, socketId, kind, draftPos);
      if (!ref) return null;
      const [x, y] = worldToScreen(view, ref.x, ref.y);
      return { x, y, dir: ref.dir, type: ref.def.type };
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
        g.fillStyle = `rgba(${pal.textRgb},0.85)`;
        g.font = `${Math.max(9, 11 * view.zoom)}px Inter, system-ui, sans-serif`;
        g.textBaseline = "middle";
        g.fillText(typeof node.params.title === "string" ? node.params.title : "Backdrop", x + 8 * view.zoom, y + titleH / 2, w - 16 * view.zoom);
      }
      // Resize handle glyph (bottom-right corner).
      const handle = 10 * view.zoom;
      g.strokeStyle = `rgba(${pal.mutedRgb},0.6)`;
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(x + w - handle, y + h - 2);
      g.lineTo(x + w - 2, y + h - handle);
      g.moveTo(x + w - handle * 0.6, y + h - 2);
      g.lineTo(x + w - 2, y + h - handle * 0.6);
      g.stroke();
    }

    // Groups: same LOW z-order as backdrops (behind wires and nodes). An expanded group draws as a
    // frame auto-fitted around its members; a collapsed one as a title chip with a member count, since
    // its contents are hidden. Neutral chrome — accent is reserved for selection.
    for (const node of Object.values(comp.nodes)) {
      if (node.type !== "group") continue;
      const rect = groupRect(comp, node, draftPos);
      const [x, y] = worldToScreen(view, rect.x, rect.y);
      const w = rect.w * view.zoom;
      const h = rect.h * view.zoom;
      const selected = selectedNodeIds.includes(node.id);
      const collapsed = groupIsCollapsed(node);
      const titleH = Math.min(h, GROUP_TITLEBAR_H * view.zoom);
      g.beginPath();
      g.roundRect(x, y, w, h, 7 * view.zoom);
      g.fillStyle = `rgba(${pal.mutedRgb},0.10)`;
      g.fill();
      g.lineWidth = selected ? 2 : 1;
      g.strokeStyle = selected ? accentHex : `rgba(${pal.mutedRgb},0.45)`;
      if (!selected && !collapsed) g.setLineDash([4, 3]);
      g.stroke();
      g.setLineDash([]);
      // Titlebar — the only band that takes clicks (see hitTest), so it reads as the grab handle.
      g.beginPath();
      g.roundRect(x, y, w, titleH, collapsed ? 7 * view.zoom : [7 * view.zoom, 7 * view.zoom, 0, 0]);
      g.fillStyle = `rgba(${pal.mutedRgb},0.22)`;
      g.fill();
      if (view.zoom > 0.35) {
        // Disclosure caret: ▸ collapsed, ▾ expanded — the affordance for the double-click toggle.
        const title = typeof node.params.title === "string" ? node.params.title : "Group";
        const count = groupMembers(node).length;
        g.fillStyle = `rgba(${pal.textRgb},0.85)`;
        g.font = `${Math.max(9, 11 * view.zoom)}px Inter, system-ui, sans-serif`;
        g.textBaseline = "middle";
        g.fillText(`${collapsed ? "▸" : "▾"} ${title}`, x + 8 * view.zoom, y + titleH / 2, w - 46 * view.zoom);
        if (collapsed) {
          g.fillStyle = `rgba(${pal.mutedRgb},0.9)`;
          g.textAlign = "right";
          g.fillText(String(count), x + w - 8 * view.zoom, y + titleH / 2);
          g.textAlign = "left";
        }
      }
    }

    // Wires under nodes. The splice-target wire (node or palette drag hovering it) draws amber.
    const spliceHoverId = paletteHover?.edgeId ?? (gesture.kind === "moveNodes" ? gesture.hoverEdgeId : null);
    for (const edge of comp.edges) {
      const a = socketScreen(edge.from.nodeId, edge.from.socket, "output");
      const b = socketScreen(edge.to.nodeId, edge.to.socket, "input");
      if (!a || !b) continue;
      const [x0, y0, c0x, c0y, c1x, c1y, x1, y1] = wirePath(a.x, a.y, b.x, b.y, a.dir, b.dir);
      const isSpliceTarget = edge.id === spliceHoverId;
      const isSelected = edge.id === selectedEdgeId;
      g.lineWidth = Math.max(1.25, (isSpliceTarget || isSelected ? 2.5 : 1.5) * view.zoom);
      // ACCENT-DRIVEN, at two strengths: a resting wire is the accent held well back, selection/splice
      // is the accent at full strength. It used to paint the resting wire in the output's DATA-TYPE
      // color, which broke the node editor's own rule — it is a consumer of the app's single accent
      // source (see flarex-canvas-model), so a theme change left every thread the same fixed blue. The
      // data type is still readable where it belongs: on the socket the wire lands in, which is exactly
      // how Resolve does it (colored sockets, neutral threads).
      g.strokeStyle =
        isSpliceTarget || isSelected ? `rgba(${accentRgb},0.95)` : `rgba(${accentRgb},0.42)`;
      g.beginPath();
      g.moveTo(x0, y0);
      g.bezierCurveTo(c0x, c0y, c1x, c1y, x1, y1);
      g.stroke();
    }
    // In-progress wire.
    if (gesture.kind === "wire") {
      const a = socketScreen(gesture.from.nodeId, gesture.from.socket, gesture.from.kind);
      if (a) {
        // The free end faces back toward the cursor so the lead line curves naturally either way.
        const freeDir: 1 | -1 = gesture.toX >= a.x ? -1 : 1;
        const [x0, y0, c0x, c0y, c1x, c1y, x1, y1] = wirePath(a.x, a.y, gesture.toX, gesture.toY, a.dir, freeDir);
        // Same two accent strengths as a resting wire: snapped to a valid target = full, searching = held
        // back. Dashed either way, which is what marks it as not-yet-connected.
        g.strokeStyle = gesture.target ? `rgba(${accentRgb},0.9)` : `rgba(${accentRgb},0.5)`;
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
      // Backdrop and Group already got their own LOW-z-order passes above; skip their generic boxes.
      // Members of a collapsed group aren't drawn at all — their wires already re-anchor to its box.
      if (node.type === "backdrop" || node.type === "group" || isHidden(node)) continue;
      const def = getFlarexNodeDefinition(node.type);
      const pos = draftPos(node);
      const [x, y] = worldToScreen(view, pos.x, pos.y);
      const isReroute = node.type === "reroute";
      const w = nodeWidth(node) * view.zoom;
      const h = nodeHeight(node) * view.zoom;
      const selected = selectedNodeIds.includes(node.id);
      // Reroute renders as a small dot — no body box, no label, no accent strip, no view dot.
      if (isReroute) {
        g.beginPath();
        g.arc(x + w / 2, y + h / 2, Math.max(3, (w / 2) * 0.9), 0, Math.PI * 2);
        g.fillStyle = node.enabled ? `rgba(${pal.mutedRgb},0.9)` : `rgba(${pal.mutedRgb},0.4)`;
        g.fill();
        g.lineWidth = selected ? 2 : 1;
        g.strokeStyle = selected ? accentHex : `rgba(${pal.borderRgb},1)`;
        g.stroke();
        for (const socket of nodeSockets(node, comp)) {
          const [sxp, syp] = worldToScreen(view, socket.x + (pos.x - node.ui.x), socket.y + (pos.y - node.ui.y));
          drawSocket(sxp, syp, socket.def.type, false, node.enabled);
        }
        continue;
      }
      // ── Node tile ────────────────────────────────────────────────────────────
      // Two presentations, both taken from the references: with a picture the tile IS the image in a
      // thin bezel with an index/status footer, and the NAME sits outside above it (Resolve); without
      // one it stays the compact Fusion box with the name inside. `showThumb` picks between them.
      const showThumb = flarexNodeThumbnailsEnabled() && nodeHasThumbnail(node);
      const label = node.label ?? def.label;
      const labelVisible = view.zoom > 0.45;
      const dimText = node.enabled ? 0.92 : 0.45;

      if (showThumb && labelVisible) {
        // Name ABOVE the tile. Left-aligned to the node's edge so a column of nodes reads as a list.
        g.fillStyle = `rgba(${pal.textRgb},${node.enabled ? 0.8 : 0.4})`;
        g.font = `${Math.max(8, 10 * view.zoom)}px Inter, system-ui, sans-serif`;
        g.textBaseline = "alphabetic";
        g.fillText(label, x + 1, y - NODE_LABEL_GAP * view.zoom, w);
      }

      g.beginPath();
      g.roundRect(x, y, w, h, (showThumb ? 3 : 5) * view.zoom);
      // Node body = the app panel token; border neutral, or accent when selected (accent-only selection).
      g.fillStyle = node.enabled ? `rgba(${pal.panelRgb},0.96)` : `rgba(${pal.panelRgb},0.55)`;
      g.fill();
      g.lineWidth = selected ? 2 : 1;
      g.strokeStyle = selected ? accentHex : `rgba(${pal.borderRgb},1)`;
      g.stroke();

      if (showThumb) {
        // ── Picture ──
        // Draw-time is a pure cache LOOKUP — rendering is scheduled on idle by `requestFlarexThumbnails`
        // below, never from here, so a repaint can never trigger GPU work.
        const bezel = NODE_BEZEL * view.zoom;
        const ix = x + bezel;
        const iy = y + bezel;
        const iw = Math.max(1, w - bezel * 2);
        const ih = Math.max(1, NODE_THUMB_H * view.zoom - bezel * 2);
        g.save();
        g.beginPath();
        g.rect(ix, iy, iw, ih);
        g.clip();
        // Backing tone — what an as-yet-unrendered node shows. The picture itself is OPAQUE (a frame is
        // always cleared opaque, see the capture handle), so this is never blended with a rendered one.
        g.fillStyle = `rgba(${pal.bgRgb},1)`;
        g.fillRect(ix, iy, iw, ih);
        const picture = getFlarexThumbnail(comp.id, node.id);
        if (picture) {
          // CONTAIN: the render already preserves the comp's aspect (the capture handle fits it into
          // the requested box), so a vertical project letterboxes inside the tile instead of being
          // cropped to a 16:9 slice of itself.
          const scale = Math.min(iw / picture.width, ih / picture.height);
          const dw = picture.width * scale;
          const dh = picture.height * scale;
          g.globalAlpha = node.enabled ? 1 : 0.4;
          g.drawImage(picture, ix + (iw - dw) / 2, iy + (ih - dh) / 2, dw, dh);
          g.globalAlpha = 1;
        }
        g.restore();

        // ── Footer: index (left) + status glyphs (right) ──
        const fy = y + NODE_THUMB_H * view.zoom;
        const fh = NODE_FOOTER_H * view.zoom;
        g.beginPath();
        g.moveTo(x, fy);
        g.lineTo(x + w, fy);
        g.lineWidth = 1;
        g.strokeStyle = `rgba(${pal.borderRgb},1)`;
        g.stroke();
        if (labelVisible) {
          const index = nodeIndices.get(node.id);
          if (index !== undefined) {
            g.fillStyle = `rgba(${pal.dimRgb},${node.enabled ? 1 : 0.5})`;
            g.font = `${Math.max(8, 9.5 * view.zoom)}px Inter, system-ui, sans-serif`;
            g.textBaseline = "middle";
            g.fillText(String(index).padStart(2, "0"), x + 6 * view.zoom, fy + fh / 2);
          }
          // Glyphs, right-to-left. The view dot moved here from the body: on a picture node it was
          // sitting ON the image, which is exactly the noise the redesign is removing.
          let gx = x + w - 8 * view.zoom;
          if (comp.previewNodeId === node.id) {
            g.beginPath();
            g.arc(gx, fy + fh / 2, Math.max(2.5, 3.5 * view.zoom), 0, Math.PI * 2);
            g.fillStyle = accentHex;
            g.fill();
            gx -= 10 * view.zoom;
          }
          if (nodeAnimated.has(node.id)) {
            // Keyframed — a small diamond, the same affordance the timeline uses for a keyframe.
            const r = Math.max(2.5, 3.2 * view.zoom);
            g.beginPath();
            g.moveTo(gx, fy + fh / 2 - r);
            g.lineTo(gx + r, fy + fh / 2);
            g.lineTo(gx, fy + fh / 2 + r);
            g.lineTo(gx - r, fy + fh / 2);
            g.closePath();
            g.fillStyle = `rgba(${pal.textRgb},0.75)`;
            g.fill();
            gx -= 10 * view.zoom;
          }
          if (!node.enabled) {
            // Disabled — a struck-through bar, readable at a glance next to a dimmed picture.
            g.beginPath();
            g.moveTo(gx - 4 * view.zoom, fy + fh / 2);
            g.lineTo(gx + 4 * view.zoom, fy + fh / 2);
            g.lineWidth = Math.max(1.5, 2 * view.zoom);
            g.strokeStyle = `rgba(${pal.textRgb},0.5)`;
            g.stroke();
          }
        }
      } else {
        // Compact form: left edge strip + the name inside, as before.
        g.fillStyle = selected ? `rgba(${accentRgb},1)` : `rgba(${pal.dimRgb},1)`;
        g.globalAlpha = node.enabled ? 0.9 : 0.4;
        g.fillRect(x, y, Math.max(2, 3 * view.zoom), h);
        g.globalAlpha = 1;
        if (labelVisible) {
          g.fillStyle = `rgba(${pal.textRgb},${dimText})`;
          g.font = `${Math.max(9, 11 * view.zoom)}px Inter, system-ui, sans-serif`;
          g.textBaseline = "middle";
          g.fillText(label, x + 9 * view.zoom, y + h / 2, w - 14 * view.zoom);
        }
        // Fusion view dot: this node's output is what the viewer shows (double-click toggles) — accent.
        if (comp.previewNodeId === node.id) {
          g.beginPath();
          g.arc(x + 10 * view.zoom, y + h - 7 * view.zoom, Math.max(2.5, 3.5 * view.zoom), 0, Math.PI * 2);
          g.fillStyle = accentHex;
          g.fill();
          g.lineWidth = 1;
          g.strokeStyle = `rgba(${pal.bgRgb},0.9)`;
          g.stroke();
        }
      }
      // Sockets. While dragging a wire, every type-compatible candidate (opposite kind, matching
      // socket type, not the source node) gets a low-alpha halo ring so the drop targets are
      // visible before the cursor is even over them — the direct hover target gets its own
      // brighter ring (drawn separately below).
      for (const socket of nodeSockets(node, comp)) {
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
          g.strokeStyle = `rgba(${accentRgb},0.35)`;
          g.lineWidth = 1.5;
          g.stroke();
        }
        drawSocket(sxp, syp, socket.def.type, isDirectTarget, node.enabled);
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
        g.fillStyle = `rgba(${pal.textRgb},0.7)`;
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

    // ── Thumbnail pass (Slice 6) ────────────────────────────────────────────────
    // Scheduled from the END of the draw, so the node list is exactly what was just painted. Every
    // condition that must NOT cost anything resolves to an empty request, which cancels queued work:
    // mode off, no capture handle, no host clip, mid-gesture (drag/marquee/wire), or PLAYING.
    const idle = !isPlaying && gesture.kind === "none";
    const visibleForThumbs =
      thumbnails && idle && thumbnailCapture && hostLayerId
        ? Object.values(comp.nodes)
            .filter((n) => nodeHasThumbnail(n) && !isHidden(n))
            // Viewport cull in SCREEN space — what is painted is what is worth rendering.
            .map((n) => {
              const [nx, ny] = worldToScreen(view, n.ui.x, n.ui.y);
              return { node: n, nx, ny, w: nodeWidth(n) * view.zoom, h: nodeHeight(n) * view.zoom };
            })
            .filter((e) => e.nx + e.w >= 0 && e.nx <= size.w && e.ny + e.h >= 0 && e.ny <= size.h)
            // Centre-out priority: the nodes the user is looking at fill in first on a cold cache.
            .sort(
              (a, b) =>
                Math.hypot(a.nx + a.w / 2 - size.w / 2, a.ny + a.h / 2 - size.h / 2) -
                Math.hypot(b.nx + b.w / 2 - size.w / 2, b.ny + b.h / 2 - size.h / 2),
            )
            .map((e) => e.node.id)
        : [];
    requestFlarexThumbnails({
      hostLayerId: hostLayerId ?? "",
      comp,
      timeSeconds: compTime,
      nodeIds: visibleForThumbs,
      capture: thumbnailCapture?.current ?? null,
      onUpdated: () => setThumbTick((t) => t + 1),
    });
  }, [comp, view, gesture, selectedNodeIds, size, paletteHover, selectedEdgeId, themeTick, thumbTick, thumbnails, thumbnailCapture, hostLayerId, compTime, isPlaying]);

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
      // A picture node's NAME is drawn above its top edge, so the bounds need that headroom or the
      // topmost row of labels lands outside the fitted view.
      y0 = Math.min(y0, nodeThumbRect(n) ? n.ui.y - NODE_LABEL_GAP - 8 : n.ui.y);
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
    const selectedIds = selectedNodeIds.includes(hit.nodeId) ? selectedNodeIds : [hit.nodeId];
    if (!selectedNodeIds.includes(hit.nodeId)) onSelectNodes([hit.nodeId]);
    // A Group carries its members: dragging the box moves everything inside it, which is what makes it
    // a container rather than a floating label.
    const dragIds = expandGroupDragSet(comp, selectedIds);
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
    // A Group has no output to view, so its double-click is the collapse/expand toggle instead.
    if (node.type === "group") {
      onUpdateComp((current) => {
        const target = current.nodes[hit.nodeId];
        if (!target) return current;
        return {
          ...current,
          nodes: { ...current.nodes, [hit.nodeId]: { ...target, params: { ...target.params, collapsed: target.params.collapsed !== true } } },
        };
      });
      return;
    }
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

  /** Insert the chosen type at the menu's world position. If exactly one node is selected, auto-
   *  wire its first compatible output into the new node's first compatible input (Fusion "insert
   *  after selected") — skipped silently when no socket types match. ONE commit. */
  const insertNodeFromMenu = (type: FlarexNodeType, dropAt?: { wx: number; wy: number }) => {
    const menu = nodeMenu;
    // A DRAG carries its own drop point and so needs no open menu; a click still requires one.
    if (!menu && !dropAt) return;
    const selected = stateRef.current.selectedNodeIds;
    const id = `n_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    onUpdateComp((current) => {
      // PLACEMENT, in priority order (2026-07-28):
      //   1. an explicit drop point — the user pointed at a spot, so honour it exactly;
      //   2. to the RIGHT of a single selected node — the direction the graph reads and the direction
      //      the auto-wire below runs, so the new node lands beside what it was just connected to;
      //   3. the menu position, i.e. wherever the cursor was.
      // (3) was the only rule before, which meant a keyboard-driven add (Tab, type, Enter) dropped the
      // node under a pointer the user was not thinking about — frequently on top of existing nodes.
      const placed =
        dropAt
          ? { x: Math.round(dropAt.wx - NODE_W / 2), y: Math.round(dropAt.wy - 18) }
          : (selected.length === 1 ? placeAfterNode(current.nodes, selected[0]!) : null) ??
            { x: Math.round(menu!.wx - NODE_W / 2), y: Math.round(menu!.wy - 18) };
      const node = createFlarexNode(type, id, placed.x, placed.y);
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

  // ── Drag-and-drop (toolbar palette → canvas splices into a wire; media-pool asset → MediaIn node) ─
  const ASSET_DRAG_MIME = "application/x-orreris-asset";
  const onDragOver = (event: React.DragEvent) => {
    const type = flarexPaletteDrag.current;
    const isAsset = event.dataTransfer.types.includes(ASSET_DRAG_MIME);
    if (!type && !isAsset) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    // An asset drop makes a MediaIn (no inputs → can't splice into a wire) — just allow the drop.
    if (!type) {
      setPaletteHover(null);
      return;
    }
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
    const assetId = type ? "" : event.dataTransfer.getData(ASSET_DRAG_MIME);
    if (!type && !assetId) return;
    event.preventDefault();
    const [sx, sy] = localPoint(event);
    const { comp: c, view: v } = stateRef.current;
    const [wx, wy] = screenToWorld(v, sx, sy);
    const id = `n_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

    // Media-pool asset dropped: create a MediaIn loading that asset (asset-source MediaIn, Phase 2),
    // labeled with the asset name so the node reads as the source at a glance.
    if (!type) {
      const name = sourceAssets?.find((a) => a.id === assetId)?.name;
      onUpdateComp((current) => {
        const node = createFlarexNode("mediaIn", id, Math.round(wx - NODE_W / 2), Math.round(wy - 18));
        node.params = { ...node.params, sourceAssetId: assetId };
        if (name) node.label = name;
        return { ...current, nodes: { ...current.nodes, [id]: node } };
      });
      onSelectNodes([id]);
      return;
    }

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

  // Delete the selection. MediaOut is always protected (the fixed output). MediaIn is deletable when
  // the comp has MORE THAN ONE (multi-clip MediaIn, FLAREX.md Phase 2) — the last MediaIn stays put so
  // the graph keeps its default source; extra source inputs added from the palette can be removed.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Delete" && event.key !== "Backspace") return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      const mediaInCount = Object.values(stateRef.current.comp.nodes).filter((n) => n.type === "mediaIn").length;
      const ids = stateRef.current.selectedNodeIds.filter((id) => {
        const node = stateRef.current.comp.nodes[id];
        if (!node || node.type === "mediaOut") return false;
        if (node.type === "mediaIn") return mediaInCount > 1;
        return true;
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
      {/* F1: add-node browser (categorized + searchable), anchored at the cursor. */}
      {nodeMenu ? (
        <div className="flarex-node-menu" style={{ left: nodeMenu.sx, top: nodeMenu.sy }}>
          <FlarexNodeBrowser
            onPick={insertNodeFromMenu}
            onClose={() => setNodeMenu(null)}
            // Dragging out of the menu hands off to the palette channel the canvas already handles
            // (drop, or splice when released on a wire). The menu closes on drag start: it is anchored
            // at the cursor, so leaving it open would cover the canvas the user is dragging onto.
            onDragStartType={(type) => {
              flarexPaletteDrag.current = type;
              setNodeMenu(null);
            }}
            onDragEndType={() => {
              flarexPaletteDrag.current = null;
            }}
          />
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
          {/* MediaOut never deletable; a MediaIn is deletable only when the comp has more than one
              (the last MediaIn stays as the default source — multi-clip MediaIn, FLAREX.md Phase 2). */}
          {contextMenuNode.type !== "mediaOut" &&
          (contextMenuNode.type !== "mediaIn" ||
            Object.values(comp.nodes).filter((n) => n.type === "mediaIn").length > 1) ? (
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
