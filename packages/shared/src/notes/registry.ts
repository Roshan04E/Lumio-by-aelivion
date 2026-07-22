/**
 * Notes board registry seam (plans/notes-sonnet-execution.md M1) — mirrors the Flarex
 * registry pattern (`packages/shared/src/flarex/registry.ts`): boards live first-class in
 * `ProjectGraph.notesBoards`, and every write path goes through `stampNotesBoard` so the
 * board's `version` (the render/persist dirty key) always bumps on mutation.
 */

import type { ProjectGraph } from "../types";
import type { NoteEdge, NoteItem, NotesBoard } from "./types";

let noteIdCounter = 0;
function nextNoteId(prefix: string): string {
  noteIdCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${noteIdCounter.toString(36)}`;
}

export function createNotesBoard(name: string): NotesBoard {
  return {
    id: nextNoteId("board"),
    name,
    items: {},
    edges: [],
    version: 1,
  };
}

/** Write-through seam: store/replace a board in the registry with its version bumped. */
export function stampNotesBoard(graph: ProjectGraph, board: NotesBoard): ProjectGraph {
  const stamped: NotesBoard = { ...board, version: (board.version ?? 0) + 1 };
  return { ...graph, notesBoards: { ...(graph.notesBoards ?? {}), [stamped.id]: stamped } };
}

/**
 * Guarantees `graph.activeNotesBoardId` points at a board in `graph.notesBoards`, auto-creating
 * a default board on first use. No-op (same graph object) when a valid active board exists.
 */
export function ensureDefaultNotesBoard(graph: ProjectGraph): { graph: ProjectGraph; boardId: string } {
  const activeId = graph.activeNotesBoardId;
  if (activeId && graph.notesBoards?.[activeId]) {
    return { graph, boardId: activeId };
  }
  const existingId = graph.notesBoards ? Object.keys(graph.notesBoards)[0] : undefined;
  if (existingId) {
    return { graph: { ...graph, activeNotesBoardId: existingId }, boardId: existingId };
  }
  const board = createNotesBoard("Board 1");
  const next: ProjectGraph = {
    ...graph,
    notesBoards: { ...(graph.notesBoards ?? {}), [board.id]: board },
    activeNotesBoardId: board.id,
  };
  return { graph: next, boardId: board.id };
}

/**
 * The clipboard core: clones `items` (+ any `edges` whose both endpoints are in the set) with
 * fresh ids, offsetting positions and remapping edge endpoints to the new ids. Edges touching an
 * item outside the cloned set are dropped (mirrors `cloneFlarexNodes`'s internal-edge remap).
 */
export function cloneNoteItems(
  items: NoteItem[],
  edges: NoteEdge[],
  offsetX = 24,
  offsetY = 24,
): { items: NoteItem[]; edges: NoteEdge[] } {
  const idMap = new Map<string, string>();
  for (const item of items) idMap.set(item.id, nextNoteId("item"));
  const clonedItems = items.map((item) => ({
    ...item,
    id: idMap.get(item.id)!,
    x: item.x + offsetX,
    y: item.y + offsetY,
  }));
  const clonedEdges = edges
    .filter((edge) => idMap.has(edge.from) && idMap.has(edge.to))
    .map((edge) => ({
      ...edge,
      id: nextNoteId("edge"),
      from: idMap.get(edge.from)!,
      to: idMap.get(edge.to)!,
    }));
  return { items: clonedItems, edges: clonedEdges };
}

/**
 * Items whose CENTER lies inside `frame`'s rect, excluding the frame itself and locked items —
 * the "captured by this frame" set, computed fresh at frame-drag start (never stored).
 */
export function itemsInsideFrame(board: NotesBoard, frameId: string): NoteItem[] {
  const frame = board.items[frameId];
  if (!frame || frame.type !== "frame") return [];
  const left = frame.x;
  const top = frame.y;
  const right = frame.x + frame.w;
  const bottom = frame.y + frame.h;
  return Object.values(board.items).filter((item) => {
    if (item.id === frameId || item.type === "frame" || item.locked) return false;
    const cx = item.x + item.w / 2;
    const cy = item.y + item.h / 2;
    return cx >= left && cx <= right && cy >= top && cy <= bottom;
  });
}

/**
 * Rename a board (plans/notes-sonnet-execution-2.md P3). No-op (same graph object) when the
 * board doesn't exist, the name is blank, or it's unchanged.
 */
export function renameNotesBoard(graph: ProjectGraph, boardId: string, name: string): ProjectGraph {
  const board = graph.notesBoards?.[boardId];
  const trimmed = name.trim();
  if (!board || !trimmed || trimmed === board.name) return graph;
  return stampNotesBoard(graph, { ...board, name: trimmed });
}

/**
 * Delete a board (P3). Guarded: NEVER deletes the last board (no-op, same graph object) — a
 * project must always have somewhere for the board switcher to land. If the deleted board was
 * active, `activeNotesBoardId` moves to another remaining board.
 */
export function deleteNotesBoard(graph: ProjectGraph, boardId: string): ProjectGraph {
  const boards = graph.notesBoards;
  if (!boards || !boards[boardId]) return graph;
  const ids = Object.keys(boards);
  if (ids.length <= 1) return graph;
  const nextBoards = { ...boards };
  delete nextBoards[boardId];
  const activeId = graph.activeNotesBoardId === boardId ? Object.keys(nextBoards)[0] : graph.activeNotesBoardId;
  return { ...graph, notesBoards: nextBoards, activeNotesBoardId: activeId };
}

/**
 * Duplicate a board (Q4.1): fresh board id, every item/edge id remapped via the existing
 * `cloneNoteItems` (no position offset — a duplicate should land exactly where the original was,
 * it's a NEW board, not an overlapping paste), name suffixed " copy". Returns
 * `{ graph, boardId }` with the duplicate made active, mirroring `ensureDefaultNotesBoard`'s shape.
 */
export function duplicateNotesBoard(graph: ProjectGraph, boardId: string): { graph: ProjectGraph; boardId: string } | null {
  const source = graph.notesBoards?.[boardId];
  if (!source) return null;
  const { items: clonedItems, edges: clonedEdges } = cloneNoteItems(Object.values(source.items), source.edges, 0, 0);
  const board: NotesBoard = {
    id: nextNoteId("board"),
    name: `${source.name} copy`,
    items: Object.fromEntries(clonedItems.map((item) => [item.id, item])),
    edges: clonedEdges,
    version: 1,
    view: source.view,
    color: source.color,
  };
  const next: ProjectGraph = {
    ...graph,
    notesBoards: { ...(graph.notesBoards ?? {}), [board.id]: board },
    activeNotesBoardId: board.id,
  };
  return { graph: next, boardId: board.id };
}

/** Notes linked to a timeline clip (P2 reverse-direction: clip → notes). */
export function notesForLayer(board: NotesBoard, layerId: string): NoteItem[] {
  return Object.values(board.items).filter((item) => item.linkedLayerId === layerId);
}

interface TodoRow {
  text: string;
  done: boolean;
}
function parseTodoRows(json: string | undefined): TodoRow[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((r) => typeof r?.text === "string") : [];
  } catch {
    return [];
  }
}

function itemToMarkdown(item: NoteItem): string | null {
  switch (item.type) {
    case "note":
      return `- ${item.title ? `**${item.title}:** ` : ""}${item.body ?? ""}`.trim() || null;
    case "text":
      return `- ${item.body ?? item.title ?? ""}`.trim() || null;
    case "doc":
      // A doc IS markdown — emit it verbatim (its own headings/lists flow straight into the outline).
      return item.body?.trim() ? item.body.trim() : null;
    case "todo": {
      const rows = parseTodoRows(item.todosJson);
      const header = `- **${item.title || "Todo"}**`;
      return [header, ...rows.map((r) => `  - [${r.done ? "x" : " "}] ${r.text}`)].join("\n");
    }
    case "link":
      return `- [${item.title || item.url || "Link"}](${item.url ?? ""})`;
    case "asset":
      return `- 🎬 ${item.title || "Media"}`;
    case "image":
      return `- 🖼️ ${item.title || "Image"}`;
    case "frame":
    case "shape":
      return null; // frames become headings (handled by the caller); shapes are pure visual
    default:
      return null;
  }
}

/**
 * Board → Markdown outline (P6): frames become `##` headings (their captured members nest under
 * them), notes/links/todos/assets/images become bullets (todos as checkbox sub-lists), pure
 * visual items (shapes, connectors) are ignored. Order follows each group's y-then-x reading order.
 */
export function boardToMarkdown(board: NotesBoard): string {
  const items = Object.values(board.items);
  const frames = items.filter((item) => item.type === "frame").sort((a, b) => a.y - b.y || a.x - b.x);
  const grouped = new Set<string>();
  const lines: string[] = [`# ${board.name}`];
  for (const frame of frames) {
    lines.push("", `## ${frame.title || "Frame"}`);
    const members = itemsInsideFrame(board, frame.id).sort((a, b) => a.y - b.y || a.x - b.x);
    for (const member of members) {
      grouped.add(member.id);
      const line = itemToMarkdown(member);
      if (line) lines.push(line);
    }
  }
  const rest = items.filter((item) => item.type !== "frame" && !grouped.has(item.id)).sort((a, b) => a.y - b.y || a.x - b.x);
  if (rest.length > 0) {
    if (frames.length > 0) lines.push("", "## Ungrouped");
    for (const item of rest) {
      const line = itemToMarkdown(item);
      if (line) lines.push(line);
    }
  }
  return `${lines.join("\n").trim()}\n`;
}
