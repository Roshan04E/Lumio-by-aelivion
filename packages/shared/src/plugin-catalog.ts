import { z } from "zod";
import {
  pluginPackageKindSchema,
  type PluginManifest,
  type PluginPackageKind
} from "./plugin-manifest";
import { assertPluginManifestSafe, assertPluginPackageSafe } from "./plugin-safety";

export interface PluginCatalogPackage {
  id: string;
  manifestId: string;
  kind: PluginPackageKind;
  schemaVersion: string;
  name: string;
  version: string;
  description?: string | undefined;
  authorName?: string | undefined;
  licenseType?: string | undefined;
  tags: string[];
  category?: string | undefined;
  thumbnail?: string | undefined;
  preview?: string | undefined;
  packageUrl?: string | undefined;
  manifest: PluginManifest;
  package?: unknown;
  active: boolean;
  published: boolean;
  updatedAt: string;
  createdAt: string;
}

export interface PluginCatalogResponse {
  packages: PluginCatalogPackage[];
  revision: string;
}

export const pluginCatalogKindFilterSchema = pluginPackageKindSchema.or(z.literal("all")).default("all");

export const createPluginPackageSchema = z
  .object({
    manifest: z.unknown().optional(),
    package: z.unknown().optional(),
    packageUrl: z.string().url().optional(),
    active: z.boolean().default(true),
    published: z.boolean().default(true)
  })
  .refine((value) => value.manifest || value.package, "Provide either a plugin manifest or a package containing a manifest.");

export const patchPluginPackageSchema = z.object({
  manifest: z.unknown().optional(),
  package: z.unknown().optional(),
  packageUrl: z.string().url().nullable().optional(),
  active: z.boolean().optional(),
  published: z.boolean().optional()
});

export function manifestFromPluginPackageInput(input: { manifest?: unknown; package?: unknown }): PluginManifest {
  if (input.package !== undefined) {
    const report = assertPluginPackageSafe(input.package);
    if (!input.manifest) {
      return report.manifest!;
    }
  }
  const manifest = input.manifest ?? readManifestFromPackage(input.package);
  return assertPluginManifestSafe(manifest).manifest!;
}

export function readManifestFromPackage(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return (value as { manifest?: unknown }).manifest;
}

export function pluginCatalogCacheKey(revision: string): string {
  return `kimera.pluginCatalog.${revision}`;
}
