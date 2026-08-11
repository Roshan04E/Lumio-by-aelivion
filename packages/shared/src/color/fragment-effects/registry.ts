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

import { GLSL_HASH_PRELUDE } from "../glsl-hash";
import { GLSL_TRANSFER_PRELUDE } from "../glsl-transfer";

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
  /**
   * The effect LOWERS alpha (keyers). The default composite-back draws the pass result OVER the
   * running nest image, which is correct only for opaque outputs — a keyed hole would show the
   * original opaque pixel underneath and the key would be invisible. `rewritesAlpha` passes with
   * no mask REPLACE the running image instead.
   */
  rewritesAlpha?: boolean;
  /**
   * SEMANTIC dependency declarations (ADR-010), DERIVED from the shader at registration — NOT
   * authored. Kept semantic ("time", never "uTime") so consumers (compiler, evaluation-engine cache)
   * never learn the shader language: a WGSL/MSL/graph effect that animates differently derives the
   * same `["time"]` here and nothing above the registry changes. Consumed by the Flarex content cache
   * to estimate retention (a time-varying artifact has ~zero inter-frame reuse). Any value the caller
   * sets is overwritten by the registry's derivation.
   */
  dependencies?: readonly FragmentEffectDependency[];
  /**
   * This effect is AUTHORED IN DISPLAY SPACE end to end, and the linear stage must leave it alone.
   *
   * Set it and the harness neither decodes on the way in nor encodes on the way out, so the body sees
   * and returns exactly what it saw and returned before the linear stage existed — in a linear project
   * as well as a display one. It is an opt-out from the light, not a conversion of it.
   *
   * WHY THIS EXISTS RATHER THAN A TABLE OF RE-TUNED CONSTANTS. The plan (§3.4) expected the artistic
   * family to need new luma thresholds in linear. Measured, that is not the shape of the problem:
   * these effects do not MIX light, they DRAW a picture out of authored display-referred numbers, and
   * the numbers are not only thresholds.
   *
   *   · `stylize.ts` pivots contrast at `(c - 0.5) * k + 0.5`. 0.5 is middle grey on a display graph;
   *     linear middle grey is 0.214. Run in linear it crushes and saturates everything below mid —
   *     which is exactly what the render showed: olive hillside, blood-red bokeh, over-saturated ground.
   *   · `halftone` returns `mix(vec3(0.97), vec3(0.05), ink)` — authored PAPER and INK values. Emitted
   *     as linear they are the wrong paper and the wrong ink.
   *   · the cel-band quantizer bands LUMA into N steps; banding linear luma puts every edge somewhere
   *     else, because most of a picture's linear luma sits low.
   *
   * Converting a threshold cannot fix a pivot, an output constant or a quantizer. Re-authoring all of
   * them would mean re-designing four shipped looks by eye, with no reference for what they should
   * become — and freezing the result into a baseline, which is what makes a bad tuning permanent.
   *
   * This is not a special case invented here. It is the rule `color/cpu.ts` already applies to curves,
   * wheels, HSL and .cube LUTs — *authored on display graphs, so run them on display values* — and the
   * one the linear-light plan itself mandates for grain (§3.4). The family that needed an exception was
   * simply larger than the plan expected.
   *
   * The consequence is deliberate and worth stating: for these effects the display and linear arms are
   * BIT-IDENTICAL. That is the correct answer, not a missing feature. What the linear stage buys is
   * correct light in the operations that mix it — blur, glow, bloom — and those are unaffected by this
   * flag because they are not fragment effects.
   */
  displayReferred?: boolean;
}

/** Semantic environment/data axes an effect's output depends on (ADR-010 dependency declarations).
 *  Derived from the shader by the registry; kept language-agnostic. Grows as new providers appear. */
export type FragmentEffectDependency = "time";

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

