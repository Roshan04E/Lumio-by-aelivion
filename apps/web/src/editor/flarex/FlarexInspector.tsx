/**
 * Flarex node inspector (FLAREX.md Part 5) — param rows for the selected node rendered through the
 * MAIN inspector's canonical shells (`PropertyRow` / `EffectSliderControl` on the
 * `.effect-slider-control` grid), so sliders, keyframe diamonds and prev/next navigation read
 * pixel-identical to the Edit-page inspector. Every change is ONE comp update through the caller's
 * stamped write path (undo-friendly, bumps `version` → live preview re-lowers).
 *
 * The panel is RESIZABLE via the left-edge handle (width persisted per browser).
 */

import { useEffect, useRef, useState } from "react";
import { Maximize2, Minimize2 } from "lucide-react";
import {
  evaluateFlarexNodeParam,
  getFlarexNodeDefinition,
  parseFlarexNodeParams,
  listFragmentEffects,
  getFragmentEffect,
  FLAREX_CHROMA_KEY_ID,
  FLAREX_LUMA_KEY_ID,
  type FlarexComp,
  type FlarexNode,
  type FragmentEffectDefinition,
  type FragmentEffectParam,
} from "@orreris/shared";
import { EffectSliderControl } from "../../components/EffectSliderControl";
import { CurveEditor } from "../../components/CurveEditor";
import { HueSatCurves } from "../../components/HueSatCurves";
import { PropertyRow } from "../inspector/controls/PropertyRow";
import type { KeyframeButtonsProps } from "../inspector/controls/KeyframeButtons";
import {
  applyNodeParamValueAtTime,
  clearNodeParamKeyframes,
  findNodeParamKeyframe,
  getActiveNodeParamKeyframe,
  getNodeParamKeyframes,
  toggleNodeParamKeyframe
} from "./flarex-keyframes";
// Slider ranges live in ONE place (`flarex-param-meta.ts`) so the inspector rows and the graph-editor
// lanes clamp identically — a lane clamping differently from its inspector row would let one surface
// author a value the other refuses.
import { FLAREX_PARAM_RANGES as RANGES } from "./flarex-param-meta";

const ENUMS: Record<string, readonly string[]> = {
  "merge.blend": [
    "normal", "multiply", "screen", "overlay", "darken", "lighten", "color-dodge", "color-burn",
    "hard-light", "soft-light", "difference", "exclusion", "hue", "saturation", "color", "luminosity", "add",
  ],
  "matteControl.operation": ["add", "subtract", "intersect", "exclude"],
};

const COLOR_PARAMS = new Set(["chromaKey.color", "text.color", "backdrop.color"]);
/** polygonMask/bezierMask `points` — a structured row-per-point editor (F3, round 3). FLAREX.md's
 *  original plan was a full on-viewer SVG drag overlay above `ScenePreviewCanvas`; that touches the
 *  live viewer's coordinate mapping across preview/export capture paths (a much bigger, riskier
 *  seam) for marginal gain over a structured list — the plan's own documented fallback when the
 *  viewer overlay "proves too entangled." Taking the fallback deliberately this round: same crude-
 *  but-functional spirit as the JSON textarea it replaces, minus the raw-JSON editing. */
const POINT_LIST_PARAMS = new Set(["polygonMask.points", "bezierMask.points"]);

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

const prettyLabel = (key: string): string =>
  key.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase());

/** Fragment-effect registry entries selectable from the `filter` node — excludes the two
 *  flarex-only keyers (chromaKey/lumaKey have their own dedicated node types) and multi-pass
 *  stylize graphs (heavy pass-graphs that don't read as a single lightweight chain filter). */
