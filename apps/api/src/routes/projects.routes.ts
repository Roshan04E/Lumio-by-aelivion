import crypto from "node:crypto";
import { Router } from "express";
import type { Prisma } from "@prisma/client";
import {
  addEffectSchema,
  applyTemplateSchema,
  createProjectSchema,
  createProjectEffect,
  createDefaultComposition,
  instantiateTemplateComposition,
  patchProjectSchema,
  resolveModuleInsertions,
  templateDefinitions,
  type ProjectGraph
} from "@orreris/shared";
import { asyncHandler, getParam, HttpError, ok, validateBody } from "../lib/http";
import { asJson, fromJson } from "../lib/json";
import { prisma } from "../lib/prisma";
import { requireAuth, type AuthRequest } from "../middleware/auth";
import { planProjectFromPrompt } from "../services/aiPlanner.service";
import { buildProjectRenderManifest, renderFinal, renderPreview } from "../services/mockProcessing.service";

export const projectsRouter = Router();

projectsRouter.post(
  "/",
  requireAuth,
  asyncHandler<AuthRequest>(async (req, res) => {
    const input = validateBody(createProjectSchema, req.body);
    const projectId = `project_${crypto.randomUUID()}`;
    const promptPlan = input.prompt ? await planProjectFromPrompt(input.prompt) : undefined;
    const templateSelector = input.templateId ?? promptPlan?.templateSlug;
    const resolvedTemplate = templateSelector ? await resolveTemplate(templateSelector) : { template: undefined, dbId: undefined };
    const template = resolvedTemplate.template;
    const templateGraph = template ? fromJson<ProjectGraph>(template.templateGraph) : undefined;
    const graph: ProjectGraph = templateGraph
      ? {
          ...templateGraph,
          projectId,
          editableFields: {
            ...templateGraph.editableFields,
            ...(promptPlan?.editableFields ?? {})
          },
          version: 1
        }
      : {
          projectId,
          // AI path seeds from the plan; the create-only goal presets seed from `input.effects`.
          effects: (promptPlan?.effects ?? input.effects ?? []).map((type) => createProjectEffect(type)),
          editableFields: promptPlan?.editableFields ?? {},
          version: 1
        };

    if (input.sourceAssetId) {
      graph.sourceAssetId = input.sourceAssetId;
    }

    // The composition/timeline duration must never truncate the actual source clip.
    // A template carries its own intentional duration; otherwise, when a real asset is
    // attached, the timeline is sized to that asset's real length plus a 1-second
    // buffer (never less than the clip itself). Only a template-less, asset-less
    // project (e.g. a blank/prompt-only draft) falls back to a short placeholder.
    // Priority: a template's own length → the real footage length (never truncated) → a goal
    // preset's target duration (footage-less drafts) → a short default.
    let timelineDurationSeconds = template?.durationSeconds ?? input.durationSeconds ?? 12;
    if (!template && input.sourceAssetId) {
      const sourceAsset = await prisma.sourceAsset.findFirst({
        where: { id: input.sourceAssetId, userId: req.user.id }
      });
      if (sourceAsset) {
        timelineDurationSeconds = sourceAsset.durationSeconds + 1;
      }
    }

    // A save-as-template carries a full authored composition: instantiate it
    // (remap ids, fill empty media slots with the uploaded asset) instead of
    // building a blank default. Module-stack templates and blank drafts still get
    // the default composition.
    if (templateGraph?.composition) {
      graph.composition = instantiateTemplateComposition(templateGraph.composition, projectId, {
        sourceAssetId: input.sourceAssetId,
        name: input.title ?? templateGraph.composition.name
      });
      timelineDurationSeconds = graph.composition.durationSeconds;
    } else {
      graph.composition = createDefaultComposition({
        id: projectId,
        name: input.title ?? "Untitled reel",
        durationSeconds: timelineDurationSeconds,
        assetId: input.sourceAssetId,
        orientation: input.orientation,
        fps: input.fps,
        // No template AND no prompt = "Continue without a template" → an empty timeline
        // (no placeholder media layer when there's no real footage).
        blank: !template && !promptPlan
      });
    }

    const project = await prisma.project.create({
      data: {
        id: projectId,
        userId: req.user.id,
        ...(resolvedTemplate.dbId ? { templateId: resolvedTemplate.dbId } : {}),
        title: input.title ?? "Untitled reel",
        ...(input.sourceAssetId ? { sourceAssetId: input.sourceAssetId } : {}),
        projectGraph: asJson(graph),
        durationSeconds: timelineDurationSeconds
      },
      include: { template: true, sourceAsset: true }
    });

    return ok(res, "Project created", { project, promptPlan }, 201);
  })
);

projectsRouter.get(
  "/",
  requireAuth,
  asyncHandler<AuthRequest>(async (req, res) => {
    const projects = await prisma.project.findMany({
      where: { userId: req.user.id },
      include: { template: true, sourceAsset: true },
      orderBy: { updatedAt: "desc" }
    });

    return ok(res, "Projects", { projects });
  })
);

projectsRouter.get(
  "/:id",
  requireAuth,
  asyncHandler<AuthRequest>(async (req, res) => {
    const id = getParam(req, "id");
    const project = await prisma.project.findFirst({
      where: { id, userId: req.user.id },
      include: { template: true, sourceAsset: true, renderJobs: { orderBy: { createdAt: "desc" } } }
    });

    if (!project) {
      throw new HttpError(404, "Project not found");
    }

    return ok(res, "Project", { project });
  })
);

