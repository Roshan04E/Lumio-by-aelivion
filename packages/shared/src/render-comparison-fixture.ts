import type { ProjectGraph, SourceAsset, TimelineLayer } from "./types";
import { applyCaptionTrackToComposition, captionStylePresets, createCaptionTrack, parseTranscriptInput } from "./captions";
import { createBoxMask } from "./clip-masks";
import { registerFragmentEffect } from "./color/fragment-effects/registry";
import { SHADER_MANIFEST_ID_PARAM_KEY } from "./plugin-effect-adapter";
import { createFlarexNode } from "./flarex/node-defs";
import { createFlarexComp } from "./flarex/registry";
import type { FlarexComp } from "./flarex/types";

const fixtureImageSvg = encodeURIComponent(`
<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1920" viewBox="0 0 1080 1920">
  <defs>
    <linearGradient id="sky" x1="0" x2="0" y1="0" y2="1">
      <stop offset="0" stop-color="#f4c7a7"/>
      <stop offset="0.34" stop-color="#b28a7d"/>
      <stop offset="1" stop-color="#16100c"/>
    </linearGradient>
    <linearGradient id="hill" x1="0" x2="1" y1="0" y2="1">
      <stop offset="0" stop-color="#5d2c16"/>
      <stop offset="0.56" stop-color="#b85b20"/>
      <stop offset="1" stop-color="#27160f"/>
    </linearGradient>
    <filter id="soft"><feGaussianBlur stdDeviation="24"/></filter>
  </defs>
  <rect width="1080" height="1920" fill="url(#sky)"/>
  <circle cx="860" cy="240" r="130" fill="#ffe1a6" opacity="0.68" filter="url(#soft)"/>
  <path d="M0 680 C230 500 330 760 560 600 C760 460 910 520 1080 430 L1080 1920 L0 1920Z" fill="#39241c" opacity="0.74"/>
  <path d="M0 980 C210 820 410 940 620 780 C800 642 940 690 1080 590 L1080 1920 L0 1920Z" fill="url(#hill)"/>
  <path d="M190 1920 C130 1580 360 1450 300 1230 C260 1080 400 920 620 820" fill="none" stroke="#090b10" stroke-width="72" stroke-linecap="round"/>
  <path d="M190 1920 C130 1580 360 1450 300 1230 C260 1080 400 920 620 820" fill="none" stroke="#d8dbe3" stroke-width="8" stroke-linecap="round" opacity="0.92"/>
  <path d="M210 1920 C150 1580 382 1450 322 1230 C282 1080 422 920 642 820" fill="none" stroke="#d8dbe3" stroke-width="5" stroke-linecap="round" opacity="0.62"/>
  ${Array.from({ length: 34 })
    .map((_, index) => {
      const x = (index * 151) % 1080;
      const y = 720 + ((index * 97) % 1000);
      const r = 28 + ((index * 19) % 58);
      const color = ["#d86f24", "#8f3f19", "#f0a545", "#4f2a16"][index % 4];
      return `<circle cx="${x}" cy="${y}" r="${r}" fill="${color}" opacity="0.58"/>`;
    })
    .join("")}
</svg>`);

const fixturePersonMatteSvg = encodeURIComponent(`
<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1920" viewBox="0 0 1080 1920">
  <rect width="1080" height="1920" fill="#000000"/>
  <ellipse cx="540" cy="880" rx="245" ry="320" fill="#ffffff"/>
  <rect x="360" y="1130" width="360" height="520" rx="120" fill="#ffffff"/>
  <circle cx="445" cy="740" r="54" fill="#ffffff"/>
  <circle cx="635" cy="740" r="54" fill="#ffffff"/>
</svg>`);

// LANDSCAPE (1920x1080), deliberately the opposite orientation of the 1080x1920 comp — every other
// fixture's media asset already matches the comp's aspect, which is exactly why none of them caught a
// Flarex asset-source MediaIn stretching a mismatched-aspect clip (virtual-layers.ts's hardcoded
// `fit: "fill"`). Four saturated vertical bars + a center circle: "cover" (crop, correct) keeps the
// bars square-cornered and the circle round; "fill" (stretch, the bug) squeezes all four bars into
// view and the circle into a tall ellipse — a large, unambiguous, deterministic diff either way.
const fixtureMismatchedAspectSvg = encodeURIComponent(`
<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080" viewBox="0 0 1920 1080">
  <rect x="0" y="0" width="480" height="1080" fill="#e63946"/>
  <rect x="480" y="0" width="480" height="1080" fill="#f4a300"/>
  <rect x="960" y="0" width="480" height="1080" fill="#2a9d8f"/>
  <rect x="1440" y="0" width="480" height="1080" fill="#264653"/>
  <circle cx="960" cy="540" r="200" fill="#ffffff"/>
</svg>`);

// RENDERER-DIVERGENCE coverage under a non-identity host transform (project-tracker/architectural-debt.md
// DEBT-017) — NOT a DEBT-016 staleness guard (render:compare:pixels is differential; DEBT-016's cache
// lives only on the web-preview side, so it never shows up as a preview/export disagreement — the
// two-render unit test flarex-source-draw-cache-transform.test.ts is that guard). What this DOES catch:
// if a future change makes ONE renderer handle a host transform differently from the other, this is the
// first of the 14 Flarex fixtures able to see it — the other 13 sit at an identity host transform, where
// there is nothing to diverge on. Falsified against exactly that shape (a temporary Remotion-only
// perturbation in SceneStage.tsx, reverted): 56.226% diff, failed as expected; restored, 0.000%, passed.
// Matches the comp's own aspect (1080x1920) so "cover" fit does not crop it — a plain teal/white checker,
// distinct from the warm-gradient host asset, so a merge between the two is visually unambiguous in the
// diff PNGs.
const fixtureHostTransformMediaSvg = encodeURIComponent(`
<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1920" viewBox="0 0 1080 1920">
  <rect width="1080" height="1920" fill="#1e6b63"/>
  <rect x="0" y="0" width="540" height="960" fill="#2fae9e"/>
  <rect x="540" y="960" width="540" height="960" fill="#2fae9e"/>
  <circle cx="540" cy="960" r="260" fill="#ffffff"/>
</svg>`);

export const renderComparisonFrameSeconds = 0.45;
export const renderComparisonArtifactDir = "render-comparison";

/**
 * Pixel-comparison fixture variants. Each isolates one render concern so a regression
 * points at a specific code path. `default` is the rich color fixture (curves + HSL
 * secondary, used historically); the others are added for the unified-WebGL parity sweep.
 */
export type RenderComparisonFixtureKey =
  | "default"
  | "plain-image"
  | "brightness-contrast"
  | "color-curves"
  | "object-fit-cover"
  | "object-fit-contain"
  | "content-transform"
  | "person-matte"
  | "blur"
  | "glow"
  | "region-blur"
  | "masked-blur"
  | "clip-region-blur"
  | "two-region-effects"
  | "overlap-region-effects"
  | "feather-region-blur"
  | "tilt-3d"
  | "scaled-text"
  | "media-opacity"
  | "graded-text"
  | "masked-text"
  | "region-text"
  | "tilted-text"
  | "transition"
  | "advanced-transition"
  | "plugin-shader"
  | "stylize"
  | "stylize-ink"
  | "stylize-print"
  | "stylize-subject"
  | "vignette"

  | "grain"
  | "chroma-key"
  | "framed-media"
  | "framed-blob"
  | "track-matte"
  | "anchored-media"
  | "nested-transition"
  | "nested-grade"
  | "nested-junction-transition"
  | "nested-junction-preroll"
  | "texture-fill"
  | "flarex-key-glow"
  | "flarex-curves"
  | "flarex-keyframed-blur"
  | "flarex-merge-blend"
  | "flarex-transform"
  | "flarex-ellipse-matte"
  | "flarex-reroute"
  | "flarex-multi-in"
  | "flarex-color-chain"
  | "flarex-unified-color"
  | "flarex-filter-stack"
  | "flarex-generators"
  | "flarex-mismatched-aspect"
  | "flarex-host-transform"
  | "flarex-animated-roto";

export const renderComparisonFixtureKeys: RenderComparisonFixtureKey[] = [
  "default",
  "plain-image",
  "brightness-contrast",
  "color-curves",
  "object-fit-cover",
  "object-fit-contain",
  "content-transform",
  "blur",
  "glow",
  "region-blur",
  "masked-blur",
  "clip-region-blur",
  "two-region-effects",
  "overlap-region-effects",
  "feather-region-blur",
  "tilt-3d",
  "scaled-text",
  "media-opacity",
  "graded-text",
  "masked-text",
  "region-text",
  "tilted-text",
  "transition",
  "advanced-transition",
  "plugin-shader",
  "stylize",
  "stylize-ink",
  "stylize-print",
  "stylize-subject",
  "vignette",

  "grain",
  "chroma-key",
  "framed-media",
  "framed-blob",
  "track-matte",
  "anchored-media",
  "nested-transition",
  "nested-grade",
  "nested-junction-transition",
  "nested-junction-preroll",
  "texture-fill",
  "flarex-key-glow",
  "flarex-curves",
  "flarex-keyframed-blur",
  "flarex-merge-blend",
  "flarex-transform",
  "flarex-ellipse-matte",
  "flarex-reroute",
  "flarex-multi-in",
  "flarex-color-chain",
  "flarex-unified-color",
  "flarex-filter-stack",
  "flarex-generators",
  "flarex-mismatched-aspect",
  "flarex-host-transform",
  "flarex-animated-roto"
];

const fullColorEffects: TimelineLayer["effects"] = [
  {
    id: "fixture_curves",
    type: "colorCurves",
    name: "Curves",
    enabled: true,
    intensity: 100,
    params: {
      curve: JSON.stringify({
        master: [
          { x: 0, y: 0 },
          { x: 0.25, y: 0.18 },
          { x: 0.75, y: 0.82 },
          { x: 1, y: 1 }
        ],
        blue: [
          { x: 0, y: 0.06 },
          { x: 1, y: 0.94 }
        ]
      })
    }
  },
  {
    id: "fixture_secondary",
    type: "hslSecondary",
    name: "HSL Secondary",
    enabled: true,
    intensity: 100,
    params: {
      secondary: JSON.stringify({
        hueCenter: 0.07,
        hueWidth: 0.1,
        satMin: 0.12,
        satMax: 1,
        lumMin: 0.08,
        lumMax: 0.96,
        softness: 0.12,
        invert: false,
        hueShift: 0.05,
        satScale: 1.3,
        lumScale: 1,
        showMask: false
      })
    }
  }
];

