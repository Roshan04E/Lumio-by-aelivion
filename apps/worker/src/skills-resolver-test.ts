/**
 * Skill model-resolver test.
 *
 * `resolveModels` is the "which model is capable of this task, and is it available"
 * resolver (packages/shared/src/skills/resolveModels.ts). This asserts the behavior the
 * asset-generation feature depends on:
 *   - local-first: an image task ranks the free local model above cloud when a local
 *     endpoint is reachable;
 *   - cloud-only video: a video task has no local candidate and resolves to fal;
 *   - availability filtering: no capable model → empty result (caller surfaces "connect
 *     a generator");
 *   - capability filtering: a task whose inputs/constraints no model satisfies → empty.
 * Every task kind in the shipped skill must have at least one capable model when fully
 * available, so the registry can't drift out of sync with the skill.
 */

import assert from "node:assert/strict";
import {
  assetGenerationSkill,
  resolveModels,
  type GenerationAvailability,
  type ResolveTask
} from "@orreris/shared";

const ALL: GenerationAvailability = { falKey: true, localEndpoint: true, byoKey: true };
const CLOUD_ONLY: GenerationAvailability = { falKey: true, localEndpoint: false, byoKey: false };
const LOCAL_ONLY: GenerationAvailability = { falKey: false, localEndpoint: true, byoKey: false };
const NONE: GenerationAvailability = { falKey: false, localEndpoint: false, byoKey: false };

const t2i: ResolveTask = { taskKind: "text-to-image", modality: "image", inputs: ["text"] };
const t2v: ResolveTask = { taskKind: "text-to-video", modality: "video", inputs: ["text"] };

// 1. Local-first: with a reachable local endpoint the top image model is local (free).
{
  const ranked = resolveModels(t2i, ALL, "localFirst");
  assert.ok(ranked.length > 0, "image task has candidates when fully available");
  assert.equal(ranked[0]!.model.provider, "local", "image top pick is local under localFirst");
  assert.equal(ranked[0]!.model.cost, 0, "local pick is free");
}

// 2. Cloud-only video: no local candidate; resolves to fal.
{
  const ranked = resolveModels(t2v, ALL, "localFirst");
  assert.ok(ranked.length > 0, "video task has candidates when fully available");
  assert.ok(ranked.every((r) => r.model.provider === "fal"), "video is cloud-only (fal)");
}

// 3. Video with only a local endpoint (no fal key) → nothing capable+available.
{
  const ranked = resolveModels(t2v, LOCAL_ONLY, "localFirst");
  assert.equal(ranked.length, 0, "video with local-only availability resolves to nothing");
}

// 4. Image with only cloud availability still resolves (to fal), just not local.
{
  const ranked = resolveModels(t2i, CLOUD_ONLY, "localFirst");
  assert.ok(ranked.length > 0, "image resolves on cloud-only");
  assert.ok(ranked.every((r) => r.model.provider === "fal"), "cloud-only image picks fal");
}

// 5. No availability at all → empty for every task kind.
{
  for (const task of assetGenerationSkill.taskKinds) {
    const ranked = resolveModels(
      { taskKind: task.id, modality: task.modality, inputs: task.inputs, constraints: task.capabilityReq.constraints },
      NONE
    );
    assert.equal(ranked.length, 0, `no availability → empty for ${task.id}`);
  }
}

// 6. Every shipped task kind has at least one capable model when fully available.
{
  for (const task of assetGenerationSkill.taskKinds) {
    const ranked = resolveModels(
      { taskKind: task.id, modality: task.modality, inputs: task.inputs, constraints: task.capabilityReq.constraints },
      ALL
    );
    assert.ok(ranked.length > 0, `registry covers task kind ${task.id}`);
  }
}

// 7. Constraint filtering: a 30s video exceeds every model's max duration → empty.
{
  const longVideo: ResolveTask = {
    taskKind: "text-to-video",
    modality: "video",
    inputs: ["text"],
    constraints: { maxDurationSeconds: 30 }
  };
  const ranked = resolveModels(longVideo, ALL, "localFirst");
  assert.equal(ranked.length, 0, "over-long video exceeds all model durations → empty");
}

// 8. Speed preference ranks a fast model above a slow one for the same task.
{
  const ranked = resolveModels(t2i, CLOUD_ONLY, "speed");
  const fastIdx = ranked.findIndex((r) => r.model.latencyClass === "fast");
  const slowIdx = ranked.findIndex((r) => r.model.latencyClass !== "fast");
  if (fastIdx >= 0 && slowIdx >= 0) {
    assert.ok(fastIdx < slowIdx, "speed pref ranks fast model first");
  }
}

console.log("skills-resolver-test: OK");
