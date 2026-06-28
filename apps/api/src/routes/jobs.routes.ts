import { Router } from "express";
import { asyncHandler, getParam, HttpError, ok } from "../lib/http";
import { prisma } from "../lib/prisma";
import { requireAuth, type AuthRequest } from "../middleware/auth";

export const jobsRouter = Router();

jobsRouter.get(
  "/",
  requireAuth,
  asyncHandler<AuthRequest>(async (req, res) => {
    const jobs = await prisma.renderJob.findMany({
      where: { userId: req.user.id },
      include: { project: { select: { id: true, title: true } } },
      orderBy: { createdAt: "desc" }
    });

    return ok(res, "Jobs", { jobs });
  })
);

jobsRouter.get(
  "/:id",
  requireAuth,
  asyncHandler<AuthRequest>(async (req, res) => {
    const id = getParam(req, "id");
    const job = await prisma.renderJob.findFirst({
      where: { id, userId: req.user.id }
    });

    if (!job) {
      throw new HttpError(404, "Job not found");
    }

    return ok(res, "Job", { job });
  })
);

jobsRouter.post(
  "/:id/cancel",
  requireAuth,
  asyncHandler<AuthRequest>(async (req, res) => {
    const id = getParam(req, "id");
    const job = await prisma.renderJob.findFirst({
      where: { id, userId: req.user.id }
    });

    if (!job) {
      throw new HttpError(404, "Job not found");
    }

    if (job.status === "completed") {
      throw new HttpError(409, "Completed jobs cannot be cancelled");
    }

    const updated = await prisma.renderJob.update({
      where: { id: job.id },
      data: { status: "cancelled", progress: 0 }
    });

    return ok(res, "Job cancelled", { job: updated });
  })
);
