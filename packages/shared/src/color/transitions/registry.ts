/**
 * Unified GPU transition engine — registry + shader assembler.
 *
 * Every transition is a GL-Transitions–style fragment body `vec4 transition(vec2 uv)` that samples
 * `getFromColor(uv)` (outgoing clip, already graded) and `getToColor(uv)` (incoming clip, already
 * graded) by `progress` (0→1, ALREADY EASED by the caller) plus named params. `buildTransitionFragmentShader`
 * wraps a definition in the standard `#version 300 es` harness so the SAME assembled GLSL is compiled by
 * all three renderers (web preview, browser export, Remotion) → pixel-identical output.
 *
 * Hard rule: bodies operate in the renderer's sRGB OUTPUT space (the space the per-clip canvases already
 * composite in). Do NOT add pow(2.2) linear round-trips, or preview and export diverge.
 *
 * UV convention matches `MediaWebGLRenderer`: uv (0,0) = bottom-left, (1,1) = top-left,
 * with sources uploaded UNPACK_FLIP_Y=true — so upstream gl-transition bodies port over verbatim.
 */

export type TransitionParamType = "float" | "vec2" | "vec3" | "bool";

export interface TransitionParam {
  /** GLSL uniform name (also the key in TransitionSpec.params). */
  name: string;
  type: TransitionParamType;
  default: number | number[] | boolean;
  /** UI hints (float only). */
  min?: number;
  max?: number;
  step?: number;
  label?: string;
}

export type TransitionCategory = "basic" | "creator" | "cinematic" | "glitch" | "mask";

export type TransitionEasing = "linear" | "easeIn" | "easeOut" | "easeInOut";

export interface TransitionDefinition {
  /** Stable id — this is what `TransitionSpec.kind` stores (the manifest contract). */
  id: string;
  name: string;
  category: TransitionCategory;
  defaultDurationSeconds: number;
  /** Default easing applied to the linear time progress before it reaches the shader. */
  easing: TransitionEasing;
  params: TransitionParam[];
  /** The body: must define `vec4 transition(vec2 uv) { ... }`. */
  glsl: string;
}

/** Apply a definition's easing curve to a linear 0..1 progress. Shared by all renderers. */
export function applyTransitionEasing(progress: number, easing: TransitionEasing): number {
  const t = Math.max(0, Math.min(1, progress));
  switch (easing) {
    case "easeIn":
      return t * t * t;
    case "easeOut":
      return 1 - Math.pow(1 - t, 3);
    case "easeInOut":
      return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    case "linear":
    default:
      return t;
  }
}

const GLSL_TYPE: Record<TransitionParamType, string> = {
  float: "float",
  vec2: "vec2",
  vec3: "vec3",
  bool: "bool"
};

/**
 * Shared GLSL prelude available to every transition body: aspect-correct scale/rotate helpers,
 * a cheap hash, and a luma helper. Keeping these here means bodies stay tiny and consistent.
 */
const HARNESS_PRELUDE = `
// Object-fit UV remap: scales uv about the centre so each clip is sampled exactly as it renders normally
// (cover/contain/fill). uFromFit/uToFit = [1,1] is a no-op (fill). Keeps the transition geometry identical to
// the clip's own object-fit so there is no squeeze/jump at the window boundary.
vec2 _fitUv(vec2 uv, vec2 s){ return (uv - 0.5) * s + 0.5; }
vec4 getFromColor(vec2 uv){ return texture(uFrom, clamp(_fitUv(uv, uFromFit), 0.0, 1.0)); }
vec4 getToColor(vec2 uv){ return texture(uTo, clamp(_fitUv(uv, uToFit), 0.0, 1.0)); }

float _rand(vec2 co){ return fract(sin(dot(co.xy, vec2(12.9898, 78.233))) * 43758.5453); }
float _luma(vec3 c){ return dot(c, vec3(0.299, 0.587, 0.114)); }
// Scale about centre (s>1 → zoom in).
vec2 _scaleUV(vec2 uv, float s){ return (uv - 0.5) / max(s, 1e-4) + 0.5; }
// Rotate about centre, aspect-corrected so circles stay circular.
vec2 _rotUV(vec2 uv, float ang){
  vec2 p = uv - 0.5; p.x *= ratio;
  float c = cos(ang), s = sin(ang);
  p = mat2(c, -s, s, c) * p;
  p.x /= ratio;
  return p + 0.5;
}
bool _inside(vec2 uv){ return uv.x >= 0.0 && uv.x <= 1.0 && uv.y >= 0.0 && uv.y <= 1.0; }
`;

