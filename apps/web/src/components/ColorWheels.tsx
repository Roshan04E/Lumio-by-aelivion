import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Undo2 } from "lucide-react";
import type { ColorWheel, ColorWheels as ColorWheelsValue } from "@orreris/shared";

/**
 * Professional Color System (Phase 3, 13C.2) — the 3-way Color Wheels editor.
 * Shadows / Midtones / Highlights, each a circular color-balance pad (drag the dot
 * to push color toward a hue) plus a master luma slider. Maps to ASC-CDL in the
 * engine and bakes into the same per-channel LUT the curves use, so the preview
 * updates live and the export stays pixel-aligned. Emits live while dragging; one
 * undo step per gesture. Stores `ColorWheels` as JSON ("{}" = identity).
 */

type WheelKey = "shadows" | "midtones" | "highlights";

const WHEELS: { key: WheelKey; label: string }[] = [
  { key: "shadows", label: "Shadows" },
  { key: "midtones", label: "Midtones" },
  { key: "highlights", label: "Highlights" }
];

const NEUTRAL: ColorWheel = { x: 0, y: 0, master: 0 };

/**
 * Build the rim gradient from the SAME hue math the engine uses, so dragging toward a
 * displayed color pushes that color (not its complement). The engine tints by
 * `hue = atan2(y, x)` (x→right, y→up). A CSS conic angle φ (clockwise from top) points
 * at screen direction (x=sin φ, y=cos φ) → `hue = atan2(cos φ, sin φ) = 90° − φ`. So the
 * rim color at φ must be `hsv(90 − φ)`.
 */
function hsvCss(h: number, s: number, v: number): string {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let r = 0;
  let g = 0;
  let b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return `rgb(${Math.round((r + m) * 255)}, ${Math.round((g + m) * 255)}, ${Math.round((b + m) * 255)})`;
}

/**
 * Neutral film grain, tiled. Present for a functional reason, not a decorative one: CSS gradients
 * quantize badly across a large low-chroma dark field, and the banding rings that produces are the
 * loudest "this is a web gradient" artefact on the wheel. A few percent of monochrome noise dithers
 * them away — the same reason grading UIs look dense rather than posterized.
 */
const WHEEL_GRAIN = (() => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="90" height="90"><filter id="n"><feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" stitchTiles="stitch"/><feColorMatrix type="saturate" values="0"/></filter><rect width="90" height="90" filter="url(#n)" opacity="0.055"/></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
})();

/**
 * The trackball is composited from an explicit LAYER STACK, listed here top-most first (CSS paints
 * background layers in that order). Each layer has one job; the design lives in their interaction,
 * not in any single gradient.
 *
 *   1 GRAIN            dither, kills gradient banding (see WHEEL_GRAIN)
 *   2 AMBIENT          broad soft light from above — NOT a point specular
 *   3 RIM SEPARATOR    dark annulus dividing the colour field from the outer ring
 *   4 EDGE VIGNETTE    field darkening toward its own rim; gives the disc volume
 *   5 CHROMA SCRIM     saturation compression + luminance falloff (the important one)
 *   6 HUE SOURCE       one full-saturation conic — the field AND the ring both read from it
 *
 * The two decisions that separate an instrument from a colour picker:
 *
 * SATURATION IS COMPRESSED, AND RISES WITH THE SQUARE OF RADIUS. A picker shows the gamut, so it
 * runs full chroma everywhere. A balance control shows DEVIATION FROM NEUTRAL, so its field must be
 * near-neutral through the middle and gain chroma slowly — which is also what makes small corrections
 * readable, since the interesting range is near the centre. Layer 5's alpha follows ~r², so the field
 * never approaches full HSV; only the ring does.
 *
 * THE RING IS AN OBJECT, NOT A BRIGHTER EDGE. Layer 3 puts a dark gap between field and ring, so the
 * ring reads as a machined band AROUND the ball rather than the point where a gradient got vivid.
 * Without that gap there is no ring at all — just a hot edge.
 */
