/**
 * Editable vector graphic helpers — shared by the editor, web preview, and Remotion export so a graphic
 * recolors identically everywhere. A graphic layer stores its SVG normalized to `currentColor`; the current
 * `fill` is baked into a data-URL `<img>` source on render (SVG images don't inherit CSS `color`, so the color
 * must live inside the markup). Vector, so it scales crisply and stays recolorable — no rasterized asset.
 */

import type { LayerGraphic, TimelineKeyframeV2 } from "../types";
import { evaluateAnimatedValue } from "../animation";

/** Default graphic fill (matches the bundled pack's original blue) used when a pick carries no explicit color. */
export const DEFAULT_GRAPHIC_FILL = "#5b8def";

/** Escape a user/color string to a safe CSS color token so it can't break out of the SVG attribute or inject
 *  markup. Accepts hex, rgb()/rgba(), hsl()/hsla(), and bare CSS color keywords; anything else → the default. */
export function sanitizeGraphicFill(fill: string | undefined): string {
  const value = (fill ?? "").trim();
  if (/^#[0-9a-fA-F]{3,8}$/.test(value)) return value;
  if (/^(rgb|rgba|hsl|hsla)\([0-9.,%\s/]+\)$/.test(value)) return value;
  // Keyword-shaped but NOT a color: SMIL fill values ("freeze"/"remove", from the palette-extraction
  // bug that read them off <animate> tags) and CSS-wide keywords — never bake these as color="…".
  if (/^(freeze|remove|inherit|initial|unset|revert)$/i.test(value)) return DEFAULT_GRAPHIC_FILL;
  if (/^[a-zA-Z]{3,20}$/.test(value)) return value; // css color keyword (red, tomato, transparent…)
  return DEFAULT_GRAPHIC_FILL;
}

/** Parse a viewBox / width+height to a natural pixel aspect for framing. Returns undefined dims when unknown. */
function readViewBox(svg: string): { naturalWidth?: number; naturalHeight?: number } {
  const viewBox = /viewBox\s*=\s*["']\s*[-\d.]+\s+[-\d.]+\s+([\d.]+)\s+([\d.]+)/i.exec(svg);
  if (viewBox) {
    const w = Number(viewBox[1]);
    const h = Number(viewBox[2]);
    if (w > 0 && h > 0) return { naturalWidth: w, naturalHeight: h };
  }
  const w = /\bwidth\s*=\s*["']?([\d.]+)/i.exec(svg);
  const h = /\bheight\s*=\s*["']?([\d.]+)/i.exec(svg);
  if (w && h && Number(w[1]) > 0 && Number(h[1]) > 0) {
    return { naturalWidth: Number(w[1]), naturalHeight: Number(h[1]) };
  }
  return {};
}

/**
 * Normalize a picked SVG into a recolorable graphic: every occurrence of `sourceColor` (the pack's baked fill)
 * becomes `currentColor`, so a single `color` on the root recolors the whole shape. Iconify mono icons already
 * use `currentColor`, so passing no `sourceColor` leaves them untouched (still recolorable). Multicolor icons
 * that use no `currentColor` and don't match `sourceColor` render as-authored (not recolorable — acceptable for
 * the solid-colors-first pass).
 */
export function normalizeGraphicSvg(svg: string, sourceColor?: string | undefined): LayerGraphic {
  // SMIL is PRESERVED here: the stored svg is the graphic's source of truth, and animated icons (the
  // line-md pack) now PLAY their animation (see graphicToAnimatedDataUrl / graphicAnimationFrame).
  // This used to settle at import, which destroyed the animation before it was ever stored — the
  // static bake (graphicToDataUrl) still settles on its own, so the "invisible base state paints
  // nothing" case that motivated the import-time settle stays covered for non-animated rendering.
  let normalized = svg.trim();
  if (sourceColor) {
    // Replace the baked fill (in fill="…"/stroke="…" attrs and any inline usage), case-insensitively.
    normalized = normalized.replace(new RegExp(escapeRegExp(sourceColor), "gi"), "currentColor");
  }
  return { svg: normalized, fill: sanitizeGraphicFill(sourceColor), ...readViewBox(normalized) };
}

/** SMIL animation elements — matched for settling/stripping and excluded from palette scans. */
const SMIL_TAG_NAMES = ["animate", "set", "animatetransform", "animatemotion", "animatecolor"] as const;
const SMIL_TEST = /<(animate|set|animateTransform|animateMotion|animateColor)\b/i;
const SMIL_STRIP = /<\/?(?:animate|set|animateTransform|animateMotion|animateColor)\b(?:"[^"]*"|'[^']*'|[^>"'])*>/gi;

/**
 * Statically "settle" a SMIL-animated SVG: apply each `<animate>`/`<set>`'s FINAL value (last `values`
 * entry, else `to`) onto its parent element's attribute, then strip every animation element. Animated
 * icon packs (line-md, …) hide their base state and draw in via animation — rasterized as an `<img>`
 * texture the base state is what paints, i.e. nothing. The settled document is the completed look.
 * Non-animated SVGs return unchanged via the cheap test.
 *
 * Applied ONLY at the static bake (graphicToDataUrl) — NOT at import. Import must preserve the SMIL
 * (it's the stored source of truth that drives live playback, graphicToAnimatedDataUrl); settling
 * there destroyed the animation before it was ever stored. Graphics imported while that was the case
 * carry a settled svg and need a RE-IMPORT to animate — the data is gone, not recoverable.
 */
export function settleSvgAnimations(svg: string): string {
  if (!SMIL_TEST.test(svg)) return svg;
  const tagRe = /<(\/?)([a-zA-Z][\w:.-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
  interface OpenTag {
    name: string;
    start: number;
    end: number;
    attrUpdates?: Map<string, string>;
  }
  const stack: OpenTag[] = [];
  const deletions: { start: number; end: number }[] = [];
  const updatedTags = new Map<number, OpenTag>();
  let match: RegExpExecArray | null;
  while ((match = tagRe.exec(svg))) {
    const raw = match[0];
    const closing = Boolean(match[1]);
    const name = (match[2] ?? "").toLowerCase();
    const selfClosing = raw.endsWith("/>");
    if (closing) {
      for (let i = stack.length - 1; i >= 0; i -= 1) {
        if (stack[i]!.name === name) {
          stack.length = i;
          break;
        }
      }
      continue;
    }
    if ((SMIL_TAG_NAMES as readonly string[]).includes(name)) {
      let end = match.index + raw.length;
      if (!selfClosing) {
        const closeRe = new RegExp(`</${name}\\s*>`, "ig");
        closeRe.lastIndex = end;
        const close = closeRe.exec(svg);
        if (close) end = close.index + close[0].length;
      }
      deletions.push({ start: match.index, end });
      tagRe.lastIndex = end;
      // Settle animate/set final values (transform/motion animations are just stripped — their base
      // geometry is the sensible static state). Always use the final value regardless of fill=freeze:
      // the completed animation IS the icon's intended static look.
      if ((name === "animate" || name === "set") && stack.length) {
        const attrName = /\battributeName\s*=\s*["']([^"']+)["']/i.exec(raw)?.[1];
        const valuesAttr = /\bvalues\s*=\s*["']([^"']*)["']/i.exec(raw)?.[1];
        const toAttr = /\bto\s*=\s*["']([^"']*)["']/i.exec(raw)?.[1];
        const final = valuesAttr
          ? valuesAttr
              .split(";")
              .map((entry) => entry.trim())
              .filter(Boolean)
              .pop()
          : toAttr;
        if (attrName && final !== undefined && /^[a-zA-Z_][\w:.-]*$/.test(attrName) && attrName.toLowerCase() !== "transform") {
          const parent = stack[stack.length - 1]!;
          parent.attrUpdates ??= new Map();
          parent.attrUpdates.set(attrName, final);
          updatedTags.set(parent.start, parent);
        }
      }
      continue;
    }
    if (!selfClosing) stack.push({ name, start: match.index, end: match.index + raw.length });
  }
  if (!deletions.length && !updatedTags.size) return svg;
  const edits: { start: number; end: number; text: string }[] = deletions.map((d) => ({ ...d, text: "" }));
  for (const tag of updatedTags.values()) {
    let open = svg.slice(tag.start, tag.end);
    for (const [attr, value] of tag.attrUpdates!) {
      const safe = value.replace(/["<>]/g, "");
      const attrRe = new RegExp(`(\\s${escapeRegExp(attr)}\\s*=\\s*)(?:"[^"]*"|'[^']*')`, "i");
      open = attrRe.test(open) ? open.replace(attrRe, `$1"${safe}"`) : open.replace(/\s*\/?>$/, (tail) => ` ${attr}="${safe}"${tail.trimStart()}`);
    }
    edits.push({ start: tag.start, end: tag.end, text: open });
  }
  edits.sort((a, b) => b.start - a.start);
  let out = svg;
  for (const edit of edits) out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  return out;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Distinct paint colors used by an SVG's `fill`/`stroke` (attributes and inline `style`), in first-seen
 * order; `none`/`currentColor`/url() paints excluded. Drives import-time recolorability: exactly ONE
 * color → normalize it to `currentColor` (simple Fill control works, like the bundled pack); several →
 * a per-color palette (each entry an exact-literal substitution slot). Case-insensitive de-dupe,
 * original casing preserved (substitutions replace case-insensitively).
 */
export function extractSvgPalette(svg: string): string[] {
  const colors: string[] = [];
  const seen = new Set<string>();
  // Scan with SMIL animation elements removed: `<animate fill="freeze">` uses `fill` as the SMIL
  // freeze/remove keyword, NOT a paint — treating "freeze" as the icon's color mangled the graphic
  // (color="freeze" root + the animation keyword rewritten to currentColor).
  const scanSvg = svg.replace(SMIL_STRIP, "");
  const NON_PAINT_KEYWORDS = new Set(["none", "currentcolor", "transparent", "freeze", "remove", "inherit", "initial", "unset", "revert"]);
  const add = (raw: string | undefined) => {
    const value = (raw ?? "").trim();
    if (!value) return;
    const lower = value.toLowerCase();
    if (NON_PAINT_KEYWORDS.has(lower) || lower.startsWith("url(")) return;
    // Only real color tokens (hex / rgb / hsl / keyword) — same shapes sanitizeGraphicFill accepts.
    if (!/^#[0-9a-fA-F]{3,8}$/.test(value) && !/^(rgb|rgba|hsl|hsla)\([0-9.,%\s/]+\)$/.test(value) && !/^[a-zA-Z]{3,20}$/.test(value)) return;
    if (seen.has(lower)) return;
    seen.add(lower);
    colors.push(value);
  };
  for (const match of scanSvg.matchAll(/\b(?:fill|stroke)\s*=\s*["']([^"']+)["']/gi)) add(match[1]);
  for (const match of scanSvg.matchAll(/\b(?:fill|stroke)\s*:\s*([^;"'}]+)/gi)) add(match[1]);
  return colors;
}

/** Longest-side pixel size baked into the SVG root so it rasterizes crisply as an `<img>`/texture (vector
 *  scales to any display size, but the decode/texture-upload happens at these intrinsic dims). */
const GRAPHIC_RASTER_SIZE = 1024;

/** Bake `fill` into the SVG root as a `color` presentation attribute (so `currentColor` resolves when the SVG
 *  is used as an `<img>`/texture source) AND explicit width/height (an SVG with only a viewBox decodes with an
 *  ambiguous/zero intrinsic size as an `<img>`, so the compositor would drop it). Returns a data URL —
 *  deterministic, identical in every renderer. */
export function graphicToDataUrl(graphic: LayerGraphic): string {
  // Defensive settle at bake time: graphics imported BEFORE the import-time settle existed still carry
  // live SMIL animations (invisible base state) — this heals them without re-import. Animated playback
  // uses graphicToAnimatedDataUrl instead (no settle); this settled form is the static fallback.
  return bakeGraphicSvg(graphic, settleSvgAnimations(graphic.svg));
}

/** Bake a graphic's fill/palette/intrinsic-size into `sourceSvg` and return its data URL. Shared by the
 *  settled (static) and animated (SMIL begin-shifted) paths so recolor + sizing stay pixel-identical. */
function bakeGraphicSvg(graphic: LayerGraphic, sourceSvg: string): string {
  const fill = sanitizeGraphicFill(graphic.fill);
  const aspect = (graphic.naturalWidth ?? 1) / (graphic.naturalHeight ?? 1);
  const width = aspect >= 1 ? GRAPHIC_RASTER_SIZE : Math.round(GRAPHIC_RASTER_SIZE * aspect);
  const height = aspect >= 1 ? Math.round(GRAPHIC_RASTER_SIZE / aspect) : GRAPHIC_RASTER_SIZE;
  // Multicolor palette: substitute each changed source color literal (the `currentColor` normalize
  // trick generalized — exact-literal, case-insensitive, sanitized so a stored value can't inject
  // markup). Same bake for every renderer, so recolors stay pixel-aligned preview↔export.
  let svg = sourceSvg;
  const slots = (graphic.palette ?? []).filter((slot) => slot.from && slot.to !== slot.from);
  if (slots.length) {
    // Single combined pass (a chained per-slot replace could re-substitute another slot's output),
    // with boundary guards so a keyword like `red` never matches inside `darkred`.
    const to = new Map(slots.map((slot) => [slot.from.toLowerCase(), sanitizeGraphicFill(slot.to)]));
    const combined = new RegExp(`(?<![\\w#-])(${slots.map((slot) => escapeRegExp(slot.from)).join("|")})(?![\\w-])`, "gi");
    svg = svg.replace(combined, (match) => to.get(match.toLowerCase()) ?? match);
  }
  // Strip any existing root color/width/height, then inject ours right after the opening `<svg`.
  const cleaned = svg
    .replace(/(<svg\b[^>]*?)\s+color\s*=\s*["'][^"']*["']/i, "$1")
    .replace(/(<svg\b[^>]*?)\s+width\s*=\s*["'][^"']*["']/i, "$1")
    .replace(/(<svg\b[^>]*?)\s+height\s*=\s*["'][^"']*["']/i, "$1")
    .replace(/<svg\b/i, `<svg color="${fill}" width="${width}" height="${height}"`);
  return `data:image/svg+xml,${encodeURIComponent(cleaned)}`;
}

// ─── Animated (SMIL) graphics ────────────────────────────────────────────────────────────────────
//
// Animated icon packs (line-md, …) carry SMIL animations. Instead of settling them to a static final
// frame, we play them live by rendering the graphic at a chosen point in its cycle. The unifying
// primitive across every renderer — including the DOM-less export Worker, via a main-thread pre-bake —
// is the SMIL "deep-link": an <img> whose animations carry begin="-Ts" renders frame T immediately at
// load, independent of the document clock. All renderers select a frame with the SAME shared math
// (graphicAnimationFrame), so pixels stay aligned preview ↔ local export ↔ Remotion.

/** Frame sampling rate for baked animation frames. */
export const GRAPHIC_ANIM_FPS = 30;
/** Hard cap on baked frames per graphic (bounds memory/transfer for long cycles). */
export const GRAPHIC_ANIM_MAX_FRAMES = 90;

const smilCycleCache = new Map<string, number | null>();

/** Parse a SMIL time value ("1.5s", "600ms", bare seconds) to seconds; null if unparseable. */
function parseSmilTimeSeconds(raw: string | undefined): number | null {
  const value = (raw ?? "").trim().toLowerCase();
  const ms = /^([\d.]+)ms$/.exec(value);
  if (ms) return Number(ms[1]) / 1000;
  const s = /^([\d.]+)s?$/.exec(value);
  if (s) return Number(s[1]);
  return null;
}

/**
 * Loop-cycle length (seconds) of an SVG's SMIL animations, or null if it carries none. Heuristic: the
 * max over all animation elements of (begin offset + active duration), where active = dur × finite
 * repeatCount (indefinite counts as one dur). Looping at that boundary replays the whole graphic —
 * the longest "draw-in" completes and harmonically-related sub-loops (e.g. a 1s spinner under a 2s
 * draw-in) re-align. Memoized by svg string (called per render). Returns null → use the static bake.
 */
export function getGraphicAnimationCycleSeconds(svg: string): number | null {
  const cached = smilCycleCache.get(svg);
  if (cached !== undefined) return cached;
  let cycle: number | null = null;
  if (SMIL_TEST.test(svg)) {
    let maxActive = 0;
    for (const match of svg.matchAll(SMIL_OPEN)) {
      const attrs = match[2] ?? "";
      const dur = parseSmilTimeSeconds(/\bdur\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1]);
      if (dur === null || dur <= 0) continue;
      const begin = parseSmilTimeSeconds(/\bbegin\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1]) ?? 0;
      const repeatRaw = /\brepeatCount\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1]?.trim().toLowerCase();
      const repeats = repeatRaw && repeatRaw !== "indefinite" ? Math.max(1, Number(repeatRaw) || 1) : 1;
      maxActive = Math.max(maxActive, Math.max(0, begin) + dur * repeats);
    }
    if (maxActive > 0) cycle = maxActive;
  }
  smilCycleCache.set(svg, cycle);
  return cycle;
}

/** SMIL element opening tags — used to inject the begin deep-link and to scan durations/repeat intent. */
const SMIL_OPEN = /<(animate|set|animateTransform|animateMotion|animateColor)\b((?:"[^"]*"|'[^']*'|[^>"'])*)>/gi;

const smilLoopCache = new Map<string, boolean>();

/**
 * The SVG's OWN loop intent: true when any animation repeats indefinitely (a spinner), false when they
 * all run once and hold (`fill="freeze"` — a line-md-style draw-in). This is the default the layer's
 * `animation.loop` override can replace; icon authors declare it deliberately, so honor it unless the
 * user says otherwise. Memoized by svg string.
 */
export function graphicAnimationLoopsByDefault(svg: string): boolean {
  const cached = smilLoopCache.get(svg);
  if (cached !== undefined) return cached;
  let loops = false;
  for (const match of svg.matchAll(SMIL_OPEN)) {
    const attrs = match[2] ?? "";
    const repeatCount = /\brepeatCount\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1]?.trim().toLowerCase();
    const repeatDur = /\brepeatDur\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1]?.trim().toLowerCase();
    if (repeatCount === "indefinite" || repeatDur === "indefinite") {
      loops = true;
      break;
    }
  }
  smilLoopCache.set(svg, loops);
  return loops;
}

/** Layer-scope keyframe properties driving a graphic's animation. Times are LAYER-LOCAL seconds — the
 *  TimelineKeyframeV2 convention (`evaluateTimelineTransform` evaluates at `timeSeconds - startSeconds`,
 *  and the panels store `currentTime - layer.startSeconds`). Local storage is also why these survive a
 *  work-area in-point shift untouched. */
export const GRAPHIC_PROGRESS_PROPERTY = "graphicProgress";
export const GRAPHIC_DURATION_PROPERTY = "graphicDuration";

/** Floor for a cycle length — guards the 1/duration integrand against divide-by-zero / negatives. */
const MIN_CYCLE_SECONDS = 0.01;

/** A graphic's resolved playback plan — the SVG's own animation combined with the layer's overrides. */
export interface GraphicAnimationPlan {
  /** The SVG's intrinsic cycle: the deep-link TIME DOMAIN frames are baked over. */
  naturalCycleSeconds: number;
  /** How long one cycle takes ON THE TIMELINE (override or natural) — the STATIC selection domain.
   *  Differing from `naturalCycleSeconds` time-scales playback without re-authoring the SVG. */
  playDurationSeconds: number;
  /** Repeat for the clip's whole duration, vs. play once and hold the final frame. */
  loop: boolean;
  frameCount: number;
  /** Progress keyframes rebased to CLIP-LOCAL time (cycles: 1 = one full cycle). Highest precedence —
   *  they ARE the phase, so hold/reverse/ease/jump all fall out for free. */
  progressKeys: TimelineKeyframeV2[];
  /** Duration ramp rebased to CLIP-LOCAL time (seconds per cycle), linear segments + edge-hold. */
  durationKeys: Array<{ timeSeconds: number; value: number }>;
}

/** Pull a layer-scope numeric keyframe list for `property`, sorted. Times are already LAYER-LOCAL. */
function localKeys(animations: TimelineKeyframeV2[] | undefined, property: string): TimelineKeyframeV2[] {
  if (!animations?.length) return [];
  return animations
    .filter((k) => k.target.scope === "layer" && k.target.property === property && typeof k.value === "number")
    .sort((a, b) => a.timeSeconds - b.timeSeconds);
}

/**
 * Resolve a graphic's animation plan, or null when it carries no SMIL (→ use the static settled bake).
 * Defaults come from the SVG itself (its cycle, its repeat intent); `graphic.animation` overrides them
 * per layer; keyframes on the LAYER override both. Every renderer resolves through here so
 * preview/local export/Remotion agree — pass the layer's `animations` or keyframed graphics silently
 * fall back to static playback in that renderer.
 */
export function resolveGraphicAnimation(
  graphic: LayerGraphic | undefined,
  options: { animations?: TimelineKeyframeV2[] | undefined } = {}
): GraphicAnimationPlan | null {
  if (!graphic) return null;
  const naturalCycleSeconds = getGraphicAnimationCycleSeconds(graphic.svg);
  if (naturalCycleSeconds == null) return null;
  const override = graphic.animation;
  const playDurationSeconds =
    override?.durationSeconds != null && override.durationSeconds > 0 ? override.durationSeconds : naturalCycleSeconds;
  const loop = override?.loop ? override.loop === "infinite" : graphicAnimationLoopsByDefault(graphic.svg);
  const progressKeys = localKeys(options.animations, GRAPHIC_PROGRESS_PROPERTY);
  const durationKeys = localKeys(options.animations, GRAPHIC_DURATION_PROPERTY).map((k) => ({
    timeSeconds: k.timeSeconds,
    value: Math.max(MIN_CYCLE_SECONDS, k.value as number),
  }));
  return {
    naturalCycleSeconds,
    playDurationSeconds,
    loop,
    // Frames are baked across the NATURAL cycle, but how many we need is set by the SLOWEST the clip
    // ever plays it — a stretched cycle holds each frame longer, so it needs more of them to stay smooth.
    frameCount: graphicAnimationFrameCount(slowestCycleSeconds(playDurationSeconds, progressKeys, durationKeys)),
    progressKeys,
    durationKeys,
  };
}

/** The longest one cycle ever takes on the timeline — drives how many frames to bake. */
function slowestCycleSeconds(
  staticDuration: number,
  progressKeys: TimelineKeyframeV2[],
  durationKeys: Array<{ timeSeconds: number; value: number }>
): number {
  if (durationKeys.length) return Math.max(...durationKeys.map((k) => k.value));
  if (progressKeys.length >= 2) {
    const first = progressKeys[0]!;
    const last = progressKeys[progressKeys.length - 1]!;
    const span = last.timeSeconds - first.timeSeconds;
    const cycles = Math.abs((last.value as number) - (first.value as number));
    if (span > 0 && cycles > 1e-6) return span / cycles; // average seconds per cycle
  }
  return staticDuration;
}

/**
 * Cycles completed at CLIP-LOCAL time `localSeconds` — the one phase every renderer selects frames from.
 * Precedence: progress keyframes (they ARE the phase) → a duration ramp (integrated) → the static
 * duration. Integer part = whole cycles, fraction = position within the current one.
 */
export function graphicAnimationPhase(plan: GraphicAnimationPlan, localSeconds: number): number {
  if (plan.progressKeys.length) {
    return evaluateAnimatedValue<number>({
      baseValue: 0,
      keyframes: plan.progressKeys,
      property: GRAPHIC_PROGRESS_PROPERTY,
      scope: "layer",
      timeSeconds: localSeconds,
    });
  }
  if (plan.durationKeys.length) return integrateInverseDuration(plan.durationKeys, localSeconds);
  return plan.playDurationSeconds > 0 ? Math.max(0, localSeconds) / plan.playDurationSeconds : 0;
}

/**
 * Exact ∫₀ᵗ 1/duration(u) du over a LINEAR duration ramp (edge values hold outside the keys) = cycles
 * completed by t. Mirrors `integrateRamp`'s model (linear segments, edge-hold), but the integrand here
 * is 1/(a+bu) — a hyperbola — so each segment closes to (1/b)·ln(d(t)/d₀) rather than a trapezoid.
 *
 * The integral is what makes a duration ramp CONTINUOUS: evaluating `t % duration(t)` directly would
 * jump the animation every time the duration changed, because the phase itself would be discontinuous.
 */
function integrateInverseDuration(keys: Array<{ timeSeconds: number; value: number }>, localSeconds: number): number {
  const t = Math.max(0, localSeconds);
  const first = keys[0]!;
  // Before the first key: constant at the first value.
  let phase = Math.min(t, Math.max(0, first.timeSeconds)) / first.value;
  if (t <= first.timeSeconds) return phase;
  for (let i = 1; i < keys.length; i += 1) {
    const a = keys[i - 1]!;
    const b = keys[i]!;
    const span = b.timeSeconds - a.timeSeconds;
    if (span <= 0) continue;
    const dt = Math.min(t, b.timeSeconds) - a.timeSeconds;
    if (dt > 0) {
      const k = (b.value - a.value) / span; // d(u) = a.value + k·u
      phase += Math.abs(k) < 1e-9 ? dt / a.value : Math.log((a.value + k * dt) / a.value) / k;
    }
    if (t <= b.timeSeconds) return phase;
  }
  // After the last key: constant at the last value.
  const last = keys[keys.length - 1]!;
  phase += (t - last.timeSeconds) / last.value;
  return phase;
}

/** True when a graphic carries SMIL animation that should play live (vs. the settled static bake). */
export function graphicIsAnimated(graphic: LayerGraphic | undefined): boolean {
  return resolveGraphicAnimation(graphic) !== null;
}

/**
 * Deep-link every SMIL animation to `offsetSeconds`, producing an SVG that renders THAT frame and then
 * holds it forever. Non-SMIL SVGs pass through unchanged.
 *
 * `begin="-Ts"` alone is not enough, and this is the subtle part. It renders frame T at document time
 * 0 — but an `<img>`'s SVG clock starts the instant it loads and never stops, so every millisecond
 * between "loaded" and "we captured it" silently ADDS to the phase. The bake is then a race: capture
 * quickly and it's about right, capture late and the frame is wrong. The preview's sequential bake
 * (~2ms/frame) hid it behind a uniform nudge; the export's parallel rasterize + blocking `toDataURL`
 * skewed later frames by a large fraction of a cycle, which reads as a spinner that "renders fewer
 * frames" (see project-tracker/export.md v6).
 *
 * So the clock is taken out of the equation: the animation is made to END almost immediately and
 * `fill="freeze"` holds the value it had there. `begin` is shifted to `-(T - ε)` and `end` set to `ε`,
 * giving an active duration of exactly T — so the frozen value is frame T, held for all document time
 * ≥ ε. The result is a STATIC image of frame T; capture it whenever, every renderer gets identical
 * pixels.
 *
 * ε is small but MUST be > 0: `end="0s"` (the obvious form) closes the interval exactly at the
 * document start, and Chrome then renders the BASE state rather than the frozen value — an interval
 * that ends at time 0 is treated as never having applied. The graphic:render gate catches this
 * immediately (every frame comes back as base-state ink), which is why the bake primitive is verified
 * against real Chromium rather than reasoned about from the SMIL spec.
 *
 * The author's own `begin` delay is PRESERVED and shifted (`begin="0.5s"` at offset 0.7 → `"-0.2s"`),
 * so staggered/choreographed icons keep their timing — and one whose delay hasn't elapsed yet gets
 * `begin > end`, hence no active interval and its base state, which is exactly right.
 * `repeatCount`/`repeatDur` are deliberately NOT touched: they declare the author's loop intent, which
 * `resolveGraphicAnimation` reads (and the layer can override). Forcing them to `indefinite` here
 * overrode `fill="freeze"` and made one-shot draw-ins loop against their author's intent. `end`
 * truncates a repeating animation's active interval without touching which value it freezes on
 * (active time T of an indefinite repeat is still T mod dur).
 */
/**
 * How far past the document start a baked animation's active interval extends. Must be > 0 (see
 * shiftSvgSmilBegin) and small enough that the freeze is indistinguishable from the target frame.
 */
const SMIL_BAKE_EPSILON = 0.001;

export function shiftSvgSmilBegin(svg: string, offsetSeconds: number): string {
  if (!SMIL_TEST.test(svg)) return svg;
  return svg.replace(SMIL_OPEN, (_full, tag: string, rawAttrs: string) => {
    const selfClose = /\/\s*$/.test(rawAttrs);
    // Non-offset begins ("click", "a.end") can't be shifted — deep-link from 0 instead.
    const base = parseSmilTimeSeconds(/\bbegin\s*=\s*["']([^"']+)["']/i.exec(rawAttrs)?.[1]) ?? 0;
    // begin = -(T - ε) so that end(ε) - begin = T exactly: the freeze lands on frame T, not T + ε.
    const beginVal = `${String(Number((base - offsetSeconds + SMIL_BAKE_EPSILON).toFixed(4)))}s`;
    // `fill`/`end` on an animation element are SMIL timing attributes (not paint), so replacing the
    // author's is safe here: a bake wants one frozen frame, whatever the author's playback intent was.
    let attrs = rawAttrs
      .replace(/\/\s*$/, "")
      .replace(/\s+begin\s*=\s*(?:"[^"]*"|'[^']*')/i, "")
      .replace(/\s+end\s*=\s*(?:"[^"]*"|'[^']*')/i, "")
      .replace(/\s+fill\s*=\s*(?:"[^"]*"|'[^']*')/i, "")
      .trim();
    attrs = attrs ? ` ${attrs}` : "";
    return `<${tag}${attrs} begin="${beginVal}" end="${SMIL_BAKE_EPSILON}s" fill="freeze"${selfClose ? " /" : ""}>`;
  });
}

/** Data URL for an animated graphic deep-linked at `svgTimeSeconds` into its NATURAL cycle
 *  (fill/palette/size baked, SMIL kept — NOT settled). Mirror of graphicToDataUrl for the animated path. */
export function graphicToAnimatedDataUrl(graphic: LayerGraphic, svgTimeSeconds: number): string {
  return bakeGraphicSvg(graphic, shiftSvgSmilBegin(graphic.svg, svgTimeSeconds));
}

/** Number of frames to bake for a cycle (≥1, capped, at GRAPHIC_ANIM_FPS). */
export function graphicAnimationFrameCount(cycleSeconds: number): number {
  return Math.max(1, Math.min(GRAPHIC_ANIM_MAX_FRAMES, Math.round(cycleSeconds * GRAPHIC_ANIM_FPS)));
}

/**
 * The SVG deep-link time to bake frame `index` at — every renderer bakes through this, so their frame
 * sequences are identical. Looping spreads frames over [0, cycle) so the wrap back to frame 0 is
 * seamless (no duplicated endpoint); one-shot spreads over [0, cycle] INCLUSIVE so the last frame is
 * the completed state the clip then holds.
 */
export function graphicAnimationBakeTime(plan: GraphicAnimationPlan, index: number): number {
  const { naturalCycleSeconds, frameCount, loop } = plan;
  if (frameCount <= 1) return loop ? 0 : oneShotEndTime(naturalCycleSeconds);
  const clamped = Math.max(0, Math.min(frameCount - 1, index));
  if (loop) return (clamped / frameCount) * naturalCycleSeconds;
  return Math.min((clamped / (frameCount - 1)) * naturalCycleSeconds, oneShotEndTime(naturalCycleSeconds));
}

/**
 * Deep-link time for a one-shot's FINAL frame — a hair INSIDE the active interval, never exactly at its
 * end. Baking at exactly `begin + dur` is a boundary Chrome does not reliably freeze at: a
 * `fill="freeze"` draw-in rendered its BASE state there, i.e. a blank icon at the very frame the clip
 * then holds (caught by graphic:render). Just inside, the animation is still running at ~its final
 * value — which is the completed look for `fill="freeze"` AND for `fill="remove"` (which would revert
 * to base past the end by spec). 0.1% of the cycle is visually indistinguishable from complete.
 */
function oneShotEndTime(naturalCycleSeconds: number): number {
  return naturalCycleSeconds * (1 - 1e-3);
}

/**
 * Baked frame index for a phase (cycles). Looping wraps within the cycle; one-shot clamps to [0,1] so
 * it runs once and then HOLDS the completed frame.
 */
export function graphicAnimationFrameFromPhase(plan: GraphicAnimationPlan, phase: number): number {
  const { frameCount, loop } = plan;
  if (frameCount <= 1 || !Number.isFinite(phase)) return 0;
  // EPSILON before every floor: exact frame boundaries land a hair under in binary floating point
  // ((35/36)*1.2 → ratio*count = 34.99999999999999), which floored to the PREVIOUS frame and desynced
  // renderers that derive time from the index (Remotion) from those that bake by index.
  if (!loop) {
    const clamped = Math.max(0, Math.min(1, phase));
    return Math.min(frameCount - 1, Math.floor(clamped * (frameCount - 1) + 1e-9));
  }
  // Single modulo (only normalized when negative): the `((x % c) + c) % c` idiom re-rounds a positive
  // x and lost a bit — 0.6 % 1.2 came back 0.5999999999999999.
  let frac = phase % 1;
  if (frac < 0) frac += 1;
  return Math.min(frameCount - 1, Math.floor(frac * frameCount + 1e-9));
}

/**
 * Select the baked frame index for a CLIP-LOCAL time — the single source of truth every renderer calls.
 * Honors progress keyframes / a duration ramp / the static duration (see `graphicAnimationPhase`).
 */
export function graphicAnimationFrameAt(plan: GraphicAnimationPlan, localSeconds: number): number {
  return graphicAnimationFrameFromPhase(plan, graphicAnimationPhase(plan, localSeconds));
}
