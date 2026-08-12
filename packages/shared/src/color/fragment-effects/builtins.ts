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
  // centerY is a PERCENT and uv.y runs bottom-up, so the flip is 100 - y, not 1 - y. It read
  // "1.0 - centerY" from the day it was written: at the default centre that is (1 - 50)/100 =
  // -0.49, roughly half a frame BELOW the picture, and every setting of the control lands off
  // frame. The measured symptom was a zoom that smeared everything upward and barely moved along
  // the frame's own centre row; the Center Y control has never done anything usable.
  vec2 center = vec2(centerX, 100.0 - centerY) / 100.0;
  vec2 delta = uv - center;
  // Quadratic response into a 30% zoom sweep at the top of the slider (was a flat 6%). See the
  // range/tap note above DIRECTIONAL_BLUR — same reasoning, same shape.
  float a = clamp(amount, 0.0, 100.0) / 100.0;
  float strength = 0.30 * a * a;
  // Tap count from the WORST-CASE sweep in the frame (the corner furthest from the centre), not
  // from this pixel's own. A per-pixel count would print a visible ring wherever it steps, and two
  // renderers could round that step differently; this is constant across the frame because it reads
  // uniforms only.
  float maxSweepPx = length(max(center, 1.0 - center) * uResolution) * strength;
  int taps = int(clamp(ceil(maxSweepPx / 3.0), 8.0, 96.0));
  float jitter = _rand(uv * uResolution) - 0.5;
  vec4 sum = vec4(0.0);
  for (int i = 0; i < taps; i++) {
    float t = (float(i) + jitter) / float(taps - 1);
    float scale = 1.0 - strength * t;
    sum += getSrcColor(center + delta * scale);
  }
  return sum / float(taps);
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
  /**
   * Range and taps (2026-08-11). The old body streaked a fixed 60 PIXELS at amount 100 over a
   * fixed 16 taps — 5.6% of a 1080-wide frame, and smaller still on a 4K conform, because the
   * length was absolute. Measured, the response was linear to the top of the slider with no
   * plateau (reach past a hard edge 2/7/11/17/23/29px across amount 0.1..1.0), so unlike glow the
   * ceiling was never a kernel truncation; the constant was simply timid. See
   * `plans/flarex-node-controls-audit.md`.
   *
   * Three changes, and the second is the one that makes the first honest:
   *
   *  1. The streak is now a fraction of frame WIDTH, topping out at 20%, so it survives a conform.
   *  2. Taps scale with the streak at roughly one per 3px, capped at 96. Spreading a longer streak
   *     over the old 16 taps would not produce a longer blur, it would produce discrete ghosts —
   *     216px over 16 taps is 14px between samples. The count is derived from uniforms only, so it
   *     is constant across the frame and identical in every renderer, and it is demand-driven, so a
   *     short streak still costs a short shader.
   *
   *     The cap is where this stops being free: it covers a 288px span at the 3px target, which is
   *     the whole range on a 1080-wide frame (216px, 3.0px spacing) and most of it at 1920 (384px,
   *     4.0px). At 3840 the top of the slider samples ~8px apart and the phase jitter below is
   *     carrying it. The honest fix past that point is to prefilter at reduced resolution — the same
   *     change glow needs — and it is not in this round.
   *  3. Quadratic response. A linear remap would have multiplied every existing project's streak by
   *     3.6x at the same slider value; squaring keeps the low and middle of the range near their
   *     historical lengths (amount 0.4 goes 24px -> 35px) and puts the new reach at the top, where
   *     the complaint was. It also gives finer control over the short streaks people actually dial.
   */
  glsl: `
vec4 effect(vec2 uv) {
  float rad = radians(angle);
  vec2 dir = vec2(cos(rad), sin(rad));
  float a = clamp(amount, 0.0, 100.0) / 100.0;
  float spanPx = 0.20 * uResolution.x * a * a;
  int taps = int(clamp(ceil(spanPx / 3.0), 8.0, 96.0));
  vec2 dirStep = dir * (spanPx / uResolution);
  // Per-pixel phase jitter of +-half a tap. At the top of the range the taps are several pixels
  // apart and a fixed phase ladders a hard edge into countable ghosts; jitter turns that ladder
  // into dither. _rand is the shared integer hash — bit-identical across renderers, never sin().
  float jitter = _rand(uv * uResolution) - 0.5;
  vec4 sum = vec4(0.0);
  for (int i = 0; i < taps; i++) {
    float t = ((float(i) + jitter) / float(taps - 1)) - 0.5;
    sum += getSrcColor(uv + dirStep * t);
  }
  return sum / float(taps);
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
  // Authored end to end in display space — see `displayReferred`.
  displayReferred: true,
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
  // Authored end to end in display space — see `displayReferred`.
  displayReferred: true,
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
  // Authored end to end in display space — see `displayReferred`.
  displayReferred: true,
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
  // Authored end to end in display space — see `displayReferred`.
  displayReferred: true,
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
  // Authored end to end in display space — see `displayReferred`.
  displayReferred: true,
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

/** Flarex chroma keyer v2 (FLAREX.md Phase 1; upgraded to the pro 3-pass graph 2026-07-21; garbage/
 *  hold-out mattes folded into the final pass 2026-08-12 — see below).
 *  Not a `TimelineEffectType` — referenced by id from the Flarex lowering compiler's chromaKey node.
 *
 *  Pass graph (Keylight / Delta-Keyer family, not a distance key):
 *    matte  — COLOR-DIFFERENCE matte in the CbCr plane: alpha is LINEAR in the key mixture, so a
 *             50% green hair/motion-blur edge gets 50% alpha (translucency a distance matte cannot
 *             produce). Then screen levels: clipBlack/clipWhite + softness shoulder.
 *    edge   — matte-space refinement: Gaussian feather whose radius is FRAME-RELATIVE (defined at a
 *             1080p short edge, scales with working res — proxy/preview/export paint the same
 *             picture-space edge), then choke levels (positive eats the fringe, negative grows back).
 *    final  — GARBAGE/HOLD-OUT FOLD, then y-preserving despill (project the key hue out of the chroma
 *             plane; luma untouched, no darkening) + EDGE DECONTAMINATION: an edge pixel is
 *             fg + key*(1-m), so the key contribution is divided back out (screen subtraction) —
 *             green casts leave the hair entirely instead of being dimmed. `matteOnly` shows the
 *             (now garbage/hold-out-inclusive) matte for tuning.
 *
 *  GARBAGE/HOLD-OUT FOLD (`keyerMattes`, `uGarbageMatte`/`uHoldOutMatte`, compile-flarex.ts's
 *  chromaKey case rasterizes the two optional matte sockets straight onto this pass — no compile-side
 *  composite anymore):
 *
 *    m = clamp(max(m, holdOut) * (1 - garbage), 0, 1)
 *
 *  Applied BEFORE `matteOnly`'s early return, so the tuning view shows both mattes' contribution —
 *  the one thing the OLD compile-side composite could not do (a hold-out there was a plate composited
 *  UNDER the keyed image, invisible to a matteOnly pass that only ever saw the key's own RGB became
 *  matte). PRECEDENCE — garbage beats hold-out — is structural in this expression, not compared: at
 *  garbage=1 the product is 0 regardless of holdOut; at garbage=0, holdOut=1 forces 1. Partial values
 *  (feathered mattes) are the continuous extension of the same rule. Both sockets are invertible via
 *  the `garbageInvert`/`holdOutInvert` bools, applied to the sampled coverage before the fold — a
 *  node-param pair (node-defs.ts), not a second rasterized mask (that used to be `complementMatte`'s
 *  job on the compile side; inverting a scalar in the shader is simpler and costs nothing extra).
 *
 *  `displayReferred: true` (below) makes the WHOLE graph — matte/edge/final — resolve to "display"
 *  light space (`effectLightFor`). That governs `getSrcColor`, the ONE place colour is decoded, which
 *  only the "matte" pass calls — untouched by this fold. The garbage/hold-out textures are alpha-only
 *  coverage, sampled directly via `texture(...).a` with no `getSrcColor`/transfer-function pass at
 *  all, so there is nothing for the linear stage to convert either way: the key keeps reading exactly
 *  the display-chroma values its tolerance/clip/choke constants were tuned against. */
export const FLAREX_CHROMA_KEY_ID = "flarex.chromaKey";

const CHROMA_HELPERS = `
vec2 _chroma(vec3 c) {
  // BT.601 CbCr, centered at 0 — hue/saturation plane, luma-independent.
  float cb = -0.168736 * c.r - 0.331264 * c.g + 0.5 * c.b;
  float cr =  0.5      * c.r - 0.418688 * c.g - 0.081312 * c.b;
  return vec2(cb, cr);
}
`;

const FLAREX_CHROMA_KEY: FragmentEffectDefinition = {
  id: FLAREX_CHROMA_KEY_ID,
  name: "Chroma Keyer",
  category: "Keying",
  rewritesAlpha: true,
  keyerMattes: true,
  /**
   * FOUND BY THE TYPE, not by review: this is the second multi-pass definition in the tree, and
   * `102eeb5` asserted in prose that the stylize graph was the only one. It was wrong, and nothing
   * would have said so — a keyer in a LINEAR project would have run its 3-pass graph through raw
   * RGBA8 intermediates, banding the matte in the shadows exactly where hair edges live.
   *
   * `displayReferred` is also the right answer on its own merits, before the storage argument. A
   * color-difference keyer is not a light-mixing operation: it measures how key-hued a pixel is in
   * the CbCr plane, and every constant here — tolerance's `0.5 + t * 2.0` gain, the clipBlack/
   * clipWhite screen levels, the choke shoulder — was authored and tuned against DISPLAY chroma.
   * In linear, chroma collapses toward the shadows and all of them mean something else.
   *
   * If a linear keyer is ever wanted, it is the compositor-side fix (sRGB intermediates) plus a
   * re-tune of the whole control set, not this flag.
   */
  displayReferred: true,
  params: [
    { name: "keyColor", type: "vec3", default: [0.0, 0.69, 0.25], label: "Key Color" },
    { name: "tolerance", type: "float", default: 0.35, min: 0, max: 1, step: 0.01, label: "Tolerance" },
    { name: "softness", type: "float", default: 0.1, min: 0, max: 1, step: 0.01, label: "Softness" },
    { name: "clipBlack", type: "float", default: 0, min: 0, max: 1, step: 0.01, label: "Clip Black" },
    { name: "clipWhite", type: "float", default: 1, min: 0, max: 1, step: 0.01, label: "Clip White" },
    { name: "spillSuppression", type: "float", default: 0.5, min: 0, max: 1, step: 0.01, label: "Spill Suppression" },
    { name: "edgeSoftness", type: "float", default: 2, min: 0, max: 20, step: 0.5, label: "Edge Softness" },
    { name: "choke", type: "float", default: 0.05, min: -1, max: 1, step: 0.01, label: "Choke" },
    { name: "decontaminate", type: "float", default: 0.5, min: 0, max: 1, step: 0.01, label: "Edge Cleanup" },
    { name: "matteOnly", type: "bool", default: false, label: "Matte Only" },
    // Node params of the same name (node-defs.ts) flow straight through as `pass.params` — see
    // `resolveFragmentEffectParams`. Coverage sampled from `uGarbageMatte`/`uHoldOutMatte`; these
    // bools flip which side of it counts as "on" before the fold below.
    { name: "garbageInvert", type: "bool", default: false, label: "Invert Garbage" },
    { name: "holdOutInvert", type: "bool", default: false, label: "Invert Hold-Out" }
  ],
  glsl: "", // multi-pass — see `passes`
  passes: [
    {
      id: "matte",
      glsl: `
