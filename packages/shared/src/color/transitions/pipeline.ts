/**
 * Modular GPU Transition Pipeline — types + atomic shader module library.
 *
 * Instead of a single monolith fragment shader, complex ("professional") transitions are defined as a
 * SEQUENCE of passes. Each pass runs one atomic module (a `vec4 passMain(vec2 uv)` GLSL body) with the
 * standard transition harness (see `pipeline-assembler.ts`): `uFrom`/`uTo` are the two pre-composed
 * sides, `uSrc` is the PREVIOUS pass's output (ping-ponged by the executor — `getSrcColor(uv)`), and
 * `progress`/`resolution`/`ratio` plus the definition's params are uniforms. The executor lives in
 * `SceneCompositor.drawTransitionPipeline` (all scene-path renderers) — the same assembled GLSL and the
 * same pass order everywhere keeps preview/export pixel-identical.
 *
 * Hard rules (same as registry.ts): bodies operate in sRGB output space (no linear round-trips), uv
 * (0,0) = bottom-left. Every module must be a real algorithm — no CSS-fake shortcuts.
 */

export type TransitionPassModuleId =
  | "sample-source"    // Basic texture sampling (pass-through / side pick)
  | "sample-mask"      // AI/Procedural mask-weighted composite
  | "radial-warp"      // Spherical/Cylindrical distortion
  | "perspective-warp" // 4-point corner pin
  | "curl-noise"       // Fluid-like displacement
  | "gaussian-blur"    // One-axis Gaussian (chain two passes for full blur)
  | "directional-blur" // Motion smear
  | "luma-mix"         // Luminance-weighted composite
  | "linear-mix"       // Standard blend
  | "additive-mix"     // Light leak / glow blend
  | "chromatic-split"  // RGB offset
  | "bokeh-blur";      // Physical lens blur (disc kernel, highlight-weighted)

export interface TransitionPass {
  /** The atomic shader module to execute. */
  moduleId: TransitionPassModuleId;
  /** Which textures the pass reads, for documentation ("uFrom", "uTo", "uSrc" = previous pass). */
  inputs: string[];
  /** Pass-specific static param values (uniform name → value; override the def's resolved params). */
  params?: Record<string, number | number[] | boolean>;
}

export interface TransitionPipeline {
  /** The sequence of passes to execute. The last pass's output is the transition result. */
  passes: TransitionPass[];
}

/**
 * Atomic module library. Each module defines `vec4 passMain(vec2 uv)` and may declare extra uniforms
 * (deduped against the standard harness set at assembly). Helpers available: getFromColor/getToColor
 * (fit-corrected sides), getSrcColor (previous pass), _rand/_luma/_scaleUV/_rotUV/_inside, progress,
 * resolution, ratio.
 */
