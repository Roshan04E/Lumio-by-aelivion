/**
 * Notes board (plans/notes-sonnet-execution.md M3–M5) — the DOM viewport/world + gestures.
 * Gestures mirror the Flarex/Fusion model (left click select, marquee, Shift/Ctrl toggle, drag
 * moves selection, Delete deletes, middle/Alt/Space-drag pan, wheel zoom-at-cursor).
 *
 * ONE `gesture` state machine drives every drag interaction (pan/marquee/move/resize/connect);
 * every initiator (card/handle/connector-dot pointerdown) captures the pointer on the VIEWPORT
 * element (not itself) so a single onPointerMove/onPointerUp pair on `.notes-viewport` handles
 * all of them — no per-element listener duplication.
 */

import { useEffect, useRef, useState } from "react";
import { Link2, Pin, Search, X } from "lucide-react";
import {
  cloneNoteItems,
  defaultSizeForAsset,
  itemsInsideFrame,
  notesForLayer,
  type NoteEdge,
  type NoteItem,
  type NotesBoard as NotesBoardData,
  type SourceAsset,
} from "@orreris/shared";
import {
  clampZoom,
  edgeCubicPath,
  edgeMidpoint,
  fitViewFor,
  nextZOrder,
  rectFromPoints,
  rectsIntersect,
  screenToWorld,
  zoomAt,
  type NotesRect,
  type NotesViewState,
} from "./notes-board-model";
import {
  AssetCardBody,
  assetKind,
  ColorSwatchRow,
  FrameTitleBody,
  ImageCardBody,
  LinkCardBody,
  LinkedTimeRow,
  LockToggleButton,
  NoteCardBody,
  NOTE_COLOR_SWATCHES,
  noteTint,
  ShapeCardBody,
  TodoCardBody,
} from "./NotesCards";
import { setNotice } from "../../lib/noticeStore";

const MIN_SIZE = { w: 80, h: 48 };
const MAX_PASTED_IMAGE_BYTES = 2 * 1024 * 1024; // ~2MB guard — small pastes stay inline data URLs in
// the project graph; anything bigger would bloat every save/sync (no OPFS/cloud storage for these).

/** Searchable text for the Ctrl+F filter — title/body/link/todo item text, whatever the card has. */
function itemSearchText(item: NoteItem): string {
  const parts = [item.title, item.body, item.url];
  if (item.todosJson) {
    try {
      const rows = JSON.parse(item.todosJson);
      if (Array.isArray(rows)) parts.push(...rows.map((r) => r?.text));
    } catch {
      /* ignore */
    }
  }
  return parts.filter(Boolean).join(" ").toLowerCase();
}

function nextId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

/** Module-level clipboard (not the system clipboard) — same idiom as the Flarex node clipboard.
 *  Cleared whenever the active board changes, so a paste only ever lands in its origin board. */
const notesClipboard: { current: { boardId: string; items: NoteItem[]; edges: NoteEdge[] } | null } = { current: null };

type Gesture =
  | { kind: "none" }
  | { kind: "pan"; startX: number; startY: number; panX: number; panY: number }
  | { kind: "marquee"; startX: number; startY: number; curX: number; curY: number; additive: boolean }
  | {
      kind: "move";
      grabWX: number;
      grabWY: number;
      primaryId: string;
      start: Record<string, { x: number; y: number }>;
      positions: Record<string, { x: number; y: number }>;
    }
  | { kind: "resize"; itemId: string; handle: string; startRect: NotesRect; aspect: number | null; lockAxis: "height" | null; rect: NotesRect }
  | { kind: "connect"; fromId: string; toX: number; toY: number; targetId: string | null };

function computeResizeRect(start: NotesRect, handle: string, wx: number, wy: number, aspect: number | null, lockAxis: "height" | null): NotesRect {
  // Height-locked (Q1.3, audio cards): resize width freely, height always snaps back to natural.
  const effectiveHandle = lockAxis === "height" ? handle.replace(/[ns]/, "") || handle : handle;
  if (lockAxis === "height" && effectiveHandle === handle && !handle.includes("e") && !handle.includes("w")) {
    return start; // a pure n/s handle on a height-locked card has nothing left to do
  }
  const x1 = start.x + start.w;
  const y1 = start.y + start.h;
  let nx = start.x;
  let ny = start.y;
  let nx1 = x1;
  let ny1 = y1;
  if (effectiveHandle.includes("w")) nx = wx;
  if (effectiveHandle.includes("e")) nx1 = wx;
  if (effectiveHandle.includes("n")) ny = wy;
  if (effectiveHandle.includes("s")) ny1 = wy;
  let w = Math.max(MIN_SIZE.w, nx1 - nx);
  let h = lockAxis === "height" ? start.h : Math.max(MIN_SIZE.h, ny1 - ny);
  if (aspect) {
    if (w / h > aspect) w = Math.max(MIN_SIZE.w, h * aspect);
    else h = Math.max(MIN_SIZE.h, w / aspect);
  }
  const x = effectiveHandle.includes("w") ? nx1 - w : nx;
  const y = lockAxis === "height" ? start.y : effectiveHandle.includes("n") ? ny1 - h : ny;
  return { x, y, w, h };
}

function hitTestItem(board: NotesBoardData, wx: number, wy: number, excludeId?: string): string | null {
  let best: NoteItem | null = null;
  for (const item of Object.values(board.items)) {
    if (item.id === excludeId) continue;
    if (wx >= item.x && wx <= item.x + item.w && wy >= item.y && wy <= item.y + item.h) {
      if (!best || item.z > best.z) best = item;
    }
  }
  return best?.id ?? null;
}

const HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"] as const;
const HANDLE_CURSOR: Record<string, string> = {
  nw: "nwse-resize",
  se: "nwse-resize",
  ne: "nesw-resize",
  sw: "nesw-resize",
  n: "ns-resize",
  s: "ns-resize",
  e: "ew-resize",
  w: "ew-resize",
};
const HANDLE_POS: Record<string, { left: string; top: string }> = {
  nw: { left: "0%", top: "0%" },
  n: { left: "50%", top: "0%" },
  ne: { left: "100%", top: "0%" },
  e: { left: "100%", top: "50%" },
  se: { left: "100%", top: "100%" },
  s: { left: "50%", top: "100%" },
  sw: { left: "0%", top: "100%" },
  w: { left: "0%", top: "50%" },
};
const SIDES = ["top", "right", "bottom", "left"] as const;

export interface NotesBoardProps {
  board: NotesBoardData;
  assets: SourceAsset[];
  onUpdateBoard: (updater: (board: NotesBoardData) => NotesBoardData) => void;
  view: NotesViewState;
  onViewChange: (view: NotesViewState) => void;
  selectedIds: string[];
  onSelectIds: (ids: string[]) => void;
  viewportRef: React.RefObject<HTMLDivElement | null>;
  onFit: () => void;
  /** Shared transport playhead (P2 NLE link) — "Pin to playhead" writes this into `linkedTime`. */
  currentTime: number;
  /** Seeks the shared transport (P2) — the clock chip's click target. */
  onSeek: (seconds: number) => void;
  /** Reverse-direction jump (P2.3): a clip's note badge was double-clicked. Bumping `nonce` (even
   *  for the same layerId) re-triggers the select+center even if you jump to the same clip twice. */
  focusRequest?: { layerId: string; nonce: number } | null | undefined;
  /** Layer ids that have a Flarex node comp (Q2.1) — drives the clock-chip row's node-glyph button. */
  layerFlarexCompIds?: Set<string> | undefined;
  /** Switches to the Flarex page for a linked clip (Q2.1) — same handler EditorPage already wires
   *  to the timeline's fx badge, reused verbatim (no new seam). */
  onOpenFlarexForLayer?: ((layerId: string) => void) | undefined;
  /** Opens an asset in the Source Monitor (Q2.2) — same callback the AssetBin already uses. */
  onOpenAssetInSourceMonitor?: ((assetId: string) => void) | undefined;
  /** The Edit page's selection when exactly one clip is selected, else null (Q2.3, read-only —
   *  Notes never writes timeline selection). Powers "Link to selected clip". */
  selectedTimelineLayerId?: string | null | undefined;
  /** Quick-start template chips on the empty-board hint (Q6.1) — same templates the toolbar menu
   *  offers, reused rather than duplicated. */
  templateNames?: string[] | undefined;
  onApplyTemplate?: ((name: string) => void) | undefined;
}

/** Centers the view on a rect at the CURRENT zoom (unlike `fitViewFor`, never changes zoom). */
function centerViewOn(view: NotesViewState, rect: NotesRect, vw: number, vh: number): NotesViewState {
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  return { ...view, panX: vw / 2 - cx * view.zoom, panY: vh / 2 - cy * view.zoom };
}

