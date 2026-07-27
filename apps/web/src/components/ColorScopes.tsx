/**
 * Professional Color System (Phase 3, 13C.5 → managed color) — Color Scopes (editor-only).
 *
 * Four scope views of the composited preview frame:
 *   - Waveform: luma (Rec.709 Y) per horizontal column
 *   - RGB Parade: R / G / B waveforms side by side
 *   - Vectorscope: Cb/Cr dot plot (Rec.709) with the skin-tone line at ~123°
 *   - Histogram: R/G/B distribution
 *
 * **Trust:** the scopes prefer an explicit readback of the final scene compositor output
 * (`sampleSource`, backed by `SceneCompositor.readCompositeThumbnail` — the retained composite,
 * not the fragile `querySelector("canvas")` DOM-order guess). When the scene compositor isn't
 * available (DOM fallback path), they fall back to sampling the first `<canvas>`/`<video>` in the
 * preview container and flag themselves **approx**. All math is Rec.709 SDR; legal-range guides
 * (limited 16–235) and clipping markers are drawn so grading decisions are trustworthy.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Columns2, LayoutGrid, Rows3, Square } from "lucide-react";

export type ScopeMode = "waveform" | "parade" | "vectorscope" | "histogram";

/**
 * View arrangements (user request 2026-07-21): `single` = one scope + mode tabs (the classic view),
 * `two` = a chosen pair side by side (wraps to rows in narrow hosts), `grid` = all four in a 2×2,
 * `column` = all four stacked top-to-bottom (the tall left-panel "maximum productivity" view).
 */
export type ScopeLayout = "single" | "two" | "grid" | "column";

/**
 * A frame source for the scopes: a top-origin RGBA downsample of the composited frame, or null when
 * the compositor output is not available this instant.
 *
 * `label` names WHAT was measured — "Output", or the Flarex node / soloed clip the viewer is showing.
 * It is returned per-sample rather than passed as a prop because the sampler is what knows: the scopes
 * measure whatever the viewer is currently rooted at, and a footer naming something else would be a
 * measurement instrument lying about its own source.
 */
export type ScopeFrameSampler = (
  targetW: number,
  targetH: number
) => {
  data: Uint8ClampedArray;
  width: number;
  height: number;
  label?: string;
} | null;

interface Props {
  /**
   * Fallback source: a ref to a container searched for the first `<video>`/`<canvas>`. Used only
   * when `sampleSource` is absent or returns null (DOM preview path); flagged "approx".
   */
  containerRef: React.RefObject<HTMLElement | null>;
  /** Preferred trustworthy source — the scene compositor's retained-composite readback. */
  sampleSource?: ScopeFrameSampler | undefined;
  /** Increment to trigger a re-sample (tie to frame tick / playback). */
  tick?: number;
  /**
   * Any value whose IDENTITY changes when the picture might have changed for a reason other than
   * time — a grade edit, an effect toggle, a layer change. Hosts pass the composition object itself.
   *
   * This exists because `tick` is derived from the playhead, so while paused nothing re-sampled when
   * a colorist moved a colour wheel: the scopes sat on the frame from the last seek. Scopes that only
   * update when the playhead moves cannot be used to grade, which is the one job they have.
   *
   * It cannot be handled by simply re-sampling on the React update, either. The compositor redraws
   * ASYNCHRONOUSLY and keeps compositing for a settle window (~600ms) after any change, so a sample
   * taken during the render that observed the edit reads the PREVIOUS retained composite. That is
   * why the change opens a short watch window instead (see the effect below).
   */
  changeKey?: unknown;
  /** While playing, sample at a coarser resolution to stay light; full detail when paused. */
  isPlaying?: boolean;
  mode?: ScopeMode;
  /** Persistence namespace — each host (drawer / left panel / inspector) remembers its own view. */
  storageKey?: string | undefined;
  defaultLayout?: ScopeLayout | undefined;
  /** Hide the layout switcher (compact hosts that fix a single layout). */
  showLayoutPicker?: boolean | undefined;
  /** Optional extra header control (e.g. the inspector's "open in left panel" button). */
  headerAction?: ReactNode;
}

