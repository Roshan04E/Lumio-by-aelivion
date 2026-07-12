/**
 * Editor Command Plane (v1) — the second control surface next to the Timeline Action Registry.
 *
 * Timeline actions mutate the COMPOSITION (persisted, undoable, exported). Editor commands drive
 * the EDITOR ITSELF — tool switching, transport, playhead, selection, preview quality, snapping —
 * the state a voice user needs instant hands-free control over ("pan mode", "pause", "select
 * clip 3", "half resolution"). They are:
 *   - non-destructive view/transport state (no approval bar in ANY mode; reversible by saying
 *     the opposite),
 *   - executed by a dispatcher EditorPage provides (it owns all the setters),
 *   - Zod-validated here like timeline actions, and compiled ONLY by the brain's tier-0
 *     precision rules (zero tokens, <5 ms — voice latency class). LLM-tier exposure is v2.
 */

import { z } from "zod";

export const editorCommandSchemas = {
  /** Switch the timeline tool (V/H/C/R/U equivalents). */
  setTool: z.object({
    tool: z.enum(["select", "blade", "hand", "roll", "slide"])
  }),
  /** Transport: play/pause/toggle, JKL shuttle, stop. */
  transport: z.object({
    op: z.enum(["play", "pause", "toggle", "shuttleForward", "shuttleBack", "stop"])
  }),
  /** Move the playhead. Exactly one of the fields should be set. */
  seek: z.object({
    toSeconds: z.number().min(0).max(7200).optional(),
    deltaSeconds: z.number().min(-7200).max(7200).optional(),
    target: z.enum(["start", "end", "nextCut", "prevCut", "nextMarker", "prevMarker"]).optional(),
    /** Frame-step (positive = forward). */
    frames: z.number().int().min(-240).max(240).optional()
  }),
  /** Select one clip (layerId pre-resolved by the brain) or clear the selection. */
  selectClip: z.object({
    layerId: z.string().optional(),
    clear: z.boolean().optional()
  }),
  /** Preview resolution: the ¼ / ½ / 1 / Auto control. */
  setPreviewQuality: z.object({
    quality: z.enum(["quarter", "half", "full", "auto"])
  }),
  setSnapping: z.object({
    on: z.boolean().optional(),
    toggle: z.boolean().optional()
  }),
  /** The editor's global history (distinct from the AI panel's own revert). */
  editorUndoRedo: z.object({
    op: z.enum(["undo", "redo"])
  }),
  /** Open the local export dialog (the dialog itself is the confirmation step). */
  openExport: z.object({}),
  /** Open/close a workspace panel: the left browse tabs, or the right Inspector. */
  openPanel: z.object({
    panel: z.enum(["assets", "effects", "color", "settings", "inspector"]),
    op: z.enum(["open", "close", "toggle"]).default("open")
  })
} as const;

export type EditorCommandId = keyof typeof editorCommandSchemas;

export type EditorCommandParams<Id extends EditorCommandId = EditorCommandId> = z.infer<
  (typeof editorCommandSchemas)[Id]
>;

export interface EditorCommandResult {
  ok: boolean;
  /** Short confirmation (or refusal) line — voice/TTS-ready ("🖐 Hand tool"). */
  say: string;
}

/** Implemented by EditorPage (it owns every setter); consumed by the AI panel. */
export type EditorCommandDispatcher = (id: EditorCommandId, params: unknown) => EditorCommandResult;

export function validateEditorCommand(id: EditorCommandId, params: unknown): { ok: boolean; errors: string[] } {
  const schema = editorCommandSchemas[id];
  const result = schema.safeParse(params ?? {});
  return result.success
    ? { ok: true, errors: [] }
    : { ok: false, errors: result.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`) };
}

export function isEditorCommandId(id: string): id is EditorCommandId {
  return Object.prototype.hasOwnProperty.call(editorCommandSchemas, id);
}

/** One-liners for the capabilities answer / future planner catalog. */
export const editorCommandSummaries: Record<EditorCommandId, string> = {
  setTool: "switch the timeline tool (select / hand-pan / blade / roll / slide)",
  transport: "play, pause, shuttle (JKL) and stop playback",
  seek: "move the playhead (to a time, start/end, next/previous cut or marker, frame steps)",
  selectClip: "select a clip by number, or clear the selection",
  setPreviewQuality: "set preview resolution (¼ / ½ / full / auto)",
  setSnapping: "turn timeline snapping on/off",
  editorUndoRedo: "editor-wide undo/redo",
  openExport: "open the export dialog",
  openPanel: "open/close workspace panels (media pool, effects, color, project settings, inspector)"
};
