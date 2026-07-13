import { createTimelineEffect, getTimelineEffectDefinition, type TimelineEffectCategory } from "./effects";
import {
  getFragmentEffect,
  registerFragmentEffect,
  resolveFragmentEffectParams,
  type FragmentEffectDefinition,
  type FragmentEffectParam,
  type FragmentParamType
} from "./color/fragment-effects/registry";
import type { PluginEffectManifest, PluginParam } from "./plugin-manifest";
import { timelineEffectTypes, type TimelineEffect, type TimelineEffectParamValue, type TimelineEffectType, type TimelineLayerType } from "./types";

const SUPPORTED_EFFECT_ENGINES = new Set<PluginEffectManifest["engine"]>(["native", "color-pipeline", "lut3d", "webgl-fragment"]);
const COLOR_PIPELINE_EFFECT_TYPE: TimelineEffectType = "brightnessContrast";
const LUT_EFFECT_TYPE: TimelineEffectType = "importedLut";
const PLUGIN_SHADER_EFFECT_TYPE: TimelineEffectType = "pluginShader";
/** Key under which a pluginShader TimelineEffect's params stores the fragment-effect registry id. */
export const SHADER_MANIFEST_ID_PARAM_KEY = "__shaderManifestId";

export interface ResolvedEffectManifest {
  id: string;
  name: string;
  description?: string | undefined;
  effectType: TimelineEffectType;
  category: TimelineEffectCategory;
  compatibleLayerTypes: TimelineLayerType[];
  params: Record<string, TimelineEffectParamValue>;
  intensity: number;
  warnings: string[];
  manifest: PluginEffectManifest;
}

export function resolveEffectManifest(manifest: PluginEffectManifest): ResolvedEffectManifest {
  const warnings = manifest.warnings.map((warning) => warning.message);

  if (manifest.engine === "webgl-fragment") {
    return resolvePluginShaderManifest(manifest, warnings);
  }

  const requestedType = readEffectType(manifest);
  const effectType = effectTypeForManifest(manifest, requestedType, warnings);
  const definition = getTimelineEffectDefinition(effectType);
  const defaults = Object.fromEntries((definition?.params ?? []).map((param) => [param.key, param.defaultValue]));
  const manifestParams = readEffectParams(manifest, warnings);
  const compatibleLayerTypes = manifest.compatibleLayerTypes.filter((type) => definition?.compatibleLayerTypes.includes(type) ?? true);

  if (!SUPPORTED_EFFECT_ENGINES.has(manifest.engine)) {
    warnings.push(`Engine "${manifest.engine}" is not renderable yet. Importing as a manifest-backed preset only.`);
  }
  if (requestedType && requestedType !== effectType) {
    warnings.push(`Effect type "${requestedType}" is not available; mapped to "${effectType}".`);
  }
  if (compatibleLayerTypes.length === 0 && definition) {
    warnings.push(`No declared compatible layer type matches "${effectType}"; using the native effect compatibility.`);
  }

  return {
    id: manifest.id,
    name: manifest.name,
    description: manifest.description,
    effectType,
    category: definition?.category ?? "Stylize",
    compatibleLayerTypes: compatibleLayerTypes.length ? compatibleLayerTypes : definition?.compatibleLayerTypes ?? manifest.compatibleLayerTypes,
    params: { ...defaults, ...manifestParams },
    intensity: readIntensity(manifest, definition?.defaultIntensity ?? 50),
    warnings,
    manifest
  };
}

export function createTimelineEffectFromManifest(manifest: PluginEffectManifest): TimelineEffect {
  const resolved = resolveEffectManifest(manifest);
  return {
    ...createTimelineEffect(resolved.effectType),
    id: `effect_${resolved.id}_${Date.now()}`,
    name: resolved.name,
    intensity: resolved.intensity,
    params: resolved.params
  };
}

