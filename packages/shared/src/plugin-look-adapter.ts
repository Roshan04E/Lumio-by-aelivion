import { registerCreativeLook, type CreativeLook } from "./color/looks";
import type { PluginLookManifest } from "./plugin-manifest";

export interface ResolvedLookManifest {
  id: string;
  name: string;
  description?: string | undefined;
  look: CreativeLook;
  warnings: string[];
  manifest: PluginLookManifest;
}

export interface RegisterLookManifestResult {
  look: CreativeLook;
  registered: boolean;
  warnings: string[];
}

const LOOK_NUMBER_KEYS = [
  "exposure",
  "contrast",
  "highlights",
  "shadows",
  "whites",
  "blacks",
  "saturation",
  "vibrance",
  "temperature",
  "tint"
] as const;

export function resolveLookManifest(manifest: PluginLookManifest): ResolvedLookManifest {
  const warnings = manifest.warnings.map((warning) => warning.message);
  const raw = manifest.look;
  const correction = readCorrection(raw.correction, warnings);
  const wheelsJson = readJsonField(raw.wheelsJson ?? raw.wheels, "wheels", warnings);
  const curvesJson = readJsonField(raw.curvesJson ?? raw.curves, "curves", warnings);

  if (manifest.engine === "lut3d") {
    warnings.push("LUT-backed look manifests are stored, but the creative-look renderer only supports color-pipeline looks in this step.");
  }

  const look: CreativeLook = {
    name: manifest.name,
    description: manifest.description ?? "Imported creator look.",
    correction,
    ...(curvesJson ? { curvesJson } : {}),
    ...(wheelsJson ? { wheelsJson } : {})
  };

  return {
    id: manifest.id,
    name: manifest.name,
    description: manifest.description,
    look,
    warnings,
    manifest
  };
}

export function registerLookManifest(
  manifest: PluginLookManifest,
  options: { override?: boolean } = {}
): RegisterLookManifestResult {
  const resolved = resolveLookManifest(manifest);
  const registered = registerCreativeLook(resolved.look, options);
  const warnings = [...resolved.warnings];
  if (!registered) {
    warnings.push(`Look "${resolved.look.name}" already exists; manifest was not registered.`);
  }
  return { look: resolved.look, registered, warnings };
}

export function registerLookManifests(
  manifests: PluginLookManifest[],
  options: { override?: boolean } = {}
): RegisterLookManifestResult[] {
  return manifests.map((manifest) => registerLookManifest(manifest, options));
}

function readCorrection(value: unknown, warnings: string[]): CreativeLook["correction"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    warnings.push("look.correction is missing; imported look will be neutral.");
    return {};
  }
  const source = value as Record<string, unknown>;
  const correction: CreativeLook["correction"] = {};
  for (const key of LOOK_NUMBER_KEYS) {
    const raw = source[key];
    if (raw === undefined) continue;
    if (typeof raw === "number" && Number.isFinite(raw)) {
      correction[key] = raw;
    } else {
      warnings.push(`look.correction.${key} must be a number and was ignored.`);
    }
  }
  return correction;
}

function readJsonField(value: unknown, label: string, warnings: string[]): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") {
    try {
      JSON.parse(value);
      return value;
    } catch {
      warnings.push(`look.${label}Json is not valid JSON and was ignored.`);
      return undefined;
    }
  }
  if (typeof value === "object" && value !== null) {
    return JSON.stringify(value);
  }
  warnings.push(`look.${label} must be an object or JSON string and was ignored.`);
  return undefined;
}