${CHROMA_HELPERS}
vec4 effect(vec2 uv) {
  vec4 c = getSrcColor(uv);
  vec2 kc = _chroma(keyColor);
  float sat = max(length(kc), 1e-4);
  vec2 keyDir = kc / sat;
  vec2 pc = _chroma(c.rgb);
  float along = dot(pc, keyDir);
  float across = length(pc - keyDir * along);
  // Color-difference matte: how much MORE key-hued than anything-else-hued the pixel is,
  // normalized by the key's own saturation — 0 on the subject, 1 on the pure screen, and
  // LINEAR in between (the property that keeps hair edges translucent).
  float gain = 0.5 + tolerance * 2.0;
  float keyness = max(along - across, 0.0);
  float raw = 1.0 - clamp(keyness / sat * gain, 0.0, 1.0);
  // Screen levels: everything below clipBlack is fully removed, above clipWhite fully kept.
  float lo = clamp(clipBlack, 0.0, 0.95);
  float hi = max(clipWhite, lo + 0.02);
  float m = clamp((raw - lo) / (hi - lo), 0.0, 1.0);
  m = mix(m, m * m * (3.0 - 2.0 * m), clamp(softness, 0.0, 1.0));
  return vec4(vec3(m), 1.0);
}
`
    },
    {
      id: "edge",
      inputs: ["matte"],
      glsl: `