projectsRouter.patch(
  "/:id",
  requireAuth,
  asyncHandler<AuthRequest>(async (req, res) => {
    const id = getParam(req, "id");
    const input = validateBody(patchProjectSchema, req.body);
    const project = await prisma.project.findFirst({ where: { id, userId: req.user.id } });

    if (!project) {
      throw new HttpError(404, "Project not found");
    }

    const data: Prisma.ProjectUpdateInput = {};
    if (input.title !== undefined) data.title = input.title;
    if (input.status !== undefined) data.status = input.status;
    if (input.durationSeconds !== undefined) data.durationSeconds = input.durationSeconds;
    if (input.projectGraph !== undefined) data.projectGraph = asJson(input.projectGraph);

    const updated = await prisma.project.update({
      where: { id: project.id },
      data,
      include: { template: true, sourceAsset: true }
    });

    return ok(res, "Project updated", { project: updated });
  })
);

projectsRouter.delete(
  "/:id",
  requireAuth,
  asyncHandler<AuthRequest>(async (req, res) => {
    const id = getParam(req, "id");
    const project = await prisma.project.findFirst({ where: { id, userId: req.user.id } });

    if (!project) {
      throw new HttpError(404, "Project not found");
    }

    await prisma.project.delete({ where: { id: project.id } });
    return ok(res, "Project deleted", { id: project.id });
  })
);

projectsRouter.post(
  "/:id/apply-template",
  requireAuth,
  asyncHandler<AuthRequest>(async (req, res) => {
    const id = getParam(req, "id");
    const input = validateBody(applyTemplateSchema, req.body);
    const [project, resolved] = await Promise.all([
      prisma.project.findFirst({ where: { id, userId: req.user.id } }),
      resolveTemplate(input.templateId)
    ]);
    const template = resolved.template;

    if (!project) {
      throw new HttpError(404, "Project not found");
    }
    if (!template) {
      throw new HttpError(404, "Template not found");
    }

    const graph: ProjectGraph = {
      ...fromJson<ProjectGraph>(template.templateGraph),
      projectId: project.id,
      version: (fromJson<ProjectGraph>(project.projectGraph).version ?? 1) + 1
    };
    if (project.sourceAssetId) {
      graph.sourceAssetId = project.sourceAssetId;
    }

    const updated = await prisma.project.update({
      where: { id: project.id },
      data: {
        ...(resolved.dbId ? { templateId: resolved.dbId } : {}),
        projectGraph: asJson(graph),
        durationSeconds: template.durationSeconds
      },
      include: { template: true, sourceAsset: true }
    });

    return ok(res, "Template applied", { project: updated });
  })
);

projectsRouter.post(
  "/:id/add-effect",
  requireAuth,
  asyncHandler<AuthRequest>(async (req, res) => {
    const id = getParam(req, "id");
    const input = validateBody(addEffectSchema, req.body);
    const project = await prisma.project.findFirst({
      where: { id, userId: req.user.id }
    });

    if (!project) {
      throw new HttpError(404, "Project not found");
    }

    const graph = fromJson<ProjectGraph>(project.projectGraph);
    const insertions = resolveModuleInsertions(graph.effects, input.type, {
      editableFields: graph.editableFields
    }).map((effect) => (effect.type === input.type ? { ...effect, config: { ...effect.config, ...input.config } } : effect));

    const updatedGraph: ProjectGraph = {
      ...graph,
      effects: [...graph.effects, ...insertions],
      version: graph.version + 1
    };

    const updated = await prisma.project.update({
      where: { id: project.id },
      data: { projectGraph: asJson(updatedGraph) },
      include: { template: true, sourceAsset: true }
    });

    return ok(res, "Effect added", { project: updated, insertedEffects: insertions });
  })
);

projectsRouter.get(
  "/:id/render-manifest",
  requireAuth,
  asyncHandler<AuthRequest>(async (req, res) => {
    const id = getParam(req, "id");
    const quality = req.query.quality === "preview" ? "preview" : "final";
    const manifest = await buildProjectRenderManifest(id, req.user.id, quality);
    res.setHeader("Content-Disposition", `attachment; filename="${id}-${quality}-manifest.json"`);
    return ok(res, "Render manifest", { manifest });
  })
);

projectsRouter.post(
  "/:id/preview",
  requireAuth,
  asyncHandler<AuthRequest>(async (req, res) => {
    const id = getParam(req, "id");
    const data = await renderPreview(id, req.user.id);
    return ok(res, "Preview generated", data);
  })
);

projectsRouter.post(
  "/:id/export",
  requireAuth,
  asyncHandler<AuthRequest>(async (req, res) => {
    const id = getParam(req, "id");
    const data = await renderFinal(id, req.user.id);
    return ok(res, "Final export generated", data);
  })
);

/**
 * Resolve a template by id/slug. `dbId` is set ONLY when a real Template row exists — it's
 * the value safe to use for the Project.templateId foreign key. The `template` (DB row OR an
 * in-memory definition) is used for the graph/duration; a constant-only template must NOT be
 * connected as a FK (that throws Project_templateId_fkey), e.g. when promoting a local draft
 * whose templateId never existed server-side.
 */
async function resolveTemplate(idOrSlug: string) {
  const dbTemplate = await prisma.template.findFirst({
    where: { OR: [{ id: idOrSlug }, { slug: idOrSlug }] }
  });
  if (dbTemplate) {
    return { template: dbTemplate, dbId: dbTemplate.id };
  }
  const constant = templateDefinitions.find((template) => template.id === idOrSlug || template.slug === idOrSlug);
  return { template: constant, dbId: undefined as string | undefined };
}
