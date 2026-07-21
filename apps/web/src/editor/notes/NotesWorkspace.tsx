/**
 * Notes workspace (plans/notes-sonnet-execution.md M2/M6, round 2 plans/notes-sonnet-execution-2.md
 * P1/P3/P5/P6) — the page body that replaces the viewer+inspector area while the Notes page is
 * active: toolbar (top) → board (center). Monolith containment: EditorPage passes only
 * { graph, assets, onUpdateGraph, currentTime, onSeek, onNotesPrompt, focusRequest } —
 * everything else lives in this subtree, mirroring `FlarexWorkspace.tsx`.
 */

import { useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  Circle,
  Frame as FrameIcon,
  Link2,
  ListChecks,
  Minus,
  MoveUpRight,
  Plus,
  Search,
  Sparkles,
  Square,
  StickyNote,
  Trash2,
} from "lucide-react";
import {
  boardToMarkdown,
  compileNotesIntent,
  createNotesBoard,
  deleteNotesBoard,
  ensureDefaultNotesBoard,
  renameNotesBoard,
  stampNotesBoard,
  type NoteItem,
  type NoteItemType,
  type NoteShapeKind,
  type NotesBoard as NotesBoardData,
  type NotesIntent,
  type ProjectGraph,
  type SourceAsset,
} from "@orreris/shared";
import { NotesBoard } from "./NotesBoard";
import { clampZoom, fitViewFor, nextZOrder, screenToWorld, zoomAt, type NotesViewState } from "./notes-board-model";

const DEFAULT_SIZE: Record<NoteItemType, { w: number; h: number }> = {
  note: { w: 220, h: 160 },
  link: { w: 240, h: 88 },
  frame: { w: 360, h: 260 },
  todo: { w: 240, h: 200 },
  asset: { w: 260, h: 160 },
  image: { w: 260, h: 180 },
  shape: { w: 200, h: 140 },
};

function nextId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

/** Fixed starter layouts (P5.3) — each is a `NotesIntent`, compiled through the SAME deterministic
 *  P1 compiler a "Generate" prompt would use, so there's no second layout code path. */
const TEMPLATES: Record<string, NotesIntent> = {
  Mindmap: { ops: [{ op: "mindmap", root: "Central idea", branches: ["Branch 1", "Branch 2", "Branch 3"] }] },
  Kanban: {
    ops: [
      { op: "addFrame", title: "To do" },
      { op: "addFrame", title: "Doing" },
      { op: "addFrame", title: "Done" },
    ],
  },
  Moodboard: {
    ops: [
      { op: "addFrame", title: "Moodboard" },
      { op: "addNote", text: "Drag reference images here" },
      { op: "addNote", text: "Drag reference images here" },
      { op: "addNote", text: "Drag reference images here" },
    ],
  },
  "Shot list": { ops: [{ op: "addFrame", title: "Shots" }, { op: "todo", title: "Shot list", items: ["Wide", "Medium", "Close-up"] }] },
};

export interface NotesWorkspaceProps {
  graph: ProjectGraph;
  assets: SourceAsset[];
  onUpdateGraph: (nextGraph: ProjectGraph) => void;
  /** Shared transport playhead (P2 NLE link). */
  currentTime: number;
  /** Seeks the shared transport (P2). */
  onSeek: (seconds: number) => void;
  /** "✦ Generate" submit (P1) — EditorPage owns the real routing (fenced this round); this round
   *  only ships the compiler + this UI entry point. */
  onNotesPrompt?: ((text: string) => void) | undefined;
  /** Reverse-direction jump (P2.3): a clip's note badge was double-clicked. */
  focusRequest?: { layerId: string; nonce: number } | null | undefined;
}

