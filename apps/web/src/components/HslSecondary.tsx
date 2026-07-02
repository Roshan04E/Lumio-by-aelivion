import { useCallback, useEffect, useRef, useState } from "react";
import { NEUTRAL_SECONDARY, type HslSecondary as Secondary } from "@lumio-by-aelivion/shared";

/**
 * Professional Color System (Phase 3, 13C.3) — HSL Secondary keyer + correction.
 * Isolate a color by hue / saturation / luma (each a feathered band), then re-grade ONLY
 * the keyed range (hue shift + saturation/luma gain). "Show mask" displays the grayscale
 * key matte in the viewer (white = fully selected) so you can dial the key precisely.
 * Stores `HslSecondary` JSON ("{}" = neutral). WebGL engine only (a 3D-LUT, not SVG).
 */

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function parse(value: string): Secondary {
  if (!value || value.trim() === "" || value.trim() === "{}") return { ...NEUTRAL_SECONDARY };
  try {
    const raw = JSON.parse(value) as Partial<Secondary>;
    return { ...NEUTRAL_SECONDARY, ...raw };
  } catch {
    return { ...NEUTRAL_SECONDARY };
  }
}

function isNeutral(s: Secondary): boolean {
  return (
    s.hueCenter === NEUTRAL_SECONDARY.hueCenter &&
    s.hueWidth === NEUTRAL_SECONDARY.hueWidth &&
    s.satMin === NEUTRAL_SECONDARY.satMin &&
    s.satMax === NEUTRAL_SECONDARY.satMax &&
    s.lumMin === NEUTRAL_SECONDARY.lumMin &&
    s.lumMax === NEUTRAL_SECONDARY.lumMax &&
    s.softness === NEUTRAL_SECONDARY.softness &&
    !s.invert &&
    s.hueShift === 0 &&
    s.satScale === 1 &&
    s.lumScale === 1 &&
    !s.showMask
  );
}

function serialize(s: Secondary): string {
  return isNeutral(s) ? "{}" : JSON.stringify(s);
}

const HUE_STOPS = [0, 60, 120, 180, 240, 300, 360].map((h) => `hsl(${h} 90% 55%)`).join(", ");

function Row({ label, value, min, max, step, suffix, onChange }: { label: string; value: number; min: number; max: number; step: number; suffix?: string; onChange: (v: number) => void }) {
  return (
    <label className="hsl-secondary-row">
      <span className="hsl-secondary-row-label">{label}</span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
      <span className="hsl-secondary-row-value">
        {value.toFixed(step < 1 ? 2 : 0)}
        {suffix ?? ""}
      </span>
    </label>
  );
}

export function HslSecondary({ value, onChange }: { value: string; onChange: (json: string) => void }) {
  const [s, setS] = useState<Secondary>(() => parse(value));
  const editingRef = useRef(false);

  useEffect(() => {
    if (!editingRef.current) setS(parse(value));
  }, [value]);

  const update = useCallback(
    (patch: Partial<Secondary>) => {
      setS((prev) => {
        const next = { ...prev, ...patch };
        onChange(serialize(next));
        return next;
      });
    },
    [onChange]
  );

  // Hue band overlay (highlight the selected hue range on the spectrum). Width is ± around
  // center; render as a translucent window that wraps the 0/1 seam visually.
  const centerPct = s.hueCenter * 100;
  const widthPct = Math.min(50, s.hueWidth * 100);

  return (
    <div className="hsl-secondary">
      <div className="hsl-secondary-section-title">Key</div>

      <div className="hsl-secondary-hue">
        <div
          className="hsl-secondary-hue-strip"
          style={{ background: `linear-gradient(90deg, ${HUE_STOPS})` }}
          onPointerDown={(e) => {
            editingRef.current = true;
            const rect = e.currentTarget.getBoundingClientRect();
            update({ hueCenter: clamp01((e.clientX - rect.left) / rect.width) });
          }}
          onPointerUp={() => {
            editingRef.current = false;
          }}
        >
          <span className="hsl-secondary-hue-window" style={{ left: `${centerPct - widthPct}%`, width: `${widthPct * 2}%` }} aria-hidden="true" />
          <span className="hsl-secondary-hue-marker" style={{ left: `${centerPct}%` }} aria-hidden="true" />
        </div>
      </div>

      <Row label="Hue width" value={s.hueWidth} min={0} max={0.5} step={0.01} onChange={(v) => update({ hueWidth: v })} />
      <Row label="Sat min" value={s.satMin} min={0} max={1} step={0.01} onChange={(v) => update({ satMin: Math.min(v, s.satMax) })} />
      <Row label="Sat max" value={s.satMax} min={0} max={1} step={0.01} onChange={(v) => update({ satMax: Math.max(v, s.satMin) })} />
      <Row label="Luma min" value={s.lumMin} min={0} max={1} step={0.01} onChange={(v) => update({ lumMin: Math.min(v, s.lumMax) })} />
      <Row label="Luma max" value={s.lumMax} min={0} max={1} step={0.01} onChange={(v) => update({ lumMax: Math.max(v, s.lumMin) })} />
      <Row label="Softness" value={s.softness} min={0} max={0.5} step={0.01} onChange={(v) => update({ softness: v })} />

      <div className="hsl-secondary-toggles">
        <label title="Select everything EXCEPT the keyed range">
          <input type="checkbox" checked={s.invert} onChange={(e) => update({ invert: e.target.checked })} />
          Invert
        </label>
        <label title="Show the key as a grayscale matte in the viewer (white = selected)">
          <input type="checkbox" checked={s.showMask} onChange={(e) => update({ showMask: e.target.checked })} />
          Show mask
        </label>
      </div>

      <div className="hsl-secondary-section-title">Correction</div>
      <Row label="Hue shift" value={s.hueShift} min={-0.5} max={0.5} step={0.005} onChange={(v) => update({ hueShift: v })} />
      <Row label="Saturation" value={s.satScale} min={0} max={2} step={0.01} suffix="×" onChange={(v) => update({ satScale: v })} />
      <Row label="Luma" value={s.lumScale} min={0} max={2} step={0.01} suffix="×" onChange={(v) => update({ lumScale: v })} />

      <p className="curve-editor-hint">Pick a hue on the strip, tighten the bands, then grade only that color. Toggle Show mask to see the key.</p>
    </div>
  );
}