function listFilterableFragmentEffects(): FragmentEffectDefinition[] {
  return listFragmentEffects().filter(
    (def) => !def.passes && def.id !== FLAREX_CHROMA_KEY_ID && def.id !== FLAREX_LUMA_KEY_ID,
  );
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

const WIDTH_KEY = "flarex.inspectorWidth";
const MAX_KEY = "flarex.inspectorMax";
const MIN_W = 240;
const MAX_W = 560;

export interface FlarexInspectorProps {
  comp: FlarexComp;
  node: FlarexNode | null;
  onUpdateComp: (updater: (comp: FlarexComp) => FlarexComp) => void;
  /** Comp-local playhead (shared transport − layer.startSeconds, clamped ≥ 0) — where keyframes land. */
  compTime: number;
  /** Seek the shared transport to a comp-local time (used by prev/next keyframe nav). */
  onSeekCompTime: (compTime: number) => void;
}

export function FlarexInspector({ comp, node, onUpdateComp, compTime, onSeekCompTime }: FlarexInspectorProps) {
  const [width, setWidth] = useState<number>(() => {
    const stored = Number(window.localStorage.getItem(WIDTH_KEY));
    return Number.isFinite(stored) && stored >= MIN_W && stored <= MAX_W ? stored : 300;
  });
  const resizeRef = useRef<{ startX: number; startW: number } | null>(null);
  // Maximize: the node inspector is cramped in the workspace corner, so a toggle lifts it to a
  // full-height column docked immediately LEFT of the main clip inspector (which stays open) — you
  // can read a node's params and the clip's grade side by side. Persisted like the width.
  const [maximized, setMaximized] = useState<boolean>(() => window.localStorage.getItem(MAX_KEY) === "1");
  const toggleMax = () => {
    setMaximized((m) => {
      const next = !m;
      window.localStorage.setItem(MAX_KEY, next ? "1" : "0");
      return next;
    });
  };
  // Drive the editor layout so a maximized inspector sits ALONGSIDE the viewer (shrinking it),
  // never on top: widen the right column by the inspector's width via a class + var on
  // `.editor-layout`, and the fixed panel fills that reserved strip. Self-contained (no prop chain);
  // cleaned up on restore and on unmount (leaving the Flarex page).
  useEffect(() => {
    const layout = document.querySelector<HTMLElement>(".editor-layout");
    if (!layout) return undefined;
    if (maximized) {
      layout.classList.add("is-flarex-inspector-max");
      layout.style.setProperty("--flarex-max-w", `${width}px`);
    } else {
      layout.classList.remove("is-flarex-inspector-max");
      layout.style.removeProperty("--flarex-max-w");
    }
    return () => {
      layout.classList.remove("is-flarex-inspector-max");
      layout.style.removeProperty("--flarex-max-w");
    };
  }, [maximized, width]);

  const onResizeDown = (event: React.PointerEvent) => {
    resizeRef.current = { startX: event.clientX, startW: width };
    (event.target as Element).setPointerCapture(event.pointerId);
  };
  const onResizeMove = (event: React.PointerEvent) => {
    const r = resizeRef.current;
    if (!r) return;
    // Handle sits on the LEFT edge — dragging left widens the panel.
    setWidth(Math.max(MIN_W, Math.min(MAX_W, r.startW + (r.startX - event.clientX))));
  };
  const onResizeUp = () => {
    if (!resizeRef.current) return;
    resizeRef.current = null;
    window.localStorage.setItem(WIDTH_KEY, String(width));
  };

  const shell = (children: React.ReactNode) => (
    <aside
      className={`flarex-inspector${maximized ? " flarex-inspector--max" : ""}`}
      style={{ flex: `0 0 ${width}px`, width }}
    >
      <div
        className="flarex-inspector-resize"
        title="Drag to resize"
        onPointerDown={onResizeDown}
        onPointerMove={onResizeMove}
        onPointerUp={onResizeUp}
        onPointerCancel={onResizeUp}
      />
      <button
        type="button"
        className="flarex-inspector-max-btn"
        title={maximized ? "Restore node inspector" : "Maximize node inspector (full height, beside the main inspector)"}
        aria-pressed={maximized}
        onClick={toggleMax}
      >
        {maximized ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
      </button>
      {children}
    </aside>
  );

  if (!node) {
    return shell(<div className="flarex-inspector-empty">Select a node</div>);
  }
  const def = getFlarexNodeDefinition(node.type);
  const keyframeable = new Set(def.keyframeable);
  const nodeId = node.id;
  const defaults = parseFlarexNodeParams(node.type, {});

  const patchNode = (patch: Partial<FlarexNode>) => {
    onUpdateComp((current) => {
      const target = current.nodes[node.id];
      if (!target) return current;
      return { ...current, nodes: { ...current.nodes, [node.id]: { ...target, ...patch } } };
    });
  };
  const setParam = (key: string, value: string | number | boolean) => {
    onUpdateComp((current) => {
      const target = current.nodes[node.id];
      if (!target) return current;
      return {
        ...current,
        nodes: { ...current.nodes, [node.id]: { ...target, params: { ...target.params, [key]: value } } },
      };
    });
  };

  // Filter node: effectId select + dynamic per-effect param rows (registry-driven, N1).
  const isFilterNode = node.type === "filter";
  const filterEffectId = isFilterNode && typeof node.params.effectId === "string" ? (node.params.effectId as string) : "";
  const filterDef = isFilterNode && filterEffectId ? getFragmentEffect(filterEffectId) : undefined;
  const filterEffectParams = isFilterNode
    ? parseFilterEffectParams(typeof node.params.effectParams === "string" ? (node.params.effectParams as string) : "")
    : {};
  const onFilterEffectIdChange = (nextId: string) => {
    onUpdateComp((current) => {
      const target = current.nodes[node.id];
      if (!target) return current;
      return {
        ...current,
        nodes: { ...current.nodes, [node.id]: { ...target, params: { ...target.params, effectId: nextId, effectParams: "{}" } } },
      };
    });
  };
  const setFilterEffectParam = (paramName: string, value: number | number[] | boolean) => {
    onUpdateComp((current) => {
      const target = current.nodes[node.id];
      if (!target) return current;
      const existing = parseFilterEffectParams(typeof target.params.effectParams === "string" ? (target.params.effectParams as string) : "");
      const next = { ...existing, [paramName]: value };
      return {
        ...current,
        nodes: { ...current.nodes, [node.id]: { ...target, params: { ...target.params, effectParams: JSON.stringify(next) } } },
      };
    });
  };
  const renderFilterParamRow = (param: FragmentEffectParam) => {
    const current = filterEffectParams[param.name];
    if (param.type === "bool") {
      const value = typeof current === "boolean" ? current : Boolean(param.default);
      return (
        <PropertyRow
          key={param.name}
          label={param.label ?? prettyLabel(param.name)}
          control={<span />}
          value={<input type="checkbox" checked={value} onChange={(e) => setFilterEffectParam(param.name, e.target.checked)} />}
        />
      );
    }
    if (param.type === "vec3") {
      const value = Array.isArray(current) ? current : (param.default as number[]);
      return (
        <PropertyRow
          key={param.name}
          label={param.label ?? prettyLabel(param.name)}
          className="flarex-row-color"
          control={<input type="color" value={rgbToHex(value)} onChange={(e) => setFilterEffectParam(param.name, hexToRgb(e.target.value))} />}
        />
      );
    }
    if (param.type === "vec2") {
      const value = Array.isArray(current) ? current : (param.default as number[]);
      return (
        <PropertyRow
          key={param.name}
          label={param.label ?? prettyLabel(param.name)}
          control={<span />}
          value={
            <span className="flarex-vec2-row">
              <input
                className="effect-slider-number"
                type="number"
                value={Number.isFinite(value[0]) ? value[0] : 0}
                onChange={(e) => setFilterEffectParam(param.name, [Number(e.target.value) || 0, value[1] ?? 0])}
              />
              <input
                className="effect-slider-number"
                type="number"
                value={Number.isFinite(value[1]) ? value[1] : 0}
                onChange={(e) => setFilterEffectParam(param.name, [value[0] ?? 0, Number(e.target.value) || 0])}
              />
            </span>
          }
        />
      );
    }
    // float
    const value = typeof current === "number" ? current : (param.default as number);
    return (
      <EffectSliderControl
        key={param.name}
        label={param.label ?? prettyLabel(param.name)}
        value={value}
        min={param.min ?? 0}
        max={param.max ?? 1}
        step={param.step ?? 0.01}
        onChange={(next) => setFilterEffectParam(param.name, next)}
        onReset={() => setFilterEffectParam(param.name, param.default as number)}
      />
    );
  };

  return shell(
    <>
      <header className="flarex-inspector-head">
        <span className="flarex-inspector-title">{node.label ?? def.label}</span>
        <label className="flarex-inspector-enable" title="Enable / pass-through">
          <input type="checkbox" checked={node.enabled} onChange={(e) => patchNode({ enabled: e.target.checked })} />
          <span>{node.enabled ? "On" : "Off"}</span>
        </label>
      </header>
      <div className="flarex-inspector-body">
        {/* Schema order, not object-insertion order — rows keep a stable, designed sequence, and
            nodes saved before a def gained new params still show them (value falls back to the
            default until first edited). */}
        {[...Object.keys(defaults), ...Object.keys(node.params).filter((k) => !(k in defaults))].map((key) => {
          if (isFilterNode && key === "effectId") {
            const groups = groupByCategory(listFilterableFragmentEffects());
            return (
              <PropertyRow
                key={key}
                label="Effect"
                className="flarex-row-select"
                control={
                  <select value={filterEffectId} onChange={(e) => onFilterEffectIdChange(e.target.value)}>
                    <option value="">— none —</option>
                    {groups.map(([category, defsInGroup]) => (
                      <optgroup key={category} label={category}>
                        {defsInGroup.map((d) => (
                          <option key={d.id} value={d.id}>
                            {d.name}
                          </option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                }
              />
            );
          }
          if (isFilterNode && key === "effectParams") {
            if (!filterDef) return null;
            return <div key={key} className="flarex-filter-params">{filterDef.params.map(renderFilterParamRow)}</div>;
          }
          if (node.type === "colorCurves" && key === "curves") {
            const curveValue = typeof node.params.curves === "string" ? (node.params.curves as string) : "";
            return (
              <div key={key} className="flarex-curve-editor">
                <CurveEditor value={curveValue} onChange={(json) => setParam("curves", json)} />
              </div>
            );
          }
          if (node.type === "hueSat" && key === "hueCurves") {
            const curveValue = typeof node.params.hueCurves === "string" ? (node.params.hueCurves as string) : "";
            return (
              <div key={key} className="flarex-curve-editor">
                <HueSatCurves value={curveValue} onChange={(json) => setParam("hueCurves", json)} />
              </div>
            );
          }
          const value = node.params[key] ?? defaults[key];
          if (value === undefined) return null;
          const metaKey = `${node.type}.${key}`;
          const label = prettyLabel(key);
          if (typeof value === "boolean") {
            return (
              <PropertyRow
                key={key}
                label={label}
                control={<span />}
                value={<input type="checkbox" checked={value} onChange={(e) => setParam(key, e.target.checked)} />}
              />
            );
          }
          if (typeof value === "number") {
            const range = RANGES[metaKey];
            const canKeyframe = keyframeable.has(key);
            // When animated, the row must SHOW the sampled value at the playhead (not the ignored
            // base), and a drag must upsert a keyframe there — the animated-edit rule.
            const displayValue = canKeyframe
              ? evaluateFlarexNodeParam({ animations: comp.animations, baseValue: value, nodeId, paramKey: key, timeSeconds: compTime })
              : value;
            const writeParam = (next: number) => {
              if (canKeyframe) {
                onUpdateComp((current) => applyNodeParamValueAtTime(current, nodeId, key, compTime, next));
              } else {
                setParam(key, next);
              }
            };
            const keyframe: Omit<KeyframeButtonsProps, "label"> | undefined = canKeyframe
              ? {
                  active: Boolean(getActiveNodeParamKeyframe(comp, nodeId, key, compTime)),
                  hasAny: getNodeParamKeyframes(comp, nodeId, key).length > 0,
                  hasPrevious: Boolean(findNodeParamKeyframe(comp, nodeId, key, compTime, -1)),
                  hasNext: Boolean(findNodeParamKeyframe(comp, nodeId, key, compTime, 1)),
                  onToggle: () => onUpdateComp((current) => toggleNodeParamKeyframe(current, nodeId, key, compTime, displayValue)),
                  onClearAll: () => onUpdateComp((current) => clearNodeParamKeyframes(current, nodeId, key)),
                  onPrevious: () => {
                    const kf = findNodeParamKeyframe(comp, nodeId, key, compTime, -1);
                    if (kf) onSeekCompTime(kf.timeSeconds);
                  },
                  onNext: () => {
                    const kf = findNodeParamKeyframe(comp, nodeId, key, compTime, 1);
                    if (kf) onSeekCompTime(kf.timeSeconds);
                  },
                }
              : undefined;
            const defaultValue = typeof defaults[key] === "number" ? (defaults[key] as number) : undefined;
            if (range) {
              return (
                <EffectSliderControl
                  key={key}
                  label={label}
                  value={displayValue}
                  min={range[0]}
                  max={range[1]}
                  step={range[2]}
                  keyframe={keyframe}
                  onChange={writeParam}
                  onReset={defaultValue !== undefined ? () => writeParam(defaultValue) : undefined}
                />
              );
            }
            return (
              <PropertyRow
                key={key}
                label={label}
                keyframe={keyframe}
                control={<span />}
                value={
                  <input
                    className="effect-slider-number"
                    type="number"
                    value={Number.isFinite(displayValue) ? Number(displayValue.toFixed(4)) : 0}
                    onChange={(e) => {
                      const parsed = Number(e.target.value);
                      if (Number.isFinite(parsed)) writeParam(parsed);
                    }}
                  />
                }
              />
            );
          }
          const options = ENUMS[metaKey];
          if (options) {
            return (
              <PropertyRow
                key={key}
                label={label}
                className="flarex-row-select"
                control={
                  <select value={value} onChange={(e) => setParam(key, e.target.value)}>
                    {options.map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                }
              />
            );
          }
          if (COLOR_PARAMS.has(metaKey)) {
            return (
              <PropertyRow
                key={key}
                label={label}
                className="flarex-row-color"
                control={
                  <input type="color" value={/^#[0-9a-fA-F]{6}$/.test(value) ? value : "#00b140"} onChange={(e) => setParam(key, e.target.value)} />
                }
              />
            );
          }
          if (POINT_LIST_PARAMS.has(metaKey)) {
            const points = parsePointsParam(value);
            const setPoints = (next: Array<[number, number]>) => setParam(key, JSON.stringify(next));
            return (
              <div key={key} className="flarex-points-editor">
                <span className="flarex-points-editor-label">{label} (comp fraction 0..1)</span>
                {points.map((p, i) => (
                  <div key={i} className="flarex-points-row">
                    <span className="flarex-points-index">{i + 1}</span>
                    <input
                      className="effect-slider-number"
                      type="number"
                      step={0.01}
                      value={p[0]}
                      onChange={(e) => {
                        const next = points.map((pt, idx) => (idx === i ? ([Number(e.target.value) || 0, pt[1]] as [number, number]) : pt));
                        setPoints(next);
                      }}
                    />
                    <input
                      className="effect-slider-number"
                      type="number"
                      step={0.01}
                      value={p[1]}
                      onChange={(e) => {
                        const next = points.map((pt, idx) => (idx === i ? ([pt[0], Number(e.target.value) || 0] as [number, number]) : pt));
                        setPoints(next);
                      }}
                    />
                    <button
                      type="button"
                      title="Move up"
                      disabled={i === 0}
                      onClick={() => {
                        const next = [...points];
                        [next[i - 1], next[i]] = [next[i]!, next[i - 1]!];
                        setPoints(next);
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
                        setPoints(next);
                      }}
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      title="Remove point (3 minimum)"
                      disabled={points.length <= 3}
                      onClick={() => setPoints(points.filter((_, idx) => idx !== i))}
                    >
                      ✕
                    </button>
                  </div>
                ))}
                <button type="button" className="flarex-points-add" onClick={() => setPoints([...points, [0.5, 0.5]])}>
                  + Add point
                </button>
              </div>
            );
          }
          return (
            <PropertyRow
              key={key}
              label={label}
              className="flarex-row-text"
              control={<input type="text" value={value} onChange={(e) => setParam(key, e.target.value)} />}
            />
          );
        })}
        {Object.keys(node.params).length === 0 ? <div className="flarex-inspector-empty">No parameters</div> : null}
        {/* Rename */}
        <PropertyRow
          label="Label"
          className="flarex-row-text"
          control={<input type="text" value={node.label ?? ""} placeholder={def.label} onChange={(e) => patchNode({ label: e.target.value || undefined })} />}
        />
      </div>
    </>,
  );
}
