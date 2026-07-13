import type { TimelineLayerType } from "@kimera-by-aelivion/shared";

/**
 * Resolve-style top-level inspector tabs (Video/Text/Shape | Audio | Effects).
 * Replaces the single long accordion scroll: each tab shows only its sections, which
 * kills the stacked-headers problem. Color grading deliberately stays OUT of these
 * tabs — the left panel's Color tab (Lumetri + scopes) is the one color surface
 * (user call 2026-07-12: three color entry points was two too many).
 * The active tab is remembered per layer type across selections (module map, not
 * state — survives unmounts without a store).
 */
export type InspectorTabId = "video" | "audio" | "effects" | "graphics";

const lastTabByLayerType = new Map<TimelineLayerType, InspectorTabId>();

export function availableInspectorTabs(type: TimelineLayerType): InspectorTabId[] {
  if (type === "audio") return ["audio", "effects"];
  // Graphics = the Essential Graphics surface (layer stack, align, vector properties) for every
  // visual layer type — mirrors Premiere v25's contextual Properties panel split.
  return ["video", "effects", "graphics"];
}

/** First tab label adapts to the layer ("Video" reads wrong on a text layer). */
export function inspectorTabLabel(tab: InspectorTabId, type: TimelineLayerType): string {
  if (tab === "video") {
    if (type === "text") return "Text";
    if (type === "shape") return "Shape";
    return "Video";
  }
  if (tab === "audio") return "Audio";
  if (tab === "graphics") return "Graphics";
  return "Effects";
}

export function rememberedInspectorTab(type: TimelineLayerType): InspectorTabId {
  const tabs = availableInspectorTabs(type);
  const remembered = lastTabByLayerType.get(type);
  return remembered && tabs.includes(remembered) ? remembered : tabs[0]!;
}

export function rememberInspectorTab(type: TimelineLayerType, tab: InspectorTabId): void {
  lastTabByLayerType.set(type, tab);
}

export function InspectorTabs({
  layerType,
  active,
  onChange
}: {
  layerType: TimelineLayerType;
  active: InspectorTabId;
  onChange: (tab: InspectorTabId) => void;
}) {
  const tabs = availableInspectorTabs(layerType);
  if (tabs.length < 2) return null;
  return (
    <div className="inspector-tabs" role="tablist" aria-label="Inspector sections">
      {tabs.map((tab) => (
        <button
          className={tab === active ? "is-active" : ""}
          key={tab}
          role="tab"
          aria-selected={tab === active}
          type="button"
          onClick={() => onChange(tab)}
        >
          {inspectorTabLabel(tab, layerType)}
        </button>
      ))}
    </div>
  );
}
