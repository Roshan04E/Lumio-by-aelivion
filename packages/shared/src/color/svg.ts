/**
 * Professional Color System (Phase 3) — SVG filter emitter.
 * Turns a `ColorPipeline` into serializable SVG filter primitives that BOTH DOM
 * renderers (web preview + Remotion) build into an identical `<filter>` and apply
 * via `filter: url(#id)`. `feColorMatrix` carries the matrix; `feComponentTransfer`
 * with `type="table"` IS the per-channel 1D LUT (the basis for real Curves in 13C.1).
 */

import type { ColorPipeline, ColorStage } from "./types";
import type { ColorRenderWarning } from "./color-management";

export type SvgColorPrimitive =
  | { kind: "colorMatrix"; values: string }
  | { kind: "componentTransfer"; r: string; g: string; b: string };

export interface SvgColorFilter {
  id: string;
  /** Maps to the `color-interpolation-filters` attribute on the `<filter>`. */
  colorInterpolationFilters: "sRGB" | "linearRGB";
  primitives: SvgColorPrimitive[];
}

/** Round to keep emitted strings compact and stable across renderers. */
function fmt(value: number): string {
  return Number.parseFloat(value.toFixed(6)).toString();
}

/** Expand a 3×4 (RGB + offset) matrix into feColorMatrix's 4×5 (RGBA + offset) form. */
function matrixToFeValues(m: number[]): string {
  const v = [
    m[0]!, m[1]!, m[2]!, 0, m[3]!,
    m[4]!, m[5]!, m[6]!, 0, m[7]!,
    m[8]!, m[9]!, m[10]!, 0, m[11]!,
    0, 0, 0, 1, 0
  ];
  return v.map(fmt).join(" ");
}

function stageToPrimitives(stage: ColorStage): SvgColorPrimitive[] {
  const primitives: SvgColorPrimitive[] = [];
  if (stage.matrix) {
    primitives.push({ kind: "colorMatrix", values: matrixToFeValues(stage.matrix) });
  }
  if (stage.curve) {
    primitives.push({
      kind: "componentTransfer",
      r: stage.curve.r.map(fmt).join(" "),
      g: stage.curve.g.map(fmt).join(" "),
      b: stage.curve.b.map(fmt).join(" ")
    });
  }
  return primitives;
}

/**
 * Build the SVG filter spec for a pipeline, or `null` when it's an identity (so the
 * renderer applies no filter at all). `id` should be stable per layer+effect-set.
 */
export function pipelineToSvgFilter(pipeline: ColorPipeline, id: string): SvgColorFilter | null {
  if (pipeline.identity) {
    return null;
  }
  const primitives = pipeline.stages.flatMap(stageToPrimitives);
  if (primitives.length === 0) {
    return null;
  }
  return { id, colorInterpolationFilters: pipeline.space, primitives };
}

/**
 * Warnings for rendering `pipeline` through the DOM/SVG (no-GL) path. SVG can only apply the
 * display-referred `matrix`/`curve` primitives, so it (a) omits `hsl`/`lut3d` stages entirely and
 * (b) approximates managed `controls` in sRGB instead of the exact Rec.709-linear grade. The WebGL
 * backbone is exact — this returns `[]` for it. The UI surfaces these via `colorWarningsLabel`.
 */
export function svgFallbackWarnings(pipeline: ColorPipeline): ColorRenderWarning[] {
  if (pipeline.identity) return [];
  const managed = pipeline.colorSettings.workingSpace === "rec709-linear";
  const hasAdvanced = pipeline.stages.some((s) => s.hsl || s.lut3d);
  const hasManagedControls = managed && pipeline.stages.some((s) => s.controls);
  if (hasAdvanced || hasManagedControls) {
    return [
      {
        code: "advanced-stage-fallback",
        severity: "warning",
        message: "Color preview degraded: LUT/HSL/managed color not exact."
      }
    ];
  }
  return [];
}

function primitiveToMarkup(primitive: SvgColorPrimitive): string {
  if (primitive.kind === "colorMatrix") {
    return `<feColorMatrix type="matrix" values="${primitive.values}"/>`;
  }
  return (
    `<feComponentTransfer>` +
    `<feFuncR type="table" tableValues="${primitive.r}"/>` +
    `<feFuncG type="table" tableValues="${primitive.g}"/>` +
    `<feFuncB type="table" tableValues="${primitive.b}"/>` +
    `</feComponentTransfer>`
  );
}

/**
 * Serialize one or more color filters into a single hidden `<svg><defs>` markup
 * string, injected identically into both renderers via `dangerouslySetInnerHTML`
 * (the same shared-generator pattern the text-warp overlay uses, guaranteeing
 * pixel parity). Returns "" when there's nothing to emit. Filter ids are
 * referenced from the layer's CSS `filter: url(#id)`.
 */
export function buildColorFilterDefs(filters: Array<SvgColorFilter | null | undefined>): string {
  const defs = filters
    .filter((filter): filter is SvgColorFilter => Boolean(filter))
    // No explicit filter region — the SVG default (-10%..120%) avoids clipping a
    // chained drop-shadow (glow); a recolor leaves transparent pixels transparent.
    .map(
      (filter) =>
        `<filter id="${filter.id}" color-interpolation-filters="${filter.colorInterpolationFilters}">` +
        `${filter.primitives.map(primitiveToMarkup).join("")}</filter>`
    )
    .join("");
  if (!defs) {
    return "";
  }
  return `<svg aria-hidden="true" focusable="false" style="position:absolute;width:0;height:0;overflow:hidden" xmlns="http://www.w3.org/2000/svg"><defs>${defs}</defs></svg>`;
}
