/**
 * Notes card body renderers (plans/notes-sonnet-execution.md M4) — pure presentational content for
 * each `NoteItemType`. Mounted inside the generic card wrapper in `NotesBoard.tsx`, which owns
 * selection/drag/resize/z-order; these components own only their own type-specific editing state
 * (title/body drafts, checklist rows) and commit through the single `onCommit` patch callback —
 * one `updateBoard` write per commit, never per keystroke.
 */

import { Fragment, useEffect, useRef, useState } from "react";
import { Clock, FileText, Globe, ImageOff, Lock, Unlock, Workflow } from "lucide-react";
import { parseNoteMarkdown, type NoteAssetKind, type NoteItem, type TextRun } from "@orreris/shared";
import type { SourceAsset } from "@orreris/shared";
import { RichTextEditor } from "../../components/RichTextEditor";
import { runsToHtml } from "../../components/rich-text-serialize";
import { NotesMediaPlayer } from "./NotesMediaPlayer";

export const NOTE_COLOR_SWATCHES = ["#e8b04b", "#e0708a", "#69c98a", "#5fb2e6", "#b58fe0", "#d5cf6d", "#8a8f98", "#ffffff"];

export function noteTint(color: string | undefined): string | undefined {
  return color ? `color-mix(in srgb, ${color} 18%, var(--nle-panel-2, #1a1d23))` : undefined;
}

export function assetKind(asset: SourceAsset): NoteAssetKind {
  if (asset.fileType?.startsWith("image/")) return "image";
  if (asset.fileType?.startsWith("audio/")) return "audio";
  if (asset.fileType?.startsWith("video/")) return "video";
  return "file";
}

/** Deterministic markdown-lite renderer (Q3.1) — maps the shared parser's AST to spans/elements.
 *  No dangerouslySetInnerHTML: every token becomes a real React node. */
function renderNoteMarkdown(text: string) {
  return parseNoteMarkdown(text).map((block, i) => {
    const inline = block.inline.map((tok, j) =>
      tok.kind === "bold" ? (
        <strong key={j}>{tok.value}</strong>
      ) : tok.kind === "italic" ? (
        <em key={j}>{tok.value}</em>
      ) : tok.kind === "code" ? (
        <code key={j} className="notes-note-md-code">{tok.value}</code>
      ) : (
        <Fragment key={j}>{tok.value}</Fragment>
      ),
    );
    if (block.kind === "heading") {
      const Tag = block.level === 1 ? "h1" : block.level === 2 ? "h2" : "h3";
      return <Tag key={i} className={`notes-note-md-heading notes-note-md-h${block.level}`}>{inline}</Tag>;
    }
    if (block.kind === "bullet") {
      return (
        <div key={i} className="notes-note-md-bullet">
          <span className="notes-note-md-bullet-dot" />
          <span>{inline}</span>
        </div>
      );
    }
    if (block.kind === "ordered") {
      return (
        <div key={i} className="notes-note-md-bullet notes-note-md-ordered">
          <span className="notes-note-md-ordered-index">{block.index}.</span>
          <span>{inline}</span>
        </div>
      );
    }
    if (block.kind === "task") {
      return (
        <div key={i} className={`notes-note-md-task${block.checked ? " is-checked" : ""}`}>
          <span className="notes-note-md-task-box" aria-hidden="true">{block.checked ? "✓" : ""}</span>
          <span>{inline}</span>
        </div>
      );
    }
    return (
      <p key={i} className="notes-note-md-paragraph">
        {inline}
      </p>
    );
  });
}

/** Shared 8-swatch color picker shown in a card's hover toolbar. */
export function ColorSwatchRow({ current, onPick }: { current: string | undefined; onPick: (color: string) => void }) {
  return (
    <div className="notes-swatch-row" onPointerDown={(e) => e.stopPropagation()}>
      {NOTE_COLOR_SWATCHES.map((c) => (
        <button
          key={c}
          type="button"
          className={`notes-swatch${current === c ? " is-active" : ""}`}
          style={{ background: c }}
          title={c}
          onClick={() => onPick(c)}
        />
      ))}
    </div>
  );
}

