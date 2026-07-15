import { ChevronDown, ChevronRight, Layers, Plus, Search, Sparkles, Star, Trash2, Upload, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  type ProjectEffect,
  cubeLutToEffectManifest,
  glTransitionToManifest,
  inspectPluginManifestSafety,
  pluginSafetyReportToMessage,
  pluginSafetyWarnings,
  type PluginEffectManifest,
  type PluginManifest,
  type PluginLookManifest,
  type PluginTransitionManifest,
  type TimelineEffectType,
  type TimelineLayerType,
  type TransitionDirection,
  type TransitionKind
} from "@kimera-by-aelivion/shared";
import {
  buildEffectCatalog,
  effectPanelCategories,
  lookGalleryCategories,
  transitionGalleryCategories,
  type CatalogItem,
  type LookGroup,
  type TransitionGroup
} from "../editor/effects/catalog";
import { loadFavourites, saveFavourites } from "../editor/effects/favourites";
import { useVideoPoster } from "../lib/videoThumbnails";
import { Badge } from "./Badge";
import { Button } from "./Button";
import { TransitionThumb } from "./TransitionThumb";

/** How many transition tiles the inline strip shows before the "Show more" full gallery. */
const TRANSITION_STRIP_CAP = 7;
const LOOK_STRIP_CAP = 7;

/** Display order for effect subcategory headers inside the Video/Text folders. "Other" (presets,
 *  imported effects — anything without a registry category) always sorts last. */
const EFFECT_CATEGORY_ORDER = ["Adjust", "Blur", "Stylize", "Keying", "Texture", "Motion", "Other"];

/** The transition spec the panel hands to the editor (duration is filled in there). */
export interface TransitionApplySpec {
  kind: TransitionKind;
  direction?: TransitionDirection | undefined;
  mode?: "in" | "out" | undefined;
  color?: string | undefined;
  params?: Record<string, number | number[] | boolean> | undefined;
  manifest?: PluginTransitionManifest | undefined;
}

// ── Folder open/closed state (persisted; folders start closed) ─────────────────────────────
const FOLDERS_KEY = "kimera.effectFoldersCollapsed";
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

