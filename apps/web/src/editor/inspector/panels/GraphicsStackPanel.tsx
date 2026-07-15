/**
 * Graphics tab — layer stack (Premiere EGP-style). A hierarchical VIEW of the composition
 * tree: graphic-ish layers (text/shape/vector) plus groups (nested compositions) shown
 * as collapsible group rows with their children indented beneath. Select / show-hide / lock /
 * rename inline; duplicate / delete / group / ungroup via right-click.
 *
 * CORE INVARIANT (§4): the stack NEVER owns composition state. Every action dispatches the SAME
 * operation the timeline would (select, updateLayer, duplicate, delete, nest, un-nest). The only
 * local state here is pure VIEW state — which groups are collapsed, and the inline rename buffer —
 * neither of which changes the composition. Direct-import component (not registry-loaded): it edits
 * layers OTHER than the selected one, which the InspectorPanelProps contract deliberately disallows.
 */

import { useEffect, useState, type DragEvent as ReactDragEvent, type MouseEvent as ReactMouseEvent } from "react";
import { ChevronDown, ChevronRight, Copy, Eye, EyeOff, Frame, Group, Layers, Lock, Shapes, Square, Trash2, Type, Unlock, Ungroup } from "lucide-react";
import type { TimelineComposition, TimelineLayer } from "@kimera-by-aelivion/shared";
import { InspectorSection } from "../InspectorSection";
import { resolveSelectMode, type LayerSelectMode } from "../../selectionMode";

export interface GraphicsStackEntry {
  layer: TimelineLayer;
  trackName: string;
  /** Track that owns this row — drag-reorder is restricted to same-track siblings. */
  trackId: string;
  /** Nesting depth for indentation (0 = top level). */
  depth: number;
  /** True when this row is a group (nested composition with children). */
  isGroup: boolean;
}

function isGraphicish(layer: TimelineLayer): boolean {
  return layer.type === "text" || layer.type === "shape" || Boolean(layer.graphic);
}

/**
 * Flatten the composition tree into rows in DRAW ORDER, front-first: tracks[0] on top, and within a
 * track the top-most layer (highest index) first — so the list reads top→bottom like Photoshop/AE
 * layers (drag-up = bring-forward). We therefore walk each track's layers REVERSED. Recurses into
 * nested compositions. A frame row is included only if it (or a descendant) has graphic-ish content,
 * so pure-media frames don't clutter the stack. Collapsed frames omit their children.
 */
export function graphicsStackEntries(
  composition: TimelineComposition,
  nestedCompositions: Record<string, TimelineComposition> | undefined,
  collapsed: ReadonlySet<string>,
  depth = 0
): GraphicsStackEntry[] {
  const entries: GraphicsStackEntry[] = [];
  for (const track of composition.tracks) {
    for (const layer of [...track.layers].reverse()) {
      const nested = layer.nestedCompositionId ? nestedCompositions?.[layer.nestedCompositionId] : undefined;
      if (nested) {
        const children = graphicsStackEntries(nested, nestedCompositions, collapsed, depth + 1);
        if (!children.length) continue; // no graphic-ish content anywhere inside → don't show the frame
        entries.push({ layer, trackName: track.name, trackId: track.id, depth, isGroup: true });
        if (!collapsed.has(layer.id)) entries.push(...children);
      } else if (isGraphicish(layer)) {
        entries.push({ layer, trackName: track.name, trackId: track.id, depth, isGroup: false });
      }
    }
  }
  return entries;
}

function layerIcon(entry: GraphicsStackEntry) {
  if (entry.isGroup) return <Frame size={13} />;
  if (entry.layer.type === "text") return <Type size={13} />;
  if (entry.layer.type === "shape") return <Square size={13} />;
  return <Shapes size={13} />;
}

interface StackMenu {
  x: number;
  y: number;
  entry: GraphicsStackEntry;
}

