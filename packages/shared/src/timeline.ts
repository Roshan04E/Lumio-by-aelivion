import type { ProjectGraph, TimelineComposition, TimelineLayer, TimelineTrack } from "./types";

const portrait = {
  width: 1080,
  height: 1920,
  fps: 30
};

export function createDefaultComposition(input: {
  id: string;
  name: string;
  durationSeconds: number;
  assetId?: string | undefined;
}): TimelineComposition {
  const duration = clamp(input.durationSeconds, 6, 7200);
  // Deliberately raw: the main clip carries no auto color-grade/grain and no fade-in
  // (see layer() below) - what the user uploaded is exactly what renders, frame 0
  // onward, full opacity, unaltered. No placeholder "Hook caption"/"CTA caption" text
  // is auto-inserted either; the text track starts empty for the user (or a tool's
  // Apply step) to fill in deliberately, not have copy appear they never asked for.
  const mediaLayer = layer({
    id: `${input.id}_media_1`,
    trackId: `${input.id}_track_video`,
    type: "video",
    name: "Main clip",
    startSeconds: 0,
    durationSeconds: duration,
    assetId: input.assetId,
    fit: "cover"
  });
  const audioLayer = layer({
    id: `${input.id}_audio_bed`,
    trackId: `${input.id}_track_audio`,
    type: "audio",
    name: "Music bed",
    startSeconds: 0,
    durationSeconds: duration,
    muted: false
  });

  return {
    id: `composition_${input.id}`,
    name: input.name,
    width: portrait.width,
    height: portrait.height,
    fps: portrait.fps,
    durationSeconds: duration,
    backgroundColor: "#07080C",
    settings: {
      viewport: {
        preset: "vertical_1080x1920",
        width: portrait.width,
        height: portrait.height,
        fps: portrait.fps,
        backgroundColor: "#07080C",
        resizeBehavior: "keep-layout"
      },
      timeline: {
        baseDurationSeconds: duration,
        autoGrow: true,
        tailPaddingSeconds: 1,
        snapSeconds: 0.1,
        timeDisplay: "seconds"
      }
    },
    tracks: [
      track(`${input.id}_track_text`, "video", "Video 2", []),
      track(`${input.id}_track_video`, "video", "Video 1", [mediaLayer]),
      track(`${input.id}_track_audio`, "audio", "Audio 1", [audioLayer])
    ]
  };
}

export function ensureComposition(graph: ProjectGraph, input: { name: string; durationSeconds: number }): TimelineComposition {
  if (graph.composition) {
    return graph.composition;
  }

  return createDefaultComposition({
    id: graph.projectId,
    name: input.name,
    durationSeconds: input.durationSeconds,
    assetId: graph.sourceAssetId
  });
}

export function flattenTimelineLayers(composition: TimelineComposition): TimelineLayer[] {
  return composition.tracks.flatMap((trackItem) => trackItem.layers);
}

/**
 * Premiere-style work area: when in/out points are set on the timeline, clip the composition to that
 * sub-range. Layers fully outside the range are dropped; layers straddling an edge are trimmed (with
 * `sourceInSeconds` advanced by the trimmed head so the media stays in sync); everything is shifted so
 * the in-point becomes t=0; and `durationSeconds` collapses to the range length. Returns the
 * composition UNCHANGED (same reference) when no in/out point is set — so the full-project export path
 * stays byte-identical. Mirrors the cloud render path (`buildRenderManifest`) so local export honors
 * the work area the same way. The returned composition has its in/out points cleared (already applied).
 */
export function clipCompositionToWorkArea(composition: TimelineComposition): TimelineComposition {
  const inRaw = composition.settings?.timeline.inPointSeconds;
  const outRaw = composition.settings?.timeline.outPointSeconds;
  if (inRaw === undefined && outRaw === undefined) return composition;

  const clampRange = (value: number, lo: number, hi: number) => Math.min(Math.max(value, lo), hi);
  const inPoint = clampRange(inRaw ?? 0, 0, composition.durationSeconds);
  const outPoint = clampRange(outRaw ?? composition.durationSeconds, inPoint, composition.durationSeconds);
  const rangeDurationSeconds = Math.max(1 / composition.fps, outPoint - inPoint);

  const tracks: TimelineTrack[] = composition.tracks.map((trackItem) => ({
    ...trackItem,
    layers: trackItem.layers.flatMap((layer) => {
      const layerStart = layer.startSeconds;
      const layerEnd = layer.startSeconds + layer.durationSeconds;
      if (layerEnd <= inPoint || layerStart >= outPoint) return [];
      const clippedStart = Math.max(layerStart, inPoint);
      const clippedEnd = Math.min(layerEnd, outPoint);
      const trimmedFromHeadSeconds = clippedStart - layerStart;
      const next: TimelineLayer = {
        ...layer,
        startSeconds: clippedStart - inPoint,
        durationSeconds: clippedEnd - clippedStart
      };
      if (layer.sourceInSeconds !== undefined) {
        next.sourceInSeconds = layer.sourceInSeconds + trimmedFromHeadSeconds;
      }
      return [next];
    })
  }));

  return {
    ...composition,
    durationSeconds: rangeDurationSeconds,
    tracks,
    ...(composition.settings
      ? { settings: { ...composition.settings, timeline: { ...composition.settings.timeline, inPointSeconds: undefined, outPointSeconds: undefined } } }
      : {})
  };
}