export const ATOMIC_MODULES: Record<TransitionPassModuleId, {
  glsl: string;
  uniforms: string[];
}> = {
  "sample-source": {
    uniforms: ["float uPickTo"],
    glsl: `vec4 passMain(vec2 uv) {
      // Base pass: seed the chain with one side (uPickTo=1 → incoming, else outgoing).
      return uPickTo > 0.5 ? getToColor(uv) : getFromColor(uv);
    }`
  },
  "linear-mix": {
    uniforms: [],
    glsl: `vec4 passMain(vec2 uv) {
      // Mix the RUNNING image (usually a warped/blurred outgoing chain) toward the incoming side.
      return mix(getSrcColor(uv), getToColor(uv), progress);
    }`
  },
  "luma-mix": {
    uniforms: ["float uLumaSoftness"],
    glsl: `vec4 passMain(vec2 uv) {
      vec4 a = getSrcColor(uv);
      vec4 b = getToColor(uv);
      float soft = max(uLumaSoftness, 0.02);
      float l = _luma(a.rgb);
      float p = progress * (1.0 + 2.0 * soft) - soft;
      float mt = smoothstep(p - soft, p + soft, l); // brighter areas reveal first
      return mix(a, b, mix(progress, mt, 0.85));
    }`
  },
  "additive-mix": {
    uniforms: ["vec3 uAddColor", "float uAddStrength"],
    glsl: `vec4 passMain(vec2 uv) {
      // Additive energy peaking at the cut (light leak / flash core).
      vec4 base = getSrcColor(uv);
      float env = 1.0 - abs(progress - 0.5) * 2.0;
      float e = pow(clamp(env, 0.0, 1.0), 1.5) * uAddStrength;
      return vec4(base.rgb + uAddColor * e, base.a);
    }`
  },
  "sample-mask": {
    uniforms: ["sampler2D uMaskTex", "float uMaskFeather", "float uMaskInvert"],
    glsl: `vec4 passMain(vec2 uv) {
      // Mask-driven reveal: the matte's alpha (e.g. an AI subject mask) gates the incoming side.
      // Feather widens the reveal band around the progress threshold for a soft organic edge.
      float m = texture(uMaskTex, clamp(uv, 0.0, 1.0)).a;
      if (uMaskInvert > 0.5) m = 1.0 - m;
      float soft = max(uMaskFeather, 0.001);
      float p = progress * (1.0 + 2.0 * soft) - soft;
      float mt = smoothstep(p - soft, p + soft, 1.0 - m);
      return mix(getToColor(uv), getSrcColor(uv), mt);
    }`
  },
  "radial-warp": {
    uniforms: ["float uWarpStrength", "vec2 uWarpCenter"],
    glsl: `vec4 passMain(vec2 uv) {
      // Barrel/pincushion distortion about a center, strength peaking at the cut. Positive strength
      // bulges outward (sphere), negative sucks inward (portal). Aspect-corrected so the warp is round.
      vec2 c = uv - uWarpCenter;
      c.x *= ratio;
      float d = length(c);
      float env = 1.0 - abs(progress - 0.5) * 2.0;
      float k = uWarpStrength * env;
      float f = 1.0 + k * d * d;
      vec2 warped = uWarpCenter + vec2(c.x / ratio, c.y) / max(f, 1e-4);
      return getSrcColor(warped);
    }`
  },
  "perspective-warp": {
    uniforms: ["vec2 uTL", "vec2 uTR", "vec2 uBL", "vec2 uBR"],
    glsl: `vec4 passMain(vec2 uv) {
      // 4-point corner pin (bilinear patch, animated toward identity by progress): the running image
      // is drawn as if its corners moved to uTL/uTR/uBL/uBR (unit space, bottom-left origin).
      float t = 1.0 - progress;
      vec2 tl = mix(vec2(0.0, 1.0), uTL, t);
      vec2 tr = mix(vec2(1.0, 1.0), uTR, t);
      vec2 bl = mix(vec2(0.0, 0.0), uBL, t);
      vec2 br = mix(vec2(1.0, 0.0), uBR, t);
      // Invert the bilinear map numerically (fixed-point iterations are stable for mild pins).
      vec2 g = uv;
      for (int i = 0; i < 6; i++) {
        vec2 bottom = mix(bl, br, g.x);
        vec2 top = mix(tl, tr, g.x);
        vec2 mapped = mix(bottom, top, g.y);
        g += uv - mapped;
      }
      return _inside(g) ? getSrcColor(g) : vec4(0.0);
    }`
  },
  "curl-noise": {
    uniforms: ["float uCurlScale", "float uCurlStrength", "float uCurlSpeed"],
    glsl: `
    // Gradient-noise potential; its perpendicular gradient (curl) is divergence-free → fluid-like flow.
    float _pnoise(vec2 p) {
      vec2 i = floor(p);
      vec2 f = fract(p);
      vec2 u = f * f * (3.0 - 2.0 * f);
      float a = _rand(i);
      float b = _rand(i + vec2(1.0, 0.0));
      float c = _rand(i + vec2(0.0, 1.0));
      float d = _rand(i + vec2(1.0, 1.0));
      return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
    }
    vec2 _curl(vec2 p) {
      const float e = 0.01;
      float dx = _pnoise(p + vec2(0.0, e)) - _pnoise(p - vec2(0.0, e));
      float dy = _pnoise(p + vec2(e, 0.0)) - _pnoise(p - vec2(e, 0.0));
      return vec2(dx, -dy) / (2.0 * e);
    }
    vec4 passMain(vec2 uv) {
      float env = 1.0 - abs(progress - 0.5) * 2.0;
      vec2 p = uv * max(uCurlScale, 0.1) + progress * uCurlSpeed;
      vec2 flow = _curl(p) * uCurlStrength * env * 0.05;
      return getSrcColor(uv + flow);
    }`
  },
  "gaussian-blur": {
    uniforms: ["vec2 uBlurDir", "float uBlurAmount"],
    glsl: `vec4 passMain(vec2 uv) {
      // One-axis Gaussian, radius animated by the cut envelope. Chain an X pass then a Y pass for a
      // full separable blur (uBlurDir = [1,0] then [0,1]).
      float env = 1.0 - abs(progress - 0.5) * 2.0;
      float sigmaPx = max(uBlurAmount * env * 0.02 * resolution.y, 0.001);
      vec2 stepUv = uBlurDir / resolution;
      float twoSigma2 = 2.0 * sigmaPx * sigmaPx;
      vec4 acc = vec4(0.0);
      float wsum = 0.0;
      for (int i = -12; i <= 12; i++) {
        float fi = float(i) * max(sigmaPx / 4.0, 1.0);
        float wt = exp(-(fi * fi) / twoSigma2);
        acc += getSrcColor(uv + stepUv * fi) * wt;
        wsum += wt;
      }
      return acc / max(wsum, 1e-6);
    }`
  },
  "directional-blur": {
    uniforms: ["vec2 uSmearDir", "float uSmearAmount"],
    glsl: `vec4 passMain(vec2 uv) {
      // Motion smear along a direction, velocity peaking at the cut (the whip-pan streak).
      vec2 d = normalize(uSmearDir + 1e-5);
      float env = sin(clamp(progress, 0.0, 1.0) * 3.14159265);
      float len = uSmearAmount * env * 0.25;
      vec4 acc = vec4(0.0);
      const int N = 16;
      for (int i = 0; i < N; i++) {
        float k = (float(i) / float(N - 1)) - 0.5;
        acc += getSrcColor(uv + d * k * len);
      }
      return acc / float(N);
    }`
  },
  "chromatic-split": {
    uniforms: ["float uSplitAmount", "vec2 uSplitDir"],
    glsl: `vec4 passMain(vec2 uv) {
      // RGB channel offset along a direction, peaking at the cut (lens dispersion / glitch fringe).
      vec2 d = normalize(uSplitDir + 1e-5);
      float env = 1.0 - abs(progress - 0.5) * 2.0;
      vec2 off = d * uSplitAmount * env * 0.02;
      vec4 base = getSrcColor(uv);
      float r = getSrcColor(uv + off).r;
      float b = getSrcColor(uv - off).b;
      return vec4(r, base.g, b, base.a);
    }`
  },
  "bokeh-blur": {
    uniforms: ["float uBokehRadius", "float uBokehHighlight"],
    glsl: `vec4 passMain(vec2 uv) {
      // Physical lens blur: disc (iris) kernel with highlight weighting — bright points bloom into
      // discs instead of washing out like a Gaussian. Radius animated by the cut envelope (focus pull).
      float env = 1.0 - abs(progress - 0.5) * 2.0;
      float radius = uBokehRadius * env * 0.03;
      if (radius < 1e-4) return getSrcColor(uv);
      vec3 acc = vec3(0.0);
      float wsum = 0.0;
      const int RINGS = 4;
      const int SEGS = 8;
      for (int r = 1; r <= RINGS; r++) {
        float rr = radius * float(r) / float(RINGS);
        for (int s = 0; s < SEGS; s++) {
          float ang = 6.2831853 * (float(s) + 0.5 * float(r)) / float(SEGS);
          vec2 off = vec2(cos(ang) / ratio, sin(ang)) * rr;
          vec3 c = getSrcColor(uv + off).rgb;
          // Highlight weighting: brighter samples dominate the disc (the bokeh look).
          float wt = 1.0 + pow(_luma(c), 4.0) * uBokehHighlight * 8.0;
          acc += c * wt;
          wsum += wt;
        }
      }
      vec3 center = getSrcColor(uv).rgb;
      float cw = 1.0 + pow(_luma(center), 4.0) * uBokehHighlight * 8.0;
      acc += center * cw;
      wsum += cw;
      return vec4(acc / max(wsum, 1e-6), getSrcColor(uv).a);
    }`
  },
};