const brightnessContrastEffects: TimelineLayer["effects"] = [
  {
    id: "fixture_basic_correction",
    type: "brightnessContrast",
    name: "Basic Color Correction",
    enabled: true,
    intensity: 100,
    params: {
      exposure: 18,
      contrast: 32,
      saturation: 128,
      temperature: -22,
      tint: 14
    }
  }
];

const colorCurvesEffects: TimelineLayer["effects"] = [
  {
    id: "fixture_curves_only",
    type: "colorCurves",
    name: "Curves",
    enabled: true,
    intensity: 100,
    params: {
      curve: JSON.stringify({
        master: [
          { x: 0, y: 0.04 },
          { x: 0.3, y: 0.22 },
          { x: 0.7, y: 0.8 },
          { x: 1, y: 0.97 }
        ],
        red: [
          { x: 0, y: 0.05 },
          { x: 1, y: 0.95 }
        ]
      })
    }
  }
];

// Method 3 Phase 2: blur/glow exercise the GPU effect passes in the scene compositor (dropped CSS
// filters in the DOM path). `region-blur` carries a mask on the blur effect so the duplicate-layer
// expansion (`expandEffectRegionMasks`) turns it into a region blur the scene path must reproduce.
const blurEffects: TimelineLayer["effects"] = [
  { id: "fixture_blur", type: "blur", name: "Blur", enabled: true, intensity: 100, params: { amount: 16 } }
];

const glowEffects: TimelineLayer["effects"] = [
  { id: "fixture_glow", type: "glow", name: "Glow", enabled: true, intensity: 100, params: { radius: 28, color: "#C9FF4A" } }
];

// Task 1.5 pixel gate: a real user GLSL "Custom Shader" (webgl-fragment) effect. Registered here so the
// fixture is self-contained for every renderer (web preview, browser export, Remotion) without needing a
// manifest-import step first; `examples/plugin-manifests/invert.effect.json` carries the SAME GLSL for the
// user-facing import flow. Deterministic (pure invert, no randomness) so preview/export/Remotion should
// match at ~0.000% at a strict pixel-gate tolerance.
export const EXAMPLE_INVERT_FRAGMENT_EFFECT_ID = "com.orreris.examples.invert";
registerFragmentEffect(
  {
    id: EXAMPLE_INVERT_FRAGMENT_EFFECT_ID,
    name: "Invert",
    category: "Stylize",
    params: [],
    glsl: `vec4 effect(vec2 uv){ vec4 s = getSrcColor(uv); return vec4(1.0 - s.rgb, s.a); }`
  },
  { override: true }
);

const pluginShaderEffects: TimelineLayer["effects"] = [
  {
    id: "fixture_plugin_shader",
    type: "pluginShader",
    name: "Custom Shader",
    enabled: true,
    intensity: 100,
    params: { [SHADER_MANIFEST_ID_PARAM_KEY]: EXAMPLE_INVERT_FRAGMENT_EFFECT_ID }
  }
];

// Stylize pass-graph fixture (plans/stylize-anime-engine.md P1): the FIRST multi-pass fragment
// effect through the pixel gate — tensor → tensorBlur → half-res anisotropic-Kuwahara paint →
// full-res tone, all deterministic (no time-driven randomness), so preview/export/Remotion must
// land at the strict bar. Trips if any renderer diverges on the scaled intermediate targets
// (working-res rounding), the multi-input sampler bindings, or the final intensity mix.
const stylizeEffects: TimelineLayer["effects"] = [
  {
    id: "fixture_stylize",
    type: "stylize",
    name: "Stylize",
    enabled: true,
    intensity: 100,
    params: { paintRadius: 4, paintSharpness: 8, palettePunch: 35 }
  }
];

// P2: the FULL graph engaged — Anime Cel mode with ink lines + cel bands (the dog/ink passes and
// the select→float styleMode plumbing all sit in this one fixture; the plain `stylize` fixture
// keeps P1's Painterly defaults as its own regression baseline).
const stylizeInkEffects: TimelineLayer["effects"] = [
  {
    id: "fixture_stylize_ink",
    type: "stylize",
    name: "Stylize",
    enabled: true,
    intensity: 100,
    params: { styleMode: "1", paintRadius: 4, paintSharpness: 8, palettePunch: 35, inkStrength: 70, inkThickness: 2, celBands: 5 }
  }
];

// P3: the Comic Print flagship — CMY halftone screens + plate misregistration + shadow hatching +
// paper grain, on top of ink + cel bands. All the print-craft branches in the tone pass sit under
// this one fixture.
const stylizePrintEffects: TimelineLayer["effects"] = [
  {
    id: "fixture_stylize_print",
    type: "stylize",
    name: "Stylize",
    enabled: true,
    intensity: 100,
    params: {
      styleMode: "4",
      paintRadius: 4,
      paintSharpness: 8,
      palettePunch: 45,
      inkStrength: 70,
      inkThickness: 2,
      celBands: 6,
      printDots: 65,
      printScale: 6,
      misprintPx: 2,
      paperAmount: 40
    }
  }
];

// P5: subject-aware styling — an ellipse "person" mask on the effect + Focus subject mode. Gates
// the maskAware path end to end: in-shader uPassMask weighting (focus keeps ink/punch, background
// flattens) INSTEAD of the binary after-composite, identically in every renderer.
const stylizeSubjectEffects: TimelineLayer["effects"] = [
  {
    id: "fixture_stylize_subject",
    type: "stylize",
    name: "Stylize",
    enabled: true,
    intensity: 100,
    params: {
      styleMode: "1",
      paintRadius: 4,
      paintSharpness: 8,
      palettePunch: 45,
      inkStrength: 70,
      inkThickness: 2,
      celBands: 5,
      subjectMode: "1",
      subjectBoost: 80
    },
    masks: [createBoxMask("ellipse", 420, 500, 660, 1420, 0)]
  }
];

const regionBlurEffects: TimelineLayer["effects"] = [
  {
    id: "fixture_region_blur",
    type: "blur",
    name: "Region Blur",
    enabled: true,
    intensity: 100,
    params: { amount: 24 },
    masks: [createBoxMask("rectangle", 300, 700, 780, 1200, 0)]
  }
];

// masked-blur: a whole-clip blur UNDER an ellipse clip-mask — exercises the scene compositor's mask +
// blur-edge handling (the comp corners outside the ellipse must stay background, no edge bleed).
const maskedBlurEffects: TimelineLayer["effects"] = [
  { id: "fixture_masked_blur", type: "blur", name: "Blur", enabled: true, intensity: 100, params: { amount: 18 } }
];

// Phase 4.1c: a color grade applied to the TEXT layer. The scene path now grades text through the SAME
// LUT engine as media (vs the old DOM fallback), so this fixture trips if the scene draws text ungraded.
const textGradeEffects: TimelineLayer["effects"] = [
  {
    id: "fixture_text_grade",
    type: "brightnessContrast",
    name: "Text grade",
    enabled: true,
    intensity: 100,
    params: { exposure: -8, contrast: 44, saturation: 70, temperature: 64, tint: -24 }
  }
];

// region-text: the SAME text grade limited to a REGION (left comp half) via an effect mask. Exercises
// expandLayerEffectRegions on a TEXT layer — only the masked region is graded; the rest stays the base look.
// Trips if region expansion is still media-only (the whole text would grade, or not at all).
const textRegionGradeEffects: TimelineLayer["effects"] = [
  {
    id: "fixture_text_region_grade",
    type: "brightnessContrast",
    name: "Text region grade",
    enabled: true,
    intensity: 100,
    params: { exposure: -8, contrast: 44, saturation: 70, temperature: 64, tint: -24 },
    masks: [createBoxMask("rectangle", 0, 0, 540, 1920, 0)]
  }
];

// two-region-effects: a blur region on the LEFT and a colour grade region on the RIGHT — DISJOINT. Locks the
// region-effect independence root fix: neither effect may bleed into the other's region (the blur must not
// appear in the graded region, and vice versa). Scene and DOM both run the shared `expandLayerEffectRegions`,
// so they must agree; a regression that re-introduces cross-effect inheritance trips this.
const twoRegionEffects: TimelineLayer["effects"] = [
  {
    id: "fixture_two_region_blur",
    type: "blur",
    name: "Region Blur (left)",
    enabled: true,
    intensity: 100,
    params: { amount: 24 },
    masks: [createBoxMask("rectangle", 100, 500, 500, 1400, 0)]
  },
  {
    id: "fixture_two_region_grade",
    type: "brightnessContrast",
    name: "Region Grade (right)",
    enabled: true,
    intensity: 100,
    params: { exposure: -8, contrast: 44, saturation: 70, temperature: 64, tint: -24 },
    masks: [createBoxMask("rectangle", 600, 500, 1000, 1400, 0)]
  }
];

// overlap-region-effects: a colour grade and a blur on the SAME region (identical masks; blur later in
// panel order). This is the fixture where the two region models INTENTIONALLY diverge: the clone-stack
// model draws the blur clone on top, so the region shows blur(ungraded base) — "top region effect wins";
// the pass model blurs the RUNNING image, so the region shows blur(graded base) — effects COMBINE (the AE
// model, todo.md TRUE fix). Flag OFF it gates scene-vs-DOM parity like any fixture; with REGION_PASSES=1
// the gate instead asserts scene(on) vs scene(off) DIFFER (combine engaged) — a DOM comparison would be
// asserting against the model this fixture exists to replace.
const overlapRegionEffects: TimelineLayer["effects"] = [
  {
    id: "fixture_overlap_grade",
    type: "brightnessContrast",
    name: "Overlap Region Grade",
    enabled: true,
    intensity: 100,
    params: { exposure: -8, contrast: 44, saturation: 70, temperature: 64, tint: -24 },
    masks: [createBoxMask("rectangle", 200, 500, 880, 1400, 0)]
  },
  {
    id: "fixture_overlap_blur",
    type: "blur",
    name: "Overlap Region Blur",
    enabled: true,
    intensity: 100,
    params: { amount: 24 },
    masks: [createBoxMask("rectangle", 200, 500, 880, 1400, 0)]
  }
];

// feather-region-blur: a region blur whose mask carries a non-zero FEATHER. Locks the mask-feather class
// (dim / hollow-ring / hard-edge regressions all change the feathered alpha ramp). Feather is a soft band, so
// the scene (matte blur) and DOM (CSS mask feather) differ somewhat at the edge — a looser per-fixture bar
// still trips a gross regression (a ring, a fully-dim matte, or a hard cut).
const featherRegionBlurEffects: TimelineLayer["effects"] = [
  {
    id: "fixture_feather_region_blur",
    type: "blur",
    name: "Feather Region Blur",
    enabled: true,
    intensity: 100,
    params: { amount: 24 },
    masks: [{ ...createBoxMask("ellipse", 300, 560, 780, 1360, 0), feather: 140 }]
  }
];

