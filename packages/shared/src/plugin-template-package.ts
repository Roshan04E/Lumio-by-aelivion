import { z } from "zod";
import { buildTemplateGraphFromProject, instantiateTemplateComposition } from "./timeline";
import {
  pluginSchemaVersion,
  pluginTimelineTemplateManifestSchema,
  type PluginTimelineTemplateManifest,
  type PluginWarning
} from "./plugin-manifest";
import type { ProjectGraph, SourceAsset, TimelineComposition, TimelineLayer } from "./types";

export const kimeraTimelineTemplatePackageFormat = "kimera.timeline-template.package" as const;
export const kimeraTimelineTemplatePackageVersion = 1 as const;

export interface KimeraTemplateAssetRef {
  id: string;
  fileName: string;
  fileType: string;
  durationSeconds?: number | undefined;
  width?: number | undefined;
  height?: number | undefined;
  thumbnailUrl?: string | undefined;
  previewUrl?: string | undefined;
  source?: SourceAsset["source"] | undefined;
}

export interface KimeraTimelineTemplatePackage {
  format: typeof kimeraTimelineTemplatePackageFormat;
  formatVersion: typeof kimeraTimelineTemplatePackageVersion;
  exportedAt: string;
  app: {
    name: "Kimera";
    company: "Aelivion Studio";
  };
  manifest: PluginTimelineTemplateManifest;
  graph: ProjectGraph;
  assets: KimeraTemplateAssetRef[];
  preview?: {
    durationSeconds: number;
    width: number;
    height: number;
    fps: number;
    thumbnail?: string | undefined;
  } | undefined;
  warnings: PluginWarning[];
}

export interface BuildTimelineTemplatePackageInput {
  projectId: string;
  title: string;
  description?: string | undefined;
  category?: string | undefined;
  graph: ProjectGraph;
  composition?: TimelineComposition | undefined;
  assets?: SourceAsset[] | undefined;
  createdAt?: string | undefined;
}

export interface ApplyTimelineTemplatePackageInput {
  package: KimeraTimelineTemplatePackage;
  projectId: string;
  projectTitle: string;
  sourceAssetId?: string | undefined;
  availableAssetIds?: string[] | undefined;
}

export interface AppliedTimelineTemplatePackage {
  graph: ProjectGraph;
  composition?: TimelineComposition | undefined;
  warnings: string[];
}

const timelineTemplatePackageSchema = z.object({
  format: z.literal(kimeraTimelineTemplatePackageFormat),
  formatVersion: z.literal(kimeraTimelineTemplatePackageVersion),
  exportedAt: z.string().min(1),
  app: z.object({
    name: z.literal("Kimera"),
    company: z.literal("Aelivion Studio")
  }),
  manifest: pluginTimelineTemplateManifestSchema,
  graph: z.custom<ProjectGraph>((value) => isProjectGraphLike(value), "Package graph is not a Kimera project graph."),
  assets: z
    .array(
      z.object({
        id: z.string().min(1),
        fileName: z.string().min(1),
        fileType: z.string().min(1),
        durationSeconds: z.number().nonnegative().optional(),
        width: z.number().nonnegative().optional(),
        height: z.number().nonnegative().optional(),
        thumbnailUrl: z.string().optional(),
        previewUrl: z.string().optional(),
        source: z.custom<SourceAsset["source"]>().optional()
      })
    )
    .default([]),
  preview: z
    .object({
      durationSeconds: z.number().nonnegative(),
      width: z.number().positive(),
      height: z.number().positive(),
      fps: z.number().positive(),
      thumbnail: z.string().optional()
    })
    .optional(),
  warnings: z
    .array(
      z.object({
        code: z.string().min(1),
        message: z.string().min(1),
        severity: z.enum(["info", "warning", "error"]).default("warning")
      })
    )
    .default([])
});

export function buildTimelineTemplatePackage(input: BuildTimelineTemplatePackageInput): KimeraTimelineTemplatePackage {
  const templateGraph = {
    ...buildTemplateGraphFromProject({
      ...input.graph,
      composition: input.composition ?? input.graph.composition
    }),
    sourceAssetId: undefined
  };
  const composition = templateGraph.composition;
  const title = input.title.trim() || "Untitled Template";
  const warnings = collectPackageWarnings(templateGraph);
  const manifest = pluginTimelineTemplateManifestSchema.parse({
    schemaVersion: pluginSchemaVersion,
    kind: "timeline-template",
    id: `template.${slugify(title)}.${Date.now()}`,
    name: title,
    version: "1.0.0",
    description: input.description?.trim() || `Kimera timeline template exported from ${title}.`,
    author: { name: "Aelivion Studio" },
    license: { type: "unknown" },
    tags: ["timeline", "template", "kimera"],
    category: input.category?.trim() || "User Templates",
    entry: "timeline.json",
    compatibility: {
      runtimes: ["web"],
      renderers: ["webgl2", "scene-compositor", "remotion-scene"],
      requiredFeatures: ["timeline-graph-v1"]
    },
    slots: composition ? buildManifestSlots(composition) : [],
    warnings
  });

  return {
    format: kimeraTimelineTemplatePackageFormat,
    formatVersion: kimeraTimelineTemplatePackageVersion,
    exportedAt: input.createdAt ?? new Date().toISOString(),
    app: {
      name: "Kimera",
      company: "Aelivion Studio"
    },
    manifest,
    graph: templateGraph,
    assets: collectAssetRefs(templateGraph, input.assets ?? []),
    preview: composition
      ? {
          durationSeconds: composition.durationSeconds,
          width: composition.width,
          height: composition.height,
          fps: composition.fps
        }
      : undefined,
    warnings
  };
}

