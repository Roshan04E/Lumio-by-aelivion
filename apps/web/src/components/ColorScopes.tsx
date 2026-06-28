/**
 * Professional Color System (Phase 3, 13C.5) — Color Scopes (editor-only).
 *
 * Four scope views sourced from a `<canvas>` or `<video>` element screenshot:
 *   - Waveform: luma (Y) per horizontal column
 *   - RGB Parade: R / G / B waveforms side by side
 *   - Vectorscope: Cb/Cr dot plot with skin-tone line at ~123°
 *   - Histogram: RGBA channel distribution
 *
 * The source frame is sampled via `OffscreenCanvas.getContext("2d").drawImage()` so
 * it works with any TexImageSource. A 160×90 downsample is enough for accurate scopes
 * at 60 fps. The component re-samples every time `sourceRef` or `tick` changes.
 */

import { useEffect, useRef, useState } from "react";

export type ScopeMode = "waveform" | "parade" | "vectorscope" | "histogram";

interface Props {
  /**
   * A ref to a container element. ColorScopes will search inside it for the first
   * `<video>` or `<canvas>` element to use as the scope source. Pass the phone-frame
   * div ref from VideoPreview via the `frameRef` prop.
   */
  containerRef: React.RefObject<HTMLElement | null>;
  /** Increment to trigger a re-sample (tie to frame tick / playback). */
  tick?: number;
  mode?: ScopeMode;
}

const SAMPLE_W = 160;
const SAMPLE_H = 90;
const SCOPE_H = 120;
const PARADE_COLORS = ["#ff4444", "#44ff44", "#4488ff"] as const;

function sampleFrame(source: HTMLVideoElement | HTMLCanvasElement | HTMLImageElement): ImageData | null {
  try {
    const canvas = new OffscreenCanvas(SAMPLE_W, SAMPLE_H);
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(source as CanvasImageSource, 0, 0, SAMPLE_W, SAMPLE_H);
    return ctx.getImageData(0, 0, SAMPLE_W, SAMPLE_H);
  } catch {
    return null;
  }
}

function drawWaveform(canvas: HTMLCanvasElement, pixels: Uint8ClampedArray, rgb: boolean) {
  const ctx = canvas.getContext("2d")!;
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "#0e0e10";
  ctx.fillRect(0, 0, w, h);

  // Grid lines at 0, 25, 50, 75, 100 IRE
  ctx.strokeStyle = "rgba(255,255,255,0.08)";
  ctx.lineWidth = 1;
  for (let pct = 0; pct <= 100; pct += 25) {
    const y = Math.round(h - (pct / 100) * h) + 0.5;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }

  const colW = w / SAMPLE_W;
  const channelColors = rgb
    ? (["rgba(255,80,80,0.6)", "rgba(80,255,80,0.6)", "rgba(80,140,255,0.6)"] as const)
    : (["rgba(200,200,200,0.7)"] as const);

  for (let col = 0; col < SAMPLE_W; col++) {
    for (let ch = 0; ch < channelColors.length; ch++) {
      ctx.fillStyle = channelColors[ch]!;
      for (let row = 0; row < SAMPLE_H; row++) {
        const idx = (row * SAMPLE_W + col) * 4;
        const val = rgb ? pixels[idx + ch]! : (0.2126 * pixels[idx]! + 0.7152 * pixels[idx + 1]! + 0.0722 * pixels[idx + 2]!);
        const y = Math.round(h - (val / 255) * h);
        ctx.fillRect(col * colW, y, Math.max(1, colW), 1);
      }
    }
  }
}

