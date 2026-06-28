import type { ZodType } from "zod";
import type { TimelineComposition } from "../types";
import type { Patch } from "immer";

/**
 * Timeline Action Registry — type contracts.
 *
 * This is the ONLY approved mechanism for AI to mutate the timeline. AI never
 * touches `TimelineLayer` / `TimelineTrack` / `TimelineComposition` / effects /
 * keyframes directly; it may only invoke registered, validated, reversible
 * actions. Actions WRAP the existing pure ops (`timeline-ops.ts`, `captions.ts`,
 * `masks.ts`, `effects.ts`) — they never reimplement mutation logic, and they
 * never touch rendering (the render manifest stays the contract).
 */

export type ActionCategory =
  | "text"
  | "layer"
  | "clip"
  | "effect"
  | "keyframe"
  | "transition"
  | "track"
  | "group"
  | "mask";

/** A single validation problem. Empty array from `validationRules` means "ok". */
export interface ValidationIssue {
  code: string;
  message: string;
  /** Optional dotted path into the params that caused the issue. */
  path?: string | undefined;
}

/** Context every action runs against. The composition is treated as immutable. */
export interface ActionContext {
  composition: TimelineComposition;
  /** Current playhead time (seconds) — used for "insert at now" semantics. */
  nowSeconds: number;
  /** Currently selected layer ids (used when params omit an explicit target). */
  selection: string[];
}

/**
 * The reversible output of an action. `patch`/`undoPatch` are immer JSON patches
 * (granular replay/analytics); `before`/`after` are full snapshots (the reliable
 * source of truth the editor's existing snapshot-undo already relies on).
 */
export interface TimelineActionResult {
  before: TimelineComposition;
  after: TimelineComposition;
  patch: Patch[];
  undoPatch: Patch[];
  /** Human one-liner for the Plan Review / Changes list, e.g. `Add text "WARNING"`. */
  summary: string;
}

export interface TimelineActionDefinition<P> {
  id: string;
  name: string;
  description: string;
  category: ActionCategory;
  /** Zod schema — the registry rejects params that don't parse before running. */
  inputSchema: ZodType<P>;
  /** Semantic checks against the composition (layer refs, effect types, …). */
  validationRules: (params: P, ctx: ActionContext) => ValidationIssue[];
  /** Pure: returns a reversible result, never mutates `ctx.composition`. */
  execute: (params: P, ctx: ActionContext) => TimelineActionResult;
  canUndo: boolean;
}
