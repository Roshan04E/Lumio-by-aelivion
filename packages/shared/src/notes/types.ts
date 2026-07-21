/**
 * Notes board data model (plans/notes-sonnet-execution.md M1): a Miro/Milanote-style
 * infinite-canvas board — sticky notes, media cards, link cards, frames and connectors.
 * Mirrors the Flarex registry pattern (`ProjectGraph.flarexComps`): boards live first-class
 * in `ProjectGraph.notesBoards`, keyed by id.
 */

export type NoteItemType = "note" | "asset" | "link" | "frame" | "todo" | "image" | "shape";

export type NoteShapeKind = "rect" | "ellipse" | "arrow";

export interface NoteItem {
  id: string;
  type: NoteItemType;
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
  color?: string | undefined;
  title?: string | undefined;
  body?: string | undefined;
  assetId?: string | undefined;
  url?: string | undefined;
  todosJson?: string | undefined;
  locked?: boolean | undefined;
  /** type "image": a pasted image inlined as a data URL (no SourceAsset exists for it). Kept
   *  small (guarded at paste time, ~2MB) — this lives in the project graph, not OPFS/cloud. */
  dataUrl?: string | undefined;
  /** type "shape": pure visual organizer (backdrop rect/ellipse, or a styled arrow). */
  shapeKind?: NoteShapeKind | undefined;
  /** NLE link (round 2 P2): this card points at a moment on the main composition's transport. */
  linkedTime?: number | undefined;
  /** NLE link (round 2 P2): this card points at a specific timeline clip. */
  linkedLayerId?: string | undefined;
}

export interface NoteEdge {
  id: string;
  from: string;
  to: string;
  label?: string | undefined;
  style?: "solid" | "dashed" | undefined;
  color?: string | undefined;
}

export interface NotesBoard {
  id: string;
  name: string;
  items: Record<string, NoteItem>;
  edges: NoteEdge[];
  version: number;
  view?: { panX: number; panY: number; zoom: number } | undefined;
  /** Board cover accent (Q4.2) — a small dot in the switcher + a faint dot-grid tint, so multiple
   *  boards are visually distinguishable at a glance. */
  color?: string | undefined;
}
