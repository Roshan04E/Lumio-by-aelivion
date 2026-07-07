/**
 * Rec.709 SDR color-management contracts.
 *
 * v1 deliberately targets the browser/editor SDR lane: Rec.709 primaries, a
 * linear working space for grading, and BT.709-tagged limited-range export.
 * HDR/log/P3 assets are detected as future work and surfaced as warnings rather
 * than silently pretending they are mastered.
 */

export type ColorWorkingSpace = "rec709-linear";
export type ColorOutputSpace = "rec709-sdr";
export type ColorRange = "limited" | "full";
export type ColorPrimaries = "bt709" | "bt601" | "bt2020" | "display-p3" | "unknown";
export type ColorTransfer = "bt709" | "srgb" | "pq" | "hlg" | "log" | "unknown";
export type ColorMatrix = "bt709" | "bt601" | "bt2020-ncl" | "rgb" | "unknown";
export type ColorMetadataSource = "detected" | "asset" | "user" | "assumed";
export type ColorConfidence = "high" | "medium" | "low";

export interface ProjectColorSettings {
  workingSpace: ColorWorkingSpace;
  output: ColorOutputSpace;
  range: ColorRange;
}

export interface SourceColorMetadata {
  primaries: ColorPrimaries;
  transfer: ColorTransfer;
  matrix: ColorMatrix;
  fullRange: boolean;
  bitDepth?: number | undefined;
  detectedFrom: ColorMetadataSource;
  confidence: ColorConfidence;
}

export type ColorRenderWarningCode =
  | "unsupported-hdr"
  | "unsupported-wide-gamut"
  | "unsupported-log"
  | "assumed-rec709"
  | "advanced-stage-fallback"
  | "export-metadata-fallback";

export interface ColorRenderWarning {
  code: ColorRenderWarningCode;
  message: string;
  severity: "info" | "warning";
}

export const DEFAULT_PROJECT_COLOR_SETTINGS: ProjectColorSettings = {
  workingSpace: "rec709-linear",
  output: "rec709-sdr",
  range: "limited"
};

export const ASSUMED_REC709_SOURCE_METADATA: SourceColorMetadata = {
  primaries: "bt709",
  transfer: "bt709",
  matrix: "bt709",
  fullRange: false,
  bitDepth: 8,
  detectedFrom: "assumed",
  confidence: "low"
};

export function normalizeProjectColorSettings(value: unknown): ProjectColorSettings {
  const raw = (typeof value === "object" && value !== null ? value : {}) as Partial<ProjectColorSettings>;
  return {
    workingSpace: raw.workingSpace === "rec709-linear" ? raw.workingSpace : DEFAULT_PROJECT_COLOR_SETTINGS.workingSpace,
    output: raw.output === "rec709-sdr" ? raw.output : DEFAULT_PROJECT_COLOR_SETTINGS.output,
    range: raw.range === "full" || raw.range === "limited" ? raw.range : DEFAULT_PROJECT_COLOR_SETTINGS.range
  };
}

export function normalizeSourceColorMetadata(value: unknown): SourceColorMetadata {
  const raw = (typeof value === "object" && value !== null ? value : {}) as Partial<SourceColorMetadata>;
  const primaries: ColorPrimaries =
    raw.primaries === "bt601" || raw.primaries === "bt2020" || raw.primaries === "display-p3" || raw.primaries === "unknown"
      ? raw.primaries
      : "bt709";
  const transfer: ColorTransfer =
    raw.transfer === "srgb" || raw.transfer === "pq" || raw.transfer === "hlg" || raw.transfer === "log" || raw.transfer === "unknown"
      ? raw.transfer
      : "bt709";
  const matrix: ColorMatrix =
    raw.matrix === "bt601" || raw.matrix === "bt2020-ncl" || raw.matrix === "rgb" || raw.matrix === "unknown"
      ? raw.matrix
      : "bt709";
  return {
    primaries,
    transfer,
    matrix,
    fullRange: typeof raw.fullRange === "boolean" ? raw.fullRange : false,
    bitDepth: typeof raw.bitDepth === "number" && Number.isFinite(raw.bitDepth) ? raw.bitDepth : ASSUMED_REC709_SOURCE_METADATA.bitDepth,
    detectedFrom:
      raw.detectedFrom === "detected" || raw.detectedFrom === "asset" || raw.detectedFrom === "user" || raw.detectedFrom === "assumed"
        ? raw.detectedFrom
        : "assumed",
    confidence: raw.confidence === "high" || raw.confidence === "medium" || raw.confidence === "low" ? raw.confidence : "low"
  };
}

export function sourceColorWarnings(metadata: SourceColorMetadata | undefined): ColorRenderWarning[] {
  const m = normalizeSourceColorMetadata(metadata);
  const warnings: ColorRenderWarning[] = [];
  if (m.detectedFrom === "assumed") {
    warnings.push({ code: "assumed-rec709", severity: "info", message: "Source color assumed Rec.709 SDR." });
  }
  if (m.transfer === "pq" || m.transfer === "hlg" || (m.bitDepth ?? 8) > 8) {
    warnings.push({ code: "unsupported-hdr", severity: "warning", message: "HDR/10-bit source is treated as Rec.709 SDR in this milestone." });
  }
  if (m.primaries === "display-p3" || m.primaries === "bt2020") {
    warnings.push({ code: "unsupported-wide-gamut", severity: "warning", message: "Wide-gamut source is treated as Rec.709 SDR." });
  }
  if (m.transfer === "log") {
    warnings.push({ code: "unsupported-log", severity: "warning", message: "Log camera transfer is not transformed yet; apply a technical LUT manually." });
  }
  return warnings;
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/**
 * Browser frame uploads arrive as display/code values. Use the sRGB/Rec.709 SDR
 * display transfer for the v1 managed path; this is exact for the browser preview
 * lane and round-trips deterministically for export fixtures.
 */
export function rec709CodeToLinear(value: number): number {
  const v = clamp01(value);
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

export function rec709LinearToCode(value: number): number {
  const v = clamp01(value);
  return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}

export function rgbCodeToLinear(rgb: readonly [number, number, number]): [number, number, number] {
  return [rec709CodeToLinear(rgb[0]), rec709CodeToLinear(rgb[1]), rec709CodeToLinear(rgb[2])];
}

export function rgbLinearToCode(rgb: readonly [number, number, number]): [number, number, number] {
  return [rec709LinearToCode(rgb[0]), rec709LinearToCode(rgb[1]), rec709LinearToCode(rgb[2])];
}

export function colorWarningsLabel(warnings: readonly ColorRenderWarning[]): string {
  if (warnings.some((warning) => warning.code === "advanced-stage-fallback")) {
    return "Color preview degraded: LUT/HSL/managed color not exact.";
  }
  if (warnings.some((warning) => warning.severity === "warning")) {
    return warnings.find((warning) => warning.severity === "warning")!.message;
  }
  return warnings[0]?.message ?? "";
}
