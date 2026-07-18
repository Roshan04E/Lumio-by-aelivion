import type { FragmentEffectDefinition } from "./registry";

/**
 * Stylize engine P1 — the Painterly pass graph (plans/stylize-anime-engine.md).
 *
 * Four registered passes over the shared multi-pass harness:
 *
 *   tensor (½ res)      Sobel structure tensor of the source luma, packed (gx², gy², gx·gy)
 *   tensorBlur (½ res)  5×5 Gaussian on the tensor — the smoothing that makes orientation stable
 *   paint (½ res)       ANISOTROPIC KUWAHARA (Kyprianidis PG'09 / GPU Pro): 8 sectors shaped by
 *                       the tensor's eigen-frame (ellipse stretched along the local feature flow),
 *                       polynomial sector weights [(x+ζ)−η·y²]² (the GPU Pro perf trick — no
 *                       per-tap Gaussians), variance-weighted sector blend (1+σ²)^(-q/2)-style.
 *                       Deterministic per frame ⇒ temporally coherent on video by construction.
 *   tone (full res)     paint buffer upsampled + saturation/contrast punch; final pass, so the
 *                       harness mixes it against the source by uIntensity.
 *
 * Alpha discipline: sample weights are multiplied by source alpha (transparent pixels contribute
 * NOTHING — no dark halos at clip edges), and the output carries the source pixel's own alpha.
 *
 * Encoding note: the tensor rides an RGBA8 target — gx,gy ∈ [-1,1] so gx²,gy² ∈ [0,1] store
 * directly and gx·gy ∈ [-1,1] stores as ·0.5+0.5. The 5×5 blur is affine-safe on that encoding.
 * 8-bit quantizes anisotropy slightly; acceptable for P1 (float targets are a later opt-in).
 */

/** Same shape `builtinFragmentEffectId("stylize")` would produce (not imported — avoids a cycle). */
export const STYLIZE_EFFECT_ID = "builtin.stylize";

const TENSOR_GLSL = `
vec4 effect(vec2 uv) {
  vec2 px = 1.0 / uResolution;
  float tl = _luma(getSrcColor(uv + px * vec2(-1.0,  1.0)).rgb);
  float tc = _luma(getSrcColor(uv + px * vec2( 0.0,  1.0)).rgb);
  float tr = _luma(getSrcColor(uv + px * vec2( 1.0,  1.0)).rgb);
  float ml = _luma(getSrcColor(uv + px * vec2(-1.0,  0.0)).rgb);
  float mr = _luma(getSrcColor(uv + px * vec2( 1.0,  0.0)).rgb);
  float bl = _luma(getSrcColor(uv + px * vec2(-1.0, -1.0)).rgb);
  float bc = _luma(getSrcColor(uv + px * vec2( 0.0, -1.0)).rgb);
  float br = _luma(getSrcColor(uv + px * vec2( 1.0, -1.0)).rgb);
  float gx = (tr + 2.0 * mr + br - tl - 2.0 * ml - bl) * 0.25;
  float gy = (tl + 2.0 * tc + tr - bl - 2.0 * bc - br) * 0.25;
  return vec4(gx * gx, gy * gy, gx * gy * 0.5 + 0.5, 1.0);
}
`;

const TENSOR_BLUR_GLSL = `
vec4 effect(vec2 uv) {
  vec2 px = 1.0 / uResolution;
  vec3 sum = vec3(0.0);
  float wsum = 0.0;
  for (int j = -2; j <= 2; j++) {
    for (int i = -2; i <= 2; i++) {
      float w = exp(-float(i * i + j * j) / 4.0);
      sum += texture(uPass0, uv + px * vec2(float(i), float(j))).rgb * w;
      wsum += w;
    }
  }
  return vec4(sum / wsum, 1.0);
}
`;

