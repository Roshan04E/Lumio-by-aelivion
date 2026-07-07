import { recordExecutionTime, timelineActionRegistry, type TimelineComposition } from "@lumio-by-aelivion/shared";
import type { AiPlan, PlanStep, PlannerContext, StepProgress } from "../types";

export interface ToolStepResult {
  applied: boolean;
  /** If the tool changed the composition, the executor re-syncs from here. */
  composition?: TimelineComposition | undefined;
  detail?: string | undefined;
}

export interface ExecutorDeps {
  /** Fresh editor context (composition/selection/playhead) at execution start. */
  getContext: () => PlannerContext;
  /** Commit one applied step to the editor (records one undo entry). */
  commitComposition: (after: TimelineComposition, summary: string) => Promise<void> | void;
  /** Open an existing tool window; resolves when the user applies or cancels. */
  openTool?: (step: PlanStep) => Promise<ToolStepResult>;
  /**
   * Run a Skill step (e.g. AI asset generation). Image tasks generate and land an asset
   * inline; video tasks hand off to the Generate Studio. Resolves like a tool step:
   * `applied` true when something was done/queued, with an optional new composition.
   */
  runSkillStep?: (step: PlanStep) => Promise<ToolStepResult>;
  /** Ask the user a question; resolves with their answer or null if dismissed. */
  askClarify?: (question: string) => Promise<string | null>;
  /** Progress callback for the UI. */
  onProgress: (update: StepProgress) => void;
}

export interface ExecutionReport {
  applied: number;
  failed: number;
  skipped: number;
  /** Layer ids created or modified by this run — feeds P5 follow-up context. */
  targetLayerIds: string[];
  /** Wall-clock duration in ms. */
  durationMs: number;
}

function layerIdSet(composition: TimelineComposition): Set<string> {
  const ids = new Set<string>();
  for (const track of composition.tracks) {
    for (const layer of track.layers) {
      ids.add(layer.id);
    }
  }
  return ids;
}

/**
 * Runs an approved plan step-by-step. `timelineAction` steps go through the
 * Timeline Action Registry (validated, reversible) and are committed to the
 * editor's existing snapshot-undo — one entry per step, so the whole AI session
 * is undoable. `tool` steps open the existing tool window and PAUSE on
 * `requiresInput` for the user to confirm before resuming.
 */
export async function executePlan(plan: AiPlan, deps: ExecutorDeps): Promise<ExecutionReport> {
  const startedAt = Date.now();
  const report: ExecutionReport = { applied: 0, failed: 0, skipped: 0, targetLayerIds: [], durationMs: 0 };
  let working = deps.getContext();
  const initialLayerIds = layerIdSet(working.composition);
  const touched = new Set<string>();

  for (const step of plan.steps) {
    deps.onProgress({ stepId: step.id, status: "running" });

    if (step.kind === "timelineAction" && step.actionId) {
      const outcome = timelineActionRegistry.execute(
        step.actionId,
        step.params,
        { composition: working.composition, selection: working.selection, nowSeconds: working.nowSeconds },
        { ai: true }
      );
      if (outcome.ok) {
        await deps.commitComposition(outcome.result.after, outcome.result.summary);
        working = { ...working, composition: outcome.result.after };
        const explicitTarget = (step.params as { layerId?: string } | undefined)?.layerId;
        if (explicitTarget) {
          touched.add(explicitTarget);
        }
        report.applied += 1;
        deps.onProgress({ stepId: step.id, status: "done", detail: outcome.result.summary });
      } else {
        report.failed += 1;
        deps.onProgress({ stepId: step.id, status: "failed", detail: outcome.message });
      }
      continue;
    }

    if (step.kind === "tool") {
      if (!deps.openTool) {
        report.skipped += 1;
        deps.onProgress({ stepId: step.id, status: "skipped", detail: "Tool execution not available here" });
        continue;
      }
      const result = await deps.openTool(step);
      if (result.applied) {
        if (result.composition) {
          working = { ...deps.getContext(), composition: result.composition };
        } else {
          working = deps.getContext();
        }
        report.applied += 1;
        deps.onProgress({ stepId: step.id, status: "done", detail: result.detail });
      } else {
        report.skipped += 1;
        deps.onProgress({ stepId: step.id, status: "skipped", detail: result.detail ?? "Cancelled" });
      }
      continue;
    }

    if (step.kind === "skill") {
      if (!deps.runSkillStep) {
        report.skipped += 1;
        deps.onProgress({ stepId: step.id, status: "skipped", detail: "Generation not available here" });
        continue;
      }
      const result = await deps.runSkillStep(step);
      if (result.applied) {
        working = result.composition ? { ...deps.getContext(), composition: result.composition } : deps.getContext();
        report.applied += 1;
        deps.onProgress({ stepId: step.id, status: "done", detail: result.detail });
      } else {
        report.skipped += 1;
        deps.onProgress({ stepId: step.id, status: "skipped", detail: result.detail ?? "Cancelled" });
      }
      continue;
    }

    // clarify — pause and ask in chat; an answer resolves the step, dismissal skips it.
    if (deps.askClarify && step.question) {
      const answer = await deps.askClarify(step.question);
      if (answer && answer.trim()) {
        report.applied += 1;
        deps.onProgress({ stepId: step.id, status: "done", detail: answer });
        continue;
      }
    }
    report.skipped += 1;
    deps.onProgress({ stepId: step.id, status: "skipped" });
  }

  // Newly created layers (present at the end, absent at the start) are also targets.
  for (const id of layerIdSet(working.composition)) {
    if (!initialLayerIds.has(id)) {
      touched.add(id);
    }
  }
  report.targetLayerIds = [...touched];
  report.durationMs = Date.now() - startedAt;
  if (report.applied > 0) {
    recordExecutionTime(report.durationMs);
  }
  return report;
}