export function parseTimelineTemplatePackage(value: unknown): KimeraTimelineTemplatePackage {
  return timelineTemplatePackageSchema.parse(value);
}

export function applyTimelineTemplatePackage(input: ApplyTimelineTemplatePackageInput): AppliedTimelineTemplatePackage {
  const source = input.package;
  const templateGraph = source.graph;
  const sourceAssetId = input.sourceAssetId;
  const composition = templateGraph.composition
    ? instantiateTemplateComposition(templateGraph.composition, input.projectId, {
        sourceAssetId,
        name: input.projectTitle
      })
    : undefined;
  const graph: ProjectGraph = {
    ...templateGraph,
    projectId: input.projectId,
    sourceAssetId,
    composition,
    version: (templateGraph.version ?? 0) + 1
  };
  const warnings = source.warnings.map((warning) => warning.message);
  warnings.push(...missingAssetWarnings(graph, input.availableAssetIds ?? [], source.assets));
  if (composition && !sourceAssetId && hasEmptyReplaceableMediaSlot(composition)) {
    warnings.push("Template has empty media slots. Drop or replace media after import.");
  }
  return { graph, composition, warnings: unique(warnings) };
}

export function timelineTemplatePackageToJson(pkg: KimeraTimelineTemplatePackage): string {
  return JSON.stringify(pkg, null, 2);
}

function buildManifestSlots(composition: TimelineComposition): PluginTimelineTemplateManifest["slots"] {
  const slotsById = new Map<string, PluginTimelineTemplateManifest["slots"][number]>();
  for (const layer of flattenCompositionLayers(composition)) {
    if (!layer.slot?.replaceable) {
      continue;
    }
    const accepts = slotAccepts(layer);
    const existing = slotsById.get(layer.slot.key);
    if (existing) {
      existing.accepts = unique([...existing.accepts, ...accepts]);
      existing.required = existing.required || layer.slot.kind === "media";
      existing.targetLayerIds = unique([...existing.targetLayerIds, layer.id]);
      continue;
    }
    slotsById.set(layer.slot.key, {
      id: layer.slot.key,
      label: layer.slot.label,
      accepts,
      required: layer.slot.kind === "media",
      replaceBehavior: "preserve-duration",
      targetLayerIds: [layer.id]
    });
  }
  return [...slotsById.values()];
}

function slotAccepts(layer: TimelineLayer): PluginTimelineTemplateManifest["slots"][number]["accepts"] {
  if (layer.slot?.kind === "text") return ["text"];
  if (layer.slot?.kind === "color") return ["color"];
  if (layer.type === "audio") return ["audio"];
  if (layer.type === "image") return ["image"];
  if (layer.type === "video") return ["video", "image"];
  return ["video", "image"];
}

function collectAssetRefs(graph: ProjectGraph, assets: SourceAsset[]): KimeraTemplateAssetRef[] {
  const ids = new Set(flattenCompositionLayers(graph.composition).map((layer) => layer.assetId).filter((id): id is string => Boolean(id)));
  return assets
    .filter((asset) => ids.has(asset.id))
    .map((asset) => ({
      id: asset.id,
      fileName: asset.originalName || asset.fileName,
      fileType: asset.fileType,
      durationSeconds: asset.durationSeconds,
      width: asset.width,
      height: asset.height,
      thumbnailUrl: asset.thumbnailUrl,
      previewUrl: asset.previewUrl,
      source: asset.source
    }));
}

function collectPackageWarnings(graph: ProjectGraph): PluginWarning[] {
  const warnings: PluginWarning[] = [];
  if (!graph.composition) {
    warnings.push({
      code: "template.empty_composition",
      message: "Project has no timeline composition to export.",
      severity: "warning"
    });
  }
  const fixedAssetLayers = flattenCompositionLayers(graph.composition).filter((layer) => layer.assetId && layer.slot?.kind !== "media");
  if (fixedAssetLayers.length > 0) {
    warnings.push({
      code: "template.fixed_media_refs",
      message: `${fixedAssetLayers.length} non-slot media layer(s) keep asset references and may need relinking after import.`,
      severity: "info"
    });
  }
  return warnings;
}

function missingAssetWarnings(graph: ProjectGraph, availableAssetIds: string[], packageAssets: KimeraTemplateAssetRef[]): string[] {
  const available = new Set(availableAssetIds);
  const packaged = new Set(packageAssets.map((asset) => asset.id));
  const missing = unique(
    flattenCompositionLayers(graph.composition)
      .filter((layer) => layer.assetId && !available.has(layer.assetId))
      .map((layer) => layer.assetId as string)
  );
  if (missing.length === 0) {
    return [];
  }
  const described = missing.map((id) => packageAssets.find((asset) => asset.id === id)?.fileName ?? id);
  const suffix = missing.some((id) => packaged.has(id)) ? " Reimport or relink those media files." : "";
  return [`Missing ${missing.length} fixed media asset(s): ${described.join(", ")}.${suffix}`];
}

function hasEmptyReplaceableMediaSlot(composition: TimelineComposition): boolean {
  return flattenCompositionLayers(composition).some((layer) => layer.slot?.kind === "media" && layer.slot.replaceable && !layer.assetId);
}

function flattenCompositionLayers(composition: TimelineComposition | undefined): TimelineLayer[] {
  return composition?.tracks.flatMap((track) => track.layers) ?? [];
}

function isProjectGraphLike(value: unknown): value is ProjectGraph {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const graph = value as Partial<ProjectGraph>;
  return typeof graph.projectId === "string" && typeof graph.editableFields === "object" && typeof graph.version === "number";
}

function slugify(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "untitled";
}

function unique<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}