const PAINT_GLSL = `
vec4 effect(vec2 uv) {
  // Eigen-frame of the smoothed structure tensor: dir = minor eigenvector (the flow direction),
  // A = anisotropy in [0,1] (0 isotropic, 1 strongly directional).
  vec3 t = texture(uPass0, uv).rgb;
  float E = t.r;
  float G = t.g;
  float F = t.b * 2.0 - 1.0;
  float D = sqrt(max((E - G) * (E - G) + 4.0 * F * F, 0.0));
  float lambda1 = 0.5 * (E + G + D);
  float lambda2 = 0.5 * (E + G - D);
  vec2 ev = vec2(lambda1 - E, -F);
  vec2 dir = (dot(ev, ev) > 1e-8) ? normalize(ev) : vec2(0.0, 1.0);
  float A = (lambda1 + lambda2 > 1e-6) ? (lambda1 - lambda2) / (lambda1 + lambda2) : 0.0;

  // FRAME-RELATIVE radius (2026-07-18, span-proxy report): the radius is defined against a 540px
  // short edge and scales with THIS pass's working resolution — so ½-scale preview, span-proxy
  // renders, and full-res export all paint the SAME picture-space brush. A raw pixel radius made
  // spans diverge from the viewer and the parity self-check (correctly) refused to seal them.
  float shortEdge = min(uResolution.x, uResolution.y);
  float radius = clamp(paintRadius, 1.0, 6.0) * (shortEdge / 540.0);
  radius = clamp(radius, 1.0, 14.0);
  // Area-preserving oriented ellipse (sqrt shaping): tap cost stays ~π·r² regardless of anisotropy
  // and the long axis never exceeds ~1.42·radius — so the DYNAMIC loop bound below is honest (the
  // first cut clamped loops at ±6 while the ellipse could reach 12: silent truncation).
  float stretch = sqrt(1.0 + A);
  float ea = radius * stretch;
  float eb = radius / stretch;
  // Row-major [[cos/a, sin/a], [-sin/b, cos/b]] — maps a pixel offset into the ellipse's unit disc.
  mat2 SR = mat2(dir.x / ea, -dir.y / eb, dir.y / ea, dir.x / eb);
  // Cap is generous (export-res working buffers legitimately need bigger pixel radii); preview cost
  // self-limits because the preview's render scale shrinks shortEdge and the radius with it.
  int radI = int(min(ceil(ea), 20.0));

  vec2 px = 1.0 / uResolution;
  vec4 m[8];
  vec3 s[8];
  for (int k = 0; k < 8; k++) { m[k] = vec4(0.0); s[k] = vec3(0.0); }
  // Rotate the unit-disc sample through the sector frames by repeated 45° rotation — no per-sector
  // trig. 4 rotations cover all 8 sectors: the polynomial is x-symmetric, so sector k+4's weight is
  // the same expression with -q.x (halves the inner loop).
  const mat2 R45 = mat2(0.7071067812, 0.7071067812, -0.7071067812, 0.7071067812);

  // DYNAMIC loop bounds — deliberate (ES 3.0 allows them): constant bounds made ANGLE/D3D fully
  // unroll 169 taps × 8 sectors into a several-thousand-instruction shader — a seconds-long compile
  // hitch + playback crawl (the "stylize freezes the video" report, 2026-07-18). A loop the
  // compiler keeps as a loop compiles instantly and executes only the real taps.
  for (int j = -radI; j <= radI; j++) {
    for (int i = -radI; i <= radI; i++) {
      vec2 p = SR * vec2(float(i), float(j));
      if (dot(p, p) > 1.0) continue;
      vec4 srcPx = getSrcColor(uv + px * vec2(float(i), float(j)));
      vec3 c = srcPx.rgb;
      float aW = srcPx.a; // transparent samples contribute nothing — no edge halos
      vec2 q = p;
      for (int k = 0; k < 4; k++) {
        float wPos = max(0.0, (q.x + 0.33) - 3.77 * q.y * q.y);
        wPos = wPos * wPos * aW;
        m[k] += vec4(c * wPos, wPos);
        s[k] += c * c * wPos;
        float wNeg = max(0.0, (0.33 - q.x) - 3.77 * q.y * q.y);
        wNeg = wNeg * wNeg * aW;
        m[k + 4] += vec4(c * wNeg, wNeg);
        s[k + 4] += c * c * wNeg;
        q = R45 * q;
      }
    }
  }

  // Variance-weighted sector blend: low-variance (flat) sectors dominate — that selection IS the
  // painterly flattening.
  vec4 center = getSrcColor(uv);
  vec3 outC = vec3(0.0);
  float outW = 0.0;
  float sharpQ = clamp(paintSharpness, 1.0, 16.0);
  for (int k = 0; k < 8; k++) {
    float wk = m[k].a;
    if (wk < 1e-5) continue;
    vec3 mean = m[k].rgb / wk;
    vec3 varc = max(s[k] / wk - mean * mean, 0.0);
    float sigma2 = varc.r + varc.g + varc.b;
    float wOut = 1.0 / (1.0 + pow(1000.0 * sigma2, 0.5 * sharpQ));
    outC += mean * wOut;
    outW += wOut;
  }
  vec3 col = (outW > 1e-5) ? outC / outW : center.rgb;
  return vec4(col, center.a);
}
`;

