import { lut3dToBase64, parseCubeFile } from "./color/cube-parser";
import { pluginEffectManifestSchema, pluginSchemaVersion, type PluginEffectManifest } from "./plugin-manifest";

export interface CubeLutManifestResult {
  manifest: PluginEffectManifest;
  warnings: string[];
}

export function cubeLutToEffectManifest(input: {
  fileName: string;
  text: string;
  idPrefix?: string | undefined;
}): CubeLutManifestResult {
  const parsed = parseCubeFile(input.text);
  if (!parsed.ok) {
    throw new Error(parsed.error);
  }
  const baseName = input.fileName.split(/[\\/]/).pop() ?? input.fileName;
  const name = cleanName(parsed.title || baseName.replace(/\.cube$/i, ""));
  const id = `${input.idPrefix ?? "external.cube"}.${slugify(name)}`;
  const lut = lut3dToBase64(parsed.lut);
  const manifest = pluginEffectManifestSchema.parse({
    schemaVersion: pluginSchemaVersion,
    kind: "effect",
    id,
    name,
    version: "1.0.0",
    description: `Imported .cube LUT (${parsed.lut.size}x${parsed.lut.size}x${parsed.lut.size}) for Lumio.`,
    author: { name: "External LUT" },
    license: { type: "unknown" },
    tags: ["lut", "cube", "external"],
    category: "LUT",
    engine: "lut3d",
    scope: ["clip", "adjustment"],
    compatibleLayerTypes: ["video", "image", "text", "shape", "adjustment"],
    effect: {
      type: "importedLut",
      intensity: 100,
      params: {
        lut,
        lutName: name,
        intensity: 100
      }
    },
    warnings: [
      {
        code: "external.cube_lut_embedded",
        message: "Imported .cube LUT was embedded into this effect manifest for portability.",
        severity: "info"
      }
    ]
  });
  return {
    manifest,
    warnings: parsed.title ? [] : ["The .cube file has no TITLE; Lumio used the file name."]
  };
}

function cleanName(value: string): string {
  const cleaned = value.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  return cleaned || "Imported LUT";
}

function slugify(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "imported-lut"
  );
}
