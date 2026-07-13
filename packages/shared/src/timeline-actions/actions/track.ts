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
      } else if (params.type === "audio") {
        draft.tracks.push(track);
      } else {
        // Visual tracks land ON TOP by default (tracks[0] draws above everything) — the same
        // placement as the editor's "Add visual layer" button, so AI-created tracks don't hide
        // their content under existing clips. Audio stays at the bottom of the stack.
        draft.tracks.unshift(track);
      }
    });
    // The id rides in the result line — the agent loop's NEXT step needs it (e.g. create a
    // track, then moveLayer.trackId onto it; real transcript failed for lack of exactly this).
    return actionResult(ctx.composition, mutation, `Create ${params.type} track (id: ${track.id})`);
  }
};

const reorderTrackSchema = z
  .object({
    trackId: z.string(),
    /** Absolute destination index in the track stack (0 = topmost). */
    toIndex: z.number().int().min(0).optional(),
    position: z.enum(["top", "bottom"]).optional()
  })
  .refine((value) => (value.toIndex !== undefined) !== (value.position !== undefined), {
    message: "Provide exactly one of toIndex or position"
  });

/**
 * Stacking order: BOTH renderers draw tracks[0] ON TOP — the web preview paints entries in
 * descending trackIndex (index 0 last), and the render manifest computes
 * `zIndex = visualTracks.length - trackIndex`. So "top" = index 0, "bottom" = end of array.
 */
const reorderTrack: TimelineActionDefinition<z.infer<typeof reorderTrackSchema>> = {
  id: "reorderTrack",
  name: "Reorder track",
  description: "Move a whole track up or down the stack (top = drawn above everything).",
  category: "track",
  inputSchema: reorderTrackSchema,
  validationRules: (params, ctx) => assertTrackExists(ctx, params.trackId),
  canUndo: true,
  execute: (params, ctx) => {
    let destination = 0;
    const mutation = runMutation(ctx.composition, (draft) => {
      const from = draft.tracks.findIndex((track) => track.id === params.trackId);
      if (from === -1) {
        return;
      }
      const [track] = draft.tracks.splice(from, 1);
      destination =
        params.position === "top" ? 0
        : params.position === "bottom" ? draft.tracks.length
        : Math.min(params.toIndex ?? 0, draft.tracks.length);
      draft.tracks.splice(destination, 0, track!);
    });
    const moved = ctx.composition.tracks.find((track) => track.id === params.trackId);
    const label = params.position ?? `index ${destination}`;
    return actionResult(ctx.composition, mutation, `Move track "${moved?.name ?? params.trackId}" to the ${label} of the stack`);
  }
};

const deleteTrackSchema = z.object({ trackId: z.string() });

const deleteTrack: TimelineActionDefinition<z.infer<typeof deleteTrackSchema>> = {
  id: "deleteTrack",
  name: "Delete track",
  description: "Remove a track and all its clips.",
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

export const trackActions = [createTrack, reorderTrack, deleteTrack];
