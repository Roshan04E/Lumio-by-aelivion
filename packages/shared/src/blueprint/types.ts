/**
 * Orreris OS — Blueprint IR core (K3, see ORRERIS_OS.md → Layer 4).
 *
 * A Blueprint is the seam between the two brains: a serializable, validated statement of
 * WHAT should happen, with zero knowledge of HOW. The IR is dialect-based (MLIR-style, not
 * a universal LLVM-style core): shared infrastructure here — goal structure, dialect
 * registry, closure driver — while each domain (color first; motion/audio later) registers
 * a dialect carrying its own payload schema and its own capability closure.
 *
 * **Capability closure is the law this module enforces:**
 *
 * > Actions are registry-validated. Blueprints are registry-validated too.
 * > Nothing abstract escapes into execution.
 *
 * `close()` must PROVE a goal is fulfillable, and the proof is the lowering itself: closure
 * computes the concrete actions the goal expands to, so an unfulfillable goal (unknown look,
 * all-neutral grade, missing capability) is a **compile-time error with a reason and
 * suggestions** — never a silent "Applied 0" at run time (the "moody no-op" regression,
 * 2026-07-18 transcript, is this module's founding test case).
 *
 * Closure may also REPAIR a goal (canonicalize a case-mismatched look name, resolve an
 * alias) — every repair is recorded and surfaced honestly, per the honest-labels invariant.
 * Targets stay OUT of the IR: lowered actions are templates; the executor binds the actual
 * layer/track ids (targeting is editor-state business, not blueprint business).
 */

import { z } from "zod";

/** One goal inside a blueprint — belongs to exactly one dialect. */
export interface BlueprintGoal<P = unknown> {
  id: string;
  dialect: string;
  /** Human summary of WHAT (never how) — provenance/explainability surface. */
  summary: string;
  payload: P;
}

export interface Blueprint {
  id: string;
  /** The user ask that produced it (provenance). */
  intent: string;
  goals: BlueprintGoal[];
}

/** A closure failure — honest, user-showable, with the nearest capabilities when known. */
export interface ClosureIssue {
  goalId: string;
  code: "unknown-dialect" | "invalid-payload" | "unknown-capability" | "empty-goal";
  message: string;
  suggestions?: string[] | undefined;
}

/** A lowered action TEMPLATE — the executor binds targets (layerId etc.) at apply time. */
export interface LoweredAction {
  actionId: string;
  params: Record<string, unknown>;
  summary: string;
}

/** A goal that passed closure: canonicalized payload + its proven lowering + any repairs. */
export interface ClosedGoal<P = unknown> {
  goal: BlueprintGoal<P>;
  actions: LoweredAction[];
  /** Human notes for every repair closure performed (e.g. `look "moody" → Noir @ 60%`). */
  repairs: string[];
}

export type CloseResult<P = unknown> =
  | { ok: true; closed: ClosedGoal<P> }
  | { ok: false; issues: ClosureIssue[] };

export interface BlueprintDialect<P = unknown> {
  id: string;
  /** Payload schema — validated by the closure driver before `close` runs. */
  schema: z.ZodType<P>;
  /** Capability closure: canonicalize, verify fulfillability, compute the lowering. */
  close(goal: BlueprintGoal<P>): CloseResult<P>;
}

// ---------------------------------------------------------------------------
// Dialect registry
// ---------------------------------------------------------------------------

const dialects = new Map<string, BlueprintDialect<never>>();

/**
 * Register a Blueprint dialect (SDK v1 surface — ORRERIS_SDK.md). Validated on entry —
 * a dialect without a schema or close() cannot honor the closure-computes-the-lowering
 * law. Duplicate ids overwrite (last write wins — HMR + deliberate overrides).
 */
export function registerBlueprintDialect<P>(dialect: BlueprintDialect<P>): boolean {
  if (!dialect?.id || typeof dialect.id !== "string" || !/^[a-z][a-z-]*$/.test(dialect.id)) {
    console.warn(`[orreris-sdk] dialect rejected: id must be a lowercase word (got ${JSON.stringify(dialect?.id)})`);
    return false;
  }
  if (!dialect.schema || typeof dialect.close !== "function") {
    console.warn(`[orreris-sdk] dialect "${dialect.id}" rejected: schema and close() are required`);
    return false;
  }
  dialects.set(dialect.id, dialect as BlueprintDialect<never>);
  return true;
}

export function getBlueprintDialect(id: string): BlueprintDialect | undefined {
  return dialects.get(id) as BlueprintDialect | undefined;
}

export function listBlueprintDialects(): string[] {
  return Array.from(dialects.keys());
}

// ---------------------------------------------------------------------------
// Closure driver
// ---------------------------------------------------------------------------

export type BlueprintCloseResult =
  | { ok: true; closed: ClosedGoal[] }
  | { ok: false; issues: ClosureIssue[] };

/**
 * Close every goal of a blueprint against the live dialect/capability registries.
 * All-or-nothing by design: a blueprint with ANY unfulfillable goal fails compilation with
 * the full issue list — partial execution of a half-valid plan is how silent no-ops happen.
 */
export function closeBlueprint(blueprint: Blueprint): BlueprintCloseResult {
  const closed: ClosedGoal[] = [];
  const issues: ClosureIssue[] = [];
  for (const goal of blueprint.goals) {
    const dialect = getBlueprintDialect(goal.dialect);
    if (!dialect) {
      issues.push({
        goalId: goal.id,
        code: "unknown-dialect",
        message: `No "${goal.dialect}" dialect is registered.`,
        suggestions: listBlueprintDialects()
      });
      continue;
    }
    const parsed = dialect.schema.safeParse(goal.payload);
    if (!parsed.success) {
      issues.push({
        goalId: goal.id,
        code: "invalid-payload",
        message: `The ${goal.dialect} goal payload is malformed: ${parsed.error.issues[0]?.message ?? "invalid"}.`
      });
      continue;
    }
    const result = dialect.close({ ...goal, payload: parsed.data });
    if (result.ok) {
      closed.push(result.closed);
    } else {
      issues.push(...result.issues);
    }
  }
  return issues.length > 0 ? { ok: false, issues } : { ok: true, closed };
}