// Stylize/keyer fixtures (unified media shader): exercise every NEW param so a normalization or
// uniform-wiring regression trips the gate. All three render through the SAME MediaWebGLRenderer
// in every path. Grain is deterministic here: u_time = layer time at the fixed fixture frame
// (renderComparisonFrameSeconds) in preview, browser export, and Remotion alike.
const vignetteEffects: TimelineLayer["effects"] = [
  {
    id: "fixture_vignette",
    type: "vignette",
    name: "Vignette",
    enabled: true,
    intensity: 100,
    params: { amount: 55, size: 40, feather: 60, roundness: 100, highlights: 40 }
  }
];

const grainEffects: TimelineLayer["effects"] = [
  {
    id: "fixture_grain",
    type: "grain",
    name: "Film Grain",
    enabled: true,
    intensity: 100,
    params: { amount: 60, size: 150 }
  }
];

// Keys the fixture's hill ORANGE (#b85b20) — proves the CbCr keyer is generic (not green-only)
// without any new asset plumbing; despill + choke exercise the new matte controls.
const chromaKeyEffects: TimelineLayer["effects"] = [
  {
    id: "fixture_chroma_key",
    type: "chromaKey",
    name: "Chroma Key",
    enabled: true,
    intensity: 100,
    params: { color: "#b85b20", tolerance: 35, softness: 15, despill: 60, choke: 20, matteView: false }
  }
];

// Flarex parity fixture (FLAREX.md / plans/flarex-sonnet-execution.md S4): locks 3-renderer parity
// for the node-compositing lowering path (`compileFlarexComp` → SceneDraw), independent of the
// ordinary effects-array pixel gates above. MediaIn → ChromaKey → Transform → Glow → MediaOut,
// keying the SAME fixture-landscape orange hill the plain `chroma-key` effects fixture uses (no
// dedicated green-screen asset exists in this harness), scaled/offset, then glowed. The keyed-away
// corners must reveal the background layer underneath — a real composite, not a self-check.
function buildFlarexKeyGlowComp(): FlarexComp {
  const comp = createFlarexComp("fixture_flarex_comp", "Flarex fixture");
  const key = createFlarexNode("chromaKey", "fixture_flarex_key");
  key.params = { ...key.params, color: "#b85b20", tolerance: 0.3, softness: 0.12, spillSuppression: 0.5 };
  const transform = createFlarexNode("transform", "fixture_flarex_transform");
  transform.params = { ...transform.params, x: 8, y: -4, scale: 0.8 };
  const glow = createFlarexNode("glow", "fixture_flarex_glow");
  glow.params = { ...glow.params, radius: 20, intensity: 0.5, threshold: 0.6 };
  comp.nodes[key.id] = key;
  comp.nodes[transform.id] = transform;
  comp.nodes[glow.id] = glow;
  comp.edges = [
    { id: "fixture_flarex_e1", from: { nodeId: "fixture_flarex_comp_in", socket: "out" }, to: { nodeId: key.id, socket: "in" } },
    { id: "fixture_flarex_e2", from: { nodeId: key.id, socket: "out" }, to: { nodeId: transform.id, socket: "in" } },
    { id: "fixture_flarex_e3", from: { nodeId: transform.id, socket: "out" }, to: { nodeId: glow.id, socket: "in" } },
    { id: "fixture_flarex_e4", from: { nodeId: glow.id, socket: "out" }, to: { nodeId: "fixture_flarex_comp_out", socket: "in" } },
  ];
  return comp;
}

// N2 (plans/flarex-sonnet-execution-2.md): locks 3-renderer parity for the colorCurves node's
// lowering path, which the compiler previously built with a MISMATCHED synthetic effect param key
// (node stores `curves`, but the `colorCurves` effect type's pipeline reads `params.curve` —
// singular — so the node silently passed through). A strong, visible S-curve on the master channel
// makes a broken param-key wiring show up as a real pixel diff, not a silent no-op.
function buildFlarexCurvesComp(): FlarexComp {
  const comp = createFlarexComp("fixture_flarex_curves_comp", "Flarex curves fixture");
  const curves = createFlarexNode("colorCurves", "fixture_flarex_curves");
  curves.params = {
    ...curves.params,
    curves: JSON.stringify({
      master: [
        { x: 0, y: 0 },
        { x: 0.25, y: 0.06 },
        { x: 0.75, y: 0.94 },
        { x: 1, y: 1 }
      ]
    })
  };
  comp.nodes[curves.id] = curves;
  comp.edges = [
    { id: "fixture_flarex_curves_e1", from: { nodeId: "fixture_flarex_curves_comp_in", socket: "out" }, to: { nodeId: curves.id, socket: "in" } },
    { id: "fixture_flarex_curves_e2", from: { nodeId: curves.id, socket: "out" }, to: { nodeId: "fixture_flarex_curves_comp_out", socket: "in" } }
  ];
  return comp;
}

// N5 (plans/flarex-sonnet-execution-2.md, round-1 leftover): the harness renders ONE frame per
// fixture (`renderComparisonFrameSeconds` = 0.45s), so a keyframed-param fixture must sample
// MID-animation (not at a keyframe's own timestamp) — a broken evaluator path (e.g. one renderer
// silently ignoring `comp.animations` and using the base param) would still coincidentally match
// at t=0, but diverges at any interpolated point.
function buildFlarexKeyframedBlurComp(): FlarexComp {
  const comp = createFlarexComp("fixture_flarex_kfblur_comp", "Flarex keyframed blur fixture");
  const blur = createFlarexNode("blur", "fixture_flarex_kfblur");
  comp.nodes[blur.id] = blur;
  comp.edges = [
    { id: "fixture_flarex_kfblur_e1", from: { nodeId: "fixture_flarex_kfblur_comp_in", socket: "out" }, to: { nodeId: blur.id, socket: "in" } },
    { id: "fixture_flarex_kfblur_e2", from: { nodeId: blur.id, socket: "out" }, to: { nodeId: "fixture_flarex_kfblur_comp_out", socket: "in" } }
  ];
  // 0 -> 40px over t=[0, 1]; sampled at the harness's fixed frame (0.45s) lands mid-ramp (~18px),
  // nowhere near either keyframe's own value.
  comp.animations = [
    { id: "fixture_flarex_kfblur_k0", target: { scope: "flarexNode", effectId: blur.id, property: "sigma" }, timeSeconds: 0, value: 0, interpolation: "linear", temporal: {} },
    { id: "fixture_flarex_kfblur_k1", target: { scope: "flarexNode", effectId: blur.id, property: "sigma" }, timeSeconds: 1, value: 40, interpolation: "linear", temporal: {} }
  ];
  return comp;
}

// F6 (plans/flarex-sonnet-execution-3.md): merge with a NON-NORMAL blend mode. MediaIn feeds both
// merge inputs — bg unchanged, fg pushed through ColorCorrect first — so `multiply` at partial
// opacity produces a real, renderer-comparable composite (no keyer/asset dependency needed).
/**
 * FOUR colour nodes in series — the pipeline-coalescing path.
 *
 * The compiler now bakes a consecutive colour chain into ONE ColorPipeline instead of one nested
 * render target per node. That is a structural change to what the renderers receive, so it needs a
 * pixel gate: the coalesced result must match across preview, local export and Remotion, and must be
 * the same picture the four separate grades produced. Deliberately mixes all three payload shapes
 * (wheels JSON, curve JSON, qualifier JSON) with a scalar node, since they take different paths into
 * the grade compiler.
 */
function buildFlarexColorChainComp(): FlarexComp {
  const comp = createFlarexComp("fixture_flarex_chain_comp", "Flarex colour chain fixture");
  const wheels = createFlarexNode("colorWheels", "fixture_flarex_chain_wheels");
  wheels.params = {
    ...wheels.params,
    wheels: JSON.stringify({
      shadows: { x: -0.12, y: 0.08, master: -0.05 },
      midtones: { x: 0.18, y: -0.14, master: 0.1 },
      highlights: { x: 0.06, y: 0.04, master: 0.08 }
    })
  };
  const curves = createFlarexNode("colorCurves", "fixture_flarex_chain_curves");
  curves.params = {
    ...curves.params,
    curves: JSON.stringify({ master: [{ x: 0, y: 0 }, { x: 0.3, y: 0.22 }, { x: 0.7, y: 0.8 }, { x: 1, y: 1 }] })
  };
  const qualifier = createFlarexNode("hslQualifier", "fixture_flarex_chain_qual");
  qualifier.params = {
    ...qualifier.params,
    secondary: JSON.stringify({ hueCenter: 0.36, hueWidth: 0.14, softness: 0.08, satScale: 0.45, lumScale: 1.1 })
  };
  const correct = createFlarexNode("colorCorrect", "fixture_flarex_chain_cc");
  correct.params = { ...correct.params, exposure: 18, contrast: 12, saturation: 128, temperature: -14 };
  for (const node of [wheels, curves, qualifier, correct]) comp.nodes[node.id] = node;
  comp.edges = [
    { id: "fixture_flarex_chain_e1", from: { nodeId: "fixture_flarex_chain_comp_in", socket: "out" }, to: { nodeId: wheels.id, socket: "in" } },
    { id: "fixture_flarex_chain_e2", from: { nodeId: wheels.id, socket: "out" }, to: { nodeId: curves.id, socket: "in" } },
    { id: "fixture_flarex_chain_e3", from: { nodeId: curves.id, socket: "out" }, to: { nodeId: qualifier.id, socket: "in" } },
    { id: "fixture_flarex_chain_e4", from: { nodeId: qualifier.id, socket: "out" }, to: { nodeId: correct.id, socket: "in" } },
    { id: "fixture_flarex_chain_e5", from: { nodeId: correct.id, socket: "out" }, to: { nodeId: "fixture_flarex_chain_comp_out", socket: "in" } }
  ];
  return comp;
}

/**
 * The UNIFIED `color` node carrying the same grade the 4-node chain above builds, plus a vignette.
 *
 * This is the fixture that proves the node across all three renderers. The unit test already asserts
 * that one Color node and the equivalent chain compile to an IDENTICAL pipeline; this asserts that
 * what comes out the other end is identical in the web preview, the local export and Remotion — i.e.
 * that the many-params-in-one-node shape did not introduce a renderer-specific path.
 *
 * Grain is deliberately absent for the same reason as the filter-stack fixture: it reads `uTime`, and
 * a time-varying pattern is not something a single-frame parity gate can hold three renderers to.
 */
