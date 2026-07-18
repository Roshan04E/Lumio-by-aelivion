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
    // master is a -1..1 luma level (offset = master*0.5, slope = 2^master — see wheels.ts).
    // These were mis-authored percent-style (-5/+3 → offset -2.5, slope ×8: crushed blacks +
    // blown neon highlights at intensity 100, user repro 2026-07-18). Intended gentle values:
    wheelsJson: JSON.stringify({
      shadows: { x: -0.14, y: 0.06, master: -0.05 },   // push teal, slightly darker
      midtones: { x: 0, y: 0, master: 0 },
      highlights: { x: 0.12, y: -0.06, master: 0.03 }   // push amber, slightly brighter
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

const creativeLookRegistry = new Map<string, CreativeLook>();
for (const look of CREATIVE_LOOKS) {
  creativeLookRegistry.set(look.name, look);
}

export function registerCreativeLook(look: CreativeLook, options: { override?: boolean } = {}): boolean {
  if (creativeLookRegistry.has(look.name) && !options.override) {
    return false;
  }
  creativeLookRegistry.set(look.name, look);
  return true;
}

export function getCreativeLook(name: string): CreativeLook | undefined {
  return creativeLookRegistry.get(name);
}

export function listCreativeLooks(): CreativeLook[] {
  return [...creativeLookRegistry.values()];
}

/* ------------------------------------------------------------------ name resolution (K3) */

/**
 * Colorist alias table — look names AIs/users plausibly say but the registry doesn't carry
 * verbatim. Data, not code: adding a mood = one row. Intensity (0–100) lets an alias land a
 * SOFTER variant of a strong base look (consumed by the blueprint color dialect; ignored by
 * plain effect-param canonicalization, which only fixes the name).
 */
const LOOK_ALIASES: Record<string, { look: string; intensity?: number }> = {
  moody: { look: "Noir", intensity: 55 },
  dark: { look: "Noir", intensity: 50 },
  dramatic: { look: "Bleach Bypass", intensity: 60 },
  gritty: { look: "Bleach Bypass", intensity: 75 },
  vintage: { look: "Faded Film" },
  retro: { look: "Faded Film" },
  analog: { look: "Faded Film" },
  faded: { look: "Faded Film" },
  film: { look: "Cinematic" },
  filmic: { look: "Cinematic" },
  movie: { look: "Cinematic" },
  hollywood: { look: "Teal & Orange" },
  blockbuster: { look: "Teal & Orange" },
  warm: { look: "Warm Sunset" },
  golden: { look: "Warm Sunset" },
  sunset: { look: "Warm Sunset" },
  cold: { look: "Cold Morning" },
  cool: { look: "Cold Morning" },
  winter: { look: "Cold Morning" },
  monochrome: { look: "Noir" },
  "black and white": { look: "Noir" },
  noirish: { look: "Noir" }
};

/** Lowercase + collapse separators + spell out "&" so "Teal and Orange" ≡ "teal&orange". */
function normalizeLookKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export interface LookResolution {
  /** Canonical registry name. */
  look: string;
  /** Intensity override carried by an alias (softer variant of a strong base). */
  intensity?: number | undefined;
  /** Human repair note when the input was rewritten; undefined for an exact match. */
  repair?: string | undefined;
}

/**
 * Resolve a requested look name against the LIVE registry (built-ins + plugin-registered):
 * exact → case/format-insensitive → alias table. Null = genuinely unknown. This is the ONE
 * resolution every consumer must share — the blueprint color dialect, the addEffect
 * `look`-param canonicalization, and any future picker — so "noir"/"moody"/"Teal and Orange"
 * mean the same thing everywhere (the 2026-07-18 "Noir applied but nothing changed" bug was
 * an LLM-lowercased name stored verbatim past a validation gap, no-oping in the renderer).
 */
export function resolveLookName(requested: string): LookResolution | null {
  const available = listCreativeLooks();
  const exact = available.find((look) => look.name === requested);
  if (exact) {
    return { look: exact.name };
  }
  const key = normalizeLookKey(requested);
  const relaxed = available.find((look) => normalizeLookKey(look.name) === key);
  if (relaxed) {
    return { look: relaxed.name, repair: `look "${requested}" → ${relaxed.name}` };
  }
  const alias = LOOK_ALIASES[key];
  if (alias && available.some((look) => look.name === alias.look)) {
    return {
      look: alias.look,
      intensity: alias.intensity,
      repair: `look "${requested}" → ${alias.look}${alias.intensity !== undefined ? ` @ ${alias.intensity}%` : ""}`
    };
  }
  return null;
}

/**
 * Find a look reference inside free text via the "<name> look" phrase shape ("apply a moody
 * look to clip 1", "give it the faded film look"). Tries the longest suffix of the captured
 * phrase so articles/fillers don't block resolution. Deliberately phrase-anchored — bare
 * adjectives ("make it warm") stay with the primary-correction vocabulary, not looks.
 */
export function matchLookInText(text: string): LookResolution | null {
  const phrase = /([a-z][a-z &-]{1,30}?)\s+look\b/.exec(text.toLowerCase());
  if (!phrase) {
    return null;
  }
  const words = phrase[1]!.trim().split(/\s+/);
  for (let start = 0; start < words.length; start += 1) {
    const resolved = resolveLookName(words.slice(start).join(" "));
    if (resolved) {
      return resolved;
    }
  }
  return null;
}

/** Resolve a look name to a `ColorEffectInput[]` (pre-scaled, ready for compileColorPipeline). */
export function resolveLookEffects(lookName: string, intensity: number): ColorEffectInput[] {
  const look = getCreativeLook(lookName);
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