vec4 effect(vec2 uv) {
  vec2 px = 1.0 / uResolution;
  float shortEdge = min(uResolution.x, uResolution.y);
  // Frame-relative feather (defined at a 1080p short edge) — spacing 0 degenerates to identity.
  float spacing = max(edgeSoftness, 0.0) * (shortEdge / 1080.0) * 0.5;
  float sum = 0.0;
  float wsum = 0.0;
  for (int j = -2; j <= 2; j++) {
    for (int i = -2; i <= 2; i++) {
      float w = exp(-float(i * i + j * j) / 2.5);
      sum += texture(uPass0, uv + px * vec2(float(i), float(j)) * spacing).r * w;
      wsum += w;
    }
  }
  float m = sum / wsum;
  // Choke levels on the feathered matte: positive raises the black point (eats INTO the kept
  // side, killing residual fringe); negative lowers the white point (grows the matte back).
  float lo = max(choke, 0.0);
  float hi = min(1.0, 1.0 + choke);
  m = clamp((m - lo) / max(hi - lo, 1e-4), 0.0, 1.0);
  return vec4(vec3(m), 1.0);
}
`
    },
    {
      id: "final",
      inputs: ["edge"],
      glsl: `
${CHROMA_HELPERS}
vec4 effect(vec2 uv) {
  vec4 c = getSrcColor(uv);
  float m = texture(uPass0, uv).r;
  // GARBAGE/HOLD-OUT FOLD — see the definition's docstring for the algebra and why it is safe from
  // linear-light conversion. Coverage is alpha-only DATA (never routed through getSrcColor), so this
  // is unaffected by displayReferred either way. Invert is applied ONLY when the socket is actually
  // wired: an unwired matte must stay a true no-op regardless of the invert flag's (persisted) value,
  // or a keyer saved with holdOutInvert=true would force full hold-out the moment the socket is
  // unplugged instead of degrading to the plain key.
  float holdOutCoverage = 0.0;
  if (uHasHoldOutMatte > 0.5) {
    holdOutCoverage = texture(uHoldOutMatte, uv).a;
    if (holdOutInvert) holdOutCoverage = 1.0 - holdOutCoverage;
  }
  float garbageCoverage = 0.0;
  if (uHasGarbageMatte > 0.5) {
    garbageCoverage = texture(uGarbageMatte, uv).a;
    if (garbageInvert) garbageCoverage = 1.0 - garbageCoverage;
  }
  m = clamp(max(m, holdOutCoverage) * (1.0 - garbageCoverage), 0.0, 1.0);
  if (matteOnly) return vec4(vec3(m), c.a);
  vec2 kc = _chroma(keyColor);
  float sat = max(length(kc), 1e-4);
  vec2 keyDir = kc / sat;
  vec2 pc = _chroma(c.rgb);
  float along = dot(pc, keyDir);
  // Despill: project the key hue OUT of the chroma plane; luma is rebuilt untouched (no darkening).
  vec2 dsc = pc - keyDir * max(along, 0.0) * clamp(spillSuppression, 0.0, 1.0);
  float y = dot(c.rgb, vec3(0.299, 0.587, 0.114));
  vec3 despilled = vec3(
    y + 1.402 * dsc.y,
    y - 0.344136 * dsc.x - 0.714136 * dsc.y,
    y + 1.772 * dsc.x
  );
  // Edge decontamination (screen subtraction): the semi-transparent pixel is fg + key*(1-m);
  // divide the key contribution back out so the fringe color leaves entirely.
  vec3 unmix = clamp((despilled - keyColor * (1.0 - m)) / max(m, 0.08), 0.0, 1.0);
  vec3 outC = mix(despilled, unmix, clamp(decontaminate, 0.0, 1.0) * (1.0 - m));
  return vec4(clamp(outC, 0.0, 1.0), c.a * m);
}
`
    }
  ]
};

/** Flarex luma keyer (FLAREX.md Phase 1.5-ready; ships with the chroma keyer since it shares the seam). */
export const FLAREX_LUMA_KEY_ID = "flarex.lumaKey";
const FLAREX_LUMA_KEY: FragmentEffectDefinition = {
  id: FLAREX_LUMA_KEY_ID,
  name: "Luma Keyer",
  category: "Keying",
  rewritesAlpha: true,
  params: [
    { name: "low", type: "float", default: 0, min: 0, max: 1, step: 0.01, label: "Low" },
    { name: "high", type: "float", default: 1, min: 0, max: 1, step: 0.01, label: "High" },
    { name: "softness", type: "float", default: 0.1, min: 0, max: 1, step: 0.01, label: "Softness" },
    { name: "invertKey", type: "bool", default: false, label: "Invert" },
    { name: "matteOnly", type: "bool", default: false, label: "Matte Only" }
  ],
  glsl: `