${GLSL_HASH_PRELUDE}
float _luma(vec3 c){ return dot(c, vec3(0.299, 0.587, 0.114)); }
`;

/**
 * The LINEAR-light variant of the prelude (linear-light programme, slice 2).
 *
 * The registry's rule at the top of this file — bodies operate in the renderer's OUTPUT space and must
 * never add their own `pow(2.2)` round-trips — is unchanged and is exactly what makes this work: no
 * body converts, so the harness can convert once, here, for all of them. `getSrcColor` is the single
 * doorway every body reads the layer's image through, so decoding inside it converts the whole stage
 * with no body edited.
 *
 * `uPass{i}` inputs are deliberately NOT decoded. Intermediate passes carry raw DATA — structure
 * tensors, flow fields, paint accumulation buffers — not colour, and running a transfer function over
 * a tensor produces a plausible-looking wrong answer rather than an obvious one. That is also why
 * their pooled targets stay `raw` rather than becoming sRGB.
 *
 * KNOWN AND NOT FIXED HERE: every luma threshold in `builtins.ts` was authored against display values
 * (plan §3.4). In linear, shadow detail collapses toward zero and highlight separation expands, so the
 * ink edge pass, the comic-print halftone, the subject-aware weighting and Kuwahara's variance
 * comparison all want new constants. Re-tuning them is its own slice with its own look-review;
 * changing appearance inside a commit whose claim is byte-identity would make the proof unreadable.
 */
const HARNESS_PRELUDE_LINEAR = `
${GLSL_TRANSFER_PRELUDE}
vec4 getSrcColor(vec2 uv){
  vec4 c = texture(uSrc, clamp(uv, 0.0, 1.0));
  return vec4(sceneToLinear(c.rgb), c.a);
}

${GLSL_HASH_PRELUDE}
float _luma(vec3 c){ return dot(c, vec3(0.299, 0.587, 0.114)); }
`;

function paramUniformLines(params: FragmentEffectParam[]): string {
  return params.map((p) => `uniform ${GLSL_TYPE[p.type]} ${p.name};`).join("\n");
}

const shaderCache = new Map<string, string>();

function assembleShader(
  def: FragmentEffectDefinition,
  body: string,
  passInputCount: number,
  isFinal: boolean,
  light: FragmentEffectLightSpace
): string {
  const passSamplers = Array.from({ length: passInputCount }, (_, i) => `uniform sampler2D uPass${i};`).join("\n");
  // Mask-aware defs (stylize P5) read the effect mask inside the shader; everyone else's
  // assembled source is untouched (parity baselines stay byte-identical).
  const maskUniforms = def.maskAware ? "uniform sampler2D uPassMask;\nuniform float uHasPassMask;" : "";
  // Intermediate passes write their raw output (data textures — tensors, flow fields, paint
  // buffers); ONLY the final pass mixes against the source, so `uIntensity` keeps its product
  // meaning ("how much of the effect") across single- and multi-pass definitions.
  /**
   * The linear stage's EXIT sits here, in the final pass's `main()`, rather than at the consumer the
   * way the plate path's S6 does. That is a deliberate difference and it is a correctness one.
   *
   * The plate path has exactly one consumer — a `compositeTexture` — so a `uFromLinear` flag on that
   * draw closes the bracket. The fragment stage has THREE, and one of them cannot convert: a
   * `rewritesAlpha` (keyer) pass REPLACES the running nest image with a raw `blitFramebuffer`. In
   * WebGL2 a blit from an sRGB attachment to a plain RGBA8 one decodes on read and does not re-encode
   * on write, so linear values would land in a display-referred buffer — a picture roughly twice as
   * dark as it should be, on the keyer path only, with no flag to blame because the flag would be ON.
   *
   * Encoding here instead keeps the stage's OUTPUT display-referred, so every consumer — the masked
   * composite, the replace-blit, the mask gate — is untouched and correct by construction, and the
   * pass targets stay in the display pool. Precision is unchanged either way: 8-bit perceptual out.
   *
   * Intermediate passes are NOT encoded. They carry data, not colour, and they are consumed only by
   * later passes in the same graph that read them raw.
   */
  const finalMain =
    light === "linear"
      ? `void main(){
  vec4 s = getSrcColor(v_uv);
  vec4 e = effect(v_uv);
  vec4 mixed = mix(s, e, clamp(uIntensity, 0.0, 1.0));
  fragColor = vec4(sceneToDisplay(mixed.rgb), mixed.a);
}`
      : `void main(){
  vec4 s = getSrcColor(v_uv);
  vec4 e = effect(v_uv);
  fragColor = mix(s, e, clamp(uIntensity, 0.0, 1.0));
}`;
  const main = isFinal
    ? finalMain
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
${light === "linear" ? HARNESS_PRELUDE_LINEAR : HARNESS_PRELUDE}
${body}

${main}
`;
}

