import { recordExecuted, recordFailed, recordRejected } from "./analytics";
import type { ActionContext, TimelineActionDefinition, TimelineActionResult, ValidationIssue } from "./types";

export interface RegistrySuccess {
  ok: true;
  result: TimelineActionResult;
}

export interface RegistryError {
  ok: false;
  code: "unknown_action" | "invalid_params" | "validation_failed" | "execution_error";
  message: string;
  issues?: ValidationIssue[] | undefined;
}

export type RegistryOutcome = RegistrySuccess | RegistryError;

export interface ExecuteOptions {
  /** Mark this invocation as AI-generated for analytics. */
  ai?: boolean | undefined;
}

/**
 * The Timeline Action Registry. The single approved gate for timeline mutation:
 * it rejects unknown actions, malformed params (zod), and failed semantic
 * validation BEFORE running, and never throws into the caller — failures come
 * back as a typed `RegistryError`.
 */
export class TimelineActionRegistry {
  private readonly actions = new Map<string, TimelineActionDefinition<unknown>>();

  register<P>(definition: TimelineActionDefinition<P>): this {
    if (this.actions.has(definition.id)) {
      throw new Error(`Timeline action "${definition.id}" is already registered`);
    }
    this.actions.set(definition.id, definition as TimelineActionDefinition<unknown>);
    return this;
  }

  has(id: string): boolean {
    return this.actions.has(id);
  }

  get(id: string): TimelineActionDefinition<unknown> | undefined {
    return this.actions.get(id);
  }

  list(): TimelineActionDefinition<unknown>[] {
    return [...this.actions.values()];
  }

  execute(id: string, rawParams: unknown, ctx: ActionContext, options: ExecuteOptions = {}): RegistryOutcome {
    const definition = this.actions.get(id);
    if (!definition) {
      recordRejected(id);
      return { ok: false, code: "unknown_action", message: `Unknown timeline action "${id}"` };
    }

    const parsed = definition.inputSchema.safeParse(rawParams);
    if (!parsed.success) {
      recordRejected(id);
      return {
        ok: false,
        code: "invalid_params",
        message: `Malformed params for "${id}"`,
        issues: parsed.error.issues.map((issue) => ({
          code: issue.code,
          message: issue.message,
          path: issue.path.join(".")
        }))
      };
    }

    const issues = definition.validationRules(parsed.data, ctx);
    if (issues.length > 0) {
      recordRejected(id);
      // The issue messages ride IN the message: agent-loop result lines only surface `message`,
      // and a bare "Validation failed" left the model guessing params blind (real transcript:
      // three moveLayer retries with invented track ids).
      return { ok: false, code: "validation_failed", message: `Validation failed for "${id}": ${issues.map((issue) => issue.message).join("; ")}`, issues };
    }

    try {
      const result = definition.execute(parsed.data, ctx);
      recordExecuted(id, { ai: options.ai });
      return { ok: true, result };
    } catch (error) {
      recordFailed(id);
      return { ok: false, code: "execution_error", message: error instanceof Error ? error.message : String(error) };
    }
  }
}