function buildFlarexUnifiedColorComp(): FlarexComp {
  const comp = createFlarexComp("fixture_flarex_unified_comp", "Flarex unified colour node fixture");
  const grade = createFlarexNode("color", "fixture_flarex_unified_grade");
  grade.params = {
    ...grade.params,
    exposure: 18,
    contrast: 12,
    saturation: 128,
    temperature: -14,
    wheels: JSON.stringify({
      shadows: { x: -0.12, y: 0.08, master: -0.05 },
      midtones: { x: 0.18, y: -0.14, master: 0.1 },
      highlights: { x: 0.06, y: 0.04, master: 0.08 }
    }),
    curves: JSON.stringify({ master: [{ x: 0, y: 0 }, { x: 0.3, y: 0.22 }, { x: 0.7, y: 0.8 }, { x: 1, y: 1 }] }),
    secondary: JSON.stringify({ hueCenter: 0.36, hueWidth: 0.14, softness: 0.08, satScale: 0.45, lumScale: 1.1 }),
    // Film section — a fragment pass on the SAME shell, not a pipeline stage.
    vignetteAmount: 0.42,
    vignetteSize: 0.55,
    vignetteFeather: 0.9
  };
  comp.nodes[grade.id] = grade;
  comp.edges = [
    { id: "fixture_flarex_unified_e1", from: { nodeId: "fixture_flarex_unified_comp_in", socket: "out" }, to: { nodeId: grade.id, socket: "in" } },
    { id: "fixture_flarex_unified_e2", from: { nodeId: grade.id, socket: "out" }, to: { nodeId: "fixture_flarex_unified_comp_out", socket: "in" } }
  ];
  return comp;
}

/**
 * The new fragment builtins stacked on ONE shell: Crop → Pixelate → Prism → Vignette.
 *
 * Crop and Channel-Boolean-class effects REWRITE alpha, so this also gates that the composite-back
 * replaces the running image rather than drawing over it (a cropped pixel must be transparent, not the
 * original pixel). Film Grain is deliberately absent: it reads `uTime`, and a time-varying pattern is
 * not something a single-frame parity gate can hold the three renderers to.
 */
function buildFlarexFilterStackComp(): FlarexComp {
  const comp = createFlarexComp("fixture_flarex_stack_comp", "Flarex filter stack fixture");
  const crop = createFlarexNode("crop", "fixture_flarex_stack_crop");
  crop.params = { ...crop.params, left: 0.08, right: 0.12, top: 0.05, bottom: 0.1, softness: 0.03 };
  const pixelate = createFlarexNode("pixelate", "fixture_flarex_stack_pix");
  pixelate.params = { ...pixelate.params, blockSize: 14 };
  const prism = createFlarexNode("prism", "fixture_flarex_stack_prism");
  prism.params = { ...prism.params, amount: 0.45, angle: 22 };
  const vignette = createFlarexNode("vignette", "fixture_flarex_stack_vig");
  vignette.params = { ...vignette.params, amount: 0.55, size: 0.5, feather: 0.9, roundness: 0.4, highlights: 0.2 };
  for (const node of [crop, pixelate, prism, vignette]) comp.nodes[node.id] = node;
  comp.edges = [
    { id: "fixture_flarex_stack_e1", from: { nodeId: "fixture_flarex_stack_comp_in", socket: "out" }, to: { nodeId: crop.id, socket: "in" } },
    { id: "fixture_flarex_stack_e2", from: { nodeId: crop.id, socket: "out" }, to: { nodeId: pixelate.id, socket: "in" } },
    { id: "fixture_flarex_stack_e3", from: { nodeId: pixelate.id, socket: "out" }, to: { nodeId: prism.id, socket: "in" } },
    { id: "fixture_flarex_stack_e4", from: { nodeId: prism.id, socket: "out" }, to: { nodeId: vignette.id, socket: "in" } },
    { id: "fixture_flarex_stack_e5", from: { nodeId: vignette.id, socket: "out" }, to: { nodeId: "fixture_flarex_stack_comp_out", socket: "in" } }
  ];
  return comp;
}

/**
 * Text+ over Background — the generator nodes, and the highest parity risk in the batch.
 *
 * Both are backed by virtual `text`/`shape` layers that each renderer RASTERIZES with its own canvas,
 * rather than by a decoded source. Font rasterization is exactly where three renderers are most likely
 * to disagree, so this gate is the one that says the Loader-style generator path really does produce
 * one picture everywhere. The MediaIn is left unwired on purpose: the comp is entirely synthetic, so a
 * failure here can only be the generators.
 */
function buildFlarexGeneratorsComp(): FlarexComp {
  const comp = createFlarexComp("fixture_flarex_gen_comp", "Flarex generators fixture");
  const background = createFlarexNode("background", "fixture_flarex_gen_bg");
  background.params = { ...background.params, color: "#1d3b6e", opacity: 1 };
  const text = createFlarexNode("text", "fixture_flarex_gen_text");
  text.params = {
    ...text.params,
    content: "FLAREX",
    fontFamily: "Inter",
    fontSize: 140,
    fontWeight: 700,
    color: "#ffd166",
    align: "center",
    x: 0.5,
    y: 0.5
  };
  const merge = createFlarexNode("merge", "fixture_flarex_gen_merge");
  for (const node of [background, text, merge]) comp.nodes[node.id] = node;
  comp.edges = [
    { id: "fixture_flarex_gen_e1", from: { nodeId: background.id, socket: "out" }, to: { nodeId: merge.id, socket: "bg" } },
    { id: "fixture_flarex_gen_e2", from: { nodeId: text.id, socket: "out" }, to: { nodeId: merge.id, socket: "fg" } },
    { id: "fixture_flarex_gen_e3", from: { nodeId: merge.id, socket: "out" }, to: { nodeId: "fixture_flarex_gen_comp_out", socket: "in" } }
  ];
  return comp;
}

function buildFlarexMergeBlendComp(): FlarexComp {
  const comp = createFlarexComp("fixture_flarex_blend_comp", "Flarex merge blend fixture");
  const grade = createFlarexNode("colorCorrect", "fixture_flarex_blend_grade");
  grade.params = { ...grade.params, exposure: 1.5, contrast: 0.3 };
  const merge = createFlarexNode("merge", "fixture_flarex_blend_merge");
  merge.params = { ...merge.params, blend: "multiply", opacity: 0.7 };
  comp.nodes[grade.id] = grade;
  comp.nodes[merge.id] = merge;
  comp.edges = [
    { id: "fixture_flarex_blend_e1", from: { nodeId: "fixture_flarex_blend_comp_in", socket: "out" }, to: { nodeId: grade.id, socket: "in" } },
    { id: "fixture_flarex_blend_e2", from: { nodeId: "fixture_flarex_blend_comp_in", socket: "out" }, to: { nodeId: merge.id, socket: "bg" } },
    { id: "fixture_flarex_blend_e3", from: { nodeId: grade.id, socket: "out" }, to: { nodeId: merge.id, socket: "fg" } },
    { id: "fixture_flarex_blend_e4", from: { nodeId: merge.id, socket: "out" }, to: { nodeId: "fixture_flarex_blend_comp_out", socket: "in" } }
  ];
  return comp;
}

// F6: Transform (scale + rotate + translate combined) over the background layer — the keyed-away
// area in flarex-key-glow already covers Transform+Glow together; this isolates Transform alone
// with a rotation term (untested in that fixture) so a rotation-order or anchor regression shows.
function buildFlarexTransformComp(): FlarexComp {
  const comp = createFlarexComp("fixture_flarex_transform_comp", "Flarex transform fixture");
  const transform = createFlarexNode("transform", "fixture_flarex_transform_t1");
  transform.params = { ...transform.params, x: 14, y: -9, scale: 0.65, rotation: 18 };
  comp.nodes[transform.id] = transform;
  comp.edges = [
    { id: "fixture_flarex_transform_e1", from: { nodeId: "fixture_flarex_transform_comp_in", socket: "out" }, to: { nodeId: transform.id, socket: "in" } },
    { id: "fixture_flarex_transform_e2", from: { nodeId: transform.id, socket: "out" }, to: { nodeId: "fixture_flarex_transform_comp_out", socket: "in" } }
  ];
  return comp;
}

// F6: ellipseMask -> matteControl (feather) -> masked Blur. Exercises the matteControl feather
// path (not just a raw shape mask's own feather) through the masked-region-pass renderer path.
function buildFlarexEllipseMatteComp(): FlarexComp {
  const comp = createFlarexComp("fixture_flarex_ellipse_matte_comp", "Flarex ellipse+matteControl fixture");
  const ellipse = createFlarexNode("ellipseMask", "fixture_flarex_ellipse");
  ellipse.params = { ...ellipse.params, centerX: 0.5, centerY: 0.45, width: 0.5, height: 0.45, feather: 0 };
  const matte = createFlarexNode("matteControl", "fixture_flarex_matte");
  matte.params = { ...matte.params, operation: "add", feather: 0.12 };
  const blur = createFlarexNode("blur", "fixture_flarex_ellipse_blur");
  blur.params = { ...blur.params, sigma: 22 };
  comp.nodes[ellipse.id] = ellipse;
  comp.nodes[matte.id] = matte;
  comp.nodes[blur.id] = blur;
  comp.edges = [
    { id: "fixture_flarex_em_e1", from: { nodeId: "fixture_flarex_ellipse_matte_comp_in", socket: "out" }, to: { nodeId: blur.id, socket: "in" } },
    { id: "fixture_flarex_em_e2", from: { nodeId: ellipse.id, socket: "out" }, to: { nodeId: matte.id, socket: "a" } },
    { id: "fixture_flarex_em_e3", from: { nodeId: matte.id, socket: "out" }, to: { nodeId: blur.id, socket: "mask" } },
    { id: "fixture_flarex_em_e4", from: { nodeId: blur.id, socket: "out" }, to: { nodeId: "fixture_flarex_ellipse_matte_comp_out", socket: "in" } }
  ];
  return comp;
}