vec4 effect(vec2 uv) {
  vec4 c = getSrcColor(uv);
  float y = _luma(c.rgb);
  float soft = max(softness * 0.25, 0.001);
  // Keep luma inside [low, high]; ramp over soft at each edge.
  float matte = smoothstep(low - soft, low + soft, y) * (1.0 - smoothstep(high - soft, high + soft, y));
  if (invertKey) matte = 1.0 - matte;
  if (matteOnly) return vec4(vec3(matte), c.a);
  return vec4(c.rgb, c.a * matte);
}
`
};

/**
 * Flarex Crop — trim the frame's edges, leaving TRANSPARENT outside the box.
 *
 * `rewritesAlpha` because that is the whole effect: the default composite-back draws the pass result
 * OVER the running image, so a cropped-away pixel would still show the original underneath and the
 * crop would be invisible (the same reason the keyers set it).
 *
 * Insets are frame fractions from each edge. Note `uv.y` runs BOTTOM-up here while the params read
 * top-down, so top/bottom are mapped, not passed straight. (This comment used to cite `radialBlur`'s
 * `1.0 - centerY` as the precedent. It was not one: crop's insets are 0..1 fractions so `1.0 - top`
 * is right, while radialBlur's centre is a 0..100 percent and that line was a defect — see the note
 * on RADIAL_BLUR above.)
 */
export const FLAREX_CROP_ID = "flarex.crop";
const FLAREX_CROP: FragmentEffectDefinition = {
  id: FLAREX_CROP_ID,
  name: "Crop",
  category: "Transform",
  rewritesAlpha: true,
  params: [
    { name: "left", type: "float", default: 0, min: 0, max: 1, step: 0.01, label: "Left" },
    { name: "right", type: "float", default: 0, min: 0, max: 1, step: 0.01, label: "Right" },
    { name: "top", type: "float", default: 0, min: 0, max: 1, step: 0.01, label: "Top" },
    { name: "bottom", type: "float", default: 0, min: 0, max: 1, step: 0.01, label: "Bottom" },
    { name: "softness", type: "float", default: 0, min: 0, max: 1, step: 0.01, label: "Soft Edge" }
  ],
  glsl: `
