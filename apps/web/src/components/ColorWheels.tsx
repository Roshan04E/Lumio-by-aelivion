import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Undo2 } from "lucide-react";
import type { ColorWheel, ColorWheels as ColorWheelsValue } from "@kimera-by-aelivion/shared";

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

const WHEEL_BACKGROUND = (() => {
  const steps = 24;
  const stops: string[] = [];
  for (let i = 0; i <= steps; i += 1) {
    const phi = (i / steps) * 360;
    const hue = (90 - phi + 360) % 360;
    stops.push(`${hsvCss(hue, 0.55, 0.82)} ${phi.toFixed(1)}deg`);
  }
  // Desaturated hue ring fading to a neutral center (matches the engine's tint hue).
  return `radial-gradient(circle at center, #26272c 0%, rgba(38, 39, 44, 0.92) 26%, rgba(38, 39, 44, 0) 70%), conic-gradient(from 0deg, ${stops.join(", ")})`;
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

  return (
    <div className="color-wheel">
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
      <span className="color-wheel-label">{label}</span>
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
