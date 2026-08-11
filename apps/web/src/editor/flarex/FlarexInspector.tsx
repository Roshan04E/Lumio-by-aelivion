/**
 * Flarex node inspector — NOT a property panel. It is a thin consumer of the application's ONE inspector:
 * it asks the adapter (`buildFlarexNodeFields`) to translate the selected node's DEFINITION into the
 * shared `PropertyField[]` model, then hands that to the shared `PropertyFieldList`, which renders every
 * row through the same controls the Edit-page inspector uses. There is no node-specific control, layout,
 * or dispatch logic here — deleting the adapter would remove the translation, not a single widget.
 *
 * The only Flarex-specific chrome is the DOCK FRAME (resizable width + a maximize toggle that lifts the
 * panel to a full-height column beside the main inspector), parallel to how the app docks its own panels.
 */

import { useEffect, useRef, useState } from "react";
import { Maximize2, Minimize2, Eye } from "lucide-react";
import { getFlarexNodeDefinition, type FlarexComp, type FlarexNode } from "@orreris/shared";
import { InspectorSection } from "../inspector/InspectorSection";
import { PropertyFieldList } from "../inspector/PropertyFieldList";
import { FlarexNodeIcon } from "./flarex-node-icons";
import { buildFlarexColorNodeSections, buildFlarexNodeFields } from "./flarex-inspector-fields";
import type { FlarexSourceAssetOption } from "./FlarexSourcePicker";
import type { SceneViewerCaptureHandle } from "../../components/ScenePreviewCanvas";
import type { SavedTrack } from "../../lib/trackLibrary";

const WIDTH_KEY = "flarex.inspectorWidth";
const MAX_KEY = "flarex.inspectorMax";
// ≥ the shared inspector grid's intrinsic minimum (label+control+value+reset columns) so the shared rows
// never collapse/overlap — the node inspector gives the same rows the same room as the Edit inspector.
const MIN_W = 280;
const MAX_W = 560;

export interface FlarexInspectorProps {
  comp: FlarexComp;
  node: FlarexNode | null;
  onUpdateComp: (updater: (comp: FlarexComp) => FlarexComp) => void;
  /** Comp-local playhead (shared transport − layer.startSeconds, clamped ≥ 0) — where keyframes land. */
  compTime: number;
  /** Seek the shared transport to a comp-local time (used by prev/next keyframe nav). */
  onSeekCompTime: (compTime: number) => void;
  /** Media-pool assets a MediaIn node may load (asset-source MediaIn, FLAREX.md Phase 2). */
  sourceAssets?: FlarexSourceAssetOption[];
  /** Enter media-pool "pick one" mode for this MediaIn node's source (the shared Replace-asset flow). */
  onPickSource?: ((nodeId: string) => void) | undefined;
  /** Open the Source Viewer (proxy vs original A/B) for an asset. */
  onInspectSource?: ((assetId: string) => void) | undefined;
  /** Saved tracks a Tracker node may follow (`editableFields.trackLibrary`). */
  trackLibrary?: SavedTrack[];
  /** Eyedropper context (see `FlarexKeyColorPicker`): the clip carrying the comp, the viewer's capture
   *  handle, and the transport state. Passed straight through to the field adapter; absent ⇒ colour
   *  rows render as the plain shared picker. */
  hostLayerId?: string | null | undefined;
  viewerCaptureRef?: React.MutableRefObject<SceneViewerCaptureHandle | null> | undefined;
  isPlaying?: boolean;
}

