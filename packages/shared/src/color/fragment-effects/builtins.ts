import { registerFragmentEffect, type FragmentEffectDefinition } from "./registry";
import { STYLIZE_PAINTERLY } from "./stylize";

/**
 * Builtin fragment-shader effects (2026-07-14 batch: radial blur, directional/motion blur, sharpen,
 * pixelate, chromatic aberration). These ride the SAME `SceneFragmentPass` harness as user-uploaded
 * "Custom Shader" plugin effects (`registry.ts`'s `buildFragmentEffectShader`) — one small
 * `vec4 effect(vec2 uv)` body each, compiled identically by the web preview's scene compositor and
 * Remotion (both consume `build-scene-draws.ts`'s `SceneLayerDraw.fragmentPasses`), so preview and
 * export stay pixel-aligned by construction, same guarantee the color-filter/transition/mask defs get.
 *
 * Unlike user plugin shaders (`type: "pluginShader"` + a `__shaderManifestId` param pointing at a
 * user-registered manifest), these are real first-class `TimelineEffectType`s (see `effects.ts`) —
 * `buildFragmentPasses` in `scene/build-scene-draws.ts` maps `effect.type` straight to
 * `builtin.<type>` here, no manifest indirection needed.
 *
 * Registered once at module load via `registerBuiltinFragmentEffects()` — called from `effects.ts` so
 * it's always available wherever the effect registry is imported (web, worker, tests).
 */

export function builtinFragmentEffectId(type: string): string {
  return `builtin.${type}`;
}

const RADIAL_BLUR: FragmentEffectDefinition = {
  id: builtinFragmentEffectId("radialBlur"),
  name: "Radial Blur",
  category: "Blur",
  params: [
    { name: "amount", type: "float", default: 40, min: 0, max: 100, step: 1, label: "Amount" },
    { name: "centerX", type: "float", default: 50, min: 0, max: 100, step: 1, label: "Center X" },
    { name: "centerY", type: "float", default: 50, min: 0, max: 100, step: 1, label: "Center Y" }
  ],
  glsl: `
vec4 effect(vec2 uv) {
  vec2 center = vec2(centerX, 1.0 - centerY) / 100.0;
  vec2 delta = uv - center;
  float strength = (amount / 100.0) * 0.06;
  const int TAPS = 16;
  vec4 sum = vec4(0.0);
  for (int i = 0; i < TAPS; i++) {
    float t = float(i) / float(TAPS - 1);
    float scale = 1.0 - strength * t;
    sum += getSrcColor(center + delta * scale);
  }
  return sum / float(TAPS);
}
`
};

const DIRECTIONAL_BLUR: FragmentEffectDefinition = {
  id: builtinFragmentEffectId("directionalBlur"),
  name: "Directional Blur",
  category: "Blur",
  params: [
    { name: "amount", type: "float", default: 40, min: 0, max: 100, step: 1, label: "Amount" },
    { name: "angle", type: "float", default: 0, min: -180, max: 180, step: 1, label: "Angle" }
  ],
  glsl: `
vec4 effect(vec2 uv) {
  float rad = radians(angle);
  vec2 dir = vec2(cos(rad), sin(rad));
  float lengthPx = (amount / 100.0) * 60.0;
  vec2 dirStep = dir * (lengthPx / uResolution);
  const int TAPS = 16;
  vec4 sum = vec4(0.0);
  for (int i = 0; i < TAPS; i++) {
    float t = (float(i) / float(TAPS - 1)) - 0.5;
    sum += getSrcColor(uv + dirStep * t);
  }
  return sum / float(TAPS);
}
`
};

const SHARPEN: FragmentEffectDefinition = {
  id: builtinFragmentEffectId("sharpen"),
  name: "Sharpen",
  category: "Stylize",
  params: [{ name: "amount", type: "float", default: 40, min: 0, max: 100, step: 1, label: "Amount" }],
  glsl: `
vec4 effect(vec2 uv) {
  vec2 px = 1.0 / uResolution;
  vec4 c = getSrcColor(uv);
  vec4 n = getSrcColor(uv + vec2(0.0, px.y));
  vec4 s = getSrcColor(uv - vec2(0.0, px.y));
  vec4 e = getSrcColor(uv + vec2(px.x, 0.0));
  vec4 w = getSrcColor(uv - vec2(px.x, 0.0));
  vec4 blurred = (n + s + e + w) * 0.25;
  float k = (amount / 100.0) * 2.0;
  vec3 sharpened = c.rgb + (c.rgb - blurred.rgb) * k;
  return vec4(clamp(sharpened, 0.0, 1.0), c.a);
}
`
};

const PIXELATE: FragmentEffectDefinition = {
  id: builtinFragmentEffectId("pixelate"),
  name: "Pixelate",
  category: "Stylize",
  params: [{ name: "blockSize", type: "float", default: 16, min: 1, max: 200, step: 1, label: "Block Size" }],
  glsl: `
vec4 effect(vec2 uv) {
  vec2 block = max(vec2(1.0), vec2(blockSize)) / uResolution;
  vec2 cell = floor(uv / block) * block + block * 0.5;
  return getSrcColor(cell);
}
`
};

