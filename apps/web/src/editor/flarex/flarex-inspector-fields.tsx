/**
 * Flarex node → Inspector ADAPTER (the only Flarex-specific inspector code).
 *
 * `buildFlarexNodeFields` translates a selected node's DEFINITION metadata (schema param order, ranges,
 * keyframeable set, enums, data types) into the application's shared `PropertyField[]` model. The shared
 * `PropertyFieldList` then renders it exactly like every other inspector — a property's editor is chosen
 * by its data type ALONE (Position → grouped XY drag, Scale/Rotation → drag, Opacity → slider, Boolean →
 * checkbox, Enum → dropdown, Color → picker, Asset → picker, Text → input), never by "it's a node."
 *
 * There is no rendering here — only the metadata→field translation and the value/keyframe binding onto
 * `comp.animations` / `node.params`. Deleting this file removes the node adapter; every widget it produced
 * still lives in the shared inspector controls.
 */

import type { ReactNode } from "react";
import {
  Layers,
  Eye,
  Tag,
  Film,
  Clock,
  Snowflake,
  Move,
  Crosshair,
  RotateCw,
  Droplets,
  Palette,
  Sun,
  Contrast,
  Sparkles,
  Crop,
  Type as TypeIcon,
  SlidersHorizontal,
  Circle,
  Maximize2,
  Power,
} from "lucide-react";
import {
  evaluateFlarexNodeParam,
  getFlarexNodeDefinition,
  parseFlarexNodeParams,
  listFragmentEffects,
  getFragmentEffect,
  CREATIVE_LOOK_NAMES,
  flarexChannelSources,
  FLAREX_CHROMA_KEY_ID,
  FLAREX_LUMA_KEY_ID,
  type FlarexComp,
  type FlarexNode,
  type FragmentEffectDefinition,
  type FragmentEffectParam,
} from "@orreris/shared";
import { ColorWheels } from "../../components/ColorWheels";
import { CurveEditor } from "../../components/CurveEditor";
import { HslSecondary } from "../../components/HslSecondary";
import { HueSatCurves } from "../../components/HueSatCurves";
import { LutFileImport } from "../../components/LutFileImport";
import type { PropertyField, PropertyFieldAxis } from "../inspector/PropertyFieldList";
import { FlarexSourcePicker, type FlarexSourceAssetOption } from "./FlarexSourcePicker";
import {
  applyNodeParamValueAtTime,
  clearNodeParamKeyframes,
  findNodeParamKeyframe,
  getActiveNodeParamKeyframe,
  getNodeParamKeyframes,
  toggleNodeParamKeyframe,
  setNodeParamInterpolation,
} from "./flarex-keyframes";
// Slider ranges live in ONE place so the inspector rows and the graph-editor lanes clamp identically.
import { FLAREX_PARAM_RANGES as RANGES } from "./flarex-param-meta";

/** Enum params → dropdown options (the only per-type enum vocabularies not already in the node def). */
const ENUMS: Record<string, readonly string[]> = {
  "merge.blend": [
    "normal", "multiply", "screen", "overlay", "darken", "lighten", "color-dodge", "color-burn",
    "hard-light", "soft-light", "difference", "exclusion", "hue", "saturation", "color", "luminosity", "add",
  ],
  "matteControl.operation": ["add", "subtract", "intersect", "exclude"],
  // Channel Boolean: every output channel picks from the same source vocabulary (shared with the
  // shader's own index order, so the two can't drift).
  "channelBoolean.red": flarexChannelSources,
  "channelBoolean.green": flarexChannelSources,
  "channelBoolean.blue": flarexChannelSources,
  "channelBoolean.alpha": flarexChannelSources,
  "text.align": ["left", "center", "right"],
};

/**
 * JSON-payload params that get a dedicated DATA editor instead of a text row, keyed
 * `<nodeType>.<paramKey>`. Every one of these reuses the app's existing clip-inspector control
 * verbatim — the node page and the clip page edit the identical payload shape, so they can never
 * drift. One table, so a new payload node is a row here rather than another branch below.
 */
