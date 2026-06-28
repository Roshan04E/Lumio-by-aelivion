/**
 * Professional Color System (Phase 3) — 3-way Color Wheels (13C.2).
 * Shadows / Midtones / Highlights wheels mapped to ASC-CDL slope·offset·power:
 *   out_c = clamp((in · slope_c + offset_c) ^ power_c)
 *  - Shadows wheel  → offset (Lift)   — moves the blacks / shadow color.
 *  - Midtones wheel → power  (Gamma)  — bends the mids / mid color.
 *  - Highlights wheel → slope (Gain)  — scales the whites / highlight color.
 * Each wheel carries a 2D color balance (x,y in the unit disk) + a master luma level.
 * The CDL is baked into the SAME per-channel `feComponentTransfer` LUT the curves use,
 * so there's no new renderer code — preview and export stay pixel-aligned by construction.
 */

import { TONE_LUT_SIZE, type ToneCurve } from "./types";

/** One wheel: color balance (x,y ∈ unit disk) + master luma level (-1..1). */
export interface ColorWheel {
  x: number;
  y: number;
  master: number;
}

export interface ColorWheels {
  shadows: ColorWheel;
  midtones: ColorWheel;
  highlights: ColorWheel;
}

export const NEUTRAL_WHEEL: ColorWheel = { x: 0, y: 0, master: 0 };

export function neutralColorWheels(): ColorWheels {
  return { shadows: { ...NEUTRAL_WHEEL }, midtones: { ...NEUTRAL_WHEEL }, highlights: { ...NEUTRAL_WHEEL } };
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function wheelIsNeutral(w: ColorWheel): boolean {
  return w.x === 0 && w.y === 0 && w.master === 0;
}

export function wheelsAreIdentity(wheels: ColorWheels): boolean {
  return wheelIsNeutral(wheels.shadows) && wheelIsNeutral(wheels.midtones) && wheelIsNeutral(wheels.highlights);
}

function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let r = 0;
  let g = 0;
  let b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return [r + m, g + m, b + m];
}

/**
 * Map a wheel's 2D position to a pure-chroma RGB push (centered at 0, no net luma):
 * angle → hue, radius → strength. Right = warm/red, rotating through the hue circle.
 */
function wheelTint(x: number, y: number): [number, number, number] {
  const mag = Math.min(1, Math.hypot(x, y));
  if (mag < 1e-4) return [0, 0, 0];
  const hue = ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
  const [r, g, b] = hsvToRgb(hue, 1, 1);
  const avg = (r + g + b) / 3;
  return [(r - avg) * mag, (g - avg) * mag, (b - avg) * mag];
}

interface Cdl {
  slope: [number, number, number];
  offset: [number, number, number];
  power: [number, number, number];
}

function computeCdl(wheels: ColorWheels): Cdl {
  const sh = wheelTint(wheels.shadows.x, wheels.shadows.y);
  const mid = wheelTint(wheels.midtones.x, wheels.midtones.y);
  const hi = wheelTint(wheels.highlights.x, wheels.highlights.y);
  const channel = (c: number) => ({
    // Lift → offset (±0.5), color cast added to shadows.
    offset: wheels.shadows.master * 0.5 + sh[c]! * 0.5,
    // Gain → slope (0.5..2×), color cast scaling highlights.
    slope: Math.pow(2, wheels.highlights.master + hi[c]!),
    // Gamma → power (0.5..2), color cast bending the mids (master>0 brightens).
    power: Math.pow(2, -(wheels.midtones.master + mid[c]!))
  });
  const r = channel(0);
  const g = channel(1);
  const b = channel(2);
  return {
    slope: [r.slope, g.slope, b.slope],
    offset: [r.offset, g.offset, b.offset],
    power: [r.power, g.power, b.power]
  };
}

function cdlChannel(input: number, slope: number, offset: number, power: number): number {
  const v = input * slope + offset;
  const base = v < 0 ? 0 : v; // guard pow of a negative base
  return clamp01(Math.pow(base, power));
}

/** Bake the 3-way wheels into a per-channel tone curve (sampled CDL). */
export function colorWheelsToToneCurve(wheels: ColorWheels, size = TONE_LUT_SIZE): ToneCurve {
  const { slope, offset, power } = computeCdl(wheels);
  const build = (c: number): number[] => {
    const lut = new Array<number>(size);
    for (let i = 0; i < size; i += 1) {
      lut[i] = cdlChannel(i / (size - 1), slope[c]!, offset[c]!, power[c]!);
    }
    return lut;
  };
  return { r: build(0), g: build(1), b: build(2) };
}