const WHEEL_BACKGROUND = (() => {
  // 96 stops. At full chroma the seams between conic stops are plainly visible, and this is the one
  // element in the panel a colorist actually stares at — the cost is a static string built once.
  const steps = 96;
  const stops: string[] = [];
  for (let i = 0; i <= steps; i += 1) {
    const phi = (i / steps) * 360;
    // Hue ORIENTATION is the engine's tint math, not a style choice — it is what makes dragging
    // toward a colour actually push that colour. Only the chroma/falloff below is cosmetic.
    const hue = (90 - phi + 360) % 360;
    stops.push(`${hsvCss(hue, 1, 1)} ${phi.toFixed(2)}deg`);
  }
  // ── 5 · CHROMA SCRIM ────────────────────────────────────────────────────────────────────────
  // A neutral scrim whose OPACITY is the saturation control. Alpha ≈ 1 − r² (hand-placed), so chroma
  // rises quadratically: the middle stays close to neutral and colour only asserts itself out near
  // the field edge. Grey, never black — fading chroma to black crushes it into a dark disc.
  // It clears completely at 90.5%, handing the last tenth of the radius to the ring at full strength.
  const SCRIM = "44, 48, 56";
  const scrim = [
    `rgba(${SCRIM}, 0.995) 0%`,
    `rgba(${SCRIM}, 0.99) 14%`,
    `rgba(${SCRIM}, 0.975) 26%`,
    `rgba(${SCRIM}, 0.95) 38%`,
    `rgba(${SCRIM}, 0.91) 48%`,
    `rgba(${SCRIM}, 0.85) 57%`,
    `rgba(${SCRIM}, 0.77) 65%`,
    `rgba(${SCRIM}, 0.66) 72%`,
    `rgba(${SCRIM}, 0.52) 79%`,
    `rgba(${SCRIM}, 0.34) 85%`,
    `rgba(${SCRIM}, 0.12) 89%`,
    `rgba(${SCRIM}, 0) 90.5%`,
  ].join(", ");

  // ── 4 · EDGE VIGNETTE ───────────────────────────────────────────────────────────────────────
  // Darkens the field toward its own edge so the disc reads as having volume. Stops before the ring:
  // the ring must remain the brightest thing on the control.
  const vignette = [
    "transparent 0 52%",
    "rgba(9, 10, 13, 0.18) 70%",
    "rgba(9, 10, 13, 0.42) 82%",
    "rgba(9, 10, 13, 0.5) 86%",
    "transparent 89%",
  ].join(", ");

  // ── 3 · RIM SEPARATOR ───────────────────────────────────────────────────────────────────────
  // The dark gap that turns a bright edge into a RING. This is the single layer that most decides
  // whether the control reads as machined hardware or as a gradient that got vivid.
  const separator = [
    "transparent 0 86.5%",
    "rgba(6, 7, 9, 0.72) 88.5%",
    "rgba(6, 7, 9, 0.8) 90%",
    "transparent 91.5%",
  ].join(", ");

  // ── 2 · AMBIENT ─────────────────────────────────────────────────────────────────────────────
  // Broad soft light from above. Deliberately NOT a point specular: a highlight reads as a glossy
  // sphere, and every reference tool renders these as flat, recessed discs.
  const ambient = "radial-gradient(120% 95% at 50% -12%, rgba(255, 255, 255, 0.055), rgba(255, 255, 255, 0.016) 45%, transparent 72%)";

  return [
    `${WHEEL_GRAIN} 0 0 / 90px 90px repeat`,
    ambient,
    `radial-gradient(circle at center, ${separator})`,
    `radial-gradient(circle at center, ${vignette})`,
    `radial-gradient(circle at center, ${scrim})`,
    `conic-gradient(from 0deg, ${stops.join(", ")})`,
  ].join(", ");
})();

function neutralWheels(): ColorWheelsValue {
  return { shadows: { ...NEUTRAL }, midtones: { ...NEUTRAL }, highlights: { ...NEUTRAL } };
}