export default function GraphicsStackPanel({
  composition,
  nestedCompositions,
  currentTime,
  selectedLayerIds,
  primaryLayerId,
  onSelectLayer,
  onChangeLayer,
  onDuplicateLayer,
  onDeleteLayer,
  onDuplicateLayers,
  onDeleteLayers,
  onGroup,
  onUngroup,
  onReorderLayer
}: {
  composition: TimelineComposition;
  /** graph.compositions — lets the stack walk nested compositions (groups). */
  nestedCompositions?: Record<string, TimelineComposition> | undefined;
  currentTime: number;
  /** Shared with the timeline/editor — selecting here selects the clip everywhere. */
  selectedLayerIds: string[];
  /** The one layer whose controls the inspector is editing (multiSelectPrimaryLayer). */
  primaryLayerId?: string | undefined;
  /** Mode mirrors the timeline exactly (resolveSelectMode); shift = range, ctrl/cmd = toggle. */
  onSelectLayer?: ((layerId: string, mode: LayerSelectMode) => void) | undefined;
  onChangeLayer?: ((layerId: string, updater: (layer: TimelineLayer) => TimelineLayer) => void) | undefined;
  onDuplicateLayer?: ((layerId: string) => void) | undefined;
  onDeleteLayer?: ((layerId: string) => void) | undefined;
  /** Selection-aware: duplicate/delete the whole multi-selection in one history entry. */
  onDuplicateLayers?: ((layerIds: string[]) => void) | undefined;
  onDeleteLayers?: ((layerIds: string[]) => void) | undefined;
  /** Group the current selection (reuses the timeline nest op — needs 2+ selected). */
  onGroup?: (() => void) | undefined;
  onUngroup?: ((layerId: string) => void) | undefined;
  /** Drag-reorder a top-level layer relative to a SAME-TRACK sibling. `place` is in Z terms. */
  onReorderLayer?: ((layerId: string, targetLayerId: string, place: "front-of" | "behind") => void) | undefined;
}) {
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const [menu, setMenu] = useState<StackMenu | null>(null);
  // Drag-reorder (§4): the row being dragged, and the current drop hint (target row + Z side).
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropHint, setDropHint] = useState<{ targetId: string; place: "front-of" | "behind" } | null>(null);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("click", close);
    window.addEventListener("blur", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  const entries = graphicsStackEntries(composition, nestedCompositions, collapsed);
  if (!entries.length) return null;

  const selectedSet = new Set(selectedLayerIds);
  const canGroup = selectedLayerIds.length >= 2 && Boolean(onGroup);
  const entryById = new Map(entries.map((entry) => [entry.layer.id, entry]));

  // Drag-reorder is v1-scoped to TOP-LEVEL (depth 0) siblings on the SAME track — a clean, safe
  // model that matches how graphics stack on a shared track. Group children (depth>0) aren't draggable.
  function canDrop(targetId: string): boolean {
    if (!dragId || dragId === targetId || !onReorderLayer) return false;
    const from = entryById.get(dragId);
    const to = entryById.get(targetId);
    return Boolean(from && to && from.depth === 0 && to.depth === 0 && from.trackId === to.trackId);
  }
  function onRowDragStart(event: ReactDragEvent, entry: GraphicsStackEntry) {
    if (entry.depth !== 0 || !onReorderLayer) {
      event.preventDefault();
      return;
    }
    setDragId(entry.layer.id);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", entry.layer.id);
  }
  function onRowDragOver(event: ReactDragEvent, entry: GraphicsStackEntry) {
    if (!canDrop(entry.layer.id)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    // Display is front-first (top = on top), so the row's upper half means "in front of" the target.
    const rect = event.currentTarget.getBoundingClientRect();
    const place: "front-of" | "behind" = event.clientY < rect.top + rect.height / 2 ? "front-of" : "behind";
    if (dropHint?.targetId !== entry.layer.id || dropHint.place !== place) setDropHint({ targetId: entry.layer.id, place });
  }
  function onRowDrop(event: ReactDragEvent, entry: GraphicsStackEntry) {
    if (!canDrop(entry.layer.id)) return;
    event.preventDefault();
    if (dragId && dropHint?.targetId === entry.layer.id) onReorderLayer?.(dragId, entry.layer.id, dropHint.place);
    setDragId(null);
    setDropHint(null);
  }
  function onRowDragEnd() {
    setDragId(null);
    setDropHint(null);
  }

  function toggleCollapse(layerId: string) {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(layerId)) next.delete(layerId);
      else next.add(layerId);
      return next;
    });
  }

  function openMenu(event: ReactMouseEvent, entry: GraphicsStackEntry) {
    event.preventDefault();
    event.stopPropagation();
    // Right-click selects the row if it isn't already part of the selection (matches most editors).
    if (!selectedSet.has(entry.layer.id)) onSelectLayer?.(entry.layer.id, "replace");
    setMenu({ x: event.clientX, y: event.clientY, entry });
  }

  // Duplicate/Delete target: when the right-clicked row is part of a multi-selection, act on the WHOLE
  // selection (like the timeline's Delete key); otherwise just the clicked row. Recomputed at click
  // time from the entry so a stale selection can't leak in.
  function actionTargets(entry: GraphicsStackEntry): string[] {
    return selectedSet.has(entry.layer.id) && selectedLayerIds.length > 1 ? selectedLayerIds : [entry.layer.id];
  }
  function runDuplicate(entry: GraphicsStackEntry) {
    const ids = actionTargets(entry);
    if (ids.length > 1 && onDuplicateLayers) onDuplicateLayers(ids);
    else onDuplicateLayer?.(ids[0]!);
  }
  function runDelete(entry: GraphicsStackEntry) {
    const ids = actionTargets(entry);
    if (ids.length > 1 && onDeleteLayers) onDeleteLayers(ids);
    else onDeleteLayer?.(ids[0]!);
  }

  return (
    <InspectorSection title="Layers" icon={<Layers size={13} />} count={entries.length}>
      <div className="graphics-stack">
        {entries.map((entry) => {
          const { layer, trackName, depth, isGroup } = entry;
          const active = layer.startSeconds <= currentTime && currentTime < layer.startSeconds + layer.durationSeconds;
          const hidden = layer.muted === true;
          const locked = layer.locked === true;
          const selected = selectedSet.has(layer.id);
          const primary = layer.id === primaryLayerId;
          const isCollapsed = collapsed.has(layer.id);
          const draggable = depth === 0 && Boolean(onReorderLayer) && renamingId !== layer.id;
          const dropSide = dropHint?.targetId === layer.id ? dropHint.place : null;
          return (
            <div
              key={layer.id}
              className={
                `graphics-stack-row${selected ? " is-selected" : ""}${primary ? " is-primary" : ""}` +
                `${active ? "" : " is-inactive"}${locked ? " is-locked" : ""}${dragId === layer.id ? " is-dragging" : ""}` +
                `${dropSide === "front-of" ? " is-drop-front" : ""}${dropSide === "behind" ? " is-drop-behind" : ""}`
              }
              style={{ paddingLeft: 4 + depth * 14 }}
              draggable={draggable}
              onDragStart={(event) => onRowDragStart(event, entry)}
              onDragOver={(event) => onRowDragOver(event, entry)}
              onDrop={(event) => onRowDrop(event, entry)}
              onDragEnd={onRowDragEnd}
              onClick={(event) => onSelectLayer?.(layer.id, resolveSelectMode(event))}
              onDoubleClick={() => setRenamingId(layer.id)}
              onContextMenu={(event) => openMenu(event, entry)}
              title={`${trackName} · ${active ? "at playhead" : "not at playhead"}`}
            >
              {isGroup ? (
                <button
                  type="button"
                  className="graphics-stack-caret"
                  title={isCollapsed ? "Expand group" : "Collapse group"}
                  aria-label={isCollapsed ? "Expand group" : "Collapse group"}
                  aria-expanded={!isCollapsed}
                  onClick={(event) => {
                    event.stopPropagation();
                    toggleCollapse(layer.id);
                  }}
                >
                  {isCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                </button>
              ) : (
                <span className="graphics-stack-caret-spacer" aria-hidden="true" />
              )}
              <span className="graphics-stack-icon">{layerIcon(entry)}</span>
              {renamingId === layer.id ? (
                <input
                  autoFocus
                  className="graphics-stack-rename"
                  defaultValue={layer.name}
                  onClick={(event) => event.stopPropagation()}
                  onBlur={(event) => {
                    const name = event.target.value.trim();
                    if (name && name !== layer.name) onChangeLayer?.(layer.id, (item) => ({ ...item, name }));
                    setRenamingId(null);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") (event.target as HTMLInputElement).blur();
                    if (event.key === "Escape") setRenamingId(null);
                  }}
                />
              ) : (
                <span className="graphics-stack-name">{layer.name || (isGroup ? "Group" : layer.type)}</span>
              )}
              <button
                type="button"
                className={`graphics-stack-action${locked ? " is-on" : ""}`}
                title={locked ? "Unlock layer" : "Lock layer"}
                aria-label={locked ? "Unlock layer" : "Lock layer"}
                onClick={(event) => {
                  event.stopPropagation();
                  onChangeLayer?.(layer.id, (item) => ({ ...item, locked: !item.locked }));
                }}
              >
                {locked ? <Lock size={13} /> : <Unlock size={13} />}
              </button>
              <button
                type="button"
                className="graphics-stack-action"
                title={hidden ? "Show layer" : "Hide layer"}
                aria-label={hidden ? "Show layer" : "Hide layer"}
                onClick={(event) => {
                  event.stopPropagation();
                  // `muted` already hides visual layers in BOTH renderers (web preview + render
                  // manifest filter on !layer.muted) — no new visibility field needed.
                  onChangeLayer?.(layer.id, (item) => ({ ...item, muted: !item.muted }));
                }}
              >
                {hidden ? <EyeOff size={13} /> : <Eye size={13} />}
              </button>
            </div>
          );
        })}
      </div>

      {menu ? (
        <div
          className="timeline-context-menu graphics-stack-menu"
          style={{ position: "fixed", left: menu.x, top: menu.y, zIndex: 60 }}
          onClick={(event) => event.stopPropagation()}
        >
          {canGroup ? (
            <button
              type="button"
              onClick={() => {
                onGroup?.();
                setMenu(null);
              }}
            >
              <Group size={13} /> Group
            </button>
          ) : null}
          {menu.entry.isGroup ? (
            <button
              type="button"
              onClick={() => {
                onUngroup?.(menu.entry.layer.id);
                setMenu(null);
              }}
            >
              <Ungroup size={13} /> Ungroup
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => {
              runDuplicate(menu.entry);
              setMenu(null);
            }}
          >
            <Copy size={13} /> Duplicate{actionTargets(menu.entry).length > 1 ? ` ${actionTargets(menu.entry).length}` : ""}
          </button>
          <button
            type="button"
            className="timeline-context-menu-danger"
            onClick={() => {
              runDelete(menu.entry);
              setMenu(null);
            }}
          >
            <Trash2 size={13} /> Delete{actionTargets(menu.entry).length > 1 ? ` ${actionTargets(menu.entry).length}` : ""}
          </button>
        </div>
      ) : null}
    </InspectorSection>
  );
}
