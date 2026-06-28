/**
 * Professional Color System (Phase 3, 13C.4) — built-in creative look presets.
 *
 * Each look is encoded as a set of `ColorEffectInput` correction params so it
 * compiles through the same pipeline as any editor-adjusted effect — no binary
 * LUT data needed.  The `creativeLook` effect picks a look by name + scales it
 * by its `intensity` slider (0–100).
 */

import type { ColorEffectInput } from "./types";

export interface CreativeLook {
  name: string;
  description: string;
  /** Correction params passed directly to `compileColorPipeline` as `brightnessContrast` inputs. */
  correction: Partial<{
    exposure: number;
    contrast: number;
    highlights: number;
    shadows: number;
    whites: number;
    blacks: number;
    saturation: number;
    vibrance: number;
    temperature: number;
    tint: number;
  }>;
  /** Optional per-channel curve biases (JSON-serialised ChannelCurves). */
  curvesJson?: string;
  /** Optional wheel biases (JSON-serialised ColorWheels — shadows/midtones/highlights). */
  wheelsJson?: string;
}

export const CREATIVE_LOOKS: CreativeLook[] = [
  {
    name: "Teal & Orange",
    description: "Classic Hollywood split: warm highlights, cool shadows.",
    correction: { contrast: 15, saturation: 115, temperature: 5, tint: -3, shadows: -8, highlights: 5 },
    wheelsJson: JSON.stringify({
      shadows: { x: -0.14, y: 0.06, master: -5 },   // push teal
      midtones: { x: 0, y: 0, master: 0 },
      highlights: { x: 0.12, y: -0.06, master: 3 }   // push amber
    })
  },
  {
    name: "Faded Film",
    description: "Lifted blacks, muted saturation — analog film character.",
    correction: { blacks: 18, whites: -8, saturation: 78, contrast: -10, highlights: -12 }
  },
  {
    name: "Noir",
    description: "High-contrast near-monochrome with deep blacks.",
    correction: { saturation: 30, contrast: 30, blacks: -15, whites: 10, shadows: -20, highlights: 8 }
  },
  {
    name: "Warm Sunset",
    description: "Golden-hour warmth with lifted shadows.",
    correction: { temperature: 25, tint: 8, saturation: 120, vibrance: 15, shadows: 8, highlights: -5 }
  },
  {
    name: "Cold Morning",
    description: "Desaturated cool tones with clean whites.",
    correction: { temperature: -20, tint: -5, saturation: 85, contrast: 8, whites: 12, shadows: -5 }
  },
  {
    name: "Cinematic",
    description: "Moderate contrast with slightly rolled-off highlights.",
    correction: { contrast: 18, highlights: -20, shadows: 10, saturation: 105, blacks: 5 }
  },
  {
    name: "Bleach Bypass",
    description: "Desaturated high-contrast gritty look.",
    correction: { saturation: 60, contrast: 35, blacks: -20, whites: 15, shadows: -15, highlights: -10 }
  },
  {
    name: "Cross Process",
    description: "Shifted channel responses — slide-film cross-processing vibe.",
    correction: { saturation: 130, contrast: 20, tint: 12, temperature: -10, highlights: -8 },
    wheelsJson: JSON.stringify({
      shadows: { x: -0.08, y: 0.1, master: 0 },   // green-teal shadows
      midtones: { x: 0, y: 0, master: 0 },
      highlights: { x: 0.06, y: -0.08, master: 0 }  // magenta highlights
    })
  }
];

export const CREATIVE_LOOK_NAMES = CREATIVE_LOOKS.map((l) => l.name);

/** Resolve a look name to a `ColorEffectInput[]` (pre-scaled, ready for compileColorPipeline). */
export function resolveLookEffects(lookName: string, intensity: number): ColorEffectInput[] {
  const look = CREATIVE_LOOKS.find((l) => l.name === lookName);
  if (!look) return [];

  const k = Math.max(0, Math.min(100, intensity)) / 100;
  const p: Record<string, number> = {};
  for (const [key, val] of Object.entries(look.correction)) {
    p[key] = (val as number) * k;
  }
  // Re-centre saturation (neutral = 100, not 0).
  if ("saturation" in p) {
    p["saturation"] = 100 + ((look.correction.saturation ?? 100) - 100) * k;
  }

  const inputs: ColorEffectInput[] = [{ type: "brightnessContrast", params: p, intensity: 100 }];

  if (look.wheelsJson) {
    try {
      const wheels = JSON.parse(look.wheelsJson);
      // Scale wheel positions by intensity
      const scale = (w: { x: number; y: number; master: number }) => ({
        x: w.x * k,
        y: w.y * k,
        master: w.master * k
      });
      inputs.push({
        type: "colorWheels",
        params: {},
        intensity: 100,
        wheels: {
          shadows: scale(wheels.shadows),
          midtones: scale(wheels.midtones),
          highlights: scale(wheels.highlights)
        }
      });
    } catch {
      // malformed preset — skip wheels
    }
  }

  return inputs;
}
