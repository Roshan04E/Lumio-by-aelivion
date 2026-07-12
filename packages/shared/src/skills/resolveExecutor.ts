import { executorRegistry, type ToolExecutor } from "./executor-registry";
import type { DeviceCapabilityFlag } from "./skill-types";

/**
 * The "which executor is capable" resolver for TOOL skill tasks — the exact analog of
 * `resolveModels` for generation. Given a task kind, live device capability flags, and whether
 * a cloud tool service is reachable (always false today — contract stub), return the
 * capable+available executors ranked best-first. Local-first bias: a browser-real executor
 * outranks cloud/mock whenever the device supports it, mirroring the free-local-first behavior
 * of the generation resolver.
 */

export interface ExecutorAvailability {
  /** Live device capability flags (from the web capability detector). */
  device: Partial<Record<DeviceCapabilityFlag, boolean>>;
  /** Whether the cloud tool service is reachable/configured (false today — contract stub). */
  cloud: boolean;
}

export type ExecutorPref = "localFirst" | "quality" | "speed";

export interface ResolveExecutorTask {
  taskKind: string;
}

export interface RankedExecutor {
  executor: ToolExecutor;
  score: number;
  reason: string;
}

function isAvailable(executor: ToolExecutor, availability: ExecutorAvailability): boolean {
  if (executor.availabilityReq === "always") {
    return true; // mock
  }
  if (executor.availabilityReq === "cloudKey") {
    return availability.cloud; // cloud stub
  }
  return executor.deviceFlags.every((flag) => availability.device[flag] === true); // browser-real
}

function isCapable(executor: ToolExecutor, task: ResolveExecutorTask): boolean {
  return executor.taskKinds.includes(task.taskKind);
}

function scoreExecutor(executor: ToolExecutor, pref: ExecutorPref): { score: number; reason: string } {
  let score = 0;
  const reasons: string[] = [];

  if (executor.kind === "browser-real") {
    score += pref === "localFirst" ? 100 : 50;
    reasons.push("local/free");
  } else if (executor.kind === "cloud") {
    score += 30;
    reasons.push("cloud");
  } else {
    reasons.push("mock");
  }

  if (pref === "quality") {
    const q = executor.qualityTier === "high" ? 40 : executor.qualityTier === "standard" ? 20 : 0;
    score += q;
    if (q > 0) reasons.push(`${executor.qualityTier} quality`);
  } else if (pref === "speed") {
    const s = executor.latencyClass === "fast" ? 40 : executor.latencyClass === "medium" ? 20 : 0;
    score += s;
    if (s > 0) reasons.push(`${executor.latencyClass} latency`);
  }

  score += Math.max(0, 20 - executor.cost);

  return { score, reason: reasons.join(", ") || executor.label };
}

export function resolveExecutors(
  task: ResolveExecutorTask,
  availability: ExecutorAvailability,
  pref: ExecutorPref = "localFirst"
): RankedExecutor[] {
  return executorRegistry
    .filter((executor) => isCapable(executor, task) && isAvailable(executor, availability))
    .map((executor) => {
      const { score, reason } = scoreExecutor(executor, pref);
      return { executor, score, reason };
    })
    .sort((a, b) => b.score - a.score || a.executor.cost - b.executor.cost);
}

/** Convenience: the single best executor, or undefined when nothing is capable+available. */
export function resolveBestExecutor(
  task: ResolveExecutorTask,
  availability: ExecutorAvailability,
  pref: ExecutorPref = "localFirst"
): RankedExecutor | undefined {
  return resolveExecutors(task, availability, pref)[0];
}
