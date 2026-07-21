/**
 * NotesIntent — the Notes-board AI DSL (plans/notes-sonnet-execution-2.md P1), cloned
 * structurally from `flarex/node-graph-intent.ts` (itself cloned from `color/grade-intent.ts`):
 * the LLM emits a COMPACT, Zod-`.strict()`-validated intent; this deterministic compiler expands
 * it into real, individually-editable board items + edges. The model never sets pixel coordinates
 * that matter — the compiler owns layout — so output is the same board the user could build by
 * hand, and identical intent → identical board (ids derived from a running counter, not
 * randomness), so repeat runs are cache/verify-friendly.
 *
 * `connect.fromRef`/`toRef` are 1-based indices into the FLAT list of every item created by every
 * op so far (in creation order, across the whole `ops` array) — NOT board ids. Out-of-range refs
 * are skipped, never thrown (a bad LLM ref shouldn't kill the whole board).
 */

import { z } from "zod";
import { createNotesBoard } from "./registry";
import type { NoteItem, NotesBoard } from "./types";

const noteItemSchema = z
  .object({
    op: z.literal("addNote"),
    text: z.string().min(1),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
    x: z.number().optional(),
    y: z.number().optional(),
  })
  .strict();

const frameItemSchema = z
  .object({
    op: z.literal("addFrame"),
    title: z.string().min(1),
    x: z.number().optional(),
    y: z.number().optional(),
    w: z.number().min(80).optional(),
    h: z.number().min(48).optional(),
  })
  .strict();

const connectSchema = z
  .object({
    op: z.literal("connect"),
    fromRef: z.number().int().min(1),
    toRef: z.number().int().min(1),
    label: z.string().optional(),
  })
  .strict();

// Mindmap branches can nest one level of typed object OR be plain strings; z.lazy for recursion.
type MindmapBranchInput = string | { text: string; children?: MindmapBranchInput[] | undefined };
const mindmapBranchSchema: z.ZodType<MindmapBranchInput> = z.lazy(() =>
  z.union([
    z.string().min(1),
    z
      .object({
        text: z.string().min(1),
        children: z.array(mindmapBranchSchema).optional(),
      })
      .strict(),
  ]),
);

const mindmapSchema = z
  .object({
    op: z.literal("mindmap"),
    root: z.string().min(1),
    branches: z.array(mindmapBranchSchema).min(1).max(16),
  })
  .strict();

const todoSchema = z
  .object({
    op: z.literal("todo"),
    title: z.string().min(1),
    items: z.array(z.string().min(1)).min(1).max(40),
  })
  .strict();

export const notesIntentSchema = z
  .object({
    ops: z.array(z.discriminatedUnion("op", [noteItemSchema, frameItemSchema, connectSchema, mindmapSchema, todoSchema])).min(1).max(24),
  })
  .strict();

export type NotesIntent = z.infer<typeof notesIntentSchema>;

/** One compiled op, for transcripts/approval UI (mirrors CompiledNodeGraphOp). */
export interface CompiledNotesOp {
  itemIds: string[];
  summary: string;
}

export interface CompiledNotesIntent {
  board: NotesBoard;
  ops: CompiledNotesOp[];
}

const NOTE_SIZE = { w: 220, h: 160 };
const FRAME_SIZE = { w: 360, h: 260 };
const TODO_SIZE = { w: 240, h: 200 };
const AUTO_COL_W = 260;
const AUTO_ROW_H = 200;
const AUTO_PER_ROW = 4;

function normalizeBranch(branch: MindmapBranchInput): { text: string; children: MindmapBranchInput[] } {
  return typeof branch === "string" ? { text: branch, children: [] } : { text: branch.text, children: branch.children ?? [] };
}

/**
 * Expand a validated intent into a board. `base` (default: a fresh empty board) keeps its
 * existing items/edges untouched — new content is appended after them (never rebuilds).
 */
