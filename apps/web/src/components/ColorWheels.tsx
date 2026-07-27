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
function hsvRgb(h: number, s: number, v: number): [number, number, number] {
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
  return [r + m, g + m, b + m];
}

function hsvCss(h: number, s: number, v: number): string {
  const [r, g, b] = hsvRgb(h, s, v);
  return `rgb(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)})`;
}

/**
 * LUMINANCE NORMALISATION — why the ring is not a raw HSV sweep.
 *
 * Full-value HSV hues differ in Rec.709 luma by more than 12:1 (yellow 0.928, blue 0.072). Painted
 * at constant `v` the ring therefore has a glaring yellow arc and a nearly black blue arc, and that
 * uneven brightness is one of the strongest "this is an HSV colour picker" signals there is — a
 * manufactured band would not vary in brightness around its circumference. Reference wheels read as
 * an object precisely because their perceived brightness is roughly constant around the ring.
 *
 * Full flattening is impossible in sRGB (nothing can make blue as bright as yellow without
 * desaturating it, and desaturating is what produced the pastel look before), so this COMPRESSES
 * rather than equalises: v is scaled by (target / luma)^k. With k = 0.35 the 12.8:1 luma spread
 * closes to about 2.4:1 — enough that the ring reads as one band, not enough to grey any hue out.
 * The floor stops the brightest hues from being pushed so dark they lose chroma.
 *
 * This changes only how a hue is PAINTED. The angle→hue map (`90 − φ`) is untouched, so what a drag
 * at a given angle does to the image is exactly as before.
 */
const HUE_LUMA_TARGET = 0.45;
const HUE_LUMA_K = 0.35;
const HUE_VALUE_FLOOR = 0.62;

function hueValueScale(h: number): number {
  const [r, g, b] = hsvRgb(h, 1, 1);
  const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return Math.min(1, Math.max(HUE_VALUE_FLOOR, (HUE_LUMA_TARGET / luma) ** HUE_LUMA_K));
}

/**
 * Neutral film grain, tiled. Present for a functional reason, not a decorative one: CSS gradients
 * quantize badly across a large low-chroma dark field, and the banding rings that produces are the
 * loudest "this is a web gradient" artefact on the wheel. A few percent of monochrome noise dithers
 * them away — the same reason grading UIs look dense rather than posterized.
 *
 * It is confined to the FIELD INTERIOR (see WHEEL_GRAIN_MASK) rather than run across the whole disc.
 * Noise is a constant-amplitude signal, so its visibility is set by what it sits on: at 5.5% it
 * vanishes into the mid-tone centre it exists to dither, but against the near-black groove it is the
 * highest-contrast thing there and reads as a ragged, speckled edge around the ball. Dither belongs
 * only where there is banding to dither.
 */
const WHEEL_GRAIN = (() => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="90" height="90"><filter id="n"><feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" stitchTiles="stitch"/><feColorMatrix type="saturate" values="0"/></filter><rect width="90" height="90" filter="url(#n)" opacity="0.055"/></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
})();

/**
 * GEOMETRY — one source of truth, in fractions of the disc RADIUS.
 *
 * Every earlier attempt at the ring failed for the same mechanical reason, and it is worth stating
 * plainly so it is not reintroduced: a bare `radial-gradient(circle at center, …)` on a SQUARE
 * element sizes itself FARTHEST-CORNER, so its 100% is r·√2, not r. Structure authored at "86%" and
 * "90.4%" was therefore being painted at 1.22r and 1.28r — outside the disc entirely. The groove,
 * the rim shade and the whole ring rendered nowhere, which is why making the ring more vivid never
 * helped: it was not dim, it was absent. Every gradient here is `closest-side`, which makes 100%
 * exactly the disc radius and makes these numbers mean what they say.
 *
 * The field's groove and the ring element's mask are both generated from these constants, so the two
 * halves of the seam cannot drift apart the way hand-copied percentages did.
 */
const GEO = {
  /** Chroma scrim is fully gone by here: beyond it the field is at its own full strength. */
  scrimClear: 0.76,
  /** Field falls off slightly toward the ring. LATE and SHALLOW, and that is the load-bearing part.
   *
   *  There is NO dark groove between field and ring. The design originally had one, on the reasoning
   *  that a ring needs a parting line or it is just the place a gradient got brighter — but at the
   *  size this actually ships at (~42px radius on a 1080p panel) any dark separator, however thin, is
   *  a sub-pixel black circle. It cannot resolve as a machined seam; it resolves as a ragged dark
   *  halo, and it reads as noise. Removed on that evidence.
   *
   *  What separates the two parts instead is the LUMINANCE STEP alone: the field arrives at ~0.58
   *  value and the ring starts at full value, across a hard mask edge. A discontinuity in brightness
   *  is a parting line — it does not have to be dark to be a line. This falloff exists only to make
   *  that step consistent around the circumference, not to draw a band. */
  vignetteIn: 0.82,
  /** Ring band runs from here to the disc edge (~12% of the radius ≈ 5px at the shipped size). */
  ringIn: 0.876
} as const;