export function updateTimelineLayer(
  composition: TimelineComposition,
  layerId: string,
  updater: (layer: TimelineLayer) => TimelineLayer
): TimelineComposition {
  return {
    ...composition,
    tracks: composition.tracks.map((trackItem) => ({
      ...trackItem,
      layers: trackItem.layers.map((item) => (item.id === layerId ? updater(item) : item))
    }))
  };
}

function track(id: string, type: TimelineTrack["type"], name: string, layers: TimelineLayer[]): TimelineTrack {
  return { id, type, name, layers };
}

/** No default fade/animation - a freshly created layer is raw: full opacity from its own start, unanimated, until the user (or a tool) deliberately adds a keyframe. */
function layer(input: Partial<TimelineLayer> & Pick<TimelineLayer, "id" | "trackId" | "type" | "name">): TimelineLayer {
  return {
    startSeconds: 0,
    durationSeconds: 3,
    fontFamily: "Inter",
    fontSize: 64,
    color: "#FFFFFF",
    transform: {
      position: { x: 50, y: 50 },
      scale: 1,
      rotation: 0,
      opacity: 100
    },
    effects: [],
    keyframes: [],
    ...input
  };
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

/**
 * Build a reusable template composition from an edited project composition. Slot
 * layers (or, when none are marked, the primary media layer + every text layer,
 * auto-marked here) keep their styling/effects/keyframes but shed project-specific
 * bindings: `media` slots lose their `assetId`/`matte` so the template ships empty,
 * `text` slots keep their copy as the default. This is what `POST /templates`
 * persists in `Template.templateGraph.composition`.
 */
export function buildTemplateGraphFromProject(graph: ProjectGraph): ProjectGraph {
  const composition = graph.composition;
  if (!composition) {
    return graph;
  }
  const withSlots = ensureTemplateSlots(composition);
  const editableFields: Record<string, unknown> = { ...graph.editableFields };
  const tracks = withSlots.tracks.map((trackItem) => ({
    ...trackItem,
    layers: trackItem.layers.map((item) => {
      if (!item.slot) {
        return item;
      }
      if (item.slot.kind === "text") {
        editableFields[item.slot.key] = item.text ?? "";
        return item;
      }
      if (item.slot.kind === "color") {
        editableFields[item.slot.key] = item.color ?? "#FFFFFF";
        return item;
      }
      // media slot: ship empty so the user's asset fills it on instantiation.
      return { ...item, assetId: undefined, matte: undefined };
    })
  }));
  return {
    ...graph,
    editableFields,
    composition: { ...withSlots, tracks }
  };
}

/**
 * Auto-mark template slots when the author hasn't marked any: the first media
 * layer with an asset becomes the main media slot, and every text layer becomes a
 * text slot. Idempotent - if any slot already exists, the composition is returned
 * unchanged so manual marking always wins.
 */
export function ensureTemplateSlots(composition: TimelineComposition): TimelineComposition {
  const hasSlot = flattenTimelineLayers(composition).some((item) => item.slot);
  if (hasSlot) {
    return composition;
  }
  let mediaMarked = false;
  let textIndex = 0;
  return {
    ...composition,
    tracks: composition.tracks.map((trackItem) => ({
      ...trackItem,
      layers: trackItem.layers.map((item) => {
        if (!mediaMarked && (item.type === "video" || item.type === "image") && item.assetId) {
          mediaMarked = true;
          return { ...item, slot: { key: "media_main", label: "Main media", kind: "media" as const, replaceable: true } };
        }
        if (item.type === "text") {
          textIndex += 1;
          return { ...item, slot: { key: `text_${textIndex}`, label: item.name || `Text ${textIndex}`, kind: "text" as const, replaceable: true } };
        }
        return item;
      })
    }))
  };
}

/**
 * Instantiate a template's stored composition into a fresh project. Track/layer
 * ids are remapped from the template's project token to the new project id so the
 * `${projectId}_*` naming convention stays coherent; empty media slots are filled
 * with the user's uploaded asset. Durations, effects, keyframes, `sourceInSeconds`
 * and matte refs are preserved verbatim.
 */
export function instantiateTemplateComposition(
  templateComposition: TimelineComposition,
  newProjectId: string,
  options?: { sourceAssetId?: string | undefined; name?: string | undefined }
): TimelineComposition {
  const clone = structuredClone(templateComposition);
  const oldProjectToken = clone.id.replace(/^composition_/, "");
  const remapId = (id: string) => (oldProjectToken ? id.split(oldProjectToken).join(newProjectId) : id);
  return {
    ...clone,
    id: `composition_${newProjectId}`,
    name: options?.name ?? clone.name,
    tracks: clone.tracks.map((trackItem) => ({
      ...trackItem,
      id: remapId(trackItem.id),
      layers: trackItem.layers.map((item) => {
        const next: TimelineLayer = { ...item, id: remapId(item.id), trackId: remapId(item.trackId) };
        if (item.slot?.kind === "media" && item.slot.replaceable && options?.sourceAssetId && !item.assetId) {
          next.assetId = options.sourceAssetId;
        }
        return next;
      })
    }))
  };
}