/**
 * Which light the STAGE hands these bodies, and therefore part of the assembled shader's identity.
 *
 * Bodies never convert — the registry's rule above stands, and the harness converts once for everyone.
 * But an assembled shader is only valid for the space it was assembled for, and the cache below is a
 * process-lifetime memo keyed on the definition. A project setting that changes the space would
 * otherwise be answered with whatever variant happened to be compiled first, for the rest of the
 * session — an order-dependent wrong picture, which is the worst kind to reproduce.
 *
 * Slice 1 passes `display` from the compositor for every fragment pass, because slice 1 leaves the
 * fragment stage display-referred. That is a real value read from a real variable rather than a
 * placeholder: when slice 2 moves the nest into linear, the value changes at the call site and these
 * keys follow it with no edit here.
 */
export type FragmentEffectLightSpace = "display" | "linear";

/**
 * The light space an effect actually runs in: the stage's, unless the definition opted out.
 *
 * One choke point, deliberately. Both shader builders below and the compositor's own program cache key
 * off this, so a `displayReferred` effect resolves to `display` everywhere or nowhere — a flag honoured
 * in one cache and not the other is an order-dependent wrong picture.
 */
export function effectLightFor(
  def: FragmentEffectDefinition,
  stage: FragmentEffectLightSpace
): FragmentEffectLightSpace {
  return def.displayReferred ? "display" : stage;
}

/** Assemble the full fragment shader for a SINGLE-PASS definition. Memoized by (id, light space). */
export function buildFragmentEffectShader(
  def: FragmentEffectDefinition,
  requested: FragmentEffectLightSpace = "display"
): string {
  const light = effectLightFor(def, requested);
  const key = `${def.id}@${light}`;
  const cached = shaderCache.get(key);
  if (cached) return cached;
  const src = assembleShader(def, def.glsl, 0, true, light);
  shaderCache.set(key, src);
  return src;
}

/**
 * Assemble the shader for ONE pass of a multi-pass definition. Memoized per (def, pass). The same
 * assembled source is compiled by every renderer (web preview, browser export, Remotion) — the
 * parity-by-construction law extends to graphs unchanged.
 */
export function buildFragmentEffectPassShader(
  def: FragmentEffectDefinition,
  pass: FragmentEffectPassDefinition,
  requested: FragmentEffectLightSpace = "display"
): string {
  const light = effectLightFor(def, requested);
  const passes = def.passes ?? [];
  const key = `${def.id}#${pass.id}@${light}`;
  const cached = shaderCache.get(key);
  if (cached) return cached;
  const isFinal = passes.length > 0 && passes[passes.length - 1]!.id === pass.id;
  const src = assembleShader(def, pass.glsl, pass.inputs?.length ?? 0, isFinal, light);
  shaderCache.set(key, src);
  return src;
}

// ---------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------

const registry = new Map<string, FragmentEffectDefinition>();

/** Derive an effect's semantic dependency declarations from its shader source ONCE, at registration
 *  (ADR-010: the provider derives declarations; the compiler/evaluator only consume them). Today the
 *  only axis is `time`, detected by a `uTime` reference in the body/pass GLSL — but this scan is the
 *  ONLY place that knows the token exists; everything upstream sees the semantic `"time"`. */
function deriveFragmentEffectDependencies(def: FragmentEffectDefinition): FragmentEffectDependency[] {
  const sources = [def.glsl, ...(def.passes ?? []).map((pass) => pass.glsl)];
  const usesTime = sources.some((src) => /\buTime\b/.test(src ?? ""));
  return usesTime ? ["time"] : [];
}

export function registerFragmentEffect(def: FragmentEffectDefinition, options: { override?: boolean } = {}): boolean {
  if (registry.has(def.id) && !options.override) {
    return false;
  }
  shaderCache.delete(def.id);
  for (const pass of def.passes ?? []) {
    shaderCache.delete(`${def.id}#${pass.id}`);
  }
  // Store the def with its DERIVED dependency declarations (non-mutating: a shallow copy, so the
  // caller's object is untouched and the registry is the single source of the derived metadata).
  const dependencies = deriveFragmentEffectDependencies(def);
  registry.set(def.id, dependencies.length ? { ...def, dependencies } : def);
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
