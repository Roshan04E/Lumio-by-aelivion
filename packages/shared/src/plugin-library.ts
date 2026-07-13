import { timelineEffectRegistry, type TimelineEffectDefinition } from "./effects";
import { CREATIVE_LOOKS, type CreativeLook } from "./color/looks";
import { listTransitions, type TransitionDefinition } from "./color/transitions/registry";
import { transitionManifestToDefinition } from "./plugin-transition-adapter";
import type {
  PluginEffectManifest,
  PluginLookManifest,
  PluginManifest,
  PluginTimelineTemplateManifest,
  PluginTransitionManifest
} from "./plugin-manifest";

export type PluginSourceKind = "builtin" | "manifest" | "backend" | "imported";

export interface PluginSource {
  kind: PluginSourceKind;
  id: string;
  name: string;
  version?: string | undefined;
}

export interface RuntimePluginItem<TDefinition, TManifest extends PluginManifest | undefined = undefined> {
  id: string;
  name: string;
  description?: string | undefined;
  tags: string[];
  source: PluginSource;
  definition: TDefinition;
  manifest?: TManifest | undefined;
}

export type RuntimeEffectItem = RuntimePluginItem<TimelineEffectDefinition | PluginEffectManifest["effect"], PluginEffectManifest>;
export type RuntimeTransitionItem = RuntimePluginItem<TransitionDefinition, PluginTransitionManifest>;
export type RuntimeLookItem = RuntimePluginItem<CreativeLook | PluginLookManifest["look"], PluginLookManifest>;
export type RuntimeTemplateItem = RuntimePluginItem<PluginTimelineTemplateManifest, PluginTimelineTemplateManifest>;

export interface EffectProvider {
  readonly id: string;
  readonly name: string;
  listEffects(): RuntimeEffectItem[];
}

export interface TransitionProvider {
  readonly id: string;
  readonly name: string;
  listTransitions(): RuntimeTransitionItem[];
}

export interface LookProvider {
  readonly id: string;
  readonly name: string;
  listLooks(): RuntimeLookItem[];
}

export interface TemplateProvider {
  readonly id: string;
  readonly name: string;
  listTemplates(): RuntimeTemplateItem[];
}

const BUILTIN_SOURCE: PluginSource = { kind: "builtin", id: "kimera.builtin", name: "Kimera Built-ins" };

export const builtInEffectProvider: EffectProvider = {
  id: "kimera.builtin.effects",
  name: "Built-in Effects",
  listEffects() {
    return timelineEffectRegistry.map((definition) => ({
      id: definition.type,
      name: definition.name,
      description: definition.description,
      tags: [definition.category],
      source: BUILTIN_SOURCE,
      definition
    }));
  }
};

export const builtInTransitionProvider: TransitionProvider = {
  id: "kimera.builtin.transitions",
  name: "Built-in Transitions",
  listTransitions() {
    return listTransitions().map((definition) => ({
      id: definition.id,
      name: definition.name,
      tags: [definition.category],
      source: BUILTIN_SOURCE,
      definition
    }));
  }
};

export const builtInLookProvider: LookProvider = {
  id: "kimera.builtin.looks",
  name: "Built-in Looks",
  listLooks() {
    return CREATIVE_LOOKS.map((definition) => ({
      id: `look.${definition.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`,
      name: definition.name,
      description: definition.description,
      tags: ["look"],
      source: BUILTIN_SOURCE,
      definition
    }));
  }
};

export function createManifestEffectProvider(id: string, name: string, manifests: PluginEffectManifest[]): EffectProvider {
  const source: PluginSource = { kind: "manifest", id, name };
  return {
    id,
    name,
    listEffects() {
      return manifests.map((manifest) => ({
        id: manifest.id,
        name: manifest.name,
        description: manifest.description,
        tags: manifest.tags,
        source: { ...source, version: manifest.version },
        definition: manifest.effect,
        manifest
      }));
    }
  };
}

export function createManifestTransitionProvider(id: string, name: string, manifests: PluginTransitionManifest[]): TransitionProvider {
  const source: PluginSource = { kind: "manifest", id, name };
  return {
    id,
    name,
    listTransitions() {
      return manifests.flatMap((manifest) => {
        try {
          const definition = transitionManifestToDefinition(manifest);
          return [{
            id: manifest.id,
            name: manifest.name,
            description: manifest.description,
            tags: manifest.tags,
            source: { ...source, version: manifest.version },
            definition,
            manifest
          }];
        } catch {
          return [];
        }
      });
    }
  };
}

export function createManifestLookProvider(id: string, name: string, manifests: PluginLookManifest[]): LookProvider {
  const source: PluginSource = { kind: "manifest", id, name };
  return {
    id,
    name,
    listLooks() {
      return manifests.map((manifest) => ({
        id: manifest.id,
        name: manifest.name,
        description: manifest.description,
        tags: manifest.tags,
        source: { ...source, version: manifest.version },
        definition: manifest.look,
        manifest
      }));
    }
  };
}

export function createManifestTemplateProvider(id: string, name: string, manifests: PluginTimelineTemplateManifest[]): TemplateProvider {
  const source: PluginSource = { kind: "manifest", id, name };
  return {
    id,
    name,
    listTemplates() {
      return manifests.map((manifest) => ({
        id: manifest.id,
        name: manifest.name,
        description: manifest.description,
        tags: manifest.tags,
        source: { ...source, version: manifest.version },
        definition: manifest,
        manifest
      }));
    }
  };
}

export function listEffectLibrary(providers: EffectProvider[] = [builtInEffectProvider]): RuntimeEffectItem[] {
  return providers.flatMap((provider) => provider.listEffects());
}

export function listTransitionLibrary(providers: TransitionProvider[] = [builtInTransitionProvider]): RuntimeTransitionItem[] {
  return providers.flatMap((provider) => provider.listTransitions());
}

export function listLookLibrary(providers: LookProvider[] = [builtInLookProvider]): RuntimeLookItem[] {
  return providers.flatMap((provider) => provider.listLooks());
}

export function listTemplateLibrary(providers: TemplateProvider[] = []): RuntimeTemplateItem[] {
  return providers.flatMap((provider) => provider.listTemplates());
}
