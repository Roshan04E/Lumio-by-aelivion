import {
  getTransition,
  registerTransition,
  type TransitionCategory,
  type TransitionDefinition,
  type TransitionParam,
  type TransitionParamType
} from "./color/transitions/registry";
import type { PluginParam, PluginTransitionManifest } from "./plugin-manifest";

export interface TransitionManifestValidation {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

export interface RegisterTransitionManifestResult {
  definition: TransitionDefinition;
  registered: boolean;
  warnings: string[];
}

const TRANSITION_CATEGORIES: TransitionCategory[] = ["basic", "creator", "cinematic", "glitch", "mask"];

const FORBIDDEN_GLSL_PATTERNS: Array<{ pattern: RegExp; message: string }> = [
  { pattern: /#\s*version\b/, message: "Do not include #version; Lumio injects the shader harness." },
  { pattern: /\bvoid\s+main\s*\(/, message: "Do not define main(); provide only vec4 transition(vec2 uv)." },
  { pattern: /\bprecision\s+(lowp|mediump|highp)\b/, message: "Do not declare precision; Lumio injects it." },
  { pattern: /\buniform\s+sampler2D\b/, message: "Do not declare sampler uniforms; use getFromColor() and getToColor()." },
  { pattern: /\bgl_FragColor\b/, message: "Do not write gl_FragColor; return a vec4 from transition()." },
  { pattern: /\bdiscard\s*;/, message: "discard is not allowed in portable transition manifests." }
];

export function validateTransitionManifestGlsl(glsl: string): TransitionManifestValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const body = glsl.trim();

  if (!body) {
    errors.push("Transition GLSL body is empty.");
  }
  if (body.length > 60_000) {
    errors.push("Transition GLSL body is too large.");
  }
  if (!/\bvec4\s+transition\s*\(\s*vec2\s+\w+\s*\)/.test(body)) {
    errors.push("Transition GLSL must define vec4 transition(vec2 uv).");
  }
  for (const rule of FORBIDDEN_GLSL_PATTERNS) {
    if (rule.pattern.test(body)) {
      errors.push(rule.message);
    }
  }
  if (/\btexture\s*\(\s*uFrom\b|\btexture\s*\(\s*uTo\b/.test(body)) {
    warnings.push("Prefer getFromColor() and getToColor() so object-fit remapping stays correct.");
  }

  return { ok: errors.length === 0, errors, warnings };
}

export function transitionManifestToDefinition(manifest: PluginTransitionManifest): TransitionDefinition {
  if (manifest.engine !== "webgl-transition") {
    throw new Error(`Unsupported transition manifest engine: ${manifest.engine}`);
  }
  const glsl = manifest.transition.glsl;
  if (!glsl) {
    throw new Error(`Transition manifest ${manifest.id} is missing transition.glsl.`);
  }
  const validation = validateTransitionManifestGlsl(glsl);
  if (!validation.ok) {
    throw new Error(`Invalid transition manifest ${manifest.id}: ${validation.errors.join(" ")}`);
  }

  return {
    id: manifest.id,
    name: manifest.name,
    category: normalizeTransitionCategory(manifest.category, manifest.tags),
    defaultDurationSeconds: manifest.defaultDurationSeconds,
    easing: manifest.easing,
    params: ((manifest.transition.params ?? []).length ? manifest.transition.params : (manifest.params ?? [])).map(pluginParamToTransitionParam),
    glsl
  };
}

export function registerTransitionManifest(
  manifest: PluginTransitionManifest,
  options: { override?: boolean } = {}
): RegisterTransitionManifestResult {
  const definition = transitionManifestToDefinition(manifest);
  const existing = getTransition(definition.id);
  const registered = registerTransition(definition, options);
  const warnings = validateTransitionManifestGlsl(definition.glsl).warnings;
  if (existing && !options.override && !registered) {
    warnings.push(`Transition id "${definition.id}" already exists; manifest was not registered.`);
  }
  return { definition, registered, warnings };
}

export function registerTransitionManifests(
  manifests: PluginTransitionManifest[],
  options: { override?: boolean } = {}
): RegisterTransitionManifestResult[] {
  return manifests.map((manifest) => registerTransitionManifest(manifest, options));
}

function normalizeTransitionCategory(category: string | undefined, tags: string[] | undefined): TransitionCategory {
  const candidates = [category, ...(tags ?? [])].filter((value): value is string => Boolean(value));
  for (const candidate of candidates) {
    const normalized = candidate.toLowerCase().replace(/[\s_&]+/g, "-");
    if (normalized.includes("glitch")) return "glitch";
    if (normalized.includes("mask") || normalized.includes("reveal") || normalized.includes("wipe")) return "mask";
    if (normalized.includes("cinematic") || normalized.includes("film") || normalized.includes("light")) return "cinematic";
    if (normalized.includes("basic") || normalized.includes("essential")) return "basic";
    if (TRANSITION_CATEGORIES.includes(normalized as TransitionCategory)) return normalized as TransitionCategory;
  }
  return "creator";
}

function pluginParamToTransitionParam(param: PluginParam): TransitionParam {
  const type = transitionParamType(param);
  return {
    name: param.key,
    type,
    default: transitionParamDefault(param, type),
    label: param.label,
    ...(param.min !== undefined ? { min: param.min } : {}),
    ...(param.max !== undefined ? { max: param.max } : {}),
    ...(param.step !== undefined ? { step: param.step } : {})
  };
}

function transitionParamType(param: PluginParam): TransitionParamType {
  if (param.type === "number") return "float";
  if (param.type === "vec2") return "vec2";
  if (param.type === "vec3" || param.type === "color") return "vec3";
  if (param.type === "boolean") return "bool";
  throw new Error(`Unsupported transition param type "${param.type}" for "${param.key}".`);
}

function transitionParamDefault(param: PluginParam, type: TransitionParamType): number | number[] | boolean {
  const value = param.defaultValue;
  if (type === "float") return typeof value === "number" ? value : 0;
  if (type === "bool") return typeof value === "boolean" ? value : false;
  if (type === "vec2") return numberArray(value, 2, [0, 0]);
  if (type === "vec3") {
    if (typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value)) {
      return [parseInt(value.slice(1, 3), 16) / 255, parseInt(value.slice(3, 5), 16) / 255, parseInt(value.slice(5, 7), 16) / 255];
    }
    return numberArray(value, 3, [0, 0, 0]);
  }
  return 0;
}

function numberArray(value: unknown, size: number, fallback: number[]): number[] {
  if (!Array.isArray(value) || value.length !== size || value.some((entry) => typeof entry !== "number")) {
    return fallback;
  }
  return value;
}