vec4 effect(vec2 uv) {
  vec4 c = getSrcColor(uv);
  float l = clamp(left, 0.0, 1.0);
  float r = 1.0 - clamp(right, 0.0, 1.0);
  float b = clamp(bottom, 0.0, 1.0);
  float t = 1.0 - clamp(top, 0.0, 1.0);
  // Feather half-width in uv units. At softness 0 this collapses to a hard step, so an un-feathered
  // crop lands exactly on the pixel edge instead of bleeding half a pixel.
  float f = max(softness, 0.0) * 0.5;
  float inside;
  if (f > 0.0) {
    inside = smoothstep(l - f, l + f, uv.x) * (1.0 - smoothstep(r - f, r + f, uv.x))
           * smoothstep(b - f, b + f, uv.y) * (1.0 - smoothstep(t - f, t + f, uv.y));
  } else {
    inside = step(l, uv.x) * step(uv.x, r) * step(b, uv.y) * step(uv.y, t);
  }
  return vec4(c.rgb, c.a * clamp(inside, 0.0, 1.0));
}
`
};

/**
 * Flarex Channel Boolean — the Splitter/Combiner in ONE node.
 *
 * Each output channel is sourced from any input channel (or luma, or a constant), which covers the
 * channel work people leave the page for: isolating a channel, copying luma into alpha to build a
 * matte from a plate, swapping/zeroing channels, inverting.
 *
 * Sources are float indices because the shader-param vocabulary is float/vec2/vec3/bool; the node
 * surfaces them as named dropdowns.
 *   0=Red  1=Green  2=Blue  3=Alpha  4=Luma  5=Black(0)  6=White(1)
 */
export const FLAREX_CHANNELS_ID = "flarex.channels";
const FLAREX_CHANNELS: FragmentEffectDefinition = {
  id: FLAREX_CHANNELS_ID,
  name: "Channel Boolean",
  category: "Channel",
  rewritesAlpha: true,
  params: [
    { name: "rFrom", type: "float", default: 0, min: 0, max: 6, step: 1, label: "Red From" },
    { name: "gFrom", type: "float", default: 1, min: 0, max: 6, step: 1, label: "Green From" },
    { name: "bFrom", type: "float", default: 2, min: 0, max: 6, step: 1, label: "Blue From" },
    { name: "aFrom", type: "float", default: 3, min: 0, max: 6, step: 1, label: "Alpha From" },
    { name: "invertRgb", type: "bool", default: false, label: "Invert RGB" }
  ],
  glsl: `