export function NotesBoard({
  board,
  assets,
  onUpdateBoard,
  view,
  onViewChange,
  selectedIds,
  onSelectIds,
  viewportRef,
  onFit,
  currentTime,
  onSeek,
  focusRequest,
  layerFlarexCompIds,
  onOpenFlarexForLayer,
  onOpenAssetInSourceMonitor,
  selectedTimelineLayerId,
  templateNames,
  onApplyTemplate,
}: NotesBoardProps) {
  const [gesture, setGesture] = useState<Gesture>({ kind: "none" });
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [edgeLabelEditId, setEdgeLabelEditId] = useState<string | null>(null);
  const [autoEditId, setAutoEditId] = useState<string | null>(null);
  const [search, setSearch] = useState<{ query: string; activeIndex: number } | null>(null);
  const [oversizeNotice, setOversizeNotice] = useState(false);
  const spaceRef = useRef(false);
  const hoveredRef = useRef(false);
  const stateRef = useRef({ board, view, gesture, selectedIds, selectedEdgeId, currentTime });
  stateRef.current = { board, view, gesture, selectedIds, selectedEdgeId, currentTime };

  useEffect(() => {
    setSelectedEdgeId(null);
  }, [board.id]);

  useEffect(() => {
    if (notesClipboard.current && notesClipboard.current.boardId !== board.id) notesClipboard.current = null;
  }, [board.id]);

  // Reverse-direction jump (P2.3): a clip's note badge was double-clicked on the timeline —
  // select every note linked to that layer and center the view on them.
  useEffect(() => {
    if (!focusRequest) return;
    const matches = notesForLayer(board, focusRequest.layerId);
    if (matches.length === 0) return;
    onSelectIds(matches.map((it) => it.id));
    const rect = viewportRef.current?.getBoundingClientRect();
    if (!rect) return;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const it of matches) {
      x0 = Math.min(x0, it.x);
      y0 = Math.min(y0, it.y);
      x1 = Math.max(x1, it.x + it.w);
      y1 = Math.max(y1, it.y + it.h);
    }
    onViewChange(centerViewOn(stateRef.current.view, { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, rect.width, rect.height));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRequest?.layerId, focusRequest?.nonce]);

  // Space-held pan (tracked globally so it works regardless of DOM focus).
  useEffect(() => {
    const onDown = (e: KeyboardEvent) => {
      if (e.code === "Space") spaceRef.current = true;
    };
    const onUp = (e: KeyboardEvent) => {
      if (e.code === "Space") spaceRef.current = false;
    };
    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);
    return () => {
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", onUp);
    };
  }, []);

  const localPoint = (e: { clientX: number; clientY: number }): [number, number] => {
    const rect = viewportRef.current?.getBoundingClientRect();
    return rect ? [e.clientX - rect.left, e.clientY - rect.top] : [0, 0];
  };

  const commitItemPatch = (id: string, patch: Partial<NoteItem>) => {
    onUpdateBoard((current) => {
      const it = current.items[id];
      if (!it) return current;
      return { ...current, items: { ...current.items, [id]: { ...it, ...patch } } };
    });
  };

  // ── Background: pan / marquee / deselect ──────────────────────────────────
  const onViewportPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 && e.button !== 1) return;
    if (e.target !== e.currentTarget) return; // cards/handles/dots stopPropagation + handle their own
    const [sx, sy] = localPoint(e);
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    if (e.button === 1 || e.altKey || spaceRef.current) {
      setGesture({ kind: "pan", startX: sx, startY: sy, panX: view.panX, panY: view.panY });
      return;
    }
    setSelectedEdgeId(null);
    setGesture({ kind: "marquee", startX: sx, startY: sy, curX: sx, curY: sy, additive: e.shiftKey });
  };

  const onViewportPointerMove = (e: React.PointerEvent) => {
    const g = stateRef.current.gesture;
    if (g.kind === "none") return;
    const [sx, sy] = localPoint(e);
    if (g.kind === "pan") {
      onViewChange({ ...stateRef.current.view, panX: g.panX + (sx - g.startX), panY: g.panY + (sy - g.startY) });
      return;
    }
    if (g.kind === "marquee") {
      setGesture({ ...g, curX: sx, curY: sy });
      return;
    }
    if (g.kind === "move") {
      const [wx, wy] = screenToWorld(stateRef.current.view, sx, sy);
      const dx = wx - g.grabWX;
      const dy = wy - g.grabWY;
      const positions: Record<string, { x: number; y: number }> = {};
      for (const [id, p] of Object.entries(g.start)) positions[id] = { x: Math.round(p.x + dx), y: Math.round(p.y + dy) };
      setGesture({ ...g, positions });
      return;
    }
    if (g.kind === "resize") {
      const [wx, wy] = screenToWorld(stateRef.current.view, sx, sy);
      const rect = computeResizeRect(g.startRect, g.handle, wx, wy, g.aspect && !e.shiftKey ? g.aspect : null, g.lockAxis);
      setGesture({ ...g, rect });
      return;
    }
    if (g.kind === "connect") {
      const [wx, wy] = screenToWorld(stateRef.current.view, sx, sy);
      const targetId = hitTestItem(stateRef.current.board, wx, wy, g.fromId);
      setGesture({ ...g, toX: wx, toY: wy, targetId });
    }
  };

  const onViewportPointerUp = () => {
    const g = stateRef.current.gesture;
    setGesture({ kind: "none" });
    if (g.kind === "marquee") {
      const dragged = Math.abs(g.curX - g.startX) > 3 || Math.abs(g.curY - g.startY) > 3;
      if (!dragged) {
        onSelectIds([]);
        return;
      }
      const [wx0, wy0] = screenToWorld(stateRef.current.view, Math.min(g.startX, g.curX), Math.min(g.startY, g.curY));
      const [wx1, wy1] = screenToWorld(stateRef.current.view, Math.max(g.startX, g.curX), Math.max(g.startY, g.curY));
      const marqueeRect = rectFromPoints(wx0, wy0, wx1, wy1);
      const touched = Object.values(stateRef.current.board.items)
        .filter((it) => rectsIntersect(marqueeRect, it))
        .map((it) => it.id);
      onSelectIds(g.additive ? Array.from(new Set([...stateRef.current.selectedIds, ...touched])) : touched);
      return;
    }
    if (g.kind === "move") {
      onUpdateBoard((current) => {
        const items = { ...current.items };
        for (const [id, p] of Object.entries(g.positions)) {
          const it = items[id];
          if (it) items[id] = { ...it, x: p.x, y: p.y };
        }
        const primary = items[g.primaryId];
        if (primary) items[g.primaryId] = { ...primary, z: nextZOrder(current.items, primary.type === "frame") };
        return { ...current, items };
      });
      return;
    }
    if (g.kind === "resize") {
      onUpdateBoard((current) => {
        const it = current.items[g.itemId];
        if (!it) return current;
        return { ...current, items: { ...current.items, [g.itemId]: { ...it, x: g.rect.x, y: g.rect.y, w: g.rect.w, h: g.rect.h } } };
      });
      return;
    }
    if (g.kind === "connect") {
      if (g.targetId && g.targetId !== g.fromId) {
        onUpdateBoard((current) => {
          const exists = current.edges.some((ed) => (ed.from === g.fromId && ed.to === g.targetId) || (ed.from === g.targetId && ed.to === g.fromId));
          if (exists) return current;
          return { ...current, edges: [...current.edges, { id: nextId("edge"), from: g.fromId, to: g.targetId! }] };
        });
      } else if (!g.targetId) {
        const newId = nextId("item");
        onUpdateBoard((current) => {
          const item: NoteItem = { id: newId, type: "note", x: Math.round(g.toX - 110), y: Math.round(g.toY - 30), w: 220, h: 160, z: nextZOrder(current.items, false) };
          const edge: NoteEdge = { id: nextId("edge"), from: g.fromId, to: newId };
          return { ...current, items: { ...current.items, [newId]: item }, edges: [...current.edges, edge] };
        });
        onSelectIds([newId]);
        setAutoEditId(newId);
      }
    }
  };

  const onWheel = (e: React.WheelEvent) => {
    const [sx, sy] = localPoint(e);
    onViewChange(zoomAt(stateRef.current.view, sx, sy, Math.exp(-e.deltaY * 0.0015)));
  };

  const onViewportDoubleClick = (e: React.MouseEvent) => {
    if (e.target !== e.currentTarget) return;
    const [sx, sy] = localPoint(e);
    const [wx, wy] = screenToWorld(stateRef.current.view, sx, sy);
    const id = nextId("item");
    onUpdateBoard((current) => ({
      ...current,
      items: { ...current.items, [id]: { id, type: "note", x: Math.round(wx - 110), y: Math.round(wy - 80), w: 220, h: 160, z: nextZOrder(current.items, false) } },
    }));
    onSelectIds([id]);
    setAutoEditId(id);
  };

  // ── Asset-bin drop → asset card ────────────────────────────────────────────
  const onDragOver = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes("application/x-orreris-asset")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  };
  const onDrop = (e: React.DragEvent) => {
    const assetId = e.dataTransfer.getData("application/x-orreris-asset");
    if (!assetId) return;
    e.preventDefault();
    const asset = assets.find((a) => a.id === assetId);
    const [sx, sy] = localPoint(e);
    const [wx, wy] = screenToWorld(stateRef.current.view, sx, sy);
    // Q1.1: per-kind default size (audio wide-short, video/image real-aspect, doc compact) — the
    // generic box only applies when the asset can't be resolved at all.
    const { w, h } = asset ? defaultSizeForAsset(assetKind(asset), asset.width, asset.height) : { w: 260, h: 160 };
    const id = nextId("item");
    onUpdateBoard((current) => ({
      ...current,
      items: { ...current.items, [id]: { id, type: "asset", assetId, x: Math.round(wx - w / 2), y: Math.round(wy - h / 2), w, h, z: nextZOrder(current.items, false) } },
    }));
    onSelectIds([id]);
  };

  // ── Card / handle / connector-dot pointerdown: capture on the VIEWPORT ────
  const onCardPointerDown = (e: React.PointerEvent, item: NoteItem) => {
    const target = e.target as HTMLElement;
    if (target.closest('textarea,input,button,a,[contenteditable="true"],.notes-resize-handle,.notes-connector-dot')) return;
    // An unlocked frame's BACKGROUND (not titlebar) doesn't even select — round-1 design so a
    // frame never steals clicks meant for the board underneath it. A LOCKED item, though, must
    // stay selectable (Q4.3) — only the drag-gesture start below is what locking blocks.
    if (!item.locked && item.type === "frame" && !target.closest(".notes-frame-titlebar")) return;
    e.stopPropagation();
    viewportRef.current?.setPointerCapture(e.pointerId);
    const [sx, sy] = localPoint(e);
    const [wx, wy] = screenToWorld(stateRef.current.view, sx, sy);
    if (e.shiftKey || e.ctrlKey || e.metaKey) {
      onSelectIds(selectedIds.includes(item.id) ? selectedIds.filter((id) => id !== item.id) : [...selectedIds, item.id]);
      return;
    }
    const dragIds = selectedIds.includes(item.id) ? selectedIds : [item.id];
    if (!selectedIds.includes(item.id)) onSelectIds([item.id]);
    setSelectedEdgeId(null);
    if (item.locked) return; // selected, but locked (Q4.3): no drag gesture starts
    const start: Record<string, { x: number; y: number }> = {};
    for (const id of dragIds) {
      const it = stateRef.current.board.items[id];
      if (it) start[id] = { x: it.x, y: it.y };
    }
    if (dragIds.length === 1 && item.type === "frame") {
      for (const member of itemsInsideFrame(stateRef.current.board, item.id)) {
        if (!(member.id in start)) start[member.id] = { x: member.x, y: member.y };
      }
    }
    setGesture({ kind: "move", grabWX: wx, grabWY: wy, primaryId: item.id, start, positions: { ...start } });
  };

  const onHandlePointerDown = (e: React.PointerEvent, item: NoteItem, handle: string) => {
    e.stopPropagation();
    viewportRef.current?.setPointerCapture(e.pointerId);
    // Q1.3: image/video keep aspect from corner handles (Shift breaks it); audio resizes width
    // freely but its height stays locked to the natural row height regardless of handle.
    const resolvedAssetKind = item.type === "asset" && item.assetId ? (() => { const a = assets.find((x) => x.id === item.assetId); return a ? assetKind(a) : null; })() : null;
    const isAspectKind = (item.type === "asset" && (resolvedAssetKind === "video" || resolvedAssetKind === "image")) || item.type === "image";
    const aspect = isAspectKind && handle.length === 2 ? item.w / Math.max(1, item.h) : null;
    const lockAxis: "height" | null = item.type === "asset" && resolvedAssetKind === "audio" ? "height" : null;
    setGesture({ kind: "resize", itemId: item.id, handle, startRect: { x: item.x, y: item.y, w: item.w, h: item.h }, aspect, lockAxis, rect: { x: item.x, y: item.y, w: item.w, h: item.h } });
  };

  const onConnectorDotPointerDown = (e: React.PointerEvent, item: NoteItem) => {
    e.stopPropagation();
    viewportRef.current?.setPointerCapture(e.pointerId);
    const [sx, sy] = localPoint(e);
    const [wx, wy] = screenToWorld(stateRef.current.view, sx, sy);
    setGesture({ kind: "connect", fromId: item.id, toX: wx, toY: wy, targetId: null });
  };

  // ── Mindmap keys: Tab = child, Enter = sibling (single selection, not editing) ─
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Tab" && e.key !== "Enter") return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      if (stateRef.current.selectedIds.length !== 1) return;
      const selId = stateRef.current.selectedIds[0]!;
      const b = stateRef.current.board;
      const selItem = b.items[selId];
      if (!selItem) return;
      e.preventDefault();
      const newId = nextId("item");
      let x: number;
      let y: number;
      let edgeFrom: string;
      if (e.key === "Tab") {
        const connectedCount = b.edges.filter((ed) => ed.from === selId || ed.to === selId).length;
        x = selItem.x + selItem.w + 80;
        y = selItem.y + connectedCount * 180;
        edgeFrom = selId;
      } else {
        const parentEdge = b.edges.find((ed) => ed.to === selId);
        const parent = parentEdge ? b.items[parentEdge.from] : undefined;
        if (parent) {
          const siblingCount = b.edges.filter((ed) => ed.from === parent.id).length;
          x = parent.x + parent.w + 80;
          y = parent.y + siblingCount * 180;
          edgeFrom = parent.id;
        } else {
          x = selItem.x;
          y = selItem.y + selItem.h + 40;
          edgeFrom = selId;
        }
      }
      onUpdateBoard((current) => ({
        ...current,
        items: { ...current.items, [newId]: { id: newId, type: "note", x: Math.round(x), y: Math.round(y), w: 220, h: 160, z: nextZOrder(current.items, false) } },
        edges: [...current.edges, { id: nextId("edge"), from: edgeFrom, to: newId }],
      }));
      onSelectIds([newId]);
      setAutoEditId(newId);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onUpdateBoard, onSelectIds]);

  // ── Delete selection / selected edge ───────────────────────────────────────
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      // Locked items are excluded (Q4.3: "not deletable until unlocked") — a mixed selection just
      // deletes the unlocked members and leaves the locked ones in place.
      const ids = stateRef.current.selectedIds.filter((id) => !stateRef.current.board.items[id]?.locked);
      const edgeId = stateRef.current.selectedEdgeId;
      if (ids.length === 0 && !edgeId) return;
      e.preventDefault();
      onSelectIds([]);
      setSelectedEdgeId(null);
      onUpdateBoard((current) => {
        const items = { ...current.items };
        for (const id of ids) delete items[id];
        return { ...current, items, edges: current.edges.filter((ed) => !ids.includes(ed.from) && !ids.includes(ed.to) && ed.id !== edgeId) };
      });
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onUpdateBoard, onSelectIds]);

  // ── F fits (hover-gated) ────────────────────────────────────────────────────
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "f" && e.key !== "F") return;
      if (e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
      if (!hoveredRef.current) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      e.preventDefault();
      onFit();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onFit]);

  // ── Ctrl+A select-all / Escape clear (Q4.4) — Escape also closes search + the edge-label editor.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const inField = Boolean(target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable));
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a" && !inField) {
        e.preventDefault();
        onSelectIds(Object.keys(stateRef.current.board.items));
        return;
      }
      if (e.key === "Escape" && !inField) {
        onSelectIds([]);
        setSelectedEdgeId(null);
        setEdgeLabelEditId(null);
        setSearch(null);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onSelectIds]);

  // ── 1..8 sets the selected cards' color (quick recolor, no toolbar trip) ────
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!["1", "2", "3", "4", "5", "6", "7", "8"].includes(e.key)) return;
      if (e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      const ids = stateRef.current.selectedIds;
      if (ids.length === 0) return;
      e.preventDefault();
      const color = NOTE_COLOR_SWATCHES[Number(e.key) - 1]!;
      onUpdateBoard((current) => {
        const items = { ...current.items };
        for (const id of ids) {
          const it = items[id];
          if (it) items[id] = { ...it, color };
        }
        return { ...current, items };
      });
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onUpdateBoard]);

  // ── Paste an image (system clipboard binary, or a plain image URL) → an image card (P4.1) ──
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      if (!hoveredRef.current) return;
      const items = e.clipboardData?.items;
      const imageItem = items ? Array.from(items).find((it) => it.type.startsWith("image/")) : undefined;
      const rect = viewportRef.current?.getBoundingClientRect();
      const [centerX, centerY]: [number, number] = rect ? screenToWorld(stateRef.current.view, rect.width / 2, rect.height / 2) : [0, 0];
      const place = (dataUrl: string | undefined, url: string | undefined) => {
        const w = 260;
        const h = 180;
        const id = nextId("item");
        onUpdateBoard((current) => ({
          ...current,
          items: { ...current.items, [id]: { id, type: "image", x: Math.round(centerX - w / 2), y: Math.round(centerY - h / 2), w, h, z: nextZOrder(current.items, false), dataUrl, url } },
        }));
        onSelectIds([id]);
      };
      if (imageItem) {
        const blob = imageItem.getAsFile();
        if (!blob) return;
        if (blob.size > MAX_PASTED_IMAGE_BYTES) {
          setOversizeNotice(true);
          window.setTimeout(() => setOversizeNotice(false), 3000);
          return;
        }
        e.preventDefault();
        const reader = new FileReader();
        reader.onload = () => place(typeof reader.result === "string" ? reader.result : undefined, undefined);
        reader.readAsDataURL(blob);
        return;
      }
      const text = e.clipboardData?.getData("text/plain")?.trim();
      if (text && /^(https?:)?\/\/\S+\.(png|jpe?g|gif|webp|svg|avif)(\?\S*)?$/i.test(text)) {
        e.preventDefault();
        place(undefined, text);
      }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [onUpdateBoard, onSelectIds]);

  // ── Ctrl+F search/jump (P5.1) ────────────────────────────────────────────────
  const matchIds = search && search.query.trim()
    ? Object.values(board.items)
        .filter((it) => itemSearchText(it).includes(search.query.trim().toLowerCase()))
        .map((it) => it.id)
    : [];
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const jumpToMatch = (index: number) => {
    const id = matchIds[((index % matchIds.length) + matchIds.length) % matchIds.length];
    if (!id) return;
    const rect = board.items[id];
    const vp = viewportRef.current?.getBoundingClientRect();
    if (rect && vp) onViewChange(centerViewOn(stateRef.current.view, rect, vp.width, vp.height));
    onSelectIds(id ? [id] : []);
  };
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === "f" || e.key === "F")) {
        if (!hoveredRef.current && document.activeElement !== searchInputRef.current) return;
        e.preventDefault();
        setSearch({ query: "", activeIndex: 0 });
        window.setTimeout(() => searchInputRef.current?.focus(), 0);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // ── Clipboard: Ctrl/Cmd + C / V / D ─────────────────────────────────────────
  useEffect(() => {
    const buildSnapshot = (ids: string[]): { boardId: string; items: NoteItem[]; edges: NoteEdge[] } | null => {
      // Q6.3: copying/duplicating a single selected FRAME also brings its contained items along
      // (offset together via `cloneNoteItems`, same as any multi-item copy).
      let effectiveIds = ids;
      if (ids.length === 1) {
        const only = stateRef.current.board.items[ids[0]!];
        if (only?.type === "frame") {
          effectiveIds = [only.id, ...itemsInsideFrame(stateRef.current.board, only.id).map((m) => m.id)];
        }
      }
      if (effectiveIds.length === 0) return null;
      const idSet = new Set(effectiveIds);
      const items = effectiveIds.map((id) => stateRef.current.board.items[id]).filter((x): x is NoteItem => Boolean(x));
      const edges = stateRef.current.board.edges.filter((ed) => idSet.has(ed.from) && idSet.has(ed.to));
      return { boardId: stateRef.current.board.id, items, edges };
    };
    const pasteSnapshot = (snapshot: { boardId: string; items: NoteItem[]; edges: NoteEdge[] }) => {
      if (snapshot.boardId !== stateRef.current.board.id) return;
      const { items: newItems, edges: newEdges } = cloneNoteItems(snapshot.items, snapshot.edges);
      if (newItems.length === 0) return;
      onUpdateBoard((current) => {
        const items = { ...current.items };
        for (const it of newItems) items[it.id] = { ...it, z: nextZOrder(current.items, it.type === "frame") };
        return { ...current, items, edges: [...current.edges, ...newEdges] };
      });
      onSelectIds(newItems.map((it) => it.id));
    };
    const onKeyDown = (e: KeyboardEvent) => {
      const isMac = navigator.platform.toLowerCase().includes("mac");
      if ((isMac && !e.metaKey) || (!isMac && !e.ctrlKey)) return;
      const key = e.key.toLowerCase();
      if (key !== "c" && key !== "v" && key !== "d") return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      if (key === "c") {
        const snapshot = buildSnapshot(stateRef.current.selectedIds);
        if (!snapshot) return;
        e.preventDefault();
        notesClipboard.current = snapshot;
        return;
      }
      if (key === "v") {
        if (!notesClipboard.current) return;
        e.preventDefault();
        pasteSnapshot(notesClipboard.current);
        return;
      }
      const snapshot = buildSnapshot(stateRef.current.selectedIds);
      if (!snapshot) return;
      e.preventDefault();
      pasteSnapshot(snapshot);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onUpdateBoard, onSelectIds]);

  const rectOf = (id: string): NotesRect | null => {
    const it = board.items[id];
    if (!it) return null;
    if (gesture.kind === "move" && gesture.positions[id]) return { x: gesture.positions[id]!.x, y: gesture.positions[id]!.y, w: it.w, h: it.h };
    if (gesture.kind === "resize" && gesture.itemId === id) return gesture.rect;
    return it;
  };

  const draftRectFor = (item: NoteItem): NotesRect => rectOf(item.id) ?? item;

  /** Focus a frame (Q5.1): fit the view to exactly that frame's rect — a fast way to jump between
   *  board regions, distinct from the toolbar Fit (which fits the whole board or selection). */
  const focusFrame = (item: NoteItem) => {
    const rect = viewportRef.current?.getBoundingClientRect();
    if (!rect) return;
    const next = fitViewFor([item], rect.width, rect.height);
    if (next) onViewChange(next);
  };

  const renderCardBody = (item: NoteItem) => {
    switch (item.type) {
      case "note":
        return <NoteCardBody item={item} onCommit={(patch) => commitItemPatch(item.id, patch)} autoEdit={autoEditId === item.id} onAutoEditStart={() => setAutoEditId(null)} />;
      case "asset":
        return <AssetCardBody item={item} assets={assets} onOpenSource={item.assetId && onOpenAssetInSourceMonitor ? () => onOpenAssetInSourceMonitor(item.assetId!) : undefined} />;
      case "link":
        return <LinkCardBody item={item} onCommit={(patch) => commitItemPatch(item.id, patch)} />;
      case "todo":
        return <TodoCardBody item={item} onCommit={(patch) => commitItemPatch(item.id, patch)} />;
      case "image":
        return <ImageCardBody item={item} />;
      case "shape":
        return <ShapeCardBody item={item} />;
      case "frame":
        return null;
      default:
        return null;
    }
  };

  const showColorRow = (type: NoteItem["type"]) => type === "note" || type === "shape" || type === "image" || type === "frame";

  const items = Object.values(board.items).sort((a, b) => a.z - b.z);
  const isMoving = gesture.kind === "move";
  const isResizing = gesture.kind === "resize";

  return (
    <div
      ref={viewportRef}
      className="notes-viewport"
      style={board.color ? ({ ["--notes-board-tint" as string]: board.color }) : undefined}
      onPointerDown={onViewportPointerDown}
      onPointerMove={onViewportPointerMove}
      onPointerUp={onViewportPointerUp}
      onPointerCancel={onViewportPointerUp}
      onWheel={onWheel}
      onDoubleClick={onViewportDoubleClick}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onPointerEnter={() => {
        hoveredRef.current = true;
      }}
      onPointerLeave={() => {
        hoveredRef.current = false;
      }}
    >
      <div className="notes-world" style={{ transform: `translate(${view.panX}px, ${view.panY}px) scale(${view.zoom})`, ["--notes-zoom" as string]: view.zoom }}>
        <svg className="notes-edges-overlay">
          <defs>
            <marker id="notes-arrowhead" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" fill="context-stroke" />
            </marker>
          </defs>
          {items
            .filter((it) => it.type === "shape" && it.shapeKind === "arrow")
            .map((it) => {
              const rect = draftRectFor(it);
              return (
                <path
                  key={it.id}
                  d={`M ${rect.x} ${rect.y} L ${rect.x + rect.w} ${rect.y + rect.h}`}
                  className="notes-shape-arrow"
                  style={{ stroke: it.color ?? "#8a8f98" }}
                  markerEnd="url(#notes-arrowhead)"
                />
              );
            })}
          {board.edges.map((edge) => {
            const a = rectOf(edge.from);
            const b = rectOf(edge.to);
            if (!a || !b) return null;
            const d = edgeCubicPath(a, b);
            return (
              <g key={edge.id} className={selectedEdgeId === edge.id ? "notes-edge is-selected" : "notes-edge"}>
                <path d={d} className="notes-edge-path" style={edge.color ? { stroke: edge.color } : undefined} strokeDasharray={edge.style === "dashed" ? "8 6" : undefined} />
                <path
                  d={d}
                  className="notes-edge-hit"
                  onClick={(e) => {
                    e.stopPropagation();
                    setSelectedEdgeId(edge.id);
                    onSelectIds([]);
                  }}
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    setEdgeLabelEditId(edge.id);
                  }}
                />
              </g>
            );
          })}
          {gesture.kind === "connect"
            ? (() => {
                const from = rectOf(gesture.fromId);
                if (!from) return null;
                const cx = from.x + from.w / 2;
                const cy = from.y + from.h / 2;
                const dx = gesture.toX - cx;
                const dy = gesture.toY - cy;
                const startX = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? from.x + from.w : from.x) : cx;
                const startY = Math.abs(dx) > Math.abs(dy) ? cy : dy > 0 ? from.y + from.h : from.y;
                return <path d={`M ${startX} ${startY} L ${gesture.toX} ${gesture.toY}`} className="notes-edge-preview" />;
              })()
            : null}
        </svg>

        {board.edges
          .filter((edge) => edge.label)
          .map((edge) => {
            const a = rectOf(edge.from);
            const b = rectOf(edge.to);
            if (!a || !b) return null;
            const mid = edgeMidpoint(a, b);
            return (
              <div key={`${edge.id}_label`} className="notes-edge-label" style={{ transform: `translate(${mid.x}px, ${mid.y}px)` }}>
                {edge.label}
              </div>
            );
          })}

        {edgeLabelEditId
          ? (() => {
              const edge = board.edges.find((ed) => ed.id === edgeLabelEditId);
              const a = edge ? rectOf(edge.from) : null;
              const b = edge ? rectOf(edge.to) : null;
              if (!edge || !a || !b) return null;
              const mid = edgeMidpoint(a, b);
              return (
                <input
                  key="edge-label-editor"
                  autoFocus
                  className="notes-edge-label-input"
                  style={{ transform: `translate(${mid.x}px, ${mid.y}px)` }}
                  defaultValue={edge.label ?? ""}
                  onPointerDown={(e) => e.stopPropagation()}
                  onBlur={(e) => {
                    const label = e.target.value.trim();
                    onUpdateBoard((current) => ({ ...current, edges: current.edges.map((ed) => (ed.id === edgeLabelEditId ? { ...ed, label: label || undefined } : ed)) }));
                    setEdgeLabelEditId(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                    if (e.key === "Escape") setEdgeLabelEditId(null);
                  }}
                />
              );
            })()
          : null}

        {items.map((item) => {
          const rect = draftRectFor(item);
          const selected = selectedIds.includes(item.id);
          const dragging = (isMoving && gesture.kind === "move" && item.id in gesture.positions) || (isResizing && gesture.kind === "resize" && gesture.itemId === item.id);
          const isArrow = item.type === "shape" && item.shapeKind === "arrow";
          const isMatch = search && search.query.trim() ? matchIds.includes(item.id) : false;
          return (
            <div
              key={item.id}
              className={`notes-card notes-card-${item.type}${item.shapeKind ? ` notes-card-shape-${item.shapeKind}` : ""}${selected ? " is-selected" : ""}${dragging ? " is-dragging" : ""}${item.locked ? " is-locked" : ""}${isMatch ? " is-search-match" : ""}`}
              style={{
                transform: `translate(${rect.x}px, ${rect.y}px)`,
                width: rect.w,
                height: rect.h,
                zIndex: dragging ? 100000 : item.z,
              }}
              onPointerDown={(e) => onCardPointerDown(e, item)}
            >
              {/* Clipped surface: rounds/hides overflowing media. Connector dots, resize handles and
                  the hover toolbar are SIBLINGS of this (outside the clip) so they render as full
                  circles/handles OUTSIDE the card instead of being cut in half by overflow. Arrows
                  have no surface at all — their only visual IS the SVG line drawn above. */}
              {isArrow ? null : (
                <div
                  className="notes-card-surface"
                  style={{
                    background: item.type === "note" ? noteTint(item.color) : undefined,
                    borderColor: item.type !== "frame" ? item.color : undefined,
                  }}
                >
                  {item.type === "frame" ? (
                    <div
                      className="notes-frame-titlebar"
                      style={item.color ? { background: `color-mix(in srgb, ${item.color} 28%, transparent)` } : undefined}
                    >
                      <FrameTitleBody
                        item={item}
                        selected={selected}
                        onCommit={(patch) => commitItemPatch(item.id, patch)}
                        onFocusFrame={() => focusFrame(item)}
                      />
                    </div>
                  ) : null}
                  {renderCardBody(item)}
                </div>
              )}

              {item.linkedTime !== undefined ? (
                <div className="notes-linked-time-wrap">
                  <LinkedTimeRow
                    seconds={item.linkedTime}
                    onSeek={() => onSeek(item.linkedTime!)}
                    hasFlarexComp={Boolean(item.linkedLayerId && layerFlarexCompIds?.has(item.linkedLayerId))}
                    onOpenFlarex={item.linkedLayerId ? () => onOpenFlarexForLayer?.(item.linkedLayerId!) : undefined}
                  />
                </div>
              ) : null}

              <div className="notes-card-hover-toolbar" onPointerDown={(e) => e.stopPropagation()}>
                {showColorRow(item.type) ? <ColorSwatchRow current={item.color} onPick={(c) => commitItemPatch(item.id, { color: c })} /> : null}
                <button
                  type="button"
                  className="notes-pin-time-btn"
                  title="Pin to playhead"
                  onClick={() => commitItemPatch(item.id, { linkedTime: stateRef.current.currentTime })}
                >
                  <Pin size={11} />
                </button>
                {item.linkedLayerId === undefined ? (
                  <button
                    type="button"
                    className="notes-pin-time-btn"
                    title="Link to the selected clip"
                    onClick={() => {
                      if (!selectedTimelineLayerId) {
                        setNotice("Select exactly one clip on the Edit page first");
                        return;
                      }
                      commitItemPatch(item.id, { linkedLayerId: selectedTimelineLayerId });
                    }}
                  >
                    <Link2 size={11} />
                  </button>
                ) : null}
                <LockToggleButton locked={Boolean(item.locked)} onToggle={() => commitItemPatch(item.id, { locked: !item.locked })} />
              </div>

              {!item.locked || item.type === "frame"
                ? SIDES.map((side) => <button key={side} type="button" className={`notes-connector-dot notes-connector-dot-${side}`} onPointerDown={(e) => onConnectorDotPointerDown(e, item)} />)
                : null}

              {selected && selectedIds.length === 1 && !item.locked
                ? HANDLES.map((h) => (
                    <div
                      key={h}
                      className="notes-resize-handle"
                      style={{ left: HANDLE_POS[h]!.left, top: HANDLE_POS[h]!.top, cursor: HANDLE_CURSOR[h] }}
                      onPointerDown={(e) => onHandlePointerDown(e, item, h)}
                    />
                  ))
                : null}
            </div>
          );
        })}
      </div>

      {search ? (
        <div className="notes-search-box">
          <Search size={12} />
          <input
            ref={searchInputRef}
            value={search.query}
            placeholder="Search cards…"
            onChange={(e) => setSearch({ query: e.target.value, activeIndex: 0 })}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setSearch(null);
                return;
              }
              if (e.key === "Enter" && matchIds.length > 0) {
                e.preventDefault();
                const next = e.shiftKey ? search.activeIndex - 1 : search.activeIndex + 1;
                setSearch({ ...search, activeIndex: next });
                jumpToMatch(next);
              }
            }}
          />
          <span className="notes-search-count">{matchIds.length > 0 ? `${(search.activeIndex % matchIds.length + matchIds.length) % matchIds.length + 1}/${matchIds.length}` : "0"}</span>
          <button type="button" className="notes-search-close" onClick={() => setSearch(null)}>
            <X size={12} />
          </button>
        </div>
      ) : null}

      {oversizeNotice ? <div className="notes-oversize-notice">Image too large to paste inline (max ~2MB)</div> : null}

      {gesture.kind === "marquee" ? (
        <div
          className="notes-marquee"
          style={{
            left: Math.min(gesture.startX, gesture.curX),
            top: Math.min(gesture.startY, gesture.curY),
            width: Math.abs(gesture.curX - gesture.startX),
            height: Math.abs(gesture.curY - gesture.startY),
          }}
        />
      ) : null}

      {items.length === 0 ? (
        <div className="notes-empty-hint">
          <p>Double-click to add a note · drag media from the pool</p>
          {templateNames && templateNames.length > 0 && onApplyTemplate ? (
            <div className="notes-empty-hint-chips" onPointerDown={(e) => e.stopPropagation()}>
              {templateNames.map((name) => (
                <button key={name} type="button" className="notes-empty-hint-chip" onClick={() => onApplyTemplate(name)}>
                  ＋ {name}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export default NotesBoard;