/**
 * ANIMATED ROTO — the first fixture whose mask GEOMETRY varies per frame.
 *
 * A bezier outline with `shapeKeyframes` at t=0 and t=1, driving a blur's region mask so the moving
 * edge is visible as a moving soft/sharp boundary rather than as a shape only alpha would show.
 *
 * Sampled MID-ANIMATION, deliberately, for the reason N5 gives above the keyframed-blur fixture: the
 * harness renders one frame per fixture at `renderComparisonFrameSeconds` = 0.45s, and every failure
 * this fixture can see is a failure to INTERPOLATE. A renderer that ignored `shapeKeyframes` entirely
 * would draw the base `points`; one that held the first key would draw the t=0 outline. Neither
 * matches the 45%-of-the-way shape, and both are far enough from it to move a lot of pixels.
 *
 * The two keys carry the SAME point count on purpose — a differing count is the documented HOLD case
 * (shape morphing is out of scope for this slice), and a fixture built on the hold path would assert
 * the opposite of what it looks like it asserts.
 *
 * What this fixture CANNOT see, stated so no one reads a green run as more than it is: per DEBT-017
 * the gate is differential, and this whole path is shared code both renderers consume verbatim, so a
 * wrong-but-agreed shape reads 0.000%. Cross-frame staleness needs a second render against a warm
 * cache, which one still per process cannot produce. Both are covered by unit tests instead —
 * `flarex.test.ts` (multi-time sampling) and `flarex-animated-mask-matte.test.ts` (two renders, one
 * cache). This fixture's job is narrower and real: the two renderers agree, at an interpolated time.
 */
function buildFlarexAnimatedRotoComp(): FlarexComp {
  const comp = createFlarexComp("fixture_flarex_roto_comp", "Flarex animated roto fixture");
  const shape = createFlarexNode("bezierMask", "fixture_flarex_roto_shape");
  // A rounded quad (handles on every point) that TRANSLATES right and grows over one second. Tangents
  // are carried in the payload, so this also pins the 6-tuple form through both renderers.
  const at = (dx: number, r: number): string =>
    JSON.stringify([
      [0.28 + dx, 0.30, -r, 0, r, 0],
      [0.60 + dx, 0.30, 0, -r, 0, r],
      [0.60 + dx, 0.72, r, 0, -r, 0],
      [0.28 + dx, 0.72, 0, r, 0, -r],
    ]);
  shape.params = {
    ...shape.params,
    points: at(0, 0.06),
    shapeKeyframes: JSON.stringify([
      { t: 0, p: JSON.parse(at(0, 0.06)) },
      { t: 1, p: JSON.parse(at(0.22, 0.14)) },
    ]),
    feather: 0.05,
    expansion: 0.02,
  };
  const blur = createFlarexNode("blur", "fixture_flarex_roto_blur");
  blur.params = { ...blur.params, sigma: 26 };
  comp.nodes[shape.id] = shape;
  comp.nodes[blur.id] = blur;
  comp.edges = [
    { id: "fixture_flarex_roto_e1", from: { nodeId: "fixture_flarex_roto_comp_in", socket: "out" }, to: { nodeId: blur.id, socket: "in" } },
    { id: "fixture_flarex_roto_e2", from: { nodeId: shape.id, socket: "out" }, to: { nodeId: blur.id, socket: "mask" } },
    { id: "fixture_flarex_roto_e3", from: { nodeId: blur.id, socket: "out" }, to: { nodeId: "fixture_flarex_roto_comp_out", socket: "in" } }
  ];
  return comp;
}

// F6.2: reroute pass-through parity ACROSS REAL RENDERERS (the flarex.test.ts check already
// proves the compiler's own output is structurally identical; this proves web preview and
// Remotion agree pixel-for-pixel when a reroute sits in the middle of a real chain).
function buildFlarexRerouteComp(): FlarexComp {
  const comp = createFlarexComp("fixture_flarex_reroute_comp", "Flarex reroute fixture");
  const blur = createFlarexNode("blur", "fixture_flarex_reroute_blur");
  blur.params = { ...blur.params, sigma: 12 };
  const reroute = createFlarexNode("reroute", "fixture_flarex_reroute_r1");
  comp.nodes[blur.id] = blur;
  comp.nodes[reroute.id] = reroute;
  comp.edges = [
    { id: "fixture_flarex_reroute_e1", from: { nodeId: "fixture_flarex_reroute_comp_in", socket: "out" }, to: { nodeId: blur.id, socket: "in" } },
    { id: "fixture_flarex_reroute_e2", from: { nodeId: blur.id, socket: "out" }, to: { nodeId: reroute.id, socket: "in" } },
    { id: "fixture_flarex_reroute_e3", from: { nodeId: reroute.id, socket: "out" }, to: { nodeId: "fixture_flarex_reroute_comp_out", socket: "in" } }
  ];
  return comp;
}

// Multi-clip MediaIn parity (FLAREX.md Phase 2): a SECOND MediaIn pulls a sibling timeline clip
// (`FLAREX_MULTI_SRC_ID`), scales it down via Transform, and merges it over the host clip. This
// locks two things across all three renderers at once: (1) the sibling's graded draw is resolved
// and composited identically in preview / local export / Remotion, and (2) the referenced clip is
// SUPPRESSED from independent drawing (build-scene-draws), so a broken suppression — which would let
// the full-frame orange source paint over everything at its own z-slot — shows as a large diff.
const FLAREX_MULTI_SRC_ID = "fixture_flarex_multi_src";
function buildFlarexMultiInComp(): FlarexComp {
  const comp = createFlarexComp("fixture_flarex_multi_comp", "Flarex multi-MediaIn fixture");
  const srcIn = createFlarexNode("mediaIn", "fixture_flarex_multi_srcin");
  srcIn.params = { ...srcIn.params, sourceClipId: FLAREX_MULTI_SRC_ID };
  const transform = createFlarexNode("transform", "fixture_flarex_multi_tf");
  transform.params = { ...transform.params, scale: 0.5, y: -10 };
  const merge = createFlarexNode("merge", "fixture_flarex_multi_merge");
  comp.nodes[srcIn.id] = srcIn;
  comp.nodes[transform.id] = transform;
  comp.nodes[merge.id] = merge;
  comp.edges = [
    // Host MediaIn → merge background.
    { id: "fixture_flarex_multi_e1", from: { nodeId: "fixture_flarex_multi_comp_in", socket: "out" }, to: { nodeId: merge.id, socket: "bg" } },
    // Sibling MediaIn → Transform → merge foreground.
    { id: "fixture_flarex_multi_e2", from: { nodeId: srcIn.id, socket: "out" }, to: { nodeId: transform.id, socket: "in" } },
    { id: "fixture_flarex_multi_e3", from: { nodeId: transform.id, socket: "out" }, to: { nodeId: merge.id, socket: "fg" } },
    { id: "fixture_flarex_multi_e4", from: { nodeId: merge.id, socket: "out" }, to: { nodeId: "fixture_flarex_multi_comp_out", socket: "in" } }
  ];
  return comp;
}

// Vacuous-fixture gap (2026-08-09): an asset-source MediaIn (`params.sourceAssetId`, not
// `sourceClipId` — a real media-pool asset loaded independently of the timeline, not a sibling
// clip) whose asset is a DIFFERENT aspect than the comp. None of the other 11 Flarex fixtures'
// MediaIns reference an asset at all, or their one shared asset already matches the comp's aspect —
// so a hardcoded stretch on this path had no fixture that could ever catch it. Bypasses comp_in
// entirely (an asset-source MediaIn is self-contained, not a read of the host clip) — the comp's
// entire output is this one MediaIn.
const FLAREX_MISMATCHED_ASSET_ID = "fixture_mismatched_aspect_asset";
function buildFlarexMismatchedAspectComp(): FlarexComp {
  const comp = createFlarexComp("fixture_flarex_mismatched_aspect_comp", "Flarex mismatched-aspect source fixture");
  const srcIn = createFlarexNode("mediaIn", "fixture_flarex_mismatched_aspect_srcin");
  srcIn.params = { ...srcIn.params, sourceAssetId: FLAREX_MISMATCHED_ASSET_ID };
  comp.nodes[srcIn.id] = srcIn;
  comp.edges = [
    { id: "fixture_flarex_mismatched_aspect_e1", from: { nodeId: srcIn.id, socket: "out" }, to: { nodeId: "fixture_flarex_mismatched_aspect_comp_out", socket: "in" } }
  ];
  return comp;
}

// RENDERER-DIVERGENCE coverage under a non-identity host transform (DEBT-017, project-tracker/
// architectural-debt.md) — NOT a DEBT-016 guard. `render:compare:pixels` is DIFFERENTIAL (it diffs
// web-preview against Remotion), and DEBT-016's cache lives only on the web-preview side
// (`ScenePreviewCanvas.tsx`), so a differential gate structurally cannot see it — confirmed empirically,
// not assumed: reverting DEBT-016's fix, and separately reverting the ADR-020 slice-B transform-
// inheritance line this fixture's host also exercises, both read 0.000% before AND after. The two-render
// unit test (scene/flarex-source-draw-cache-transform.test.ts) is DEBT-016's sole and correct guard.
// What THIS fixture catches: a FUTURE change that makes one renderer handle a host transform differently
// from the other — the host's own transform is non-identity (scale/position/opacity all off their
// defaults) AND a second, asset-source MediaIn is merged over it, which no other Flarex fixture exercises
// (all 13 others sit at an identity host transform, where there is nothing to diverge on). Falsified
// against exactly that shape: a temporary Remotion-only perturbation (SceneStage.tsx, reverted) forced
// this comp's host to identity on the Remotion side only — 56.226% diff, failed as expected; reverted,
// 0.000%, passed.
const FLAREX_HOST_TRANSFORM_ASSET_ID = "fixture_host_transform_media_asset";
function buildFlarexHostTransformComp(): FlarexComp {
  const comp = createFlarexComp("fixture_flarex_host_transform_comp", "Flarex host-transform fixture");
  const srcIn = createFlarexNode("mediaIn", "fixture_flarex_host_transform_srcin");
  srcIn.params = { ...srcIn.params, sourceAssetId: FLAREX_HOST_TRANSFORM_ASSET_ID };
  const merge = createFlarexNode("merge", "fixture_flarex_host_transform_merge");
  comp.nodes[srcIn.id] = srcIn;
  comp.nodes[merge.id] = merge;
  comp.edges = [
    // Host MediaIn (comp_in) → merge background — the host's own transformed draw.
    { id: "fixture_flarex_host_transform_e1", from: { nodeId: "fixture_flarex_host_transform_comp_in", socket: "out" }, to: { nodeId: merge.id, socket: "bg" } },
    // Asset-source MediaIn → merge foreground — inherits the host's transform (the field this fixture
    // exercises); a correct render places it in the SAME box as the host behind it.
    { id: "fixture_flarex_host_transform_e2", from: { nodeId: srcIn.id, socket: "out" }, to: { nodeId: merge.id, socket: "fg" } },
    { id: "fixture_flarex_host_transform_e3", from: { nodeId: merge.id, socket: "out" }, to: { nodeId: "fixture_flarex_host_transform_comp_out", socket: "in" } }
  ];
  return comp;
}

