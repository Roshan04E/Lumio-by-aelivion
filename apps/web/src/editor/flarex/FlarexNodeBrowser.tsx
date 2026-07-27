/**
 * Flarex Add-Node browser — the shared, categorized + searchable node picker used by BOTH the
 * canvas Tab/right-click menu and the toolbar "Browse" popover (one component so the two can never
 * drift). Empty query shows a category → subcategory tree (Fusion "Add Tool" style); typing flattens
 * to a fuzzy list with keyboard nav. Built over `flarexAddableNodeTypes` today; when the node LIBRARY
 * lands (FLAREX.md Phase 2+), `buildFlarexCatalog`/`searchFlarexNodes` gain library node defs and this
 * UI scales without change.
 */

import { useMemo, useState } from "react";
import type { FlarexNodeType } from "@orreris/shared";
import { buildFlarexCatalog, searchFlarexNodes } from "./flarex-canvas-model";
import { FlarexNodeIcon } from "./flarex-node-icons";

export interface FlarexNodeBrowserProps {
  /** Add the chosen node type (the caller owns placement + wiring + closing). */
  onPick: (type: FlarexNodeType) => void;
  /** Escape / click-away closer. */
  onClose: () => void;
  autoFocus?: boolean;
}

export function FlarexNodeBrowser({ onPick, onClose, autoFocus = true }: FlarexNodeBrowserProps) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const catalog = useMemo(() => buildFlarexCatalog(), []);
  const flat = useMemo(() => searchFlarexNodes(query), [query]);
  const searching = query.trim().length > 0;
  // Keyboard nav walks the flat list (search results, or all nodes in category order when browsing).
  const active = Math.min(activeIndex, Math.max(0, flat.length - 1));

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((i) => Math.min(flat.length - 1, i + 1));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((i) => Math.max(0, i - 1));
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const item = flat[active];
      if (item) onPick(item.type);
    }
  };

  const item = (type: FlarexNodeType, label: string, meta?: string, isActive = false) => (
    <button
      key={type}
      type="button"
      className={`flarex-node-menu-item${isActive ? " is-active" : ""}`}
      onPointerDown={(e) => e.preventDefault()}
      onClick={() => onPick(type)}
    >
      <span className="flarex-node-menu-name">
        <FlarexNodeIcon type={type} size={14} />
        {label}
      </span>
      {meta ? <span className="flarex-node-menu-group">{meta}</span> : null}
    </button>
  );

  return (
    <div className="flarex-node-browser">
      <input
        className="flarex-node-menu-input"
        autoFocus={autoFocus}
        placeholder="Search nodes…"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setActiveIndex(0);
        }}
        onKeyDown={onKeyDown}
      />
      <div className="flarex-node-browser-list">
        {searching ? (
          flat.length === 0 ? (
            <div className="flarex-node-menu-empty">No matches</div>
          ) : (
            flat.map((def, i) => item(def.type, def.label, def.subcategory, i === active))
          )
        ) : (
          catalog.map((cat) => (
            <div key={cat.group} className="flarex-node-browser-cat">
              {/* Neutral category header — categories are a logical grouping, they don't paint a color. */}
              <div className="flarex-node-browser-cat-head">{cat.label}</div>
              {cat.subs.map((sub) => (
                <div key={sub.subcategory} className="flarex-node-browser-sub">
                  {/* Skip the sub-header when a single subcategory would just echo the category. */}
                  {cat.subs.length > 1 ? <div className="flarex-node-browser-sub-head">{sub.subcategory}</div> : null}
                  {sub.defs.map((def) => item(def.type, def.label))}
                </div>
              ))}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
