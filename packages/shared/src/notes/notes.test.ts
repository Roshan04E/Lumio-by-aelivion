/**
 * Standalone assert script for the Notes board contract (repo convention: no test framework —
 * exits non-zero on failure).
 *
 *   pnpm --filter @orreris/shared notes:test
 */
import {
  boardToMarkdown,
  cloneNoteItems,
  deleteNotesBoard,
  duplicateNotesBoard,
  ensureDefaultNotesBoard,
  itemsInsideFrame,
  notesForLayer,
  renameNotesBoard,
  stampNotesBoard,
} from "./registry";
import { defaultSizeForAsset } from "./notes-layout";
import { parseNoteMarkdown, parseNoteMarkdownInline } from "./notes-markdown";
import type { NoteEdge, NoteItem, NotesBoard } from "./types";
import type { ProjectGraph } from "../types";

let failures = 0;
function check(name: string, condition: boolean): void {
  if (condition) {
    console.log(`  ok  ${name}`);
  } else {
    failures += 1;
    console.error(`FAIL  ${name}`);
  }
}

function graphFixture(): ProjectGraph {
  return { projectId: "p1", effects: [], editableFields: {}, version: 1 };
}

function item(over: Partial<NoteItem> & Pick<NoteItem, "id" | "type">): NoteItem {
  return { x: 0, y: 0, w: 100, h: 100, z: 1, ...over };
}

// --- ensureDefaultNotesBoard idempotence -------------------------------------
{
  const graph = graphFixture();
  const first = ensureDefaultNotesBoard(graph);
  check("first call creates a board", Object.keys(first.graph.notesBoards ?? {}).length === 1);
  check("first call sets activeNotesBoardId", first.graph.activeNotesBoardId === first.boardId);

  const second = ensureDefaultNotesBoard(first.graph);
  check("second call is a no-op (same graph object)", second.graph === first.graph);
  check("second call returns the same boardId", second.boardId === first.boardId);
}

// --- stampNotesBoard bumps version --------------------------------------------
{
  const graph = graphFixture();
  const { graph: g1, boardId } = ensureDefaultNotesBoard(graph);
  const board = g1.notesBoards![boardId]!;
  const g2 = stampNotesBoard(g1, { ...board, name: "Renamed" });
  check("stamp bumps version", g2.notesBoards![boardId]!.version === board.version + 1);
  check("stamp preserves name change", g2.notesBoards![boardId]!.name === "Renamed");
}

// --- cloneNoteItems id remap + edge preservation ------------------------------
{
  const a = item({ id: "a", type: "note", x: 10, y: 10 });
  const b = item({ id: "b", type: "note", x: 50, y: 50 });
  const outside = item({ id: "c", type: "note", x: 90, y: 90 });
  const edgeInternal: NoteEdge = { id: "e1", from: "a", to: "b" };
  const edgeExternal: NoteEdge = { id: "e2", from: "a", to: "c" };
  const cloned = cloneNoteItems([a, b], [edgeInternal, edgeExternal], 24, 24);

  check("clones same count of items", cloned.items.length === 2);
  check("cloned items get fresh ids", cloned.items.every((it) => it.id !== "a" && it.id !== "b"));
  check("cloned items are offset", cloned.items.find((it) => it.x === 34 && it.y === 34) !== undefined);
  check("internal edge is preserved", cloned.edges.length === 1);
  const clonedEdge = cloned.edges[0]!;
  const clonedIds = new Set(cloned.items.map((it) => it.id));
  check("cloned edge endpoints map to cloned items", clonedIds.has(clonedEdge.from) && clonedIds.has(clonedEdge.to));
  check("edge touching an out-of-set item is dropped", cloned.edges.every((e) => e.id !== "e2"));

  const originalOutsideUntouched = outside.x === 90;
  check("original items untouched by clone", originalOutsideUntouched);
}

// --- itemsInsideFrame center rule ---------------------------------------------
{
  const frame = item({ id: "f", type: "frame", x: 0, y: 0, w: 200, h: 200 });
  const insideCenter = item({ id: "in", type: "note", x: 50, y: 50, w: 20, h: 20 }); // center 60,60 -> inside
  const straddling = item({ id: "straddle", type: "note", x: 190, y: 190, w: 40, h: 40 }); // center 210,210 -> outside
  const lockedInside = item({ id: "locked", type: "note", x: 50, y: 50, w: 20, h: 20, locked: true });
  const board: NotesBoard = {
    id: "b1",
    name: "Board",
    items: { f: frame, in: insideCenter, straddle: straddling, locked: lockedInside },
    edges: [],
    version: 1,
  };
  const captured = itemsInsideFrame(board, "f");
  check("captures item whose center is inside the frame", captured.some((it) => it.id === "in"));
  check("excludes item whose center is outside the frame", !captured.some((it) => it.id === "straddle"));
  check("excludes locked items", !captured.some((it) => it.id === "locked"));
  check("excludes the frame itself", !captured.some((it) => it.id === "f"));
}