// Paused = detailed grading feedback; playing = lighter. Both are Rec.709 SDR. Higher than before so
// the accumulation buffers have real population (broadcast scopes need density to read as intensity).
const SAMPLE_DETAIL = { w: 480, h: 270 } as const;
const SAMPLE_FAST = { w: 240, h: 135 } as const;
const SCOPE_H = 200;
const SCOPE_W = 320;

// Rec.709 limited-range digital code values (8-bit): black 16, white 235.
const LEGAL_BLACK = 16;
const LEGAL_WHITE = 235;

const REC709 = { kr: 0.2126, kg: 0.7152, kb: 0.0722 } as const;
function luma709(r: number, g: number, b: number): number {
  return REC709.kr * r + REC709.kg * g + REC709.kb * b;
}

interface Frame {
  data: Uint8ClampedArray;
  w: number;
  h: number;
}

/**
 * Every scope draw ends in `paintAccum`, which reads the canvas back with `getImageData` to add the
 * trace over the graticule it just drew. Without this hint Chrome keeps the surface GPU-resident and
 * each readback pulls it back across the bus — it says so unprompted ("Multiple readback operations
 * using getImageData are faster with the willReadFrequently attribute set to true"). Up to four panes
 * redraw per sample, so the hint has to be on the FIRST getContext for a canvas: later calls with
 * different attributes return the already-configured context and are silently ignored.
 */
function scope2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  return canvas.getContext("2d", { willReadFrequently: true })!;
}

/**
 * Broadcast scopes read TRACE DENSITY as brightness: where many source pixels land on the same graph
 * cell, the trace glows. These helpers accumulate a per-cell hit count into a Float buffer, then map
 * density → brightness with a perceptual curve (√), the way a real WFM/vectorscope's phosphor/graph
 * looks — instead of the old flat 1px-per-sample plot that saturated instantly and hid distribution.
 */
type Accum = { r: Float32Array; g: Float32Array; b: Float32Array; w: number; h: number };
function makeAccum(w: number, h: number): Accum {
  return { r: new Float32Array(w * h), g: new Float32Array(w * h), b: new Float32Array(w * h), w, h };
}
/** Additively splat one hit (with fractional-y anti-aliasing) into a channel buffer. */
function splat(buf: Float32Array, w: number, h: number, x: number, yf: number, amount = 1): void {
  if (x < 0 || x >= w) return;
  const y0 = Math.floor(yf);
  const frac = yf - y0;
  if (y0 >= 0 && y0 < h) buf[y0 * w + x]! += amount * (1 - frac);
  const y1 = y0 + 1;
  if (y1 >= 0 && y1 < h) buf[y1 * w + x]! += amount * frac;
}
/**
 * Composite the accumulated RGB density buffers onto the canvas as additive glow. `gain` scales the
 * √-density; a per-frame auto-normalize keeps the trace readable regardless of sample count/zoom.
 */
