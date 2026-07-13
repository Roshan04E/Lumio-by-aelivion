import { Suspense, lazy, memo, useMemo, type ComponentType } from "react";
import type { TimelineLayer } from "@kimera-by-aelivion/shared";
import { inspectorRegistry, type InspectorPanelProps, type MaskTool } from "../registry/inspector";
import type { SavedTrack } from "../../lib/trackLibrary";

/**
 * Renders the registered inspector panels for a layer's type (Phase 4). Each
 * panel is code-split via `React.lazy`, so a panel's code loads only when a
 * matching layer is selected. As panels are migrated out of EditorPage they
 * register themselves and appear here automatically — no host edits.
 *
 * Migration note: today the host renders panel *bodies* and the caller supplies
 * the section wrapper. Once multiple panels per type are migrated, the host will
 * own per-panel sections and the manual wrappers in EditorPage get removed.
 */
const lazyCache = new Map<string, ComponentType<InspectorPanelProps>>();

function panelComponent(
  id: string,
  load: () => Promise<{ default: ComponentType<InspectorPanelProps> }>
): ComponentType<InspectorPanelProps> {
  const cached = lazyCache.get(id);
  if (cached) {
    return cached;
  }
  const component = lazy(load);
  lazyCache.set(id, component);
  return component;
}

export interface InspectorHostProps {
  layer: TimelineLayer;
  onChange: (updater: (layer: TimelineLayer) => TimelineLayer) => void;
  /** Optional: restrict to specific registered panel ids (used during incremental migration). */
  panelIds?: string[];
  /** Current playback position (absolute composition seconds). Forwarded to panels that use it. */
  currentTime?: number | undefined;
  /** Seek the playhead. Forwarded to panels that use it (e.g. TransformPanel graph editor). */
  onSeek?: ((seconds: number) => void) | undefined;
  /** Composition pixel dimensions, forwarded to panels that author comp-space geometry (masks). */
  composition?: { width: number; height: number } | undefined;
  /** Mask currently edited in the preview, forwarded to the Mask panel. */
  activeMaskId?: string | undefined;
  /** Select a mask for preview editing, forwarded to the Mask panel. */
  onSelectMask?: ((maskId: string | null) => void) | undefined;
  /** Switch the active preview mask tool, forwarded to the Mask panel ("+ Pen"). */
  onChangeMaskTool?: ((tool: MaskTool) => void) | undefined;
  /** Saved motion tracks, forwarded to the Mask panel for mask tracking. */
  trackLibrary?: SavedTrack[] | undefined;
  /** Auto-keyframe mode, forwarded to panels so value edits drop keyframes at the playhead. */
  autoKeyframe?: boolean | undefined;
}

/**
 * memo(): hosts sit inside per-cold-commit parents (LayerInspector under <ColdTime>). While paused
 * the playhead prop is stable, so with identity-stable callbacks (EditorPage's inspectorHandlers
 * block) and module-constant panelIds, unrelated parent renders skip the lazy panel subtrees.
 */
export const InspectorHost = memo(InspectorHostImpl);

function InspectorHostImpl({ layer, onChange, panelIds, currentTime, onSeek, composition, activeMaskId, onSelectMask, onChangeMaskTool, trackLibrary, autoKeyframe }: InspectorHostProps) {
  const panels = useMemo(() => {
    const all = inspectorRegistry.panelsFor(layer.type);
    return panelIds ? all.filter((panel) => panelIds.includes(panel.id)) : all;
  }, [layer.type, panelIds]);

  return (
    <>
      {panels.map((panel) => {
        const Panel = panelComponent(panel.id, panel.load);
        return (
          <Suspense key={panel.id} fallback={null}>
            <Panel
              layer={layer}
              onChange={onChange}
              currentTime={currentTime}
              onSeek={onSeek}
              composition={composition}
              activeMaskId={activeMaskId}
              onSelectMask={onSelectMask}
              onChangeMaskTool={onChangeMaskTool}
              trackLibrary={trackLibrary}
              autoKeyframe={autoKeyframe}
            />
          </Suspense>
        );
      })}
    </>
  );
}
