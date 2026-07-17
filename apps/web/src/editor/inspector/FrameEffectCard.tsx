/**
 * Frames (see FRAMES.md) — the applied frame's editable parameters, shown as a card in the inspector's
 * Effects subpanel (the founder's requirement: "whatever parameters can be edited will be in the effects
 * subpanel"). Pure UI over `layer.frame.params`: the param SCHEMA comes from the FrameDefinition, so this
 * renders whatever knobs a frame (built-in OR a marketplace pack) declares — nothing is hardcoded here.
 */

import { Frame as FrameIcon, Shapes, Trash2 } from "lucide-react";
import {
  findFrameDefinition,
  frameBoxPercent,
  frameParamSections,
  frameToShapeLayer,
  setFrameBoxAxis,
  type FrameParamValue,
  type TimelineLayer
} from "@kimera-by-aelivion/shared";
import { BooleanControl } from "./controls/BooleanControl";
import { ColorControl } from "./controls/ColorControl";
import { NumberControl } from "./controls/NumberControl";

function numberOf(value: FrameParamValue | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function booleanOf(value: FrameParamValue | undefined, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function stringOf(value: FrameParamValue | undefined, fallback: string): string {
  return typeof value === "string" && value ? value : fallback;
}

export function FrameEffectCard({
  layer,
  comp,
  onChange
}: {
  layer: TimelineLayer;
  /** Comp box — the frame's width/height are percentages OF it, and aspectLock squares against it. */
  comp: { width: number; height: number };
  onChange: (updater: (layer: TimelineLayer) => TimelineLayer) => void;
}) {
  const frame = layer.frame;
  if (!frame) return null;
  const def = findFrameDefinition(frame.definitionId);
  // Show the EFFECTIVE box, not the raw params: with aspectLock on they differ (the box is squared at
  // render time), and a field that disagrees with the canvas also makes its reset button look dead —
  // reset would write 100 over a field already reading 100 while the shape stayed square. (QA round 2)
  const boxPercent = frameBoxPercent(frame, comp);
  // Sections come from shared data (generator params "Shape", then the universal "Box" chrome), so the
  // card never knows which tier a param belongs to — an imported pack frame groups itself.
  const sections = def ? frameParamSections(def) : [];

  function setParam(key: string, value: FrameParamValue) {
    onChange((item) =>
      item.frame ? { ...item, frame: { ...item.frame, params: { ...item.frame.params, [key]: value } } } : item
    );
  }

  /** Box axis edit — writes BOTH axes when locked, so the square actually follows the drag. */
  function setBoxAxis(axis: "width" | "height", value: number) {
    onChange((item) =>
      item.frame ? { ...item, frame: { ...item.frame, params: setFrameBoxAxis(item.frame, axis, value, comp) } } : item
    );
  }

  return (
    <div className="frame-effect-card">
      <div className="frame-effect-card-head">
        <span className="frame-effect-card-title">
          <FrameIcon size={13} />
          {def?.name ?? "Frame"}
        </span>
        <span className="frame-effect-card-actions">
          <button
            type="button"
            className="frame-effect-card-action"
            title="Convert to graphic — becomes an editable shape (media is dropped; undoable)"
            aria-label="Convert to graphic"
            onClick={() => onChange((item) => frameToShapeLayer(item, comp))}
          >
            <Shapes size={13} />
          </button>
          <button
            type="button"
            className="frame-effect-card-remove"
            title="Remove frame (media un-clips)"
            aria-label="Remove frame"
            onClick={() => onChange((item) => ({ ...item, frame: undefined }))}
          >
            <Trash2 size={13} />
          </button>
        </span>
      </div>
      {sections.map((section) => (
        <div className="frame-effect-card-section" key={section.title}>
          <span className="frame-effect-card-section-title">{section.title}</span>
          <div className="control-grid">
            {section.params.map((param) => {
              // Render by param TYPE, so a frame gets the right control for whatever it declares.
              // Unhandled variants are skipped rather than crashing an imported pack's card.
              // The two box axes are linked (aspectLock) and displayed from the effective box, so they
              // route through the shared geometry rather than reading/writing their param directly.
              //
              // Shown in PIXELS, not the stored %: width is a % of the comp's WIDTH and height a % of its
              // HEIGHT — two different rulers — so a locked SQUARE reads "29 / 51" in a 16:9 comp, which
              // looks broken next to "Lock Aspect: On" even though the box is exactly square (550.8px each
              // way). Pixels are one ruler, so a square reads 551 / 551. This is display-only: the params
              // stay percentages, which is what keeps a frame resolution-independent across a reframe.
              if (param.key === "width" || param.key === "height") {
                const axis = param.key;
                const compExtent = Math.max(1, axis === "width" ? comp.width : comp.height);
                return (
                  <NumberControl
                    key={param.key}
                    label={param.label}
                    value={Math.round((boxPercent[axis] / 100) * compExtent)}
                    min={1}
                    max={Math.round(compExtent)}
                    step={1}
                    onReset={() => setBoxAxis(axis, param.type === "number" ? param.defaultValue : 100)}
                    onChange={(value) => setBoxAxis(axis, (value / compExtent) * 100)}
                  />
                );
              }
              if (param.type === "number") {
                return (
                  <NumberControl
                    key={param.key}
                    label={param.label}
                    value={numberOf(frame.params[param.key], param.defaultValue)}
                    min={param.min}
                    max={param.max}
                    step={param.step}
                    onReset={() => setParam(param.key, param.defaultValue)}
                    onChange={(value) => setParam(param.key, value)}
                  />
                );
              }
              if (param.type === "boolean") {
                return (
                  <BooleanControl
                    key={param.key}
                    label={param.label}
                    value={booleanOf(frame.params[param.key], param.defaultValue)}
                    onReset={() => setParam(param.key, param.defaultValue)}
                    onChange={(value) => setParam(param.key, value)}
                  />
                );
              }
              if (param.type === "color") {
                return (
                  <ColorControl
                    key={param.key}
                    label={param.label}
                    value={stringOf(frame.params[param.key], param.defaultValue)}
                    onReset={() => setParam(param.key, param.defaultValue)}
                    onChange={(value) => setParam(param.key, value)}
                  />
                );
              }
              return null;
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
