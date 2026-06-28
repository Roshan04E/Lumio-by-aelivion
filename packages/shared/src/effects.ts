import type { TimelineEffect, TimelineEffectParamValue, TimelineEffectType, TimelineLayerType } from "./types";
import { CREATIVE_LOOK_NAMES } from "./color/looks";

export type TimelineEffectCategory = "Adjust" | "Stylize" | "Blur" | "Keying" | "Motion" | "Texture";
export type TimelineEffectScope = "clip" | "track" | "adjustment" | "transition";

export type TimelineEffectParamDefinition =
  | {
      key: string;
      label: string;
      type: "number";
      min: number;
      max: number;
      step: number;
      defaultValue: number;
      unit?: string | undefined;
      keyframeable?: boolean | undefined;
    }
  | {
      key: string;
      label: string;
      type: "color";
      defaultValue: string;
    }
  | {
      key: string;
      label: string;
      type: "boolean";
      defaultValue: boolean;
    }
  | {
      key: string;
      label: string;
      type: "select";
      defaultValue: string;
      options: Array<{ label: string; value: string }>;
    }
  | {
      key: string;
      label: string;
      /**
       * A real graph curve (Phase 3, 13C.1). `defaultValue` is a JSON string of
       * `ChannelCurves` ({ master/red/green/blue: {x,y}[] }); the inspector renders
       * an interactive curve editor, not a slider.
       */
      type: "curve";
      defaultValue: string;
    }
  | {
      key: string;
      label: string;
      /**
       * 3-way color wheels (Phase 3, 13C.2). `defaultValue` is a JSON string of
       * `ColorWheels` ({ shadows/midtones/highlights: {x,y,master} }); the inspector
       * renders interactive color-balance wheels, not sliders.
       */
      type: "wheels";
      defaultValue: string;
    }
  | {
      key: string;
      label: string;
      /**
       * Lumetri hue/sat curves (Phase 3, 13C.3). `defaultValue` is a JSON string of
       * `HueSatCurves` ({ hueVsHue/hueVsSat/hueVsLuma/lumaVsSat/satVsSat: {x,y}[] });
       * the inspector renders the five domain-colored graph curves. WebGL-only.
       */
      type: "hueCurves";
      defaultValue: string;
    }
  | {
      key: string;
      label: string;
      /**
       * HSL Secondary keyer (Phase 3, 13C.3). `defaultValue` is a JSON string of
       * `HslSecondary` (key band + feather + hue/sat/luma correction + showMask); the
       * inspector renders the keyer UI with a mask-preview toggle. WebGL-only.
       */
      type: "secondary";
      defaultValue: string;
    }
  | {
      key: string;
      label: string;
      /**
       * Creative look selector (Phase 3, 13C.4). `defaultValue` is the look name string;
       * the inspector renders a dropdown of built-in looks from the look registry.
       */
      type: "look";
      defaultValue: string;
      options: Array<{ label: string; value: string }>;
    }
  | {
      key: string;
      label: string;
      /**
       * Imported .cube LUT (Phase 3, 13C.4). `defaultValue` is ""; the inspector renders
       * a file-picker button. The value is a base64-encoded Float32 LUT from `lut3dToBase64`.
       * WebGL/CPU only — SVG can't express 3D LUTs.
       */
      type: "lut";
      defaultValue: string;
    };

export interface TimelineEffectDefinition {
  type: TimelineEffectType;
  name: string;
  description: string;
  category: TimelineEffectCategory;
  scope: TimelineEffectScope[];
  compatibleLayerTypes: TimelineLayerType[];
  defaultIntensity: number;
  previewSupport: "native" | "approximate" | "manifest-only";
  renderSupport: "native" | "approximate" | "manifest-only";
  params: TimelineEffectParamDefinition[];
}

