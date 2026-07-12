import { z } from "zod";
import { normalizeTimelineMarkers } from "../../timeline-ops";
import { actionResult, runMutation } from "../patches";
import type { TimelineActionDefinition } from "../types";

/**
 * Marker actions — registry parity for the timeline's ruler bookmarks, so the AI agent can work
 * with markers like a human editor does (D2 of the agent plan). Markers live at
 * `composition.settings.timeline.markers` (legacy bare-number entries tolerated — always
 * normalized before writing). Editor-only data: no render effect, safe to auto-apply.
 */

const EPSILON = 0.01;

const addMarkerSchema = z.object({
  timeSeconds: z.number().min(0),
  name: z.string().max(80).optional(),
  color: z.string().max(40).optional()
});

const addMarker: TimelineActionDefinition<z.infer<typeof addMarkerSchema>> = {
  id: "addMarker",
  name: "Add marker",
  description: "Add a named/colored bookmark to the timeline ruler at a time (seconds).",
  category: "clip",
  inputSchema: addMarkerSchema,
  validationRules: () => [],
  canUndo: true,
  execute: (params, ctx) => {
    const mutation = runMutation(ctx.composition, (draft) => {
      if (!draft.settings) {
        return;
      }
      const existing = normalizeTimelineMarkers(draft.settings.timeline.markers);
      if (existing.some((marker) => Math.abs(marker.timeSeconds - params.timeSeconds) < EPSILON)) {
        return; // already a marker there — idempotent
      }
      draft.settings.timeline.markers = [
        ...existing,
        {
          timeSeconds: params.timeSeconds,
          ...(params.name ? { name: params.name } : {}),
          ...(params.color ? { color: params.color } : {})
        }
      ].sort((a, b) => a.timeSeconds - b.timeSeconds);
    });
    return actionResult(ctx.composition, mutation, `Add marker at ${params.timeSeconds.toFixed(2)}s`);
  }
};

const removeMarkerSchema = z.object({
  timeSeconds: z.number().min(0)
});

const removeMarker: TimelineActionDefinition<z.infer<typeof removeMarkerSchema>> = {
  id: "removeMarker",
  name: "Remove marker",
  description: "Remove the timeline marker nearest to a time (within 0.25s).",
  category: "clip",
  inputSchema: removeMarkerSchema,
  validationRules: (params, ctx) => {
    const markers = normalizeTimelineMarkers(ctx.composition.settings?.timeline.markers);
    return markers.some((marker) => Math.abs(marker.timeSeconds - params.timeSeconds) <= 0.25)
      ? []
      : [{ code: "marker_not_found", message: "No marker within 0.25s of that time", path: "timeSeconds" }];
  },
  canUndo: true,
  execute: (params, ctx) => {
    const mutation = runMutation(ctx.composition, (draft) => {
      if (!draft.settings) {
        return;
      }
      const markers = normalizeTimelineMarkers(draft.settings.timeline.markers);
      const nearest = [...markers].sort(
        (a, b) => Math.abs(a.timeSeconds - params.timeSeconds) - Math.abs(b.timeSeconds - params.timeSeconds)
      )[0];
      if (!nearest) {
        return;
      }
      draft.settings.timeline.markers = markers.filter((marker) => marker !== nearest);
    });
    return actionResult(ctx.composition, mutation, `Remove marker near ${params.timeSeconds.toFixed(2)}s`);
  }
};

const addMarkersAtTimesSchema = z.object({
  /** Timeline times in seconds — e.g. detected beats. Bounded so a bad plan can't flood the ruler. */
  times: z.array(z.number().min(0)).min(1).max(500),
  /** Optional name prefix; markers become "prefix 1", "prefix 2", … */
  namePrefix: z.string().max(60).optional(),
  color: z.string().max(40).optional()
});

const addMarkersAtTimes: TimelineActionDefinition<z.infer<typeof addMarkersAtTimesSchema>> = {
  id: "addMarkersAtTimes",
  name: "Add markers at times",
  description: "Add a batch of markers at the given times (seconds) — e.g. every detected beat.",
  category: "clip",
  inputSchema: addMarkersAtTimesSchema,
  validationRules: () => [],
  canUndo: true,
  execute: (params, ctx) => {
    let added = 0;
    const mutation = runMutation(ctx.composition, (draft) => {
      if (!draft.settings) {
        return;
      }
      const existing = normalizeTimelineMarkers(draft.settings.timeline.markers);
      const merged = [...existing];
      params.times.forEach((time, index) => {
        if (merged.some((marker) => Math.abs(marker.timeSeconds - time) < EPSILON)) {
          return;
        }
        merged.push({
          timeSeconds: time,
          ...(params.namePrefix ? { name: `${params.namePrefix} ${index + 1}` } : {}),
          ...(params.color ? { color: params.color } : {})
        });
        added += 1;
      });
      draft.settings.timeline.markers = merged.sort((a, b) => a.timeSeconds - b.timeSeconds);
    });
    return actionResult(ctx.composition, mutation, `Add ${added} marker${added === 1 ? "" : "s"}`);
  }
};

export const markerActions = [addMarker, removeMarker, addMarkersAtTimes];