export function compileNotesIntent(intent: NotesIntent, base?: NotesBoard): CompiledNotesIntent {
  const board: NotesBoard = base
    ? { ...base, items: { ...base.items }, edges: [...base.edges] }
    : createNotesBoard("AI Board");

  // Auto-placement cursor: start to the right of any existing content so re-running intents onto
  // an authored board doesn't stack new items directly on top of old ones.
  let maxExistingRight = 0;
  for (const item of Object.values(board.items)) maxExistingRight = Math.max(maxExistingRight, item.x + item.w);
  let autoIndex = 0;
  const originX = maxExistingRight > 0 ? maxExistingRight + 80 : 0;

  let seq = 0;
  const nextId = (prefix: string): string => {
    seq += 1;
    return `${board.id}_ai${seq}_${prefix}`;
  };

  let maxZ = 0;
  for (const item of Object.values(board.items)) maxZ = Math.max(maxZ, item.z);
  const nextZ = (): number => {
    maxZ += 1;
    return maxZ;
  };

  const createdItems: NoteItem[] = [];
  const addItem = (item: NoteItem): NoteItem => {
    board.items[item.id] = item;
    createdItems.push(item);
    return item;
  };
  const addEdge = (fromId: string, toId: string, label?: string): void => {
    board.edges.push({ id: nextId("e"), from: fromId, to: toId, label });
  };

  const autoPos = (): { x: number; y: number } => {
    const col = autoIndex % AUTO_PER_ROW;
    const row = Math.floor(autoIndex / AUTO_PER_ROW);
    autoIndex += 1;
    return { x: originX + col * AUTO_COL_W, y: row * AUTO_ROW_H };
  };

  const compiled: CompiledNotesOp[] = [];

  intent.ops.forEach((op) => {
    switch (op.op) {
      case "addNote": {
        const pos = op.x !== undefined && op.y !== undefined ? { x: op.x, y: op.y } : autoPos();
        const item = addItem({ id: nextId("note"), type: "note", x: pos.x, y: pos.y, w: NOTE_SIZE.w, h: NOTE_SIZE.h, z: nextZ(), body: op.text, color: op.color });
        compiled.push({ itemIds: [item.id], summary: `Note: ${op.text.slice(0, 40)}` });
        break;
      }
      case "addFrame": {
        const pos = op.x !== undefined && op.y !== undefined ? { x: op.x, y: op.y } : autoPos();
        const item = addItem({
          id: nextId("frame"),
          type: "frame",
          x: pos.x,
          y: pos.y,
          w: op.w ?? FRAME_SIZE.w,
          h: op.h ?? FRAME_SIZE.h,
          z: 0,
          title: op.title,
        });
        compiled.push({ itemIds: [item.id], summary: `Frame: ${op.title}` });
        break;
      }
      case "todo": {
        const pos = autoPos();
        const item = addItem({
          id: nextId("todo"),
          type: "todo",
          x: pos.x,
          y: pos.y,
          w: TODO_SIZE.w,
          h: TODO_SIZE.h,
          z: nextZ(),
          title: op.title,
          todosJson: JSON.stringify(op.items.map((text) => ({ text, done: false }))),
        });
        compiled.push({ itemIds: [item.id], summary: `Todo: ${op.title} (${op.items.length} items)` });
        break;
      }
      case "mindmap": {
        const start = autoPos();
        // Reserve extra auto-slots so the next op doesn't land inside this mindmap's footprint.
        const ids: string[] = [];
        const build = (text: string, branches: MindmapBranchInput[], x: number, yTop: number): { id: string; height: number } => {
          const children: { id: string; height: number }[] = [];
          let y = yTop;
          for (const raw of branches) {
            const b = normalizeBranch(raw);
            const res = build(b.text, b.children, x + 260, y);
            children.push(res);
            y += res.height + 24;
          }
          const subtreeHeight = children.length > 0 ? y - 24 - yTop : NOTE_SIZE.h;
          const rootY = children.length > 0 ? yTop + subtreeHeight / 2 - NOTE_SIZE.h / 2 : yTop;
          const item = addItem({ id: nextId("mm"), type: "note", x, y: rootY, w: NOTE_SIZE.w, h: NOTE_SIZE.h, z: nextZ(), body: text });
          ids.push(item.id);
          for (const child of children) addEdge(item.id, child.id);
          return { id: item.id, height: Math.max(subtreeHeight, NOTE_SIZE.h) };
        };
        build(op.root, op.branches, start.x, start.y);
        compiled.push({ itemIds: ids, summary: `Mindmap: ${op.root} (${op.branches.length} branches)` });
        break;
      }
      case "connect": {
        const from = createdItems[op.fromRef - 1];
        const to = createdItems[op.toRef - 1];
        if (!from || !to) break; // out-of-range ref — skip, never throw
        addEdge(from.id, to.id, op.label);
        compiled.push({ itemIds: [], summary: `Connect ${op.fromRef} → ${op.toRef}` });
        break;
      }
    }
  });

  return { board, ops: compiled };
}

export type { MindmapBranchInput };