function parseWheels(value: string): ColorWheelsValue {
  const base = neutralWheels();
  if (!value || value.trim() === "" || value.trim() === "{}") return base;
  try {
    const raw = JSON.parse(value) as Partial<Record<WheelKey, Partial<ColorWheel>>>;
    for (const { key } of WHEELS) {
      const w = raw[key];
      if (w) base[key] = { x: num(w.x), y: num(w.y), master: num(w.master) };
    }
  } catch {
    /* identity */
  }
  return base;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function wheelNeutral(w: ColorWheel): boolean {
  return w.x === 0 && w.y === 0 && w.master === 0;
}

function serialize(wheels: ColorWheelsValue): string {
  return wheelNeutral(wheels.shadows) && wheelNeutral(wheels.midtones) && wheelNeutral(wheels.highlights)
    ? "{}"
    : JSON.stringify(wheels);
}

function clampDisk(x: number, y: number): { x: number; y: number } {
  const m = Math.hypot(x, y);
  return m > 1 ? { x: x / m, y: y / m } : { x, y };
}

export function ColorWheels({ value, onChange }: { value: string; onChange: (json: string) => void }) {
  const [wheels, setWheels] = useState<ColorWheelsValue>(() => parseWheels(value));
  const [history, setHistory] = useState<ColorWheelsValue[]>([]);
  const draggingRef = useRef(false);

  useEffect(() => {
    if (!draggingRef.current) setWheels(parseWheels(value));
  }, [value]);

  const emit = useCallback((next: ColorWheelsValue) => {
    setWheels(next);
    onChange(serialize(next));
  }, [onChange]);

  const pushHistory = useCallback(() => setHistory((h) => [...h, wheels]), [wheels]);

  const undo = useCallback(() => {
    if (history.length === 0) return;
    const prev = history[history.length - 1]!;
    setHistory(history.slice(0, -1));
    setWheels(prev);
    onChange(serialize(prev));
  }, [history, onChange]);

  const setWheel = (key: WheelKey, patch: Partial<ColorWheel>) => emit({ ...wheels, [key]: { ...wheels[key], ...patch } });

  return (
    <div className="graph-editor color-wheels">
      <div className="curve-editor-toolbar">
        <span className="color-wheels-title">Color Wheels</span>
        <button
          type="button"
          className="curve-editor-undo"
          onClick={undo}
          disabled={history.length === 0}
          title="Undo last wheel change"
        >
          <Undo2 size={13} />
        </button>
      </div>
      <div className="color-wheels-row">
        {WHEELS.map(({ key, label }) => (
          <Wheel
            key={key}
            label={label}
            wheel={wheels[key]}
            edited={!wheelNeutral(wheels[key])}
            onStart={() => {
              draggingRef.current = true;
              pushHistory();
            }}
            onEnd={() => {
              draggingRef.current = false;
            }}
            onBalance={(x, y) => setWheel(key, { x, y })}
            onMaster={(master) => setWheel(key, { master })}
            onMasterCommit={pushHistory}
            onReset={() => {
              pushHistory();
              setWheel(key, { x: 0, y: 0, master: 0 });
            }}
          />
        ))}
      </div>
    </div>
  );
}

function Wheel({
  label,
  wheel,
  edited,
  onStart,
  onEnd,
  onBalance,
  onMaster,
  onMasterCommit,
  onReset
}: {
  label: string;
  wheel: ColorWheel;
  edited: boolean;
  onStart: () => void;
  onEnd: () => void;
  onBalance: (x: number, y: number) => void;
  onMaster: (master: number) => void;
  onMasterCommit: () => void;
  onReset: () => void;
}) {
  const padRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);

  const balanceFromEvent = (event: { clientX: number; clientY: number }) => {
    const rect = padRef.current?.getBoundingClientRect();
    if (!rect) return;
    const r = rect.width / 2;
    const x = (event.clientX - rect.left - r) / r;
    const y = (r - (event.clientY - rect.top)) / r; // y up
    const c = clampDisk(x, y);
    onBalance(Number(c.x.toFixed(4)), Number(c.y.toFixed(4)));
  };

  const handleDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    draggingRef.current = true;
    onStart();
    balanceFromEvent(event);
  };
  const handleMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    balanceFromEvent(event);
  };
  const handleUp = () => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    onEnd();
  };

  const handleLeft = `${50 + wheel.x * 50}%`;
  const handleTop = `${50 - wheel.y * 50}%`;

  // Column order is LABEL → WHEEL → SLIDER: the name titles the control it belongs to instead of
  // floating between a wheel and the slider under it, which is what made three columns read as one
  // undifferentiated block. The wheel is the visual anchor between them.
  return (
    <div className="color-wheel">
      <span className="color-wheel-label">{label}</span>
      <div
        ref={padRef}
        className={`color-wheel-pad ${edited ? "is-edited" : ""}`}
        style={{ background: WHEEL_BACKGROUND }}
        onPointerDown={handleDown}
        onPointerMove={handleMove}
        onPointerUp={handleUp}
        onPointerCancel={handleUp}
        onDoubleClick={onReset}
        title={`${label} color balance — drag to push color; double-click to reset`}
      >
        <span className="color-wheel-handle" style={{ left: handleLeft, top: handleTop }} />
      </div>
      <input
        className="color-wheel-master"
        type="range"
        min={-1}
        max={1}
        step={0.01}
        value={wheel.master}
        onPointerDown={onMasterCommit}
        onChange={(event) => onMaster(Number(event.target.value))}
        title={`${label} level`}
      />
    </div>
  );
}
