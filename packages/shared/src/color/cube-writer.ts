/**
 * Professional Color System — .cube LUT WRITER (the mirror of `cube-parser.ts`).
 *
 * Serializes a `Lut3d` (as produced by `bakePipelineToLut3d`, which evaluates the WHOLE color
 * pipeline — basic correction, curves, wheels, secondaries, imported LUTs — at every grid node)
 * into the Adobe/Resolve standard `.cube` text format, R-FASTEST order, matching the parser's
 * documented data layout exactly (`index(r,g,b) = ((b*size + g)*size + r) * 3`). Because the
 * baker samples the same `applyPipelineToRgb` the renderers grade with, the exported LUT IS the
 * live grade — importing it back (or into Resolve/Premiere) reproduces the look by construction.
 */

import { bakePipelineToLut3d, LUT3D_SIZE, type Lut3d } from "./lut3d";
import type { ColorPipeline } from "./types";

function fmt(v: number): string {
  // 6 decimal places is the common .cube precision; clamp negatives from float noise.
  return (Math.abs(v) < 1e-7 ? 0 : v).toFixed(6);
}

/** Serialize a baked `Lut3d` to `.cube` text. `title` becomes the standard TITLE header line. */
export function serializeCubeFile(lut: Lut3d, title = "Orreris Grade"): string {
  const lines: string[] = [
    `TITLE "${title.replaceAll('"', "'")}"`,
    "# Exported by Orreris — the full color pipeline baked at every grid node.",
    `LUT_3D_SIZE ${lut.size}`,
    "DOMAIN_MIN 0.0 0.0 0.0",
    "DOMAIN_MAX 1.0 1.0 1.0"
  ];
  const count = lut.size * lut.size * lut.size;
  for (let i = 0; i < count; i += 1) {
    const idx = i * 3;
    lines.push(`${fmt(lut.data[idx]!)} ${fmt(lut.data[idx + 1]!)} ${fmt(lut.data[idx + 2]!)}`);
  }
  return lines.join("\n") + "\n";
}

/** One-call export: bake `pipeline` and serialize it. 33³ matches the common .cube resolution. */
export function pipelineToCubeFile(pipeline: ColorPipeline, title = "Orreris Grade", size = LUT3D_SIZE): string {
  return serializeCubeFile(bakePipelineToLut3d(pipeline, size), title);
}