const PAYLOAD_EDITORS: Record<string, (value: string, onChange: (json: string) => void) => ReactNode> = {
  "colorCurves.curves": (value, onChange) => <CurveEditor value={value} onChange={onChange} />,
  "hueSat.hueCurves": (value, onChange) => <HueSatCurves value={value} onChange={onChange} />,
  "colorWheels.wheels": (value, onChange) => <ColorWheels value={value} onChange={onChange} />,
  "hslQualifier.secondary": (value, onChange) => <HslSecondary value={value} onChange={onChange} />,
  // The unified Color node reuses the SAME editors under the same param names — one control per
  // payload shape, whether it is reached through an atomic node or the grade node.
  "color.curves": (value, onChange) => <CurveEditor value={value} onChange={onChange} />,
  "color.hueCurves": (value, onChange) => <HueSatCurves value={value} onChange={onChange} />,
  "color.wheels": (value, onChange) => <ColorWheels value={value} onChange={onChange} />,
  "color.secondary": (value, onChange) => <HslSecondary value={value} onChange={onChange} />,
};

/**
 * Section layout for the unified Color node (Resolve's corrector, one node = the whole toolset).
 * Order matches `buildUnifiedColorEffects`' pipeline order, so what you read top-to-bottom is the
 * order the grade is actually applied in. Any param not listed here falls through to the flat list,
 * so adding a param can never make it invisible.
 */
const COLOR_NODE_SECTIONS: Array<{ id: string; label: string; params: string[]; open?: boolean }> = [
  { id: "primary", label: "Primary", open: true, params: ["exposure", "contrast", "highlights", "shadows", "whites", "blacks", "saturation", "vibrance", "temperature", "tint"] },
  { id: "wheels", label: "Color Wheels", params: ["wheels"] },
  { id: "curves", label: "Curves", params: ["curves"] },
  { id: "hueSat", label: "Hue / Sat", params: ["hueCurves"] },
  { id: "qualifier", label: "Qualifier", params: ["secondary"] },
  { id: "lut", label: "LUT", params: ["lut", "lutIntensity"] },
  { id: "look", label: "Look", params: ["look", "lookIntensity"] },
  { id: "film", label: "Film", params: ["vignetteAmount", "vignetteSize", "vignetteFeather", "vignetteRoundness", "vignetteHighlights", "grainAmount", "grainSize"] },
];

/** Whether a Color node section is doing anything — drives the dot on its header, so a collapsed
 *  section still tells you the node is grading through it. Mirrors the lowering's own neutrality
 *  rule (`buildUnifiedColorEffects`): saturation is neutral at 100, everything else at 0/"". */
function colorSectionActive(params: Record<string, unknown>, keys: string[]): boolean {
  return keys.some((key) => {
    const value = params[key];
    if (typeof value === "string") return value.trim().length > 0;
    if (typeof value !== "number") return false;
    if (key === "saturation") return value !== 100;
    if (key === "lutIntensity" || key === "lookIntensity" || key === "grainSize") return false; // intensities alone mean nothing
    if (key === "vignetteSize" || key === "vignetteFeather" || key === "vignetteRoundness" || key === "vignetteHighlights") return false;
    return value !== 0;
  });
}

/** Params the CANVAS owns, not the inspector — structural payloads with no meaningful text editor. */
const STRUCTURAL_PARAMS = new Set(["group.members"]);

const COLOR_PARAMS = new Set(["chromaKey.color", "text.color", "backdrop.color", "background.color"]);
/** polygonMask/bezierMask `points` — a structured row-per-point editor (the documented fallback for the
 *  on-viewer SVG overlay), rendered as a custom field just like the clip-effect schema's curve editors. */
const POINT_LIST_PARAMS = new Set(["polygonMask.points", "bezierMask.points"]);

const prettyLabel = (key: string): string => key.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase());