export function NotesWorkspace({ graph, assets, onUpdateGraph, currentTime, onSeek, onNotesPrompt, focusRequest }: NotesWorkspaceProps) {
  const boardId = graph.activeNotesBoardId;
  const board = boardId ? graph.notesBoards?.[boardId] : undefined;
  const viewportRef = useRef<HTMLDivElement | null>(null);

  // Auto-create the default board once (idempotent — ensureDefaultNotesBoard no-ops when one exists).
  useEffect(() => {
    const { graph: next } = ensureDefaultNotesBoard(graph);
    if (next !== graph) onUpdateGraph({ ...next, version: graph.version + 1 });
  }, [graph, onUpdateGraph]);

  const [view, setView] = useState<NotesViewState>(() => ({
    panX: board?.view?.panX ?? 0,
    panY: board?.view?.panY ?? 0,
    zoom: clampZoom(board?.view?.zoom ?? 1),
  }));
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const lastBoardIdRef = useRef<string | undefined>(board?.id);
  useEffect(() => {
    if (board && board.id !== lastBoardIdRef.current) {
      lastBoardIdRef.current = board.id;
      setView({ panX: board.view?.panX ?? 0, panY: board.view?.panY ?? 0, zoom: clampZoom(board.view?.zoom ?? 1) });
      setSelectedIds([]);
    }
  }, [board]);

  const updateBoard = (updater: (board: NotesBoardData) => NotesBoardData) => {
    if (!board) return;
    const current = graph.notesBoards?.[board.id];
    if (!current) return;
    const next = updater(current);
    if (next === current) return;
    onUpdateGraph({ ...stampNotesBoard(graph, next), version: graph.version + 1 });
  };

  // Debounced view persistence — settle-only writes (~500ms), never one commit per pointer event.
  const viewSaveTimer = useRef<number | null>(null);
  useEffect(() => {
    if (!board) return undefined;
    if (viewSaveTimer.current) window.clearTimeout(viewSaveTimer.current);
    viewSaveTimer.current = window.setTimeout(() => {
      updateBoard((current) => {
        if (current.view?.panX === view.panX && current.view?.panY === view.panY && current.view?.zoom === view.zoom) return current;
        return { ...current, view };
      });
    }, 500);
    return () => {
      if (viewSaveTimer.current) window.clearTimeout(viewSaveTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, board?.id]);

  const viewportCenterWorld = (): { x: number; y: number } => {
    const rect = viewportRef.current?.getBoundingClientRect();
    const w = rect?.width ?? 800;
    const h = rect?.height ?? 500;
    const [wx, wy] = screenToWorld(view, w / 2, h / 2);
    return { x: wx, y: wy };
  };

  const addItem = (type: NoteItemType, extra?: Partial<NoteItem>) => {
    const center = viewportCenterWorld();
    const size = DEFAULT_SIZE[type];
    const id = nextId("item");
    updateBoard((current) => {
      const item: NoteItem = {
        id,
        type,
        x: Math.round(center.x - size.w / 2),
        y: Math.round(center.y - size.h / 2),
        w: size.w,
        h: size.h,
        z: nextZOrder(current.items, type === "frame" || type === "shape"),
        ...(type === "todo" ? { todosJson: "[]" } : {}),
        ...(type === "link" ? { url: "" } : {}),
        ...extra,
      };
      return { ...current, items: { ...current.items, [id]: item } };
    });
    setSelectedIds([id]);
  };

  const addShape = (shapeKind: NoteShapeKind) => addItem("shape", { shapeKind, color: "#8a8f98" });

  const fit = () => {
    const rect = viewportRef.current?.getBoundingClientRect();
    if (!rect || !board) return;
    const pool = selectedIds.length > 0 ? selectedIds.map((id) => board.items[id]).filter((x): x is NoteItem => Boolean(x)) : Object.values(board.items);
    const next = fitViewFor(pool, rect.width, rect.height);
    if (next) setView(next);
  };

  const zoomStep = (factor: number) => {
    const rect = viewportRef.current?.getBoundingClientRect();
    const w = rect?.width ?? 800;
    const h = rect?.height ?? 500;
    setView((v) => zoomAt(v, w / 2, h / 2, factor));
  };

  // Fit once when a board first opens (never blank/off-screen).
  const fittedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!board || fittedRef.current === board.id) return;
    fittedRef.current = board.id;
    if (Object.keys(board.items).length === 0) return;
    const id = window.setTimeout(fit, 0);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [board?.id]);

  /** Group as frame (P5.2): a frame sized to the selection bounds + 24px padding, placed in the
   *  low z-band so the members sit on top and move with it (`itemsInsideFrame` captures them). */
  const frameSelection = () => {
    if (!board || selectedIds.length === 0) return;
    const items = selectedIds.map((id) => board.items[id]).filter((x): x is NoteItem => Boolean(x));
    if (items.length === 0) return;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const it of items) {
      x0 = Math.min(x0, it.x);
      y0 = Math.min(y0, it.y);
      x1 = Math.max(x1, it.x + it.w);
      y1 = Math.max(y1, it.y + it.h);
    }
    const pad = 24;
    const id = nextId("item");
    updateBoard((current) => ({
      ...current,
      items: {
        ...current.items,
        [id]: { id, type: "frame", x: Math.round(x0 - pad), y: Math.round(y0 - pad), w: Math.round(x1 - x0 + pad * 2), h: Math.round(y1 - y0 + pad * 2), z: 0, title: "Group" },
      },
    }));
    setSelectedIds([id]);
  };

  const applyTemplate = (name: string) => {
    const intent = TEMPLATES[name];
    if (!intent) return;
    updateBoard((current) => compileNotesIntent(intent, current).board);
  };

  const exportOutline = () => {
    if (!board) return;
    const md = boardToMarkdown(board);
    void navigator.clipboard?.writeText(md).catch(() => undefined);
  };

  if (!board) {
    return <div className="notes-workspace notes-workspace-empty">Loading Notes…</div>;
  }

  return (
    <div className="notes-workspace">
      <div className="notes-toolbar">
        <BoardSwitcher graph={graph} activeBoardId={board.id} onUpdateGraph={onUpdateGraph} />
        <div className="notes-toolbar-group">
          <button type="button" className="notes-toolbar-btn" title="Add Note" onClick={() => addItem("note")}>
            <StickyNote size={13} /> Note
          </button>
          <button type="button" className="notes-toolbar-btn" title="Add Frame" onClick={() => addItem("frame")}>
            <FrameIcon size={13} /> Frame
          </button>
          <button type="button" className="notes-toolbar-btn" title="Add Link" onClick={() => addItem("link")}>
            <Link2 size={13} /> Link
          </button>
          <button type="button" className="notes-toolbar-btn" title="Add Todo" onClick={() => addItem("todo")}>
            <ListChecks size={13} /> Todo
          </button>
        </div>
        <div className="notes-toolbar-group">
          <button type="button" className="notes-toolbar-btn" title="Add Rectangle" onClick={() => addShape("rect")}>
            <Square size={13} />
          </button>
          <button type="button" className="notes-toolbar-btn" title="Add Ellipse" onClick={() => addShape("ellipse")}>
            <Circle size={13} />
          </button>
          <button type="button" className="notes-toolbar-btn" title="Add Arrow" onClick={() => addShape("arrow")}>
            <MoveUpRight size={13} />
          </button>
          <button type="button" className="notes-toolbar-btn" title="Frame selection" disabled={selectedIds.length === 0} onClick={frameSelection}>
            Frame selection
          </button>
        </div>
        <TemplateMenu onApply={applyTemplate} />
        <GeneratePrompt onSubmit={onNotesPrompt} />
        <div className="notes-toolbar-group notes-toolbar-zoom">
          <button type="button" className="notes-toolbar-btn" title="Export outline (Markdown → clipboard)" onClick={exportOutline}>
            Export outline
          </button>
          <button type="button" className="notes-toolbar-btn" title="Zoom out" onClick={() => zoomStep(1 / 1.2)}>
            <Minus size={12} />
          </button>
          <span className="notes-zoom-readout">{Math.round(view.zoom * 100)}%</span>
          <button type="button" className="notes-toolbar-btn" title="Zoom in" onClick={() => zoomStep(1.2)}>
            <Plus size={12} />
          </button>
          <button type="button" className="notes-toolbar-btn" title="Fit (F)" onClick={fit}>
            Fit
          </button>
        </div>
      </div>
      <NotesBoard
        board={board}
        assets={assets}
        onUpdateBoard={updateBoard}
        view={view}
        onViewChange={setView}
        selectedIds={selectedIds}
        onSelectIds={setSelectedIds}
        viewportRef={viewportRef}
        onFit={fit}
        currentTime={currentTime}
        onSeek={onSeek}
        focusRequest={focusRequest}
      />
    </div>
  );
}

