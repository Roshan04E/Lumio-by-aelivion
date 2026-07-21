/**
 * Notes card body renderers (plans/notes-sonnet-execution.md M4) — pure presentational content for
 * each `NoteItemType`. Mounted inside the generic card wrapper in `NotesBoard.tsx`, which owns
 * selection/drag/resize/z-order; these components own only their own type-specific editing state
 * (title/body drafts, checklist rows) and commit through the single `onCommit` patch callback —
 * one `updateBoard` write per commit, never per keystroke.
 */

import { useEffect, useRef, useState } from "react";
import { Clock, FileText, Globe, ImageOff } from "lucide-react";
import type { NoteItem } from "@orreris/shared";
import type { SourceAsset } from "@orreris/shared";
import { NotesMediaPlayer } from "./NotesMediaPlayer";

export const NOTE_COLOR_SWATCHES = ["#e8b04b", "#e0708a", "#69c98a", "#5fb2e6", "#b58fe0", "#d5cf6d", "#8a8f98", "#ffffff"];

export function noteTint(color: string | undefined): string | undefined {
  return color ? `color-mix(in srgb, ${color} 18%, var(--nle-panel-2, #1a1d23))` : undefined;
}

function assetKind(asset: SourceAsset): "video" | "image" | "audio" | "file" {
  if (asset.fileType?.startsWith("image/")) return "image";
  if (asset.fileType?.startsWith("audio/")) return "audio";
  if (asset.fileType?.startsWith("video/")) return "video";
  return "file";
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

  const commitAndClose = () => {
    setEditing(false);
    const patch: Partial<NoteItem> = {};
    if (title !== (item.title ?? "")) patch.title = title;
    if (body !== (item.body ?? "")) patch.body = body;
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
          onChange={(e) => setBody(e.target.value)}
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
      <div className="notes-note-text">{item.body || <span className="notes-note-placeholder">Double-click to edit…</span>}</div>
    </div>
  );
}

export function AssetCardBody({ item, assets }: { item: NoteItem; assets: SourceAsset[] }) {
  const asset = item.assetId ? assets.find((a) => a.id === item.assetId) : undefined;

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
      <div className="notes-card-body notes-asset-body">
        <img src={thumb} alt={name} draggable={false} />
        <div className="notes-asset-name">{name}</div>
      </div>
    );
  }
  if (kind === "video") {
    const src = asset.previewUrl ?? asset.proxyUrl ?? asset.fileUrl;
    return (
      <div className="notes-card-body notes-asset-body notes-asset-player">
        <NotesMediaPlayer variant="video" src={src} peaksUrl={asset.fileUrl} poster={thumb} name={name} />
      </div>
    );
  }
  if (kind === "audio") {
    return (
      <div className="notes-card-body notes-asset-body notes-asset-player">
        <NotesMediaPlayer variant="audio" src={asset.fileUrl} peaksUrl={asset.fileUrl} name={name} />
      </div>
    );
  }
  return (
    <div className="notes-card-body notes-asset-body notes-asset-file">
      <FileText size={20} />
      <span className="notes-asset-name">{name}</span>
    </div>
  );
}

export function LinkCardBody({ item, onCommit }: { item: NoteItem; onCommit: (patch: Partial<NoteItem>) => void }) {
  const [editingTitle, setEditingTitle] = useState(false);
  const [title, setTitle] = useState(item.title ?? "");
  useEffect(() => setTitle(item.title ?? ""), [item.id]);

  return (
    <div className="notes-card-body notes-link-body">
      <div className="notes-link-head">
        <Globe size={14} />
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

export function FrameTitleBody({ item, onCommit }: { item: NoteItem; onCommit: (patch: Partial<NoteItem>) => void }) {
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
    <span className="notes-frame-title" onDoubleClick={(e) => { e.stopPropagation(); setEditing(true); }}>
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

/** Small clock chip shown when a card is linked to a moment on the transport (P2 NLE link).
 *  Click seeks the playhead there; never steals the card's own drag/select gesture. */
export function LinkedTimeChip({ seconds, onSeek }: { seconds: number; onSeek: () => void }) {
  const label = `${Math.floor(seconds / 60)}:${Math.floor(seconds % 60).toString().padStart(2, "0")}`;
  return (
    <button
      type="button"
      className="notes-linked-time-chip"
      title={`Linked to ${label} on the timeline — click to seek`}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        onSeek();
      }}
    >
      <Clock size={10} />
      {label}
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
