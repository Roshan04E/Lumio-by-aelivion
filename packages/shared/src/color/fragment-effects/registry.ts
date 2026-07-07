/**
 * Fragment-effect GLSL registry — the same registry+harness pattern as the unified transition
 * engine (`color/transitions/registry.ts`), for single-clip "stylize" effects instead of two-clip
 * transitions. Every effect is a fragment body `vec4 effect(vec2 uv)` sampling `getSrcColor(uv)`
 * (the layer's own already-composited image). `buildFragmentEffectShader` wraps a definition in the
 * standard `#version 300 es` harness so the SAME assembled GLSL is compiled by all three renderers
 * (web preview, browser export, Remotion) -> pixel-identical output.
 *
 * Hard rule: bodies operate in the renderer's sRGB OUTPUT space (same as transitions) - do not add
 * pow(2.2) linear round-trips, or preview and export diverge.
 *
 * UV convention matches `MediaWebGLRenderer`: uv (0,0) = bottom-left, (1,1) = top-left, with sources
 * uploaded UNPACK_FLIP_Y=true.
 */

export type FragmentParamType = "float" | "vec2" | "vec3" | "bool";

export interface FragmentEffectParam {
  /** GLSL uniform name (also the key in the effect's params). */
  name: string;
  type: FragmentParamType;
  default: number | number[] | boolean;
  /** UI hints (float only). */
  min?: number;
  max?: number;
  step?: number;
  label?: string;
}

export interface FragmentEffectDefinition {
  /** Stable id - stored as `effect.params.__shaderManifestId`. */
  id: string;
  name: string;
  category: string;
  params: FragmentEffectParam[];
  /** The body: must define `vec4 effect(vec2 uv) { ... }`. */
  glsl: string;
}

const GLSL_TYPE: Record<FragmentParamType, string> = {
  float: "float",
  vec2: "vec2",
  vec3: "vec3",
  bool: "bool"
};

/**
 * Shared GLSL prelude available to every fragment effect body: a source-color sampler, a cheap
 * hash, and a luma helper. Keeping these here means bodies stay tiny and consistent.
 */
const HARNESS_PRELUDE = `
vec4 getSrcColor(vec2 uv){ return texture(uSrc, clamp(uv, 0.0, 1.0)); }

float _rand(vec2 co){ return fract(sin(dot(co.xy, vec2(12.9898, 78.233))) * 43758.5453); }
float _luma(vec3 c){ return dot(c, vec3(0.299, 0.587, 0.114)); }
`;

function paramUniformLines(params: FragmentEffectParam[]): string {
  return params.map((p) => `uniform ${GLSL_TYPE[p.type]} ${p.name};`).join("\n");
}

const shaderCache = new Map<string, string>();

/** Assemble the full fragment shader for a definition. Memoized by id (definitions are static). */
export function buildFragmentEffectShader(def: FragmentEffectDefinition): string {
  const cached = shaderCache.get(def.id);
  if (cached) return cached;
  const src = `#version 300 es
precision highp float;
precision highp sampler2D;

in vec2 v_uv;
out vec4 fragColor;

uniform sampler2D uSrc;      // the layer's own composited image
uniform vec2 uResolution;
uniform float uIntensity;    // 0..1, mixed against the source in main()
uniform float uTime;
${paramUniformLines(def.params)}
${HARNESS_PRELUDE}
${def.glsl}

void main(){
  vec4 s = getSrcColor(v_uv);
  vec4 e = effect(v_uv);
  fragColor = mix(s, e, clamp(uIntensity, 0.0, 1.0));
}
`;
  shaderCache.set(def.id, src);
  return src;
}

// ---------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------

const registry = new Map<string, FragmentEffectDefinition>();

export function registerFragmentEffect(def: FragmentEffectDefinition, options: { override?: boolean } = {}): boolean {
  if (registry.has(def.id) && !options.override) {
    return false;
  }
  shaderCache.delete(def.id);
  registry.set(def.id, def);
  return true;
}

export function getFragmentEffect(id: string): FragmentEffectDefinition | undefined {
  return registry.get(id);
}

export function listFragmentEffects(): FragmentEffectDefinition[] {
  return [...registry.values()];
}

/** Resolve a param value (from effect.params, with the def default as fallback) to a GLSL-ready value. */
export function resolveFragmentEffectParams(
  def: FragmentEffectDefinition,
  overrides: Record<string, number | number[] | boolean> | undefined
): Record<string, number | number[] | boolean> {
  const out: Record<string, number | number[] | boolean> = {};
  for (const p of def.params) {
    const v = overrides?.[p.name];
    out[p.name] = v !== undefined ? v : p.default;
  }
  return out;
}