/** Board dropdown (P3): current board name + caret, opens a popover listing every board with
 *  switch/rename(double-click)/delete(inline confirm), plus "+ New board". Deleting is guarded at
 *  the registry level (`deleteNotesBoard` never removes the last board) — the trash icon simply
 *  doesn't render when only one board remains. Cross-board paste stays impossible: the board
 *  clipboard in `NotesBoard.tsx` already clears whenever `board.id` changes (verified round 1). */
function BoardSwitcher({ graph, activeBoardId, onUpdateGraph }: { graph: ProjectGraph; activeBoardId: string; onUpdateGraph: (next: ProjectGraph) => void }) {
  const [open, setOpen] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const boards = Object.values(graph.notesBoards ?? {}).sort((a, b) => a.name.localeCompare(b.name));
  const active = graph.notesBoards?.[activeBoardId];

  useEffect(() => {
    if (!open) return undefined;
    const onDocDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDocDown);
    return () => document.removeEventListener("mousedown", onDocDown);
  }, [open]);

  const switchTo = (id: string) => {
    onUpdateGraph({ ...graph, activeNotesBoardId: id, version: graph.version + 1 });
    setOpen(false);
  };
  const createBoard = () => {
    const created = createNotesBoard(`Board ${boards.length + 1}`);
    onUpdateGraph({ ...stampNotesBoard(graph, created), activeNotesBoardId: created.id, version: graph.version + 1 });
    setOpen(false);
  };

  return (
    <div className="notes-board-switcher" ref={rootRef}>
      <button type="button" className="notes-board-switcher-btn" onClick={() => setOpen((v) => !v)}>
        <span>{active?.name ?? "Board"}</span>
        <ChevronDown size={12} />
      </button>
      {open ? (
        <div className="notes-board-switcher-menu">
          {boards.map((b) => (
            <div key={b.id} className={`notes-board-switcher-row${b.id === activeBoardId ? " is-active" : ""}`}>
              {renamingId === b.id ? (
                <input
                  autoFocus
                  className="notes-board-switcher-rename-input"
                  value={renameDraft}
                  onChange={(e) => setRenameDraft(e.target.value)}
                  onBlur={() => {
                    onUpdateGraph(renameNotesBoard(graph, b.id, renameDraft));
                    setRenamingId(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                    if (e.key === "Escape") setRenamingId(null);
                  }}
                />
              ) : (
                <button
                  type="button"
                  className="notes-board-switcher-name"
                  onClick={() => switchTo(b.id)}
                  onDoubleClick={() => {
                    setRenamingId(b.id);
                    setRenameDraft(b.name);
                  }}
                >
                  {b.name}
                </button>
              )}
              {confirmDeleteId === b.id ? (
                <button
                  type="button"
                  className="notes-board-switcher-delete-confirm"
                  onClick={() => {
                    onUpdateGraph(deleteNotesBoard(graph, b.id));
                    setConfirmDeleteId(null);
                  }}
                  onBlur={() => setConfirmDeleteId(null)}
                >
                  Confirm?
                </button>
              ) : boards.length > 1 ? (
                <button type="button" className="notes-board-switcher-delete" title="Delete board" onClick={() => setConfirmDeleteId(b.id)}>
                  <Trash2 size={11} />
                </button>
              ) : null}
            </div>
          ))}
          <button type="button" className="notes-board-switcher-add" onClick={createBoard}>
            <Plus size={11} /> New board
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** "+ from template" menu (P5.3): stamps a fixed starter layout via the P1 compiler. */
function TemplateMenu({ onApply }: { onApply: (name: string) => void }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return undefined;
    const onDocDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDocDown);
    return () => document.removeEventListener("mousedown", onDocDown);
  }, [open]);
  return (
    <div className="notes-board-switcher" ref={rootRef}>
      <button type="button" className="notes-toolbar-btn" onClick={() => setOpen((v) => !v)}>
        ＋ from template
      </button>
      {open ? (
        <div className="notes-board-switcher-menu">
          {Object.keys(TEMPLATES).map((name) => (
            <button
              key={name}
              type="button"
              className="notes-board-switcher-name"
              onClick={() => {
                onApply(name);
                setOpen(false);
              }}
            >
              {name}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** "✦ Generate" prompt (P1): a one-line input; submit calls `onSubmit`. The real LLM routing is
 *  fenced this round (Fable) — `onSubmit` is a stub for now. */
function GeneratePrompt({ onSubmit }: { onSubmit?: ((text: string) => void) | undefined }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  if (!open) {
    return (
      <button type="button" className="notes-toolbar-btn notes-generate-btn" title="Generate with AI" onClick={() => setOpen(true)}>
        <Sparkles size={13} /> Generate
      </button>
    );
  }
  return (
    <form
      className="notes-generate-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (text.trim()) {
          onSubmit?.(text.trim());
          setText("");
          setOpen(false);
        }
      }}
    >
      <Search size={11} />
      <input
        autoFocus
        placeholder="Describe what to add to the board…"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          if (!text.trim()) setOpen(false);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") setOpen(false);
        }}
      />
    </form>
  );
}

export default NotesWorkspace;
