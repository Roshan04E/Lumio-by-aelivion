import { registerFragmentEffect, type FragmentEffectDefinition } from "./registry";

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

const BUILTIN_FRAGMENT_EFFECTS: FragmentEffectDefinition[] = [RADIAL_BLUR, DIRECTIONAL_BLUR, SHARPEN, PIXELATE, CHROMATIC_ABERRATION];

let registered = false;

/** Idempotent — safe to call from multiple modules/renderers at load time. */
export function registerBuiltinFragmentEffects(): void {
  if (registered) return;
  registered = true;
  for (const def of BUILTIN_FRAGMENT_EFFECTS) {
    registerFragmentEffect(def);
  }
}
