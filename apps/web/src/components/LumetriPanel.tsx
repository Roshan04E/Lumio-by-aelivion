/**
 * Professional Color System (Phase 3, 13C.6) — Lumetri-style stacked color panel.
 *
 * One collapsible panel that organises all color effects as named sections, matching
 * Adobe Lumetri's UX:
 *   1. Basic Correction  — brightnessContrast (exposure/contrast/tonal/white balance)
 *   2. Creative          — creativeLook + importedLut
 *   3. Curves            — colorCurves (master + R/G/B channel graph)
 *   4. Color Wheels      — colorWheels (3-way Lift/Gamma/Gain)
 *   5. Hue/Sat Curves    — hueSatCurves (5 domain graphs, WebGL)
 *   6. HSL Secondary     — hslSecondary (keyer + correction, WebGL)
 *   7. Vignette          — vignette amount/size sliders
 *
 * Each section is independently collapsible and includes a reset-to-default button.
 * Adding a section's effect if missing happens automatically on first expand.
 */

import { ChevronDown, ChevronRight, RotateCcw } from "lucide-react";
import { useState } from "react";
import { createTimelineEffect, evaluateTimelineEffectParam, type TimelineEffect, type TimelineLayer } from "@reelforge/shared";
import { CurveEditor } from "./CurveEditor";
import { ColorWheels } from "./ColorWheels";
import { HueSatCurves } from "./HueSatCurves";
import { HslSecondary } from "./HslSecondary";
import { LutFileImport } from "./LutFileImport";
import { CREATIVE_LOOK_NAMES } from "@reelforge/shared";
import { EffectSliderControl, effectSliderTone } from "./EffectSliderControl";
import { ThemedSelect } from "../editor/inspector/controls/ThemedSelect";
import {
  clamp,
  getActiveEffectParamKeyframe,
  setEffectParamInterpolation,
  toggleEffectParamKeyframe,
  updateEffectParamAtTime
} from "../editor/inspector/keyframeUtils";

type SectionId = "basic" | "creative" | "curves" | "wheels" | "hue-sat" | "secondary" | "vignette";

interface SectionMeta {
  id: SectionId;
  label: string;
  effectType: string;
}

const SECTIONS: SectionMeta[] = [
  { id: "basic", label: "Basic Correction", effectType: "brightnessContrast" },
  { id: "creative", label: "Creative", effectType: "creativeLook" },
  { id: "curves", label: "Curves", effectType: "colorCurves" },
  { id: "wheels", label: "Color Wheels", effectType: "colorWheels" },
  { id: "hue-sat", label: "Hue/Sat Curves", effectType: "hueSatCurves" },
  { id: "secondary", label: "HSL Secondary", effectType: "hslSecondary" },
  { id: "vignette", label: "Vignette", effectType: "vignette" }
];

interface Props {
  layer: TimelineLayer;
  currentTime: number;
  onChange: (updater: (layer: TimelineLayer) => TimelineLayer) => void;
}

function findEffect(layer: TimelineLayer, type: string): TimelineEffect | undefined {
  return layer.effects?.find((e) => e.type === type);
}

function upsertEffect(layer: TimelineLayer, type: string, updater: (e: TimelineEffect) => TimelineEffect): TimelineLayer {
  const existing = layer.effects?.find((e) => e.type === type);
  if (existing) {
    return { ...layer, effects: layer.effects!.map((e) => (e.type === type ? updater(e) : e)) };
  }
  const created = createTimelineEffect(type as TimelineEffect["type"]);
  return { ...layer, effects: [...(layer.effects ?? []), updater(created)] };
}

function removeEffect(layer: TimelineLayer, type: string): TimelineLayer {
  return { ...layer, effects: (layer.effects ?? []).filter((e) => e.type !== type) };
}

function setEffectParam(effect: TimelineEffect, key: string, value: string | number | boolean): TimelineEffect {
  return { ...effect, params: { ...effect.params, [key]: value } };
}