function paramUniformLines(params: TransitionParam[]): string {
  return params.map((p) => `uniform ${GLSL_TYPE[p.type]} ${p.name};`).join("\n");
}

const shaderCache = new Map<string, string>();

/** Assemble the full fragment shader for a definition. Memoized by id (definitions are static). */
export function buildTransitionFragmentShader(def: TransitionDefinition): string {
  const cached = shaderCache.get(def.id);
  if (cached) return cached;
  const src = `#version 300 es
precision highp float;
precision highp sampler2D;

in vec2 v_uv;
out vec4 fragColor;

uniform sampler2D uFrom;   // outgoing clip, graded
uniform sampler2D uTo;     // incoming clip, graded
uniform float progress;    // 0..1, already eased
uniform vec2 resolution;
uniform float ratio;       // resolution.x / resolution.y
uniform vec2 uFromFit;     // object-fit uv scale for the outgoing texture (cover/contain/fill)
uniform vec2 uToFit;       // object-fit uv scale for the incoming texture
${paramUniformLines(def.params)}
${HARNESS_PRELUDE}
${def.glsl}

void main(){ fragColor = transition(v_uv); }
`;
  shaderCache.set(def.id, src);
  return src;
}

// ---------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------

const registry = new Map<string, TransitionDefinition>();

export function registerTransition(def: TransitionDefinition): void {
  registry.set(def.id, def);
}

export function getTransition(id: string): TransitionDefinition | undefined {
  return registry.get(id);
}

export function listTransitions(): TransitionDefinition[] {
  return [...registry.values()];
}

export function listTransitionsByCategory(category: TransitionCategory): TransitionDefinition[] {
  return listTransitions().filter((d) => d.category === category);
}

const DIR_RIGHT: TransitionParam = { name: "direction", type: "vec2", default: [1, 0], label: "Direction" };
const SOFTNESS: TransitionParam = { name: "softness", type: "float", default: 0.12, min: 0, max: 0.5, label: "Softness" };

