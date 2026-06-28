import type { ModuleType } from "@reelforge/shared";

export const workerJobTypes = [
  "PROCESS_PERSON_EXTRACTION",
  "PROCESS_BACKGROUND_REMOVAL",
  "PROCESS_TRACKING",
  "PROCESS_CAPTIONS",
  "RENDER_PREVIEW",
  "RENDER_FINAL"
] as const;

export type WorkerJobType = (typeof workerJobTypes)[number];

export interface WorkerJobPayload {
  id: string;
  type: WorkerJobType;
  projectId?: string;
  sourceAssetId?: string;
  userId: string;
  moduleType?: ModuleType;
  config?: Record<string, unknown>;
}

export const demoJobs: WorkerJobPayload[] = [
  {
    id: "mock_job_person",
    type: "PROCESS_PERSON_EXTRACTION",
    userId: "demo",
    sourceAssetId: "asset_demo",
    moduleType: "PERSON_EXTRACTION"
  },
  {
    id: "mock_job_preview",
    type: "RENDER_PREVIEW",
    userId: "demo",
    projectId: "project_demo"
  }
];
