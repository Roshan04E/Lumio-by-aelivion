import { ChevronDown, ChevronRight, Plus, Search, Sparkles, Star, Trash2, X } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  type ProjectEffect,
  type TimelineEffectType,
  type TimelineLayerType,
  type TransitionDirection,
  type TransitionKind
} from "@reelforge/shared";
import { buildEffectCatalog, effectPanelCategories, transitionGalleryCategories, type CatalogItem, type TransitionGroup } from "../editor/effects/catalog";
import { loadFavourites, saveFavourites } from "../editor/effects/favourites";
import { useVideoPoster } from "../lib/videoThumbnails";
import { Badge } from "./Badge";
import { Button } from "./Button";
import { TransitionThumb } from "./TransitionThumb";

/** How many transition tiles the inline strip shows before the "Show more" full gallery. */
const TRANSITION_STRIP_CAP = 7;

/** The transition spec the panel hands to the editor (duration is filled in there). */
export interface TransitionApplySpec {
  kind: TransitionKind;
  direction?: TransitionDirection | undefined;
  mode?: "in" | "out" | undefined;
  color?: string | undefined;
  params?: Record<string, number | number[] | boolean> | undefined;
}

// ── Folder open/closed state (persisted; folders start closed) ─────────────────────────────
const FOLDERS_KEY = "reelforge.effectFoldersCollapsed";
const ALL_FOLDER_IDS = ["favourites", ...effectPanelCategories.map((entry) => entry.id)];

function loadCollapsed(): Set<string> {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(FOLDERS_KEY) : null;
    if (raw) {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        return new Set(parsed.filter((value): value is string => typeof value === "string"));
      }
    }
  } catch {
    /* fall through to default */
  }
  // No saved state → every folder starts collapsed.
  return new Set(ALL_FOLDER_IDS);
}

function saveCollapsed(set: Set<string>): void {
  try {
    localStorage.setItem(FOLDERS_KEY, JSON.stringify([...set]));
  } catch {
    /* ignore (private mode / quota) */
  }
}

/**
 * Effects tab — an Adobe Premiere-style searchable folder tree over the lightweight catalog. Each
 * category (Video / Text / Audio / Transition / AI) is a collapsible bin; a live search filters every
 * bin at once (auto-expanding matches); each item has a favourite star, and starred items collect into
 * a Favourites bin pinned at the top (persisted in localStorage). Adding an item routes by `kind` to
 * the matching EditorPage handler — no implementation code loads until then. Default-exported so
 * EditorPage can `React.lazy` it.
 */