export function FlarexInspector({ comp, node, onUpdateComp, compTime, onSeekCompTime, sourceAssets = [], onPickSource, onInspectSource, trackLibrary = [], hostLayerId = null, viewerCaptureRef, isPlaying = false }: FlarexInspectorProps) {
  const [width, setWidth] = useState<number>(() => {
    const stored = Number(window.localStorage.getItem(WIDTH_KEY));
    return Number.isFinite(stored) && stored >= MIN_W && stored <= MAX_W ? stored : 300;
  });
  const resizeRef = useRef<{ startX: number; startW: number } | null>(null);
  // Maximize: the node inspector is cramped in the workspace corner, so a toggle lifts it to a
  // full-height column docked immediately LEFT of the main clip inspector (which stays open) — read a
  // node's params and the clip's grade side by side. Persisted like the width.
  const [maximized, setMaximized] = useState<boolean>(() => window.localStorage.getItem(MAX_KEY) === "1");
  const toggleMax = () => {
    setMaximized((m) => {
      const next = !m;
      window.localStorage.setItem(MAX_KEY, next ? "1" : "0");
      return next;
    });
  };
  // Drive the editor layout so a maximized inspector sits ALONGSIDE the viewer (shrinking it), never on
  // top: widen the right column by the inspector's width via a class + var on `.editor-layout`.
  useEffect(() => {
    const layout = document.querySelector<HTMLElement>(".editor-layout");
    if (!layout) return undefined;
    if (maximized) {
      layout.classList.add("is-flarex-inspector-max");
      layout.style.setProperty("--flarex-max-w", `${width}px`);
    } else {
      layout.classList.remove("is-flarex-inspector-max");
      layout.style.removeProperty("--flarex-max-w");
    }
    return () => {
      layout.classList.remove("is-flarex-inspector-max");
      layout.style.removeProperty("--flarex-max-w");
    };
  }, [maximized, width]);

  const onResizeDown = (event: React.PointerEvent) => {
    resizeRef.current = { startX: event.clientX, startW: width };
    (event.target as Element).setPointerCapture(event.pointerId);
  };
  const onResizeMove = (event: React.PointerEvent) => {
    const r = resizeRef.current;
    if (!r) return;
    // Handle sits on the LEFT edge — dragging left widens the panel.
    setWidth(Math.max(MIN_W, Math.min(MAX_W, r.startW + (r.startX - event.clientX))));
  };
  const onResizeUp = () => {
    if (!resizeRef.current) return;
    resizeRef.current = null;
    window.localStorage.setItem(WIDTH_KEY, String(width));
  };

  const shell = (children: React.ReactNode) => (
    <aside className={`flarex-inspector${maximized ? " flarex-inspector--max" : ""}`} style={{ flex: `0 0 ${width}px`, width }}>
      <div
        className="flarex-inspector-resize"
        title="Drag to resize"
        onPointerDown={onResizeDown}
        onPointerMove={onResizeMove}
        onPointerUp={onResizeUp}
        onPointerCancel={onResizeUp}
      />
      <button
        type="button"
        className="flarex-inspector-max-btn"
        title={maximized ? "Restore node inspector" : "Maximize node inspector (full height, beside the main inspector)"}
        aria-pressed={maximized}
        onClick={toggleMax}
      >
        {maximized ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
      </button>
      {children}
    </aside>
  );

  if (!node) {
    return shell(
      <div className="inspector-panel">
        <div className="empty-mini">
          <Eye size={16} />
          Select a node to edit its properties
        </div>
      </div>,
    );
  }

  const def = getFlarexNodeDefinition(node.type);
  // The WHOLE Flarex-specific step: node definition → shared inspector schema. Everything below renders
  // through the same InspectorSection + `.effect-controls` container + shared controls as the Edit page.
  const builderArgs = { comp, node, compTime, onUpdateComp, onSeekCompTime, sourceAssets, onPickSource, onInspectSource, trackLibrary, hostLayerId, viewerCaptureRef, isPlaying };

  // The unified Color node carries the whole grade toolset (~25 params), so it renders as collapsible
  // stages in PIPELINE ORDER instead of one wall of sliders — a section header's dot says whether that
  // stage is doing anything, which is what lets you read a collapsed node at a glance. Still the same
  // PropertyFieldList underneath: sections are layout around the sole renderer, not a new field kind.
  if (node.type === "color") {
    const sections = buildFlarexColorNodeSections(builderArgs);
    return shell(
      <div className="inspector-panel">
        {sections.map((section) => (
          <InspectorSection
            key={section.id}
            title={section.label}
            // The shared "has edits" dot — top-right beside the reset, exactly as the clip inspector's
            // Color sections show it. (It was appended to the TITLE string before, which put it next to
            // the label and made the two panels disagree.)
            active={section.active}
            // Per-stage reset, beside the dot — the same affordance and the same position as the clip
            // inspector's Colour sections. Its absence here was the last place the two panels disagreed.
            onReset={section.onReset}
            collapsible
            defaultOpen={section.defaultOpen}
          >
            <div className="effect-controls">
              <PropertyFieldList fields={section.fields} />
            </div>
          </InspectorSection>
        ))}
      </div>,
    );
  }

  const fields = buildFlarexNodeFields(builderArgs);

  return shell(
    <div className="inspector-panel">
      <InspectorSection title={node.label ?? def.label} icon={<FlarexNodeIcon type={node.type} size={14} />} collapsible={false}>
        <div className="effect-controls">
          <PropertyFieldList fields={fields} />
        </div>
      </InspectorSection>
    </div>,
  );
}