/**
 * Shared eigen-decode snippet for the ink passes: flow = minor eigenvector of the smoothed tensor
 * (the direction ALONG edges), grad = its perpendicular. Kept as a GLSL string both passes embed.
 */
const FLOW_DECODE_GLSL = `
vec2 _flowDir(vec2 uv) {
  vec3 t = texture(uPass0, uv).rgb;
  float E = t.r;
  float G = t.g;
  float F = t.b * 2.0 - 1.0;
  float D = sqrt(max((E - G) * (E - G) + 4.0 * F * F, 0.0));
  float lambda1 = 0.5 * (E + G + D);
  vec2 ev = vec2(lambda1 - E, -F);
  return (dot(ev, ev) > 1e-8) ? normalize(ev) : vec2(0.0, 1.0);
}
`;

// FDoG stage 1 (Kang NPAR'07): a 1-D difference-of-Gaussians PERPENDICULAR to the local edge flow.
// The response is packed bias-scaled (±0.0625 → ±0.5) into an RGBA8 target for stage 2.
const INK_DOG_GLSL = `
${"" /* uPass0 = tensorBlur */}
vec4 effect(vec2 uv) {
  vec2 flow = _flowDir(uv);
  vec2 grad = vec2(-flow.y, flow.x);
  vec2 px = 1.0 / uResolution;
  // Frame-relative line width (same law as the paint radius): defined against a 1080px short edge.
  float sigmaE = max(0.4, inkThickness * (min(uResolution.x, uResolution.y) / 1080.0));
  float sigmaR = sigmaE * 1.6;
  int n = int(min(ceil(sigmaR * 2.5), 10.0));
  float sumE = 0.0;
  float wE = 0.0;
  float sumR = 0.0;
  float wR = 0.0;
  for (int i = -10; i <= 10; i++) {
    if (i < -n || i > n) continue;
    float x = float(i);
    float l = _luma(getSrcColor(uv + grad * px * x).rgb);
    float we = exp(-x * x / (2.0 * sigmaE * sigmaE));
    float wr = exp(-x * x / (2.0 * sigmaR * sigmaR));
    sumE += l * we;
    wE += we;
    sumR += l * wr;
    wR += wr;
  }
  float d = sumE / max(wE, 1e-5) - 0.98 * (sumR / max(wR, 1e-5));
  return vec4(vec3(clamp(d * 8.0 + 0.5, 0.0, 1.0)), 1.0);
}
`;

// FDoG stage 2: smooth the DoG response ALONG the flow (coherent strokes, junk edges die), then the
// XDoG soft threshold → an ink map in [0,1] (0 = full ink). Straight-line flow smoothing is the v1
// approximation of curved LIC — stable and an order cheaper.
const INK_GLSL = `
${"" /* uPass0 = tensorBlur, uPass1 = dog */}
vec4 effect(vec2 uv) {
  vec2 flow = _flowDir(uv);
  vec2 px = 1.0 / uResolution;
  float sum = 0.0;
  float wsum = 0.0;
  for (int i = -4; i <= 4; i++) {
    float x = float(i);
    float v = texture(uPass1, uv + flow * px * x).r - 0.5;
    float w = exp(-x * x / 8.0);
    sum += v * w;
    wsum += w;
  }
  float d = (sum / max(wsum, 1e-5)) / 8.0;
  // XDoG: negative response = edge. Fixed eps/phi tuned for video (soft enough not to shimmer).
  float e = (d >= -0.002) ? 1.0 : 1.0 + tanh(60.0 * (d + 0.002));
  return vec4(vec3(clamp(e, 0.0, 1.0)), 1.0);
}
`;

