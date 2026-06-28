import { Router } from "express";
import { z } from "zod";
import { asyncHandler, getParam, HttpError, ok, validateBody } from "../lib/http";
import { prisma } from "../lib/prisma";
import { serializeAsset } from "../lib/asset-serializer";
import { requireAuth, type AuthRequest } from "../middleware/auth";
import { saveBuffer } from "../services/storage.service";
import type { StockOrientation } from "@reelforge/shared";
import {
  downloadStockMedia,
  isStockProvider,
  searchStock,
  STOCK_PER_PAGE,
  stockProviderConfigured,
  type StockMediaType
} from "../services/stock.service";

export const stockRouter = Router();

function resolveProvider(req: AuthRequest) {
  const provider = getParam(req, "provider");
  if (!isStockProvider(provider)) {
    throw new HttpError(404, `Unknown stock provider: ${provider}`);
  }
  return provider;
}

/** Which providers have keys configured — lets the UI show an "add key" state cleanly. */
stockRouter.get(
  "/status",
  requireAuth,
  asyncHandler<AuthRequest>(async (_req, res) =>
    ok(res, "Stock status", {
      pexels: stockProviderConfigured("pexels"),
      pixabay: stockProviderConfigured("pixabay")
    })
  )
);

stockRouter.get(
  "/:provider/search",
  requireAuth,
  asyncHandler<AuthRequest>(async (req, res) => {
    const provider = resolveProvider(req);
    if (!stockProviderConfigured(provider)) {
      return ok(res, "Stock provider not configured", { configured: false, results: [] });
    }
    const query = typeof req.query.q === "string" ? req.query.q : "";
    const type: StockMediaType = req.query.type === "video" ? "video" : "image";
    const page = Math.max(1, Number(req.query.page) || 1);
    const orientationRaw = typeof req.query.orientation === "string" ? req.query.orientation : "all";
    const orientation: StockOrientation =
      orientationRaw === "horizontal" || orientationRaw === "vertical" || orientationRaw === "square" ? orientationRaw : "all";
    const results = await searchStock(provider, query, type, page, orientation);
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
  sourceUrl: z.string().optional()
});

stockRouter.post(
  "/:provider/import",
  requireAuth,
  asyncHandler<AuthRequest>(async (req, res) => {
    const provider = resolveProvider(req);
    if (!stockProviderConfigured(provider)) {
      throw new HttpError(501, `${provider} is not configured`);
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
        source: provider,
        folder: `stock/${provider}/${input.type}`,
        originalName: `${provider} ${input.externalId}`,
        sizeBytes: buffer.byteLength,
        externalJson: {
          provider,
          externalId: input.externalId,
          author: input.author,
          sourceUrl: input.sourceUrl,
          license: provider === "pexels" ? "Pexels License" : "Pixabay License"
        }
      }
    });

    return ok(res, "Stock asset imported", { asset: serializeAsset(asset) }, 201);
  })
);