const CHROMATIC_ABERRATION: FragmentEffectDefinition = {
  id: builtinFragmentEffectId("chromaticAberration"),
  name: "Chromatic Aberration",
  category: "Stylize",
  params: [
    { name: "amount", type: "float", default: 30, min: 0, max: 100, step: 1, label: "Amount" },
    { name: "angle", type: "float", default: 0, min: -180, max: 180, step: 1, label: "Angle" }
  ],
  glsl: `
vec4 effect(vec2 uv) {
  float rad = radians(angle);
  vec2 dir = vec2(cos(rad), sin(rad));
  vec2 offset = dir * (amount / 100.0) * 0.02;
  vec4 base = getSrcColor(uv);
  float r = getSrcColor(uv + offset).r;
  float b = getSrcColor(uv - offset).b;
  return vec4(r, base.g, b, base.a);
}
`
};

// 2026-07-17 "graphics effects" batch (user request: sketch / old TV / glitch — adjustment-clip
// friendly stylize pack). `uTime` is set from the pass's frame time in EVERY renderer
// (scene-compositor `pass.timeSeconds`), so the animated ones (old TV, glitch) are frame-
// deterministic — preview and export produce identical pixels for the same frame.

const SKETCH: FragmentEffectDefinition = {
  id: builtinFragmentEffectId("sketch"),
  name: "Pencil Sketch",
  category: "Stylize",
  params: [
    { name: "detail", type: "float", default: 55, min: 0, max: 100, step: 1, label: "Detail" },
    { name: "contrast", type: "float", default: 40, min: 0, max: 100, step: 1, label: "Contrast" }
  ],
  glsl: `
vec4 effect(vec2 uv) {
  vec2 px = 1.0 / uResolution;
  // Sobel edge magnitude on luma.
  float tl = _luma(getSrcColor(uv + vec2(-px.x,  px.y)).rgb);
  float  t = _luma(getSrcColor(uv + vec2( 0.0,   px.y)).rgb);
  float tr = _luma(getSrcColor(uv + vec2( px.x,  px.y)).rgb);
  float  l = _luma(getSrcColor(uv + vec2(-px.x,  0.0 )).rgb);
  float  r = _luma(getSrcColor(uv + vec2( px.x,  0.0 )).rgb);
  float bl = _luma(getSrcColor(uv + vec2(-px.x, -px.y)).rgb);
  float  b = _luma(getSrcColor(uv + vec2( 0.0,  -px.y)).rgb);
  float br = _luma(getSrcColor(uv + vec2( px.x, -px.y)).rgb);
  float gx = (tr + 2.0 * r + br) - (tl + 2.0 * l + bl);
  float gy = (tl + 2.0 * t + tr) - (bl + 2.0 * b + br);
  float edge = length(vec2(gx, gy)) * mix(0.5, 4.0, detail / 100.0);
  // Ink on paper: edges dark, flats light, with a faint paper grain.
  float ink = 1.0 - clamp(edge, 0.0, 1.0);
  ink = pow(ink, 1.0 + (contrast / 100.0) * 3.0);
  float grain = 0.94 + 0.06 * _rand(floor(uv * uResolution * 0.5));
  vec4 src = getSrcColor(uv);
  return vec4(vec3(ink * grain), src.a);
}
`
};

const OLD_TV: FragmentEffectDefinition = {
  id: builtinFragmentEffectId("oldTv"),
  name: "Old TV",
  category: "Stylize",
  params: [
    { name: "scanlines", type: "float", default: 60, min: 0, max: 100, step: 1, label: "Scanlines" },
    { name: "noise", type: "float", default: 35, min: 0, max: 100, step: 1, label: "Noise" },
    { name: "jitter", type: "float", default: 30, min: 0, max: 100, step: 1, label: "Jitter" },
    { name: "vignette", type: "float", default: 50, min: 0, max: 100, step: 1, label: "Vignette" }
  ],
  glsl: `
vec4 effect(vec2 uv) {
  // Per-scanline horizontal jitter, stepped at ~24Hz so it flickers like a bad sync, not per-frame soup.
  float tick = floor(uTime * 24.0);
  float lineJitter = (_rand(vec2(floor(uv.y * uResolution.y), tick)) - 0.5) * 0.02 * (jitter / 100.0);
  // Occasional full-frame vertical roll tear.
  float tear = step(0.96, _rand(vec2(tick, 7.0))) * (jitter / 100.0) * 0.05;
  vec2 suv = uv + vec2(lineJitter, tear);
  vec4 c = getSrcColor(suv);
  // Slight warm cast + mild desaturation (aged phosphor).
  float lum = _luma(c.rgb);
  c.rgb = mix(c.rgb, vec3(lum) * vec3(1.05, 1.0, 0.9), 0.25);
  // Scanlines.
  float sl = sin(uv.y * uResolution.y * 3.14159) * 0.5 + 0.5;
  c.rgb *= mix(1.0, 0.72 + 0.28 * sl, scanlines / 100.0);
  // Animated static.
  float n = _rand(uv * uResolution + vec2(uTime * 61.0, uTime * 83.0));
  c.rgb = mix(c.rgb, vec3(n), (noise / 100.0) * 0.22);
  // Vignette.
  float d = distance(uv, vec2(0.5));
  c.rgb *= mix(1.0, smoothstep(0.85, 0.35, d), vignette / 100.0);
  return c;
}
`
};

