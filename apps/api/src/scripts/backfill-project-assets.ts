/**
 * One-shot backfill for the project-scoped-media migration (Phase 1).
 *
 * Before this change every SourceAsset was user-level, so existing projects reference assets purely by id
 * inside their projectGraph. After scoping, a project's bin = its owned uploads + linked assets, so without
 * links those old projects' bins would go empty. This script:
 *   1. Walks every Project.projectGraph (recursively) collecting every `assetId` it references, plus the
 *      legacy Project.sourceAssetId.
 *   2. Creates a ProjectAsset link for each (project, asset) pair the user actually owns.
 *   3. For local/timeline-generated assets referenced by EXACTLY ONE project (and not already owned), sets
 *      ownerProjectId — those are genuinely that project's uploads.
 *
 * Idempotent: links are upserted; ownership only fills nulls. Safe to re-run.
 * Run: pnpm --filter @kimera-by-aelivion/api assets:backfill
 */
import { prisma } from "../lib/prisma";

/** Recursively collect every string value stored under an `assetId` key anywhere in a JSON graph. */
function collectAssetIds(value: unknown, out: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectAssetIds(item, out);
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (key === "assetId" && typeof child === "string" && child) out.add(child);
      else collectAssetIds(child, out);
    }
  }
}

async function main() {
  const projects = await prisma.project.findMany({
    select: { id: true, userId: true, projectGraph: true, sourceAssetId: true }
  });

  // assetId -> set of projectIds that reference it (used to decide sole-owner uploads).
  const assetToProjects = new Map<string, Set<string>>();
  const projectToAssets = new Map<string, { userId: string; assetIds: Set<string> }>();

  for (const project of projects) {
    const ids = new Set<string>();
    collectAssetIds(project.projectGraph, ids);
    if (project.sourceAssetId) ids.add(project.sourceAssetId);
    projectToAssets.set(project.id, { userId: project.userId, assetIds: ids });
    for (const assetId of ids) {
      if (!assetToProjects.has(assetId)) assetToProjects.set(assetId, new Set());
      assetToProjects.get(assetId)!.add(project.id);
    }
  }

  let linksCreated = 0;
  let ownersSet = 0;
  let skippedMissing = 0;

  for (const [projectId, { userId, assetIds }] of projectToAssets) {
    for (const assetId of assetIds) {
      const asset = await prisma.sourceAsset.findFirst({
        where: { id: assetId, userId },
        select: { id: true, source: true, ownerProjectId: true }
      });
      if (!asset) {
        skippedMissing += 1;
        continue;
      }

      const link = await prisma.projectAsset.upsert({
        where: { projectId_sourceAssetId: { projectId, sourceAssetId: assetId } },
        create: { projectId, sourceAssetId: assetId },
        update: {}
      });
      if (link.addedAt) linksCreated += 1; // upsert always returns a row; count is approximate for logging

      const isUpload = asset.source === "local" || asset.source === "timeline-generated" || asset.source == null;
      const soleProject = assetToProjects.get(assetId)?.size === 1;
      if (isUpload && soleProject && !asset.ownerProjectId) {
        await prisma.sourceAsset.update({ where: { id: assetId }, data: { ownerProjectId: projectId } });
        ownersSet += 1;
      }
    }
  }

  console.log(
    `Backfill complete: ${projects.length} projects scanned, ~${linksCreated} project-asset links present, ` +
      `${ownersSet} sole-owner uploads assigned, ${skippedMissing} references skipped (asset missing/foreign).`
  );
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Backfill failed:", error);
    process.exit(1);
  });
