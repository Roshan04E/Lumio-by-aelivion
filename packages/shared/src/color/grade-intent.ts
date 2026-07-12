/**
 * Professional Color System — AI grade intent + deterministic compiler.
 *
 * The AI (LLM primary, deterministic planner as a floor) authors a COMPACT `GradeIntent`
 * — a dozen high-level fields like `shadows:teal`, `crushBlacks`, `isolate skin desaturate`.
 * This module expands that intent, entirely deterministically and locally (no tokens, no
 * network), into a STACK of real color effects — the SAME `brightnessContrast` / `colorCurves`
 * / `colorWheels` / `hueSatCurves` / `hslSecondary` params the panel produces — so what the AI
 * grades renders identically in preview and export and stays individually editable.
 *
 * Nothing here invents color math: it only composes the shipped structures/helpers
 * (`curve.ts`, `wheels.ts`, `hsl.ts`, `looks.ts`) into effect param payloads.
 */

import { z } from "zod";
import { type ChannelCurves, type CurvePoint } from "./curve";
import { neutralHueCurvePoints, NEUTRAL_SECONDARY, type HslSecondary, type HueSatCurves } from "./hsl";
import { resolveLookEffects } from "./looks";
import { neutralColorWheels, type ColorWheel, type ColorWheels } from "./wheels";

/* --------------------------------------------------------------------- hue vocabulary */

export const HUE_NAMES = [
  "red",
  "orange",
  "yellow",
  "green",
  "teal",
  "cyan",
  "blue",
  "purple",
  "magenta",
  "skin",
  "sky",
  "foliage"
] as const;
export type HueName = (typeof HUE_NAMES)[number];

/** Named hue → its center (0..1 turn on the HSL wheel) and a default qualifier half-width. */
const HUE_CENTERS: Record<HueName, { center: number; width: number }> = {
  red: { center: 0.0, width: 0.05 },
  orange: { center: 0.06, width: 0.05 },
  yellow: { center: 0.14, width: 0.05 },
  green: { center: 0.33, width: 0.08 },
  teal: { center: 0.5, width: 0.06 },
  cyan: { center: 0.52, width: 0.06 },
  blue: { center: 0.62, width: 0.07 },
  purple: { center: 0.78, width: 0.07 },
  magenta: { center: 0.9, width: 0.06 },
  // Semantic keys — narrow, memory-of-a-colorist bands.
  skin: { center: 0.05, width: 0.04 },
  sky: { center: 0.6, width: 0.09 },
  foliage: { center: 0.28, width: 0.1 }
};

/* --------------------------------------------------------------------- intent schema */

const hueName = z.enum(HUE_NAMES);

/** A directional color push for one tonal band (shadows/mids/highlights) of the 3-way wheels. */
const huePushSchema = z.object({
  hue: hueName,
  /** 0..1 push strength (wheel radius). */
  strength: z.number().min(0).max(1),
  /** Optional per-band luma bias, -1..1 (wheel master level). */
  luma: z.number().min(-1).max(1).optional()
});

/** Primary correction — the same signed controls as Basic Color Correction. */
const primarySchema = z
  .object({
    exposure: z.number().min(-100).max(100),
    contrast: z.number().min(-100).max(100),
    highlights: z.number().min(-100).max(100),
    shadows: z.number().min(-100).max(100),
    whites: z.number().min(-100).max(100),
    blacks: z.number().min(-100).max(100),
    saturation: z.number().min(0).max(220),
    vibrance: z.number().min(-100).max(100),
    temperature: z.number().min(-100).max(100),
    tint: z.number().min(-100).max(100)
  })
  .partial();

/** Tonal curve shaping (master curve) — normalized -1..1 (or 0..1 where noted). */
const toneSchema = z
  .object({
    /** S-curve contrast, -1..1 (negative = flatten). */
    contrast: z.number().min(-1).max(1),
    /** Raise the black point (lift shadows), 0..1. */
    lift: z.number().min(0).max(1),
    /** Deepen the blacks (crush), 0..1. */
    crush: z.number().min(0).max(1),
    /** Roll off the highlights, 0..1. */
    rolloff: z.number().min(0).max(1)
  })
  .partial();

/** A hue-selective adjustment (Lumetri hue/sat curves) at a named hue. */
const hueAdjustSchema = z.object({
  target: hueName,
  /** Saturation gain at that hue, -1..1 (0 = none). */
  sat: z.number().min(-1).max(1).optional(),
  /** Hue rotation at that hue, -0.5..0.5 turns. */
  hueShift: z.number().min(-0.5).max(0.5).optional(),
  /** Luma gain at that hue, -1..1. */
  luma: z.number().min(-1).max(1).optional()
});

