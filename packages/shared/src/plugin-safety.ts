import { z } from "zod";
import {
  pluginManifestSchema,
  pluginSchemaVersion,
  type PluginEffectManifest,
  type PluginLookManifest,
  type PluginManifest,
  type PluginTransitionManifest
} from "./plugin-manifest";

export type PluginSafetySeverity = "error" | "warning";

export interface PluginSafetyIssue {
  severity: PluginSafetySeverity;
  code: string;
  message: string;
  path?: string | undefined;
}

export interface PluginSafetyOptions {
  byteSize?: number | undefined;
  maxManifestBytes?: number | undefined;
  maxPackageBytes?: number | undefined;
  maxAssets?: number | undefined;
  maxEntries?: number | undefined;
  maxParams?: number | undefined;
}

export interface PluginSafetyReport {
  ok: boolean;
  manifest?: PluginManifest | undefined;
  issues: PluginSafetyIssue[];
}

export class PluginSafetyError extends Error {
  report: PluginSafetyReport;

  constructor(report: PluginSafetyReport) {
    super(pluginSafetyReportToMessage(report));
    this.name = "PluginSafetyError";
    this.report = report;
  }
}

const DEFAULT_MAX_MANIFEST_BYTES = 256 * 1024;
const DEFAULT_MAX_PACKAGE_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_ASSETS = 64;
const DEFAULT_MAX_ENTRIES = 200;
const DEFAULT_MAX_PARAMS = 200;

