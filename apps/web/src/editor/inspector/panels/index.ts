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

  // Content / Crop — reframe the SOURCE inside the clip (pan/zoom/crop), separate from the comp Transform.
  // Media only (text/shape have no source to reframe). Sits just under Transform.
  inspectorRegistry.register({
    id: "content",
    title: "Content / Crop",
    tier: "basic",
    appliesTo: ["video", "image"],
    order: 20,
    load: () => import("./ContentPanel")
  });

  // Editable vector graphic — fill color (and future stroke/opacity). Renders only for image layers that
  // carry `layer.graphic` (a Search → Graphics pick); a no-op for photo/file image layers.
  inspectorRegistry.register({
    id: "graphic",
    title: "Graphic",
    tier: "basic",
    appliesTo: ["image"],
    order: 15,
    load: () => import("./GraphicPanel")
  });

  inspectorRegistry.register({
    id: "text.warp",
    title: "Warp",
    tier: "advanced",
    appliesTo: ["text"],
    order: 40,
    load: () => import("./TextWarpPanel")
  });

  // Vector clip masks — crop a layer to a shape. Media masks on its comp-sized element; text/shape mask via
  // a comp-space, transform-less wrapper (getOverlayMaskWrapperStyle), rendered in every path (DOM/scene/
  // Remotion/export) since Phase 4.1c — so the section applies to all visual layer types.
  inspectorRegistry.register({
    id: "mask",
    title: "Masks",
    tier: "advanced",
    appliesTo: ["video", "image", "text", "shape", "adjustment"],
    order: 30,
    load: () => import("./MaskPanel")
  });
}
