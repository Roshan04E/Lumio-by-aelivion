/**
 * Professional Color System — extended WebGL2 shader for the unified MediaWebGLRenderer.
 * Extends the base color shader (`shader.ts`) with:
 *   - Matte compositing: a second luma-matte texture multiplied into alpha.
 *   - Layer opacity: `u_opacity` multiplied into the final alpha.
 *   - LUT is optional: `u_hasLut` gates the lookup so identity layers render straight through.
 *
 * Object-fit (cover/contain) remains a CSS property on the canvas element — no UV math
 * in the shader. Transforms stay CSS. Warp overlay stays DOM SVG. This keeps the shader
 * minimal and the CSS layout engine doing what it's good at.
 *
 * Manual trilinear LUT lookup (same as shader.ts) — 8 `texelFetch` taps — so it works on
 * headless Chromium / SwiftShader where `OES_texture_float_linear` may be absent.
 */

import type { Lut3d } from "./lut3d";

export const MEDIA_VERTEX_SHADER = `#version 300 es
in vec2 a_position;
out vec2 v_uv;
void main() {
  v_uv = a_position * 0.5 + 0.5;
  gl_Position = vec4(a_position, 0.0, 1.0);
}`;

export const MEDIA_FRAGMENT_SHADER = `#version 300 es
precision highp float;
precision highp sampler3D;
in vec2 v_uv;
out vec4 fragColor;

uniform sampler2D u_frame;
uniform sampler3D u_lut;
uniform float u_lutSize;
uniform float u_amount;
uniform bool u_hasLut;

uniform sampler2D u_matte;
uniform bool u_hasMatte;
uniform bool u_matteInvert;
uniform float u_matteOpacity;

uniform float u_opacity;

// Stylize effects (real per-pixel shader ops, not DOM overlays).
uniform bool u_hasVignette;
uniform float u_vigAmount;     // 0..1 darkening strength at the corners
uniform float u_vigSize;       // 0..1 size of the clear center
uniform float u_vigFeather;    // 0..1 falloff width (1 = legacy fall-to-corner)
uniform float u_vigRound;      // 0..1 aspect correction (0 = legacy UV circle, 1 = pixel-circular)
uniform float u_vigHighlights; // 0..1 highlight protection (0 = plain multiply)
uniform float u_aspect;        // frame width / height (for u_vigRound)

uniform bool u_hasGrain;
uniform float u_grainAmount; // 0..1 film-grain intensity
uniform float u_grainSize;   // grain size multiplier (1 = legacy 1280×720 virtual grid)
uniform float u_time;        // layer time (s) — deterministic grain across preview+export

uniform bool u_hasChroma;
uniform vec3 u_chromaColor;   // key color, linear 0..1
uniform float u_chromaTol;    // base tolerance in normalized CbCr distance (how close counts as key)
uniform float u_chromaSoft;   // edge softness (same domain)
uniform float u_chromaDespill;   // 0..1 key-chroma suppression on kept spill pixels
uniform float u_chromaChoke;     // 0..1 matte erosion after softness
uniform bool u_chromaMatteView;  // render the grayscale alpha matte instead of the frame (tuning)

// Transition reveal — a real per-pixel GPU wipe/iris on the INCOMING clip's alpha. The outgoing clip
// is composited opaque underneath in every renderer, so masking the incoming alpha produces a true
// two-clip transition with no second texture. progress: 0 concealed → 1 revealed.
uniform int u_transitionKind;     // 0 none, 1 wipe, 2 iris, 3 dip
uniform float u_transitionProgress;
uniform int u_transitionDir;      // wipe: 0 left, 1 right, 2 up, 3 down
uniform int u_transitionMode;     // iris: 0 in (grow from center), 1 out (shrink to center)
uniform float u_transitionSoft;   // 0..1 soft-edge width
uniform vec3 u_transitionColor;   // dip-through colour (rgb 0..1)

const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

// Linear wipe: reveal (=1) where the coordinate is behind the moving line at p, with a soft edge.
float wipeReveal(vec2 uv, float p, int dir, float soft) {
  float coord = (dir == 0) ? (1.0 - uv.x)
              : (dir == 1) ? uv.x
              : (dir == 2) ? (1.0 - uv.y)
              : uv.y;
  float s = max(soft, 0.001);
  return 1.0 - smoothstep(p - s, p + s, coord);
}

// Iris/circle: reveal a disc growing from (mode 0) or shrinking to (mode 1) the center.
float irisReveal(vec2 uv, float p, int mode, float soft) {
  float d = distance(uv, vec2(0.5)) * 1.41421356; // 0 center → ~1 corners
  float s = max(soft, 0.001);
  float reveal = 1.0 - smoothstep(p - s, p + s, d);
  return (mode == 1) ? (1.0 - reveal) : reveal;
}

// Mirror the CPU cleanCoverage() snap: codec noise near 0/255 snaps to exact 0/1.
float cleanMatteCoverage(float luma) {
  if (luma <= 0.094) return 0.0;   // NOISE_FLOOR 24/255
  if (luma >= 0.910) return 1.0;   // NOISE_CEILING 232/255
  return luma;
}

// Hash-based value noise for film grain (stable per uv+time).
float grainHash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

// BT.709 chroma plane — luminance-independent (Cb, Cr) so dark and bright shades of the
// key color key together, and the keyer works for ANY key color (not just green).
vec2 toCbCr(vec3 c) {
  float y = dot(c, LUMA);
  return vec2((c.b - y) / 1.8556, (c.r - y) / 1.5748);
}

// Reconstruct RGB from luma + a (possibly despilled) chroma pair — BT.709 inverse.
vec3 fromYCbCr(float y, vec2 cc) {
  float r = y + 1.5748 * cc.y;
  float b = y + 1.8556 * cc.x;
  float g = (y - 0.2126 * r - 0.0722 * b) / 0.7152;
  return vec3(r, g, b);
}

vec3 lutLookup(vec3 c) {
  float n = u_lutSize;
  vec3 p = clamp(c, 0.0, 1.0) * (n - 1.0);
  ivec3 b0 = ivec3(floor(p));
  ivec3 b1 = min(b0 + ivec3(1), ivec3(int(n) - 1));
  vec3 f = p - vec3(b0);
  vec3 c000 = texelFetch(u_lut, ivec3(b0.x, b0.y, b0.z), 0).rgb;
  vec3 c100 = texelFetch(u_lut, ivec3(b1.x, b0.y, b0.z), 0).rgb;
  vec3 c010 = texelFetch(u_lut, ivec3(b0.x, b1.y, b0.z), 0).rgb;
  vec3 c110 = texelFetch(u_lut, ivec3(b1.x, b1.y, b0.z), 0).rgb;
  vec3 c001 = texelFetch(u_lut, ivec3(b0.x, b0.y, b1.z), 0).rgb;
  vec3 c101 = texelFetch(u_lut, ivec3(b1.x, b0.y, b1.z), 0).rgb;
  vec3 c011 = texelFetch(u_lut, ivec3(b0.x, b1.y, b1.z), 0).rgb;
  vec3 c111 = texelFetch(u_lut, ivec3(b1.x, b1.y, b1.z), 0).rgb;
  vec3 c00 = mix(c000, c100, f.x);
  vec3 c10 = mix(c010, c110, f.x);
  vec3 c01 = mix(c001, c101, f.x);
  vec3 c11 = mix(c011, c111, f.x);
  return mix(mix(c00, c10, f.y), mix(c01, c11, f.y), f.z);
}

void main() {
  vec4 src = texture(u_frame, v_uv);

  if (u_hasLut) {
    vec3 graded = lutLookup(src.rgb);
    src.rgb = mix(src.rgb, graded, u_amount);
  }

  // Chroma key — YCbCr chroma-plane keyer: soft edge, matte choke, key-direction despill.
  if (u_hasChroma) {
    vec2 keyCC = toCbCr(u_chromaColor);
    float keyLen = max(length(keyCC), 0.10); // near-gray key colors: keep the normalization sane
    vec2 srcCC = toCbCr(src.rgb);
    float dist = distance(srcCC, keyCC) / keyLen;
    float keyAlpha = smoothstep(u_chromaTol, u_chromaTol + u_chromaSoft + 0.001, dist);
    // Choke: erode the matte after the soft edge (0 = identity).
    keyAlpha = clamp((keyAlpha - u_chromaChoke) / max(1.0 - u_chromaChoke, 0.001), 0.0, 1.0);
    if (u_chromaMatteView) {
      fragColor = vec4(vec3(keyAlpha), 1.0);
      return;
    }
    // Despill: suppress the chroma component along the key direction on kept pixels near the
    // key (edge fringe), reconstructing luma-preserving RGB. Works for any key color.
    float spill = 1.0 - keyAlpha;
    float l = dot(src.rgb, LUMA);
    vec2 keyDir = keyCC / max(length(keyCC), 1e-4);
    float along = max(dot(srcCC, keyDir), 0.0);
    vec2 despilled = srcCC - keyDir * (along * u_chromaDespill * spill);
    src.rgb = clamp(fromYCbCr(l, despilled), 0.0, 1.0);
    src.a *= keyAlpha;
  }

  // Vignette — smooth radial darkening (gamma-correct on the graded rgb). Roundness blends the
  // legacy UV-space circle (0) toward a pixel-circular falloff (1); at roundness 0 + feather 1
  // + highlights 0 this is exactly the pre-param shader: length(d)*sqrt(2) vs smoothstep(start, 1).
  if (u_hasVignette) {
    vec2 d = v_uv - 0.5;
    d.x *= mix(1.0, u_aspect, u_vigRound);
    float corner = length(vec2(0.5 * mix(1.0, u_aspect, u_vigRound), 0.5));
    float r = length(d) / corner;                  // 0 center → 1 corners
    float start = mix(0.15, 0.95, u_vigSize);
    float end = mix(start + 0.02, 1.0, u_vigFeather);
    float v = 1.0 - u_vigAmount * smoothstep(start, end, r);
    // Protect highlights: bright pixels resist the darkening (filmic vignette, not a flat multiply).
    float vl = dot(src.rgb, LUMA);
    v = mix(v, 1.0, u_vigHighlights * smoothstep(0.6, 1.0, vl));
    src.rgb *= v;
  }

  // Film grain — luminance-aware (strongest in midtones), deterministic per frame. The seed uses
  // a long non-integer period so the pattern never visibly repeats (the old fract(u_time) reset
  // the pattern every whole second); u_grainSize scales the virtual grain cell (1 = legacy grid).
  if (u_hasGrain) {
    vec2 grid = vec2(1280.0, 720.0) / max(u_grainSize, 0.01);
    float n = grainHash(v_uv * grid + mod(u_time, 61.7) * 97.13);
    float l = dot(src.rgb, LUMA);
    float midWeight = 1.0 - abs(l - 0.5) * 1.4;
    src.rgb += (n - 0.5) * u_grainAmount * max(0.0, midWeight);
  }

  if (u_hasMatte) {
    float matteAlpha = cleanMatteCoverage(texture(u_matte, v_uv).r);
    if (u_matteInvert) matteAlpha = 1.0 - matteAlpha;
    src.a *= matteAlpha * u_matteOpacity;
  }

  src.rgb = clamp(src.rgb, 0.0, 1.0);
  src.a *= u_opacity;

  // Transition reveal (incoming clip) — applied last so it masks the fully composited pixel.
  if (u_transitionKind == 1) {
    src.a *= wipeReveal(v_uv, u_transitionProgress, u_transitionDir, u_transitionSoft);
  } else if (u_transitionKind == 2) {
    src.a *= irisReveal(v_uv, u_transitionProgress, u_transitionMode, u_transitionSoft);
  } else if (u_transitionKind == 3) {
    // Dip through a colour: the incoming fades in tinted to the colour over the first half (screen
    // goes from the outgoing clip to the colour), then the colour resolves to the real frame.
    float reveal = smoothstep(0.0, 0.5, u_transitionProgress);
    float colorAmt = clamp(1.0 - abs(u_transitionProgress - 0.5) * 2.0, 0.0, 1.0);
    src.rgb = mix(src.rgb, u_transitionColor, colorAmt);
    src.a *= reveal;
  }

  fragColor = src;
}`;

/**
 * Pack a `Lut3d` (RGB triples) into an RGBA Float32 buffer for `gl.texImage3D`.
 * Reused from shader.ts — copied here so media-renderer.ts has no dependency on
 * the old shader module (they coexist independently).
 */
export function mediaLut3dToRgbaFloat(lut: Lut3d): Float32Array {
  const { size, data } = lut;
  const out = new Float32Array(size * size * size * 4);
  const count = size * size * size;
  for (let i = 0; i < count; i += 1) {
    out[i * 4] = data[i * 3]!;
    out[i * 4 + 1] = data[i * 3 + 1]!;
    out[i * 4 + 2] = data[i * 3 + 2]!;
    out[i * 4 + 3] = 1;
  }
  return out;
}