const NOTE_MAX_AUTOGROW_H = 2000; // effectively uncapped — the card grows with the text while editing

export function NoteCardBody({
  item,
  onCommit,
  autoEdit = false,
  onAutoEditStart,
  onEditingChange,
}: {
  item: NoteItem;
  onCommit: (patch: Partial<NoteItem>) => void;
  autoEdit?: boolean;
  onAutoEditStart?: () => void;
  /** Reported to the board so it can hide the resize handles / connector dots while this card is
   *  being edited (they otherwise sit above the inputs and swallow clicks — esp. on the Title). */
  onEditingChange?: (editing: boolean) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(item.title ?? "");
  const [body, setBody] = useState(item.body ?? "");
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    setTitle(item.title ?? "");
    setBody(item.body ?? "");
  }, [item.id]);

  useEffect(() => {
    if (autoEdit) {
      setEditing(true);
      onAutoEditStart?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoEdit]);

  useEffect(() => {
    onEditingChange?.(editing);
    return () => onEditingChange?.(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  // Auto-grow (Q3.3): the textarea's own height tracks its content while editing (visual only);
  // the FINAL scrollHeight commits as the card's `h` alongside the text, capped at a sane max.
  const autoGrow = () => {
    const el = bodyRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(NOTE_MAX_AUTOGROW_H, el.scrollHeight)}px`;
  };
  useEffect(() => {
    if (editing) autoGrow();
  }, [editing]);

  const commitAndClose = () => {
    setEditing(false);
    const patch: Partial<NoteItem> = {};
    if (title !== (item.title ?? "")) patch.title = title;
    if (body !== (item.body ?? "")) patch.body = body;
    const grown = bodyRef.current ? Math.min(NOTE_MAX_AUTOGROW_H, bodyRef.current.scrollHeight) + 56 : item.h;
    if (grown > item.h) patch.h = grown;
    if (Object.keys(patch).length > 0) onCommit(patch);
  };

  if (editing) {
    // Commit only when focus leaves the WHOLE editor — not when it moves between the title and the
    // body. (A per-field onBlur would end the session the instant you click from body → title,
    // unmounting the title before it can focus — which made the Title appear "unclickable".)
    const onContainerBlur = (e: React.FocusEvent<HTMLDivElement>) => {
      if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
      commitAndClose();
    };
    const onEscape = (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        setTitle(item.title ?? "");
        setBody(item.body ?? "");
        setEditing(false);
      }
    };
    return (
      <div className="notes-card-body notes-note-body is-editing" onPointerDown={(e) => e.stopPropagation()} onBlur={onContainerBlur}>
        <input
          className="notes-note-title-input"
          placeholder="Title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={onEscape}
        />
        <textarea
          ref={bodyRef}
          className="notes-note-body-input"
          autoFocus
          value={body}
          onChange={(e) => {
            setBody(e.target.value);
            autoGrow();
          }}
          onKeyDown={onEscape}
        />
      </div>
    );
  }

  return (
    <div className="notes-card-body notes-note-body" onDoubleClick={() => setEditing(true)}>
      {item.title ? <div className="notes-note-title">{item.title}</div> : null}
      <div className="notes-note-text">
        {item.body ? renderNoteMarkdown(item.body) : <span className="notes-note-placeholder">Double-click to edit…</span>}
      </div>
    </div>
  );
}

/** Parse a text card's stored `TextRun[]` (falling back to a single plain run from `body`). */
function textRunsOf(item: NoteItem): TextRun[] {
  if (item.runsJson) {
    try {
      const parsed = JSON.parse(item.runsJson);
      if (Array.isArray(parsed) && parsed.every((r) => typeof r?.text === "string")) return parsed as TextRun[];
    } catch {
      /* fall through to the plain body */
    }
  }
  return item.body ? [{ text: item.body }] : [{ text: "" }];
}

/** Bare rich text on the board — reuses the SAME `RichTextEditor` the Text-layer inspector uses
 *  (per-selection bold/italic/color/highlight/font/size → shared `TextRun[]`). View mode renders the
 *  runs (draggable); double-click mounts the editor; a click outside the card (but not on the font
 *  dropdown portal) commits and exits. `body` mirrors the plain text for search/markdown export. */
export function TextCardBody({
  item,
  onCommit,
  autoEdit = false,
  onAutoEditStart,
  onEditingChange,
}: {
  item: NoteItem;
  onCommit: (patch: Partial<NoteItem>) => void;
  autoEdit?: boolean;
  onAutoEditStart?: () => void;
  onEditingChange?: (editing: boolean) => void;
}) {
  const [editing, setEditing] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const runs = textRunsOf(item);

  useEffect(() => {
    if (autoEdit) {
      setEditing(true);
      onAutoEditStart?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoEdit]);
  useEffect(() => {
    onEditingChange?.(editing);
    return () => onEditingChange?.(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  // Persist the grown height so view mode keeps the size the text reached while editing (the card
  // auto-grew via .is-grow-editing). Grow-only — resize down manually if you want it smaller.
  const exitEditing = () => {
    const el = containerRef.current?.querySelector(".rich-text-editor") as HTMLElement | null;
    if (el) {
      const grown = Math.round(el.scrollHeight + 28);
      if (grown > (item.h ?? 0)) onCommit({ h: grown });
    }
    setEditing(false);
  };

  // Exit editing on a pointerdown outside the card — but ignore clicks inside the ThemedSelect font
  // portal (rendered at document root), so choosing a font doesn't close the editor.
  useEffect(() => {
    if (!editing) return undefined;
    const onDown = (e: PointerEvent) => {
      const t = e.target as HTMLElement | null;
      if (!t) return;
      if (containerRef.current?.contains(t)) return;
      if (t.closest(".themed-select-menu")) return;
      exitEditing();
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  if (editing) {
    return (
      <div ref={containerRef} className="notes-card-body notes-text-body is-editing" onPointerDown={(e) => e.stopPropagation()}>
        <RichTextEditor
          layerId={item.id}
          runs={runs}
          palette={NOTE_COLOR_SWATCHES}
          onCommit={(nextRuns, plain) => onCommit({ runsJson: nextRuns ? JSON.stringify(nextRuns) : undefined, body: plain })}
        />
      </div>
    );
  }
  const isEmpty = runs.every((r) => !r.text);
  return (
    <div className="notes-card-body notes-text-body" style={item.color ? { color: item.color } : undefined} onDoubleClick={() => setEditing(true)}>
      {isEmpty ? (
        <span className="notes-note-placeholder">Double-click to edit…</span>
      ) : (
        <div className="notes-text-render" dangerouslySetInnerHTML={{ __html: runsToHtml(runs) }} />
      )}
    </div>
  );
}

/** Markdown document card (Obsidian-style): a reading view of rendered markdown; double-click opens
 *  a LIVE split editor — raw markdown on the left, rendered preview on the right, updating as you
 *  type. Supports `#`/`##`/`###`, `**bold**`, `*italic*`, `` `code` ``, `-`/`*` bullets, `1.`
 *  ordered lists and `- [ ]`/`- [x]` task items (shared markdown-lite parser). */
export function DocCardBody({
  item,
  onCommit,
  autoEdit = false,
  onAutoEditStart,
  onEditingChange,
}: {
  item: NoteItem;
  onCommit: (patch: Partial<NoteItem>) => void;
  autoEdit?: boolean;
  onAutoEditStart?: () => void;
  onEditingChange?: (editing: boolean) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState(item.body ?? "");

  useEffect(() => setBody(item.body ?? ""), [item.id]);
  useEffect(() => {
    if (autoEdit) {
      setEditing(true);
      onAutoEditStart?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoEdit]);
  useEffect(() => {
    onEditingChange?.(editing);
    return () => onEditingChange?.(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  const commitAndClose = () => {
    setEditing(false);
    if (body !== (item.body ?? "")) onCommit({ body });
  };

  if (editing) {
    return (
      <div
        className="notes-card-body notes-doc-body is-editing"
        onPointerDown={(e) => e.stopPropagation()}
        onBlur={(e) => {
          if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
          commitAndClose();
        }}
      >
        <div className="notes-doc-split">
          <textarea
            className="notes-doc-input"
            autoFocus
            value={body}
            placeholder={"# Title\n\nWrite **markdown** here…\n\n- a bullet\n- [ ] a task"}
            spellCheck={false}
            onChange={(e) => setBody(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setBody(item.body ?? "");
                setEditing(false);
              }
            }}
          />
          <div className="notes-doc-preview notes-doc-preview-live">
            {body.trim() ? renderNoteMarkdown(body) : <span className="notes-note-placeholder">Preview…</span>}
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="notes-card-body notes-doc-body" onDoubleClick={() => setEditing(true)}>
      <div className="notes-doc-preview">
        {item.body?.trim() ? renderNoteMarkdown(item.body) : <span className="notes-note-placeholder">Double-click to write markdown…</span>}
      </div>
    </div>
  );
}

export function AssetCardBody({ item, assets, onOpenSource }: { item: NoteItem; assets: SourceAsset[]; onOpenSource?: (() => void) | undefined }) {
  const asset = item.assetId ? assets.find((a) => a.id === item.assetId) : undefined;
  const openProps = onOpenSource ? { onDoubleClick: (e: React.MouseEvent) => { e.stopPropagation(); onOpenSource(); } } : {};

  if (!asset) {
    return (
      <div className="notes-card-body notes-asset-body notes-asset-missing">
        <FileText size={20} />
        <span>Missing media</span>
      </div>
    );
  }

  const name = asset.originalName || asset.fileName;
  const kind = assetKind(asset);
  const thumb = asset.thumbnailUrl ?? asset.previewUrl ?? asset.proxyUrl ?? asset.fileUrl;

  if (kind === "image") {
    return (
      <div className="notes-card-body notes-asset-body" {...openProps}>
        <img src={thumb} alt={name} draggable={false} />
        <div className="notes-asset-name">{name}</div>
      </div>
    );
  }
  if (kind === "video") {
    const src = asset.previewUrl ?? asset.proxyUrl ?? asset.fileUrl;
    // Poster must be an IMAGE — only thumbnailUrl qualifies. `thumb` falls back to previewUrl/
    // proxyUrl/fileUrl, all of which are VIDEO urls: as a <video poster> they render black AND
    // suppress the first-frame nudge. Pass thumbnailUrl only (undefined for local clips → the
    // player decodes + paints the real first frame instead of a black box).
    return (
      <div className="notes-card-body notes-asset-body notes-asset-player" {...openProps}>
        <NotesMediaPlayer variant="video" src={src} peaksUrl={asset.fileUrl} poster={asset.thumbnailUrl} name={name} />
      </div>
    );
  }
  if (kind === "audio") {
    return (
      <div className="notes-card-body notes-asset-body notes-asset-player" {...openProps}>
        <NotesMediaPlayer variant="audio" src={asset.fileUrl} peaksUrl={asset.fileUrl} name={name} />
      </div>
    );
  }
  return (
    <div className="notes-card-body notes-asset-body notes-asset-file" {...openProps}>
      <FileText size={20} />
      <span className="notes-asset-name">{name}</span>
    </div>
  );
}

/** Zero-CORS favicon (Q3.2): `https://<host>/favicon.ico` — no metadata fetch, just an <img> with
 *  an onError fallback to the plain globe icon. */
function LinkFavicon({ url }: { url: string | undefined }) {
  const [failed, setFailed] = useState(false);
  const host = (() => {
    if (!url) return null;
    try {
      return new URL(url).host;
    } catch {
      return null;
    }
  })();
  if (!host || failed) return <Globe size={14} />;
  return <img className="notes-link-favicon" src={`https://${host}/favicon.ico`} alt="" onError={() => setFailed(true)} />;
}

export function LinkCardBody({ item, onCommit }: { item: NoteItem; onCommit: (patch: Partial<NoteItem>) => void }) {
  const [editingTitle, setEditingTitle] = useState(false);
  const [title, setTitle] = useState(item.title ?? "");
  useEffect(() => setTitle(item.title ?? ""), [item.id]);

  return (
    <div className="notes-card-body notes-link-body">
      <div className="notes-link-head">
        <LinkFavicon url={item.url} />
        {editingTitle ? (
          <input
            className="notes-link-title-input"
            autoFocus
            value={title}
            onPointerDown={(e) => e.stopPropagation()}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={() => {
              setEditingTitle(false);
              if (title !== (item.title ?? "")) onCommit({ title });
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              if (e.key === "Escape") {
                setTitle(item.title ?? "");
                setEditingTitle(false);
              }
            }}
          />
        ) : (
          <span className="notes-link-title" onDoubleClick={() => setEditingTitle(true)}>
            {item.title || "Untitled link"}
          </span>
        )}
      </div>
      <a
        className="notes-link-url"
        href={item.url}
        target="_blank"
        rel="noopener noreferrer"
        onPointerDown={(e) => e.stopPropagation()}
      >
        {item.url}
      </a>
    </div>
  );
}

/**
 * Q5.1 moved the frame title's DOUBLE-click to "focus this frame" (fit the view to it) — rename
 * now triggers on a SINGLE click while the frame is already selected (the common desktop-icon
 * rename idiom), so the two affordances never collide on the same gesture.
 */
export function FrameTitleBody({
  item,
  selected,
  onCommit,
  onFocusFrame,
}: {
  item: NoteItem;
  selected: boolean;
  onCommit: (patch: Partial<NoteItem>) => void;
  onFocusFrame?: (() => void) | undefined;
}) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(item.title ?? "Frame");
  useEffect(() => setTitle(item.title ?? "Frame"), [item.id]);

  if (editing) {
    return (
      <input
        className="notes-frame-title-input"
        autoFocus
        value={title}
        onPointerDown={(e) => e.stopPropagation()}
        onChange={(e) => setTitle(e.target.value)}
        onBlur={() => {
          setEditing(false);
          if (title.trim() && title !== item.title) onCommit({ title: title.trim() });
          else setTitle(item.title ?? "Frame");
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") {
            setTitle(item.title ?? "Frame");
            setEditing(false);
          }
        }}
      />
    );
  }
  return (
    <span
      className="notes-frame-title"
      onClick={(e) => {
        if (!selected) return;
        e.stopPropagation();
        setEditing(true);
      }}
      onDoubleClick={(e) => {
        e.stopPropagation();
        onFocusFrame?.();
      }}
    >
      {item.title || "Frame"}
    </span>
  );
}

export function ImageCardBody({ item }: { item: NoteItem }) {
  const src = item.dataUrl ?? item.url;
  if (!src) {
    return (
      <div className="notes-card-body notes-asset-body notes-asset-missing">
        <ImageOff size={20} />
        <span>No image</span>
      </div>
    );
  }
  return (
    <div className="notes-card-body notes-asset-body">
      <img src={src} alt={item.title ?? "Pasted image"} draggable={false} />
    </div>
  );
}

/** Pure visual organizer: a tinted rect/ellipse backdrop. Arrows are NOT rendered here — they're
 *  a straight line drawn into the connector SVG overlay (see `NotesBoard.tsx`), since an arrow's
 *  only visual content IS the line, not a box. */
export function ShapeCardBody({ item }: { item: NoteItem }) {
  if (item.shapeKind === "arrow") return null;
  return (
    <div
      className={`notes-shape-body notes-shape-${item.shapeKind ?? "rect"}`}
      style={{ background: `color-mix(in srgb, ${item.color ?? "#8a8f98"} 22%, transparent)`, borderColor: item.color ?? "#8a8f98" }}
    />
  );
}

/** Clock chip + optional Flarex-jump glyph, shown when a card is linked to a moment on the
 *  transport (P2 NLE link; Q2.1 extends it with the cross-page Flarex jump). Neither button steals
 *  the card's own drag/select gesture. */
export function LinkedTimeRow({
  seconds,
  onSeek,
  hasFlarexComp = false,
  onOpenFlarex,
}: {
  seconds: number;
  onSeek: () => void;
  hasFlarexComp?: boolean;
  onOpenFlarex?: (() => void) | undefined;
}) {
  const label = `${Math.floor(seconds / 60)}:${Math.floor(seconds % 60).toString().padStart(2, "0")}`;
  return (
    <div className="notes-linked-time-row" onPointerDown={(e) => e.stopPropagation()}>
      <button
        type="button"
        className="notes-linked-time-chip"
        title={`Linked to ${label} on the timeline — click to seek`}
        onClick={(e) => {
          e.stopPropagation();
          onSeek();
        }}
      >
        <Clock size={10} />
        {label}
      </button>
      {hasFlarexComp ? (
        <button
          type="button"
          className="notes-linked-flarex-btn"
          title="Open this clip's Flarex comp"
          onClick={(e) => {
            e.stopPropagation();
            onOpenFlarex?.();
          }}
        >
          <Workflow size={10} />
        </button>
      ) : null}
    </div>
  );
}

/** Hover-toolbar lock toggle (Q4.3) — available on ANY item type, not just frames. */
export function LockToggleButton({ locked, onToggle }: { locked: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      className="notes-lock-btn"
      title={locked ? "Unlock" : "Lock (not draggable/resizable/deletable until unlocked)"}
      onClick={onToggle}
    >
      {locked ? <Lock size={11} /> : <Unlock size={11} />}
    </button>
  );
}

interface TodoRow {
  text: string;
  done: boolean;
}

function parseTodos(json: string | undefined): TodoRow[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((r) => typeof r?.text === "string") : [];
  } catch {
    return [];
  }
}

export function TodoCardBody({ item, onCommit }: { item: NoteItem; onCommit: (patch: Partial<NoteItem>) => void }) {
  const rows = parseTodos(item.todosJson);
  const [draft, setDraft] = useState("");

  const writeRows = (next: TodoRow[]) => onCommit({ todosJson: JSON.stringify(next) });
  const done = rows.filter((r) => r.done).length;
  const pct = rows.length > 0 ? Math.round((done / rows.length) * 100) : 0;

  return (
    <div className="notes-card-body notes-todo-body" onPointerDown={(e) => e.stopPropagation()}>
      <div className="notes-todo-head">
        <div className="notes-todo-bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
          <span className="notes-todo-bar-fill" style={{ width: `${pct}%` }} />
        </div>
        <span className="notes-todo-count">
          {done}/{rows.length}
        </span>
      </div>
      <div className="notes-todo-rows">
        {rows.map((row, i) => (
          <label className={`notes-todo-row${row.done ? " is-done" : ""}`} key={i}>
            <input
              type="checkbox"
              className="notes-todo-check"
              checked={row.done}
              onChange={() => writeRows(rows.map((r, idx) => (idx === i ? { ...r, done: !r.done } : r)))}
            />
            <input
              className="notes-todo-text-input"
              value={row.text}
              placeholder="Item"
              onChange={(e) => writeRows(rows.map((r, idx) => (idx === i ? { ...r, text: e.target.value } : r)))}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  if (row.text.trim() === "") {
                    writeRows(rows.filter((_, idx) => idx !== i));
                  } else {
                    writeRows([...rows.slice(0, i + 1), { text: "", done: false }, ...rows.slice(i + 1)]);
                  }
                }
                if (e.key === "Backspace" && row.text === "" && rows.length > 1) {
                  e.preventDefault();
                  writeRows(rows.filter((_, idx) => idx !== i));
                }
              }}
            />
          </label>
        ))}
        {rows.length === 0 ? <div className="notes-todo-empty">No items yet</div> : null}
      </div>
      <div className="notes-todo-add">
        <span className="notes-todo-add-plus">＋</span>
        <input
          className="notes-todo-new-input"
          placeholder="Add item…"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && draft.trim()) {
              writeRows([...rows, { text: draft.trim(), done: false }]);
              setDraft("");
            }
          }}
        />
      </div>
    </div>
  );
}
