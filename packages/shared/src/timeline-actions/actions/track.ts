import { z } from "zod";
import type { TimelineTrack } from "../../types";
import { actionResult, runMutation } from "../patches";
import { assertTrackExists } from "../validation";
import type { TimelineActionDefinition } from "../types";
import { freshId } from "./shared";

const createTrackSchema = z.object({
  type: z.enum(["video", "text", "audio", "overlay"]),
  name: z.string().max(120).optional(),
  index: z.number().int().min(0).optional()
});

const createTrack: TimelineActionDefinition<z.infer<typeof createTrackSchema>> = {
  id: "createTrack",
  name: "Create track",
  description: "Add a new empty track.",
  category: "track",
  inputSchema: createTrackSchema,
  validationRules: () => [],
  canUndo: true,
  execute: (params, ctx) => {
    const track: TimelineTrack = {
      id: freshId(`track_${params.type}`),
      type: params.type,
      name: params.name ?? `${params.type[0]!.toUpperCase()}${params.type.slice(1)} track`,
      layers: []
    };
    const mutation = runMutation(ctx.composition, (draft) => {
      if (params.index !== undefined && params.index <= draft.tracks.length) {
        draft.tracks.splice(params.index, 0, track);
      } else {
        draft.tracks.push(track);
      }
    });
    return actionResult(ctx.composition, mutation, `Create ${params.type} track`);
  }
};

const deleteTrackSchema = z.object({ trackId: z.string() });

const deleteTrack: TimelineActionDefinition<z.infer<typeof deleteTrackSchema>> = {
  id: "deleteTrack",
  name: "Delete track",
  description: "Remove a track and all its layers.",
  category: "track",
  inputSchema: deleteTrackSchema,
  validationRules: (params, ctx) => assertTrackExists(ctx, params.trackId),
  canUndo: true,
  execute: (params, ctx) => {
    const mutation = runMutation(ctx.composition, (draft) => {
      draft.tracks = draft.tracks.filter((track) => track.id !== params.trackId);
    });
    return actionResult(ctx.composition, mutation, `Delete track`);
  }
};

export const trackActions = [createTrack, deleteTrack];
