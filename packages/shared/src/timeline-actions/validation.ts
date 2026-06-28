import type { TimelineComposition, TimelineEffect, TimelineLayer, TimelineTrack } from "../types";
import { getTimelineEffectDefinition } from "../effects";
import type { ActionContext, ValidationIssue } from "./types";

/**
 * Shared semantic validators. These all read allowed values from the existing
 * source-of-truth registries (`timelineEffectRegistry` via `getTimelineEffectDefinition`,
 * the layer/track type unions) — never a hardcoded second list.
 */

export interface LayerLocation {
  track: TimelineTrack;
  layer: TimelineLayer;
  trackIndex: number;
  layerIndex: number;
}

/** Locate a layer (and its track) by id, or null. */
export function findLayer(composition: TimelineComposition, layerId: string): LayerLocation | null {
  for (let trackIndex = 0; trackIndex < composition.tracks.length; trackIndex += 1) {
    const track = composition.tracks[trackIndex]!;
    const layerIndex = track.layers.findIndex((item) => item.id === layerId);
    if (layerIndex !== -1) {
      return { track, layer: track.layers[layerIndex]!, trackIndex, layerIndex };
    }
  }
  return null;
}

export function findTrack(composition: TimelineComposition, trackId: string): TimelineTrack | null {
  return composition.tracks.find((track) => track.id === trackId) ?? null;
}

export function assertLayerExists(ctx: ActionContext, layerId: string, path = "layerId"): ValidationIssue[] {
  return findLayer(ctx.composition, layerId)
    ? []
    : [{ code: "invalid_layer_reference", message: `No layer with id "${layerId}"`, path }];
}

export function assertTrackExists(ctx: ActionContext, trackId: string, path = "trackId"): ValidationIssue[] {
  return findTrack(ctx.composition, trackId)
    ? []
    : [{ code: "invalid_track_reference", message: `No track with id "${trackId}"`, path }];
}

/** Effect type must exist in `timelineEffectRegistry`. */
export function assertEffectTypeKnown(type: string, path = "effectType"): ValidationIssue[] {
  return getTimelineEffectDefinition(type as TimelineEffect["type"])
    ? []
    : [{ code: "unsupported_effect_type", message: `Unknown effect type "${type}"`, path }];
}

/**
 * Validate a partial set of effect params against the registry param schema:
 * unknown keys, wrong type, and number out-of-range / bad select option all fail.
 */
export function assertEffectParamsValid(
  type: string,
  params: Record<string, unknown> | undefined,
  path = "params"
): ValidationIssue[] {
  if (!params) {
    return [];
  }
  const definition = getTimelineEffectDefinition(type as TimelineEffect["type"]);
  if (!definition) {
    return assertEffectTypeKnown(type, path);
  }
  const issues: ValidationIssue[] = [];
  for (const [key, value] of Object.entries(params)) {
    const param = definition.params.find((item) => item.key === key);
    if (!param) {
      issues.push({ code: "unknown_effect_param", message: `Effect "${type}" has no param "${key}"`, path: `${path}.${key}` });
      continue;
    }
    if (param.type === "number") {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        issues.push({ code: "invalid_effect_param", message: `Param "${key}" must be a finite number`, path: `${path}.${key}` });
      } else if (value < param.min || value > param.max) {
        issues.push({ code: "effect_param_out_of_range", message: `Param "${key}" must be ${param.min}..${param.max}`, path: `${path}.${key}` });
      }
    } else if (param.type === "boolean" && typeof value !== "boolean") {
      issues.push({ code: "invalid_effect_param", message: `Param "${key}" must be a boolean`, path: `${path}.${key}` });
    } else if (param.type === "color" && typeof value !== "string") {
      issues.push({ code: "invalid_effect_param", message: `Param "${key}" must be a color string`, path: `${path}.${key}` });
    } else if (param.type === "select") {
      const allowed = param.options.map((option) => option.value);
      if (typeof value !== "string" || !allowed.includes(value)) {
        issues.push({ code: "invalid_effect_param", message: `Param "${key}" must be one of ${allowed.join(", ")}`, path: `${path}.${key}` });
      }
    }
  }
  return issues;
}

/** Animatable layer transform properties an `addKeyframe` action may target. */
export const KEYFRAMEABLE_LAYER_PROPERTIES = [
  "position.x",
  "position.y",
  "scale",
  "rotation",
  "opacity"
] as const;

export function assertKeyframeTarget(property: string, path = "property"): ValidationIssue[] {
  return (KEYFRAMEABLE_LAYER_PROPERTIES as readonly string[]).includes(property)
    ? []
    : [
        {
          code: "unsupported_animation_target",
          message: `Cannot animate "${property}"; allowed: ${KEYFRAMEABLE_LAYER_PROPERTIES.join(", ")}`,
          path
        }
      ];
}

/** Guard against NaN/Infinity sneaking into a transform via AI params. */
export function assertFinite(value: number, label: string, path: string): ValidationIssue[] {
  return Number.isFinite(value)
    ? []
    : [{ code: "invalid_transform", message: `${label} must be a finite number`, path }];
}
