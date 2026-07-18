import type { TimelineEffect, TimelineEffectParamValue, TimelineEffectType, TimelineLayerType } from "./types";
import { CREATIVE_LOOK_NAMES } from "./color/looks";
import { registerBuiltinFragmentEffects } from "./color/fragment-effects/builtins";

// Ensures the 5 builtin fragment-shader effects (radial/directional blur, sharpen, pixelate,
// chromatic aberration) are registered wherever this module (the central effect registry) loads —
// web, worker, and tests alike. See `color/fragment-effects/builtins.ts`.
registerBuiltinFragmentEffects();

export type TimelineEffectCategory = "Adjust" | "Stylize" | "Blur" | "Keying" | "Motion" | "Texture" | "Audio";
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
    // Colour grades apply to text/shape too — every renderer grades overlays (DOM SVG filter, Remotion,
    // export overlay-grade, and the GPU scene pass), so they belong in the inspector for those layers.
    compatibleLayerTypes: ["video", "image", "text", "shape", "adjustment"],
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
    description: "Edge glow around alpha edges (text/cutouts), or a highlight bloom that makes bright areas of footage glow outward.",
    category: "Stylize",
    scope: ["clip", "adjustment"],
    compatibleLayerTypes: ["video", "image", "text", "shape", "adjustment"],
    defaultIntensity: 45,
    previewSupport: "native",
    renderSupport: "native",
    params: [
      // Edge = bloom the alpha silhouette (text/shapes/person cutouts). Highlights = luminance bloom: bright
      // areas of the content glow outward (works on opaque footage, where an edge glow has no edges to bloom).
      {
        key: "mode",
        label: "Mode",
        type: "select",
        defaultValue: "edge",
        options: [
          { label: "Edge", value: "edge" },
          { label: "Highlights (bloom)", value: "highlights" }
        ]
      },
      { key: "radius", label: "Radius", type: "number", min: 0, max: 160, step: 1, defaultValue: 14, unit: "px", keyframeable: true },
      // Highlights mode only: the luminance above which pixels start to bloom (0 = everything, 100 = only the brightest).
      { key: "threshold", label: "Threshold", type: "number", min: 0, max: 100, step: 1, defaultValue: 55, unit: "%", keyframeable: true },
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
    params: [
      { key: "amount", label: "Amount", type: "number", min: 0, max: 100, step: 1, defaultValue: 18, unit: "%", keyframeable: true },
      { key: "size", label: "Size", type: "number", min: 25, max: 400, step: 1, defaultValue: 100, unit: "%", keyframeable: true }
    ]
  },
  {
    type: "vignette",
    name: "Vignette",
    description: "Smooth radial edge darkening with size, feather, roundness, and highlight protection (WebGL shader).",
    category: "Stylize",
    scope: ["clip", "adjustment"],
    compatibleLayerTypes: ["video", "image", "adjustment"],
    defaultIntensity: 30,
    previewSupport: "native",
    renderSupport: "native",
    params: [
      { key: "amount", label: "Amount", type: "number", min: 0, max: 100, step: 1, defaultValue: 35, unit: "%", keyframeable: true },
      { key: "size", label: "Size", type: "number", min: 0, max: 100, step: 1, defaultValue: 58, unit: "%", keyframeable: true },
      { key: "feather", label: "Feather", type: "number", min: 0, max: 100, step: 1, defaultValue: 100, unit: "%", keyframeable: true },
      { key: "roundness", label: "Roundness", type: "number", min: 0, max: 100, step: 1, defaultValue: 0, unit: "%", keyframeable: true },
      { key: "highlights", label: "Protect highlights", type: "number", min: 0, max: 100, step: 1, defaultValue: 0, unit: "%", keyframeable: true }
    ]
  },
  {
    type: "chromaKey",
    name: "Chroma Key",
    description: "Chroma-plane (YCbCr) keyer for any key color: soft edge, despill, matte choke, and a matte view for tuning (WebGL).",
    category: "Keying",
    scope: ["clip"],
    compatibleLayerTypes: ["video", "image"],
    defaultIntensity: 50,
    previewSupport: "native",
    renderSupport: "native",
    params: [
      { key: "color", label: "Key color", type: "color", defaultValue: "#00FF00" },
      { key: "tolerance", label: "Tolerance", type: "number", min: 0, max: 100, step: 1, defaultValue: 30, unit: "%", keyframeable: true },
      { key: "softness", label: "Edge softness", type: "number", min: 0, max: 100, step: 1, defaultValue: 12, unit: "%", keyframeable: true },
      { key: "despill", label: "Despill", type: "number", min: 0, max: 100, step: 1, defaultValue: 60, unit: "%", keyframeable: true },
      { key: "choke", label: "Choke", type: "number", min: 0, max: 100, step: 1, defaultValue: 0, unit: "%", keyframeable: true },
      { key: "matteView", label: "Show matte", type: "boolean", defaultValue: false }
    ]
  },
  {
    type: "colorCurves",
    name: "Curves",
    description: "Pro RGB + master tone curves — drag points on the graph to reshape tone and color.",
    category: "Adjust",
    scope: ["clip", "adjustment"],
    compatibleLayerTypes: ["video", "image", "text", "shape", "adjustment"],
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
    compatibleLayerTypes: ["video", "image", "text", "shape", "adjustment"],
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
    compatibleLayerTypes: ["video", "image", "text", "shape", "adjustment"],
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
    compatibleLayerTypes: ["video", "image", "text", "shape", "adjustment"],
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
    compatibleLayerTypes: ["video", "image", "text", "shape", "adjustment"],
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
    compatibleLayerTypes: ["video", "image", "text", "shape", "adjustment"],
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
  },
  // ── Clip audio FX ─────────────────────────────────────────────────────────
  // Real DSP in all three renderers via ONE shared implementation (audio-fx.ts): preview runs it
  // in an AudioWorklet, local export processes decoded PCM, the cloud worker post-mix runs it in
  // Node. Params are static per clip in v1 (not keyframeable) and `intensity` is ignored — a
  // wet/dry blend on dynamics stops behaving like dynamics.
  {
    type: "audioEq",
    name: "EQ",
    description: "Three-band equalizer with low-cut and high-cut filters (RBJ biquads, matching Web Audio's filters exactly).",
    category: "Audio",
    scope: ["clip"],
    compatibleLayerTypes: ["audio"],
    defaultIntensity: 100,
    previewSupport: "native",
    renderSupport: "native",
    params: [
      { key: "lowCutHz", label: "Low Cut", type: "number", min: 0, max: 400, step: 5, defaultValue: 0, unit: "Hz" },
      { key: "lowShelfDb", label: "Low Gain", type: "number", min: -12, max: 12, step: 0.5, defaultValue: 0, unit: "dB" },
      { key: "lowShelfHz", label: "Low Freq", type: "number", min: 60, max: 500, step: 5, defaultValue: 120, unit: "Hz" },
      { key: "midDb", label: "Mid Gain", type: "number", min: -12, max: 12, step: 0.5, defaultValue: 0, unit: "dB" },
      { key: "midHz", label: "Mid Freq", type: "number", min: 200, max: 8000, step: 50, defaultValue: 1000, unit: "Hz" },
      { key: "midQ", label: "Mid Q", type: "number", min: 0.3, max: 4, step: 0.1, defaultValue: 1 },
      { key: "highShelfDb", label: "High Gain", type: "number", min: -12, max: 12, step: 0.5, defaultValue: 0, unit: "dB" },
      { key: "highShelfHz", label: "High Freq", type: "number", min: 2000, max: 16000, step: 100, defaultValue: 8000, unit: "Hz" },
      { key: "highCutHz", label: "High Cut", type: "number", min: 0, max: 20000, step: 100, defaultValue: 0, unit: "Hz" }
    ]
  },
  {
    type: "audioCompressor",
    name: "Compressor",
    description: "Soft-knee dynamics compressor (stereo-linked) with makeup gain — even out dialog or tighten a music bed.",
    category: "Audio",
    scope: ["clip"],
    compatibleLayerTypes: ["audio"],
    defaultIntensity: 100,
    previewSupport: "native",
    renderSupport: "native",
    params: [
      { key: "thresholdDb", label: "Threshold", type: "number", min: -60, max: 0, step: 1, defaultValue: -24, unit: "dB" },
      { key: "ratio", label: "Ratio", type: "number", min: 1, max: 20, step: 0.5, defaultValue: 3, unit: ":1" },
      { key: "kneeDb", label: "Knee", type: "number", min: 0, max: 24, step: 1, defaultValue: 6, unit: "dB" },
      { key: "attackMs", label: "Attack", type: "number", min: 0.1, max: 100, step: 0.1, defaultValue: 10, unit: "ms" },
      { key: "releaseMs", label: "Release", type: "number", min: 10, max: 1000, step: 10, defaultValue: 150, unit: "ms" },
      { key: "makeupDb", label: "Makeup", type: "number", min: 0, max: 24, step: 0.5, defaultValue: 0, unit: "dB" }
    ]
  },
  {
    type: "audioGate",
    name: "Noise Gate",
    description: "Mutes the clip below a threshold — removes room tone and bleed between phrases.",
    category: "Audio",
    scope: ["clip"],
    compatibleLayerTypes: ["audio"],
    defaultIntensity: 100,
    previewSupport: "native",
    renderSupport: "native",
    params: [
      { key: "thresholdDb", label: "Threshold", type: "number", min: -80, max: 0, step: 1, defaultValue: -50, unit: "dB" },
      { key: "reduceDb", label: "Reduction", type: "number", min: 0, max: 80, step: 1, defaultValue: 80, unit: "dB" },
      { key: "attackMs", label: "Attack", type: "number", min: 0.1, max: 50, step: 0.1, defaultValue: 2, unit: "ms" },
      { key: "holdMs", label: "Hold", type: "number", min: 0, max: 500, step: 10, defaultValue: 50, unit: "ms" },
      { key: "releaseMs", label: "Release", type: "number", min: 10, max: 1000, step: 10, defaultValue: 120, unit: "ms" }
    ]
  },
  {
    type: "audioLimiter",
    name: "Limiter",
    description: "Hard ceiling on the clip's level — stops peaks from clipping without squashing the body of the sound.",
    category: "Audio",
    scope: ["clip"],
    compatibleLayerTypes: ["audio"],
    defaultIntensity: 100,
    previewSupport: "native",
    renderSupport: "native",
    params: [
      { key: "ceilingDb", label: "Ceiling", type: "number", min: -12, max: 0, step: 0.5, defaultValue: -1, unit: "dB" },
      { key: "releaseMs", label: "Release", type: "number", min: 5, max: 500, step: 5, defaultValue: 50, unit: "ms" }
    ]
  },
  {
    // Plugin-authored real GLSL fragment effect. Params are dynamic per-manifest — the inspector
    // reads them from the fragment definition (`getFragmentEffect(effect.params.__shaderManifestId)`)
    // rather than from this static `params: []`.
    type: "pluginShader",
    name: "Custom Shader",
    description: "A user-authored GLSL fragment effect, rendered natively in preview, export, and Remotion.",
    category: "Stylize",
    scope: ["clip"],
    compatibleLayerTypes: ["video", "image", "text", "shape"],
    defaultIntensity: 100,
    previewSupport: "native",
    renderSupport: "native",
    params: []
  },
  // Builtin fragment-shader effects (2026-07-14) — real GLSL passes, same harness as Custom Shader
  // above, but first-class registry types (see `color/fragment-effects/builtins.ts`) rather than a
  // user-uploaded manifest. `buildFragmentPasses` in `scene/build-scene-draws.ts` maps these types
  // straight to their `builtin.<type>` fragment definition.
  {
    type: "radialBlur",
    name: "Radial Blur",
    description: "Zoom-style blur radiating from a center point (real GLSL shader).",
    category: "Blur",
    scope: ["clip", "adjustment"],
    compatibleLayerTypes: ["video", "image", "text", "shape", "adjustment"],
    defaultIntensity: 100,
    previewSupport: "native",
    renderSupport: "native",
    params: [
      { key: "amount", label: "Amount", type: "number", min: 0, max: 100, step: 1, defaultValue: 40, unit: "%", keyframeable: true },
      { key: "centerX", label: "Center X", type: "number", min: 0, max: 100, step: 1, defaultValue: 50, unit: "%", keyframeable: true },
      { key: "centerY", label: "Center Y", type: "number", min: 0, max: 100, step: 1, defaultValue: 50, unit: "%", keyframeable: true }
    ]
  },
  {
    type: "directionalBlur",
    name: "Directional Blur",
    description: "Linear motion-streak blur along an angle (real GLSL shader).",
    category: "Blur",
    scope: ["clip", "adjustment"],
    compatibleLayerTypes: ["video", "image", "text", "shape", "adjustment"],
    defaultIntensity: 100,
    previewSupport: "native",
    renderSupport: "native",
    params: [
      { key: "amount", label: "Amount", type: "number", min: 0, max: 100, step: 1, defaultValue: 40, unit: "%", keyframeable: true },
      { key: "angle", label: "Angle", type: "number", min: -180, max: 180, step: 1, defaultValue: 0, unit: "°", keyframeable: true }
    ]
  },
  {
    type: "sharpen",
    name: "Sharpen",
    description: "Unsharp-mask edge sharpening (real GLSL shader).",
    category: "Stylize",
    scope: ["clip", "adjustment"],
    compatibleLayerTypes: ["video", "image", "text", "shape", "adjustment"],
    defaultIntensity: 100,
    previewSupport: "native",
    renderSupport: "native",
    params: [{ key: "amount", label: "Amount", type: "number", min: 0, max: 100, step: 1, defaultValue: 40, unit: "%", keyframeable: true }]
  },
  {
    type: "pixelate",
    name: "Pixelate",
    description: "Mosaic pixelation block effect (real GLSL shader).",
    category: "Stylize",
    scope: ["clip", "adjustment"],
    compatibleLayerTypes: ["video", "image", "text", "shape", "adjustment"],
    defaultIntensity: 100,
    previewSupport: "native",
    renderSupport: "native",
    params: [{ key: "blockSize", label: "Block Size", type: "number", min: 1, max: 200, step: 1, defaultValue: 16, unit: "px", keyframeable: true }]
  },
  {
    type: "chromaticAberration",
    name: "Chromatic Aberration",
    description: "RGB channel offset along an angle for a lens/glitch fringing look (real GLSL shader).",
    category: "Stylize",
    scope: ["clip", "adjustment"],
    compatibleLayerTypes: ["video", "image", "text", "shape", "adjustment"],
    defaultIntensity: 100,
    previewSupport: "native",
    renderSupport: "native",
    params: [
      { key: "amount", label: "Amount", type: "number", min: 0, max: 100, step: 1, defaultValue: 30, unit: "%", keyframeable: true },
      { key: "angle", label: "Angle", type: "number", min: -180, max: 180, step: 1, defaultValue: 0, unit: "°", keyframeable: true }
    ]
  },
  // 2026-07-17 stylize pack (user request: sketch / old TV / glitch as adjustment-clip effects).
  // Same builtin fragment harness — real GLSL, all three renderers, zero per-renderer code.
  {
    type: "sketch",
    name: "Pencil Sketch",
    description: "Sobel-edge pencil sketch on paper with grain (real GLSL shader).",
    category: "Stylize",
    scope: ["clip", "adjustment"],
    compatibleLayerTypes: ["video", "image", "text", "shape", "adjustment"],
    defaultIntensity: 100,
    previewSupport: "native",
    renderSupport: "native",
    params: [
      { key: "detail", label: "Detail", type: "number", min: 0, max: 100, step: 1, defaultValue: 55, unit: "%", keyframeable: true },
      { key: "contrast", label: "Contrast", type: "number", min: 0, max: 100, step: 1, defaultValue: 40, unit: "%", keyframeable: true }
    ]
  },
  {
    type: "oldTv",
    name: "Old TV",
    description: "CRT look: scanlines, static, sync jitter, aged-phosphor tint, vignette (real GLSL shader).",
    category: "Stylize",
    scope: ["clip", "adjustment"],
    compatibleLayerTypes: ["video", "image", "text", "shape", "adjustment"],
    defaultIntensity: 100,
    previewSupport: "native",
    renderSupport: "native",
    params: [
      { key: "scanlines", label: "Scanlines", type: "number", min: 0, max: 100, step: 1, defaultValue: 60, unit: "%", keyframeable: true },
      { key: "noise", label: "Noise", type: "number", min: 0, max: 100, step: 1, defaultValue: 35, unit: "%", keyframeable: true },
      { key: "jitter", label: "Jitter", type: "number", min: 0, max: 100, step: 1, defaultValue: 30, unit: "%", keyframeable: true },
      { key: "vignette", label: "Vignette", type: "number", min: 0, max: 100, step: 1, defaultValue: 50, unit: "%", keyframeable: true }
    ]
  },
  {
    type: "glitchFx",
    name: "Glitch",
    description: "Digital glitch: row tearing + RGB split, tick-animated (real GLSL shader).",
    category: "Stylize",
    scope: ["clip", "adjustment"],
    compatibleLayerTypes: ["video", "image", "text", "shape", "adjustment"],
    defaultIntensity: 100,
    previewSupport: "native",
    renderSupport: "native",
    params: [
      { key: "amount", label: "Amount", type: "number", min: 0, max: 100, step: 1, defaultValue: 50, unit: "%", keyframeable: true },
      { key: "blockiness", label: "Blockiness", type: "number", min: 0, max: 100, step: 1, defaultValue: 40, unit: "%", keyframeable: true },
      { key: "speed", label: "Speed", type: "number", min: 0, max: 100, step: 1, defaultValue: 50, unit: "%", keyframeable: true }
    ]
  },
  {
    type: "halftone",
    name: "Halftone",
    description: "Print-style halftone dot screen with screen angle (real GLSL shader).",
    category: "Stylize",
    scope: ["clip", "adjustment"],
    compatibleLayerTypes: ["video", "image", "text", "shape", "adjustment"],
    defaultIntensity: 100,
    previewSupport: "native",
    renderSupport: "native",
    params: [
      { key: "dotSize", label: "Dot Size", type: "number", min: 2, max: 40, step: 1, defaultValue: 8, unit: "px", keyframeable: true },
      { key: "angle", label: "Angle", type: "number", min: -90, max: 90, step: 1, defaultValue: 25, unit: "°", keyframeable: true }
    ]
  },
  {
    type: "posterize",
    name: "Posterize",
    description: "Quantize colors to a fixed number of levels (real GLSL shader).",
    category: "Stylize",
    scope: ["clip", "adjustment"],
    compatibleLayerTypes: ["video", "image", "text", "shape", "adjustment"],
    defaultIntensity: 100,
    previewSupport: "native",
    renderSupport: "native",
    params: [{ key: "levels", label: "Levels", type: "number", min: 2, max: 16, step: 1, defaultValue: 5, keyframeable: true }]
  },
  {
    type: "stylize",
    name: "Stylize",
    description:
      "Illustration engine: anisotropic-Kuwahara paint, flow-guided ink lines, cel shading — Painterly / Anime Cel / Manga / Sketch (multi-pass GPU graph, temporally stable on video).",
    category: "Stylize",
    scope: ["clip", "adjustment"],
    compatibleLayerTypes: ["video", "image", "text", "shape", "adjustment"],
    defaultIntensity: 100,
    previewSupport: "native",
    renderSupport: "native",
    params: [
      {
        key: "styleMode",
        label: "Style",
        type: "select",
        defaultValue: "0",
        options: [
          { label: "Painterly", value: "0" },
          { label: "Anime Cel", value: "1" },
          { label: "Manga", value: "2" },
          { label: "Sketch", value: "3" }
        ]
      },
      { key: "paintRadius", label: "Brush Size", type: "number", min: 1, max: 6, step: 1, defaultValue: 4, unit: "px", keyframeable: true },
      { key: "paintSharpness", label: "Edge Hardness", type: "number", min: 1, max: 16, step: 1, defaultValue: 8, keyframeable: true },
      { key: "palettePunch", label: "Color Punch", type: "number", min: 0, max: 100, step: 1, defaultValue: 35, unit: "%", keyframeable: true },
      { key: "inkStrength", label: "Ink Lines", type: "number", min: 0, max: 100, step: 1, defaultValue: 0, unit: "%", keyframeable: true },
      { key: "inkThickness", label: "Line Weight", type: "number", min: 0.5, max: 4, step: 0.5, defaultValue: 2, keyframeable: true },
      { key: "celBands", label: "Cel Bands", type: "number", min: 0, max: 10, step: 1, defaultValue: 0, keyframeable: true }
    ]
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