float _pickChannel(vec4 c, float src) {
  int s = int(clamp(src, 0.0, 6.0) + 0.5);
  if (s == 0) return c.r;
  if (s == 1) return c.g;
  if (s == 2) return c.b;
  if (s == 3) return c.a;
  if (s == 4) return _luma(c.rgb);
  if (s == 5) return 0.0;
  return 1.0;
}
vec4 effect(vec2 uv) {
  vec4 c = getSrcColor(uv);
  vec4 o = vec4(
    _pickChannel(c, rFrom),
    _pickChannel(c, gFrom),
    _pickChannel(c, bFrom),
    _pickChannel(c, aFrom)
  );
  if (invertRgb) o.rgb = vec3(1.0) - o.rgb;
  return clamp(o, 0.0, 1.0);
}
`
};

/**
 * Flarex Vignette / Film Grain — the media shader's two stylize stages, as pass effects.
 *
 * They exist here rather than riding a `ColorPipeline` because vignette/grain are NOT pipeline
 * stages: they live in `MediaEffects`, which the compositor passes as `null` when it grades a group
 * (`scene-compositor.ts`), so a Flarex node could never reach them that way. As fragment passes they
 * are also cheaper — passes stack on one shell instead of opening a nest per node.
 *
 * The GLSL is ported from `media-shader.ts` so a vignette/grain looks identical whether it is applied
 * to a clip or built as a node. Params are normalized 0..1 (the `MediaEffects` contract), with the
 * media path's own 0.25 grain scaling folded in so the node param stays a clean 0..1.
 */
export const FLAREX_VIGNETTE_ID = "flarex.vignette";
const FLAREX_VIGNETTE: FragmentEffectDefinition = {
  id: FLAREX_VIGNETTE_ID,
  name: "Vignette",
  category: "Stylize",
  params: [
    { name: "amount", type: "float", default: 0.35, min: 0, max: 1, step: 0.01, label: "Amount" },
    { name: "size", type: "float", default: 0.58, min: 0, max: 1, step: 0.01, label: "Size" },
    { name: "feather", type: "float", default: 1, min: 0, max: 1, step: 0.01, label: "Feather" },
    { name: "roundness", type: "float", default: 0, min: 0, max: 1, step: 0.01, label: "Roundness" },
    { name: "highlights", type: "float", default: 0, min: 0, max: 1, step: 0.01, label: "Protect Highlights" }
  ],
  glsl: `