interface FixtureVariant {
  effects: TimelineLayer["effects"];
  fit: "cover" | "contain";
  masks?: TimelineLayer["masks"];
  /** 3D tilt applied to the base media layer (exercises the composite quad vs CSS perspective). */
  tilt?: { rotateX?: number; rotateY?: number; perspective?: number };
  /** When set, the overlay track is a single TEXT layer at this scale (no captions/shape) — exercises the
   *  resolution-aware BOX raster: scaled scene text must stay as crisp as the DOM/export text. */
  textScale?: number;
  /** Base media-layer opacity (0–100). Exercises scene composite-applied opacity vs DOM CSS opacity. */
  mediaOpacity?: number;
  content?: TimelineLayer["content"];
  /** Phase 4.1c: color grade on the TEXT layer (scene grades text via the LUT, like media). */
  textEffects?: TimelineLayer["effects"];
  /** Phase 4.1c: clip mask on the TEXT layer (scene clips text via the comp-space matte). */
  textMasks?: TimelineLayer["masks"];
  /** Phase 4.1c: 3D tilt on the TEXT layer (scene tilts text via the composite quad). */
  textTilt?: { rotateX?: number; rotateY?: number; perspective?: number };
  /** Phase 4.2: two same-track clips joined by a junction transition, sampled MID-transition — exercises
   *  the scene pass mixing the junction in-canvas (vs the DOM overlay). */
  transition?: boolean;
  /** Phase 6.3c: luma person-extraction matte on a media layer. */
  matte?: TimelineLayer["matte"];
  /** Frames Step E: parametric frame (clip mask + border chrome) on the media layer. */
  frame?: TimelineLayer["frame"];
  /** Track matte (D1): the media layer consumes the layer above it (the text fixture) as its matte. */
  trackMatte?: TimelineLayer["trackMatte"];
  /** Anchor points (D3): off-center pivot + rotation/scale on the media layer. */
  anchorTransform?: { anchor: { x: number; y: number }; rotation: number; scale: number };
  /** D4 (R2 step 3): the transition pair lives INSIDE a nested composition referenced by a compound clip. */
  nestedTransition?: boolean;
  /** Block 4a/4b (NESTING_MATURITY.md): color grade + region blur applied to the COMPOUND clip itself. */
  nestedGrade?: boolean;
  /** Block 4c: junction transition where the INCOMING side is a compound clip (clip → group mix). */
  nestedJunctionTransition?: boolean;
  /** Block 6 tail: TRIMMED compound incoming, sampled in the PRE-cut window segment — the group side
   *  must mix real pre-roll nest material (head handle), not hard-cut until its start. */
  nestedJunctionPreroll?: boolean;
  /** Texture fill (D2): image paint on the TEXT fixture's glyphs. */
  textFillTexture?: TimelineLayer["fillTexture"];
  /** Flarex parity (S4): the media layer renders through this node comp instead of its own
   *  effects array — over a background layer so the keyed-away area is a real composite. */
  flarex?: FlarexComp;
  /** Multi-clip MediaIn parity (FLAREX.md Phase 2): add the sibling SOURCE clip the comp's second
   *  MediaIn references. The clip is suppressed from independent drawing and appears only inside the
   *  comp output — proving both resolution and suppression are renderer-consistent. */
  flarexMultiSource?: boolean;
  /** DEBT-017 fixture: override the HOST media layer's transform POSITION away from center (50/50). Every other
   *  variant leaves this undefined, so `imageLayer`'s position stays exactly 50/50 — byte-identical to
   *  before this field existed. Separate from `anchorTransform.anchor` (the rotation/scale PIVOT, not a
   *  translation) and from `anchorTransform.scale`/`mediaOpacity` (which already vary scale/opacity). */
  hostPosition?: { x: number; y: number };
}

function variantFor(key: RenderComparisonFixtureKey): FixtureVariant {
  switch (key) {
    case "plain-image":
      return { effects: [], fit: "cover" };
    case "brightness-contrast":
      return { effects: brightnessContrastEffects, fit: "cover" };
    case "color-curves":
      return { effects: colorCurvesEffects, fit: "cover" };
    case "object-fit-cover":
      return { effects: [], fit: "cover" };
    case "object-fit-contain":
      return { effects: [], fit: "contain" };
    case "content-transform":
      return {
        effects: [],
        fit: "cover",
        content: {
          scale: 1.8,
          offsetX: 0.42,
          offsetY: -0.24,
          crop: { top: 0.08, right: 0.18, bottom: 0.12, left: 0.06 }
        }
      };
    case "person-matte":
      return {
        effects: [],
        fit: "cover",
        matte: {
          artifactId: "fixture_person_matte",
          uri: `data:image/svg+xml;charset=utf-8,${fixturePersonMatteSvg}`,
          kind: "luma",
          fps: 30,
          feather: 0,
          edgeMode: "clean",
          invert: false,
          opacity: 1
        }
      };
    case "blur":
      return { effects: blurEffects, fit: "cover" };
    case "glow":
      return { effects: glowEffects, fit: "cover" };
    case "region-blur":
      return { effects: regionBlurEffects, fit: "cover" };
    case "masked-blur":
      return { effects: maskedBlurEffects, fit: "cover", masks: [createBoxMask("ellipse", 300, 560, 780, 1360, 0)] };
    case "clip-region-blur":
      // The user's exact repro: a CLIP mask on the layer AND a REGION blur on the effect = the `clip ∩ region`
      // compound. The expansion must blur only inside (clipEllipse ∩ regionRect); the rest of the clip ellipse
      // stays sharp, and outside the clip is background. Region blur alone works — this checks the compound.
      return { effects: regionBlurEffects, fit: "cover", masks: [createBoxMask("ellipse", 220, 520, 860, 1400, 0)] };
    case "two-region-effects":
      return { effects: twoRegionEffects, fit: "cover" };
    case "overlap-region-effects":
      return { effects: overlapRegionEffects, fit: "cover" };
    case "feather-region-blur":
      return { effects: featherRegionBlurEffects, fit: "cover" };
    case "tilt-3d":
      return { effects: [], fit: "cover", tilt: { rotateY: 26, rotateX: -12, perspective: 1000 } };
    case "scaled-text":
      return { effects: [], fit: "cover", textScale: 5 };
    case "media-opacity":
      return { effects: [], fit: "cover", mediaOpacity: 50 };
    case "graded-text":
      return { effects: [], fit: "cover", textScale: 5, textEffects: textGradeEffects };
    case "masked-text":
      // A rectangle clip mask revealing only the LEFT comp half — a big, unambiguous clip of the
      // scaled text (the right glyphs disappear). Ungraded/unmasked scene text trips the bar.
      return { effects: [], fit: "cover", textScale: 5, textMasks: [createBoxMask("rectangle", 0, 0, 540, 1920, 0)] };
    case "region-text":
      // Text grade confined to the left comp half via an effect (region) mask — exercises region expansion
      // on a TEXT layer (left half graded, right half base).
      return { effects: [], fit: "cover", textScale: 5, textEffects: textRegionGradeEffects };
    case "tilted-text":
      return { effects: [], fit: "cover", textScale: 3, textTilt: { rotateY: 26, rotateX: -12, perspective: 1000 } };
    case "transition":
      return { effects: [], fit: "cover", transition: true };
    case "advanced-transition":
      return { effects: [], fit: "cover", transition: true };
    case "plugin-shader":
      return { effects: pluginShaderEffects, fit: "cover" };
    case "stylize":
      return { effects: stylizeEffects, fit: "cover" };
    case "stylize-ink":
      return { effects: stylizeInkEffects, fit: "cover" };
    case "stylize-print":
      return { effects: stylizePrintEffects, fit: "cover" };
    case "stylize-subject":
      return { effects: stylizeSubjectEffects, fit: "cover" };
    case "vignette":
      return { effects: vignetteEffects, fit: "cover" };
    case "grain":
      return { effects: grainEffects, fit: "cover" };
    case "chroma-key":
      return { effects: chromaKeyEffects, fit: "cover" };
    case "flarex-key-glow":
      return { effects: [], fit: "cover", flarex: buildFlarexKeyGlowComp() };
    case "flarex-curves":
      return { effects: [], fit: "cover", flarex: buildFlarexCurvesComp() };
    case "flarex-keyframed-blur":
      return { effects: [], fit: "cover", flarex: buildFlarexKeyframedBlurComp() };
    case "flarex-merge-blend":
      return { effects: [], fit: "cover", flarex: buildFlarexMergeBlendComp() };
    case "flarex-transform":
      return { effects: [], fit: "cover", flarex: buildFlarexTransformComp() };
    case "flarex-ellipse-matte":
      return { effects: [], fit: "cover", flarex: buildFlarexEllipseMatteComp() };
    case "flarex-reroute":
      return { effects: [], fit: "cover", flarex: buildFlarexRerouteComp() };
    case "flarex-multi-in":
      return { effects: [], fit: "cover", flarex: buildFlarexMultiInComp(), flarexMultiSource: true };
    case "flarex-color-chain":
      return { effects: [], fit: "cover", flarex: buildFlarexColorChainComp() };
    case "flarex-unified-color":
      return { effects: [], fit: "cover", flarex: buildFlarexUnifiedColorComp() };
    case "flarex-filter-stack":
      return { effects: [], fit: "cover", flarex: buildFlarexFilterStackComp() };
    case "flarex-generators":
      return { effects: [], fit: "cover", flarex: buildFlarexGeneratorsComp() };
    case "flarex-mismatched-aspect":
      return { effects: [], fit: "cover", flarex: buildFlarexMismatchedAspectComp() };
    case "flarex-host-transform":
      // DEBT-017 fixture: scale != 1, position != 50/50, opacity != 100 — all three off their identity
      // default, the one host-transform shape none of the other 13 Flarex fixtures carries.
      return {
        effects: [],
        fit: "cover",
        flarex: buildFlarexHostTransformComp(),
        hostPosition: { x: 30, y: 35 },
        anchorTransform: { anchor: { x: 50, y: 50 }, rotation: 0, scale: 0.6 },
        mediaOpacity: 70
      };
    case "flarex-animated-roto":
      return { effects: [], fit: "cover", flarex: buildFlarexAnimatedRotoComp() };
    case "framed-blob":
      // Frames Phase 2: a procedural BLOB frame + border. Exercises the bezier-with-tangents clip mask
      // (the first pixel-gated bezier matte) and the pen+tangent border stroke (the blob's border clone
      // bakes to a pen shapePath) — the two code paths the simple-shape fixtures never touch. Seeded, so
      // the outline is byte-identical in every renderer.
      return {
        effects: [],
        fit: "cover",
        frame: {
          definitionId: "orreris.blob",
          generatorId: "blob",
          params: {
            points: 9,
            seed: 11,
            wobble: 55,
            width: 82,
            height: 62,
            aspectLock: false,
            border: true,
            borderWidth: 14,
            borderColor: "#7fd4ff"
          }
        }
      };
    case "framed-media":
      // Frames Step E: a rounded-rect frame with a non-trivial box (unlocked 78×60%) + a thick border.
      // Exercises the WHOLE frame surface at once: the clip mask (media clipped to the inset rounded box —
      // pins the manifest carrying `layer.frame`, without which the cloud render is UN-clipped) and the
      // border (the derived stroke-only shape clone from `expandFrameBorders`, riding the shape raster —
      // pins the manifest carrying `shapeKind`/`shapePath`). A wide bright stroke trips the bar loudly.
      return {
        effects: [],
        fit: "cover",
        frame: {
          definitionId: "orreris.rounded-rect",
          generatorId: "rounded-rect",
          params: {
            roundness: 40,
            width: 78,
            height: 60,
            aspectLock: false,
            border: true,
            borderWidth: 16,
            borderColor: "#ffd24a"
          }
        }
      };
    case "texture-fill":
      // Texture fill (D2): the big scaled "HI" glyphs paint with a 2×2 checkerboard PNG (data URL —
      // decodable via fetch+createImageBitmap in every renderer), tiled at 40× so the squares are
      // huge and unambiguous. Trips if any renderer's rasterizer skips the decode await (solid white
      // glyphs), mis-anchors the pattern, or the manifest drops `fillTexture`.
      return {
        effects: [],
        fit: "cover",
        textScale: 5,
        textFillTexture: {
          url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR42mO4ZCPy/9cJjf8MIALEAQBa+AoViENR1AAAAABJRU5ErkJggg==",
          fit: "tile",
          scale: 40
        }
      };
    case "nested-transition":
      // D4 (R2 step 3): the SAME two-clip crossDissolve as the `transition` fixture, but inside a
      // nested composition referenced by a compound clip — sampled MID-transition. Trips if the
      // in-nest mix doesn't play (hard cut = only the graded incoming shows), if the outgoing child
      // double-draws, or if the mix targets aren't sized to the nest.
      return { effects: [], fit: "cover", nestedTransition: true };
    case "nested-grade":
      // Block 4a/4b: a plain single-image nest whose COMPOUND clip carries a LUT-engine grade
      // (curves) AND a region blur. Trips if the group's own color pipeline is a no-op (the old
      // silent failure: media pre-grades per-layer, a compound clip mounts no media layer), or if
      // the shell drops its region passes (the compound was removed before region expansion runs).
      return { effects: [], fit: "cover", nestedGrade: true };
    case "nested-junction-transition":
      // Block 4c (old Block 1 Task 7): a junction crossDissolve whose INCOMING side is a compound
      // clip, sampled mid-window. Trips if the pair scan misses compound junctions (they only exist
      // on the RAW comp — hard cut), or if the group side doesn't pre-compose into the mix.
      return { effects: [], fit: "cover", nestedJunctionTransition: true };
    case "nested-junction-preroll":
      // Block 6 tail: the compound INCOMING is TRIMMED (sourceIn 0.6 → real head handle), cut at
      // 0.6s, crossDissolve 0.4s → R3.1 window [0.4, 0.8]; the 0.45s sample lands BEFORE the cut,
      // where the mix must read pre-roll nest material from the junction-extended children. Trips if
      // the extension is missing (group side empty → hard cut) or if the span gate double-draws.
      return { effects: [], fit: "cover", nestedJunctionPreroll: true };
    case "anchored-media":
      // Anchor points (D3): the media rotates/scales about an OFF-CENTER pivot (20%,20%), with an
      // ellipse clip mask riding along. Trips if any pivot site disagrees — the GPU quad
      // (writeQuad), the mask matte bake (scene-mask-matte layer transform), or the manifest not
      // carrying `transform.anchor`. Center-pivot renderers put the image somewhere else entirely.
      return {
        effects: [],
        fit: "cover",
        masks: [createBoxMask("ellipse", 220, 520, 860, 1400, 0)],
        anchorTransform: { anchor: { x: 20, y: 20 }, rotation: 25, scale: 0.85 }
      };
    case "track-matte":
      // Track matte (D1): the big scaled "HI" text ABOVE the media layer becomes the media's ALPHA
      // matte — the classic text-cutout. The text stops drawing on its own (it's consumed), so the
      // frame is the landscape visible ONLY through the glyphs over the background. Trips if the
      // matte source still draws normally, if the consumer ignores the matte, or if the source
      // resolution disagrees between renderers.
      return { effects: [], fit: "cover", textScale: 5, trackMatte: { mode: "alpha" } };
    case "default":
    default:
      return { effects: fullColorEffects, fit: "cover" };
  }
}

