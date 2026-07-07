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

import { useEffect, useRef, useState } from "react";

export type ScopeMode = "waveform" | "parade" | "vectorscope" | "histogram";

/**
 * Trustworthy frame source: returns a top-origin RGBA downsample of the final composited frame at
 * (about) the requested size, or null when the compositor output isn't available this frame.
 */
export type ScopeFrameSampler = (
  targetW: number,
  targetH: number
) => { data: Uint8ClampedArray; width: number; height: number } | null;

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
  /** While playing, sample at a coarser resolution to stay light; full detail when paused. */
  isPlaying?: boolean;
  mode?: ScopeMode;
}

// Paused = detailed grading feedback; playing = lighter. Both are Rec.709 SDR.
const SAMPLE_DETAIL = { w: 320, h: 180 } as const;
const SAMPLE_FAST = { w: 160, h: 90 } as const;
const SCOPE_H = 120;
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

/** Downsample any TexImageSource into an ImageData of the requested size (fallback path). */
function sampleFromElement(source: CanvasImageSource, w: number, h: number): Frame | null {
  try {
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext("2d")!;
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
  const ctx = canvas.getContext("2d")!;
  const w = canvas.width;
  const h = canvas.height;
  const { data, w: sw, h: sh } = frame;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "#0e0e10";
  ctx.fillRect(0, 0, w, h);
  drawLevelGrid(ctx, 0, w, h);

  const colW = w / sw;
  const channelColors = rgb
    ? (["rgba(255,80,80,0.55)", "rgba(80,255,80,0.55)", "rgba(80,140,255,0.55)"] as const)
    : (["rgba(200,200,200,0.65)"] as const);

  let clippedHi = 0;
  let clippedLo = 0;
  for (let col = 0; col < sw; col++) {
    for (let ch = 0; ch < channelColors.length; ch++) {
      ctx.fillStyle = channelColors[ch]!;
      for (let row = 0; row < sh; row++) {
        const idx = (row * sw + col) * 4;
        const val = rgb ? data[idx + ch]! : luma709(data[idx]!, data[idx + 1]!, data[idx + 2]!);
        if (val >= 255) clippedHi++;
        else if (val <= 0) clippedLo++;
        const y = Math.round(h - (val / 255) * h);
        ctx.fillRect(col * colW, y, Math.max(1, colW), 1);
      }
    }
  }
  drawClipMarkers(ctx, w, h, clippedLo, clippedHi, sw * sh * channelColors.length);
}

function drawParade(canvas: HTMLCanvasElement, frame: Frame) {
  const ctx = canvas.getContext("2d")!;
  const w = canvas.width;
  const h = canvas.height;
  const { data, w: sw, h: sh } = frame;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "#0e0e10";
  ctx.fillRect(0, 0, w, h);

  const gapW = 3;
  const thirdW = Math.floor((w - gapW * 2) / 3);
  const channels = [
    { ch: 0, color: "rgba(255,80,80,0.7)", label: "R" },
    { ch: 1, color: "rgba(80,220,80,0.7)", label: "G" },
    { ch: 2, color: "rgba(80,140,255,0.7)", label: "B" }
  ];

  for (let c = 0; c < 3; c++) {
    const { ch, color, label } = channels[c]!;
    const xOff = c * (thirdW + gapW);
    ctx.fillStyle = "rgba(255,255,255,0.04)";
    ctx.fillRect(xOff, 0, thirdW, h);
    drawLevelGrid(ctx, xOff, thirdW, h);

    const colW = thirdW / sw;
    ctx.fillStyle = color;
    for (let col = 0; col < sw; col++) {
      for (let row = 0; row < sh; row++) {
        const val = data[(row * sw + col) * 4 + ch]!;
        const y = Math.round(h - (val / 255) * h);
        ctx.fillRect(xOff + col * colW, y, Math.max(1, colW), 1);
      }
    }
    ctx.fillStyle = "rgba(255,255,255,0.5)";
    ctx.font = "9px monospace";
    ctx.fillText(label, xOff + 4, h - 4);
  }
}

function drawVectorscope(canvas: HTMLCanvasElement, frame: Frame) {
  const ctx = canvas.getContext("2d")!;
  const w = canvas.width;
  const h = canvas.height;
  const { data } = frame;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "#0a0a0d";
  ctx.fillRect(0, 0, w, h);

  const cx = w / 2;
  const cy = h / 2;
  const r = Math.min(cx, cy) * 0.88;

  ctx.strokeStyle = "rgba(255,255,255,0.12)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();

  ctx.strokeStyle = "rgba(255,255,255,0.07)";
  ctx.beginPath();
  ctx.moveTo(cx, cy - r);
  ctx.lineTo(cx, cy + r);
  ctx.moveTo(cx - r, cy);
  ctx.lineTo(cx + r, cy);
  ctx.stroke();

  // Skin-tone line at ~123° (the "I" line) — the standard skin reference.
  const skinAngle = (123 * Math.PI) / 180;
  ctx.strokeStyle = "rgba(255,200,100,0.45)";
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx + Math.cos(skinAngle) * r, cy - Math.sin(skinAngle) * r);
  ctx.stroke();

  // Rec.709 Cb/Cr from normalized RGB. Scale = 0.5/(1-Kb) for Cb, 0.5/(1-Kr) for Cr.
  const cbScale = 0.5 / (1 - REC709.kb);
  const crScale = 0.5 / (1 - REC709.kr);
  ctx.fillStyle = "rgba(160,220,160,0.35)";
  for (let i = 0; i < data.length; i += 4) {
    const ri = data[i]! / 255;
    const gi = data[i + 1]! / 255;
    const bi = data[i + 2]! / 255;
    const y = luma709(ri, gi, bi);
    const cb = cbScale * (bi - y);
    const cr = crScale * (ri - y);
    const px = cx + cb * r * 2;
    const py = cy - cr * r * 2;
    ctx.fillRect(px - 0.5, py - 0.5, 1.5, 1.5);
  }
}