/** Leading label icon per param, so node rows read like the main inspector's Transform rows. Matched
 *  loosely by key substring with a neutral fallback so every row gets one. */
function paramIcon(key: string): ReactNode {
  const k = key.toLowerCase();
  if (k.includes("blend")) return <Layers size={14} />;
  if (k.includes("opacity") || k.includes("alpha")) return <Eye size={14} />;
  if (k === "label") return <Tag size={14} />;
  if (k.includes("sourceasset") || k.includes("effectid")) return <Film size={14} />;
  if (k.includes("sourcein") || k.includes("time")) return <Clock size={14} />;
  if (k.includes("freeze")) return <Snowflake size={14} />;
  if (k.includes("position") || k.includes("center") || k.includes("offset") || k.includes("translate")) return <Move size={14} />;
  if (k.includes("scale") || k.includes("size") || k.includes("zoom")) return <Maximize2 size={14} />;
  if (k.includes("rotat") || k.includes("angle")) return <RotateCw size={14} />;
  if (k.includes("blur") || k.includes("radius")) return <Droplets size={14} />;
  if (k.includes("color") || k.includes("tint")) return <Palette size={14} />;
  if (k.includes("bright") || k.includes("expos") || k.includes("gain") || k.includes("lift")) return <Sun size={14} />;
  if (k.includes("contrast") || k.includes("gamma")) return <Contrast size={14} />;
  if (k.includes("glow") || k.includes("sharp") || k.includes("bloom")) return <Sparkles size={14} />;
  if (k.includes("crop") || k.includes("mask") || k.includes("points")) return <Crop size={14} />;
  if (k.includes("text") || k.includes("font")) return <TypeIcon size={14} />;
  if (
    k.includes("threshold") || k.includes("soft") || k.includes("amount") || k.includes("strength") ||
    k.includes("intensity") || k.includes("mix") || k.includes("balance") || k.includes("saturat")
  )
    return <SlidersHorizontal size={14} />;
  return <Circle size={14} />;
}

function listFilterableFragmentEffects(): FragmentEffectDefinition[] {
  return listFragmentEffects().filter((def) => !def.passes && def.id !== FLAREX_CHROMA_KEY_ID && def.id !== FLAREX_LUMA_KEY_ID);
}

function groupByCategory(defs: FragmentEffectDefinition[]): Array<[string, FragmentEffectDefinition[]]> {
  const groups = new Map<string, FragmentEffectDefinition[]>();
  for (const def of defs) {
    const list = groups.get(def.category) ?? [];
    list.push(def);
    groups.set(def.category, list);
  }
  return [...groups.entries()];
}

function parseFilterEffectParams(raw: string): Record<string, number | number[] | boolean> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function parsePointsParam(raw: string): Array<[number, number]> {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((p): p is [number, number] => Array.isArray(p) && p.length === 2 && p.every((n) => typeof n === "number" && Number.isFinite(n)))
      .map(([x, y]) => [Math.max(0, Math.min(1, x)), Math.max(0, Math.min(1, y))] as [number, number]);
  } catch {
    return [];
  }
}

function rgbToHex(rgb: number[]): string {
  const clamp = (n: number | undefined) => Math.max(0, Math.min(255, Math.round((n ?? 0) * 255)));
  return `#${[0, 1, 2].map((i) => clamp(rgb[i]).toString(16).padStart(2, "0")).join("")}`;
}

