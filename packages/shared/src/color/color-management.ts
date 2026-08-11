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

/**
 * Which light the EFFECT STAGE mixes in (linear-light programme, slice 1).
 *
 * `display` — blur, glow and the other light-mixing operations run on gamma-encoded values. This is
 * what every project shipped before 2026-08-11 does, and it is measurably wrong: a white patch throws
 * only 1.68x the light of a 60% grey where physics says 3.24x, so highlights wash rather than bloom.
 *
 * `linear` — the compositor decodes at the stage boundary and re-encodes on the way out, so effects
 * mix light the way Nuke, Resolve and After Effects' "Blend Colors Using 1.0 Gamma" do.
 *
 * This is a PROJECT setting rather than a global flip because it changes how finished work looks.
 * Resolve versions its colour science and AE puts it behind a project checkbox for the same reason.
 */
export type ColorEffectLight = "display" | "linear";

export interface ProjectColorSettings {
  workingSpace: ColorWorkingSpace;
  output: ColorOutputSpace;
  range: ColorRange;
  effectLight: ColorEffectLight;
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

/**
 * What an ABSENT/unreadable colour setting means: today's shipped behaviour.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * THESE TWO CONSTANTS MUST NOT BE MERGED BACK INTO ONE. Read this before "tidying" them.
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 *
 * Until 2026-08-11 a single `DEFAULT_PROJECT_COLOR_SETTINGS` answered two different questions:
 * "what does a project that never stored this mean?" and "what does a NEW project get?". Those had
 * the same answer, so one constant was correct. `effectLight` is the first field where they differ:
 * a new project gets `linear`, and **every project saved before that date must keep `display`, or its
 * finished work silently changes the next time it is opened.**
 *
 * The failure is invisible to every gate in this repo. `render:compare:pixels` compares the two
 * RENDERERS, and both would read the same wrong default and agree perfectly (DEBT-017). The
 * render-comparison fixtures build their own compositions and stamp their own settings, so they would
 * not notice either. `render:baseline` catches it — but only because its fixtures deliberately leave
 * the field ABSENT, which is a property of the fixtures, not of the code.
 *
 * So the guard is this comment, the naming, and `color.test.ts`'s legacy-default assertions.
 *
 * @see NEW_PROJECT_COLOR_SETTINGS for what a new project gets.
 */
export const LEGACY_PROJECT_COLOR_SETTINGS: ProjectColorSettings = {
  workingSpace: "rec709-linear",
  output: "rec709-sdr",
  range: "limited",
  // Absent = a project authored before the linear-light stage existed. Its blur and glow were dialled
  // by eye against display-encoded maths; re-mixing them in linear would move somebody's finished cut.
  effectLight: "display"
};

/**
 * What a NEW project is stamped with, explicitly, at creation (`createDefaultComposition`).
 *
 * "Stamped explicitly" is load-bearing: a new project must SAVE `effectLight: "linear"` into its
 * settings rather than inherit it from a default, because the absent case has to keep meaning
 * "legacy" forever. A project that relied on the default would flip its own meaning the moment
 * anything about the defaulting changed.
 */
export const NEW_PROJECT_COLOR_SETTINGS: ProjectColorSettings = {
  workingSpace: "rec709-linear",
  output: "rec709-sdr",
  range: "limited",
  effectLight: "linear"
};

/**
 * @deprecated Ambiguous — say which question you are answering.
 * Use {@link LEGACY_PROJECT_COLOR_SETTINGS} for "I was handed nothing, assume the old contract" and
 * {@link NEW_PROJECT_COLOR_SETTINGS} for "this is a brand-new project". Kept as an alias of the
 * LEGACY value so any site missed in the audit degrades to today's behaviour rather than silently
 * converting a user's project — the safe direction to fail.
 */
export const DEFAULT_PROJECT_COLOR_SETTINGS: ProjectColorSettings = LEGACY_PROJECT_COLOR_SETTINGS;

export const ASSUMED_REC709_SOURCE_METADATA: SourceColorMetadata = {
  primaries: "bt709",
  transfer: "bt709",
  matrix: "bt709",
  fullRange: false,
  bitDepth: 8,
  detectedFrom: "assumed",
  confidence: "low"
};

/**
 * Normalize persisted colour settings. Every fallback here is the LEGACY value on purpose: this
 * function's whole job is to answer "the stored data did not say — what did it mean?", and for a
 * project that did not say, the answer is whatever it rendered as before the field existed.
 */
export function normalizeProjectColorSettings(value: unknown): ProjectColorSettings {
  const raw = (typeof value === "object" && value !== null ? value : {}) as Partial<ProjectColorSettings>;
  return {
    workingSpace: raw.workingSpace === "rec709-linear" ? raw.workingSpace : LEGACY_PROJECT_COLOR_SETTINGS.workingSpace,
    output: raw.output === "rec709-sdr" ? raw.output : LEGACY_PROJECT_COLOR_SETTINGS.output,
    range: raw.range === "full" || raw.range === "limited" ? raw.range : LEGACY_PROJECT_COLOR_SETTINGS.range,
    // An unrecognised value falls back to `display` like an absent one. A project whose settings blob
    // got mangled must not be silently converted — "I could not read it" and "it said display" have
    // the same safe answer.
    effectLight: raw.effectLight === "linear" ? "linear" : LEGACY_PROJECT_COLOR_SETTINGS.effectLight
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