function paintAccum(ctx: CanvasRenderingContext2D, accum: Accum, gain: number): void {
  const { r, g, b, w, h } = accum;
  const n = w * h;
  let peak = 0;
  for (let i = 0; i < n; i++) {
    if (r[i]! > peak) peak = r[i]!;
    if (g[i]! > peak) peak = g[i]!;
    if (b[i]! > peak) peak = b[i]!;
  }
  if (peak <= 0) return;
  const norm = 1 / Math.sqrt(peak);
  const img = ctx.getImageData(0, 0, w, h);
  const px = img.data;
  for (let i = 0; i < n; i++) {
    const rv = Math.min(255, Math.sqrt(r[i]!) * norm * gain * 255);
    const gv = Math.min(255, Math.sqrt(g[i]!) * norm * gain * 255);
    const bv = Math.min(255, Math.sqrt(b[i]!) * norm * gain * 255);
    if (rv || gv || bv) {
      const o = i * 4;
      // Additive over the existing graticule/background already on the canvas.
      px[o]! = Math.min(255, px[o]! + rv);
      px[o + 1]! = Math.min(255, px[o + 1]! + gv);
      px[o + 2]! = Math.min(255, px[o + 2]! + bv);
      px[o + 3]! = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}

/** Downsample any TexImageSource into an ImageData of the requested size (fallback path). */
function sampleFromElement(source: CanvasImageSource, w: number, h: number): Frame | null {
  try {
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    ctx.drawImage(source, 0, 0, w, h);
    const img = ctx.getImageData(0, 0, w, h);
    return { data: img.data, w, h };
  } catch {
    return null;
  }
}

/** Draw the horizontal legal/mid grid + optional IRE labels shared by waveform/parade. */
function drawLevelGrid(ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D, x0: number, w: number, h: number) {
  ctx.strokeStyle = "rgba(255,255,255,0.07)";
  ctx.lineWidth = 1;
  for (let pct = 0; pct <= 100; pct += 25) {
    const y = Math.round(h - (pct / 100) * h) + 0.5;
    ctx.beginPath();
    ctx.moveTo(x0, y);
    ctx.lineTo(x0 + w, y);
    ctx.stroke();
  }
  // Legal-range guides (limited 16/235) — dashed amber so out-of-legal excursions are obvious.
  ctx.strokeStyle = "rgba(255,190,90,0.35)";
  ctx.setLineDash([3, 3]);
  for (const level of [LEGAL_BLACK, LEGAL_WHITE]) {
    const y = Math.round(h - (level / 255) * h) + 0.5;
    ctx.beginPath();
    ctx.moveTo(x0, y);
    ctx.lineTo(x0 + w, y);
    ctx.stroke();
  }
  ctx.setLineDash([]);
}

function drawWaveform(canvas: HTMLCanvasElement, frame: Frame, rgb: boolean) {
  const ctx = scope2d(canvas);
  const w = canvas.width;
  const h = canvas.height;
  const { data, w: sw, h: sh } = frame;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "#0b0b0d";
  ctx.fillRect(0, 0, w, h);
  drawLevelGrid(ctx, 0, w, h);

  const accum = makeAccum(w, h);
  let clippedHi = 0;
  let clippedLo = 0;
  for (let col = 0; col < sw; col++) {
    const x = Math.min(w - 1, Math.floor((col / sw) * w));
    for (let row = 0; row < sh; row++) {
      const idx = (row * sw + col) * 4;
      const r = data[idx]!;
      const g = data[idx + 1]!;
      const b = data[idx + 2]!;
      if (rgb) {
        splat(accum.r, w, h, x, (1 - r / 255) * (h - 1));
        splat(accum.g, w, h, x, (1 - g / 255) * (h - 1));
        splat(accum.b, w, h, x, (1 - b / 255) * (h - 1));
        if (r >= 255 || g >= 255 || b >= 255) clippedHi++;
        else if (r <= 0 && g <= 0 && b <= 0) clippedLo++;
      } else {
        const val = luma709(r, g, b);
        const yf = (1 - val / 255) * (h - 1);
        // Luma trace as a soft green-white (broadcast WFM convention).
        splat(accum.r, w, h, x, yf, 0.75);
        splat(accum.g, w, h, x, yf, 1);
        splat(accum.b, w, h, x, yf, 0.75);
        if (val >= 254) clippedHi++;
        else if (val <= 1) clippedLo++;
      }
    }
  }
  paintAccum(ctx, accum, rgb ? 1.4 : 1.6);
  drawClipMarkers(ctx, w, h, clippedLo, clippedHi, sw * sh);
}

function drawParade(canvas: HTMLCanvasElement, frame: Frame) {
  const ctx = scope2d(canvas);
  const w = canvas.width;
  const h = canvas.height;
  const { data, w: sw, h: sh } = frame;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "#0b0b0d";
  ctx.fillRect(0, 0, w, h);

  const gapW = 4;
  const thirdW = Math.floor((w - gapW * 2) / 3);
  for (let c = 0; c < 3; c++) {
    const xOff = c * (thirdW + gapW);
    ctx.fillStyle = "rgba(255,255,255,0.03)";
    ctx.fillRect(xOff, 0, thirdW, h);
    drawLevelGrid(ctx, xOff, thirdW, h);
  }

  // One accumulation buffer; each channel splats into its own third at its own colour.
  const accum = makeAccum(w, h);
  for (let c = 0; c < 3; c++) {
    const xOff = c * (thirdW + gapW);
    const buf = c === 0 ? accum.r : c === 1 ? accum.g : accum.b;
    for (let col = 0; col < sw; col++) {
      const x = xOff + Math.min(thirdW - 1, Math.floor((col / sw) * thirdW));
      for (let row = 0; row < sh; row++) {
        const val = data[(row * sw + col) * 4 + c]!;
        splat(buf, w, h, x, (1 - val / 255) * (h - 1));
      }
    }
  }
  paintAccum(ctx, accum, 1.5);

  ctx.fillStyle = "rgba(255,255,255,0.55)";
  ctx.font = "9px monospace";
  for (let c = 0; c < 3; c++) ctx.fillText("RGB"[c]!, c * (thirdW + gapW) + 4, h - 4);
}

// 75%-bar vectorscope targets: angle (deg, measured like the graticule) + radius fraction of full.
// Angles/radii are the standard Rec.709 75% colour-bar positions.
const VECTOR_TARGETS: { label: string; angleDeg: number; radius: number; color: string }[] = [
  { label: "R", angleDeg: 103.5, radius: 0.63, color: "rgba(255,90,90,0.9)" },
  { label: "Mg", angleDeg: 61, radius: 0.59, color: "rgba(255,90,255,0.9)" },
  { label: "B", angleDeg: 192, radius: 0.63, color: "rgba(90,140,255,0.9)" },
  { label: "Cy", angleDeg: 283.5, radius: 0.63, color: "rgba(90,230,255,0.9)" },
  { label: "G", angleDeg: 241, radius: 0.59, color: "rgba(90,255,90,0.9)" },
  { label: "Yl", angleDeg: 13, radius: 0.63, color: "rgba(255,235,90,0.9)" }
];

function drawVectorscope(canvas: HTMLCanvasElement, frame: Frame) {
  const ctx = scope2d(canvas);
  const w = canvas.width;
  const h = canvas.height;
  const { data } = frame;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "#08080b";
  ctx.fillRect(0, 0, w, h);

  const cx = w / 2;
  const cy = h / 2;
  const r = Math.min(cx, cy) * 0.9;

  // Graticule rings + cross.
  ctx.strokeStyle = "rgba(255,255,255,0.14)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.strokeStyle = "rgba(255,255,255,0.06)";
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.5, 0, Math.PI * 2);
  ctx.moveTo(cx, cy - r);
  ctx.lineTo(cx, cy + r);
  ctx.moveTo(cx - r, cy);
  ctx.lineTo(cx + r, cy);
  ctx.stroke();

  // 75% colour target boxes + labels.
  ctx.font = "8px monospace";
  for (const t of VECTOR_TARGETS) {
    const a = (t.angleDeg * Math.PI) / 180;
    const tx = cx + Math.cos(a) * r * t.radius;
    const ty = cy - Math.sin(a) * r * t.radius;
    ctx.strokeStyle = t.color;
    ctx.lineWidth = 1;
    ctx.strokeRect(tx - 4, ty - 4, 8, 8);
    ctx.fillStyle = t.color;
    ctx.fillText(t.label, tx + 6, ty + 3);
  }

  // Skin-tone line at ~123° (the "I" line) — the standard skin reference.
  const skinAngle = (123 * Math.PI) / 180;
  ctx.strokeStyle = "rgba(255,200,100,0.4)";
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx + Math.cos(skinAngle) * r, cy - Math.sin(skinAngle) * r);
  ctx.stroke();

  // Accumulate Cb/Cr density, coloured by the pixel's own hue, painted additively.
  const cbScale = 0.5 / (1 - REC709.kb);
  const crScale = 0.5 / (1 - REC709.kr);
  const accum = makeAccum(w, h);
  for (let i = 0; i < data.length; i += 4) {
    const ri = data[i]! / 255;
    const gi = data[i + 1]! / 255;
    const bi = data[i + 2]! / 255;
    const y = luma709(ri, gi, bi);
    const cb = cbScale * (bi - y);
    const cr = crScale * (ri - y);
    const px = Math.round(cx + cb * r * 2);
    const py = Math.round(cy - cr * r * 2);
    if (px < 0 || px >= w || py < 0 || py >= h) continue;
    const o = py * w + px;
    accum.r[o]! += ri;
    accum.g[o]! += gi;
    accum.b[o]! += bi;
  }
  paintAccum(ctx, accum, 2.2);
}

