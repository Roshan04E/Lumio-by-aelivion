/**
 * Shared helpers for splitting/joining a CSS background color into a hex + alpha
 * pair, used by both the Auto Captions style tab and the editor's graphics
 * inspector so they treat background opacity identically.
 */

export interface ParsedBackground {
  hex: string;
  alphaPercent: number;
}

export function parseBackgroundColor(value: string | undefined, fallbackHex: string): ParsedBackground {
  if (!value) {
    return { hex: fallbackHex, alphaPercent: 14 };
  }
  if (value === "transparent") {
    return { hex: fallbackHex, alphaPercent: 0 };
  }
  const rgbaMatch = value.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)/i);
  if (rgbaMatch) {
    const r = Math.round(Number(rgbaMatch[1]));
    const g = Math.round(Number(rgbaMatch[2]));
    const b = Math.round(Number(rgbaMatch[3]));
    const alpha = rgbaMatch[4] !== undefined ? Number(rgbaMatch[4]) : 1;
    return { hex: rgbToHex(r, g, b), alphaPercent: Math.round(alpha * 100) };
  }
  if (/^#[0-9a-f]{6}$/i.test(value)) {
    return { hex: value, alphaPercent: 100 };
  }
  return { hex: fallbackHex, alphaPercent: 14 };
}

export function buildBackgroundColor(hex: string, alphaPercent: number): string {
  const clamped = Math.min(100, Math.max(0, Number.isFinite(alphaPercent) ? alphaPercent : 0));
  if (clamped <= 0) {
    return "transparent";
  }
  if (clamped >= 100) {
    return hex;
  }
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${(clamped / 100).toFixed(2)})`;
}

export function hexToRgb(hex: string) {
  const value = hex.replace("#", "");
  return {
    r: Number.parseInt(value.slice(0, 2), 16) || 0,
    g: Number.parseInt(value.slice(2, 4), 16) || 0,
    b: Number.parseInt(value.slice(4, 6), 16) || 0
  };
}

export function rgbToHex(r: number, g: number, b: number) {
  return `#${[r, g, b].map((channel) => Math.min(255, Math.max(0, Math.round(channel))).toString(16).padStart(2, "0")).join("")}`;
}