/** A qualified secondary key + correction (HSL Secondary) on a named hue/skin/sky/foliage. */
const secondarySchema = z.object({
  target: hueName,
  sat: z.number().min(-1).max(1).optional(),
  hueShift: z.number().min(-0.5).max(0.5).optional(),
  luma: z.number().min(-1).max(1).optional(),
  invert: z.boolean().optional()
});

export const gradeIntentSchema = z
  .object({
    /** A CreativeLook preset name used as a base (e.g. "Teal & Orange", "Noir"). */
    look: z.string().min(1).optional(),
    /** 0..100 scale applied to a `look` base. Default 100. */
    lookIntensity: z.number().min(0).max(100).optional(),
    primary: primarySchema.optional(),
    tone: toneSchema.optional(),
    balance: z
      .object({
        shadows: huePushSchema.optional(),
        midtones: huePushSchema.optional(),
        highlights: huePushSchema.optional()
      })
      .optional(),
    hue: z.array(hueAdjustSchema).max(8).optional(),
    secondary: z.array(secondarySchema).max(6).optional()
  })
  .strict();

export type GradeIntent = z.infer<typeof gradeIntentSchema>;
type HuePush = z.infer<typeof huePushSchema>;

/* --------------------------------------------------------------------- compiler output */

export interface CompiledGrade {
  effectType: "brightnessContrast" | "colorCurves" | "colorWheels" | "hueSatCurves" | "hslSecondary";
  /** Effect params ready for the `addEffect` timeline action (graph params are JSON strings). */
  params: Record<string, string | number>;
  summary: string;
}

/* --------------------------------------------------------------------- small helpers */

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function wrap01(v: number): number {
  const r = v - Math.floor(v);
  return r < 0 ? r + 1 : r;
}

/**
 * Push a localized "bump" onto a hue-domain curve: `deltaY` at `center` (0.5 neutral baseline),
 * falling back to 0.5 at ±`hw`. Points outside [0,1] are dropped (the sampler wraps the seam).
 */
function pushHueBump(points: CurvePoint[], center: number, deltaY: number, hw = 0.1): void {
  const c = wrap01(center);
  const y = clamp(0.5 + deltaY, 0, 1);
  for (const sx of [c - hw, c + hw]) {
    if (sx > 0 && sx < 1) {
      points.push({ x: sx, y: 0.5 });
    }
  }
  points.push({ x: c, y });
}

/* --------------------------------------------------------------------- stage builders */

function buildPrimary(intent: GradeIntent): CompiledGrade | null {
  // Merge a look base (if any) with explicit primary overrides.
  const params: Record<string, number> = {};
  if (intent.look) {
    const looks = resolveLookEffects(intent.look, intent.lookIntensity ?? 100);
    const base = looks.find((l) => l.type === "brightnessContrast");
    if (base) {
      for (const [k, v] of Object.entries(base.params)) {
        params[k] = v;
      }
    }
  }
  if (intent.primary) {
    for (const [k, v] of Object.entries(intent.primary)) {
      if (typeof v === "number") {
        params[k] = v;
      }
    }
  }
  // Clamp to the Basic Color Correction param ranges.
  for (const k of Object.keys(params)) {
    params[k] = k === "saturation" ? clamp(params[k]!, 0, 220) : clamp(params[k]!, -100, 100);
  }
  if (Object.keys(params).length === 0) {
    return null;
  }
  return { effectType: "brightnessContrast", params, summary: intent.look ? `Base grade (${intent.look})` : "Primary correction" };
}

function buildToneCurve(intent: GradeIntent): CompiledGrade | null {
  const tone = intent.tone;
  if (!tone) {
    return null;
  }
  const c = tone.contrast ?? 0;
  const lift = tone.lift ?? 0;
  const crush = tone.crush ?? 0;
  const rolloff = tone.rolloff ?? 0;
  if (c === 0 && lift === 0 && crush === 0 && rolloff === 0) {
    return null;
  }
  // A monotonic 5-point master curve: lifted/crushed black point, S-curve mids, rolled-off highlights.
  const master: CurvePoint[] = [
    { x: 0, y: clamp(lift * 0.15, 0, 0.4) },
    { x: 0.2, y: clamp(0.2 - crush * 0.12 + lift * 0.06 - c * 0.05, 0, 1) },
    { x: 0.5, y: 0.5 },
    { x: 0.8, y: clamp(0.8 + c * 0.05 - rolloff * 0.05, 0, 1) },
    { x: 1, y: clamp(1 - rolloff * 0.12, 0.6, 1) }
  ];
  const curves: ChannelCurves = { master };
  return { effectType: "colorCurves", params: { curve: JSON.stringify(curves) }, summary: "Tonal curve" };
}