// Final pass: cel posterize + palette punch + style flavor + ink composite, mixed by uIntensity.
// styleMode: 0 Painterly · 1 Anime Cel · 2 Manga (mono, hard contrast) · 3 Sketch (paper + ink).
const TONE_GLSL = `
${"" /* uPass0 = paint, uPass1 = ink */}
vec4 effect(vec2 uv) {
  vec4 src = getSrcColor(uv);
  vec3 c = texture(uPass0, uv).rgb;
  float mode = floor(styleMode + 0.5);

  // Cel bands (0/1 = off): quantize LUMA and rescale color, with a hair of hash dither on the
  // threshold so gradients don't band-crawl in motion. Deterministic — same everywhere.
  float bands = floor(celBands);
  if (bands >= 2.0) {
    float l = max(_luma(c), 1e-4);
    float dith = (_rand(floor(uv * uResolution)) - 0.5) / max(bands, 2.0) * 0.25;
    float lq = (floor(clamp(l + dith, 0.0, 0.9999) * bands) + 0.5) / bands;
    c *= lq / l;
  }

  float punch = clamp(palettePunch, 0.0, 100.0) / 100.0;
  float l2 = _luma(c);
  c = mix(vec3(l2), c, 1.0 + punch * 0.6);
  c = (c - 0.5) * (1.0 + punch * 0.18) + 0.5;

  if (mode == 2.0) {
    // Manga: mono + hard contrast (screen-tones arrive with the print pass, P3).
    float m = _luma(c);
    c = vec3(clamp((m - 0.5) * 1.35 + 0.55, 0.0, 1.0));
  } else if (mode == 3.0) {
    // Sketch: warm paper faintly tinted by the paint — the ink below carries the drawing.
    c = mix(vec3(0.96, 0.945, 0.915), c, 0.18);
  }

  float ink = texture(uPass1, uv).r;
  c *= mix(1.0, ink, clamp(inkStrength, 0.0, 100.0) / 100.0);
  return vec4(clamp(c, 0.0, 1.0), src.a);
}
`;

export const STYLIZE_PAINTERLY: FragmentEffectDefinition = {
  id: STYLIZE_EFFECT_ID,
  name: "Stylize",
  category: "Stylize",
  params: [
    { name: "paintRadius", type: "float", default: 4, min: 1, max: 6, step: 1, label: "Brush Size" },
    { name: "paintSharpness", type: "float", default: 8, min: 1, max: 16, step: 1, label: "Edge Hardness" },
    { name: "palettePunch", type: "float", default: 35, min: 0, max: 100, step: 1, label: "Color Punch" },
    // P2 (defaults keep the P1 Painterly output byte-stable: no ink, no bands, mode 0).
    { name: "inkStrength", type: "float", default: 0, min: 0, max: 100, step: 1, label: "Ink Lines" },
    { name: "inkThickness", type: "float", default: 2, min: 0.5, max: 4, step: 0.5, label: "Line Weight" },
    { name: "celBands", type: "float", default: 0, min: 0, max: 10, step: 1, label: "Cel Bands" },
    { name: "styleMode", type: "float", default: 0, min: 0, max: 3, step: 1, label: "Style" }
  ],
  glsl: "", // multi-pass definition — `passes` below is the whole effect
  passes: [
    { id: "tensor", scale: 0.5, glsl: TENSOR_GLSL },
    { id: "tensorBlur", scale: 0.5, inputs: ["tensor"], glsl: TENSOR_BLUR_GLSL },
    { id: "paint", scale: 0.5, inputs: ["tensorBlur"], glsl: PAINT_GLSL },
    { id: "dog", inputs: ["tensorBlur"], glsl: FLOW_DECODE_GLSL + INK_DOG_GLSL },
    { id: "ink", inputs: ["tensorBlur", "dog"], glsl: FLOW_DECODE_GLSL + INK_GLSL },
    { id: "tone", inputs: ["paint", "ink"], glsl: TONE_GLSL }
  ]
};