const DANGEROUS_KEY_PATTERN = /^(script|scripts|on[a-z]+|javascript|iframe|object|embed)$/i;
const DANGEROUS_STRING_PATTERNS: Array<{ pattern: RegExp; message: string }> = [
  { pattern: /<\s*script\b/i, message: "HTML script tags are not allowed in plugin packages." },
  { pattern: /\bjavascript\s*:/i, message: "javascript: URLs are not allowed in plugin packages." },
  { pattern: /\bdata\s*:\s*text\/html/i, message: "HTML data URLs are not allowed in plugin packages." },
  { pattern: /\bimportScripts\s*\(/, message: "Worker script loading is not allowed in plugin packages." },
  { pattern: /\beval\s*\(/, message: "Dynamic eval is not allowed in plugin packages." },
  { pattern: /\bnew\s+Function\s*\(/, message: "Dynamic Function constructors are not allowed in plugin packages." },
  { pattern: /\brequire\s*\(\s*['"](?:child_process|fs|node:)/, message: "Node runtime access is not allowed in plugin packages." }
];

const MANIFEST_TOP_LEVEL_KEYS = new Set([
  "schemaVersion",
  "kind",
  "id",
  "name",
  "version",
  "description",
  "author",
  "license",
  "tags",
  "category",
  "thumbnail",
  "preview",
  "compatibility",
  "assets",
  "params",
  "entries",
  "warnings",
  "engine",
  "scope",
  "compatibleLayerTypes",
  "defaultDurationSeconds",
  "easing",
  "effect",
  "transition",
  "look",
  "entry",
  "slots"
]);

export function inspectPluginManifestSafety(value: unknown, options: PluginSafetyOptions = {}): PluginSafetyReport {
  const issues: PluginSafetyIssue[] = [];
  const normalizedValue = normalizeManifestCompatibilityFields(value);
  const byteSize = options.byteSize ?? estimateJsonBytes(value);
  if (byteSize > (options.maxManifestBytes ?? DEFAULT_MAX_MANIFEST_BYTES)) {
    issues.push({
      severity: "error",
      code: "plugin.manifest_too_large",
      message: `Manifest is ${formatBytes(byteSize)}, above the ${formatBytes(options.maxManifestBytes ?? DEFAULT_MAX_MANIFEST_BYTES)} limit.`
    });
  }
  if (byteSize > (options.maxPackageBytes ?? DEFAULT_MAX_PACKAGE_BYTES)) {
    issues.push({
      severity: "error",
      code: "plugin.package_too_large",
      message: `Package is ${formatBytes(byteSize)}, above the ${formatBytes(options.maxPackageBytes ?? DEFAULT_MAX_PACKAGE_BYTES)} limit.`
    });
  }

  const rawSchemaVersion = readRecord(value)?.schemaVersion;
  if (rawSchemaVersion !== undefined && rawSchemaVersion !== pluginSchemaVersion) {
    issues.push({
      severity: "error",
      code: "plugin.unsupported_schema_version",
      message: `Schema version "${String(rawSchemaVersion)}" is not supported. Lumio currently supports ${pluginSchemaVersion}.`,
      path: "schemaVersion"
    });
  }

  collectDangerousContentIssues(value, issues);
  collectUnknownTopLevelWarnings(normalizedValue, issues);

  const parsed = pluginManifestSchema.safeParse(normalizedValue);
  if (!parsed.success) {
    issues.push(...zodIssuesToSafetyIssues(parsed.error));
    return { ok: false, issues };
  }

  collectCountIssues(parsed.data, issues, options);
  collectCompatibilityWarnings(parsed.data, issues);
  collectPreviewWarnings(parsed.data, issues);
  const hasErrors = issues.some((issue) => issue.severity === "error");
  return { ok: !hasErrors, manifest: parsed.data, issues };
}

function normalizeManifestCompatibilityFields(value: unknown): unknown {
  const record = readRecord(value);
  if (!record || record.kind !== "transition") {
    return value;
  }
  const direction = typeof record.direction === "string" ? directionToVec2(record.direction) : undefined;
  if (!direction) {
    return value;
  }
  const transition = readRecord(record.transition) ?? {};
  const params = Array.isArray(transition.params) ? [...transition.params] : [];
  const hasDirectionParam = params.some((param) => readRecord(param)?.key === "direction");
  if (!hasDirectionParam) {
    params.push({
      key: "direction",
      label: "Direction",
      type: "vec2",
      defaultValue: direction
    });
  }
  const { direction: _direction, ...rest } = record;
  return {
    ...rest,
    transition: {
      ...transition,
      params
    }
  };
}

function directionToVec2(value: string): [number, number] | undefined {
  switch (value.toLowerCase()) {
    case "left":
      return [-1, 0];
    case "right":
      return [1, 0];
    case "up":
      return [0, 1];
    case "down":
      return [0, -1];
    default:
      return undefined;
  }
}

export function inspectPluginPackageSafety(value: unknown, options: PluginSafetyOptions = {}): PluginSafetyReport {
  const issues: PluginSafetyIssue[] = [];
  const byteSize = options.byteSize ?? estimateJsonBytes(value);
  if (byteSize > (options.maxPackageBytes ?? DEFAULT_MAX_PACKAGE_BYTES)) {
    issues.push({
      severity: "error",
      code: "plugin.package_too_large",
      message: `Package is ${formatBytes(byteSize)}, above the ${formatBytes(options.maxPackageBytes ?? DEFAULT_MAX_PACKAGE_BYTES)} limit.`
    });
  }
  collectDangerousContentIssues(value, issues, "package");
  const manifest = readRecord(value)?.manifest;
  if (!manifest) {
    issues.push({
      severity: "error",
      code: "plugin.manifest_missing",
      message: "Package is missing a manifest object.",
      path: "manifest"
    });
    return { ok: false, issues };
  }
  const manifestReport = inspectPluginManifestSafety(manifest, options);
  issues.push(...manifestReport.issues);
  const hasErrors = issues.some((issue) => issue.severity === "error");
  return { ok: !hasErrors, manifest: manifestReport.manifest, issues };
}

export function assertPluginManifestSafe(value: unknown, options: PluginSafetyOptions = {}): PluginSafetyReport {
  const report = inspectPluginManifestSafety(value, options);
  if (!report.ok) {
    throw new PluginSafetyError(report);
  }
  return report;
}

export function assertPluginPackageSafe(value: unknown, options: PluginSafetyOptions = {}): PluginSafetyReport {
  const report = inspectPluginPackageSafety(value, options);
  if (!report.ok) {
    throw new PluginSafetyError(report);
  }
  return report;
}

export function pluginSafetyReportToMessage(report: PluginSafetyReport, maxIssues = 4): string {
  const issues = report.issues.filter((issue) => issue.severity === "error");
  const display = issues.length ? issues : report.issues;
  if (!display.length) {
    return "Plugin package passed safety checks.";
  }
  const detail = display
    .slice(0, maxIssues)
    .map((issue) => `${issue.path ? `${issue.path}: ` : ""}${issue.message}`)
    .join(" ");
  const more = display.length > maxIssues ? ` +${display.length - maxIssues} more.` : "";
  return `${detail}${more}`;
}

export function pluginSafetyWarnings(report: PluginSafetyReport): string[] {
  return report.issues.filter((issue) => issue.severity === "warning").map((issue) => issue.message);
}

function zodIssuesToSafetyIssues(error: z.ZodError): PluginSafetyIssue[] {
  return error.issues.slice(0, 12).map((issue) => ({
    severity: "error",
    code: "plugin.schema_invalid",
    message: issue.message,
    path: issue.path.length ? issue.path.join(".") : "manifest"
  }));
}

function collectCountIssues(manifest: PluginManifest, issues: PluginSafetyIssue[], options: PluginSafetyOptions) {
  if (manifest.assets.length > (options.maxAssets ?? DEFAULT_MAX_ASSETS)) {
    issues.push({
      severity: "error",
      code: "plugin.too_many_assets",
      message: `Plugin declares ${manifest.assets.length} assets; limit is ${options.maxAssets ?? DEFAULT_MAX_ASSETS}.`,
      path: "assets"
    });
  }
  if (manifest.entries.length > (options.maxEntries ?? DEFAULT_MAX_ENTRIES)) {
    issues.push({
      severity: "error",
      code: "plugin.too_many_entries",
      message: `Plugin declares ${manifest.entries.length} entries; limit is ${options.maxEntries ?? DEFAULT_MAX_ENTRIES}.`,
      path: "entries"
    });
  }
  if (manifest.params.length > (options.maxParams ?? DEFAULT_MAX_PARAMS)) {
    issues.push({
      severity: "error",
      code: "plugin.too_many_params",
      message: `Plugin declares ${manifest.params.length} params; limit is ${options.maxParams ?? DEFAULT_MAX_PARAMS}.`,
      path: "params"
    });
  }
}

function collectCompatibilityWarnings(manifest: PluginManifest, issues: PluginSafetyIssue[]) {
  if (manifest.kind === "effect" && !supportedEffectEngine(manifest)) {
    issues.push({
      severity: "warning",
      code: "plugin.effect_engine_unsupported",
      message: `Effect engine "${manifest.engine}" can be stored but is not directly renderable yet.`,
      path: "engine"
    });
  }
  if (manifest.kind === "transition" && manifest.engine !== "webgl-transition") {
    issues.push({
      severity: "warning",
      code: "plugin.transition_engine_unsupported",
      message: `Transition engine "${manifest.engine}" can be stored but is not directly renderable yet.`,
      path: "engine"
    });
  }
  if (manifest.kind === "look" && !supportedLookEngine(manifest)) {
    issues.push({
      severity: "warning",
      code: "plugin.look_engine_unsupported",
      message: `Look engine "${manifest.engine}" can be stored but may not render in the current creative-look pipeline.`,
      path: "engine"
    });
  }
}

function collectPreviewWarnings(manifest: PluginManifest, issues: PluginSafetyIssue[]) {
  const paths = new Set(manifest.assets.map((asset) => asset.path));
  for (const [field, value] of [["thumbnail", manifest.thumbnail], ["preview", manifest.preview]] as const) {
    if (!value || isAbsoluteUrl(value) || paths.has(value)) {
      continue;
    }
    issues.push({
      severity: "warning",
      code: "plugin.preview_asset_missing",
      message: `${field} "${value}" is not listed in package assets.`,
      path: field
    });
  }
}

function collectUnknownTopLevelWarnings(value: unknown, issues: PluginSafetyIssue[]) {
  const record = readRecord(value);
  if (!record) return;
  for (const key of Object.keys(record)) {
    if (!MANIFEST_TOP_LEVEL_KEYS.has(key)) {
      issues.push({
        severity: "warning",
        code: "plugin.unknown_field",
        message: `Unknown top-level field "${key}" will be ignored.`,
        path: key
      });
    }
  }
}

function collectDangerousContentIssues(value: unknown, issues: PluginSafetyIssue[], path = "manifest", depth = 0) {
  if (depth > 24) {
    issues.push({ severity: "error", code: "plugin.too_deep", message: "Plugin package JSON is too deeply nested.", path });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectDangerousContentIssues(item, issues, `${path}.${index}`, depth + 1));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      const nestedPath = `${path}.${key}`;
      if (DANGEROUS_KEY_PATTERN.test(key)) {
        issues.push({
          severity: "error",
          code: "plugin.executable_key",
          message: `Executable-style field "${key}" is not allowed.`,
          path: nestedPath
        });
      }
      collectDangerousContentIssues(nested, issues, nestedPath, depth + 1);
    }
    return;
  }
  if (typeof value === "string") {
    for (const rule of DANGEROUS_STRING_PATTERNS) {
      if (rule.pattern.test(value)) {
        issues.push({ severity: "error", code: "plugin.executable_content", message: rule.message, path });
      }
    }
  }
}

function supportedEffectEngine(manifest: PluginEffectManifest): boolean {
  return manifest.engine === "native" || manifest.engine === "color-pipeline" || manifest.engine === "lut3d";
}

function supportedLookEngine(manifest: PluginLookManifest): boolean {
  return manifest.engine === "color-pipeline" || manifest.engine === "lut3d";
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function isAbsoluteUrl(value: string): boolean {
  return /^https?:\/\//i.test(value) || value.startsWith("/");
}

function estimateJsonBytes(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return "unknown size";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