function drawHistogram(canvas: HTMLCanvasElement, frame: Frame) {
  const ctx = scope2d(canvas);
  const w = canvas.width;
  const h = canvas.height;
  const { data } = frame;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "#0b0b0d";
  ctx.fillRect(0, 0, w, h);

  // Legal-range vertical guides (16 / 235) + quarter grid.
  ctx.strokeStyle = "rgba(255,255,255,0.05)";
  for (let q = 1; q < 4; q++) {
    const x = Math.round((q / 4) * w) + 0.5;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
  }
  ctx.strokeStyle = "rgba(255,190,90,0.3)";
  ctx.setLineDash([3, 3]);
  for (const level of [LEGAL_BLACK, LEGAL_WHITE]) {
    const x = Math.round((level / 256) * w) + 0.5;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
  }
  ctx.setLineDash([]);

  const counts: [number[], number[], number[]] = [new Array(256).fill(0), new Array(256).fill(0), new Array(256).fill(0)];
  for (let i = 0; i < data.length; i += 4) {
    counts[0][data[i]!]! += 1;
    counts[1][data[i + 1]!]! += 1;
    counts[2][data[i + 2]!]! += 1;
  }

  // √-scale so small populations (shadow/highlight detail) are visible, like Lightroom/Resolve.
  const max = Math.sqrt(Math.max(...counts[0], ...counts[1], ...counts[2], 1));
  const chColors = ["rgba(255,70,70,0.75)", "rgba(70,220,70,0.75)", "rgba(70,140,255,0.75)"];
  ctx.globalCompositeOperation = "lighter"; // additive so overlaps read as white (neutral)
  for (let c = 0; c < 3; c++) {
    ctx.fillStyle = chColors[c]!;
    ctx.beginPath();
    ctx.moveTo(0, h);
    for (let v = 0; v < 256; v++) {
      const barH = (Math.sqrt(counts[c]![v]!) / max) * h;
      const x = (v / 256) * w;
      ctx.lineTo(x, h - barH);
    }
    ctx.lineTo(w, h);
    ctx.closePath();
    ctx.fill();
  }
  ctx.globalCompositeOperation = "source-over";
}