// --- round-trip JSON.parse(JSON.stringify(board)) deep-equal ------------------
{
  const board: NotesBoard = {
    id: "b2",
    name: "Round trip",
    items: {
      n1: item({ id: "n1", type: "note", title: "Hi", body: "line1\nline2", color: "#ff0000" }),
    },
    edges: [{ id: "e1", from: "n1", to: "n1", label: "self", style: "dashed" }],
    version: 3,
    view: { panX: 10, panY: -5, zoom: 1.5 },
  };
  const roundTripped = JSON.parse(JSON.stringify(board));
  check("round-trip is deep-equal", JSON.stringify(roundTripped) === JSON.stringify(board));
}

// --- renameNotesBoard ----------------------------------------------------------
{
  const graph = graphFixture();
  const { graph: g1, boardId } = ensureDefaultNotesBoard(graph);
  const g2 = renameNotesBoard(g1, boardId, "  Research  ");
  check("rename trims + applies the new name", g2.notesBoards![boardId]!.name === "Research");
  const g3 = renameNotesBoard(g2, boardId, "Research");
  check("renaming to the same name is a no-op (same graph object)", g3 === g2);
  const g4 = renameNotesBoard(g2, "missing", "X");
  check("renaming a missing board is a no-op", g4 === g2);
}

// --- deleteNotesBoard ------------------------------------------------------------
{
  const graph = graphFixture();
  const { graph: g1, boardId: firstId } = ensureDefaultNotesBoard(graph);
  const guarded = deleteNotesBoard(g1, firstId);
  check("deleting the LAST board is a no-op (same graph object)", guarded === g1);

  const g2 = stampNotesBoard(g1, { id: "board2", name: "Second", items: {}, edges: [], version: 1 });
  const g3 = deleteNotesBoard(g2, firstId);
  check("deletes the board", g3.notesBoards![firstId] === undefined);
  check("second board survives", Boolean(g3.notesBoards!["board2"]));
  check("active board moves off the deleted one", g3.activeNotesBoardId === "board2");
}

// --- notesForLayer ---------------------------------------------------------------
{
  const linked = item({ id: "n1", type: "note", linkedLayerId: "layerA" });
  const unlinked = item({ id: "n2", type: "note" });
  const board: NotesBoard = { id: "b3", name: "Board", items: { n1: linked, n2: unlinked }, edges: [], version: 1 };
  const found = notesForLayer(board, "layerA");
  check("finds the note linked to the layer", found.length === 1 && found[0]?.id === "n1");
  check("does not match unlinked notes", notesForLayer(board, "layerB").length === 0);
}

// --- boardToMarkdown ---------------------------------------------------------------
{
  const frame = item({ id: "f1", type: "frame", x: 0, y: 0, w: 400, h: 400, title: "Research" });
  const noteInFrame = item({ id: "n1", type: "note", x: 20, y: 20, w: 100, h: 100, title: "Idea", body: "Do the thing" });
  const todoOutside = item({ id: "t1", type: "todo", x: 500, y: 0, title: "Shots", todosJson: JSON.stringify([{ text: "Wide", done: true }, { text: "Close", done: false }]) });
  const shape = item({ id: "s1", type: "shape", x: 0, y: 0, shapeKind: "rect" });
  const board: NotesBoard = { id: "b4", name: "Outline Test", items: { f1: frame, n1: noteInFrame, t1: todoOutside, s1: shape }, edges: [], version: 1 };
  const md = boardToMarkdown(board);
  check("markdown starts with the board title", md.startsWith("# Outline Test"));
  check("frame becomes a heading", md.includes("## Research"));
  check("note becomes a bullet with its body", md.includes("Do the thing"));
  check("todo becomes checkbox lines", md.includes("[x] Wide") && md.includes("[ ] Close"));
  check("shape (pure visual) produces no line", !md.includes("shape"));
}

// --- duplicateNotesBoard ---------------------------------------------------------
{
  const graph = graphFixture();
  const { graph: g1, boardId } = ensureDefaultNotesBoard(graph);
  const g2 = stampNotesBoard(g1, {
    ...g1.notesBoards![boardId]!,
    items: { n1: item({ id: "n1", type: "note", body: "original" }) },
    edges: [],
  });
  const dup = duplicateNotesBoard(g2, boardId);
  check("duplicate returns a result", dup !== null);
  if (dup) {
    const { graph: g3, boardId: dupId } = dup;
    check("duplicate gets a fresh board id", dupId !== boardId);
    check("duplicate is named '... copy'", g3.notesBoards![dupId]!.name.endsWith(" copy"));
    check("duplicate becomes active", g3.activeNotesBoardId === dupId);
    const dupItem = Object.values(g3.notesBoards![dupId]!.items)[0];
    check("duplicate has one remapped item", dupItem !== undefined && dupItem.id !== "n1" && dupItem.body === "original");
    check("original board untouched", g3.notesBoards![boardId]!.items.n1?.body === "original");
  }
  const missing = duplicateNotesBoard(g2, "missing");
  check("duplicating a missing board returns null", missing === null);
}

