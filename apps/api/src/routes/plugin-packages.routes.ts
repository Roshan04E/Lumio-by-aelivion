import { Router } from "express";
import {
  createPluginPackageSchema,
  manifestFromPluginPackageInput,
  patchPluginPackageSchema,
  pluginCatalogKindFilterSchema,
  PluginSafetyError,
  pluginSafetyReportToMessage,
  type PluginCatalogPackage,
  type PluginManifest
} from "@orreris/shared";
import type { PluginPackage, Prisma } from "@prisma/client";
import { z } from "zod";
import { asyncHandler, getParam, HttpError, ok, validateBody } from "../lib/http";
import { asJson } from "../lib/json";
import { prisma } from "../lib/prisma";
import { requireAuth, type AuthRequest } from "../middleware/auth";

export const pluginPackagesRouter = Router();

const listQuerySchema = z.object({
  kind: pluginCatalogKindFilterSchema.catch("all"),
  includeInactive: z.enum(["0", "1", "false", "true"]).optional()
});

pluginPackagesRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const query = listQuerySchema.parse(req.query);
    const includeInactive = query.includeInactive === "1" || query.includeInactive === "true";
    const where: Prisma.PluginPackageWhereInput = {
      ...(query.kind !== "all" ? { kind: query.kind } : {}),
      ...(includeInactive ? {} : { active: true, published: true })
    };
    const packages = await prisma.pluginPackage.findMany({
      where,
      orderBy: [{ kind: "asc" }, { category: "asc" }, { name: "asc" }]
    });

    return ok(res, "Plugin packages", {
      packages: packages.map((item) => serializePluginPackage(item)),
      revision: catalogRevision(packages)
    });
  })
);

pluginPackagesRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const id = getParam(req, "id");
    const item = await prisma.pluginPackage.findFirst({
      where: { OR: [{ id }, { manifestId: id }] }
    });
    if (!item || !item.active || !item.published) {
      throw new HttpError(404, "Plugin package not found");
    }

    return ok(res, "Plugin package", { package: serializePluginPackage(item, true) });
  })
);

pluginPackagesRouter.post(
  "/",
  requireAuth,
  asyncHandler<AuthRequest>(async (req, res) => {
    const input = validateBody(createPluginPackageSchema, req.body);
    enforcePackageBodySize(input.package);
    const manifest = safeManifestFromInput(input);
    const item = await prisma.pluginPackage.upsert({
      where: { manifestId: manifest.id },
      update: packageUpdateData({ ...input, manifest }, req.user.id),
      create: packageCreateData({ ...input, manifest }, req.user.id)
    });

    return ok(res, "Plugin package published", { package: serializePluginPackage(item, true) }, 201);
  })
);

pluginPackagesRouter.patch(
  "/:id",
  requireAuth,
  asyncHandler<AuthRequest>(async (req, res) => {
    const id = getParam(req, "id");
    const input = validateBody(patchPluginPackageSchema, req.body);
    enforcePackageBodySize(input.package);
    const existing = await prisma.pluginPackage.findFirst({
      where: { OR: [{ id }, { manifestId: id }] }
    });
    if (!existing) {
      throw new HttpError(404, "Plugin package not found");
    }

    const manifest = input.manifest !== undefined || input.package !== undefined ? safeManifestFromInput(input) : undefined;
    const item = await prisma.pluginPackage.update({
      where: { id: existing.id },
      data: packageUpdateData({ ...input, manifest }, req.user.id)
    });

    return ok(res, "Plugin package updated", { package: serializePluginPackage(item, true) });
  })
);

