import { Router } from "express";
import { z } from "zod";
import { asyncHandler, HttpError, ok, validateBody } from "../lib/http";
import { prisma } from "../lib/prisma";
import { serializeAsset } from "../lib/asset-serializer";
import { requireAuth, type AuthRequest } from "../middleware/auth";
import { saveBuffer } from "../services/storage.service";
import type { StockOrientation } from "@kimera-by-aelivion/shared";
import { downloadStockMedia, searchStock, STOCK_PER_PAGE, stockProviderConfigured, type StockMediaType } from "../services/stock.service";

export const stockRouter = Router();

// Provider-less routes: the UI is one unified Search surface, so no provider name is ever exposed here
// (today this fans out to Pexels only; adding a source later stays additive in stock.service.ts).

/** Whether stock search is configured at all — lets the UI show an "unconfigured" empty state cleanly. */
stockRouter.get(
  "/status",
  requireAuth,
  asyncHandler<AuthRequest>(async (_req, res) => ok(res, "Stock status", { configured: stockProviderConfigured("pexels") }))
);

stockRouter.get(
  "/search",
  requireAuth,
  asyncHandler<AuthRequest>(async (req, res) => {
    if (!stockProviderConfigured("pexels")) {
      return ok(res, "Stock search not configured", { configured: false, results: [] });
    }
    const query = typeof req.query.q === "string" ? req.query.q : "";
    const type: StockMediaType = req.query.type === "video" ? "video" : "image";
    const page = Math.max(1, Number(req.query.page) || 1);
    const orientationRaw = typeof req.query.orientation === "string" ? req.query.orientation : "all";
    const orientation: StockOrientation =
      orientationRaw === "horizontal" || orientationRaw === "vertical" || orientationRaw === "square" ? orientationRaw : "all";
    const results = await searchStock("pexels", query, type, page, orientation);
    return ok(res, "Stock results", { configured: true, results, page, perPage: STOCK_PER_PAGE });
  })
);

const importSchema = z.object({
  externalId: z.string().min(1),
  type: z.enum(["image", "video"]),
  downloadUrl: z.string().url(),
  width: z.coerce.number().min(1).default(1080),
  height: z.coerce.number().min(1).default(1920),
  durationSeconds: z.coerce.number().min(0).optional(),
  fileType: z.string().default("image/jpeg"),
  author: z.string().optional(),
  sourceUrl: z.string().optional(),
  // Project-scoped import (Phase 1 rule): imported stock lands in the requesting project's bin.
  projectId: z.string().trim().min(1).optional()
});

stockRouter.post(
  "/import",
  requireAuth,
  asyncHandler<AuthRequest>(async (req, res) => {
    if (!stockProviderConfigured("pexels")) {
      throw new HttpError(501, "Stock search is not configured");
    }
    const input = validateBody(importSchema, req.body);
    const { buffer, fileName } = await downloadStockMedia(input.downloadUrl, input.externalId, input.type);
    const fileUrl = await saveBuffer(buffer, fileName);

    const asset = await prisma.sourceAsset.create({
      data: {
        userId: req.user.id,
        fileName,
        fileType: input.fileType ?? (input.type === "image" ? "image/jpeg" : "video/mp4"),
        fileUrl,
        cloudUrl: fileUrl,
        durationSeconds: Math.max(1, Math.ceil(input.durationSeconds ?? (input.type === "image" ? 5 : 12))),
        width: input.width ?? 1080,
        height: input.height ?? 1920,
        status: "ready",
        source: "pexels",
        folder: `stock/pexels/${input.type}`,
        originalName: `pexels ${input.externalId}`,
        sizeBytes: buffer.byteLength,
        // Stock is a reusable library asset (ownerProjectId stays null); link it into the requesting
        // project so it shows in that project's bin without being bound to it.
        ...(input.projectId ? { projectLinks: { create: { projectId: input.projectId } } } : {}),
        externalJson: {
          provider: "pexels",
          externalId: input.externalId,
          author: input.author,
          sourceUrl: input.sourceUrl,
          license: "Pexels License"
        }
      }
    });

    return ok(res, "Stock asset imported", { asset: serializeAsset(asset) }, 201);
  })
);
