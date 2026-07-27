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
/**
 * Hue conic at a given saturation/value. 96 stops — at full chroma the seams between fewer are
 * plainly visible, and this is the element a colorist actually stares at. Built once per variant.
 *
 * Hue ORIENTATION (`90 − φ`) is the engine's tint math, NOT a style choice: it is what makes dragging
 * toward a colour actually push that colour into the image. Matching another application's wheel
 * orientation would require changing the engine's mapping, i.e. changing what a drag does.
 */
function hueConic(s: number, v: number): string {
  const steps = 96;
  const stops: string[] = [];
  for (let i = 0; i <= steps; i += 1) {
    const phi = (i / steps) * 360;
    const hue = (90 - phi + 360) % 360;
    stops.push(`${hsvCss(hue, s, v)} ${phi.toFixed(2)}deg`);
  }
  return `conic-gradient(from 0deg, ${stops.join(", ")})`;
}

/**
 * OUTER RING — full brightness, full saturation. Rendered on its own element (masked to the outer
 * band) rather than as a background layer of the field, because the ring and the field need
 * DIFFERENT hsv values and one conic cannot be both. That was the structural error behind every
 * earlier attempt: scrimming a single bright conic desaturates it but leaves it BRIGHT, which is
 * exactly the pastel colour-picker look. The reference has a dark saturated field with a separate
 * vivid ring.
 */
export const WHEEL_RING = hueConic(1, 1);

/**
 * THE FIELD — the disc inside the ring. Layers, top-most first. Each exists for one reason:
 *
 *   1 GRAIN      Dither. CSS gradients quantize across a large dark low-chroma area and the banding
 *                rings that produces are the loudest "web gradient" artefact on the control.
 *   2 GAP        A dark groove at the field's edge. Without a break, a ring is just the place a
 *                gradient got brighter; with one, it is an object sitting around the disc.
 *   3 RIM SHADE  Darkens the field's outer fifth. The ring reads as a ring because of the LUMINANCE
 *                STEP at its inner edge — so the field must arrive at the gap DARK. Without this the
 *                field was already bright by the time it met the ring and the step was invisible,
 *                which is why the ring kept failing to register no matter how vivid it was made.
 *   4 SCRIM      Neutral toward the centre: chroma rises with radius, so small corrections near
 *                neutral stay readable and the wheel reads as deviation-from-neutral, not as a gamut.
 *   5 HUE        Conic at REDUCED VALUE — dark but saturated (deep red, deep green). This is the
 *                structural point: dark-and-saturated is a low-value conic. Greying down a bright
 *                conic desaturates it while leaving it bright, which is pastel — a colour picker.
 *
 * The ring is a SEPARATE element at full value (see WHEEL_RING); one conic cannot be both.
 */
const WHEEL_BACKGROUND = (() => {
  const SCRIM = "42, 45, 52";
  const scrim = [
    `rgba(${SCRIM}, 0.9) 0%`,
    `rgba(${SCRIM}, 0.84) 12%`,
    `rgba(${SCRIM}, 0.72) 24%`,
    `rgba(${SCRIM}, 0.58) 37%`,
    `rgba(${SCRIM}, 0.43) 50%`,
    `rgba(${SCRIM}, 0.29) 63%`,
    `rgba(${SCRIM}, 0.17) 75%`,
    `rgba(${SCRIM}, 0.08) 85%`,
    `rgba(${SCRIM}, 0) 92%`,
  ].join(", ");

  // 3 · RIM SHADE — the luminance step the ring is read against.
  const rimShade = [
    "transparent 0 62%",
    "rgba(8, 9, 12, 0.16) 76%",
    "rgba(8, 9, 12, 0.4) 86%",
    "rgba(8, 9, 12, 0.46) 89%",
    "transparent 91.5%",
  ].join(", ");

  // 2 · GAP — the groove, immediately inside where the ring element begins.
  const gap = [
    "transparent 0 87.5%",
    "rgba(5, 6, 8, 0.88) 89.2%",
    "rgba(5, 6, 8, 0.88) 90.4%",
    "transparent 91.5%",
  ].join(", ");

  return [
    `${WHEEL_GRAIN} 0 0 / 90px 90px repeat`,
    `radial-gradient(circle at center, ${gap})`,
    `radial-gradient(circle at center, ${rimShade})`,
    `radial-gradient(circle at center, ${scrim})`,
    hueConic(0.95, 0.62),
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
        {/* The vivid outer ring, on its own element so it can carry FULL value while the field stays
            dark and saturated (see WHEEL_RING). Masked to the outer band; inert to pointers, so it
            changes nothing about how the pad is dragged. */}
        <span className="color-wheel-ring" style={{ background: WHEEL_RING }} />
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
