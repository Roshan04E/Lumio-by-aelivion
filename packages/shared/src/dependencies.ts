import { getModule } from "./catalog";
import type { ModuleType, ProjectEffect } from "./types";

export const dependencyRules: Partial<Record<ModuleType, ModuleType[]>> = {
  TEXT_BEHIND_PERSON: ["PERSON_EXTRACTION"],
  SMART_3D_FOLLOW_TEXT: ["PERSON_EXTRACTION", "PERSON_TRACKING"],
  BACKGROUND_REPLACEMENT: ["PERSON_EXTRACTION"],
  PERSON_REMOVAL: ["PERSON_EXTRACTION"],
  FINAL_RENDER: [],
  AUTO_CAPTIONS: []
};

export function defaultConfigForModule(type: ModuleType): Record<string, unknown> {
  switch (type) {
    case "PERSON_EXTRACTION":
      return { quality: "preview", edgeMode: "fast" };
    case "PERSON_TRACKING":
      return { quality: "preview", smoothing: 0.45 };
    case "BACKGROUND_REMOVAL":
      return { quality: "preview", outputMode: "transparent" };
    case "PERSON_REMOVAL":
      return { selectionMode: "tap", inpaintQuality: "preview", feather: 6 };
    case "TEXT_BEHIND_PERSON":
      return { text: "REEL MODE", depthFeel: 0.68, textPosition: "behind_person", textColor: "#C9FF4A" };
    case "SMART_3D_FOLLOW_TEXT":
      return { text: "SKATE MODE", depthStrength: 0.7, trackingStyle: "cinematic", shadow: true, motionBlur: true };
    case "AUTO_CAPTIONS":
      return { language: "hinglish", captionStyle: "bold_yellow", punchWords: "wait,secret,proof" };
    case "BEAT_SYNC":
      return { energy: "medium" };
    case "ZOOM_CUTS":
      return { intensity: "medium", frequency: 4 };
    case "BACKGROUND_REPLACEMENT":
      return { backgroundStyle: "dark_crime", blur: 6 };
    case "MOTION_TEXT":
      return { text: "NEW DROP", style: "bold" };
    case "FINAL_RENDER":
      return { resolution: "720p", watermark: false };
    default:
      return {};
  }
}

export function createProjectEffect(type: ModuleType, config: Record<string, unknown> = {}): ProjectEffect {
  const module = getModule(type);
  const suffix =
    globalThis.crypto?.randomUUID?.().slice(0, 8) ?? Math.random().toString(36).slice(2, 10);

  return {
    id: `effect_${type.toLowerCase()}_${suffix}`,
    type,
    name: module.name,
    input: module.inputTypes,
    output: module.outputTypes,
    config: {
      ...defaultConfigForModule(type),
      ...config
    },
    status: "idle"
  };
}

export function createTemplateEffect(templateSlug: string, type: ModuleType, index: number, config: Record<string, unknown> = {}): ProjectEffect {
  const module = getModule(type);

  return {
    id: `${templateSlug}_effect_${index + 1}`,
    type,
    name: module.name,
    input: module.inputTypes,
    output: module.outputTypes,
    config: {
      ...defaultConfigForModule(type),
      ...config
    },
    status: "idle"
  };
}

export function getDependenciesForModule(type: ModuleType, existingTypes: ModuleType[] = []): ModuleType[] {
  if (type === "BACKGROUND_REPLACEMENT") {
    const hasMaskProvider = existingTypes.includes("PERSON_EXTRACTION") || existingTypes.includes("BACKGROUND_REMOVAL");
    return hasMaskProvider ? [] : ["PERSON_EXTRACTION"];
  }

  return dependencyRules[type] ?? [];
}

/**
 * Checks whether a durable artifact already stored on the project graph
 * (`editableFields` — where every tool surface persists masks/tracking)
 * satisfies a module's OUTPUT, honoring the `accepts: ["mask"/"trackingPath"]`
 * declarations in tools.ts. Returns the config patch to record on the inserted
 * effect (which artifact satisfied it), or undefined when nothing durable exists.
 * Durable = an http(s) URI every render path (including the Remotion worker)
 * can fetch — a browser-local blob:/opfs: URI never satisfies a dependency.
 */
export function artifactSatisfiesModule(
  type: ModuleType,
  editableFields: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (!editableFields) {
    return undefined;
  }
  if (type === "PERSON_EXTRACTION") {
    const mask = editableFields.maskSequence as { id?: string; matteVideoUri?: string } | undefined;
    if (mask && typeof mask.matteVideoUri === "string" && /^https?:\/\//i.test(mask.matteVideoUri)) {
      return { satisfiedByArtifact: true, maskSequenceId: mask.id };
    }
    return undefined;
  }
  if (type === "PERSON_TRACKING") {
    const track = editableFields.trackingPath as { id?: string; points?: unknown[] } | undefined;
    if (track && Array.isArray(track.points) && track.points.length > 0) {
      return { satisfiedByArtifact: true, trackingPathId: track.id };
    }
    return undefined;
  }
  return undefined;
}

export function resolveModuleInsertions(
  existingEffects: ProjectEffect[],
  requestedType: ModuleType,
  context?: { editableFields?: Record<string, unknown> | undefined }
): ProjectEffect[] {
  const existingTypes = existingEffects.map((effect) => effect.type);
  const chain: ModuleType[] = [];
  const addWithDependencies = (type: ModuleType) => {
    for (const dependency of getDependenciesForModule(type, [...existingTypes, ...chain])) {
      addWithDependencies(dependency);
    }

    if (!existingTypes.includes(type) && !chain.includes(type)) {
      chain.push(type);
    }
  };

  addWithDependencies(requestedType);
  return chain.map((type) => {
    // Thread existing durable artifacts into auto-inserted PREREQUISITES: adding
    // e.g. Text Behind Person to a project that already extracted a person mask
    // records the PERSON_EXTRACTION dependency as already satisfied ("ready",
    // config pointing at the artifact) instead of an idle effect that implies a
    // re-run. The requested module itself always inserts idle — the user asked
    // for it to run.
    if (type !== requestedType) {
      const satisfiedConfig = artifactSatisfiesModule(type, context?.editableFields);
      if (satisfiedConfig) {
        return { ...createProjectEffect(type, satisfiedConfig), status: "ready" as const };
      }
    }
    return createProjectEffect(type);
  });
}

export function estimateCreditsForEffects(effects: ProjectEffect[], durationSeconds: number): number {
  const moduleCredits = effects.reduce((total, effect) => total + getModule(effect.type).estimatedCostCredits, 0);
  return Math.max(durationSeconds, moduleCredits);
}