const DEFS: TransitionDefinition[] = [
  // ---- Basic (migrated from the old split engine) ----
  {
    id: "crossDissolve",
    name: "Cross Dissolve",
    category: "basic",
    defaultDurationSeconds: 0.5,
    easing: "easeInOut",
    params: [],
    glsl: `vec4 transition(vec2 uv){ return mix(getFromColor(uv), getToColor(uv), progress); }`
  },
  {
    id: "dip",
    name: "Dip to Color",
    category: "basic",
    defaultDurationSeconds: 0.6,
    easing: "easeInOut",
    params: [{ name: "dipColor", type: "vec3", default: [0, 0, 0], label: "Color" }],
    glsl: `vec4 transition(vec2 uv){
      vec4 a = getFromColor(uv);
      vec4 b = getToColor(uv);
      vec4 c = vec4(dipColor, 1.0);
      if (progress < 0.5) return mix(a, c, clamp(progress * 2.0, 0.0, 1.0));
      return mix(c, b, clamp((progress - 0.5) * 2.0, 0.0, 1.0));
    }`
  },
  {
    id: "wipe",
    name: "Wipe",
    category: "basic",
    defaultDurationSeconds: 0.5,
    easing: "easeInOut",
    params: [DIR_RIGHT, SOFTNESS],
    glsl: `vec4 transition(vec2 uv){
      vec2 d = normalize(direction + 1e-5);
      float s = dot(uv - 0.5, d) + 0.5;
      float soft = max(softness, 0.001);
      float p = progress * (1.0 + 2.0 * soft) - soft;
      float mt = 1.0 - smoothstep(p - soft, p + soft, s);
      return mix(getFromColor(uv), getToColor(uv), mt);
    }`
  },
  {
    id: "iris",
    name: "Iris",
    category: "basic",
    defaultDurationSeconds: 0.6,
    easing: "easeInOut",
    params: [SOFTNESS, { name: "reverse", type: "bool", default: false, label: "Shrink" }],
    glsl: `vec4 transition(vec2 uv){
      vec2 c = (uv - 0.5); c.x *= ratio;
      float dist = length(c);
      float maxR = length(vec2(0.5 * ratio, 0.5));
      float soft = max(softness, 0.001) * maxR;
      float r = (reverse ? (1.0 - progress) : progress) * (maxR + soft);
      float inCircle = 1.0 - smoothstep(r - soft, r + soft, dist);
      float mt = reverse ? (1.0 - inCircle) : inCircle;
      return mix(getFromColor(uv), getToColor(uv), mt);
    }`
  },
  {
    id: "slide",
    name: "Slide",
    category: "basic",
    defaultDurationSeconds: 0.5,
    easing: "easeInOut",
    params: [DIR_RIGHT],
    glsl: `vec4 transition(vec2 uv){
      vec2 d = normalize(direction + 1e-5);
      vec2 toUV = uv - d * (1.0 - progress);
      vec4 fromC = getFromColor(uv);
      if (_inside(toUV)) return getToColor(toUV);
      return fromC;
    }`
  },
  {
    id: "push",
    name: "Push",
    category: "basic",
    defaultDurationSeconds: 0.5,
    easing: "easeInOut",
    params: [DIR_RIGHT],
    glsl: `vec4 transition(vec2 uv){
      vec2 d = normalize(direction + 1e-5);
      vec4 fromC = getFromColor(uv + d * progress);
      vec4 toC = getToColor(uv - d * (1.0 - progress));
      return _inside(uv - d * (1.0 - progress)) ? toC : fromC;
    }`
  },
  {
    id: "zoom",
    name: "Zoom",
    category: "basic",
    defaultDurationSeconds: 0.5,
    easing: "easeInOut",
    params: [{ name: "reverse", type: "bool", default: false, label: "Zoom out" }],
    glsl: `vec4 transition(vec2 uv){
      float sFrom = reverse ? (1.0 - 0.3 * progress) : (1.0 + 0.3 * progress);
      float sTo = reverse ? mix(0.7, 1.0, progress) : mix(1.3, 1.0, progress);
      vec4 a = getFromColor(_scaleUV(uv, sFrom));
      vec4 b = getToColor(_scaleUV(uv, sTo));
      return mix(a, b, smoothstep(0.0, 1.0, progress));
    }`
  },

  // ---- Creator pack ----
  {
    id: "punchZoom",
    name: "Punch Zoom",
    category: "creator",
    defaultDurationSeconds: 0.4,
    easing: "easeInOut",
    params: [
      { name: "strength", type: "float", default: 0.6, min: 0.1, max: 1.5, label: "Strength" },
      { name: "motionBlur", type: "float", default: 0.5, min: 0, max: 1, label: "Motion blur" }
    ],
    glsl: `vec4 transition(vec2 uv){
      float t = progress;
      float zoomA = 1.0 + strength * t;            // outgoing punches in
      float zoomB = 1.0 + strength * (1.0 - t);    // incoming starts punched, settles
      const int N = 10;
      vec4 a = vec4(0.0); vec4 b = vec4(0.0);
      for (int i = 0; i < N; i++){
        float k = float(i) / float(N - 1);
        float bl = 1.0 + motionBlur * 0.35 * k;
        a += getFromColor(_scaleUV(uv, zoomA * bl));
        b += getToColor(_scaleUV(uv, zoomB * bl));
      }
      a /= float(N); b /= float(N);
      return mix(a, b, smoothstep(0.4, 0.6, t));
    }`
  },
  {
    id: "zoomBlur",
    name: "Smooth Zoom Blur",
    category: "creator",
    defaultDurationSeconds: 0.6,
    easing: "easeInOut",
    params: [
      { name: "strength", type: "float", default: 0.35, min: 0.1, max: 1.0, label: "Strength" },
      { name: "rotation", type: "float", default: 0.0, min: -1, max: 1, label: "Rotation" }
    ],
    glsl: `vec4 transition(vec2 uv){
      float t = progress;
      const int N = 12;
      vec4 a = vec4(0.0); vec4 b = vec4(0.0);
      for (int i = 0; i < N; i++){
        float k = float(i) / float(N - 1);
        float za = 1.0 + strength * t * k;
        float zb = 1.0 + strength * (1.0 - t) * k;
        float ang = rotation * (t) * (k - 0.5) * 0.6;
        a += getFromColor(_rotUV(_scaleUV(uv, za), ang));
        b += getToColor(_rotUV(_scaleUV(uv, zb), -ang));
      }
      a /= float(N); b /= float(N);
      return mix(a, b, smoothstep(0.0, 1.0, t));
    }`
  },
  {
    id: "whipPan",
    name: "Whip Pan",
    category: "creator",
    defaultDurationSeconds: 0.35,
    easing: "easeInOut",
    params: [
      DIR_RIGHT,
      { name: "blur", type: "float", default: 0.6, min: 0, max: 1, label: "Blur" }
    ],
    glsl: `vec4 transition(vec2 uv){
      vec2 d = normalize(direction + 1e-5);
      float t = progress;
      // velocity peaks at the cut → strongest directional blur in the middle
      float vel = sin(t * 3.14159265) * blur * 0.5;
      const int N = 10;
      vec4 a = vec4(0.0); vec4 b = vec4(0.0);
      for (int i = 0; i < N; i++){
        float k = (float(i) / float(N - 1)) - 0.5;
        vec2 off = d * vel * k;
        a += getFromColor(uv + d * t + off);
        b += getToColor(uv - d * (1.0 - t) + off);
      }
      a /= float(N); b /= float(N);
      return mix(a, b, smoothstep(0.45, 0.55, t));
    }`
  },
  {
    id: "blurSwipe",
    name: "Blur Swipe",
    category: "creator",
    defaultDurationSeconds: 0.5,
    easing: "easeInOut",
    params: [DIR_RIGHT, { name: "blur", type: "float", default: 0.5, min: 0, max: 1, label: "Blur" }],
    glsl: `vec4 transition(vec2 uv){
      vec2 d = normalize(direction + 1e-5);
      float s = dot(uv - 0.5, d) + 0.5;
      float soft = 0.25;
      float p = progress * (1.0 + 2.0 * soft) - soft;
      float mt = 1.0 - smoothstep(p - soft, p + soft, s);
      float edge = (1.0 - abs(s - p) / soft);
      float bl = clamp(edge, 0.0, 1.0) * blur * 0.04;
      const int N = 8;
      vec4 a = vec4(0.0); vec4 b = vec4(0.0);
      for (int i = 0; i < N; i++){
        float k = (float(i) / float(N - 1)) - 0.5;
        a += getFromColor(uv + d * k * bl);
        b += getToColor(uv + d * k * bl);
      }
      a /= float(N); b /= float(N);
      return mix(a, b, mt);
    }`
  },
  {
    id: "flash",
    name: "Flash",
    category: "creator",
    defaultDurationSeconds: 0.3,
    easing: "linear",
    params: [
      { name: "flashColor", type: "vec3", default: [1, 1, 1], label: "Color" },
      { name: "intensity", type: "float", default: 1.0, min: 0, max: 1, label: "Intensity" }
    ],
    glsl: `vec4 transition(vec2 uv){
      vec4 a = getFromColor(uv);
      vec4 b = getToColor(uv);
      vec4 base = mix(a, b, smoothstep(0.35, 0.65, progress));
      float flash = (1.0 - abs(progress - 0.5) * 2.0);   // peaks at cut
      flash = pow(clamp(flash, 0.0, 1.0), 1.5) * intensity;
      return mix(base, vec4(flashColor, 1.0), flash);
    }`
  },
  {
    id: "shake",
    name: "Camera Shake",
    category: "creator",
    defaultDurationSeconds: 0.4,
    easing: "linear",
    params: [{ name: "amount", type: "float", default: 0.5, min: 0, max: 1, label: "Amount" }],
    glsl: `vec4 transition(vec2 uv){
      float env = (1.0 - abs(progress - 0.5) * 2.0);   // shake peaks at the cut
      float a1 = amount * 0.04 * env;
      vec2 j = vec2(
        sin(progress * 90.0) * a1,
        cos(progress * 78.0) * a1
      );
      vec4 a = getFromColor(uv + j);
      vec4 b = getToColor(uv + j);
      return mix(a, b, smoothstep(0.45, 0.55, progress));
    }`
  },
  {
    id: "spin",
    name: "Spin",
    category: "creator",
    defaultDurationSeconds: 0.5,
    easing: "easeInOut",
    params: [
      { name: "turns", type: "float", default: 1.0, min: 0.25, max: 3, label: "Turns" },
      { name: "zoom", type: "float", default: 0.4, min: 0, max: 1, label: "Zoom" }
    ],
    glsl: `vec4 transition(vec2 uv){
      float t = progress;
      float angA = turns * 6.2831853 * t;
      float angB = -turns * 6.2831853 * (1.0 - t);
      float zA = 1.0 + zoom * t;
      float zB = 1.0 + zoom * (1.0 - t);
      vec4 a = getFromColor(_rotUV(_scaleUV(uv, zA), angA));
      vec4 b = getToColor(_rotUV(_scaleUV(uv, zB), angB));
      return mix(a, b, smoothstep(0.4, 0.6, t));
    }`
  },

  // ---- Cinematic ----
  {
    id: "lumaFade",
    name: "Luma Fade",
    category: "cinematic",
    defaultDurationSeconds: 0.8,
    easing: "easeInOut",
    params: [{ name: "softness", type: "float", default: 0.2, min: 0.02, max: 0.6, label: "Softness" }],
    glsl: `vec4 transition(vec2 uv){
      vec4 a = getFromColor(uv);
      vec4 b = getToColor(uv);
      float l = _luma(a.rgb);
      float soft = max(softness, 0.02);
      float p = progress * (1.0 + 2.0 * soft) - soft;
      float mt = smoothstep(p - soft, p + soft, l);   // brighter areas reveal first
      mt = mix(progress, mt, 0.85);
      return mix(a, b, mt);
    }`
  },
  {
    id: "lightLeak",
    name: "Light Leak",
    category: "cinematic",
    defaultDurationSeconds: 0.8,
    easing: "easeInOut",
    params: [
      { name: "leakColor", type: "vec3", default: [1.0, 0.6, 0.2], label: "Leak color" },
      { name: "intensity", type: "float", default: 0.8, min: 0, max: 1.5, label: "Intensity" }
    ],
    glsl: `vec4 transition(vec2 uv){
      vec4 a = getFromColor(uv);
      vec4 b = getToColor(uv);
      vec4 base = mix(a, b, smoothstep(0.3, 0.7, progress));
      float env = (1.0 - abs(progress - 0.5) * 2.0);
      // soft diagonal bloom sweeping across the frame
      float sweep = dot(uv, normalize(vec2(0.7, 0.3)));
      float band = exp(-pow((sweep - progress) * 3.0, 2.0));
      float leak = (band * 0.7 + env * 0.5) * intensity;
      vec3 col = base.rgb + leakColor * leak;
      return vec4(col, base.a);
    }`
  },
  {
    id: "filmBurn",
    name: "Film Burn",
    category: "cinematic",
    defaultDurationSeconds: 0.7,
    easing: "easeInOut",
    params: [{ name: "intensity", type: "float", default: 1.0, min: 0, max: 1.5, label: "Intensity" }],
    glsl: `vec4 transition(vec2 uv){
      vec4 a = getFromColor(uv);
      vec4 b = getToColor(uv);
      float n = _rand(floor(uv * 48.0) + floor(progress * 6.0));
      float burnEdge = progress * 1.3 - 0.15;
      float d = distance(uv, vec2(0.5)) * 0.7 + n * 0.25;
      float reveal = smoothstep(burnEdge - 0.12, burnEdge + 0.12, 1.0 - d);
      float hot = exp(-pow((1.0 - d - burnEdge) * 7.0, 2.0)) * intensity;
      vec3 ember = mix(vec3(1.0, 0.5, 0.1), vec3(1.0, 0.9, 0.4), n);
      vec3 col = mix(a.rgb, b.rgb, reveal) + ember * hot;
      return vec4(col, 1.0);
    }`
  },
  {
    id: "parallaxPush",
    name: "3D Parallax Push",
    category: "cinematic",
    defaultDurationSeconds: 0.6,
    easing: "easeInOut",
    params: [
      DIR_RIGHT,
      { name: "depth", type: "float", default: 0.15, min: 0, max: 0.4, label: "Depth" }
    ],
    glsl: `vec4 transition(vec2 uv){
      vec2 d = normalize(direction + 1e-5);
      // outgoing recedes (scales down + drifts), incoming pushes in from the front
      vec2 fromUV = _scaleUV(uv + d * progress * 0.6, 1.0 - depth * progress);
      vec2 toUV = _scaleUV(uv - d * (1.0 - progress), 1.0 + depth * (1.0 - progress));
      vec4 fromC = getFromColor(fromUV);
      if (_inside(uv - d * (1.0 - progress))) {
        return getToColor(toUV);
      }
      return fromC;
    }`
  },

  // ---- Glitch ----
  {
    id: "glitch",
    name: "Glitch",
    category: "glitch",
    defaultDurationSeconds: 0.4,
    easing: "linear",
    params: [
      { name: "rgbSplit", type: "float", default: 0.5, min: 0, max: 1, label: "RGB split" },
      { name: "slices", type: "float", default: 0.6, min: 0, max: 1, label: "Slices" }
    ],
    glsl: `vec4 transition(vec2 uv){
      float env = (1.0 - abs(progress - 0.5) * 2.0);
      float blocks = floor(uv.y * mix(8.0, 32.0, slices));
      float jitter = (_rand(vec2(blocks, floor(progress * 24.0))) - 0.5) * env * slices * 0.2;
      vec2 g = vec2(jitter, 0.0);
      float split = rgbSplit * env * 0.04;
      float mid = smoothstep(0.4, 0.6, progress);
      vec2 base = uv + g;
      vec4 src = mix(getFromColor(base), getToColor(base), mid);
      float r = mix(getFromColor(base + vec2(split, 0.0)).r, getToColor(base + vec2(split, 0.0)).r, mid);
      float bch = mix(getFromColor(base - vec2(split, 0.0)).b, getToColor(base - vec2(split, 0.0)).b, mid);
      float scan = 0.9 + 0.1 * sin(uv.y * resolution.y * 1.5);
      return vec4(vec3(r, src.g, bch) * scan, 1.0);
    }`
  },
  {
    id: "pixelate",
    name: "Pixelate",
    category: "glitch",
    defaultDurationSeconds: 0.5,
    easing: "easeInOut",
    params: [{ name: "blocks", type: "float", default: 0.5, min: 0.1, max: 1, label: "Coarseness" }],
    glsl: `vec4 transition(vec2 uv){
      float env = (1.0 - abs(progress - 0.5) * 2.0);
      float minCells = mix(120.0, 12.0, blocks);
      float cells = mix(resolution.x, minCells, env);
      vec2 px = vec2(cells, cells / max(ratio, 1e-4));
      vec2 q = (floor(uv * px) + 0.5) / px;
      return mix(getFromColor(q), getToColor(q), smoothstep(0.4, 0.6, progress));
    }`
  },

  // ---- Mask ----
  {
    id: "maskReveal",
    name: "Shape Reveal",
    category: "mask",
    defaultDurationSeconds: 0.6,
    easing: "easeInOut",
    params: [
      { name: "shape", type: "float", default: 0, min: 0, max: 2, step: 1, label: "Shape (0 circle,1 box,2 diamond)" },
      SOFTNESS
    ],
    glsl: `vec4 transition(vec2 uv){
      vec2 c = (uv - 0.5); c.x *= ratio;
      float dist;
      if (shape < 0.5) {
        dist = length(c);
      } else if (shape < 1.5) {
        dist = max(abs(c.x), abs(c.y));
      } else {
        dist = abs(c.x) + abs(c.y);
      }
      float maxR = (shape < 1.5) ? length(vec2(0.5 * ratio, 0.5)) : (0.5 * ratio + 0.5);
      float soft = max(softness, 0.001) * maxR;
      float r = progress * (maxR + soft);
      float mt = 1.0 - smoothstep(r - soft, r + soft, dist);
      return mix(getFromColor(uv), getToColor(uv), mt);
    }`
  }
];

for (const def of DEFS) registerTransition(def);

/** Resolve a param value (from spec.params, with the def default as fallback) to a GLSL-ready value. */
export function resolveTransitionParams(
  def: TransitionDefinition,
  overrides: Record<string, number | number[] | boolean> | undefined
): Record<string, number | number[] | boolean> {
  const out: Record<string, number | number[] | boolean> = {};
  for (const p of def.params) {
    const v = overrides?.[p.name];
    out[p.name] = v !== undefined ? v : p.default;
  }
  return out;
}
