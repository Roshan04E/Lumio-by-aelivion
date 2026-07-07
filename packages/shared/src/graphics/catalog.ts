/**
 * Bundled vector-graphics pack — offline, no API key, no network. Shipped alongside the searchable
 * Iconify results (`apps/web/src/lib/graphics-search.ts`) so the unified Search "Graphics" chip always has
 * SOMETHING to show even with no query and no connectivity. Every entry is a self-contained inline SVG
 * (viewBox 0 0 100 100, currentColor-free — solid fills only, so rasterizing to a PNG asset always renders
 * something visible regardless of the importing context's CSS).
 */

export interface BundledGraphic {
  id: string;
  name: string;
  category: "shape" | "arrow" | "badge" | "line" | "bubble";
  tags: string[];
  /** Inline SVG markup, viewBox "0 0 100 100". */
  svg: string;
}

function shape(id: string, name: string, category: BundledGraphic["category"], tags: string[], svg: string): BundledGraphic {
  return { id, name, category, tags: [name.toLowerCase(), ...tags], svg };
}

const FILL = "#5b8def";

export const BUNDLED_GRAPHICS: BundledGraphic[] = [
  shape("rect-basic", "Rectangle", "shape", ["box", "square"], `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><rect x="10" y="20" width="80" height="60" fill="${FILL}"/></svg>`),
  shape("rect-rounded", "Rounded Rectangle", "shape", ["box", "rounded"], `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><rect x="10" y="20" width="80" height="60" rx="14" fill="${FILL}"/></svg>`),
  shape("square", "Square", "shape", ["box"], `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><rect x="15" y="15" width="70" height="70" fill="${FILL}"/></svg>`),
  shape("circle", "Circle", "shape", ["round", "dot"], `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><circle cx="50" cy="50" r="42" fill="${FILL}"/></svg>`),
  shape("ellipse", "Ellipse", "shape", ["oval"], `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><ellipse cx="50" cy="50" rx="46" ry="30" fill="${FILL}"/></svg>`),
  shape("triangle", "Triangle", "shape", ["tri"], `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><polygon points="50,10 90,85 10,85" fill="${FILL}"/></svg>`),
  shape("diamond", "Diamond", "shape", ["rhombus"], `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><polygon points="50,8 92,50 50,92 8,50" fill="${FILL}"/></svg>`),
  shape("pentagon", "Pentagon", "shape", [], `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><polygon points="50,8 90,38 74,90 26,90 10,38" fill="${FILL}"/></svg>`),
  shape("hexagon", "Hexagon", "shape", [], `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><polygon points="50,6 90,28 90,72 50,94 10,72 10,28" fill="${FILL}"/></svg>`),
  shape("star", "Star", "shape", ["favorite"], `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><polygon points="50,6 61,38 95,38 68,58 78,90 50,70 22,90 32,58 5,38 39,38" fill="${FILL}"/></svg>`),
  shape("heart", "Heart", "shape", ["love", "like"], `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><path d="M50 88 C20 66 6 48 6 30 C6 14 18 4 32 4 C42 4 48 10 50 16 C52 10 58 4 68 4 C82 4 94 14 94 30 C94 48 80 66 50 88 Z" fill="${FILL}"/></svg>`),
  shape("cross", "Plus", "shape", ["add", "plus"], `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><path d="M40 5 H60 V40 H95 V60 H60 V95 H40 V60 H5 V40 H40 Z" fill="${FILL}"/></svg>`),

  shape("arrow-right", "Arrow Right", "arrow", ["direction"], `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><path d="M8 40 H60 V22 L92 50 L60 78 V60 H8 Z" fill="${FILL}"/></svg>`),
  shape("arrow-left", "Arrow Left", "arrow", ["direction"], `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><path d="M92 40 H40 V22 L8 50 L40 78 V60 H92 Z" fill="${FILL}"/></svg>`),
  shape("arrow-up", "Arrow Up", "arrow", ["direction"], `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><path d="M40 92 V40 H22 L50 8 L78 40 H60 V92 Z" fill="${FILL}"/></svg>`),
  shape("arrow-down", "Arrow Down", "arrow", ["direction"], `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><path d="M40 8 V60 H22 L50 92 L78 60 H60 V8 Z" fill="${FILL}"/></svg>`),
  shape("arrow-curved", "Curved Arrow", "arrow", ["direction", "swoosh"], `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><path d="M10 70 Q10 20 60 20 H78 L70 8 L94 24 L70 40 L78 28 H60 Q26 28 26 70 Z" fill="${FILL}"/></svg>`),
  shape("chevron-right", "Chevron", "arrow", ["next"], `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><path d="M30 10 L70 50 L30 90 L20 80 L52 50 L20 20 Z" fill="${FILL}"/></svg>`),

  shape("badge-round", "Round Badge", "badge", ["seal", "sticker"], `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><circle cx="50" cy="50" r="44" fill="none" stroke="${FILL}" stroke-width="8"/><circle cx="50" cy="50" r="28" fill="${FILL}"/></svg>`),
  shape("badge-ribbon", "Ribbon Badge", "badge", ["award", "sticker"], `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><circle cx="50" cy="38" r="30" fill="${FILL}"/><polygon points="30,60 30,96 50,82 70,96 70,60" fill="${FILL}"/></svg>`),
  shape("badge-burst", "Burst Badge", "badge", ["sale", "sticker"], `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><g fill="${FILL}"><polygon points="50,4 58,26 80,16 68,36 92,42 68,52 84,72 60,62 56,86 46,64 24,80 32,58 8,58 28,44 12,28 36,32"/></g></svg>`),
  shape("badge-hex", "Hex Badge", "badge", ["seal", "sticker"], `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><polygon points="50,4 92,27 92,73 50,96 8,73 8,27" fill="none" stroke="${FILL}" stroke-width="8"/><circle cx="50" cy="50" r="18" fill="${FILL}"/></svg>`),

  shape("line-solid", "Line", "line", ["divider", "underline"], `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><rect x="5" y="46" width="90" height="8" fill="${FILL}"/></svg>`),
  shape("line-dashed", "Dashed Line", "line", ["divider"], `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><line x1="5" y1="50" x2="95" y2="50" stroke="${FILL}" stroke-width="8" stroke-dasharray="14 10" stroke-linecap="round"/></svg>`),
  shape("line-wavy", "Wavy Line", "line", ["divider", "squiggle"], `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><path d="M5 50 Q 20 30, 35 50 T 65 50 T 95 50" fill="none" stroke="${FILL}" stroke-width="8" stroke-linecap="round"/></svg>`),
  shape("underline-brush", "Brush Underline", "line", ["highlight"], `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><path d="M4 60 Q 50 40 96 58 Q 50 76 4 60 Z" fill="${FILL}"/></svg>`),

  shape("bubble-round", "Speech Bubble", "bubble", ["chat", "talk"], `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><rect x="6" y="10" width="88" height="60" rx="16" fill="${FILL}"/><polygon points="24,70 24,92 46,70" fill="${FILL}"/></svg>`),
  shape("bubble-cloud", "Thought Bubble", "bubble", ["think", "chat"], `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><ellipse cx="50" cy="36" rx="42" ry="28" fill="${FILL}"/><circle cx="26" cy="72" r="9" fill="${FILL}"/><circle cx="14" cy="90" r="5" fill="${FILL}"/></svg>`),
  shape("bubble-burst", "Exclaim Bubble", "bubble", ["shout", "chat"], `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><polygon points="10,10 90,6 84,50 96,56 76,66 82,94 50,72 18,90 26,58 4,50 20,44" fill="${FILL}"/></svg>`)
];

function matchesGraphicQuery(graphic: BundledGraphic, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return graphic.tags.some((tag) => tag.includes(q)) || graphic.category.includes(q);
}

export function listBundledGraphics(): BundledGraphic[] {
  return BUNDLED_GRAPHICS;
}

export function searchBundledGraphics(query: string): BundledGraphic[] {
  return BUNDLED_GRAPHICS.filter((graphic) => matchesGraphicQuery(graphic, query));
}
