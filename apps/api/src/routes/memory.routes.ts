import { Router } from "express";
import { z } from "zod";
import { asyncHandler, getParam, ok, validateBody } from "../lib/http";
import { requireAuth, type AuthRequest } from "../middleware/auth";
import { deleteFact, listFacts, upsertFacts } from "../services/memory.service";

/**
 * Phase 11 — AI Memory OS API. Auth-gated, keyed by the JWT user. Holds small
 * reusable signals the planner uses to fill defaults ("my usual caption style").
 * No secrets, no gating — metadata only. The web client treats localStorage as
 * the offline source of truth and syncs through here when authed.
 */
export const memoryRouter = Router();

const factSchema = z.object({
  scope: z.enum(["creator", "project", "style"]),
  projectId: z.string().max(120).optional(),
  key: z.string().min(1).max(120),
  // Distilled signal only — never a raw prompt. Cap the payload.
  value: z.union([z.string().max(2000), z.number(), z.boolean(), z.array(z.string().max(200)).max(50)]),
  confidence: z.number().min(0).max(1).optional(),
  source: z.enum(["inferred", "explicit"]).optional()
});

const upsertSchema = z.object({ facts: z.array(factSchema).min(1).max(40) });

memoryRouter.get(
  "/",
  requireAuth,
  asyncHandler<AuthRequest>(async (req, res) => {
    const projectId = typeof req.query.projectId === "string" ? req.query.projectId : undefined;
    const facts = await listFacts(req.user.id, projectId);
    return ok(res, "Memory loaded", { facts });
  })
);

memoryRouter.put(
  "/",
  requireAuth,
  asyncHandler<AuthRequest>(async (req, res) => {
    const input = validateBody(upsertSchema, req.body);
    const facts = await upsertFacts(req.user.id, input.facts);
    return ok(res, "Memory saved", { facts });
  })
);

memoryRouter.delete(
  "/:id",
  requireAuth,
  asyncHandler<AuthRequest>(async (req, res) => {
    const removed = await deleteFact(req.user.id, getParam(req, "id"));
    return ok(res, removed ? "Memory forgotten" : "Nothing to forget", { removed });
  })
);
