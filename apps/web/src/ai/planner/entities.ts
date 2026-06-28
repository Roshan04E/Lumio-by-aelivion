/**
 * Prompt entity extraction shared by both planners. These are synchronous,
 * dependency-free (plain string scans) so they work in the LLM planner's sync
 * validation path AND the deterministic planner. The LLM planner uses them to
 * BACKFILL params a model dropped (e.g. it picks `addShape` but forgets the
 * `color` the user clearly asked for); the deterministic planner uses them to
 * build params from scratch.
 */

const COLOR_WORDS: Record<string, string> = {
  red: "#ef4444",
  crimson: "#dc2626",
  scarlet: "#dc2626",
  green: "#22c55e",
  lime: "#84cc16",
  blue: "#3b82f6",
  navy: "#1e3a8a",
  cyan: "#06b6d4",
  teal: "#14b8a6",
  yellow: "#facc15",
  gold: "#eab308",
  white: "#ffffff",
  black: "#000000",
  gray: "#6b7280",
  grey: "#6b7280",
  silver: "#cbd5e1",
  orange: "#fb923c",
  amber: "#f59e0b",
  purple: "#a855f7",
  violet: "#8b5cf6",
  indigo: "#6366f1",
  magenta: "#d946ef",
  pink: "#ec4899",
  brown: "#92400e",
  maroon: "#7f1d1d"
};

// Adjectives that qualify a color ("neutral/warm/dark red") — ignored, we keep the base color.
const COLOR_QUALIFIERS =
  /\b(neutral|warm|cool|dark|light|bright|deep|pale|soft|muted|vivid|rich|dull|faded)\b/gi;

/** A hex color, or a named color (qualifiers like "neutral"/"dark" are stripped). */
export function extractColor(prompt: string): string | undefined {
  const hex = prompt.match(/#([0-9a-f]{3}|[0-9a-f]{6})\b/i);
  if (hex) {
    return hex[0];
  }
  const cleaned = prompt.toLowerCase().replace(COLOR_QUALIFIERS, " ");
  for (const [word, value] of Object.entries(COLOR_WORDS)) {
    if (new RegExp(`\\b${word}\\b`).test(cleaned)) {
      return value;
    }
  }
  return undefined;
}

/** Bold / italic intent for text. Returns only the flags actually mentioned. */
export function extractTextStyle(prompt: string): { bold?: boolean; italic?: boolean } {
  const out: { bold?: boolean; italic?: boolean } = {};
  if (/\b(bold|bolder|heavy|black|strong)\b/i.test(prompt)) out.bold = true;
  if (/\b(italic|italics|italicis\w*|oblique|slanted)\b/i.test(prompt)) out.italic = true;
  return out;
}

/** A font size in pixels for text, from explicit "NNpx" or size words. */
export function extractSize(prompt: string): number | undefined {
  const px = prompt.match(/\b(\d{1,3})\s*(?:px|pt)\b/i);
  if (px) return Math.min(800, Math.max(4, Number(px[1])));
  if (/\b(huge|massive|giant)\b/i.test(prompt)) return 160;
  if (/\b(large|big)\b/i.test(prompt)) return 120;
  if (/\b(small|tiny)\b/i.test(prompt)) return 48;
  return undefined;
}

// --- Shape geometry (shared by the deterministic planner AND the LLM backfill) ---

export interface ShapeGeometry {
  isShape: boolean;
  widthPercent?: number;
  heightPercent?: number;
  borderRadius?: number;
}

interface ShapeBase {
  widthPercent: number;
  heightPercent: number;
  round: boolean;
}

/** Detect the requested shape kind and its base proportions (round = needs a circular radius). */
function detectShapeBase(lower: string, square: (w: number) => { widthPercent: number; heightPercent: number }): ShapeBase | null {
  if (/\b(circle|round|dot|ring|disc|disk)\b/.test(lower)) return { ...square(24), round: true };
  if (/\b(ellipse|oval)\b/.test(lower)) return { widthPercent: 34, heightPercent: 24, round: true };
  if (/\b(pill|capsule|bar)\b/.test(lower)) return { widthPercent: 48, heightPercent: 12, round: true };
  if (/\bsquare\b/.test(lower)) return { ...square(24), round: false };
  if (/\b(rectangle|rect|box|banner)\b/.test(lower)) return { widthPercent: 46, heightPercent: 22, round: false };
  if (/\b(shape|blob|badge)\b/.test(lower)) return { widthPercent: 40, heightPercent: 24, round: false };
  return null;
}

/** Size multiplier from words like "tiny"/"big"/"huge". */
function shapeSizeScale(lower: string): number {
  if (/\b(huge|massive|giant|enormous)\b/.test(lower)) return 2.1;
  if (/\b(big|large)\b/.test(lower)) return 1.5;
  if (/\bsmall\b/.test(lower)) return 0.65;
  if (/\b(tiny|mini|miniature)\b/.test(lower)) return 0.45;
  return 1;
}

const clampPercent = (value: number): number => Math.max(1, Math.min(100, Number(value.toFixed(1))));

/**
 * Resolve a shape request into concrete, aspect-correct geometry from the PROMPT
 * (no wink needed, so the LLM planner can reuse it to backfill what the model
 * dropped). Nothing here is hardcoded to an orientation: "vertical"/"horizontal"
 * flip the long axis, size words scale it, and round shapes get a px radius ≥ half
 * their longest side so CSS renders a true circle/capsule at any size and aspect.
 */
export function resolveShapeGeometry(prompt: string, composition: { width?: number; height?: number }): ShapeGeometry {
  const lower = prompt.toLowerCase();
  const width = composition.width || 1080;
  const height = composition.height || 1920;
  const aspect = width / height;
  const square = (widthPercent: number) => ({ widthPercent, heightPercent: widthPercent * aspect });

  const base = detectShapeBase(lower, square);
  if (!base) {
    return { isShape: false };
  }

  const scale = shapeSizeScale(lower);
  let widthPercent = clampPercent(base.widthPercent * scale);
  let heightPercent = clampPercent(base.heightPercent * scale);

  const wantVertical = /\b(vertical|tall|portrait|upright)\b/.test(lower);
  const wantHorizontal = /\b(horizontal|wide|landscape)\b/.test(lower);
  if ((wantVertical && widthPercent > heightPercent) || (wantHorizontal && heightPercent > widthPercent)) {
    [widthPercent, heightPercent] = [heightPercent, widthPercent];
  }

  const borderRadius = base.round
    ? Math.ceil(Math.max((widthPercent / 100) * width, (heightPercent / 100) * height) / 2) + 1
    : /\b(shape|blob|badge)\b/.test(lower)
      ? 12
      : 0;

  return { isShape: true, widthPercent, heightPercent, borderRadius };
}

/** Directional words → on-screen percent coordinates (for new layers). */
export function extractPosition(prompt: string): { x?: number; y?: number } {
  const lower = prompt.toLowerCase();
  const out: { x?: number; y?: number } = {};
  if (/\btop\b/.test(lower)) out.y = 15;
  if (/\bbottom\b/.test(lower)) out.y = 85;
  if (/\bleft\b/.test(lower)) out.x = 15;
  if (/\bright\b/.test(lower)) out.x = 85;
  if (/\b(center|centre|middle)\b/.test(lower)) {
    out.x = 50;
    out.y = 50;
  }
  return out;
}
