/**
 * Standalone assert script for the NotesIntent AI DSL (repo convention: no test framework —
 * exits non-zero on failure).
 *
 *   pnpm --filter @orreris/shared notes:intent:test
 */
import { compileNotesIntent, notesIntentSchema } from "./notes-intent";
import { createNotesBoard } from "./registry";

type Rect = { x: number; y: number; w: number; h: number };
function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.x <= b.x + b.w && a.x + a.w >= b.x && a.y <= b.y + b.h && a.y + a.h >= b.y;
}

let failures = 0;
function check(name: string, condition: boolean): void {
  if (condition) {
    console.log(`  ok  ${name}`);
  } else {
    failures += 1;
    console.error(`FAIL  ${name}`);
  }
}

// --- Schema round-trip ---------------------------------------------------------
{
  const intent = {
    ops: [
      { op: "addNote" as const, text: "Hello" },
      { op: "addFrame" as const, title: "Research" },
      { op: "todo" as const, title: "Shot list", items: ["Wide", "Close-up"] },
      { op: "mindmap" as const, root: "Video", branches: ["Hook", "Body", "CTA"] },
      { op: "connect" as const, fromRef: 1, toRef: 2 },
    ],
  };
  const parsed = notesIntentSchema.safeParse(intent);
  check("valid intent parses", parsed.success);
  if (parsed.success) {
    const roundTripped = notesIntentSchema.parse(JSON.parse(JSON.stringify(parsed.data)));
    check("schema round-trips through JSON", JSON.stringify(roundTripped) === JSON.stringify(parsed.data));
  }
  const rejected = notesIntentSchema.safeParse({ ops: [{ op: "addNote", text: "x", bogus: 1 }] });
  check("strict schema rejects unknown keys", !rejected.success);
  const empty = notesIntentSchema.safeParse({ ops: [] });
  check("empty ops array rejected (min 1)", !empty.success);
}

// --- Mindmap: 3 branches -> 1 root + 3 children + 3 edges, non-overlapping ------
{
  const { board } = compileNotesIntent({ ops: [{ op: "mindmap", root: "Video", branches: ["Hook", "Body", "CTA"] }] });
  const items = Object.values(board.items);
  check("mindmap produces 4 items (1 root + 3 children)", items.length === 4);
  check("mindmap produces 3 edges", board.edges.length === 3);
  const root = items.find((it) => it.body === "Video");
  check("root exists", Boolean(root));
  check("every edge originates at the root", board.edges.every((e) => e.from === root?.id));
  let overlapping = false;
  for (let i = 0; i < items.length; i += 1) {
    for (let j = i + 1; j < items.length; j += 1) {
      if (rectsIntersect(items[i]!, items[j]!)) overlapping = true;
    }
  }
  check("no two mindmap items overlap", !overlapping);
}

// --- Nested mindmap branches -----------------------------------------------------
{
  const { board } = compileNotesIntent({
    ops: [{ op: "mindmap", root: "Root", branches: [{ text: "A", children: ["A1", "A2"] }, "B"] }],
  });
  check("nested mindmap produces 5 items (root, A, A1, A2, B)", Object.keys(board.items).length === 5);
  check("nested mindmap produces 4 edges", board.edges.length === 4);
}

// --- connect: out-of-range ref is skipped, never throws --------------------------
{
  let threw = false;
  let result: ReturnType<typeof compileNotesIntent> | null = null;
  try {
    result = compileNotesIntent({
      ops: [
        { op: "addNote", text: "One" },
        { op: "connect", fromRef: 1, toRef: 99 },
      ],
    });
  } catch {
    threw = true;
  }
  check("out-of-range connect ref never throws", !threw);
  check("out-of-range connect ref produces no edge", result !== null && result.board.edges.length === 0);
}

// --- connect: valid refs across ops (1-based, flat creation order) ---------------
{
  const { board } = compileNotesIntent({
    ops: [
      { op: "addNote", text: "First" },
      { op: "addNote", text: "Second" },
      { op: "connect", fromRef: 1, toRef: 2, label: "leads to" },
    ],
  });
  check("valid connect produces exactly 1 edge", board.edges.length === 1);
  check("connect edge carries its label", board.edges[0]?.label === "leads to");
}

// --- Compiling onto a base board preserves existing items -----------------------
{
  const base = createNotesBoard("Existing");
  const withExisting = { ...base, items: { keep1: { id: "keep1", type: "note" as const, x: 0, y: 0, w: 220, h: 160, z: 1, body: "keep me" } } };
  const { board } = compileNotesIntent({ ops: [{ op: "addNote", text: "New" }] }, withExisting);
  check("existing item preserved", Boolean(board.items.keep1));
  check("existing item content untouched", board.items.keep1?.body === "keep me");
  check("new item added alongside it", Object.keys(board.items).length === 2);
}

// --- todo op --------------------------------------------------------------------
{
  const { board } = compileNotesIntent({ ops: [{ op: "todo", title: "Checklist", items: ["a", "b", "c"] }] });
  const item = Object.values(board.items)[0];
  check("todo item created", item?.type === "todo");
  const rows = item?.todosJson ? JSON.parse(item.todosJson) : [];
  check("todo has 3 rows, all not done", rows.length === 3 && rows.every((r: { done: boolean }) => r.done === false));
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
} else {
  console.log("\nAll notes-intent checks passed.");
}