/** Return the layer with `type` present (creating a default effect if missing). */
function ensureEffect(layer: TimelineLayer, type: string): TimelineLayer {
  if (layer.effects?.some((e) => e.type === type)) return layer;
  const created = createTimelineEffect(type as TimelineEffect["type"]);
  return { ...layer, effects: [...(layer.effects ?? []), created] };
}

function effectIdOf(layer: TimelineLayer, type: string): string | undefined {
  return layer.effects?.find((e) => e.type === type)?.id;
}

interface SectionProps {
  label: string;
  enabled: boolean;
  open: boolean;
  onToggleOpen: () => void;
  onReset: () => void;
  children: React.ReactNode;
}

function Section({ label, enabled, open, onToggleOpen, onReset, children }: SectionProps) {
  return (
    <div className={`lumetri-section${enabled ? " lumetri-section--active" : ""}`}>
      <button className="lumetri-section-header" type="button" onClick={onToggleOpen}>
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        <span className="lumetri-section-label">{label}</span>
        {enabled && <span className="lumetri-section-dot" title="Effect applied" />}
        <button
          className="lumetri-section-reset"
          type="button"
          title="Reset section to defaults"
          onClick={(e) => { e.stopPropagation(); onReset(); }}
        >
          <RotateCcw size={11} />
        </button>
      </button>
      {open && <div className="lumetri-section-body">{children}</div>}
    </div>
  );
}

