/**
 * Notes card body renderers (plans/notes-sonnet-execution.md M4) — pure presentational content for
 * each `NoteItemType`. Mounted inside the generic card wrapper in `NotesBoard.tsx`, which owns
 * selection/drag/resize/z-order; these components own only their own type-specific editing state
 * (title/body drafts, checklist rows) and commit through the single `onCommit` patch callback —
 * one `updateBoard` write per commit, never per keystroke.
 */

import { Fragment, useEffect, useRef, useState } from "react";
import { Clock, FileText, Globe, ImageOff, Lock, Unlock, Workflow } from "lucide-react";
import { parseNoteMarkdown, type NoteAssetKind, type NoteItem } from "@orreris/shared";
import type { SourceAsset } from "@orreris/shared";
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
      tok.kind === "bold" ? <strong key={j}>{tok.value}</strong> : tok.kind === "italic" ? <em key={j}>{tok.value}</em> : <Fragment key={j}>{tok.value}</Fragment>,
    );
    if (block.kind === "heading") {
      const Tag = block.level === 1 ? "h1" : "h2";
      return <Tag key={i} className="notes-note-md-heading">{inline}</Tag>;
    }
    if (block.kind === "bullet") {
      return (
        <div key={i} className="notes-note-md-bullet">
          <span className="notes-note-md-bullet-dot" />
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

const NOTE_MAX_AUTOGROW_H = 420;

export function NoteCardBody({
  item,
  onCommit,
  autoEdit = false,
  onAutoEditStart,
}: {
  item: NoteItem;
  onCommit: (patch: Partial<NoteItem>) => void;
  autoEdit?: boolean;
  onAutoEditStart?: () => void;
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
    return (
      <div className="notes-card-body notes-note-body is-editing" onPointerDown={(e) => e.stopPropagation()}>
        <input
          className="notes-note-title-input"
          placeholder="Title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              setTitle(item.title ?? "");
              setBody(item.body ?? "");
              setEditing(false);
            }
          }}
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
          onBlur={commitAndClose}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              setTitle(item.title ?? "");
              setBody(item.body ?? "");
              setEditing(false);
            }
          }}
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

  return (
    <div className="notes-card-body notes-todo-body" onPointerDown={(e) => e.stopPropagation()}>
      <div className="notes-todo-progress">
        {done}/{rows.length}
      </div>
      <div className="notes-todo-rows">
        {rows.map((row, i) => (
          <div className="notes-todo-row" key={i}>
            <input
              type="checkbox"
              checked={row.done}
              onChange={() => writeRows(rows.map((r, idx) => (idx === i ? { ...r, done: !r.done } : r)))}
            />
            <input
              className="notes-todo-text-input"
              value={row.text}
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
              }}
            />
          </div>
        ))}
      </div>
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
  );
}
