/**
 * Executor resolver test.
 *
 * `resolveExecutors` is the "which runtime can execute this tool task" resolver
 * (packages/shared/src/skills/resolveExecutor.ts) — the tool analog of `resolveModels`.
 * This asserts the behavior the tool-skill routing depends on:
 *   - local-first: a device with Web Workers ranks the free browser-real executor above
 *     cloud/mock;
 *   - graceful degradation: a device with no capable flags still resolves to the always-on
 *     mock executor, never an empty result;
 *   - cloud ranks below browser-real even when "available" (contract stub, still real when
 *     the flag flips on later);
 *   - every tool task kind registered in the skill registry has at least one capable
 *     executor, so the registry can't silently drift out of sync with the skills.
 */

import assert from "node:assert/strict";
import { resolveExecutors, skillRegistry, type ExecutorAvailability } from "@kimera-by-aelivion/shared";

const DEVICE_READY: ExecutorAvailability = { device: { webWorkers: true }, cloud: false };
const DEVICE_READY_CLOUD: ExecutorAvailability = { device: { webWorkers: true }, cloud: true };
const DEVICE_NONE: ExecutorAvailability = { device: {}, cloud: false };

const toolTaskIds = skillRegistry
  .flatMap((skill) => skill.taskKinds)
  .filter((task) => task.execution === "tool")
  .map((task) => task.id);

assert.ok(toolTaskIds.length > 0, "at least one tool task kind is registered");

// 1. Local-first: with Web Workers available, the top pick for a tool task is browser-real.
{
  const ranked = resolveExecutors({ taskKind: "extract-person" }, DEVICE_READY, "localFirst");
  assert.ok(ranked.length > 0, "extract-person has candidates when the device supports it");
  assert.equal(ranked[0]!.executor.kind, "browser-real", "extract-person top pick is browser-real");
  assert.equal(ranked[0]!.executor.cost, 0, "browser-real pick is free");
}

// 2. No device flags → only the always-on mock executor is returned (never empty).
{
  const ranked = resolveExecutors({ taskKind: "extract-person" }, DEVICE_NONE, "localFirst");
  assert.ok(ranked.length > 0, "mock keeps the task resolvable even with no device support");
  assert.ok(
    ranked.every((r) => r.executor.kind === "mock"),
    "only mock executors are returned when the device has no capable flags"
  );
}

// 3. Cloud available still ranks below browser-real under localFirst.
{
  const ranked = resolveExecutors({ taskKind: "extract-person" }, DEVICE_READY_CLOUD, "localFirst");
  const browserIdx = ranked.findIndex((r) => r.executor.kind === "browser-real");
  const cloudIdx = ranked.findIndex((r) => r.executor.kind === "cloud");
  assert.ok(browserIdx >= 0 && cloudIdx >= 0, "both browser-real and cloud executors are present");
  assert.ok(browserIdx < cloudIdx, "browser-real outranks cloud under localFirst");
}

// 4. Every tool task kind from the skill registry has at least one capable executor
//    under full device availability.
{
  for (const taskId of toolTaskIds) {
    const ranked = resolveExecutors({ taskKind: taskId }, DEVICE_READY, "localFirst");
    assert.ok(ranked.length > 0, `registry covers tool task kind ${taskId}`);
  }
}

// 5. Speed preference ranks a fast executor above a slow one for the same task, when both exist.
{
  const ranked = resolveExecutors({ taskKind: "auto-caption" }, DEVICE_READY_CLOUD, "speed");
  const fastIdx = ranked.findIndex((r) => r.executor.latencyClass === "fast");
  const slowIdx = ranked.findIndex((r) => r.executor.latencyClass === "slow");
  if (fastIdx >= 0 && slowIdx >= 0) {
    assert.ok(fastIdx < slowIdx, "speed pref ranks fast executor first");
  }
}

console.log("executor-resolver-test: OK");