export function LumetriPanel({ layer, currentTime, onChange }: Props) {
  const [openSections, setOpenSections] = useState<Set<SectionId>>(new Set(["basic"]));
  const layerTime = clamp(currentTime - layer.startSeconds, 0, layer.durationSeconds);

  function toggleSection(id: SectionId) {
    setOpenSections((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function updateEffectParam(type: string, key: string, value: string | number | boolean) {
    onChange((l) => upsertEffect(l, type, (e) => setEffectParam(e, key, value)));
  }

  function resetSection(type: string) {
    onChange((l) => removeEffect(l, type));
  }

  const ps = (type: string, key: string, fallback: string): string => {
    const eff = findEffect(layer, type);
    const v = eff?.params?.[key];
    return typeof v === "string" ? v : fallback;
  };

  // A tone-colored, keyframeable slider identical to the Controls-tab effect sliders.
  // The backing effect is created on first interaction (edit / keyframe), so browsing
  // a section never mutates the project.
  const renderSlider = (
    effectType: string,
    paramKey: string,
    label: string,
    min: number,
    max: number,
    defaultValue: number,
    step = 1,
    unit?: string
  ) => {
    const eff = findEffect(layer, effectType);
    const stored = eff?.params?.[paramKey];
    const baseValue = typeof stored === "number" ? stored : defaultValue;
    const animatedValue = eff
      ? evaluateTimelineEffectParam({ animations: layer.animations, baseValue, effectId: eff.id, paramKey, timeSeconds: layerTime })
      : baseValue;
    const activeKeyframe = eff ? getActiveEffectParamKeyframe(layer, eff.id, paramKey, layerTime) : undefined;
    const applyAtTime = (value: number) =>
      onChange((l) => {
        const next = ensureEffect(l, effectType);
        return updateEffectParamAtTime(next, effectIdOf(next, effectType)!, paramKey, layerTime, value);
      });
    return (
      <EffectSliderControl
        key={`${effectType}.${paramKey}`}
        label={unit ? `${label} ${unit}` : label}
        tone={effectSliderTone(paramKey)}
        min={min}
        max={max}
        step={step}
        value={animatedValue}
        keyframe={{
          active: Boolean(activeKeyframe),
          interpolation: activeKeyframe?.interpolation,
          onChangeInterpolation: (interp) =>
            onChange((l) => {
              const next = ensureEffect(l, effectType);
              return setEffectParamInterpolation(next, effectIdOf(next, effectType)!, paramKey, layerTime, interp);
            }),
          onToggle: () =>
            onChange((l) => {
              const next = ensureEffect(l, effectType);
              return toggleEffectParamKeyframe(next, effectIdOf(next, effectType)!, paramKey, layerTime, animatedValue);
            })
        }}
        onReset={() => applyAtTime(defaultValue)}
        onChange={applyAtTime}
      />
    );
  };

  return (
    <div className="lumetri-panel">
      {SECTIONS.map(({ id, label, effectType }) => {
        const isOpen = openSections.has(id);
        const hasEffect = Boolean(findEffect(layer, effectType));

        return (
          <Section
            key={id}
            label={label}
            enabled={hasEffect}
            open={isOpen}
            onToggleOpen={() => toggleSection(id)}
            onReset={() => resetSection(effectType)}
          >
            {id === "basic" && (
              <div className="lumetri-basic">
                {renderSlider("brightnessContrast", "exposure", "Exposure", -100, 100, 0)}
                {renderSlider("brightnessContrast", "contrast", "Contrast", -100, 100, 0)}
                {renderSlider("brightnessContrast", "highlights", "Highlights", -100, 100, 0)}
                {renderSlider("brightnessContrast", "shadows", "Shadows", -100, 100, 0)}
                {renderSlider("brightnessContrast", "whites", "Whites", -100, 100, 0)}
                {renderSlider("brightnessContrast", "blacks", "Blacks", -100, 100, 0)}
                <div className="lumetri-divider" />
                {renderSlider("brightnessContrast", "saturation", "Saturation", 0, 220, 100)}
                {renderSlider("brightnessContrast", "vibrance", "Vibrance", -100, 100, 0)}
                <div className="lumetri-divider" />
                {renderSlider("brightnessContrast", "temperature", "Temperature", -100, 100, 0)}
                {renderSlider("brightnessContrast", "tint", "Tint", -100, 100, 0)}
              </div>
            )}

            {id === "creative" && (
              <div className="lumetri-creative">
                <label className="lumetri-look-select">
                  <span>Look</span>
                  <ThemedSelect
                    ariaLabel="Creative look"
                    value={ps("creativeLook", "look", CREATIVE_LOOK_NAMES[0] ?? "")}
                    options={CREATIVE_LOOK_NAMES.map((name) => ({ value: name, label: name }))}
                    onChange={(look) => updateEffectParam("creativeLook", "look", look)}
                  />
                </label>
                {renderSlider("creativeLook", "intensity", "Intensity", 0, 100, 100)}
                <div className="lumetri-divider" />
                <p className="lumetri-section-sub">LUT</p>
                <LutFileImport
                  value={ps("importedLut", "lut", "")}
                  onChange={(v) => updateEffectParam("importedLut", "lut", v)}
                />
                {renderSlider("importedLut", "intensity", "LUT Intensity", 0, 100, 100)}
              </div>
            )}

            {id === "curves" && (
              <div className="effect-curve-control">
                <CurveEditor
                  value={ps("colorCurves", "curve", "{}")}
                  onChange={(v) => updateEffectParam("colorCurves", "curve", v)}
                />
              </div>
            )}

            {id === "wheels" && (
              <div className="effect-curve-control">
                <ColorWheels
                  value={ps("colorWheels", "wheels", "{}")}
                  onChange={(v) => updateEffectParam("colorWheels", "wheels", v)}
                />
              </div>
            )}

            {id === "hue-sat" && (
              <div className="effect-curve-control">
                <HueSatCurves
                  value={ps("hueSatCurves", "curves", "{}")}
                  onChange={(v) => updateEffectParam("hueSatCurves", "curves", v)}
                />
              </div>
            )}

            {id === "secondary" && (
              <div className="effect-curve-control">
                <HslSecondary
                  value={ps("hslSecondary", "secondary", "{}")}
                  onChange={(v) => updateEffectParam("hslSecondary", "secondary", v)}
                />
              </div>
            )}

            {id === "vignette" && (
              <div className="lumetri-basic">
                {renderSlider("vignette", "amount", "Amount", 0, 100, 35)}
                {renderSlider("vignette", "size", "Size", 0, 100, 58)}
              </div>
            )}
          </Section>
        );
      })}
    </div>
  );
}
