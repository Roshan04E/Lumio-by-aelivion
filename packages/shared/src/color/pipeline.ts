/**
 * Professional Color System (Phase 3) — pipeline compiler.
 * Maps each supported color effect into a normalized control set, then into a
 * `ColorStage` (white-balance + saturation matrix, then a master tone curve).
 * 13C.0 covers the existing primaries (exposure/contrast/tone/saturation/temp/tint);
 * per-channel curves, real Lift/Gamma/Gain, and LUTs arrive in 13C.1+.
 */

import {
  COLOR_EFFECT_TYPES,
  LUMA_WEIGHTS,
  NEUTRAL_CONTROLS,
  TONE_LUT_SIZE,
  type ColorControls,
  type ColorEffectInput,
  type ColorPipeline,
  type ColorStage,
  type ToneCurve
} from "./types";
import { channelCurvesAreIdentity, channelCurvesToToneCurve } from "./curve";
import { colorWheelsToToneCurve, wheelsAreIdentity } from "./wheels";
import { hueSatCurvesAreIdentity, secondaryIsIdentity, type HslSecondary } from "./hsl";
import { resolveLookEffects } from "./looks";

const IDENTITY_MATRIX_3x4: readonly number[] = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

function num(params: Record<string, number>, key: string, fallback: number): number {
  const value = params[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** Scale a signed control toward its 0 neutral by `k` (0..1). */
function mixSigned(value: number, k: number): number {
  return value * k;
}

/** Scale a control toward an arbitrary neutral by `k` (0..1). */
function mixAround(value: number, neutral: number, k: number): number {
  return neutral + (value - neutral) * k;
}

/** Read the unified controls out of one color effect, scaled by its intensity. */
export function extractControls(effect: ColorEffectInput): ColorControls {
  const p = effect.params ?? {};
  const k = clamp01((effect.intensity ?? 100) / 100);
  const c: ColorControls = { ...NEUTRAL_CONTROLS };

  if (effect.type === "brightnessContrast") {
    // Modern "Basic Color Correction" keys, with the legacy 100-based brightness/contrast
    // as a fallback so older saved effects keep working.
    const hasModern = "exposure" in p || "highlights" in p || "saturation" in p;
    // `curve{Shadows,Midtones,Highlights}` are legacy tonal-curve add-ons; fold them
    // into the nearest control so no saved behavior is dropped in the pivot.
    c.exposure = mixSigned(("exposure" in p ? num(p, "exposure", 0) : num(p, "brightness", 100) - 100) + num(p, "curveMidtones", 0), k);
    c.contrast = mixSigned(hasModern ? num(p, "contrast", 0) : num(p, "contrast", 100) - 100, k);
    c.highlights = mixSigned(num(p, "highlights", 0) + num(p, "curveHighlights", 0), k);
    c.shadows = mixSigned(num(p, "shadows", 0) + num(p, "curveShadows", 0), k);
    c.whites = mixSigned(num(p, "whites", 0), k);
    c.blacks = mixSigned(num(p, "blacks", 0), k);
    c.saturation = mixAround(num(p, "saturation", 100), 100, k);
    c.vibrance = mixSigned(num(p, "vibrance", 0), k);
    c.temperature = mixSigned(num(p, "temperature", 0), k);
    c.tint = mixSigned(num(p, "tint", 0), k);
    return c;
  }

  if (effect.type === "colorGrade") {
    c.saturation = mixAround(num(p, "saturation", 100), 100, k);
    c.temperature = mixSigned(num(p, "temperature", 0), k);
    return c;
  }

  if (effect.type === "curves") {
    // The existing "prograde" tonal effect: black/white point + shadows/mids/highlights.
    c.blacks = mixSigned(num(p, "blackPoint", 0), k);
    c.whites = mixSigned(num(p, "whitePoint", 0), k);
    c.shadows = mixSigned(num(p, "shadows", 0), k);
    c.highlights = mixSigned(num(p, "highlights", 0), k);
    c.exposure = mixSigned(num(p, "midtones", 0), k);
    c.contrast = mixSigned(num(p, "contrast", 0), k);
    c.saturation = mixAround(num(p, "saturation", 100), 100, k);
    return c;
  }

  return c;
}

function controlsAreNeutral(c: ColorControls): boolean {
  return (
    c.exposure === 0 &&
    c.contrast === 0 &&
    c.highlights === 0 &&
    c.shadows === 0 &&
    c.whites === 0 &&
    c.blacks === 0 &&
    c.saturation === 100 &&
    c.vibrance === 0 &&
    c.temperature === 0 &&
    c.tint === 0
  );
}

/** 3×3 multiply, returned as a 3×4 (offset column = 0). `a` applied after `b`: a·b. */
function matMul3(a: number[], b: number[]): number[] {
  const out = new Array<number>(12).fill(0);
  for (let row = 0; row < 3; row += 1) {
    for (let col = 0; col < 3; col += 1) {
      let sum = 0;
      for (let k = 0; k < 3; k += 1) {
        sum += a[row * 4 + k]! * b[k * 4 + col]!;
      }
      out[row * 4 + col] = sum;
    }
    out[row * 4 + 3] = 0;
  }
  return out;
}

/** Luma-preserving saturation matrix (Rec.709), with vibrance as a gentle extra push. */
function saturationMatrix(saturation: number, vibrance: number): number[] {
  const s = Math.max(0, saturation / 100 + (vibrance / 100) * 0.5);
  const [lr, lg, lb] = LUMA_WEIGHTS;
  return [
    lr * (1 - s) + s, lg * (1 - s), lb * (1 - s), 0,
    lr * (1 - s), lg * (1 - s) + s, lb * (1 - s), 0,
    lr * (1 - s), lg * (1 - s), lb * (1 - s) + s, 0
  ];
}

/**
 * White-balance gain matrix. Temperature warms (more R / less B); positive tint
 * pushes toward magenta (cut G, slight R+B boost), matching Lumetri's convention.
 */
function whiteBalanceMatrix(temperature: number, tint: number): number[] {
  const t = temperature / 100;
  const ti = tint / 100;
  const rGain = (1 + t * 0.2) * (1 + ti * 0.07);
  const gGain = 1 - ti * 0.15;
  const bGain = (1 - t * 0.2) * (1 + ti * 0.07);
  return [rGain, 0, 0, 0, 0, gGain, 0, 0, 0, 0, bGain, 0];
}

/**
 * Build a single 0..1 → 0..1 tone transfer from the tonal controls (sRGB space).
 * Perceptual approximation; the Lumetri-accurate highlight/shadow rolloff lands in 13C.1.
 */
function toneTransfer(c: ColorControls): (x: number) => number {
  const exposureGain = Math.pow(2, (c.exposure / 100) * 0.8); // ±0.8 stops at extremes
  const black = -(c.blacks / 100) * 0.15; // blacks>0 lifts the black point
  const white = 1 + (c.whites / 100) * 0.15;
  const sh = c.shadows / 100;
  const hl = c.highlights / 100;
  const con = c.contrast / 100;
  return (x: number): number => {
    let v = x * exposureGain;
    v = black + (white - black) * v; // level remap
    const vc = clamp01(v);
    v += sh * 0.2 * (1 - vc) * (1 - vc); // lift/lower shadows (dark region)
    v += hl * 0.2 * vc * vc; // lift/lower highlights (bright region)
    v = (v - 0.5) * (1 + con * 0.7) + 0.5; // contrast S-curve around mid
    return clamp01(v);
  };
}

function sampleCurve(fn: (x: number) => number): number[] {
  const samples = new Array<number>(TONE_LUT_SIZE);
  for (let i = 0; i < TONE_LUT_SIZE; i += 1) {
    samples[i] = fn(i / (TONE_LUT_SIZE - 1));
  }
  return samples;
}

function controlsToStage(c: ColorControls): ColorStage {
  const hasMatrix = c.saturation !== 100 || c.vibrance !== 0 || c.temperature !== 0 || c.tint !== 0;
  const hasCurve = c.exposure !== 0 || c.contrast !== 0 || c.highlights !== 0 || c.shadows !== 0 || c.whites !== 0 || c.blacks !== 0;

  let matrix: number[] | null = null;
  if (hasMatrix) {
    matrix = matMul3(whiteBalanceMatrix(c.temperature, c.tint), saturationMatrix(c.saturation, c.vibrance));
  }

  let curve: ToneCurve | null = null;
  if (hasCurve) {
    const master = sampleCurve(toneTransfer(c));
    curve = { r: master, g: [...master], b: [...master] };
  }

  return { matrix, curve };
}

/**
 * Compile color effects (params pre-resolved) into a single `ColorPipeline`.
 * Non-color and disabled effects should be filtered out by the caller; unknown
 * types are ignored. Stages preserve effect order.
 */
export function compileColorPipeline(effects: ColorEffectInput[]): ColorPipeline {
  const stages: ColorStage[] = [];
  let previewMatte: HslSecondary | null = null;
  for (const effect of effects) {
    if (!COLOR_EFFECT_TYPES.has(effect.type)) {
      continue;
    }
    // Graph curves: a pure per-channel tone-curve stage (no matrix).
    if (effect.type === "colorCurves") {
      if (effect.curves && !channelCurvesAreIdentity(effect.curves)) {
        stages.push({ matrix: null, curve: channelCurvesToToneCurve(effect.curves) });
      }
      continue;
    }
    // 3-way color wheels: baked ASC-CDL as a per-channel tone-curve stage.
    if (effect.type === "colorWheels") {
      if (effect.wheels && !wheelsAreIdentity(effect.wheels)) {
        stages.push({ matrix: null, curve: colorWheelsToToneCurve(effect.wheels) });
      }
      continue;
    }
    // Lumetri hue/sat curves: an HSL-domain stage (WebGL/3D-LUT only).
    if (effect.type === "hueSatCurves") {
      if (effect.hueSatCurves && !hueSatCurvesAreIdentity(effect.hueSatCurves)) {
        stages.push({ matrix: null, curve: null, hsl: effect.hueSatCurves });
      }
      continue;
    }
    // HSL secondary key + correction: an HSL-domain stage (WebGL/3D-LUT only). The
    // "show mask" display flag surfaces on the pipeline so the WebGL view can render the
    // key matte; the correction stage itself is skipped when neutral.
    if (effect.type === "hslSecondary") {
      const s = effect.secondary;
      if (s) {
        if (s.showMask) previewMatte = s;
        if (!secondaryIsIdentity(s)) {
          stages.push({ matrix: null, curve: null, hsl: s });
        }
      }
      continue;
    }
    // Creative look: expand into correction + optional wheel stages via the look registry.
    if (effect.type === "creativeLook") {
      const lookName = String(effect.params["look"] ?? "");
      const intensity = typeof effect.params["intensity"] === "number" ? effect.params["intensity"] : (effect.intensity ?? 100);
      if (lookName) {
        const lookEffects = resolveLookEffects(lookName, intensity);
        for (const le of lookEffects) {
          if (le.type === "colorWheels" && le.wheels && !wheelsAreIdentity(le.wheels)) {
            stages.push({ matrix: null, curve: colorWheelsToToneCurve(le.wheels) });
          } else {
            const controls = extractControls(le);
            if (!controlsAreNeutral(controls)) {
              const stage = controlsToStage(controls);
              if (stage.matrix || stage.curve) stages.push(stage);
            }
          }
        }
      }
      continue;
    }
    // Imported .cube LUT: a single lut3d stage (WebGL/CPU only — SVG can't express 3D LUTs).
    if (effect.type === "importedLut") {
      if (effect.importedLut3d) {
        stages.push({ matrix: null, curve: null, lut3d: effect.importedLut3d });
      }
      continue;
    }
    const controls = extractControls(effect);
    if (controlsAreNeutral(controls)) {
      continue;
    }
    const stage = controlsToStage(controls);
    if (stage.matrix || stage.curve) {
      stages.push(stage);
    }
  }
  return { stages, space: "sRGB", identity: stages.length === 0 && !previewMatte, previewMatte };
}

export const COLOR_IDENTITY_MATRIX_3x4 = IDENTITY_MATRIX_3x4;