function formatManifestImportError(kind: "Effect" | "Look" | "Transition" | "Plugin", error: unknown): string {
  const issues = (error as { issues?: Array<{ path?: Array<string | number>; message?: string }> } | undefined)?.issues;
  if (Array.isArray(issues) && issues.length) {
    const detail = issues
      .slice(0, 4)
      .map((issue) => `${issue.path?.length ? issue.path.join(".") : "manifest"}: ${issue.message ?? "Invalid value"}`)
      .join("; ");
    const more = issues.length > 4 ? `; +${issues.length - 4} more` : "";
    return `${kind} upload rejected - ${detail}${more}`;
  }
  if (error instanceof SyntaxError) {
    return `${kind} upload rejected - the file is not valid JSON.`;
  }
  return `${kind} upload rejected - ${error instanceof Error ? error.message : "unknown error"}`;
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
  importedEffects,
  importedLooks,
  importedTransitions,
  onAddTimelineEffect,
  onApplyEffectManifest,
  onImportEffectManifest,
  onRemoveEffectManifest,
  onImportLookManifest,
  onRemoveLookManifest,
  onImportTransitionManifest,
  onRemoveTransitionManifest,
  onApplyToolEffect,
  onApplyPreset,
  onApplyLook,
  onAddTransition,
  onAddAudioEffect,
  onRemove
}: {
  effects: ProjectEffect[];
  selectedLayerType?: TimelineLayerType | undefined;
  /** Up to two real timeline frames (A, B) used as the transition preview footage. */
  sampleFrames?: Array<{ url: string; kind: "video" | "image" }> | undefined;
  importedEffects: PluginEffectManifest[];
  importedLooks: PluginLookManifest[];
  importedTransitions: PluginTransitionManifest[];
  onAddTimelineEffect: (type: TimelineEffectType) => void;
  onApplyEffectManifest: (manifest: PluginEffectManifest) => void;
  onImportEffectManifest: (manifest: PluginEffectManifest) => Promise<string>;
  onRemoveEffectManifest: (manifestId: string) => Promise<string> | string;
  onImportLookManifest: (manifest: PluginLookManifest) => Promise<string>;
  onRemoveLookManifest: (manifestId: string) => Promise<string> | string;
  onImportTransitionManifest: (manifest: PluginTransitionManifest) => Promise<string>;
  onRemoveTransitionManifest: (manifestId: string) => Promise<string> | string;
  onApplyToolEffect: (toolSlug: string) => void;
  onApplyPreset: (presetId: string) => void;
  onApplyLook: (lookName: string, mode: "clip" | "adjustment", manifest?: PluginLookManifest | undefined) => void;
  onAddTransition: (spec: TransitionApplySpec) => void;
  onAddAudioEffect: (fade?: "in" | "out" | undefined) => void;
  onRemove: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [favourites, setFavourites] = useState<Set<string>>(() => loadFavourites());
  const [importStatus, setImportStatus] = useState<string | null>(null);
  // Folder ids the user has collapsed (persisted; folders start closed).
  const [collapsed, setCollapsed] = useState<Set<string>>(() => loadCollapsed());
  // Full-screen transition gallery ("Show more" portal).
  const [galleryOpen, setGalleryOpen] = useState(false);
  // Active filter chip in the "Show more" gallery. "all" shows every category as a labeled section.
  const [galleryCategory, setGalleryCategory] = useState<TransitionGroup | "all">("all");
  const [lookGalleryOpen, setLookGalleryOpen] = useState(false);
  const [lookGalleryCategory, setLookGalleryCategory] = useState<LookGroup | "all">("all");
  const searchRef = useRef<HTMLInputElement>(null);
  const universalImportInputRef = useRef<HTMLInputElement>(null);
  // FULL catalog always (2026-07-03 UX change): selecting a clip no longer FILTERS the panel down
  // to that type's items — every category stays browsable so users can grab, say, a video effect
  // while an audio clip is selected and drag it onto any compatible clip. The selection instead
  // AUTO-EXPANDS the matching category below.
  const catalog = useMemo(
    () =>
      buildEffectCatalog(undefined, {
        effectManifests: importedEffects,
        lookManifests: importedLooks,
        transitionManifests: importedTransitions
      }),
    [importedEffects, importedLooks, importedTransitions]
  );

  // Selecting a clip opens its category bin (audio clip → Audio, text → Text, video/image →
  // Video) without collapsing anything the user opened themselves.
  useEffect(() => {
    if (!selectedLayerType) return;
    const folder = selectedLayerType === "audio" ? "audio" : selectedLayerType === "text" ? "text" : "video";
    setCollapsed((current) => {
      if (!current.has(folder)) return current;
      const next = new Set(current);
      next.delete(folder);
      saveCollapsed(next);
      return next;
    });
  }, [selectedLayerType]);

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
    for (const id of ["uploaded", "video", "text", "audio"] as const) {
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
      case "effectManifest":
        onApplyEffectManifest(item.manifest);
        break;
      case "audio":
        onAddAudioEffect(item.fade);
        break;
      case "preset":
        onApplyPreset(item.presetId);
        break;
      case "look":
        onApplyLook(item.lookName, "clip", item.manifest);
        break;
      case "transition":
        onAddTransition({ kind: item.transition, direction: item.direction, mode: item.mode, color: item.color, params: item.params, manifest: item.manifest });
        break;
      case "ai":
        onApplyToolEffect(item.toolSlug);
        break;
    }
  }

  async function importUniversalPlugin(file: File | undefined) {
    if (!file) return;
    setImportStatus(`Uploading ${file.name}...`);
    try {
      if (file.name.toLowerCase().endsWith(".cube")) {
        const result = cubeLutToEffectManifest({ fileName: file.name, text: await file.text() });
        const message = await onImportEffectManifest(result.manifest);
        setImportStatus(result.warnings.length ? `${message} ${result.warnings.join(" ")}` : message);
        openImportedFolder("uploaded");
        return;
      }
      if (/\.(glsl|frag)$/i.test(file.name)) {
        const result = glTransitionToManifest({ fileName: file.name, text: await file.text() });
        const message = await onImportTransitionManifest(result.manifest);
        setImportStatus(result.warnings.length ? `${message} ${result.warnings.join(" ")}` : message);
        setGalleryCategory("uploaded");
        openImportedFolder("transition");
        return;
      }
      const manifest = await parseSafeAnyManifestFile(file);
      if (manifest.kind === "effect") {
        setImportStatus(await onImportEffectManifest(manifest));
        openImportedFolder("uploaded");
      } else if (manifest.kind === "look") {
        setImportStatus(await onImportLookManifest(manifest));
        setLookGalleryCategory("uploaded");
        openImportedFolder("look");
      } else if (manifest.kind === "transition") {
        setImportStatus(await onImportTransitionManifest(manifest));
        setGalleryCategory("uploaded");
        openImportedFolder("transition");
      } else {
        throw new Error(`"${manifest.kind}" packages are valid, but this panel can import effects, looks, transitions, and .cube LUTs.`);
      }
    } catch (error) {
      setImportStatus(formatManifestImportError("Plugin", error));
    } finally {
      if (universalImportInputRef.current) universalImportInputRef.current.value = "";
    }
  }

  async function parseSafeAnyManifestFile(file: File): Promise<PluginManifest> {
    const text = await file.text();
    const parsedJson = JSON.parse(text) as unknown;
    const report = inspectPluginManifestSafety(parsedJson, { byteSize: file.size });
    if (!report.ok && isExternalGlTransitionJson(parsedJson)) {
      return glTransitionToManifest({ fileName: file.name, text, json: parsedJson }).manifest;
    }
    if (!report.ok || !report.manifest) {
      throw new Error(pluginSafetyReportToMessage(report));
    }
    const warnings = pluginSafetyWarnings(report);
    if (warnings.length) {
      console.warn("[plugins] safety warnings", warnings);
    }
    return report.manifest;
  }

  function isExternalGlTransitionJson(value: unknown): boolean {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    return ["glsl", "fragment", "shader", "transition"].some((key) => typeof record[key] === "string") && record.kind !== "transition";
  }

  function openImportedFolder(id: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      next.delete(id);
      saveCollapsed(next);
      return next;
    });
  }

  function renderRow(item: CatalogItem) {
    const starred = favourites.has(item.id);
    const removable = item.kind === "effectManifest";
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
              event.dataTransfer.setData("application/x-kimera-timeline-effect", item.effectType);
              event.dataTransfer.setData("text/plain", item.label);
            } else if (draggableTransition && item.kind === "transition") {
              event.dataTransfer.effectAllowed = "copy";
              event.dataTransfer.setData(
                "application/x-kimera-transition",
                JSON.stringify({ kind: item.transition, direction: item.direction, mode: item.mode, color: item.color, params: item.params, manifest: item.manifest })
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
        {removable ? (
          <button
            type="button"
            className="effect-tree-delete"
            aria-label={`Remove uploaded effect ${item.label}`}
            title="Remove uploaded effect"
            onClick={async () => {
              setImportStatus(await onRemoveEffectManifest(item.manifest.id));
              setFavourites((prev) => {
                if (!prev.has(item.id)) return prev;
                const next = new Set(prev);
                next.delete(item.id);
                saveFavourites(next);
                return next;
              });
            }}
          >
            <Trash2 size={13} />
          </button>
        ) : null}
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
        {isOpen ? <div className="effect-tree-folder-body">{renderFolderBody(items)}</div> : null}
      </div>
    );
  }

  /**
   * Video/Text folders mix many effect categories (Blur/Adjust/Stylize/Keying/Texture) once the
   * registry grows past a handful of items — sub-group by category (with an "Other" bucket for
   * items that don't carry one: presets, imported effects) so the list reads as sections instead of
   * one long flat pile. A folder with only one distinct category renders flat, unchanged from before.
   */
  function renderFolderBody(items: CatalogItem[]) {
    const groups = new Map<string, CatalogItem[]>();
    for (const item of items) {
      const key = item.kind === "effect" && item.category ? item.category : "Other";
      const list = groups.get(key);
      if (list) list.push(item);
      else groups.set(key, [item]);
    }
    if (groups.size <= 1) {
      return items.map(renderRow);
    }
    const orderedKeys = [...EFFECT_CATEGORY_ORDER.filter((key) => groups.has(key)), ...[...groups.keys()].filter((key) => !EFFECT_CATEGORY_ORDER.includes(key))];
    return orderedKeys.map((key) => (
      <div className="effect-tree-subgroup" key={key}>
        <div className="effect-tree-subgroup-head">{key}</div>
        {groups.get(key)!.map(renderRow)}
      </div>
    ));
  }

  // The top tree holds only effect categories; Transitions + AI live in the bottom strip.
  const treeCategoryIds = new Set(["uploaded", "video", "text", "audio"]);
  function renderTransitionTile(item: CatalogItem) {
    if (item.kind !== "transition") return null;
    const removeTransition = item.manifest
      ? async () => {
          setImportStatus(await onRemoveTransitionManifest(item.manifest!.id));
          setFavourites((prev) => removeFavourite(prev, item.id));
        }
      : undefined;
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
        onRemove={removeTransition}
        // Junction kinds can be dragged onto a timeline cut (same payload the tree rows write).
        dragPayload={
          item.junction
            ? JSON.stringify({ kind: item.transition, direction: item.direction, mode: item.mode, color: item.color, params: item.params, manifest: item.manifest })
            : undefined
        }
      />
    );
  }

  function renderLookTile(item: CatalogItem) {
    if (item.kind !== "look") return null;
    const starred = favourites.has(item.id);
    const sampleSrc = aSrc ?? bSrc;
    return (
      <div className="look-thumb-wrap" key={item.id} title={item.description}>
        <button type="button" className="look-thumb" onClick={() => onApplyLook(item.lookName, "clip", item.manifest)}>
          <span
            className={`look-thumb-preview look-thumb-preview--${item.group}`}
            style={{
              backgroundImage: sampleSrc ? `url("${sampleSrc}")` : undefined,
              filter: item.previewStyle.filter
            }}
          />
          <span
            className="look-thumb-grade"
            style={{
              background: item.previewStyle.overlay,
              opacity: item.previewStyle.opacity
            }}
          />
          <span className="look-thumb-vignette" />
          <span className="look-thumb-name">{item.label}</span>
        </button>
        <button
          type="button"
          className={`transition-thumb-star ${starred ? "is-on" : ""}`}
          aria-label={starred ? "Remove from favourites" : "Add to favourites"}
          aria-pressed={starred}
          onClick={() => toggleFavourite(item.id)}
        >
          <Star size={12} fill={starred ? "currentColor" : "none"} />
        </button>
        <button
          type="button"
          className="look-thumb-adjustment"
          title="Apply as adjustment layer"
          aria-label={`Apply ${item.label} as adjustment layer`}
          onClick={() => onApplyLook(item.lookName, "adjustment", item.manifest)}
        >
          <Layers size={12} />
        </button>
        {item.manifest ? (
          <button
            type="button"
            className="look-thumb-delete"
            title="Remove uploaded look"
            aria-label={`Remove uploaded look ${item.label}`}
            onClick={async () => {
              setImportStatus(await onRemoveLookManifest(item.manifest!.id));
              setFavourites((prev) => removeFavourite(prev, item.id));
            }}
          >
            <Trash2 size={12} />
          </button>
        ) : null}
        <span className="transition-thumb-label">{item.label}</span>
      </div>
    );
  }

  function removeFavourite(prev: Set<string>, id: string) {
    if (!prev.has(id)) return prev;
    const next = new Set(prev);
    next.delete(id);
    saveFavourites(next);
    return next;
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
  const lookTiles = catalog.look
    .filter(matchesQuery)
    .slice()
    .sort((a, b) => Number(favourites.has(b.id)) - Number(favourites.has(a.id)));
  const aiTiles = catalog.ai.filter(matchesQuery);

  return (
    <div className="effect-panel">
      <div className="panel-heading">
        <h2>Effects</h2>
        <Badge tone="muted">{selectedLayerType ? selectedLayerType : "select layer"}</Badge>
        <button
          type="button"
          className="effect-header-import"
          title="Import plugin manifest or .cube LUT"
          onClick={() => universalImportInputRef.current?.click()}
        >
          <Upload size={13} />
          <span>Upload</span>
        </button>
        <input
          ref={universalImportInputRef}
          type="file"
          accept="application/json,.json,.cube,.glsl,.frag"
          className="effect-import-input"
          onChange={(event) => void importUniversalPlugin(event.currentTarget.files?.[0])}
        />
      </div>
      {importStatus ? <small className="effect-import-status">{importStatus}</small> : null}

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
        {lookTiles.length ? (
          <div className="effect-strip-row">
            <div className="effect-strip-head">
              <span>Looks</span>
              <Badge tone="muted">{lookTiles.length}</Badge>
            </div>
            <div className="effect-strip-track">
              {lookTiles.slice(0, LOOK_STRIP_CAP).map(renderLookTile)}
              {lookTiles.length > LOOK_STRIP_CAP ? (
                <button type="button" className="transition-show-more" onClick={() => { setLookGalleryCategory("all"); setLookGalleryOpen(true); }}>
                  <span className="transition-show-more-plus">+{lookTiles.length - LOOK_STRIP_CAP}</span>
                  <span>Show more</span>
                </button>
              ) : null}
            </div>
          </div>
        ) : null}

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
      {lookGalleryOpen && typeof document !== "undefined"
        ? createPortal(
            (() => {
              const matching = catalog.look.filter(matchesQuery);
              const itemsFor = (id: LookGroup) => matching.filter((item) => item.kind === "look" && item.group === id);
              const nonEmpty = lookGalleryCategories.filter((cat) => itemsFor(cat.id).length > 0);
              const shownSections = lookGalleryCategory === "all" ? nonEmpty : nonEmpty.filter((cat) => cat.id === lookGalleryCategory);
              return (
                <div className="transition-gallery-portal" onClick={() => setLookGalleryOpen(false)}>
                  <div className="transition-gallery" onClick={(event) => event.stopPropagation()}>
                    <div className="transition-gallery-head">
                      <h3>Looks</h3>
                      <Badge tone="muted">{matching.length}</Badge>
                      <button
                        type="button"
                        className="transition-gallery-import"
                        title="Import look manifest"
                        aria-label="Import look manifest"
                        onClick={() => universalImportInputRef.current?.click()}
                      >
                        <Upload size={15} />
                        <span>Upload</span>
                      </button>
                      <button type="button" className="transition-gallery-close" aria-label="Close" onClick={() => setLookGalleryOpen(false)}>
                        <X size={16} />
                      </button>
                    </div>
                    <div className="transition-gallery-chips">
                      <button
                        type="button"
                        className={`transition-gallery-chip ${lookGalleryCategory === "all" ? "is-active" : ""}`}
                        onClick={() => setLookGalleryCategory("all")}
                      >
                        All
                      </button>
                      {nonEmpty.map((cat) => (
                        <button
                          key={cat.id}
                          type="button"
                          className={`transition-gallery-chip ${lookGalleryCategory === cat.id ? "is-active" : ""}`}
                          onClick={() => setLookGalleryCategory(cat.id)}
                        >
                          {cat.label}
                        </button>
                      ))}
                    </div>
                    <div className="transition-gallery-body">
                      {shownSections.length === 0 ? (
                        <small className="effect-panel-hint">{`No looks match “${query.trim()}”.`}</small>
                      ) : (
                        shownSections.map((cat) => {
                          const items = itemsFor(cat.id);
                          return (
                            <section className="transition-gallery-section" key={cat.id}>
                              <div className="transition-gallery-section-head">
                                <span>{cat.label}</span>
                                <Badge tone="muted">{items.length}</Badge>
                              </div>
                              <div className="transition-gallery-grid">{items.map(renderLookTile)}</div>
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
                      <div className="transition-gallery-title">
                        <h3>Transitions</h3>
                        <small>Applies to the selected clip's right cut first, then left cut.</small>
                      </div>
                      <Badge tone="muted">{matching.length}</Badge>
                      <button
                        type="button"
                        className="transition-gallery-import"
                        title="Import transition manifest"
                        aria-label="Import transition manifest"
                        onClick={() => universalImportInputRef.current?.click()}
                      >
                        <Upload size={15} />
                        <span>Upload</span>
                      </button>
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