function pushToWheel(push: HuePush | undefined): ColorWheel {
  if (!push || push.strength <= 0) {
    return { x: 0, y: 0, master: push?.luma ?? 0 };
  }
  const angle = HUE_CENTERS[push.hue].center * Math.PI * 2; // turn → radians
  const r = clamp(push.strength, 0, 1) * 0.2; // keep pushes gentle (wheel radius ~0..0.2)
  return { x: Math.cos(angle) * r, y: Math.sin(angle) * r, master: clamp(push.luma ?? 0, -1, 1) };
}

function buildWheels(intent: GradeIntent): CompiledGrade | null {
  const b = intent.balance;
  if (!b || (!b.shadows && !b.midtones && !b.highlights)) {
    return null;
  }
  const wheels: ColorWheels = {
    ...neutralColorWheels(),
    shadows: pushToWheel(b.shadows),
    midtones: pushToWheel(b.midtones),
    highlights: pushToWheel(b.highlights)
  };
  return { effectType: "colorWheels", params: { wheels: JSON.stringify(wheels) }, summary: "3-way color balance" };
}

function buildHueCurves(intent: GradeIntent): CompiledGrade | null {
  const list = intent.hue;
  if (!list || list.length === 0) {
    return null;
  }
  const hueVsSat: CurvePoint[] = [...neutralHueCurvePoints()];
  const hueVsHue: CurvePoint[] = [...neutralHueCurvePoints()];
  const hueVsLuma: CurvePoint[] = [...neutralHueCurvePoints()];
  let touched = false;
  for (const adj of list) {
    const center = HUE_CENTERS[adj.target].center;
    if (adj.sat) {
      pushHueBump(hueVsSat, center, clamp(adj.sat, -1, 1) * 0.5);
      touched = true;
    }
    if (adj.hueShift) {
      pushHueBump(hueVsHue, center, clamp(adj.hueShift, -0.5, 0.5));
      touched = true;
    }
    if (adj.luma) {
      pushHueBump(hueVsLuma, center, clamp(adj.luma, -1, 1) * 0.5);
      touched = true;
    }
  }
  if (!touched) {
    return null;
  }
  const curves: HueSatCurves = { hueVsSat, hueVsHue, hueVsLuma };
  return { effectType: "hueSatCurves", params: { curves: JSON.stringify(curves) }, summary: "Hue-selective adjust" };
}

function buildSecondaries(intent: GradeIntent): CompiledGrade[] {
  const list = intent.secondary;
  if (!list || list.length === 0) {
    return [];
  }
  return list
    .map((entry): CompiledGrade | null => {
      const { center, width } = HUE_CENTERS[entry.target];
      const secondary: HslSecondary = {
        ...NEUTRAL_SECONDARY,
        hueCenter: center,
        hueWidth: width,
        hueShift: clamp(entry.hueShift ?? 0, -0.5, 0.5),
        satScale: clamp(1 + (entry.sat ?? 0), 0, 2),
        lumScale: clamp(1 + (entry.luma ?? 0), 0, 2),
        invert: entry.invert ?? false
      };
      // Skip a no-op key (no correction).
      if (secondary.hueShift === 0 && secondary.satScale === 1 && secondary.lumScale === 1) {
        return null;
      }
      return {
        effectType: "hslSecondary",
        params: { secondary: JSON.stringify(secondary) },
        summary: `Secondary key (${entry.target})`
      };
    })
    .filter((g): g is CompiledGrade => g !== null);
}

/* --------------------------------------------------------------------- entry point */

/**
 * Compile a `GradeIntent` into an ordered stack of color effects. Returns `[]` for an empty or
 * fully-neutral intent. Order follows a colorist's flow: primary → tone → 3-way → hue-selective →
 * secondaries. Each entry is applied as its own editable effect via the `addEffect` action.
 */
export function compileGradeIntent(intent: GradeIntent): CompiledGrade[] {
  const stages: (CompiledGrade | null)[] = [
    buildPrimary(intent),
    buildToneCurve(intent),
    buildWheels(intent),
    buildHueCurves(intent),
    ...buildSecondaries(intent)
  ];
  return stages.filter((s): s is CompiledGrade => s !== null);
}

/** True when the intent carries no gradable signal at all. */
export function gradeIntentIsEmpty(intent: GradeIntent): boolean {
  return compileGradeIntent(intent).length === 0;
}
