import { inspectorRegistry } from "../../registry/inspector";

/**
 * Registers the inspector panels that have been migrated out of the EditorPage
 * monolith (Phase 4, ongoing). Each panel is a lazy dynamic import so its code
 * only loads when a matching layer type is selected. Idempotent.
 */
let registered = false;

export function registerBuiltinInspectorPanels(): void {
  if (registered) {
    return;
  }
  registered = true;

  // Transform controls + graph editor + animation presets (all layer types).
  // Order 10 keeps it at the top of the basic tier for every layer.
  inspectorRegistry.register({
    id: "transform",
    title: "Transform",
    tier: "basic",
    appliesTo: ["text", "image", "video", "shape", "adjustment"],
    order: 10,
    load: () => import("./TransformPanel")
  });

  inspectorRegistry.register({
    id: "text.warp",
    title: "Warp",
    tier: "advanced",
    appliesTo: ["text"],
    order: 40,
    load: () => import("./TextWarpPanel")
  });

  // Vector masks (Phase 1) — clip-level masks on full-bleed media layers.
  inspectorRegistry.register({
    id: "mask",
    title: "Masks",
    tier: "advanced",
    appliesTo: ["video", "image"],
    order: 30,
    load: () => import("./MaskPanel")
  });
}