function packageCreateData(
  input: PackageInput & { manifest: PluginManifest },
  userId: string
): Prisma.PluginPackageCreateInput {
  const manifest = input.manifest;
  return {
    manifestId: manifest.id,
    kind: manifest.kind,
    schemaVersion: manifest.schemaVersion,
    name: manifest.name,
    version: manifest.version,
    description: manifest.description ?? null,
    authorName: manifest.author?.name ?? null,
    licenseType: manifest.license?.type ?? null,
    tags: asJson(manifest.tags),
    category: manifest.category ?? null,
    thumbnail: manifest.thumbnail ?? null,
    preview: manifest.preview ?? null,
    packageUrl: input.packageUrl ?? null,
    manifest: asJson(manifest),
    ...(input.package !== undefined ? { packageJson: asJson(input.package) } : {}),
    compatibility: asJson(manifest.compatibility),
    active: input.active ?? true,
    published: input.published ?? true,
    createdBy: { connect: { id: userId } }
  };
}

function packageUpdateData(
  input: PackageInput,
  userId: string
): Prisma.PluginPackageUpdateInput {
  const data: Prisma.PluginPackageUpdateInput = {
    createdBy: { connect: { id: userId } }
  };
  if (input.manifest) {
    data.manifestId = input.manifest.id;
    data.kind = input.manifest.kind;
    data.schemaVersion = input.manifest.schemaVersion;
    data.name = input.manifest.name;
    data.version = input.manifest.version;
    data.description = input.manifest.description ?? null;
    data.authorName = input.manifest.author?.name ?? null;
    data.licenseType = input.manifest.license?.type ?? null;
    data.tags = asJson(input.manifest.tags);
    data.category = input.manifest.category ?? null;
    data.thumbnail = input.manifest.thumbnail ?? null;
    data.preview = input.manifest.preview ?? null;
    data.manifest = asJson(input.manifest);
    data.compatibility = asJson(input.manifest.compatibility);
  }
  if (input.package !== undefined) data.packageJson = asJson(input.package);
  if (input.packageUrl !== undefined) data.packageUrl = input.packageUrl;
  if (input.active !== undefined) data.active = input.active;
  if (input.published !== undefined) data.published = input.published;
  return data;
}

interface PackageInput {
  manifest?: PluginManifest | undefined;
  package?: unknown;
  packageUrl?: string | null | undefined;
  active?: boolean | undefined;
  published?: boolean | undefined;
}

function serializePluginPackage(row: PluginPackage, includePackage = false): PluginCatalogPackage {
  return {
    id: row.id,
    manifestId: row.manifestId,
    kind: row.kind as PluginCatalogPackage["kind"],
    schemaVersion: row.schemaVersion,
    name: row.name,
    version: row.version,
    description: row.description ?? undefined,
    authorName: row.authorName ?? undefined,
    licenseType: row.licenseType ?? undefined,
    tags: Array.isArray(row.tags) ? (row.tags as string[]) : [],
    category: row.category ?? undefined,
    thumbnail: row.thumbnail ?? undefined,
    preview: row.preview ?? undefined,
    packageUrl: row.packageUrl ?? undefined,
    manifest: row.manifest as PluginCatalogPackage["manifest"],
    package: includePackage ? row.packageJson ?? undefined : undefined,
    active: row.active,
    published: row.published,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  };
}

function catalogRevision(packages: PluginPackage[]): string {
  const newest = packages.reduce((max, item) => Math.max(max, item.updatedAt.getTime()), 0);
  return `${packages.length}-${newest}`;
}

function safeManifestFromInput(input: { manifest?: unknown; package?: unknown }): PluginManifest {
  try {
    return manifestFromPluginPackageInput(input);
  } catch (error) {
    if (error instanceof PluginSafetyError) {
      throw new HttpError(400, pluginSafetyReportToMessage(error.report));
    }
    throw error;
  }
}

function enforcePackageBodySize(value: unknown) {
  if (value === undefined) return;
  const byteSize = new TextEncoder().encode(JSON.stringify(value)).length;
  const maxPackageBytes = 2 * 1024 * 1024;
  if (byteSize > maxPackageBytes) {
    throw new HttpError(
      400,
      pluginSafetyReportToMessage({
        ok: false,
        issues: [
          {
            severity: "error",
            code: "plugin.package_too_large",
            message: `Package is too large (${Math.round(byteSize / 1024)} KB). Limit is ${Math.round(maxPackageBytes / 1024)} KB.`
          }
        ]
      })
    );
  }
}
