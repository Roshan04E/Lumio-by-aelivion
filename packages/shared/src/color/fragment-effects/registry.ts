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

/**
 * One pass of a multi-pass fragment effect (the stylize pass-graph, plans/stylize-anime-engine.md).
 * Passes run in array order; each renders a full-screen triangle into its own render target.
 * `uSrc` is ALWAYS the layer's original composited image; `inputs` lists EARLIER pass ids whose
 * outputs are bound as `uPass0..N` (in the listed order). `scale` shrinks the pass's working
 * resolution (0.5 = half comp res — where expensive filters live); the LAST pass always renders at
 * full comp resolution and is the only one mixed against the source by `uIntensity`.
 */
export interface FragmentEffectPassDefinition {
  id: string;
  /** Earlier pass ids bound as uPass0..N. Omit for src-only passes. */
  inputs?: string[];
  /** Working-resolution factor (0,1]; ignored (forced 1) on the final pass. */
  scale?: number;
  /**
   * Cost gate: when it returns true for the resolved params, the pass is SKIPPED and later passes
   * that list it as an input receive the SOURCE texture instead. Only valid when the consuming
   * math makes the input irrelevant under the same condition (e.g. ink passes skipped at
   * inkStrength 0, whose consumer mixes by inkStrength). Deterministic — same params skip the
   * same passes in every renderer, so parity holds.
   */
  skipWhen?: (params: Record<string, number | number[] | boolean>) => boolean;
  /** The body: must define `vec4 effect(vec2 uv) { ... }`. */
  glsl: string;
}

export interface FragmentEffectDefinition {
  /** Stable id - stored as `effect.params.__shaderManifestId`. */
  id: string;
  name: string;
  category: string;
  params: FragmentEffectParam[];
  /** Single-pass body: must define `vec4 effect(vec2 uv) { ... }`. Ignored when `passes` is set. */
  glsl: string;
  /** Multi-pass graph (ordered). When present the compositor runs the chain instead of `glsl`. */
  passes?: FragmentEffectPassDefinition[];
  /**
   * Mask-aware effect (stylize P5): the effect's pass mask is bound INTO the shader as
   * `uniform sampler2D uPassMask` (+ `uniform float uHasPassMask`, 0/1) instead of being applied
   * as the usual binary after-composite gate — the shader reads the matte's ALPHA as a per-pixel
   * weight map (subject vs background treatment). Only mask-aware defs get the extra uniforms, so
   * every other definition's assembled GLSL stays byte-identical.
   */
  maskAware?: boolean;
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

function assembleShader(def: FragmentEffectDefinition, body: string, passInputCount: number, isFinal: boolean): string {
  const passSamplers = Array.from({ length: passInputCount }, (_, i) => `uniform sampler2D uPass${i};`).join("\n");
  // Mask-aware defs (stylize P5) read the effect mask inside the shader; everyone else's
  // assembled source is untouched (parity baselines stay byte-identical).
  const maskUniforms = def.maskAware ? "uniform sampler2D uPassMask;\nuniform float uHasPassMask;" : "";
  // Intermediate passes write their raw output (data textures — tensors, flow fields, paint
  // buffers); ONLY the final pass mixes against the source, so `uIntensity` keeps its product
  // meaning ("how much of the effect") across single- and multi-pass definitions.
  const main = isFinal
    ? `void main(){
  vec4 s = getSrcColor(v_uv);
  vec4 e = effect(v_uv);
  fragColor = mix(s, e, clamp(uIntensity, 0.0, 1.0));
}`
    : `void main(){
  fragColor = effect(v_uv);
}`;
  return `#version 300 es
precision highp float;
precision highp sampler2D;

in vec2 v_uv;
out vec4 fragColor;

uniform sampler2D uSrc;      // the layer's own composited image
${passSamplers}
${maskUniforms}
uniform vec2 uResolution;    // THIS pass's output resolution (scaled passes see their working res)
uniform float uIntensity;    // 0..1, mixed against the source in the final pass's main()
uniform float uTime;
${paramUniformLines(def.params)}
${HARNESS_PRELUDE}
${body}

${main}
`;
}

/** Assemble the full fragment shader for a SINGLE-PASS definition. Memoized by id (definitions are static). */
export function buildFragmentEffectShader(def: FragmentEffectDefinition): string {
  const cached = shaderCache.get(def.id);
  if (cached) return cached;
  const src = assembleShader(def, def.glsl, 0, true);
  shaderCache.set(def.id, src);
  return src;
}

/**
 * Assemble the shader for ONE pass of a multi-pass definition. Memoized per (def, pass). The same
 * assembled source is compiled by every renderer (web preview, browser export, Remotion) — the
 * parity-by-construction law extends to graphs unchanged.
 */
export function buildFragmentEffectPassShader(def: FragmentEffectDefinition, pass: FragmentEffectPassDefinition): string {
  const passes = def.passes ?? [];
  const key = `${def.id}#${pass.id}`;
  const cached = shaderCache.get(key);
  if (cached) return cached;
  const isFinal = passes.length > 0 && passes[passes.length - 1]!.id === pass.id;
  const src = assembleShader(def, pass.glsl, pass.inputs?.length ?? 0, isFinal);
  shaderCache.set(key, src);
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
  for (const pass of def.passes ?? []) {
    shaderCache.delete(`${def.id}#${pass.id}`);
  }
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
