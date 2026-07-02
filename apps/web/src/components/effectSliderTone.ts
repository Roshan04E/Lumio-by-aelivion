/**
 * Tone helpers for the effect sliders — kept OUT of EffectSliderControl.tsx so that component file
 * exports a component only (mixed component + helper exports break React Fast Refresh, forcing a full
 * reload of the file and its importers on every edit).
 */

export type SliderTone = "neutral" | "warmth" | "tint" | "saturation" | "light" | "shadow" | "highlight";

/** Map a param key to its tonal track color so sliders read like a pro color panel. */
export function effectSliderTone(key: string): SliderTone {
  if (key === "temperature") return "warmth";
  if (key === "tint") return "tint";
  if (key === "saturation" || key === "vibrance") return "saturation";
  if (key === "blackPoint" || key === "blacks" || key === "shadows" || key === "curveShadows") return "shadow";
  if (key === "whitePoint" || key === "whites" || key === "highlights" || key === "curveHighlights") return "highlight";
  if (key === "midtones" || key === "curveMidtones" || key === "exposure") return "light";
  if (key === "brightness" || key === "contrast" || key === "amount") return "light";
  return "neutral";
}

export function formatEffectValue(value: number, step: number) {
  return step < 1 ? value.toFixed(1) : String(Math.round(value));
}