/** Corner markers when a meaningful fraction of samples clip to 0 or 255. */
function drawClipMarkers(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  lo: number,
  hi: number,
  total: number
) {
  const thresh = total * 0.002; // >0.2% of samples at the rail
  ctx.font = "9px monospace";
  if (hi > thresh) {
    ctx.fillStyle = "rgba(255,90,90,0.9)";
    ctx.fillText("▲ clip", w - 40, 11);
  }
  if (lo > thresh) {
    ctx.fillStyle = "rgba(120,160,255,0.9)";
    ctx.fillText("▼ crush", 4, h - 12);
  }
}

/** While playing the scopes re-sample themselves at this cadence (see the live-loop effect below). */
const PLAYING_RESAMPLE_MS = 100;

/**
 * PAUSED EDIT WATCH. On a `changeKey` identity change the picture is not ready yet — the compositor
 * redraws asynchronously and keeps compositing for its settle window. So a change opens a watch:
 * re-sample at this cadence for this long, then stop dead.
 *
 * Deliberately a bounded window rather than a permanent paused poll: idle scopes must cost nothing,
 * and a continuous drag simply keeps re-opening the window, which yields live feedback for exactly as
 * long as the user is actually changing something. The duration tracks ScenePreviewCanvas's
 * SCENE_SETTLE_MS (600ms) with margin — it has to outlast the compositor's own settle or the last
 * sample lands before the final frame and the scopes end up one edit stale.
 */
const EDIT_RESAMPLE_MS = 90;
const EDIT_WATCH_MS = 800;

