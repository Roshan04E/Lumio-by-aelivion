import { createTimelineEffect, getTimelineEffectDefinition, type TimelineEffectCategory } from "./effects";
import type { PluginEffectManifest } from "./plugin-manifest";
import { timelineEffectTypes, type TimelineEffect, type TimelineEffectParamValue, type TimelineEffectType, type TimelineLayerType } from "./types";

const SUPPORTED_EFFECT_ENGINES = new Set<PluginEffectManifest["engine"]>(["native", "color-pipeline", "lut3d"]);
const COLOR_PIPELINE_EFFECT_TYPE: TimelineEffectType = "brightnessContrast";
const LUT_EFFECT_TYPE: TimelineEffectType = "importedLut";

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
  warnings.push("Native effect manifests should declare effect.type with a supported Lumio effect id.");
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