vec4 effect(vec2 uv) {
  vec4 c = getSrcColor(uv);
  float aspect = uResolution.x / max(uResolution.y, 1.0);
  vec2 d = uv - 0.5;
  d.x *= mix(1.0, aspect, roundness);
  float corner = length(vec2(0.5 * mix(1.0, aspect, roundness), 0.5));
  float r = length(d) / corner;                    // 0 centre → 1 corners
  float start = mix(0.15, 0.95, size);
  float end = mix(start + 0.02, 1.0, feather);
  float v = 1.0 - amount * smoothstep(start, end, r);
  // Protect highlights: bright pixels resist the darkening (filmic vignette, not a flat multiply).
  v = mix(v, 1.0, highlights * smoothstep(0.6, 1.0, _luma(c.rgb)));
  return vec4(c.rgb * v, c.a);
}
`
};

export const FLAREX_GRAIN_ID = "flarex.grain";
const FLAREX_GRAIN: FragmentEffectDefinition = {
  id: FLAREX_GRAIN_ID,
  name: "Film Grain",
  category: "Stylize",
  params: [
    { name: "amount", type: "float", default: 0.18, min: 0, max: 1, step: 0.01, label: "Amount" },
    { name: "size", type: "float", default: 1, min: 0.25, max: 4, step: 0.05, label: "Size" }
  ],
  glsl: `
float _grainHash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
vec4 effect(vec2 uv) {
  vec4 c = getSrcColor(uv);
  // size 1 = the media path's 1280×720 virtual grain grid; >1 = coarser grain. The seed uses a long
  // non-integer period so the pattern never visibly repeats.
  vec2 grid = vec2(1280.0, 720.0) / max(size, 0.01);
  float n = _grainHash(uv * grid + mod(uTime, 61.7) * 97.13);
  float midWeight = 1.0 - abs(_luma(c.rgb) - 0.5) * 1.4;
  return vec4(c.rgb + (n - 0.5) * (amount * 0.25) * max(0.0, midWeight), c.a);
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
  STYLIZE_PAINTERLY,
  // Flarex nodes (FLAREX.md) — id-referenced by the lowering compiler, not TimelineEffectTypes.
  FLAREX_CHROMA_KEY,
  FLAREX_LUMA_KEY,
  FLAREX_CROP,
  FLAREX_CHANNELS,
  FLAREX_VIGNETTE,
  FLAREX_GRAIN
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