const GLITCH_FX: FragmentEffectDefinition = {
  id: builtinFragmentEffectId("glitchFx"),
  name: "Glitch",
  category: "Stylize",
  params: [
    { name: "amount", type: "float", default: 50, min: 0, max: 100, step: 1, label: "Amount" },
    { name: "blockiness", type: "float", default: 40, min: 0, max: 100, step: 1, label: "Blockiness" },
    { name: "speed", type: "float", default: 50, min: 0, max: 100, step: 1, label: "Speed" }
  ],
  glsl: `
vec4 effect(vec2 uv) {
  float t = floor(uTime * mix(4.0, 24.0, speed / 100.0));
  float strength = amount / 100.0;
  float rows = mix(6.0, 40.0, blockiness / 100.0);
  float row = floor(uv.y * rows);
  float r1 = _rand(vec2(row, t));
  // Only some rows tear each tick — constant full-frame shifting reads as noise, not a glitch.
  float tearing = step(0.62, _rand(vec2(row, t + 13.0)));
  float shift = (r1 - 0.5) * 0.14 * strength * tearing;
  vec2 suv = uv + vec2(shift, 0.0);
  float split = 0.008 * strength * (0.5 + r1);
  vec4 base = getSrcColor(suv);
  float rr = getSrcColor(suv + vec2(split, 0.0)).r;
  float bb = getSrcColor(suv - vec2(split, 0.0)).b;
  return vec4(rr, base.g, bb, base.a);
}
`
};

const HALFTONE: FragmentEffectDefinition = {
  id: builtinFragmentEffectId("halftone"),
  name: "Halftone",
  category: "Stylize",
  params: [
    { name: "dotSize", type: "float", default: 8, min: 2, max: 40, step: 1, label: "Dot Size" },
    { name: "angle", type: "float", default: 25, min: -90, max: 90, step: 1, label: "Angle" }
  ],
  glsl: `
vec4 effect(vec2 uv) {
  float rad = radians(angle);
  mat2 rot = mat2(cos(rad), -sin(rad), sin(rad), cos(rad));
  mat2 inv = mat2(cos(rad), sin(rad), -sin(rad), cos(rad));
  float cell = max(2.0, dotSize);
  vec2 p = rot * (uv * uResolution);
  vec2 grid = (floor(p / cell) + 0.5) * cell;
  vec2 srcUv = (inv * grid) / uResolution;
  float l = _luma(getSrcColor(clamp(srcUv, 0.0, 1.0)).rgb);
  // Dot radius grows with darkness (print-style ink coverage).
  float radius = (1.0 - l) * cell * 0.62;
  float d = distance(p, grid);
  float ink = smoothstep(radius, radius - 1.2, d);
  vec4 src = getSrcColor(uv);
  return vec4(mix(vec3(0.97), vec3(0.05), ink), src.a);
}
`
};

const POSTERIZE: FragmentEffectDefinition = {
  id: builtinFragmentEffectId("posterize"),
  name: "Posterize",
  category: "Stylize",
  params: [{ name: "levels", type: "float", default: 5, min: 2, max: 16, step: 1, label: "Levels" }],
  glsl: `
vec4 effect(vec2 uv) {
  vec4 c = getSrcColor(uv);
  float n = max(2.0, floor(levels));
  vec3 q = floor(c.rgb * (n - 1.0) + 0.5) / (n - 1.0);
  return vec4(q, c.a);
}
`
};

const BUILTIN_FRAGMENT_EFFECTS: FragmentEffectDefinition[] = [
  RADIAL_BLUR,
  DIRECTIONAL_BLUR,
  SHARPEN,
  PIXELATE,
  CHROMATIC_ABERRATION,
  SKETCH,
  OLD_TV,
  GLITCH_FX,
  HALFTONE,
  POSTERIZE,
  // The stylize pass-graph (multi-pass — plans/stylize-anime-engine.md P1: Painterly).
  STYLIZE_PAINTERLY
];

let registered = false;

/** Idempotent — safe to call from multiple modules/renderers at load time. */
export function registerBuiltinFragmentEffects(): void {
  if (registered) return;
  registered = true;
  for (const def of BUILTIN_FRAGMENT_EFFECTS) {
    registerFragmentEffect(def);
  }
}