function drawHistogram(canvas: HTMLCanvasElement, frame: Frame) {
  const ctx = canvas.getContext("2d")!;
  const w = canvas.width;
  const h = canvas.height;
  const { data } = frame;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "#0e0e10";
  ctx.fillRect(0, 0, w, h);

  // Legal-range vertical guides (16 / 235).
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

  const max = Math.max(...counts[0], ...counts[1], ...counts[2], 1);
  const chColors = ["rgba(255,80,80,0.55)", "rgba(80,220,80,0.55)", "rgba(80,140,255,0.55)"];
  for (let c = 0; c < 3; c++) {
    ctx.fillStyle = chColors[c]!;
    for (let v = 0; v < 256; v++) {
      const barH = (counts[c]![v]! / max) * h;
      const x = (v / 256) * w;
      const barW = Math.max(1, w / 256);
      ctx.fillRect(x, h - barH, barW, barH);
    }
  }
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

export function ColorScopes({ containerRef, sampleSource, tick, isPlaying, mode = "waveform" }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [activeMode, setActiveMode] = useState<ScopeMode>(mode);
  const [approx, setApprox] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dims = isPlaying ? SAMPLE_FAST : SAMPLE_DETAIL;

    // Prefer the trustworthy scene-compositor readback.
    let frame: Frame | null = null;
    let usedFallback = false;
    if (sampleSource) {
      const s = sampleSource(dims.w, dims.h);
      if (s) frame = { data: s.data, w: s.width, h: s.height };
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

    if (activeMode === "waveform") drawWaveform(canvas, frame, false);
    else if (activeMode === "parade") drawParade(canvas, frame);
    else if (activeMode === "vectorscope") drawVectorscope(canvas, frame);
    else if (activeMode === "histogram") drawHistogram(canvas, frame);
  }, [containerRef, sampleSource, tick, activeMode, isPlaying]);

  const modes: { id: ScopeMode; label: string }[] = [
    { id: "waveform", label: "Waveform" },
    { id: "parade", label: "Parade" },
    { id: "vectorscope", label: "Vector" },
    { id: "histogram", label: "Histogram" }
  ];

  return (
    <div className="color-scopes">
      <div className="color-scopes-tabs">
        {modes.map(({ id, label }) => (
          <button
            key={id}
            className={`color-scopes-tab${activeMode === id ? " color-scopes-tab--active" : ""}`}
            type="button"
            onClick={() => setActiveMode(id)}
          >
            {label}
          </button>
        ))}
      </div>
      <canvas
        ref={canvasRef}
        className="color-scopes-canvas"
        width={activeMode === "vectorscope" ? SCOPE_H : SCOPE_W}
        height={SCOPE_H}
        style={{ width: "100%", height: SCOPE_H, display: "block" }}
      />
      <div className="color-scopes-footer">
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