const pct = (t: number) => `${(t * 100).toFixed(2)}%`;

/**
 * Hue conic. 128 stops — at full chroma the seams between fewer are plainly visible, and this is the
 * element a colorist actually stares at. `scale` applies the luminance normalisation above; the field
 * passes a reduced `v` on top of it.
 *
 * Hue ORIENTATION (`90 − φ`) is the engine's tint math, NOT a style choice: it is what makes dragging
 * toward a colour actually push that colour into the image. Matching another application's wheel
 * orientation would require changing the engine's mapping, i.e. changing what a drag does.
 */
function hueConic(s: number, v: number, normalise = true): string {
  const steps = 128;
  const stops: string[] = [];
  for (let i = 0; i <= steps; i += 1) {
    const phi = (i / steps) * 360;
    const hue = (90 - phi + 360) % 360;
    const value = normalise ? v * hueValueScale(hue) : v;
    stops.push(`${hsvCss(hue, s, value)} ${phi.toFixed(2)}deg`);
  }
  return `conic-gradient(from 0deg, ${stops.join(", ")})`;
}

/**
 * THE COLOUR RING — a manufactured collar, not a brighter edge.
 *
 * Two layers, top-most first. A flat band of hue reads as PRINTED; a band shaded across its own
 * WIDTH reads as a physical part with a curved surface. That is the difference between the reference
 * tools' rings and a conic-gradient border.
 *
 *   1 SEAT     Darkens the collar's OUTER edge only, where it meets the bezel — the far side of a
 *              rounded band turning away from the light. There is deliberately nothing on the inner
 *              edge: a dark inner stop is a black circle drawn between the ring and the field, which
 *              at this size cannot resolve and reads as a ragged halo (same finding as the groove,
 *              see GEO.vignetteIn). The inner edge is defined by the luminance step alone.
 *   2 HUE      Full chroma, luminance-normalised (see hueValueScale).
 *
 * There is deliberately NO vertical light key on the ring, though the housing has one. A directional
 * gradient across a circular band brightens one arc and darkens the opposite one, and since a band's
 * apparent thickness is set by its contrast against the bezel, that makes the collar look THICKER at
 * the bottom than at the top — measurably concentric, visibly not. Hue-dependent luminance amplifies
 * it further. Constant apparent thickness is the whole point of a machined collar, so the shading
 * here follows the ring's own geometry only. The light-from-above cue lives on the housing, which is
 * a wide annulus where it reads correctly, and on the puck.
 */
export const WHEEL_RING = [
  `radial-gradient(circle closest-side at center,
     rgba(0,0,0,0) 0 96%,
     rgba(0,0,0,0.42) 100%)`.replace(/\s+/g, " "),
  hueConic(1, 1)
].join(", ");

/** Mask for the ring element — generated from the SAME constant the field's falloff ends on. */
export const WHEEL_RING_MASK =
  `radial-gradient(circle closest-side at center, transparent 0 ${pct(GEO.ringIn - 0.008)}, #000 ${pct(GEO.ringIn)}, #000 100%)`;

/** Grain is faded out well before the vignette darkens, so it never lands on the near-black rim. */
export const WHEEL_GRAIN_MASK =
  `radial-gradient(circle closest-side at center, #000 0 ${pct(GEO.vignetteIn - 0.16)}, transparent ${pct(GEO.vignetteIn + 0.02)})`;

/**
 * THE FIELD — the disc inside the ring. Layers, top-most first. Each exists for one reason:
 *
 *   1 VIGNETTE   A slight falloff toward the rim, so the field meets the ring at a consistent value
 *                and the luminance step that separates them is even around the circumference.
 *   2 SCRIM      Neutral toward the centre: chroma rises with the SQUARE of radius, so small
 *                corrections near neutral stay readable and the wheel reads as deviation-from-
 *                neutral, not as a gamut. A picker shows the gamut; a balance control does not.
 *   3 HUE        Conic at REDUCED VALUE — dark but saturated (deep red, deep green). Dark-and-
 *                saturated is a LOW-VALUE conic; greying a bright conic down desaturates it while
 *                leaving it bright, which is pastel — a colour picker.
 *
 * Grain is NOT in this stack — it is a separate masked element, for the reason given at WHEEL_GRAIN.
 */