export const timelineEffectRegistry: TimelineEffectDefinition[] = [
  {
    type: "blur",
    name: "Gaussian Blur",
    description: "Softens the selected layer.",
    category: "Blur",
    scope: ["clip", "adjustment"],
    compatibleLayerTypes: ["video", "image", "text", "shape", "adjustment"],
    defaultIntensity: 45,
    previewSupport: "native",
    renderSupport: "native",
    params: [{ key: "amount", label: "Amount", type: "number", min: 0, max: 40, step: 1, defaultValue: 8, unit: "px", keyframeable: true }]
  },
  {
    type: "brightnessContrast",
    name: "Basic Color Correction",
    description: "Lightweight primary correction: exposure, contrast, color, and tonal curve controls.",
    category: "Adjust",
    scope: ["clip", "adjustment"],
    compatibleLayerTypes: ["video", "image", "adjustment"],
    defaultIntensity: 50,
    previewSupport: "native",
    renderSupport: "native",
    params: [
      { key: "exposure", label: "Exposure", type: "number", min: -100, max: 100, step: 1, defaultValue: 0, keyframeable: true },
      { key: "contrast", label: "Contrast", type: "number", min: -100, max: 100, step: 1, defaultValue: 0, keyframeable: true },
      { key: "highlights", label: "Highlights", type: "number", min: -100, max: 100, step: 1, defaultValue: 0, keyframeable: true },
      { key: "shadows", label: "Shadows", type: "number", min: -100, max: 100, step: 1, defaultValue: 0, keyframeable: true },
      { key: "whites", label: "Whites", type: "number", min: -100, max: 100, step: 1, defaultValue: 0, keyframeable: true },
      { key: "blacks", label: "Blacks", type: "number", min: -100, max: 100, step: 1, defaultValue: 0, keyframeable: true },
      { key: "saturation", label: "Saturation", type: "number", min: 0, max: 220, step: 1, defaultValue: 100, unit: "%", keyframeable: true },
      { key: "vibrance", label: "Vibrance", type: "number", min: -100, max: 100, step: 1, defaultValue: 0, keyframeable: true },
      { key: "temperature", label: "Temperature", type: "number", min: -100, max: 100, step: 1, defaultValue: 0, keyframeable: true },
      { key: "tint", label: "Tint", type: "number", min: -100, max: 100, step: 1, defaultValue: 0, keyframeable: true },
      { key: "curveShadows", label: "Curve shadows", type: "number", min: -100, max: 100, step: 1, defaultValue: 0, keyframeable: true },
      { key: "curveMidtones", label: "Curve midtones", type: "number", min: -100, max: 100, step: 1, defaultValue: 0, keyframeable: true },
      { key: "curveHighlights", label: "Curve highlights", type: "number", min: -100, max: 100, step: 1, defaultValue: 0, keyframeable: true }
    ]
  },
  // NOTE: the old shallow "Color Grade" (quick sat+warmth) and scalar "Tone Curves"
  // effects were removed from the panel — superseded by "Basic Color Correction"
  // (brightnessContrast) + the real graph "Curves" (colorCurves). Their types stay in
  // the union + color engine for back-compat so older saved projects still render.
  {
    type: "glow",
    name: "Glow",
    description: "Adds soft luminous bloom around layer edges.",
    category: "Stylize",
    scope: ["clip", "adjustment"],
    compatibleLayerTypes: ["video", "image", "text", "shape", "adjustment"],
    defaultIntensity: 45,
    previewSupport: "native",
    renderSupport: "native",
    params: [
      { key: "radius", label: "Radius", type: "number", min: 0, max: 48, step: 1, defaultValue: 14, unit: "px", keyframeable: true },
      { key: "color", label: "Color", type: "color", defaultValue: "#C9FF4A" }
    ]
  },
  {
    type: "grain",
    name: "Film Grain",
    description: "Real per-pixel, luminance-aware film grain (WebGL, baked into the render).",
    category: "Texture",
    scope: ["clip", "adjustment"],
    compatibleLayerTypes: ["video", "image", "adjustment"],
    defaultIntensity: 25,
    previewSupport: "native",
    renderSupport: "native",
    params: [{ key: "amount", label: "Amount", type: "number", min: 0, max: 100, step: 1, defaultValue: 18, unit: "%", keyframeable: true }]
  },
  {
    type: "vignette",
    name: "Vignette",
    description: "Smooth radial edge darkening with adjustable size (WebGL shader).",
    category: "Stylize",
    scope: ["clip", "adjustment"],
    compatibleLayerTypes: ["video", "image", "adjustment"],
    defaultIntensity: 30,
    previewSupport: "native",
    renderSupport: "native",
    params: [
      { key: "amount", label: "Amount", type: "number", min: 0, max: 100, step: 1, defaultValue: 35, unit: "%", keyframeable: true },
      { key: "size", label: "Size", type: "number", min: 0, max: 100, step: 1, defaultValue: 58, unit: "%", keyframeable: true }
    ]
  },
  {
    type: "chromaKey",
    name: "Chroma Key",
    description: "Real color-distance keyer with soft edge + spill suppression (WebGL).",
    category: "Keying",
    scope: ["clip"],
    compatibleLayerTypes: ["video", "image"],
    defaultIntensity: 50,
    previewSupport: "native",
    renderSupport: "native",
    params: [
      { key: "color", label: "Key color", type: "color", defaultValue: "#00FF00" },
      { key: "tolerance", label: "Tolerance", type: "number", min: 0, max: 100, step: 1, defaultValue: 30, unit: "%", keyframeable: true },
      { key: "softness", label: "Edge softness", type: "number", min: 0, max: 100, step: 1, defaultValue: 12, unit: "%", keyframeable: true }
    ]
  },
  {
    type: "colorCurves",
    name: "Curves",
    description: "Pro RGB + master tone curves — drag points on the graph to reshape tone and color.",
    category: "Adjust",
    scope: ["clip", "adjustment"],
    compatibleLayerTypes: ["video", "image", "adjustment"],
    defaultIntensity: 100,
    previewSupport: "native",
    renderSupport: "native",
    // Single graph param: the inspector renders an interactive curve editor (all four
    // channels) and stores ChannelCurves as JSON. "{}" = identity (no change).
    params: [{ key: "curve", label: "Curves", type: "curve", defaultValue: "{}" }]
  },
  {
    type: "colorWheels",
    name: "Color Wheels",
    description: "3-way Lift/Gamma/Gain — balance color in shadows, midtones, and highlights on color wheels.",
    category: "Adjust",
    scope: ["clip", "adjustment"],
    compatibleLayerTypes: ["video", "image", "adjustment"],
    defaultIntensity: 100,
    previewSupport: "native",
    renderSupport: "native",
    // Single wheels param: the inspector renders three interactive color wheels and
    // stores ColorWheels as JSON. "{}" = identity (no change).
    params: [{ key: "wheels", label: "Color Wheels", type: "wheels", defaultValue: "{}" }]
  },
  {
    type: "hueSatCurves",
    name: "Hue/Sat Curves",
    description: "Lumetri hue curves — shift hue, push saturation or luma per color, and shape sat vs luma/sat. WebGL engine.",
    category: "Adjust",
    scope: ["clip", "adjustment"],
    compatibleLayerTypes: ["video", "image", "adjustment"],
    defaultIntensity: 100,
    previewSupport: "native",
    renderSupport: "native",
    // Single graph param: the inspector renders the five domain-colored hue/sat curves and
    // stores HueSatCurves as JSON. "{}" = identity (flat 0.5 baseline = no change).
    params: [{ key: "curves", label: "Hue/Sat Curves", type: "hueCurves", defaultValue: "{}" }]
  },
  {
    type: "hslSecondary",
    name: "HSL Secondary",
    description: "Isolate a color by hue/sat/luma (feathered key) and re-grade only that range. Mask preview. WebGL engine.",
    category: "Adjust",
    scope: ["clip", "adjustment"],
    compatibleLayerTypes: ["video", "image", "adjustment"],
    defaultIntensity: 100,
    previewSupport: "native",
    renderSupport: "native",
    // Single keyer param: the inspector renders the HSL key + correction UI and stores
    // HslSecondary as JSON. "{}" = neutral (full-range key, no correction).
    params: [{ key: "secondary", label: "HSL Secondary", type: "secondary", defaultValue: "{}" }]
  },
  {
    type: "creativeLook",
    name: "Creative Look",
    description: "One-click cinematic look preset — Teal & Orange, Faded Film, Noir and more — with intensity control.",
    category: "Adjust",
    scope: ["clip", "adjustment"],
    compatibleLayerTypes: ["video", "image", "adjustment"],
    defaultIntensity: 100,
    previewSupport: "native",
    renderSupport: "native",
    params: [
      {
        key: "look",
        label: "Look",
        type: "look",
        defaultValue: CREATIVE_LOOK_NAMES[0] ?? "",
        options: CREATIVE_LOOK_NAMES.map((n) => ({ label: n, value: n }))
      },
      { key: "intensity", label: "Intensity", type: "number", min: 0, max: 100, step: 1, defaultValue: 100, unit: "%" }
    ]
  },
  {
    type: "importedLut",
    name: "LUT",
    description: "Import a .cube LUT file for creative grading — any 3-D LUT at up to 65³ resolution.",
    category: "Adjust",
    scope: ["clip", "adjustment"],
    compatibleLayerTypes: ["video", "image", "adjustment"],
    defaultIntensity: 100,
    previewSupport: "native",
    renderSupport: "native",
    params: [
      { key: "lut", label: "LUT file", type: "lut", defaultValue: "" },
      { key: "intensity", label: "Intensity", type: "number", min: 0, max: 100, step: 1, defaultValue: 100, unit: "%" }
    ]
  },
  {
    type: "volume",
    name: "Volume",
    description: "Adjust a clip's audio level. Keyframe the gain for fade in / out.",
    category: "Adjust",
    scope: ["clip"],
    compatibleLayerTypes: ["audio", "video"],
    defaultIntensity: 100,
    previewSupport: "native",
    renderSupport: "native",
    params: [{ key: "gain", label: "Gain", type: "number", min: 0, max: 200, step: 1, defaultValue: 100, unit: "%", keyframeable: true }]
  }
];

