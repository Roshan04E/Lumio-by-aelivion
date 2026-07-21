/**
 * Notes board geometry (plans/notes-sonnet-execution.md M3) — pure math, no DOM/React. Adapted
 * from `editor/flarex/flarex-canvas-model.ts`'s screen<->world split, but NOT imported from it:
 * the board is a DOM tree (`.notes-world` gets a literal CSS `transform`), not a Canvas2D draw
 * loop, so the pan/zoom convention here matches that CSS directly.
 *
 * `.notes-world` is styled `transform: translate(panX, panY) scale(zoom)` (transform-origin 0 0).
 * CSS composes that as translate(scale(p)), i.e. screen = world*zoom + (panX,panY) — so panX/panY
 * are the SCREEN-pixel position of world (0,0), not a world-space offset (unlike Flarex's model).
 */

export interface NotesViewState {
  panX: number;
  panY: number;
  zoom: number;
}

export interface NotesRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const clampZoom = (zoom: number): number => Math.min(2.5, Math.max(0.15, zoom));

export const worldToScreen = (view: NotesViewState, wx: number, wy: number): [number, number] => [
  wx * view.zoom + view.panX,
  wy * view.zoom + view.panY,
];

export const screenToWorld = (view: NotesViewState, sx: number, sy: number): [number, number] => [
  (sx - view.panX) / view.zoom,
  (sy - view.panY) / view.zoom,
];

/** Cursor-anchored zoom: the world point under (sx,sy) stays under the cursor after zooming. */
export function zoomAt(view: NotesViewState, sx: number, sy: number, factor: number): NotesViewState {
  const zoom = clampZoom(view.zoom * factor);
  const [wx, wy] = screenToWorld(view, sx, sy);
  return { zoom, panX: sx - wx * zoom, panY: sy - wy * zoom };
}

export function rectsIntersect(a: NotesRect, b: NotesRect): boolean {
  return a.x <= b.x + b.w && a.x + a.w >= b.x && a.y <= b.y + b.h && a.y + a.h >= b.y;
}

export function rectFromPoints(x0: number, y0: number, x1: number, y1: number): NotesRect {
  return { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
}

/**
 * Pan/zoom that frames every rect in `items` (world space) inside a `vw`×`vh` viewport with
 * `pad` px of screen-space breathing room, capped at 100% zoom (fitting never zooms IN past 1x
 * just because the content is small). Returns null for an empty set or a zero-size viewport.
 */
export function fitViewFor(items: NotesRect[], vw: number, vh: number, pad = 60): NotesViewState | null {
  if (items.length === 0 || vw <= 0 || vh <= 0) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const item of items) {
    x0 = Math.min(x0, item.x);
    y0 = Math.min(y0, item.y);
    x1 = Math.max(x1, item.x + item.w);
    y1 = Math.max(y1, item.y + item.h);
  }
  const spanW = Math.max(1, x1 - x0);
  const spanH = Math.max(1, y1 - y0);
  const zoom = clampZoom(Math.min((vw - pad * 2) / spanW, (vh - pad * 2) / spanH, 1));
  const worldCenterX = (x0 + x1) / 2;
  const worldCenterY = (y0 + y1) / 2;
  return { zoom, panX: vw / 2 - worldCenterX * zoom, panY: vh / 2 - worldCenterY * zoom };
}

export type NoteSide = "top" | "bottom" | "left" | "right";

/** Which side of `rect` faces `otherCenter` — used to pick a connector's facing anchor. */
export function sideFacing(rect: NotesRect, otherCx: number, otherCy: number): NoteSide {
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  const dx = otherCx - cx;
  const dy = otherCy - cy;
  if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? "right" : "left";
  return dy > 0 ? "bottom" : "top";
}

export function anchorPoint(rect: NotesRect, side: NoteSide): { x: number; y: number } {
  switch (side) {
    case "top":
      return { x: rect.x + rect.w / 2, y: rect.y };
    case "bottom":
      return { x: rect.x + rect.w / 2, y: rect.y + rect.h };
    case "left":
      return { x: rect.x, y: rect.y + rect.h / 2 };
    case "right":
      return { x: rect.x + rect.w, y: rect.y + rect.h / 2 };
  }
}

/** Smooth cubic (SVG path `d`) between two rects' nearest facing edge-midpoints. */
export function edgeCubicPath(a: NotesRect, b: NotesRect): string {
  const cbx = b.x + b.w / 2;
  const cby = b.y + b.h / 2;
  const cax = a.x + a.w / 2;
  const cay = a.y + a.h / 2;
  const sideA = sideFacing(a, cbx, cby);
  const sideB = sideFacing(b, cax, cay);
  const p0 = anchorPoint(a, sideA);
  const p1 = anchorPoint(b, sideB);
  const horizontal = sideA === "left" || sideA === "right";
  const dist = horizontal ? Math.max(24, Math.abs(p1.x - p0.x) * 0.5) : Math.max(24, Math.abs(p1.y - p0.y) * 0.5);
  const c0 = horizontal ? { x: p0.x + (sideA === "right" ? dist : -dist), y: p0.y } : { x: p0.x, y: p0.y + (sideA === "bottom" ? dist : -dist) };
  const c1 = horizontal ? { x: p1.x + (sideB === "right" ? dist : -dist), y: p1.y } : { x: p1.x, y: p1.y + (sideB === "bottom" ? dist : -dist) };
  return `M ${p0.x} ${p0.y} C ${c0.x} ${c0.y}, ${c1.x} ${c1.y}, ${p1.x} ${p1.y}`;
}

/** Midpoint between two rects' facing edge-anchors — where an edge's label pill sits. */
export function edgeMidpoint(a: NotesRect, b: NotesRect): { x: number; y: number } {
  const cbx = b.x + b.w / 2;
  const cby = b.y + b.h / 2;
  const cax = a.x + a.w / 2;
  const cay = a.y + a.h / 2;
  const p0 = anchorPoint(a, sideFacing(a, cbx, cby));
  const p1 = anchorPoint(b, sideFacing(b, cax, cay));
  return { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 };
}

/**
 * Frames sit BELOW normal cards (frame z band 0–999, cards 1000+) so a frame never occludes its
 * members. Returns the next free z in the band for the item being created/raised.
 */
export function nextZOrder(items: Record<string, { type: string; z: number }>, isFrame: boolean): number {
  const base = isFrame ? 0 : 1000;
  let max = base - 1;
  for (const item of Object.values(items)) {
    if ((item.type === "frame") === isFrame && item.z > max) max = item.z;
  }
  return max + 1;
}

