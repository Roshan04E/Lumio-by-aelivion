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

  // Oriented ellipse: stretched along the flow by anisotropy (GPU Pro shaping, alpha = 1).
  float radius = clamp(paintRadius, 1.0, 6.0);
  float ea = radius * clamp(1.0 + A, 0.1, 2.0);
  float eb = radius * clamp(1.0 / (1.0 + A), 0.1, 2.0);
  // Row-major [[cos/a, sin/a], [-sin/b, cos/b]] — maps a pixel offset into the ellipse's unit disc.
  mat2 SR = mat2(dir.x / ea, -dir.y / eb, dir.y / ea, dir.x / eb);
  int radI = int(ceil(max(ea, eb)));

  vec2 px = 1.0 / uResolution;
  vec4 m[8];
  vec3 s[8];
  for (int k = 0; k < 8; k++) { m[k] = vec4(0.0); s[k] = vec3(0.0); }
  // Rotate the unit-disc sample through the 8 sector frames by repeated 45-degree rotation — the
  // polynomial weight needs no trig per sector.
  const mat2 R45 = mat2(0.7071067812, 0.7071067812, -0.7071067812, 0.7071067812);

  for (int j = -6; j <= 6; j++) {
    for (int i = -6; i <= 6; i++) {
      if (i < -radI || i > radI || j < -radI || j > radI) continue;
      vec2 p = SR * vec2(float(i), float(j));
      if (dot(p, p) > 1.0) continue;
      vec4 srcPx = getSrcColor(uv + px * vec2(float(i), float(j)));
      vec3 c = srcPx.rgb;
      float aW = srcPx.a; // transparent samples contribute nothing — no edge halos
      vec2 q = p;
      for (int k = 0; k < 8; k++) {
        float w = max(0.0, (q.x + 0.33) - 3.77 * q.y * q.y);
        w = w * w * aW;
        m[k] += vec4(c * w, w);
        s[k] += c * c * w;
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

const TONE_GLSL = `
vec4 effect(vec2 uv) {
  vec4 src = getSrcColor(uv);
  vec3 c = texture(uPass0, uv).rgb;
  float punch = clamp(palettePunch, 0.0, 100.0) / 100.0;
  float l = _luma(c);
  c = mix(vec3(l), c, 1.0 + punch * 0.6);      // saturation push toward "flat illustrated color"
  c = (c - 0.5) * (1.0 + punch * 0.18) + 0.5;  // gentle contrast
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
    { name: "palettePunch", type: "float", default: 35, min: 0, max: 100, step: 1, label: "Color Punch" }
  ],
  glsl: "", // multi-pass definition — `passes` below is the whole effect
  passes: [
    { id: "tensor", scale: 0.5, glsl: TENSOR_GLSL },
    { id: "tensorBlur", scale: 0.5, inputs: ["tensor"], glsl: TENSOR_BLUR_GLSL },
    { id: "paint", scale: 0.5, inputs: ["tensorBlur"], glsl: PAINT_GLSL },
    { id: "tone", inputs: ["paint"], glsl: TONE_GLSL }
  ]
};
