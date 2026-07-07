import { Router } from "express";
import { createTemplateSchema, patchTemplateSchema, templateDefinitions } from "@lumio-by-aelivion/shared";
import type { Prisma } from "@prisma/client";
import { asyncHandler, getParam, HttpError, ok, validateBody } from "../lib/http";
import { asJson } from "../lib/json";
import { prisma } from "../lib/prisma";
import { requireAuth, type AuthRequest } from "../middleware/auth";

export const templatesRouter = Router();

templatesRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    const templates = await prisma.template.findMany({
      where: { active: true },
      orderBy: [{ category: "asc" }, { name: "asc" }]
    });

    return ok(res, "Templates", {
      templates: templates.length ? templates : templateDefinitions
    });
  })
);

// In-editor Templates gallery: curated (userId null) + the current user's own saved templates. Placed
// BEFORE "/:id" so Express doesn't match "mine" as an id param.
templatesRouter.get(
  "/mine",
  requireAuth,
  asyncHandler<AuthRequest>(async (req, res) => {
    const templates = await prisma.template.findMany({
      where: { active: true, OR: [{ userId: null }, { userId: req.user.id }] },
      orderBy: [{ category: "asc" }, { name: "asc" }]
    });
    return ok(res, "Templates", { templates });
  })
);

templatesRouter.delete(
  "/:id",
  requireAuth,
  asyncHandler<AuthRequest>(async (req, res) => {
    const id = getParam(req, "id");
    const existing = await prisma.template.findFirst({ where: { id, userId: req.user.id } });
    if (!existing) {
      throw new HttpError(404, "Template not found (or you don't own it)");
    }
    await prisma.template.delete({ where: { id: existing.id } });
    return ok(res, "Template deleted", { id });
  })
);

templatesRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const id = getParam(req, "id");
    const template =
      (await prisma.template.findFirst({
        where: { OR: [{ id }, { slug: id }] }
      })) ?? templateDefinitions.find((item) => item.id === id || item.slug === id);

    if (!template) {
      throw new HttpError(404, "Template not found");
    }

    return ok(res, "Template", { template });
  })
);

templatesRouter.post(
  "/",
  requireAuth,
  asyncHandler<AuthRequest>(async (req, res) => {
    const input = validateBody(createTemplateSchema, req.body);
    const template = await prisma.template.create({
      data: {
        // "Save as template" from the editor always attributes to the saving user, so it shows in
        // that user's own Templates gallery (curated templates stay userId=null, seeded separately).
        userId: req.user.id,
        name: input.name,
        slug: input.slug,
        category: input.category,
        description: input.description,
        previewUrl: input.previewUrl ?? "/assets/template-custom.jpg",
        thumbnailUrl: input.thumbnailUrl ?? "/assets/template-custom.jpg",
        durationSeconds: input.durationSeconds,
        requiredModules: asJson(input.requiredModules),
        editableFields: asJson(input.editableFields ?? []),
        templateGraph: asJson(input.templateGraph),
        active: input.active ?? true
      }
    });

    return ok(res, "Template created", { template }, 201);
  })
);

templatesRouter.patch(
  "/:id",
  requireAuth,
  asyncHandler(async (req, res) => {
    const id = getParam(req, "id");
    const input = validateBody(patchTemplateSchema, req.body);
    const existing = await prisma.template.findFirst({
      where: { OR: [{ id }, { slug: id }] }
    });

    if (!existing) {
      throw new HttpError(404, "Template not found");
    }

    const data: Prisma.TemplateUpdateInput = {};
    if (input.name !== undefined) data.name = input.name;
    if (input.slug !== undefined) data.slug = input.slug;
    if (input.category !== undefined) data.category = input.category;
    if (input.description !== undefined) data.description = input.description;
    if (input.previewUrl !== undefined) data.previewUrl = input.previewUrl;
    if (input.thumbnailUrl !== undefined) data.thumbnailUrl = input.thumbnailUrl;
    if (input.durationSeconds !== undefined) data.durationSeconds = input.durationSeconds;
    if (input.requiredModules !== undefined) data.requiredModules = asJson(input.requiredModules);
    if (input.editableFields !== undefined) data.editableFields = asJson(input.editableFields);
    if (input.templateGraph !== undefined) data.templateGraph = asJson(input.templateGraph);
    if (input.active !== undefined) data.active = input.active;

    const template = await prisma.template.update({
      where: { id: existing.id },
      data
    });

    return ok(res, "Template updated", { template });
  })
);
