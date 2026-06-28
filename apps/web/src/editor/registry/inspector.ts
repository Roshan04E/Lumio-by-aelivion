import type { ComponentType } from "react";
import type { TimelineLayer, TimelineLayerType } from "@reelforge/shared";
import type { SavedTrack } from "../../lib/trackLibrary";

/**
 * Inspector Registry (Phase 3 scaffolding).
 *
 * The inspector becomes data-driven: instead of `EditorPage` switching on
 * `layer.type` with inline JSX, each layer type collects a set of registered
 * panel providers, rendered with progressive disclosure (basic → advanced →
 * expert). Adding/refining a control means registering a panel, not editing the
 * monolith.
 */
export type InspectorTier = "basic" | "advanced" | "expert";

export interface InspectorPanelProps {
  layer: TimelineLayer;
  /** Functional layer update — the host wires this to the store/action registry. */
  onChange: (updater: (layer: TimelineLayer) => TimelineLayer) => void;
  /** Current playback position (absolute composition seconds). Used by panels that
   *  need to read/write keyframes at the playhead (e.g. TransformPanel). */
  currentTime?: number | undefined;
  /** Seek the playhead to an absolute composition time. Used by graph-editor navigation. */
  onSeek?: ((seconds: number) => void) | undefined;
  /** Composition pixel dimensions — panels that author comp-space geometry (e.g. masks) need these. */
  composition?: { width: number; height: number } | undefined;
  /** The mask currently being edited in the preview (so the panel can highlight it). */
  activeMaskId?: string | undefined;
  /** Select a mask for editing in the preview overlay. */
  onSelectMask?: ((maskId: string | null) => void) | undefined;
  /** Switch the active preview mask tool (so "+ Pen"/"+ Polygon" can start a draw). */
  onChangeMaskTool?: ((tool: MaskTool) => void) | undefined;
  /** Saved motion tracks (editableFields.trackLibrary) — masks can follow one (mask tracking). */
  trackLibrary?: SavedTrack[] | undefined;
}

/** Mask drawing/editing tools shared by the preview toolbar, overlay, and inspector. */
export type MaskTool = "select" | "rectangle" | "ellipse" | "pen" | "polygon";

export interface InspectorPanelProvider {
  id: string;
  /** Section title, e.g. "Transform", "Typography", "Mask". */
  title: string;
  tier: InspectorTier;
  /** Layer types this panel applies to. */
  appliesTo: TimelineLayerType[];
  /** Lower sorts first within a tier. */
  order?: number;
  /** Lazy panel component; loaded only when its layer type is selected. */
  load: () => Promise<{ default: ComponentType<InspectorPanelProps> }>;
}

export class InspectorRegistry {
  private readonly panels: InspectorPanelProvider[] = [];

  register(panel: InspectorPanelProvider): this {
    // Idempotent by id: replace an existing provider rather than appending a duplicate.
    // The module-level `registered`/`seeded` guards reset on Vite HMR while this registry
    // singleton persists, so a naive push would accumulate duplicate panels and render each
    // inspector section twice. Replacing also lets a hot-reloaded panel's new `load` win.
    const existingIndex = this.panels.findIndex((existing) => existing.id === panel.id);
    if (existingIndex >= 0) {
      this.panels[existingIndex] = panel;
    } else {
      this.panels.push(panel);
    }
    return this;
  }

  /** Ordered panels for a layer type, grouped-ready (sorted by tier then order). */
  panelsFor(type: TimelineLayerType): InspectorPanelProvider[] {
    const tierRank: Record<InspectorTier, number> = { basic: 0, advanced: 1, expert: 2 };
    return this.panels
      .filter((panel) => panel.appliesTo.includes(type))
      .sort((a, b) => tierRank[a.tier] - tierRank[b.tier] || (a.order ?? 0) - (b.order ?? 0));
  }
}

export const inspectorRegistry = new InspectorRegistry();