export function EffectGraphPanel({
  effects,
  selectedLayerType,
  sampleFrames,
  onAddTimelineEffect,
  onApplyToolEffect,
  onApplyPreset,
  onAddTransition,
  onAddAudioEffect,
  onRemove
}: {
  effects: ProjectEffect[];
  selectedLayerType?: TimelineLayerType | undefined;
  /** Up to two real timeline frames (A, B) used as the transition preview footage. */
  sampleFrames?: Array<{ url: string; kind: "video" | "image" }> | undefined;
  onAddTimelineEffect: (type: TimelineEffectType) => void;
  onApplyToolEffect: (toolSlug: string) => void;
  onApplyPreset: (presetId: string) => void;
  onAddTransition: (spec: TransitionApplySpec) => void;
  onAddAudioEffect: (fade?: "in" | "out" | undefined) => void;
  onRemove: (id: string) => void;
}) {
  const catalog = useMemo(() => buildEffectCatalog(selectedLayerType), [selectedLayerType]);
  const [query, setQuery] = useState("");
  const [favourites, setFavourites] = useState<Set<string>>(() => loadFavourites());
  // Folder ids the user has collapsed (persisted; folders start closed).
  const [collapsed, setCollapsed] = useState<Set<string>>(() => loadCollapsed());
  // Full-screen transition gallery ("Show more" portal).
  const [galleryOpen, setGalleryOpen] = useState(false);
  // Active filter chip in the "Show more" gallery. "all" shows every category as a labeled section.
  const [galleryCategory, setGalleryCategory] = useState<TransitionGroup | "all">("all");
  const searchRef = useRef<HTMLInputElement>(null);

  // Resolve the two sample frames to image sources: an image clip is its own url; a video clip needs a
  // captured poster frame. Same A/B pair feeds every preview tile so transitions are comparable.
  const sampleA = sampleFrames?.[0];
  const sampleB = sampleFrames?.[1];
  const aPoster = useVideoPoster(sampleA?.kind === "video" ? sampleA.url : undefined);
  const bPoster = useVideoPoster(sampleB?.kind === "video" ? sampleB.url : undefined);
  const aSrc = sampleA ? (sampleA.kind === "image" ? sampleA.url : aPoster ?? undefined) : undefined;
  const bSrc = sampleB ? (sampleB.kind === "image" ? sampleB.url : bPoster ?? undefined) : undefined;

  const normalizedQuery = query.trim().toLowerCase();
  const matchesQuery = (item: CatalogItem) =>
    !normalizedQuery || [item.label, item.description].some((value) => value.toLowerCase().includes(normalizedQuery));

  // The Favourites bin in the tree only collects EFFECT favourites (Video/Text/Audio). Transition and
  // AI favourites live in their own strip rows (transitions float to the top of the Transitions row).
  const itemsById = useMemo(() => {
    const map = new Map<string, CatalogItem>();
    for (const id of ["video", "text", "audio"] as const) {
      for (const item of catalog[id]) map.set(item.id, item);
    }
    return map;
  }, [catalog]);

  const favouriteItems = useMemo(
    () => [...itemsById.values()].filter((item) => favourites.has(item.id) && matchesQuery(item)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [itemsById, favourites, normalizedQuery]
  );

  function toggleFavourite(id: string) {
    setFavourites((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      saveFavourites(next);
      return next;
    });
  }

  function toggleFolder(id: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      saveCollapsed(next);
      return next;
    });
  }

  function addItem(item: CatalogItem) {
    switch (item.kind) {
      case "effect":
        onAddTimelineEffect(item.effectType);
        break;
      case "audio":
        onAddAudioEffect(item.fade);
        break;
      case "preset":
        onApplyPreset(item.presetId);
        break;
      case "transition":
        onAddTransition({ kind: item.transition, direction: item.direction, mode: item.mode, color: item.color, params: item.params });
        break;
      case "ai":
        onApplyToolEffect(item.toolSlug);
        break;
    }
  }

  function renderRow(item: CatalogItem) {
    const starred = favourites.has(item.id);
    // Junction transitions can be dragged onto a cut between two clips; effects drag onto a clip.
    const draggableEffect = item.kind === "effect";
    const draggableTransition = item.kind === "transition" && Boolean(item.junction);
    return (
      <div className="effect-tree-row" key={item.id} title={item.description}>
        <button
          type="button"
          className="effect-tree-add"
          draggable={draggableEffect || draggableTransition}
          onClick={() => addItem(item)}
          onDragStart={(event) => {
            if (draggableEffect) {
              event.dataTransfer.effectAllowed = "copy";
              event.dataTransfer.setData("application/x-reelforge-timeline-effect", item.effectType);
              event.dataTransfer.setData("text/plain", item.label);
            } else if (draggableTransition && item.kind === "transition") {
              event.dataTransfer.effectAllowed = "copy";
              event.dataTransfer.setData(
                "application/x-reelforge-transition",
                JSON.stringify({ kind: item.transition, direction: item.direction, mode: item.mode, color: item.color, params: item.params })
              );
              event.dataTransfer.setData("text/plain", item.label);
            }
          }}
        >
          <Plus size={14} />
          <span>{item.label}</span>
        </button>
        <button
          type="button"
          className={`effect-tree-star ${starred ? "is-on" : ""}`}
          aria-label={starred ? "Remove from favourites" : "Add to favourites"}
          aria-pressed={starred}
          onClick={() => toggleFavourite(item.id)}
        >
          <Star size={14} fill={starred ? "currentColor" : "none"} />
        </button>
      </div>
    );
  }

  function renderFolder(id: string, label: string, items: CatalogItem[], pinned = false) {
    if (items.length === 0) return null;
    // A search forces matching folders open; otherwise honour the user's collapse state.
    const isOpen = normalizedQuery ? true : !collapsed.has(id);
    return (
      <div className={`effect-tree-folder ${pinned ? "is-pinned" : ""}`} key={id}>
        <button type="button" className="effect-tree-folder-head" aria-expanded={isOpen} onClick={() => toggleFolder(id)}>
          {isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          <span>{label}</span>
          <span className="effect-tree-count">{items.length}</span>
        </button>
        {isOpen ? <div className="effect-tree-folder-body">{items.map(renderRow)}</div> : null}
      </div>
    );
  }

  // The top tree holds only effect categories; Transitions + AI live in the bottom strip.
  const treeCategoryIds = new Set(["video", "text", "audio"]);
  function renderTransitionTile(item: CatalogItem) {
    if (item.kind !== "transition") return null;
    return (
      <TransitionThumb
        key={item.id}
        kind={item.transition}
        params={{ direction: item.direction, mode: item.mode, color: item.color }}
        label={item.label}
        starred={favourites.has(item.id)}
        aSrc={aSrc}
        bSrc={bSrc}
        onApply={() => addItem(item)}
        onToggleStar={() => toggleFavourite(item.id)}
      />
    );
  }

  const visibleByCategory = effectPanelCategories
    .filter((entry) => treeCategoryIds.has(entry.id))
    .map((entry) => ({ entry, items: catalog[entry.id].filter(matchesQuery) }));
  const hasAnyMatch = favouriteItems.length > 0 || visibleByCategory.some((group) => group.items.length > 0);

  // Bottom horizontal strip rows (extensible — add more rows here later). Favourited transitions
  // float to the front of the Transitions row (stable order otherwise) — no separate Favourites bin.
  const transitionTiles = catalog.transition
    .filter(matchesQuery)
    .slice()
    .sort((a, b) => Number(favourites.has(b.id)) - Number(favourites.has(a.id)));
  const aiTiles = catalog.ai.filter(matchesQuery);

  return (
    <div className="effect-panel">
      <div className="panel-heading">
        <h2>Effects</h2>
        <Badge tone="muted">{selectedLayerType ? selectedLayerType : "select layer"}</Badge>
      </div>

      <div className="effect-search-bar">
        <Search size={14} aria-hidden="true" />
        <input
          ref={searchRef}
          value={query}
          placeholder="Search effects & transitions…"
          onChange={(event) => setQuery(event.target.value)}
        />
        {query ? (
          <button type="button" className="effect-search-clear" aria-label="Clear search" onClick={() => setQuery("")}>
            <X size={14} />
          </button>
        ) : null}
      </div>

      <div className="effect-tree">
        {renderFolder("favourites", "Favourites", favouriteItems, true)}
        {visibleByCategory.map((group) => renderFolder(group.entry.id, group.entry.label, group.items))}
        {!hasAnyMatch ? (
          <small className="effect-panel-hint">
            {normalizedQuery
              ? `No effects match “${query.trim()}”.`
              : !selectedLayerType
                ? "Select an element in the timeline or viewer, then add an effect."
                : "No effects for this clip type yet."}
          </small>
        ) : null}
      </div>

      {/* Bottom strip — browsable square tiles. Transitions preview on hover; AI tools run on click. */}
      <div className="effect-strip-panel">
        {transitionTiles.length ? (
          <div className="effect-strip-row">
            <div className="effect-strip-head">
              <span>Transitions</span>
              <Badge tone="muted">{transitionTiles.length}</Badge>
            </div>
            <div className="effect-strip-track">
              {transitionTiles.slice(0, TRANSITION_STRIP_CAP).map(renderTransitionTile)}
              {transitionTiles.length > TRANSITION_STRIP_CAP ? (
                <button type="button" className="transition-show-more" onClick={() => { setGalleryCategory("all"); setGalleryOpen(true); }}>
                  <span className="transition-show-more-plus">+{transitionTiles.length - TRANSITION_STRIP_CAP}</span>
                  <span>Show more</span>
                </button>
              ) : null}
            </div>
          </div>
        ) : null}

        {aiTiles.length ? (
          <div className="effect-strip-row">
            <div className="effect-strip-head">
              <span>AI Tools</span>
              <Badge tone="muted">{aiTiles.length}</Badge>
            </div>
            <div className="effect-strip-track">
              {aiTiles.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className="ai-tool-tile"
                  title={item.description}
                  onClick={() => addItem(item)}
                >
                  <Sparkles size={18} aria-hidden="true" />
                  <span>{item.label}</span>
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </div>

      {effects.length ? (
        <div className="effect-library-section">
          <div className="panel-heading">
            <h2>Active AI tools</h2>
            <Badge tone="muted">{effects.length}</Badge>
          </div>
          <div className="effect-list">
            {effects.map((effect) => (
              <div className="effect-row" key={effect.id}>
                <div>
                  <strong>{effect.name}</strong>
                  <span>{effect.status}</span>
                  <small>
                    {effect.input.join(" + ")} -&gt; {effect.output.join(" + ")}
                  </small>
                </div>
                <Button variant="ghost" icon={<Trash2 size={15} />} onClick={() => onRemove(effect.id)}>
                  Remove
                </Button>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {/* Full transitions gallery ("Show more") — portalled to <body> so it overlays the whole editor,
          not just the effects panel (whose transform/overflow would otherwise trap a fixed child).
          Grouped by industry-standard category with filter chips + labeled sections. */}
      {galleryOpen && typeof document !== "undefined"
        ? createPortal(
            (() => {
              const matching = catalog.transition.filter(matchesQuery);
              const itemsFor = (id: TransitionGroup) => matching.filter((item) => item.kind === "transition" && item.group === id);
              const nonEmpty = transitionGalleryCategories.filter((cat) => itemsFor(cat.id).length > 0);
              const shownSections = galleryCategory === "all" ? nonEmpty : nonEmpty.filter((cat) => cat.id === galleryCategory);
              return (
                <div className="transition-gallery-portal" onClick={() => setGalleryOpen(false)}>
                  <div className="transition-gallery" onClick={(event) => event.stopPropagation()}>
                    <div className="transition-gallery-head">
                      <h3>Transitions</h3>
                      <Badge tone="muted">{matching.length}</Badge>
                      <button type="button" className="transition-gallery-close" aria-label="Close" onClick={() => setGalleryOpen(false)}>
                        <X size={16} />
                      </button>
                    </div>
                    <div className="transition-gallery-chips">
                      <button
                        type="button"
                        className={`transition-gallery-chip ${galleryCategory === "all" ? "is-active" : ""}`}
                        onClick={() => setGalleryCategory("all")}
                      >
                        All
                      </button>
                      {nonEmpty.map((cat) => (
                        <button
                          key={cat.id}
                          type="button"
                          className={`transition-gallery-chip ${galleryCategory === cat.id ? "is-active" : ""}`}
                          onClick={() => setGalleryCategory(cat.id)}
                        >
                          {cat.label}
                        </button>
                      ))}
                    </div>
                    <div className="transition-gallery-body">
                      {shownSections.length === 0 ? (
                        <small className="effect-panel-hint">No transitions match “{query.trim()}”.</small>
                      ) : (
                        shownSections.map((cat) => {
                          const items = itemsFor(cat.id);
                          return (
                            <section className="transition-gallery-section" key={cat.id}>
                              <div className="transition-gallery-section-head">
                                <span>{cat.label}</span>
                                <Badge tone="muted">{items.length}</Badge>
                              </div>
                              <div className="transition-gallery-grid">{items.map(renderTransitionTile)}</div>
                            </section>
                          );
                        })
                      )}
                    </div>
                  </div>
                </div>
              );
            })(),
            document.body
          )
        : null}
    </div>
  );
}

export default EffectGraphPanel;