export function createRenderComparisonFixture(key: RenderComparisonFixtureKey = "default") {
  const variant = variantFor(key);
  const imageAsset: SourceAsset = {
    id: "fixture_image",
    userId: "fixture_user",
    fileName: "fixture-landscape.svg",
    fileType: "image/svg+xml",
    fileUrl: `data:image/svg+xml;charset=utf-8,${fixtureImageSvg}`,
    durationSeconds: 12,
    width: 1080,
    height: 1920,
    status: "ready",
    createdAt: new Date(0).toISOString()
  };

  // flarex-mismatched-aspect: a landscape asset for the asset-source MediaIn to load, deliberately
  // the opposite orientation of the 1080x1920 comp (see fixtureMismatchedAspectSvg above).
  const mismatchedAspectAsset: SourceAsset = {
    id: FLAREX_MISMATCHED_ASSET_ID,
    userId: "fixture_user",
    fileName: "fixture-mismatched-aspect.svg",
    fileType: "image/svg+xml",
    fileUrl: `data:image/svg+xml;charset=utf-8,${fixtureMismatchedAspectSvg}`,
    durationSeconds: 12,
    width: 1920,
    height: 1080,
    status: "ready",
    createdAt: new Date(0).toISOString()
  };

  // flarex-host-transform (DEBT-017 renderer-divergence coverage): the asset-source MediaIn's media,
  // merged over the host at the host's own (non-identity) transform.
  const hostTransformMediaAsset: SourceAsset = {
    id: FLAREX_HOST_TRANSFORM_ASSET_ID,
    userId: "fixture_user",
    fileName: "fixture-host-transform-media.svg",
    fileType: "image/svg+xml",
    fileUrl: `data:image/svg+xml;charset=utf-8,${fixtureHostTransformMediaSvg}`,
    durationSeconds: 12,
    width: 1080,
    height: 1920,
    status: "ready",
    createdAt: new Date(0).toISOString()
  };

  const imageLayer: TimelineLayer = {
    id: "fixture_image_layer",
    trackId: "video_track",
    type: "image",
    name: "Fixture landscape",
    startSeconds: 0,
    durationSeconds: 12,
    assetId: imageAsset.id,
    fit: variant.fit,
    transform: {
      position: variant.hostPosition ?? { x: 50, y: 50 },
      scale: variant.anchorTransform?.scale ?? 1,
      rotation: variant.anchorTransform?.rotation ?? 0,
      opacity: variant.mediaOpacity ?? 100,
      ...(variant.anchorTransform ? { anchor: variant.anchorTransform.anchor } : {}),
      ...(variant.tilt
        ? {
            rotateX: variant.tilt.rotateX ?? 0,
            rotateY: variant.tilt.rotateY ?? 0,
            perspective: variant.tilt.perspective ?? 0
          }
        : {})
    },
    // Variant-driven (see RenderComparisonFixtureKey): the "default" fixture exercises the
    // full Phase-3 color pipeline (13C.1 graph Curves + 13C.3 HSL Secondary that ONLY the
    // WebGL float-3D-LUT engine can render); other variants isolate a single concern so a
    // parity regression points at one code path.
    effects: variant.effects,
    ...(variant.content ? { content: variant.content } : {}),
    ...(variant.matte ? { matte: variant.matte } : {}),
    ...(variant.masks ? { masks: variant.masks } : {}),
    ...(variant.frame ? { frame: variant.frame } : {}),
    ...(variant.trackMatte ? { trackMatte: variant.trackMatte } : {}),
    ...(variant.flarex ? { flarexCompId: variant.flarex.id } : {}),
    keyframes: []
  };

  // flarex-key-glow: a full-bleed background layer sharing `video_track` with the flarex-comped
  // image layer, so the ChromaKey node's keyed-away hill visibly reveals a real composited color
  // (not just the comp's black backdrop — Remotion's SceneStage hardcodes its clear color to
  // black regardless of `composition.backgroundColor`, so that field is NOT cross-renderer
  // reliable for this purpose; an actual layer draw is).
  const flarexBackgroundLayer: TimelineLayer = {
    id: "fixture_flarex_bg",
    trackId: "video_track",
    type: "shape",
    name: "Flarex background",
    startSeconds: 0,
    durationSeconds: 12,
    color: "#1e6091",
    transform: { position: { x: 50, y: 50 }, scale: 1, rotation: 0, opacity: 100 },
    effects: [],
    keyframes: []
  };

  // Multi-clip MediaIn source (FLAREX.md Phase 2): a full-bleed solid ORANGE shape referenced by the
  // host comp's second MediaIn. It's added to the video track ABOVE the host, so if suppression breaks
  // it would paint full-frame over everything (a huge diff); with suppression it appears ONLY as the
  // comp's scaled-down foreground patch. A solid color is deterministic across renderers.
  const flarexSourceLayer: TimelineLayer = {
    id: FLAREX_MULTI_SRC_ID,
    trackId: "video_track",
    type: "shape",
    name: "Flarex source clip",
    startSeconds: 0,
    durationSeconds: 12,
    color: "#e0662a",
    transform: { position: { x: 50, y: 50 }, scale: 1, rotation: 0, opacity: 100 },
    effects: [],
    keyframes: []
  };

  const shapeLayer: TimelineLayer = {
    id: "fixture_shape_layer",
    trackId: "overlay_track",
    type: "shape",
    name: "Text backing",
    startSeconds: 0,
    durationSeconds: 12,
    color: "rgba(0, 0, 0, 0.18)",
    transform: {
      position: { x: 50, y: 63 },
      scale: 0.92,
      rotation: 0,
      opacity: 76
    },
    effects: [],
    keyframes: []
  };

  // Text-only fixtures: a single large text layer (no captions/shape) so the diff isolates ONE text
  // concern — scaled-text (resolution-aware BOX raster), graded-text (LUT grade), masked-text (clip
  // matte), tilted-text (3D quad). All four now composite text on the GPU (Phase 4.1c/d, no DOM fallback).
  const useTextFixture = Boolean(variant.textScale || variant.textEffects || variant.textMasks || variant.textTilt);
  const textFixtureLayer: TimelineLayer = {
    id: "fixture_scaled_text",
    trackId: "overlay_track",
    type: "text",
    name: "Text fixture",
    text: "HI",
    startSeconds: 0,
    durationSeconds: 12,
    fontFamily: "Arial",
    fontSize: 110,
    textWidthPercent: 86,
    textAlign: "center",
    color: "#ffffff",
    strokeColor: "#050608",
    strokeWidth: 4,
    transform: {
      position: { x: 50, y: 50 },
      scale: variant.textScale ?? 1,
      rotation: 0,
      opacity: 100,
      ...(variant.textTilt
        ? {
            rotateX: variant.textTilt.rotateX ?? 0,
            rotateY: variant.textTilt.rotateY ?? 0,
            perspective: variant.textTilt.perspective ?? 0
          }
        : {})
    },
    effects: variant.textEffects ?? [],
    ...(variant.textMasks ? { masks: variant.textMasks } : {}),
    ...(variant.textFillTexture ? { fillTexture: variant.textFillTexture } : {}),
    keyframes: []
  };

  const transcript = parseTranscriptInput(`WEBVTT

00:00:00.000 --> 00:00:01.400
New Drop

00:00:01.400 --> 00:00:03.200
Save this style now`);
  const captionStyle = captionStylePresets[0]!;
  const captionTrack = createCaptionTrack(transcript, captionStyle.id, "new, drop, save");

  // Transition fixture (Phase 4.2): two same-track image clips joined by a crossDissolve, sampled
  // MID-transition (the comp frame renderComparisonFrameSeconds = 0.45s is inside the 0.4–0.8s window).
  // The incoming clip carries a heavy grade so the two-texture mix is non-trivial (plain ⟷ graded).
  const transitionOutgoing: TimelineLayer = {
    id: "fixture_transition_out",
    trackId: "video_track",
    type: "image",
    name: "Transition outgoing",
    startSeconds: 0,
    durationSeconds: 0.4,
    assetId: imageAsset.id,
    fit: "cover",
    transform: { position: { x: 50, y: 50 }, scale: 1, rotation: 0, opacity: 100 },
    effects: [],
    keyframes: []
  };
  const transitionIncoming: TimelineLayer = {
    id: "fixture_transition_in",
    trackId: "video_track",
    type: "image",
    name: "Transition incoming",
    startSeconds: 0.4,
    durationSeconds: 11.6,
    assetId: imageAsset.id,
    fit: "cover",
    transform: { position: { x: 50, y: 50 }, scale: 1, rotation: 0, opacity: 100 },
    effects: colorCurvesEffects,
    transitionIn: {
      kind: key === "advanced-transition" ? "rgbDisplace" : "crossDissolve",
      durationSeconds: 0.4
    },
    keyframes: []
  };

  // D4: the transition pair re-homed INSIDE a nested composition, referenced by ONE compound clip on
  // the main timeline. The compound clip spans the whole comp; nested time == parent time, so the
  // 0.45s sample lands mid-window exactly like the flat `transition` fixture.
  const nestedComposition = {
    id: "fixture_nested_comp",
    name: "Nested transition comp",
    width: 1080,
    height: 1920,
    fps: 30,
    durationSeconds: 12,
    backgroundColor: "#000000",
    tracks: [
      {
        id: "nest_video_track",
        type: "video" as const,
        name: "Nest video",
        layers: [
          { ...transitionOutgoing, id: "nest_out", trackId: "nest_video_track" },
          { ...transitionIncoming, id: "nest_in", trackId: "nest_video_track" }
        ]
      }
    ]
  };
  const compoundClip: TimelineLayer = {
    id: "fixture_nest_clip",
    trackId: "video_track",
    type: "video",
    name: "Nested sequence",
    nestedCompositionId: nestedComposition.id,
    startSeconds: 0,
    durationSeconds: 12,
    fit: "cover",
    transform: { position: { x: 50, y: 50 }, scale: 1, rotation: 0, opacity: 100 },
    effects: [],
    keyframes: []
  };

  // Block 4a/4b (nested-grade): a single-image nest; the COMPOUND clip carries the curves grade + a
  // region blur — both must render on the composited group RTT (shell pipeline + shell region pass).
  const gradedNestComposition = {
    id: "fixture_graded_nest",
    name: "Graded nest comp",
    width: 1080,
    height: 1920,
    fps: 30,
    durationSeconds: 12,
    backgroundColor: "#000000",
    tracks: [
      {
        id: "gnest_track",
        type: "video" as const,
        name: "Nest video",
        layers: [{ ...imageLayer, id: "gnest_img", trackId: "gnest_track", effects: [], fit: "cover" as const }]
      }
    ]
  };
  const gradedNestClip: TimelineLayer = {
    ...compoundClip,
    id: "fixture_graded_nest_clip",
    nestedCompositionId: gradedNestComposition.id,
    effects: [...colorCurvesEffects, ...regionBlurEffects]
  };

  // Block 4c (nested-junction-transition): plain image (0–0.4s) → COMPOUND clip carrying the
  // crossDissolve `transitionIn`; the nest holds the graded image, so a missing mix (hard cut) or a
  // missing group side is loud. Same 0.4–0.8s window/sample as the flat `transition` fixture.
  const junctionNestComposition = {
    id: "fixture_junction_nest",
    name: "Junction nest comp",
    width: 1080,
    height: 1920,
    fps: 30,
    durationSeconds: 11.6,
    backgroundColor: "#000000",
    tracks: [
      {
        id: "jnest_track",
        type: "video" as const,
        name: "Nest video",
        layers: [
          {
            ...transitionIncoming,
            id: "jnest_media",
            trackId: "jnest_track",
            startSeconds: 0,
            durationSeconds: 11.6,
            transitionIn: undefined
          }
        ]
      }
    ]
  };
  const junctionNestClip: TimelineLayer = {
    ...compoundClip,
    id: "fixture_junction_nest_clip",
    nestedCompositionId: junctionNestComposition.id,
    startSeconds: 0.4,
    durationSeconds: 11.6,
    transitionIn: { kind: "crossDissolve", durationSeconds: 0.4 }
  };

  // Block 6 tail (nested-junction-preroll): 12s single-media nest (graded), TRIMMED compound
  // incoming (sourceIn 0.6) cut at 0.6s against a 0.6s plain outgoing. Head handle 0.6s → R3.1
  // resolves preroll 0.2s (outgoing tail is huge → auto = D/2 floor) → window [0.4, 0.8]; the
  // 0.45s sample sits BEFORE the cut, exercising the junction-extended pre-roll children.
  const prerollNestComposition = {
    id: "fixture_preroll_nest",
    name: "Preroll nest comp",
    width: 1080,
    height: 1920,
    fps: 30,
    durationSeconds: 12,
    backgroundColor: "#000000",
    tracks: [
      {
        id: "pnest_track",
        type: "video" as const,
        name: "Nest video",
        layers: [
          {
            ...transitionIncoming,
            id: "pnest_media",
            trackId: "pnest_track",
            startSeconds: 0,
            durationSeconds: 12,
            transitionIn: undefined
          }
        ]
      }
    ]
  };
  const prerollOutgoing: TimelineLayer = { ...transitionOutgoing, durationSeconds: 0.6 };
  const prerollNestClip: TimelineLayer = {
    ...compoundClip,
    id: "fixture_preroll_nest_clip",
    nestedCompositionId: prerollNestComposition.id,
    startSeconds: 0.6,
    durationSeconds: 11.4,
    sourceInSeconds: 0.6,
    transitionIn: { kind: "crossDissolve", durationSeconds: 0.4 }
  };

  const graph: ProjectGraph = {
    projectId: "project_render_pixel_fixture",
    effects: [],
    editableFields: {
      transcript,
      captionTrack,
      captionStyle: captionStyle.id
    },
    version: 1,
    composition: {
      id: "composition_render_pixel_fixture",
      name: "Render pixel fixture",
      width: 1080,
      height: 1920,
      fps: 30,
      durationSeconds: 12,
      backgroundColor: "#000000",
      tracks: [
        {
          id: "overlay_track",
          type: "overlay",
          name: "Overlay",
          // Transition/nesting fixtures keep the overlay empty so the diff isolates the concern.
          layers: useTextFixture
            ? [textFixtureLayer]
            : variant.transition || variant.nestedTransition || variant.nestedGrade || variant.nestedJunctionTransition || variant.nestedJunctionPreroll
              ? []
              : [shapeLayer]
        },
        {
          id: "video_track",
          type: "video",
          name: "Video",
          layers: variant.nestedTransition
            ? [compoundClip]
            : variant.nestedGrade
              ? [gradedNestClip]
              : variant.nestedJunctionTransition
                ? [transitionOutgoing, junctionNestClip]
                : variant.nestedJunctionPreroll
                  ? [prerollOutgoing, prerollNestClip]
                  : variant.transition
                    ? [transitionOutgoing, transitionIncoming]
                    : variant.flarexMultiSource
                      ? [flarexBackgroundLayer, imageLayer, flarexSourceLayer]
                      : variant.flarex
                        ? [flarexBackgroundLayer, imageLayer]
                        : [imageLayer]
        }
      ]
    },
    ...(variant.nestedTransition ? { compositions: { [nestedComposition.id]: nestedComposition } } : {}),
    ...(variant.nestedGrade ? { compositions: { [gradedNestComposition.id]: gradedNestComposition } } : {}),
    ...(variant.nestedJunctionTransition ? { compositions: { [junctionNestComposition.id]: junctionNestComposition } } : {}),
    ...(variant.nestedJunctionPreroll ? { compositions: { [prerollNestComposition.id]: prerollNestComposition } } : {}),
    ...(variant.flarex ? { flarexComps: { [variant.flarex.id]: variant.flarex } } : {})
  };
  // Text-only + transition/nesting fixtures isolate their concern — skip captions so the diff is just that.
  const nestedFixture =
    variant.nestedTransition || variant.nestedGrade || variant.nestedJunctionTransition || variant.nestedJunctionPreroll;
  const compositionWithCaptions =
    useTextFixture || variant.transition || nestedFixture
      ? graph.composition!
      : applyCaptionTrackToComposition(graph.composition!, captionTrack, captionStyle);

  return {
    graph: {
      ...graph,
      composition: compositionWithCaptions
    },
    assets: [imageAsset, mismatchedAspectAsset, hostTransformMediaAsset],
    currentTime: renderComparisonFrameSeconds
  };
}