function drawParade(canvas: HTMLCanvasElement, pixels: Uint8ClampedArray) {
  const ctx = canvas.getContext("2d")!;
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "#0e0e10";
  ctx.fillRect(0, 0, w, h);

  const thirdW = Math.floor(w / 3);
  const gapW = 3;
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

    const colW = thirdW / SAMPLE_W;
    ctx.fillStyle = color;
    for (let col = 0; col < SAMPLE_W; col++) {
      for (let row = 0; row < SAMPLE_H; row++) {
        const idx = (row * SAMPLE_W + col) * 4;
        const val = pixels[idx + ch]!;
        const y = Math.round(h - (val / 255) * h);
        ctx.fillRect(xOff + col * colW, y, Math.max(1, colW), 1);
      }
    }

    ctx.fillStyle = "rgba(255,255,255,0.5)";
    ctx.font = "9px monospace";
    ctx.fillText(label, xOff + 4, h - 4);
  }
}

function drawVectorscope(canvas: HTMLCanvasElement, pixels: Uint8ClampedArray) {
  const ctx = canvas.getContext("2d")!;
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "#0a0a0d";
  ctx.fillRect(0, 0, w, h);

  const cx = w / 2;
  const cy = h / 2;
  const r = Math.min(cx, cy) * 0.88;

  // Outer ring
  ctx.strokeStyle = "rgba(255,255,255,0.12)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();

  // Cross-hairs
  ctx.strokeStyle = "rgba(255,255,255,0.07)";
  ctx.beginPath();
  ctx.moveTo(cx, cy - r);
  ctx.lineTo(cx, cy + r);
  ctx.moveTo(cx - r, cy);
  ctx.lineTo(cx + r, cy);
  ctx.stroke();

  // Skin-tone line at 123° from positive X (Cb/Cr plane)
  const skinAngle = (123 * Math.PI) / 180;
  ctx.strokeStyle = "rgba(255,200,100,0.45)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx + Math.cos(skinAngle) * r, cy - Math.sin(skinAngle) * r);
  ctx.stroke();

  // Dots
  ctx.fillStyle = "rgba(160,220,160,0.35)";
  for (let i = 0; i < pixels.length; i += 4) {
    const ri = pixels[i]! / 255;
    const gi = pixels[i + 1]! / 255;
    const bi = pixels[i + 2]! / 255;
    // BT.601 Cb/Cr
    const cb = -0.16874 * ri - 0.33126 * gi + 0.5 * bi;
    const cr = 0.5 * ri - 0.41869 * gi - 0.08131 * bi;
    const px = cx + cb * r * 2;
    const py = cy - cr * r * 2;
    ctx.fillRect(px - 0.5, py - 0.5, 1.5, 1.5);
  }
}

function drawHistogram(canvas: HTMLCanvasElement, pixels: Uint8ClampedArray) {
  const ctx = canvas.getContext("2d")!;
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "#0e0e10";
  ctx.fillRect(0, 0, w, h);

  const counts: [number[], number[], number[]] = [new Array(256).fill(0), new Array(256).fill(0), new Array(256).fill(0)];
  for (let i = 0; i < pixels.length; i += 4) {
    counts[0][pixels[i]!]! += 1;
    counts[1][pixels[i + 1]!]! += 1;
    counts[2][pixels[i + 2]!]! += 1;
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

export function ColorScopes({ containerRef, tick, mode = "waveform" }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [activeMode, setActiveMode] = useState<ScopeMode>(mode);

  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;

    // Prefer WebGL canvas (graded output) then video then any canvas
    const source =
      (container.querySelector("canvas") as HTMLCanvasElement | null) ??
      (container.querySelector("video") as HTMLVideoElement | null);
    if (!source) return;

    const imageData = sampleFrame(source);
    if (!imageData) return;
    const { data } = imageData;

    if (activeMode === "waveform") drawWaveform(canvas, data, false);
    else if (activeMode === "parade") drawParade(canvas, data);
    else if (activeMode === "vectorscope") drawVectorscope(canvas, data);
    else if (activeMode === "histogram") drawHistogram(canvas, data);
  }, [containerRef, tick, activeMode]);

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
        width={activeMode === "vectorscope" ? SCOPE_H : 320}
        height={SCOPE_H}
        style={{ width: "100%", height: SCOPE_H, display: "block" }}
      />
    </div>
  );
}