function hexToRgb(hex: string): number[] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return [0, 0, 0];
  const n = parseInt(m[1]!, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export interface BuildFlarexNodeFieldsArgs {
  comp: FlarexComp;
  node: FlarexNode;
  /** Comp-local playhead (shared transport − layer.startSeconds, clamped ≥ 0) — where keyframes land. */
  compTime: number;
  onUpdateComp: (updater: (comp: FlarexComp) => FlarexComp) => void;
  /** Seek the shared transport to a comp-local time (prev/next keyframe nav). */
  onSeekCompTime: (compTime: number) => void;
  /** Media-pool assets a MediaIn node may load. */
  sourceAssets: FlarexSourceAssetOption[];
  /** Enter media-pool "pick one" mode for this MediaIn node's source. */
  onPickSource?: ((nodeId: string) => void) | undefined;
  /** Open the Source Viewer (proxy vs original A/B) for an asset. */
  onInspectSource?: ((assetId: string) => void) | undefined;
}

/** Translate one node's definition + params into the shared inspector schema. */
export function buildFlarexNodeFields(args: BuildFlarexNodeFieldsArgs): PropertyField[] {
  const { comp, node, compTime, onUpdateComp, onSeekCompTime, sourceAssets, onPickSource, onInspectSource } = args;
  const def = getFlarexNodeDefinition(node.type);
  const keyframeable = new Set(def.keyframeable);
  const nodeId = node.id;
  const defaults = parseFlarexNodeParams(node.type, {});
  const fields: PropertyField[] = [];

  const patchNode = (patch: Partial<FlarexNode>) =>
    onUpdateComp((current) => {
      const target = current.nodes[nodeId];
      if (!target) return current;
      return { ...current, nodes: { ...current.nodes, [nodeId]: { ...target, ...patch } } };
    });
  const setParam = (key: string, value: string | number | boolean) =>
    onUpdateComp((current) => {
      const target = current.nodes[nodeId];
      if (!target) return current;
      return { ...current, nodes: { ...current.nodes, [nodeId]: { ...target, params: { ...target.params, [key]: value } } } };
    });

  // Numeric field binding for ONE param — value sampled at the playhead when animated, writes upsert a
  // keyframe there (the animated-edit rule). Shared by standalone number rows and grouped X/Y axes so
  // both write/keyframe/sample identically.
  const numberField = (paramKey: string) => {
    const range = RANGES[`${node.type}.${paramKey}`];
    const canKeyframe = keyframeable.has(paramKey);
    const raw = node.params[paramKey] ?? defaults[paramKey];
    const base = typeof raw === "number" ? raw : 0;
    const displayValue = canKeyframe
      ? evaluateFlarexNodeParam({ animations: comp.animations, baseValue: base, nodeId, paramKey, timeSeconds: compTime })
      : base;
    const writeParam = (next: number) => {
      if (canKeyframe) onUpdateComp((current) => applyNodeParamValueAtTime(current, nodeId, paramKey, compTime, next));
      else setParam(paramKey, next);
    };
    const activeKf = getActiveNodeParamKeyframe(comp, nodeId, paramKey, compTime);
    const defaultValue = typeof defaults[paramKey] === "number" ? (defaults[paramKey] as number) : undefined;
    const nav = canKeyframe
      ? {
          active: Boolean(activeKf),
          hasAny: getNodeParamKeyframes(comp, nodeId, paramKey).length > 0,
          hasPrevious: Boolean(findNodeParamKeyframe(comp, nodeId, paramKey, compTime, -1)),
          hasNext: Boolean(findNodeParamKeyframe(comp, nodeId, paramKey, compTime, 1)),
          onToggle: () => onUpdateComp((current) => toggleNodeParamKeyframe(current, nodeId, paramKey, compTime, displayValue)),
          onClearAll: () => onUpdateComp((current) => clearNodeParamKeyframes(current, nodeId, paramKey)),
          onPrevious: () => {
            const kf = findNodeParamKeyframe(comp, nodeId, paramKey, compTime, -1);
            if (kf) onSeekCompTime(kf.timeSeconds);
          },
          onNext: () => {
            const kf = findNodeParamKeyframe(comp, nodeId, paramKey, compTime, 1);
            if (kf) onSeekCompTime(kf.timeSeconds);
          },
        }
      : undefined;
    // Standalone rows carry the full contract (adds the interpolation menu); grouped axes carry the plain
    // diamond only (matching the clip Transform panel's grouped vs single rows).
    const keyframeFull = nav
      ? {
          ...nav,
          interpolation: activeKf?.interpolation,
          onChangeInterpolation: (interpolation: Parameters<typeof setNodeParamInterpolation>[4]) =>
            onUpdateComp((current) => setNodeParamInterpolation(current, nodeId, paramKey, compTime, interpolation)),
        }
      : undefined;
    return { range, displayValue, writeParam, defaultValue, keyframePlain: nav, keyframeFull };
  };

  const numberFieldDescriptor = (key: string): PropertyField => {
    const f = numberField(key);
    // Slider for a bounded "percentage-like" range (0..100 / ±100 / ±180) or normalized 0..1 (Opacity);
    // drag-scrub for everything else (Scale, Rotation, unbounded). Same rule the clip inspector uses.
    const [min, max, step] = f.range ?? [-1_000_000, 1_000_000, 0.01];
    const naturalSlider = (min === 0 && max === 100) || (min === -100 && max === 100) || (min === -180 && max === 180);
    const slider = Boolean(f.range) && (naturalSlider || (min === 0 && max === 1));
    return {
      kind: "number",
      key,
      label: prettyLabel(key),
      icon: paramIcon(key),
      value: f.displayValue,
      min,
      max,
      step,
      slider,
      keyframe: f.keyframeFull,
      defaultValue: f.defaultValue,
      onChange: f.writeParam,
    };
  };

  // Vec2 params that read as ONE grouped X/Y row, IDENTICAL to the clip Transform panel's Position /
  // Anchor. The Transform node stores these as separate scalars, so we pair them here.
  const vec2Groups: Array<{ x: string; y: string; label: string; icon: ReactNode }> =
    node.type === "transform"
      ? [
          { x: "x", y: "y", label: "Position", icon: <Move size={14} /> },
          { x: "anchorX", y: "anchorY", label: "Anchor", icon: <Crosshair size={14} /> },
        ]
      : [];
  const consumedByGroup = new Set(vec2Groups.map((g) => g.y));
  const vec2Descriptor = (g: { x: string; y: string; label: string; icon: ReactNode }): PropertyField => {
    const axis = (paramKey: string, tag: string): PropertyFieldAxis => {
      const f = numberField(paramKey);
      return { tag, value: f.displayValue, defaultValue: f.defaultValue, keyframe: f.keyframePlain, onChange: f.writeParam };
    };
    return { kind: "vec2", key: g.x, label: g.label, icon: g.icon, axes: [axis(g.x, "X"), axis(g.y, "Y")] };
  };

  // Filter node: effectId select + dynamic per-effect param rows (registry-driven).
  const isFilterNode = node.type === "filter";
  const filterEffectId = isFilterNode && typeof node.params.effectId === "string" ? (node.params.effectId as string) : "";
  const filterDef = isFilterNode && filterEffectId ? getFragmentEffect(filterEffectId) : undefined;
  const filterEffectParams = isFilterNode
    ? parseFilterEffectParams(typeof node.params.effectParams === "string" ? (node.params.effectParams as string) : "")
    : {};
  const setFilterEffectParam = (paramName: string, value: number | number[] | boolean) =>
    onUpdateComp((current) => {
      const target = current.nodes[nodeId];
      if (!target) return current;
      const existing = parseFilterEffectParams(typeof target.params.effectParams === "string" ? (target.params.effectParams as string) : "");
      const next = { ...existing, [paramName]: value };
      return { ...current, nodes: { ...current.nodes, [nodeId]: { ...target, params: { ...target.params, effectParams: JSON.stringify(next) } } } };
    });
  const filterParamDescriptor = (param: FragmentEffectParam): PropertyField => {
    const current = filterEffectParams[param.name];
    const label = param.label ?? prettyLabel(param.name);
    if (param.type === "bool") {
      return { kind: "boolean", key: `fx.${param.name}`, label, icon: paramIcon(param.name), value: typeof current === "boolean" ? current : Boolean(param.default), onChange: (next) => setFilterEffectParam(param.name, next) };
    }
    if (param.type === "vec3") {
      const value = Array.isArray(current) ? current : (param.default as number[]);
      return { kind: "color", key: `fx.${param.name}`, label, icon: paramIcon(param.name), value: rgbToHex(value), onChange: (next) => setFilterEffectParam(param.name, hexToRgb(next)) };
    }
    if (param.type === "vec2") {
      const value = Array.isArray(current) ? current : (param.default as number[]);
      const x = Number.isFinite(value[0]) ? (value[0] as number) : 0;
      const y = Number.isFinite(value[1]) ? (value[1] as number) : 0;
      return {
        kind: "vec2",
        key: `fx.${param.name}`,
        label,
        icon: paramIcon(param.name),
        axes: [
          { tag: "X", value: x, onChange: (next) => setFilterEffectParam(param.name, [next, y]) },
          { tag: "Y", value: y, onChange: (next) => setFilterEffectParam(param.name, [x, next]) },
        ],
      };
    }
    return {
      kind: "number",
      key: `fx.${param.name}`,
      label,
      icon: paramIcon(param.name),
      value: typeof current === "number" ? current : (param.default as number),
      min: param.min ?? 0,
      max: param.max ?? 1,
      step: param.step ?? 0.01,
      slider: true,
      defaultValue: param.default as number,
      onChange: (next) => setFilterEffectParam(param.name, next),
    };
  };

  // ── Enabled (shared boolean, first row) ──────────────────────────────────────────────────────────
  fields.push({ kind: "boolean", key: "__enabled", label: "Enabled", icon: <Power size={14} />, value: node.enabled, onChange: (next) => patchNode({ enabled: next }) });

  // Schema order, not object-insertion order — stable designed sequence; nodes saved before a def gained
  // a param still show it (value falls back to the default until first edited).
  for (const key of [...Object.keys(defaults), ...Object.keys(node.params).filter((k) => !(k in defaults))]) {
    if (consumedByGroup.has(key)) continue;
    // Structural payloads the CANVAS owns (a Group's member list): editing a raw id array by hand is
    // not a property edit, so it gets no row. Title/collapsed still render through PropertyFieldList
    // like any other property.
    if (STRUCTURAL_PARAMS.has(`${node.type}.${key}`)) continue;
    const vec2Group = vec2Groups.find((g) => g.x === key);
    if (vec2Group) {
      fields.push(vec2Descriptor(vec2Group));
      continue;
    }
    if (isFilterNode && key === "effectId") {
      const groups = groupByCategory(listFilterableFragmentEffects());
      fields.push({
        kind: "enum",
        key,
        label: "Effect",
        icon: <Film size={14} />,
        value: filterEffectId,
        placeholder: "— none —",
        groups: [
          { label: "", options: [{ value: "", label: "— none —" }] },
          ...groups.map(([category, defsInGroup]) => ({ label: category, options: defsInGroup.map((d) => ({ value: d.id, label: d.name })) })),
        ],
        onChange: (nextId) =>
          onUpdateComp((current) => {
            const target = current.nodes[nodeId];
            if (!target) return current;
            return { ...current, nodes: { ...current.nodes, [nodeId]: { ...target, params: { ...target.params, effectId: nextId, effectParams: "{}" } } } };
          }),
      });
      continue;
    }
    if (isFilterNode && key === "effectParams") {
      if (filterDef) for (const param of filterDef.params) fields.push(filterParamDescriptor(param));
      continue;
    }
    const payloadEditor = PAYLOAD_EDITORS[`${node.type}.${key}`];
    if (payloadEditor) {
      const payload = typeof node.params[key] === "string" ? (node.params[key] as string) : "";
      fields.push({
        kind: "custom",
        key,
        node: <div className="flarex-curve-editor">{payloadEditor(payload, (json) => setParam(key, json))}</div>,
      });
      continue;
    }
    if (node.type === "lut" && key === "lut") {
      // Same .cube importer the clip inspector uses: the parsed LUT is stored base64 IN the param,
      // so the comp carries its own LUT bytes and an export never has to resolve a file path.
      const current = typeof node.params.lut === "string" ? (node.params.lut as string) : "";
      fields.push({
        kind: "control",
        key,
        label: "LUT file",
        icon: <Film size={14} />,
        control: <LutFileImport value={current} onChange={(next) => setParam("lut", next)} />,
      });
      continue;
    }
    if (node.type === "look" && key === "look") {
      const current = typeof node.params.look === "string" ? (node.params.look as string) : "";
      fields.push({
        kind: "enum",
        key,
        label: "Look",
        icon: <Sparkles size={14} />,
        value: current,
        placeholder: "— none —",
        options: [{ value: "", label: "— none —" }, ...CREATIVE_LOOK_NAMES.map((name) => ({ value: name, label: name }))],
        onChange: (next) => setParam("look", next),
      });
      continue;
    }
    if (node.type === "mediaIn" && key === "sourceAssetId") {
      // Asset-source MediaIn: pick which media-pool asset this input loads. Empty = the host clip. Picking
      // an asset labels the node with the asset name; clearing back to Host drops the label.
      const current = typeof node.params.sourceAssetId === "string" ? (node.params.sourceAssetId as string) : "";
      const onPick = (nextId: string) => {
        const picked = sourceAssets.find((a) => a.id === nextId);
        onUpdateComp((cur) => {
          const target = cur.nodes[nodeId];
          if (!target) return cur;
          return { ...cur, nodes: { ...cur.nodes, [nodeId]: { ...target, params: { ...target.params, sourceAssetId: nextId }, label: nextId === "" ? undefined : picked?.name ?? target.label } } };
        });
      };
      fields.push({
        kind: "control",
        key,
        label: "Source",
        icon: <Film size={14} />,
        className: "flarex-row-source",
        control: <FlarexSourcePicker value={current} assets={sourceAssets} onOpenPicker={onPickSource ? () => onPickSource(nodeId) : undefined} onClear={() => onPick("")} onInspect={onInspectSource} />,
      });
      continue;
    }

    const value = node.params[key] ?? defaults[key];
    if (value === undefined) continue;
    const metaKey = `${node.type}.${key}`;
    const label = prettyLabel(key);
    if (typeof value === "boolean") {
      fields.push({ kind: "boolean", key, label, icon: paramIcon(key), value, onChange: (next) => setParam(key, next) });
      continue;
    }
    if (typeof value === "number") {
      fields.push(numberFieldDescriptor(key));
      continue;
    }
    const options = ENUMS[metaKey];
    if (options) {
      fields.push({ kind: "enum", key, label, icon: paramIcon(key), value, options: options.map((option) => ({ value: option, label: option })), onChange: (next) => setParam(key, next) });
      continue;
    }
    if (COLOR_PARAMS.has(metaKey)) {
      fields.push({ kind: "color", key, label, icon: paramIcon(key), value: /^#[0-9a-fA-F]{6}$/.test(value) ? value : "#00b140", onChange: (next) => setParam(key, next) });
      continue;
    }
    if (POINT_LIST_PARAMS.has(metaKey)) {
      const points = parsePointsParam(value);
      const setPoints = (next: Array<[number, number]>) => setParam(key, JSON.stringify(next));
      fields.push({ kind: "custom", key, node: <FlarexPointsEditor label={label} points={points} onChange={setPoints} /> });
      continue;
    }
    fields.push({ kind: "text", key, label, icon: paramIcon(key), value, onChange: (next) => setParam(key, next) });
  }

  // Rename (shared text row) — always last.
  fields.push({ kind: "text", key: "__label", label: "Label", icon: <Tag size={14} />, value: node.label ?? "", placeholder: def.label, onChange: (next) => patchNode({ label: next || undefined }) });

  return fields;
}

/** Structured point-list editor for polygon/bezier masks (comp-fraction 0..1). A specialized data editor,
 *  parallel to the app's CurveEditor — rendered through the shared schema's `custom` field. */
function FlarexPointsEditor({ label, points, onChange }: { label: string; points: Array<[number, number]>; onChange: (next: Array<[number, number]>) => void }) {
  return (
    <div className="flarex-points-editor">
      <span className="flarex-points-editor-label">{label} (comp fraction 0..1)</span>
      {points.map((p, i) => (
        <div key={i} className="flarex-points-row">
          <span className="flarex-points-index">{i + 1}</span>
          <input
            className="effect-slider-number"
            type="number"
            step={0.01}
            value={p[0]}
            onChange={(e) => onChange(points.map((pt, idx) => (idx === i ? ([Number(e.target.value) || 0, pt[1]] as [number, number]) : pt)))}
          />
          <input
            className="effect-slider-number"
            type="number"
            step={0.01}
            value={p[1]}
            onChange={(e) => onChange(points.map((pt, idx) => (idx === i ? ([pt[0], Number(e.target.value) || 0] as [number, number]) : pt)))}
          />
          <button
            type="button"
            title="Move up"
            disabled={i === 0}
            onClick={() => {
              const next = [...points];
              [next[i - 1], next[i]] = [next[i]!, next[i - 1]!];
              onChange(next);
            }}
          >
            ↑
          </button>
          <button
            type="button"
            title="Move down"
            disabled={i === points.length - 1}
            onClick={() => {
              const next = [...points];
              [next[i + 1], next[i]] = [next[i]!, next[i + 1]!];
              onChange(next);
            }}
          >
            ↓
          </button>
          <button type="button" title="Remove point (3 minimum)" disabled={points.length <= 3} onClick={() => onChange(points.filter((_, idx) => idx !== i))}>
            ✕
          </button>
        </div>
      ))}
      <button type="button" className="flarex-points-add" onClick={() => onChange([...points, [0.5, 0.5]])}>
        + Add point
      </button>
    </div>
  );
}

/** One collapsible group of the unified Color node's inspector. */
export interface FlarexColorSection {
  id: string;
  label: string;
  /** This stage is doing something — drives the header dot, so a COLLAPSED section still reports it. */
  active: boolean;
  defaultOpen: boolean;
  fields: PropertyField[];
}

/**
 * Split the unified Color node's fields into Resolve-order sections (Primary → Wheels → Curves →
 * Hue/Sat → Qualifier → LUT → Look → Film).
 *
 * Built by PARTITIONING the ordinary field list rather than by a separate builder, so every param
 * keeps the exact binding it would have on an atomic node — keyframes, ranges, payload editors and
 * the animated-edit write rule all come from one place. Anything not claimed by a section falls into
 * a trailing "Other" group, so a param added to the node can never become invisible.
 *
 * Empty sections are dropped. The caller renders each through the shared `InspectorSection` +
 * `PropertyFieldList` — this returns data, not markup, and adds no new field kind.
 */
export function buildFlarexColorNodeSections(args: BuildFlarexNodeFieldsArgs): FlarexColorSection[] {
  const all = buildFlarexNodeFields(args);
  const params = args.node.params;
  const claimed = new Set<string>();
  const sections: FlarexColorSection[] = [];
  for (const spec of COLOR_NODE_SECTIONS) {
    const fields = spec.params.map((key) => all.find((f) => f.key === key)).filter((f): f is PropertyField => Boolean(f));
    for (const field of fields) claimed.add(field.key);
    if (!fields.length) continue;
    sections.push({
      id: spec.id,
      label: spec.label,
      active: colorSectionActive(params, spec.params),
      defaultOpen: spec.open ?? false,
      fields,
    });
  }
  const rest = all.filter((f) => !claimed.has(f.key));
  if (rest.length) {
    sections.push({ id: "other", label: "Other", active: false, defaultOpen: true, fields: rest });
  }
  return sections;
}
