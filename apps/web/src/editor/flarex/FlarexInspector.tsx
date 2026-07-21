/**
 * Flarex node inspector (FLAREX.md Part 5) — param rows for the selected node rendered through the
 * MAIN inspector's canonical shells (`PropertyRow` / `EffectSliderControl` on the
 * `.effect-slider-control` grid), so sliders, keyframe diamonds and prev/next navigation read
 * pixel-identical to the Edit-page inspector. Every change is ONE comp update through the caller's
 * stamped write path (undo-friendly, bumps `version` → live preview re-lowers).
 *
 * The panel is RESIZABLE via the left-edge handle (width persisted per browser).
 */

import { useRef, useState } from "react";
import {
  evaluateFlarexNodeParam,
  getFlarexNodeDefinition,
  parseFlarexNodeParams,
  type FlarexComp,
  type FlarexNode,
} from "@orreris/shared";
import { EffectSliderControl } from "../../components/EffectSliderControl";
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

/** Slider ranges for numeric params (kept in sync with node-defs' Zod bounds). Fallback = free field. */
const RANGES: Record<string, [number, number, number]> = {
  "merge.opacity": [0, 1, 0.01],
  "transform.x": [-100, 100, 0.5],
  "transform.y": [-100, 100, 0.5],
  "transform.scale": [0, 4, 0.01],
  "transform.rotation": [-180, 180, 1],
  "transform.anchorX": [0, 1, 0.01],
  "transform.anchorY": [0, 1, 0.01],
  "colorCorrect.exposure": [-100, 100, 1],
  "colorCorrect.contrast": [-100, 100, 1],
  "colorCorrect.saturation": [0, 220, 1],
  "colorCorrect.temperature": [-100, 100, 1],
  "colorCorrect.tint": [-100, 100, 1],
  "blur.sigma": [0, 200, 1],
  "glow.radius": [0, 200, 1],
  "glow.intensity": [0, 2, 0.01],
  "glow.threshold": [0, 1, 0.01],
  "sharpen.amount": [0, 2, 0.01],
  "filter.intensity": [0, 1, 0.01],
  "chromaKey.tolerance": [0, 1, 0.01],
  "chromaKey.softness": [0, 1, 0.01],
  "chromaKey.clipBlack": [0, 1, 0.01],
  "chromaKey.clipWhite": [0, 1, 0.01],
  "chromaKey.spillSuppression": [0, 1, 0.01],
  "chromaKey.edgeSoftness": [0, 20, 0.5],
  "chromaKey.choke": [-1, 1, 0.01],
  "chromaKey.decontaminate": [0, 1, 0.01],
  "lumaKey.low": [0, 1, 0.01],
  "lumaKey.high": [0, 1, 0.01],
  "lumaKey.softness": [0, 1, 0.01],
  "rectMask.centerX": [0, 1, 0.01],
  "rectMask.centerY": [0, 1, 0.01],
  "rectMask.width": [0, 2, 0.01],
  "rectMask.height": [0, 2, 0.01],
  "rectMask.feather": [0, 1, 0.01],
  "rectMask.cornerRadius": [0, 1, 0.01],
  "ellipseMask.centerX": [0, 1, 0.01],
  "ellipseMask.centerY": [0, 1, 0.01],
  "ellipseMask.width": [0, 2, 0.01],
  "ellipseMask.height": [0, 2, 0.01],
  "ellipseMask.feather": [0, 1, 0.01],
  "matteControl.feather": [0, 1, 0.01],
  "polygonMask.feather": [0, 1, 0.01],
  "bezierMask.feather": [0, 1, 0.01],
  "text.fontSize": [1, 400, 1],
  "text.x": [0, 1, 0.01],
  "text.y": [0, 1, 0.01],
};

const ENUMS: Record<string, readonly string[]> = {
  "merge.blend": [
    "normal", "multiply", "screen", "overlay", "darken", "lighten", "color-dodge", "color-burn",
    "hard-light", "soft-light", "difference", "exclusion", "hue", "saturation", "color", "luminosity", "add",
  ],
  "matteControl.operation": ["add", "subtract", "intersect", "exclude"],
};

const COLOR_PARAMS = new Set(["chromaKey.color", "text.color"]);
/** Multiline JSON payload rows — a crude but functional textarea (on-viewer point editing is
 *  explicitly out of scope for Phase 1.5, see FLAREX.md). */
const MULTILINE_PARAMS = new Set(["polygonMask.points", "bezierMask.points"]);

const prettyLabel = (key: string): string =>
  key.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase());

const WIDTH_KEY = "flarex.inspectorWidth";
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
    <aside className="flarex-inspector" style={{ flex: `0 0 ${width}px`, width }}>
      <div
        className="flarex-inspector-resize"
        title="Drag to resize"
        onPointerDown={onResizeDown}
        onPointerMove={onResizeMove}
        onPointerUp={onResizeUp}
        onPointerCancel={onResizeUp}
      />
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
          if (MULTILINE_PARAMS.has(metaKey)) {
            return (
              <label key={key} className="flarex-param-row flarex-param-multiline">
                <span>{label}</span>
                <textarea
                  rows={3}
                  value={value}
                  placeholder="[[0.3,0.2],[0.7,0.2],[0.5,0.85]]"
                  onChange={(e) => setParam(key, e.target.value)}
                />
              </label>
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