// --- defaultSizeForAsset -----------------------------------------------------------
{
  const audio = defaultSizeForAsset("audio");
  check("audio size is wide-short", audio.w > audio.h);
  const file = defaultSizeForAsset("file");
  check("file size is compact", file.w <= 240 && file.h <= 72);
  const video = defaultSizeForAsset("video", 1920, 1080);
  check("video derives 16:9 aspect from real dimensions", Math.abs(video.w / video.h - 1920 / 1080) < 0.01);
  const videoFallback = defaultSizeForAsset("video");
  check("video falls back without dimensions", videoFallback.w > 0 && videoFallback.h > 0);
  const image = defaultSizeForAsset("image", 4000, 2000);
  check("image size is capped, not the full 4000px", image.w <= 320 && image.h <= 320);
  check("image aspect is preserved after capping", Math.abs(image.w / image.h - 2) < 0.05);
  const tinyImage = defaultSizeForAsset("image", 40, 40);
  check("tiny image is grown to the minimum footprint", tinyImage.w >= 160);
}

// --- markdown-lite parser (Q3.1) ---------------------------------------------------
{
  const bold = parseNoteMarkdownInline("hello **world** end");
  check("bold token extracted", bold.some((t) => t.kind === "bold" && t.value === "world"));
  check("surrounding text preserved around bold", bold.some((t) => t.kind === "text" && t.value === "hello "));

  const italic = parseNoteMarkdownInline("a *b* c");
  check("italic token extracted", italic.some((t) => t.kind === "italic" && t.value === "b"));

  const plain = parseNoteMarkdownInline("no markup here");
  check("plain text round-trips as a single text token", plain.length === 1 && plain[0]?.kind === "text" && plain[0]?.value === "no markup here");

  const blocks = parseNoteMarkdown("# Title\n## Subtitle\n- item one\nplain line");
  check("h1 detected", blocks[0]?.kind === "heading" && blocks[0].level === 1);
  check("h2 detected", blocks[1]?.kind === "heading" && blocks[1].level === 2);
  check("bullet detected", blocks[2]?.kind === "bullet");
  check("plain line is a paragraph", blocks[3]?.kind === "paragraph");

  const escaped = parseNoteMarkdown("just # not a heading because no space after")[0];
  check("a mid-line '#' is NOT a heading", escaped?.kind === "paragraph");

  // Relaxed headings: the space after the hashes is optional (`##Heading` works).
  const noSpace = parseNoteMarkdown("##little bellintel")[0];
  check("'##' without a space is still an h2", noSpace?.kind === "heading" && noSpace.level === 2);
  const noSpaceInline = noSpace?.kind === "heading" ? noSpace.inline.map((t) => t.value).join("") : "";
  check("no-space heading keeps its full text", noSpaceInline === "little bellintel");

  // Escape hatch: a leading backslash keeps the line literal.
  const literalHash = parseNoteMarkdown("\\# not a heading")[0];
  check("leading backslash escapes a heading", literalHash?.kind === "paragraph");
  check("backslash escape strips only the backslash", literalHash?.kind === "paragraph" && literalHash.inline.map((t) => t.value).join("") === "# not a heading");

  // Inline code, ordered + task blocks (doc card).
  const code = parseNoteMarkdownInline("run `npm test` now");
  check("inline code token extracted", code.some((t) => t.kind === "code" && t.value === "npm test"));
  const ordered = parseNoteMarkdown("1. first")[0];
  check("ordered item detected", ordered?.kind === "ordered" && ordered.index === 1);
  const taskDone = parseNoteMarkdown("- [x] done")[0];
  check("checked task detected", taskDone?.kind === "task" && taskDone.checked === true);
  const taskOpen = parseNoteMarkdown("- [ ] open")[0];
  check("open task detected", taskOpen?.kind === "task" && taskOpen.checked === false);
}

// --- locked items excluded from frame drag-capture (Q4.3) --------------------------
{
  const frame = item({ id: "f2", type: "frame", x: 0, y: 0, w: 300, h: 300 });
  const locked = item({ id: "lockedMember", type: "note", x: 50, y: 50, w: 20, h: 20, locked: true });
  const unlocked = item({ id: "freeMember", type: "note", x: 100, y: 100, w: 20, h: 20 });
  const board: NotesBoard = { id: "b5", name: "Board", items: { f2: frame, lockedMember: locked, freeMember: unlocked }, edges: [], version: 1 };
  const captured = itemsInsideFrame(board, "f2");
  check("locked member is excluded from the frame's drag-capture set", !captured.some((it) => it.id === "lockedMember"));
  check("unlocked member IS captured", captured.some((it) => it.id === "freeMember"));
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
} else {
  console.log("\nAll notes checks passed.");
}