export function canApplyEffectManifestToLayer(manifest: PluginEffectManifest, layerType: TimelineLayerType): boolean {
  return resolveEffectManifest(manifest).compatibleLayerTypes.includes(layerType);
}

// ---------------------------------------------------------------------------
// webgl-fragment (real GLSL "Custom Shader" effect) support
// ---------------------------------------------------------------------------

export interface FragmentEffectGlslValidation {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

const FORBIDDEN_FRAGMENT_GLSL_PATTERNS: Array<{ pattern: RegExp; message: string }> = [
  { pattern: /#\s*version\b/, message: "Do not include #version; Kimera injects the shader harness." },
  { pattern: /\bvoid\s+main\s*\(/, message: "Do not define main(); provide only vec4 effect(vec2 uv)." },
  { pattern: /\bprecision\s+(lowp|mediump|highp)\b/, message: "Do not declare precision; Kimera injects it." },
  { pattern: /\buniform\s+sampler2D\b/, message: "Do not declare sampler uniforms; use getSrcColor()." },
  { pattern: /\bgl_FragColor\b/, message: "Do not write gl_FragColor; return a vec4 from effect()." },
  { pattern: /\bdiscard\s*;/, message: "discard is not allowed in portable effect manifests." },
  { pattern: /#\s*extension\b/, message: "Do not declare #extension; Kimera injects the shader harness." }
];

export function validateFragmentEffectGlsl(glsl: string): FragmentEffectGlslValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const body = glsl.trim();

  if (!body) {
    errors.push("Fragment effect GLSL body is empty.");
  }
  if (body.length > 60_000) {
    errors.push("Fragment effect GLSL body is too large.");
  }
  if (!/\bvec4\s+effect\s*\(\s*vec2\s+\w+\s*\)/.test(body)) {
    errors.push("Fragment effect GLSL must define vec4 effect(vec2 uv).");
  }
  for (const rule of FORBIDDEN_FRAGMENT_GLSL_PATTERNS) {
    if (rule.pattern.test(body)) {
      errors.push(rule.message);
    }
  }
  if (/\btexture\s*\(\s*uSrc\b/.test(body)) {
    warnings.push("Prefer getSrcColor() so the effect stays consistent with the shader harness.");
  }

  return { ok: errors.length === 0, errors, warnings };
}

export function fragmentEffectManifestToDefinition(manifest: PluginEffectManifest): FragmentEffectDefinition {
  if (manifest.engine !== "webgl-fragment") {
    throw new Error(`Unsupported fragment effect manifest engine: ${manifest.engine}`);
  }
  const glsl = readManifestGlsl(manifest);
  if (!glsl) {
    throw new Error(`Effect manifest ${manifest.id} is missing effect.glsl.`);
  }
  const validation = validateFragmentEffectGlsl(glsl);
  if (!validation.ok) {
    throw new Error(`Invalid fragment effect manifest ${manifest.id}: ${validation.errors.join(" ")}`);
  }

  return {
    id: manifest.id,
    name: manifest.name,
    category: manifest.category ?? "Stylize",
    params: readManifestFragmentParams(manifest).map(pluginParamToFragmentParam),
    glsl
  };
}

export interface RegisterEffectManifestResult {
  definition?: FragmentEffectDefinition;
  registered: boolean;
  warnings: string[];
}

/** Registers a webgl-fragment manifest's GLSL as a FragmentEffectDefinition. No-op for other engines. */
export function registerEffectManifest(
  manifest: PluginEffectManifest,
  options: { override?: boolean } = {}
): RegisterEffectManifestResult {
  if (manifest.engine !== "webgl-fragment") {
    return { registered: false, warnings: [] };
  }
  const definition = fragmentEffectManifestToDefinition(manifest);
  const existing = getFragmentEffect(definition.id);
  const registered = registerFragmentEffect(definition, options);
  const warnings = validateFragmentEffectGlsl(definition.glsl).warnings;
  if (existing && !options.override && !registered) {
    warnings.push(`Fragment effect id "${definition.id}" already exists; manifest was not registered.`);
  }
  return { definition, registered, warnings };
}

export function registerEffectManifests(
  manifests: PluginEffectManifest[],
  options: { override?: boolean } = {}
): RegisterEffectManifestResult[] {
  return manifests.map((manifest) => registerEffectManifest(manifest, options));
}

/** Converts stored TimelineEffect.params (hex/JSON strings) + a fragment def into GLSL-ready values. */
export function fragmentEffectParamsFromStorage(
  def: FragmentEffectDefinition,
  params: Record<string, TimelineEffectParamValue> | undefined
): Record<string, number | number[] | boolean> {
  const overrides: Record<string, number | number[] | boolean> = {};
  for (const p of def.params) {
    const raw = params?.[p.name];
    if (raw === undefined) continue;
    if (p.type === "float" && typeof raw === "number") {
      overrides[p.name] = raw;
    } else if (p.type === "bool" && typeof raw === "boolean") {
      overrides[p.name] = raw;
    } else if (p.type === "vec3" && typeof raw === "string") {
      const rgb = hexToRgb(raw);
      if (rgb) overrides[p.name] = rgb;
    } else if (p.type === "vec2" && typeof raw === "string") {
      const vec2 = parseVec2(raw);
      if (vec2) overrides[p.name] = vec2;
    }
  }
  return resolveFragmentEffectParams(def, overrides);
}

function resolvePluginShaderManifest(manifest: PluginEffectManifest, warnings: string[]): ResolvedEffectManifest {
  let definition: FragmentEffectDefinition;
  try {
    definition = fragmentEffectManifestToDefinition(manifest);
    registerFragmentEffect(definition, { override: false });
  } catch (error) {
    warnings.push(error instanceof Error ? error.message : String(error));
    definition = {
      id: manifest.id,
      name: manifest.name,
      category: "Stylize",
      params: [],
      glsl: `vec4 effect(vec2 uv){ return getSrcColor(uv); }`
    };
    registerFragmentEffect(definition, { override: true });
  }

  const params: Record<string, TimelineEffectParamValue> = { [SHADER_MANIFEST_ID_PARAM_KEY]: definition.id };
  for (const p of definition.params) {
    params[p.name] = fragmentParamToStorageValue(p.type, p.default);
  }

  const declaredLayerTypes = manifest.compatibleLayerTypes.filter((type) =>
    (["video", "image", "text", "shape"] as TimelineLayerType[]).includes(type)
  );

  return {
    id: manifest.id,
    name: manifest.name,
    description: manifest.description,
    effectType: PLUGIN_SHADER_EFFECT_TYPE,
    category: "Stylize",
    compatibleLayerTypes: declaredLayerTypes.length ? declaredLayerTypes : ["video", "image", "text", "shape"],
    params,
    intensity: readIntensity(manifest, 100),
    warnings,
    manifest
  };
}

function readManifestGlsl(manifest: PluginEffectManifest): string | undefined {
  const raw = (manifest.effect as Record<string, unknown> | undefined)?.glsl;
  return typeof raw === "string" ? raw : undefined;
}

function readManifestFragmentParams(manifest: PluginEffectManifest): PluginParam[] {
  const raw = (manifest.effect as Record<string, unknown> | undefined)?.params;
  if (Array.isArray(raw) && raw.length) {
    return raw as PluginParam[];
  }
  return manifest.params ?? [];
}

function pluginParamToFragmentParam(param: PluginParam): FragmentEffectParam {
  const type = fragmentParamType(param);
  return {
    name: param.key,
    type,
    default: fragmentParamGlslDefault(param, type),
    label: param.label,
    ...(param.min !== undefined ? { min: param.min } : {}),
    ...(param.max !== undefined ? { max: param.max } : {}),
    ...(param.step !== undefined ? { step: param.step } : {})
  };
}

function fragmentParamType(param: PluginParam): FragmentParamType {
  if (param.type === "number") return "float";
  if (param.type === "vec2") return "vec2";
  if (param.type === "vec3" || param.type === "color") return "vec3";
  if (param.type === "boolean") return "bool";
  throw new Error(`Unsupported fragment effect param type "${param.type}" for "${param.key}".`);
}

function fragmentParamGlslDefault(param: PluginParam, type: FragmentParamType): number | number[] | boolean {
  const value = param.defaultValue;
  if (type === "float") return typeof value === "number" ? value : 0;
  if (type === "bool") return typeof value === "boolean" ? value : false;
  if (type === "vec2") return numberArrayOrFallback(value, 2, [0, 0]);
  if (type === "vec3") {
    if (typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value)) {
      const rgb = hexToRgb(value);
      if (rgb) return rgb;
    }
    return numberArrayOrFallback(value, 3, [0, 0, 0]);
  }
  return 0;
}

function fragmentParamToStorageValue(type: FragmentParamType, value: number | number[] | boolean): TimelineEffectParamValue {
  if (type === "float") return typeof value === "number" ? value : 0;
  if (type === "bool") return typeof value === "boolean" ? value : false;
  if (type === "vec3" && Array.isArray(value)) return rgbToHex(value);
  if (type === "vec2" && Array.isArray(value)) return JSON.stringify(value);
  return 0;
}

function rgbToHex(rgb: number[]): string {
  const toHex = (c: number) =>
    Math.round(Math.min(1, Math.max(0, c)) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${toHex(rgb[0] ?? 0)}${toHex(rgb[1] ?? 0)}${toHex(rgb[2] ?? 0)}`;
}

function hexToRgb(hex: string): number[] | undefined {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  const group = m?.[1];
  if (!group) return undefined;
  const n = parseInt(group, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

function parseVec2(json: string): number[] | undefined {
  try {
    const arr = JSON.parse(json);
    if (Array.isArray(arr) && arr.length === 2 && arr.every((v) => typeof v === "number")) {
      return arr as number[];
    }
  } catch {
    // ignore malformed JSON — caller falls back to the definition default.
  }
  return undefined;
}

function numberArrayOrFallback(value: unknown, size: number, fallback: number[]): number[] {
  if (!Array.isArray(value) || value.length !== size || value.some((entry) => typeof entry !== "number")) {
    return fallback;
  }
  return value as number[];
}

function effectTypeForManifest(
  manifest: PluginEffectManifest,
  requestedType: string | undefined,
  warnings: string[]
): TimelineEffectType {
  if (requestedType && isTimelineEffectType(requestedType)) {
    return requestedType;
  }
  if (manifest.engine === "color-pipeline") {
    return COLOR_PIPELINE_EFFECT_TYPE;
  }
  if (manifest.engine === "lut3d") {
    return LUT_EFFECT_TYPE;
  }
  warnings.push("Native effect manifests should declare effect.type with a supported Kimera effect id.");
  return COLOR_PIPELINE_EFFECT_TYPE;
}

function readEffectType(manifest: PluginEffectManifest): string | undefined {
  const type = manifest.effect.type;
  return typeof type === "string" ? type : undefined;
}

function readIntensity(manifest: PluginEffectManifest, fallback: number): number {
  const value = manifest.effect.intensity;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(100, Math.max(0, value));
}

function readEffectParams(manifest: PluginEffectManifest, warnings: string[]): Record<string, TimelineEffectParamValue> {
  const raw = manifest.effect.params;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }

  const params: Record<string, TimelineEffectParamValue> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      params[key] = value;
    } else {
      warnings.push(`Param "${key}" is not a string, number, or boolean and was ignored.`);
    }
  }
  return params;
}

function isTimelineEffectType(value: string): value is TimelineEffectType {
  return (timelineEffectTypes as readonly string[]).includes(value);
}
