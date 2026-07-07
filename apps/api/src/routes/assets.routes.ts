import multer from "multer";
import { Router } from "express";
import { createAssetSchema, moduleTypeSchema, normalizeSourceColorMetadata } from "@lumio-by-aelivion/shared";
import { z } from "zod";
import { asyncHandler, getParam, HttpError, ok, validateBody } from "../lib/http";
import { prisma } from "../lib/prisma";
import { serializeAsset } from "../lib/asset-serializer";
import { asJson } from "../lib/json";
import { requireAuth, type AuthRequest } from "../middleware/auth";
import { processSourceAsset } from "../services/mockProcessing.service";
import { deleteAsset, saveUpload } from "../services/storage.service";

// 1 GiB: real camera/phone footage regularly exceeds the old 250MB cap (LIMIT_FILE_SIZE in the
// 2026-07-05 soak). Kept on memoryStorage for now, so this is also the per-request RAM bound —
// going higher than this needs disk/stream storage first, not a bigger number here.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 1024 * 1024 * 1024 }
});

export const assetsRouter = Router();

assetsRouter.get(
  "/",
  requireAuth,
  asyncHandler<AuthRequest>(async (req, res) => {
    const assets = await prisma.sourceAsset.findMany({
      where: { userId: req.user.id },
      orderBy: { createdAt: "desc" }
    });

    return ok(res, "Assets", { assets: assets.map(serializeAsset) });
  })
);

assetsRouter.post(
  "/",
  requireAuth,
  upload.single("file"),
  asyncHandler<AuthRequest>(async (req, res) => {
    const input = validateBody(createAssetSchema, {
      ...req.body,
      fileName: req.file?.originalname ?? req.body.fileName,
      fileType: req.file?.mimetype ?? req.body.fileType
    });
    const fileName = input.fileName ?? "demo-clip.mp4";
    const fileType = input.fileType ?? "video/mp4";
    const fileUrl = await saveUpload(req.file, fileName);

    const asset = await prisma.sourceAsset.create({
      data: {
        userId: req.user.id,
        fileName,
        fileType,
        fileUrl,
        // A server-uploaded file is reachable over HTTP, so it doubles as the cloud copy.
        cloudUrl: fileUrl,
        // durationSeconds is an Int column but a real clip's length is rarely a whole
        // number - round up (never down) so a stored duration never under-represents
        // the actual clip, which would risk the timeline truncating it.
        durationSeconds: Math.max(1, Math.ceil(input.durationSeconds ?? 12)),
        width: input.width ?? 1080,
        height: input.height ?? 1920,
        status: "uploaded",
        source: input.source ?? "local",
        folder: input.folder ?? null,
        originalName: input.originalName ?? fileName,
        thumbnailUrl: input.thumbnailUrl ?? null,
        fps: input.fps ?? null,
        sizeBytes: input.sizeBytes ?? (req.file ? req.file.size : null),
        projectId: input.projectId ?? null,
        // Json columns: only set when present (explicit `undefined` is rejected under
        // exactOptionalPropertyTypes).
        ...(input.tags ? { tags: input.tags } : {}),
        ...(input.external ? { externalJson: input.external } : {}),
        ...(input.ai ? { aiJson: input.ai } : {}),
        // Re-normalize the client-detected color to the canonical SourceColorMetadata shape before storing.
        ...(input.color ? { colorJson: asJson(normalizeSourceColorMetadata(input.color)) } : {})
      }
    });

    return ok(res, "Asset uploaded", { asset: serializeAsset(asset) }, 201);
  })
);

assetsRouter.get(
  "/:id",
  requireAuth,
  asyncHandler<AuthRequest>(async (req, res) => {
    const id = getParam(req, "id");
    const asset = await prisma.sourceAsset.findFirst({
      where: { id, userId: req.user.id },
      include: { derivedAssets: true }
    });

    if (!asset) {
      throw new HttpError(404, "Asset not found");
    }

    return ok(res, "Asset", { asset: serializeAsset(asset), derivedAssets: asset.derivedAssets });
  })
);

assetsRouter.patch(
  "/:id",
  requireAuth,
  asyncHandler<AuthRequest>(async (req, res) => {
    const id = getParam(req, "id");
    const input = validateBody(
      z.object({
        folder: z.string().trim().max(120).nullable().optional(),
        // Free-form metadata tags; the editor also stores its color label here as "label:<color>".
        tags: z.array(z.string().trim().min(1).max(60)).max(50).optional()
      }),
      req.body
    );
    const asset = await prisma.sourceAsset.findFirst({
      where: { id, userId: req.user.id }
    });

    if (!asset) {
      throw new HttpError(404, "Asset not found");
    }

    const data: { folder?: string | null; tags?: string[] } = {};
    if (input.folder !== undefined) data.folder = input.folder || null;
    if (input.tags !== undefined) data.tags = input.tags;
    const updated = await prisma.sourceAsset.update({
      where: { id: asset.id },
      data
    });

    return ok(res, "Asset updated", { asset: serializeAsset(updated) });
  })
);

assetsRouter.delete(
  "/:id",
  requireAuth,
  asyncHandler<AuthRequest>(async (req, res) => {
    const id = getParam(req, "id");
    const asset = await prisma.sourceAsset.findFirst({
      where: { id, userId: req.user.id }
    });

    if (!asset) {
      throw new HttpError(404, "Asset not found");
    }

    await prisma.sourceAsset.delete({ where: { id: asset.id } });
    await deleteAsset(asset.fileUrl);

    return ok(res, "Asset deleted", { id: asset.id });
  })
);

assetsRouter.get(
  "/:id/derived",
  requireAuth,
  asyncHandler<AuthRequest>(async (req, res) => {
    const id = getParam(req, "id");
    const asset = await prisma.sourceAsset.findFirst({
      where: { id, userId: req.user.id }
    });

    if (!asset) {
      throw new HttpError(404, "Asset not found");
    }

    const derivedAssets = await prisma.derivedAsset.findMany({
      where: { sourceAssetId: id },
      orderBy: { createdAt: "desc" }
    });

    return ok(res, "Derived assets", { derivedAssets });
  })
);

assetsRouter.post(
  "/:id/process",
  requireAuth,
  asyncHandler<AuthRequest>(async (req, res) => {
    const id = getParam(req, "id");
    const input = validateBody(
      z.object({
        moduleType: moduleTypeSchema.default("PERSON_EXTRACTION"),
        config: z.record(z.unknown()).default({})
      }),
      req.body
    );
    const derivedAssets = await processSourceAsset({
      sourceAssetId: id,
      userId: req.user.id,
      moduleType: input.moduleType ?? "PERSON_EXTRACTION",
      config: input.config ?? {}
    });

    return ok(res, "Asset processed", { derivedAssets });
  })
);
