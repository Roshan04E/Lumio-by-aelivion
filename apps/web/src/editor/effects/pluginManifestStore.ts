import {
  pluginEffectManifestSchema,
  pluginLookManifestSchema,
  pluginTransitionManifestSchema,
  registerEffectManifest,
  registerLookManifest,
  registerTransitionManifest,
  type PluginEffectManifest,
  type PluginCatalogPackage,
  type PluginLookManifest,
  type PluginTransitionManifest
} from "@kimera-by-aelivion/shared";

const STORE_KEY = "kimera.importedPluginLibrary.v1";
const HIDDEN_EFFECTS_KEY = "kimera.hiddenImportedEffectIds.v1";
const HIDDEN_LOOKS_KEY = "kimera.hiddenImportedLookIds.v1";
const HIDDEN_TRANSITIONS_KEY = "kimera.hiddenImportedTransitionIds.v1";

export interface ImportedPluginLibrary {
  effects: PluginEffectManifest[];
  looks: PluginLookManifest[];
  transitions: PluginTransitionManifest[];
}

export const EMPTY_IMPORTED_PLUGIN_LIBRARY: ImportedPluginLibrary = {
  effects: [],
  looks: [],
  transitions: []
};

export function normalizeImportedPluginLibrary(value: unknown): ImportedPluginLibrary {
  if (!value || typeof value !== "object") {
    return EMPTY_IMPORTED_PLUGIN_LIBRARY;
  }
  const source = value as { effects?: unknown; looks?: unknown; transitions?: unknown };
  return {
    effects: Array.isArray(source.effects)
      ? source.effects.flatMap((item) => {
          const parsed = pluginEffectManifestSchema.safeParse(item);
          return parsed.success ? [parsed.data] : [];
        })
      : [],
    looks: Array.isArray(source.looks)
      ? source.looks.flatMap((item) => {
          const parsed = pluginLookManifestSchema.safeParse(item);
          return parsed.success ? [parsed.data] : [];
        })
      : [],
    transitions: Array.isArray(source.transitions)
      ? source.transitions.flatMap((item) => {
          const parsed = pluginTransitionManifestSchema.safeParse(item);
          return parsed.success ? [parsed.data] : [];
        })
      : []
  };
}

export function loadImportedPluginLibrary(): ImportedPluginLibrary {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    return raw ? normalizeImportedPluginLibrary(JSON.parse(raw)) : EMPTY_IMPORTED_PLUGIN_LIBRARY;
  } catch {
    return EMPTY_IMPORTED_PLUGIN_LIBRARY;
  }
}

export function saveImportedPluginLibrary(library: ImportedPluginLibrary): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(library));
  } catch {
    /* ignore quota/private-mode failures; project graph still persists when available */
  }
}

export function loadHiddenEffectManifestIds(): Set<string> {
  return loadHiddenManifestIds(HIDDEN_EFFECTS_KEY);
}

export function saveHiddenEffectManifestIds(ids: Set<string>): void {
  saveHiddenManifestIds(HIDDEN_EFFECTS_KEY, ids);
}

export function loadHiddenLookManifestIds(): Set<string> {
  return loadHiddenManifestIds(HIDDEN_LOOKS_KEY);
}

export function saveHiddenLookManifestIds(ids: Set<string>): void {
  saveHiddenManifestIds(HIDDEN_LOOKS_KEY, ids);
}

export function loadHiddenTransitionManifestIds(): Set<string> {
  return loadHiddenManifestIds(HIDDEN_TRANSITIONS_KEY);
}

export function saveHiddenTransitionManifestIds(ids: Set<string>): void {
  saveHiddenManifestIds(HIDDEN_TRANSITIONS_KEY, ids);
}

function loadHiddenManifestIds(key: string): Set<string> {
  try {
    const raw = localStorage.getItem(key);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : []);
  } catch {
    return new Set();
  }
}

function saveHiddenManifestIds(key: string, ids: Set<string>): void {
  try {
    localStorage.setItem(key, JSON.stringify([...ids]));
  } catch {
    /* ignore quota/private-mode failures */
  }
}

export function pluginPackagesToImportedLibrary(packages: PluginCatalogPackage[]): ImportedPluginLibrary {
  const library: ImportedPluginLibrary = { effects: [], looks: [], transitions: [] };
  for (const item of packages) {
    if (item.kind === "effect") {
      const parsed = pluginEffectManifestSchema.safeParse(item.manifest);
      if (parsed.success) library.effects.push(parsed.data);
    } else if (item.kind === "look") {
      const parsed = pluginLookManifestSchema.safeParse(item.manifest);
      if (parsed.success) library.looks.push(parsed.data);
    } else if (item.kind === "transition") {
      const parsed = pluginTransitionManifestSchema.safeParse(item.manifest);
      if (parsed.success) library.transitions.push(parsed.data);
    }
  }
  return library;
}

export function mergeEffectManifest(library: ImportedPluginLibrary, manifest: PluginEffectManifest): ImportedPluginLibrary {
  return {
    ...library,
    effects: [manifest, ...library.effects.filter((item) => item.id !== manifest.id)]
  };
}

export function removeEffectManifest(library: ImportedPluginLibrary, manifestId: string): ImportedPluginLibrary {
  return {
    ...library,
    effects: library.effects.filter((item) => item.id !== manifestId)
  };
}

export function mergeTransitionManifest(library: ImportedPluginLibrary, manifest: PluginTransitionManifest): ImportedPluginLibrary {
  return {
    ...library,
    transitions: [manifest, ...library.transitions.filter((item) => item.id !== manifest.id)]
  };
}

export function removeTransitionManifest(library: ImportedPluginLibrary, manifestId: string): ImportedPluginLibrary {
  return {
    ...library,
    transitions: library.transitions.filter((item) => item.id !== manifestId)
  };
}

export function mergeLookManifest(library: ImportedPluginLibrary, manifest: PluginLookManifest): ImportedPluginLibrary {
  return {
    ...library,
    looks: [manifest, ...library.looks.filter((item) => item.id !== manifest.id)]
  };
}

export function removeLookManifest(library: ImportedPluginLibrary, manifestId: string): ImportedPluginLibrary {
  return {
    ...library,
    looks: library.looks.filter((item) => item.id !== manifestId)
  };
}

export function hydrateTransitionManifests(manifests: PluginTransitionManifest[]): string[] {
  const warnings: string[] = [];
  for (const manifest of manifests) {
    try {
      const result = registerTransitionManifest(manifest, { override: true });
      warnings.push(...result.warnings);
    } catch (error) {
      warnings.push(error instanceof Error ? error.message : `Could not register transition ${manifest.id}.`);
    }
  }
  return warnings;
}

/** Registers webgl-fragment effect manifests' GLSL as fragment-effect defs; no-op for other engines. */
export function hydrateEffectManifests(manifests: PluginEffectManifest[]): string[] {
  const warnings: string[] = [];
  for (const manifest of manifests) {
    try {
      const result = registerEffectManifest(manifest, { override: true });
      warnings.push(...result.warnings);
    } catch (error) {
      warnings.push(error instanceof Error ? error.message : `Could not register effect ${manifest.id}.`);
    }
  }
  return warnings;
}

export function hydrateLookManifests(manifests: PluginLookManifest[]): string[] {
  const warnings: string[] = [];
  for (const manifest of manifests) {
    try {
      const result = registerLookManifest(manifest, { override: true });
      warnings.push(...result.warnings);
    } catch (error) {
      warnings.push(error instanceof Error ? error.message : `Could not register look ${manifest.id}.`);
    }
  }
  return warnings;
}