const SCOPE_LABELS: Record<ScopeMode, string> = {
  waveform: "Waveform",
  parade: "Parade",
  vectorscope: "Vector",
  histogram: "Histogram"
};
const ALL_MODES: ScopeMode[] = ["waveform", "parade", "vectorscope", "histogram"];

function drawScope(canvas: HTMLCanvasElement, frame: Frame, mode: ScopeMode): void {
  if (mode === "waveform") drawWaveform(canvas, frame, false);
  else if (mode === "parade") drawParade(canvas, frame);
  else if (mode === "vectorscope") drawVectorscope(canvas, frame);
  else drawHistogram(canvas, frame);
}

function loadStored<T extends string>(key: string, valid: readonly T[], fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    return raw != null && (valid as readonly string[]).includes(raw) ? (raw as T) : fallback;
  } catch {
    return fallback;
  }
}
function store(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* private mode — view just won't persist */
  }
}

/**
 * One scope canvas. Sizing: the backing store tracks the pane's laid-out size (capped so the
 * per-draw getImageData/putImageData stays cheap) instead of a fixed 320×200 box. The graticules
 * all draw relative to canvas w/h, and the vectorscope centers its circle on min(cx, cy), so any
 * aspect stays correct. Redraws when the shared frame version bumps (parent samples ONCE per tick
 * for every pane), on mode change, and on resize.
 */
function ScopePane({
  mode,
  frameRef,
  frameVersion,
  onChangeMode,
  showLabel = true
}: {
  mode: ScopeMode;
  frameRef: React.RefObject<Frame | null>;
  frameVersion: number;
  /** Present → the pane header shows a mode select (the "two" layout's chooser). */
  onChangeMode?: ((mode: ScopeMode) => void) | undefined;
  /** False in the single layout — the header tabs already name the scope. */
  showLabel?: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ w: number; h: number }>({ w: SCOPE_W, h: SCOPE_H });

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (!rect || rect.width <= 0 || rect.height <= 0) return;
      const w = Math.max(160, Math.min(1280, Math.floor(rect.width)));
      const h = Math.max(120, Math.min(480, Math.floor(rect.height)));
      setSize((current) => (current.w === w && current.h === h ? current : { w, h }));
    });
    observer.observe(wrap);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const frame = frameRef.current;
    if (!canvas || !frame) return;
    drawScope(canvas, frame, mode);
  }, [frameRef, frameVersion, mode, size]);

  return (
    <div className="color-scopes-pane">
      {onChangeMode ? (
        <select
          className="color-scopes-pane-select"
          aria-label="Scope type"
          value={mode}
          onChange={(event) => onChangeMode(event.target.value as ScopeMode)}
        >
          {ALL_MODES.map((id) => (
            <option key={id} value={id}>
              {SCOPE_LABELS[id]}
            </option>
          ))}
        </select>
      ) : showLabel ? (
        <span className="color-scopes-pane-label">{SCOPE_LABELS[mode]}</span>
      ) : null}
      <div ref={wrapRef} className="color-scopes-canvas-wrap">
        <canvas
          ref={canvasRef}
          className="color-scopes-canvas"
          width={size.w}
          height={size.h}
          style={{ width: "100%", height: "100%", display: "block" }}
        />
      </div>
    </div>
  );
}

const LAYOUTS: { id: ScopeLayout; title: string; icon: ReactNode }[] = [
  { id: "single", title: "Single scope", icon: <Square size={12} /> },
  { id: "two", title: "Two scopes", icon: <Columns2 size={12} /> },
  { id: "grid", title: "All scopes — grid", icon: <LayoutGrid size={12} /> },
  { id: "column", title: "All scopes — stacked", icon: <Rows3 size={12} /> }
];

