import { pluginSchemaVersion, pluginTransitionManifestSchema, type PluginParam, type PluginTransitionManifest } from "./plugin-manifest";
import { validateTransitionManifestGlsl } from "./plugin-transition-adapter";

export interface GlTransitionManifestResult {
  manifest: PluginTransitionManifest;
  warnings: string[];
}

export function glTransitionToManifest(input: {
  fileName: string;
  text: string;
  json?: unknown;
  idPrefix?: string | undefined;
}): GlTransitionManifestResult {
  const source = readGlTransitionSource(input);
  const baseName = input.fileName.split(/[\\/]/).pop() ?? input.fileName;
  const name = cleanName(source.name || baseName.replace(/\.(glsl|frag|json)$/i, ""));
  const id = `${input.idPrefix ?? "external.gl-transition"}.${slugify(name)}`;
  const warnings: string[] = [];
  const glsl = normalizeGlsl(source.glsl, warnings);
  const validation = validateTransitionManifestGlsl(glsl);
  if (!validation.ok) {
    throw new Error(validation.errors.join(" "));
  }
  warnings.push(...validation.warnings);

  const manifest = pluginTransitionManifestSchema.parse({
    schemaVersion: pluginSchemaVersion,
    kind: "transition",
    id,
    name,
    version: source.version ?? "1.0.0",
    description: source.description ?? `Imported GL transition for Lumio.`,
    author: source.author ? { name: source.author } : { name: "External GL Transition" },
    license: { type: "unknown", ...(source.license ? { name: source.license } : {}) },
    tags: ["gl-transition", "external", ...source.tags],
    category: source.category ?? "creator",
    engine: "webgl-transition",
    defaultDurationSeconds: source.defaultDurationSeconds ?? 0.7,
    easing: source.easing ?? "easeInOut",
    transition: {
      glsl,
      params: source.params
    },
    warnings: warnings.length
      ? warnings.map((message, index) => ({
          code: `external.gl_transition_warning_${index + 1}`,
          message,
          severity: "warning" as const
        }))
      : []
  });

  return { manifest, warnings };
}

interface ExternalGlTransitionSource {
  name?: string | undefined;
  version?: string | undefined;
  description?: string | undefined;
  author?: string | undefined;
  license?: string | undefined;
  category?: string | undefined;
  tags: string[];
  defaultDurationSeconds?: number | undefined;
  easing?: "linear" | "easeIn" | "easeOut" | "easeInOut" | undefined;
  params: PluginParam[];
  glsl: string;
}

function readGlTransitionSource(input: { fileName: string; text: string; json?: unknown }): ExternalGlTransitionSource {
  if (!input.fileName.toLowerCase().endsWith(".json")) {
    return { tags: [], params: [], glsl: input.text };
  }
  const json = input.json ?? JSON.parse(input.text);
  const record = readRecord(json);
  if (!record) {
    throw new Error("GL transition JSON must be an object.");
  }
  const glsl = readString(record.glsl) ?? readString(record.fragment) ?? readString(record.shader) ?? readString(record.transition);
  if (!glsl) {
    throw new Error("GL transition JSON must include a glsl, fragment, shader, or transition string.");
  }
  return {
    name: readString(record.name) ?? readString(record.title),
    version: readString(record.version),
    description: readString(record.description),
    author: readAuthor(record.author),
    license: readString(record.license),
    category: readString(record.category),
    tags: readStringArray(record.tags),
    defaultDurationSeconds: readPositiveNumber(record.defaultDurationSeconds) ?? readPositiveNumber(record.durationSeconds) ?? readPositiveNumber(record.duration),
    easing: readEasing(record.easing),
    params: readExternalParams(record.params, record.defaultParams),
    glsl
  };
}

function normalizeGlsl(source: string, warnings: string[]): string {
  let glsl = source.trim();
  glsl = glsl.replace(/^\s*#\s*version[^\n]*(\n|$)/gim, "");
  glsl = glsl.replace(/^\s*precision\s+(lowp|mediump|highp)\s+\w+\s*;\s*$/gim, "");
  glsl = glsl.replace(/^\s*uniform\s+sampler2D\s+(from|to|uFrom|uTo)\s*;\s*$/gim, "");
  glsl = glsl.replace(/^\s*uniform\s+float\s+progress\s*;\s*$/gim, "");
  glsl = glsl.replace(/^\s*uniform\s+vec2\s+resolution\s*;\s*$/gim, "");
  glsl = glsl.replace(/\btexture2D\s*\(\s*from\s*,/g, "getFromColor(");
  glsl = glsl.replace(/\btexture2D\s*\(\s*to\s*,/g, "getToColor(");
  glsl = glsl.replace(/\btexture\s*\(\s*from\s*,/g, "getFromColor(");
  glsl = glsl.replace(/\btexture\s*\(\s*to\s*,/g, "getToColor(");
  glsl = glsl.replace(/\btexture2D\s*\(\s*uFrom\s*,/g, "getFromColor(");
  glsl = glsl.replace(/\btexture2D\s*\(\s*uTo\s*,/g, "getToColor(");
  glsl = glsl.replace(/\btexture\s*\(\s*uFrom\s*,/g, "getFromColor(");
  glsl = glsl.replace(/\btexture\s*\(\s*uTo\s*,/g, "getToColor(");
  if (glsl !== source.trim()) {
    warnings.push("GL transition boilerplate was normalized for Lumio's shader harness.");
  }
  return glsl.trim();
}

function readExternalParams(paramsValue: unknown, defaultParamsValue: unknown): PluginParam[] {
  const params: PluginParam[] = [];
  const defaults = readRecord(defaultParamsValue) ?? {};
  if (Array.isArray(paramsValue)) {
    for (const item of paramsValue) {
      const record = readRecord(item);
      const key = readString(record?.key) ?? readString(record?.name);
      if (!key) continue;
      const defaultValue = record?.defaultValue ?? record?.default ?? defaults[key];
      params.push(paramFromDefault(key, readString(record?.label) ?? cleanName(key), defaultValue));
    }
  }
  for (const [key, value] of Object.entries(defaults)) {
    if (!params.some((param) => param.key === key)) {
      params.push(paramFromDefault(key, cleanName(key), value));
    }
  }
  return params;
}

function paramFromDefault(key: string, label: string, value: unknown): PluginParam {
  const id = slugifyParam(key);
  if (typeof value === "boolean") {
    return { key: id, label, type: "boolean", defaultValue: value, keyframeable: false };
  }
  if (Array.isArray(value) && value.every((entry) => typeof entry === "number")) {
    return { key: id, label, type: value.length === 2 ? "vec2" : "vec3", defaultValue: value.slice(0, value.length === 2 ? 2 : 3), keyframeable: false };
  }
  return { key: id, label, type: "number", defaultValue: typeof value === "number" ? value : 0, min: 0, max: 1, step: 0.01, keyframeable: false };
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())) : [];
}

function readAuthor(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  const record = readRecord(value);
  return readString(record?.name);
}

function readPositiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function readEasing(value: unknown): "linear" | "easeIn" | "easeOut" | "easeInOut" | undefined {
  return value === "linear" || value === "easeIn" || value === "easeOut" || value === "easeInOut" ? value : undefined;
}

function cleanName(value: string): string {
  const cleaned = value.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  return cleaned || "Imported Transition";
}

function slugify(value: string): string {
  return slugifyParam(value) || "imported-transition";
}

function slugifyParam(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "param"
  );
}