const WHEEL_BACKGROUND = (() => {
  // 4 · SCRIM — alpha ∝ 1 − (t/clear)², sampled rather than hand-placed so the curve is the stated
  // function and not a list of tuned numbers.
  const SCRIM = "34, 37, 44";
  const scrimStops: string[] = [];
  for (let i = 0; i <= 14; i += 1) {
    const t = (i / 14) * GEO.scrimClear;
    const a = 0.94 * (1 - (t / GEO.scrimClear) ** 2);
    scrimStops.push(`rgba(${SCRIM}, ${a.toFixed(3)}) ${pct(t)}`);
  }
  scrimStops.push(`rgba(${SCRIM}, 0) ${pct(GEO.scrimClear)}`);

  // 3 · VIGNETTE — smoothstep from vignetteIn to the groove.
  const vigStops: string[] = [];
  for (let i = 0; i <= 8; i += 1) {
    const u = i / 8;
    const t = GEO.vignetteIn + u * (GEO.ringIn - GEO.vignetteIn);
    const a = 0.3 * (u * u * (3 - 2 * u));
    vigStops.push(`rgba(6, 7, 10, ${a.toFixed(3)}) ${pct(t)}`);
  }

  return [
    `radial-gradient(circle closest-side at center, ${vigStops.join(", ")})`,
    `radial-gradient(circle closest-side at center, ${scrimStops.join(", ")})`,
    hueConic(1, 0.58)
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

  // Column order is LABEL → WHEEL → SLIDER → READOUT: the name titles the control it belongs to
  // instead of floating between a wheel and the slider under it, and the value closes the column.
  // The wheel is the visual anchor between them.
  return (
    <div className="color-wheel">
      <span className="color-wheel-label">
        {label}
        {/* MODIFIED indicator. A hard 3px tick against the label, replacing the accent halo that used
            to be drawn around the whole disc: a glowing ring around a control is a web focus-state
            idiom, and it also put a saturated colour directly against the chroma ring — the one
            element on this control whose colour has to be trusted. */}
        <i className={`color-wheel-mod ${edited ? "is-on" : ""}`} aria-hidden="true" />
      </span>
      {/* HOUSING — a separate part, not a box-shadow. The bezel has to be lit DIRECTIONALLY (dark
          where the recess wall faces the light, bright where it faces away) and a box-shadow ring is
          uniform by construction, so the old one read as a flat dark donut. It is inert to pointers
          and the pad still owns its own box, so the drag math is untouched. */}
      <div className="color-wheel-housing">
        <div
          ref={padRef}
          className="color-wheel-pad"
          style={{ background: WHEEL_BACKGROUND }}
          onPointerDown={handleDown}
          onPointerMove={handleMove}
          onPointerUp={handleUp}
          onPointerCancel={handleUp}
          onDoubleClick={onReset}
          title={`${label} color balance — drag to push color; double-click to reset`}
        >
          {/* Dither, confined to the field interior — see WHEEL_GRAIN. */}
          <span
            className="color-wheel-grain"
            style={{
              backgroundImage: WHEEL_GRAIN,
              WebkitMaskImage: WHEEL_GRAIN_MASK,
              maskImage: WHEEL_GRAIN_MASK
            }}
          />
          {/* The vivid outer ring, on its own element so it can carry FULL value while the field
              stays dark and saturated (see WHEEL_RING). Masked to the outer band from the same
              constant the field's groove uses; inert to pointers. */}
          <span
            className="color-wheel-ring"
            style={{ background: WHEEL_RING, WebkitMaskImage: WHEEL_RING_MASK, maskImage: WHEEL_RING_MASK }}
          />
          <span className="color-wheel-handle" style={{ left: handleLeft, top: handleTop }} />
        </div>
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
      {/* Engraved readout. Display-only — it adds no interaction, but every reference application
          shows a number under every grading control, and a wheel with no value on it cannot be used
          to match a shot. Tabular figures with a fixed sign column so the digits do not shuffle as
          the value crosses zero. */}
      <span className={`color-wheel-readout ${wheel.master !== 0 ? "is-on" : ""}`}>
        {(wheel.master < 0 ? "−" : "+") + Math.abs(wheel.master).toFixed(2)}
      </span>
    </div>
  );
}