export function ColorScopes({
  containerRef,
  sampleSource,
  tick,
  changeKey,
  isPlaying,
  mode = "waveform",
  storageKey = "default",
  defaultLayout = "single",
  showLayoutPicker = true,
  headerAction
}: Props) {
  const [layout, setLayout] = useState<ScopeLayout>(() =>
    loadStored(`orreris.scopes.${storageKey}.layout`, ["single", "two", "grid", "column"], defaultLayout)
  );
  const [activeMode, setActiveMode] = useState<ScopeMode>(() =>
    loadStored(`orreris.scopes.${storageKey}.mode`, ALL_MODES, mode)
  );
  const [secondMode, setSecondMode] = useState<ScopeMode>(() =>
    loadStored(`orreris.scopes.${storageKey}.mode2`, ALL_MODES, "vectorscope")
  );
  const [approx, setApprox] = useState(false);
  /** What the last sample actually measured, straight from the sampler — never inferred. */
  const [source, setSource] = useState<string | null>(null);
  // Shared frame: sampled ONCE per tick and drawn by every pane (1–4 canvases).
  const frameRef = useRef<Frame | null>(null);
  const [frameVersion, setFrameVersion] = useState(0);
  /**
   * When the last sample ran, across effect re-runs — the rate floor for the immediate sample below.
   * A ref, not state, precisely because observing it must not itself cause a render.
   */
  const lastSampleAtRef = useRef(0);

  /** Deadline the paused watch runs to; each change EXTENDS it rather than restarting a timer. */
  const watchUntilRef = useRef(0);
  const watchTimerRef = useRef<number | null>(null);

  const sample = useCallback(() => {
    lastSampleAtRef.current = Date.now();
    const dims = isPlaying ? SAMPLE_FAST : SAMPLE_DETAIL;

    // Prefer the trustworthy scene-compositor readback.
    let frame: Frame | null = null;
    let usedFallback = false;
    if (sampleSource) {
      const s = sampleSource(dims.w, dims.h);
      if (s) {
        frame = { data: s.data, w: s.width, h: s.height };
        setSource(s.label ?? null);
      }
    }
    if (!frame) {
      const container = containerRef.current;
      const el =
        (container?.querySelector("canvas") as HTMLCanvasElement | null) ??
        (container?.querySelector("video") as HTMLVideoElement | null);
      if (el) {
        frame = sampleFromElement(el as CanvasImageSource, dims.w, dims.h);
        usedFallback = true;
      }
    }
    setApprox(usedFallback);
    if (!frame) return;
    frameRef.current = frame;
    setFrameVersion((version) => version + 1);
  }, [containerRef, sampleSource, isPlaying]);

  // The watch timer below outlives the effect run that created it, so it must not close over that
  // run's `sample`. Reading the latest through a ref keeps it correct if the sampler is ever
  // reidentified mid-watch, without making the timer's lifetime depend on the sampler's.
  const sampleRef = useRef(sample);
  useEffect(() => {
    sampleRef.current = sample;
  }, [sample]);

  useEffect(() => {
    if (isPlaying) {
      // Playback owns the cadence from here; retire any paused watch still counting down, or the two
      // loops would sample concurrently at different resolutions.
      if (watchTimerRef.current !== null) window.clearInterval(watchTimerRef.current);
      watchTimerRef.current = null;
      // LIVE loop: the cold playhead clock (our `tick` prop) is deliberately SUSPENDED during
      // playback so the heavy cold panels never compete with playback smoothness — which froze the
      // scopes on the pre-play frame. Instead of un-suspending that clock (doctrine: don't), the
      // scopes drive their own low-rate resample here, at the coarse SAMPLE_FAST resolution.
      sample();
      const interval = window.setInterval(sample, PLAYING_RESAMPLE_MS);
      return () => window.clearInterval(interval);
    }

    // PAUSED EDIT WATCH — see EDIT_WATCH_MS. `changeKey` is in this effect's deps, so a grade edit
    // re-runs it and pushes the deadline out; the watch keeps sampling across the compositor's settle
    // window so the graded result actually lands in the scopes. It stops on its own, so an idle paused
    // editor runs no loop at all.
    //
    // The timer is deliberately NOT owned by this effect. A drag changes `changeKey` every tick, and an
    // effect-owned interval was therefore torn down and recreated faster than its own 90ms period — it
    // could never fire, and the loop only worked because the effect ALSO sampled unconditionally on
    // every tick. That is the expensive shape: a sample is a GPU readback plus, for each open pane, a
    // full-frame accumulation and a getImageData/putImageData round trip, so the sample rate was pinned
    // to the event rate at exactly the moment the user needs the main thread free. Extending a deadline
    // that one long-lived timer reads keeps the cadence at a steady 90ms no matter how fast the ticks
    // arrive; the immediate sample below is then only for a discrete edit landing after a quiet period.
    watchUntilRef.current = Date.now() + EDIT_WATCH_MS;
    if (Date.now() - lastSampleAtRef.current >= EDIT_RESAMPLE_MS) sample();
    if (watchTimerRef.current === null) {
      watchTimerRef.current = window.setInterval(() => {
        if (Date.now() >= watchUntilRef.current) {
          if (watchTimerRef.current !== null) window.clearInterval(watchTimerRef.current);
          watchTimerRef.current = null;
          return;
        }
        sampleRef.current();
      }, EDIT_RESAMPLE_MS);
    }
    return undefined;
  }, [tick, isPlaying, changeKey, sample]);

  // The watch timer outlives individual effect runs by design, so unmount is the one place that must
  // stop it — otherwise it keeps sampling a torn-down component's compositor.
  useEffect(
    () => () => {
      if (watchTimerRef.current !== null) window.clearInterval(watchTimerRef.current);
      watchTimerRef.current = null;
    },
    []
  );

  const selectLayout = (next: ScopeLayout) => {
    setLayout(next);
    store(`orreris.scopes.${storageKey}.layout`, next);
  };
  const selectMode = (next: ScopeMode) => {
    setActiveMode(next);
    store(`orreris.scopes.${storageKey}.mode`, next);
  };
  const selectSecondMode = (next: ScopeMode) => {
    setSecondMode(next);
    store(`orreris.scopes.${storageKey}.mode2`, next);
  };

  return (
    <div className="color-scopes" data-layout={layout}>
      <div className="color-scopes-head">
        {layout === "single" ? (
          <div className="color-scopes-tabs">
            {ALL_MODES.map((id) => (
              <button
                key={id}
                className={`color-scopes-tab${activeMode === id ? " color-scopes-tab--active" : ""}`}
                type="button"
                onClick={() => selectMode(id)}
              >
                {SCOPE_LABELS[id]}
              </button>
            ))}
          </div>
        ) : (
          <span className="color-scopes-head-title">Scopes</span>
        )}
        {showLayoutPicker ? (
          <div className="color-scopes-layouts" role="group" aria-label="Scope layout">
            {LAYOUTS.map(({ id, title, icon }) => (
              <button
                key={id}
                type="button"
                title={title}
                aria-label={title}
                aria-pressed={layout === id}
                className={`color-scopes-layout${layout === id ? " color-scopes-layout--active" : ""}`}
                onClick={() => selectLayout(id)}
              >
                {icon}
              </button>
            ))}
          </div>
        ) : null}
        {headerAction}
      </div>
      <div className="color-scopes-panes">
        {layout === "single" ? (
          <ScopePane mode={activeMode} frameRef={frameRef} frameVersion={frameVersion} showLabel={false} />
        ) : layout === "two" ? (
          <>
            <ScopePane mode={activeMode} frameRef={frameRef} frameVersion={frameVersion} onChangeMode={selectMode} />
            <ScopePane mode={secondMode} frameRef={frameRef} frameVersion={frameVersion} onChangeMode={selectSecondMode} />
          </>
        ) : (
          ALL_MODES.map((id) => <ScopePane key={id} mode={id} frameRef={frameRef} frameVersion={frameVersion} />)
        )}
      </div>
      <div className="color-scopes-footer">
        {/* WHAT IS BEING MEASURED, always stated. Scopes that isolate a node look identical to scopes
            reading the programme output — the numbers are the whole content — so the source has to be
            on screen or the reading is unattributable. Marked when an isolated source declined and
            this is output instead (it declines during playback by design). */}
        {source ? (
          <span className="color-scopes-source" title={`Measuring ${source}`}>
            {source}
          </span>
        ) : null}
        <span className="color-scopes-label">Rec.709 SDR</span>
        {approx ? (
          <span className="color-scopes-approx" title="Sampling the DOM preview element, not the scene compositor output — values are approximate.">
            approx
          </span>
        ) : null}
      </div>
    </div>
  );
}