export function getTimelineEffectDefinition(type: TimelineEffectType) {
  return timelineEffectRegistry.find((effect) => effect.type === type);
}

export function getTimelineEffectsForLayer(layerType: TimelineLayerType) {
  return timelineEffectRegistry.filter((effect) => effect.compatibleLayerTypes.includes(layerType));
}

export function createTimelineEffect(type: TimelineEffectType): TimelineEffect {
  const definition = getTimelineEffectDefinition(type);
  const params = Object.fromEntries((definition?.params ?? []).map((param) => [param.key, param.defaultValue]));
  return {
    id: `effect_${type}_${Date.now()}`,
    type,
    name: definition?.name ?? type,
    enabled: true,
    intensity: definition?.defaultIntensity ?? 50,
    params
  };
}

export function normalizeTimelineEffect(effect: TimelineEffect): TimelineEffect {
  const definition = getTimelineEffectDefinition(effect.type);
  if (!definition) {
    return effect;
  }

  const migratedParams = migrateTimelineEffectParams(effect);

  return {
    ...effect,
    name: effect.name || definition.name,
    intensity: Number.isFinite(effect.intensity) ? effect.intensity : definition.defaultIntensity,
    params: {
      ...Object.fromEntries(definition.params.map((param) => [param.key, param.defaultValue])),
      ...migratedParams
    }
  };
}

export function timelineEffectParamValue(effect: TimelineEffect, key: string): TimelineEffectParamValue | undefined {
  return normalizeTimelineEffect(effect).params?.[key];
}

function migrateTimelineEffectParams(effect: TimelineEffect) {
  const params = effect.params ?? {};
  if (effect.type !== "brightnessContrast") {
    return params;
  }

  const hasModernBasicCorrection = "exposure" in params || "highlights" in params || "saturation" in params;
  if (hasModernBasicCorrection) {
    return params;
  }

  return {
    ...params,
    exposure: toNumber(params.brightness, 100) - 100,
    contrast: toNumber(params.contrast, 100) - 100
  };
}

function toNumber(value: TimelineEffectParamValue | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}
