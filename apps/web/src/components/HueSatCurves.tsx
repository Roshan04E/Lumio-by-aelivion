import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Pipette, RotateCcw, Spline, Undo2 } from "lucide-react";
import { sampleHueSatCurve, type CurvePoint } from "@orreris/shared";

/**
 * Professional Color System (Phase 3, 13C.3) — Lumetri Hue/Sat curve editor.
 *
 * Premiere-style VERTICAL layout: all five graphs are stacked and editable at once (no tabs).
 * **Neutral is the flat center line (y = 0.5)**, not the tone-curve diagonal. Drag a point up
 * to push, down to pull. Hue-domain curves wrap (the 0/1 seam is continuous).
 *
 * The curve itself is domain-colored (no axis strip below to get hidden behind low points):
 * every drawn segment's color is computed from the SAME transfer the renderer bakes into the
 * 3D LUT (`sampleHueSatCurve` + the gain/shift mapping), so dragging a point shows the actual
 * applied result — pulling Hue▸Sat down desaturates the line there, Hue▸Hue shows the OUTPUT
 * hue, Hue▸Luma darkens/brightens, etc. What you see is what renders.
 *
 * Each graph also has a color picker: choosing a color drops a control point (with flanking
 * baseline anchors) at that color's position on the graph's domain — the fast way to target
 * "this sky blue" without hunting along the axis.
 *
 * Clicking an empty stretch drops a point plus two baseline anchors so the adjustment is LOCAL
 * (a bump), the way Lumetri behaves. Stores `HueSatCurves` JSON ("{}" = identity). WebGL only.
 */

type CurveKey = "hueVsSat" | "hueVsHue" | "hueVsLuma" | "lumaVsSat" | "satVsSat";
type Domain = "hue" | "luma" | "sat";

const CURVES: { key: CurveKey; label: string; domain: Domain; periodic: boolean; hint: string }[] = [
  { key: "hueVsSat", label: "Hue vs Sat", domain: "hue", periodic: true, hint: "saturate / desaturate a hue range" },
  { key: "hueVsHue", label: "Hue vs Hue", domain: "hue", periodic: true, hint: "shift one hue toward another" },
  { key: "hueVsLuma", label: "Hue vs Luma", domain: "hue", periodic: true, hint: "brighten / darken a hue range" },
  { key: "lumaVsSat", label: "Luma vs Sat", domain: "luma", periodic: false, hint: "saturation by brightness" },
  { key: "satVsSat", label: "Sat vs Sat", domain: "sat", periodic: false, hint: "remap saturation itself" }
];

const VIEW_W = 1000;
const VIEW_H = 380; // wide graphs, Premiere-like
const HIT_RADIUS = 0.03;
const SMOOTH_FACTOR = 0.22;
const ANCHOR_SPREAD = 0.16; // how far the auto-seeded baseline anchors sit from a new point
const CURVE_STEPS = 96;
/** Mirrors the renderer's gain(): y → 2^((y−0.5)·4) — used for honest visual feedback. */
const gainOf = (y: number): number => Math.pow(2, (y - 0.5) * 4);
/** Mirrors HUE_SHIFT_RANGE in hsl.ts: full deflection = ±half a turn. */
const HUE_SHIFT_RANGE = 1.0;

type Curves = Record<CurveKey, CurvePoint[]>;

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
function wrap01(v: number): number {
  const r = v - Math.floor(v);
  return r < 0 ? r + 1 : r;
}
function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function emptyCurves(): Curves {
  return { hueVsSat: [], hueVsHue: [], hueVsLuma: [], lumaVsSat: [], satVsSat: [] };
}

function isFlat(points: CurvePoint[]): boolean {
  return points.every((p) => Math.abs(p.y - 0.5) < 1e-4);
}

function parseCurves(value: string): Curves {
  const base = emptyCurves();
  if (!value || value.trim() === "" || value.trim() === "{}") return base;
  try {
    const raw = JSON.parse(value) as Partial<Record<CurveKey, CurvePoint[]>>;
    for (const { key } of CURVES) {
      const pts = raw[key];
      if (Array.isArray(pts)) {
        base[key] = pts.map((p) => ({ x: clamp01(p.x), y: clamp01(p.y) })).sort((a, b) => a.x - b.x);
      }
    }
  } catch {
    /* identity */
  }
  return base;
}

function serialize(curves: Curves): string {
  const out: Partial<Curves> = {};
  for (const { key } of CURVES) {
    if (curves[key].length > 0 && !isFlat(curves[key])) out[key] = curves[key];
  }
  return Object.keys(out).length ? JSON.stringify(out) : "{}";
}

/**
 * Stroke color for one curve segment at domain position `x` with curve value `y` — the LIVE
 * visual feedback: the color is what the adjustment DOES at that x, using the same gain/shift
 * mapping the renderer applies.
 */
function segmentColor(key: CurveKey, x: number, y: number): string {
  const g = gainOf(y);
  if (key === "hueVsSat") {
    // Neutral shows the hue at healthy saturation; cutting drains it to gray, boosting caps vivid.
    const sat = clamp(78 * Math.min(g, 1) + (g > 1 ? 22 * Math.min(1, (g - 1) / 3) : 0), 0, 100);
    return `hsl(${Math.round(x * 360)} ${sat.toFixed(0)}% 55%)`;
  }
  if (key === "hueVsHue") {
    // Show the OUTPUT hue this input hue becomes.
    const outHue = wrap01(x + (y - 0.5) * HUE_SHIFT_RANGE);
    return `hsl(${Math.round(outHue * 360)} 85% 55%)`;
  }
  if (key === "hueVsLuma") {
    const light = clamp(55 * g, 8, 92);
    return `hsl(${Math.round(x * 360)} 80% ${light.toFixed(0)}%)`;
  }
  if (key === "lumaVsSat") {
    // Domain is luma (dark → bright). Neutral reads as the gray ramp; boosting colorizes the
    // segment (teal reference chroma), cutting dims it toward flat gray.
    const light = clamp(12 + x * 74, 0, 100) * clamp(0.55 + 0.45 * Math.min(g, 1), 0, 1);
    const sat = clamp(((g - 1) / 3) * 100, 0, 100);
    return `hsl(195 ${sat.toFixed(0)}% ${light.toFixed(0)}%)`;
  }
  // satVsSat — domain is input saturation (gray → vivid); output scales it.
  const eff = clamp(x * 100 * g, 0, 100);
  return `hsl(190 ${eff.toFixed(0)}% 55%)`;
}

/** Map a picked color to its position on this curve's domain axis. */
function domainPositionOfColor(domain: Domain, hex: string): number | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1]!, 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const l = (mx + mn) / 2;
  const d = mx - mn;
  if (domain === "luma") return clamp01(l);
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1) || 1);
  if (domain === "sat") return clamp01(s);
  if (d === 0) return null; // gray has no hue to target
  let h: number;
  if (mx === r) h = ((g - b) / d) % 6;
  else if (mx === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return wrap01(h / 6);
}

export function HueSatCurves({ value, onChange }: { value: string; onChange: (json: string) => void }) {
  const [curves, setCurves] = useState<Curves>(() => parseCurves(value));
  const [drag, setDrag] = useState<{ key: CurveKey; index: number } | null>(null);
  const [smooth, setSmooth] = useState(false);
  const [history, setHistory] = useState<Curves[]>([]);
  const draggingRef = useRef(false);
  const svgRefs = useRef<Partial<Record<CurveKey, SVGSVGElement | null>>>({});

  useEffect(() => {
    if (!draggingRef.current) setCurves(parseCurves(value));
  }, [value]);

  const commit = useCallback(
    (next: Curves) => {
      setHistory((h) => [...h, curves]);
      setCurves(next);
      onChange(serialize(next));
    },
    [curves, onChange]
  );

  const undo = useCallback(() => {
    if (history.length === 0) return;
    const prev = history[history.length - 1]!;
    setHistory(history.slice(0, -1));
    setCurves(prev);
    onChange(serialize(prev));
  }, [history, onChange]);

  const pointFromEvent = useCallback((key: CurveKey, event: { clientX: number; clientY: number }): CurvePoint => {
    const svg = svgRefs.current[key];
    if (!svg) return { x: 0, y: 0.5 };
    const ctm = svg.getScreenCTM();
    if (ctm) {
      const sp = svg.createSVGPoint();
      sp.x = event.clientX;
      sp.y = event.clientY;
      const local = sp.matrixTransform(ctm.inverse());
      return { x: clamp01(local.x / VIEW_W), y: clamp01(1 - local.y / VIEW_H) };
    }
    const rect = svg.getBoundingClientRect();
    return { x: clamp01((event.clientX - rect.left) / rect.width), y: clamp01(1 - (event.clientY - rect.top) / rect.height) };
  }, []);

  /** Insert a point at domain position `x` (neutral y) plus local flanking anchors. */
  const addPointAt = useCallback(
    (key: CurveKey, x: number, y = 0.5) => {
      const def = CURVES.find((c) => c.key === key)!;
      const points = curves[key];
      const next = [...points];
      const hasNeighbor = points.some((pt) => Math.abs(pt.x - x) < ANCHOR_SPREAD * 1.5);
      if (!hasNeighbor) {
        for (const dx of [-ANCHOR_SPREAD, ANCHOR_SPREAD]) {
          const ax = def.periodic ? wrap01(x + dx) : clamp01(x + dx);
          if (!next.some((pt) => Math.abs(pt.x - ax) < 0.02)) next.push({ x: ax, y: 0.5 });
        }
      }
      next.push({ x, y });
      next.sort((a, b) => a.x - b.x);
      commit({ ...curves, [key]: next });
    },
    [curves, commit]
  );

  const handlePointDown = (key: CurveKey, index: number) => (event: ReactPointerEvent<SVGCircleElement>) => {
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    setHistory((h) => [...h, curves]); // one undo step per drag
    draggingRef.current = true;
    setDrag({ key, index });
  };

  const handlePointMove = (key: CurveKey, index: number) => (event: ReactPointerEvent<SVGCircleElement>) => {
    if (!drag || drag.key !== key || drag.index !== index) return;
    const points = curves[key];
    const p = pointFromEvent(key, event);
    const next = points.map((pt) => ({ ...pt }));
    // x is free but stays ordered between neighbors (no wrap reordering mid-drag).
    const lo = index > 0 ? points[index - 1]!.x + 0.001 : 0;
    const hi = index < points.length - 1 ? points[index + 1]!.x - 0.001 : 1;
    const targetX = clamp01(Math.min(Math.max(p.x, lo), hi));
    const f = smooth ? SMOOTH_FACTOR : 1;
    const cur = points[index]!;
    next[index]!.x = cur.x + (targetX - cur.x) * f;
    next[index]!.y = cur.y + (p.y - cur.y) * f;
    const nextCurves = { ...curves, [key]: next };
    setCurves(nextCurves);
    onChange(serialize(nextCurves));
  };

  const handlePointUp = () => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    setDrag(null);
    onChange(serialize(curves));
  };

  const handlePointDoubleClick = (key: CurveKey, index: number) => (event: ReactPointerEvent<SVGCircleElement>) => {
    event.stopPropagation();
    commit({ ...curves, [key]: curves[key].filter((_, i) => i !== index) });
  };

  const handleBackgroundClick = (key: CurveKey) => (event: ReactPointerEvent<SVGSVGElement>) => {
    if (draggingRef.current) return;
    const p = pointFromEvent(key, event);
    if (curves[key].some((pt) => Math.abs(pt.x - p.x) < HIT_RADIUS && Math.abs(pt.y - p.y) < HIT_RADIUS)) return;
    addPointAt(key, p.x, p.y);
  };

  // Sampled segment geometry per curve (the same function the renderer bakes).
  const segmentsByKey = useMemo(() => {
    const out = {} as Record<CurveKey, { x1: number; y1: number; x2: number; y2: number; color: string }[]>;
    for (const def of CURVES) {
      const points = curves[def.key];
      const segs: { x1: number; y1: number; x2: number; y2: number; color: string }[] = [];
      let prevX = 0;
      let prevY = sampleHueSatCurve(points, 0, def.periodic);
      for (let i = 1; i <= CURVE_STEPS; i += 1) {
        const x = i / CURVE_STEPS;
        const y = sampleHueSatCurve(points, x, def.periodic);
        const midX = (prevX + x) / 2;
        const midY = (prevY + y) / 2;
        segs.push({
          x1: prevX * VIEW_W,
          y1: (1 - prevY) * VIEW_H,
          x2: x * VIEW_W,
          y2: (1 - y) * VIEW_H,
          color: segmentColor(def.key, midX, midY)
        });
        prevX = x;
        prevY = y;
      }
      out[def.key] = segs;
    }
    return out;
  }, [curves]);

  return (
    <div className="graph-editor curve-editor hue-sat-curves hue-sat-curves-stacked">
      <div className="curve-editor-toolbar">
        <span className="hue-sat-curves-title">Hue / Saturation curves</span>
        <button
          type="button"
          className={`curve-editor-undo ${smooth ? "is-active" : ""}`}
          aria-pressed={smooth}
          onClick={() => setSmooth((s) => !s)}
          title="Smooth drag — points ease toward the cursor for gentle, fine adjustments"
        >
          <Spline size={13} />
        </button>
        <button type="button" className="curve-editor-undo" onClick={undo} disabled={history.length === 0} title="Undo last change">
          <Undo2 size={13} />
        </button>
      </div>

      {CURVES.map((def) => {
        const points = curves[def.key];
        const edited = points.length > 0 && !isFlat(points);
        return (
          <div className={`hue-sat-graph${edited ? " is-edited" : ""}`} key={def.key}>
            <div className="hue-sat-graph-head">
              <span className="hue-sat-graph-label" title={def.hint}>
                {def.label}
                {edited ? <span className="curve-editor-tab-edited" aria-hidden="true" /> : null}
              </span>
              <label className="hue-sat-graph-picker" title="Pick a color to add a control point at its position on this graph">
                <Pipette size={12} aria-hidden="true" />
                <input
                  type="color"
                  aria-label={`Add ${def.label} point from color`}
                  onChange={(event) => {
                    const x = domainPositionOfColor(def.domain, event.target.value);
                    if (x !== null) addPointAt(def.key, x);
                  }}
                />
              </label>
              <button
                type="button"
                className="curve-editor-undo"
                disabled={points.length === 0}
                title={`Reset ${def.label}`}
                onClick={() => commit({ ...curves, [def.key]: [] })}
              >
                <RotateCcw size={12} />
              </button>
            </div>
            <div className="graph-editor-frame hue-sat-graph-frame">
              <svg
                ref={(el) => {
                  svgRefs.current[def.key] = el;
                }}
                className="graph-editor-svg curve-editor-svg hue-sat-graph-svg"
                viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
                preserveAspectRatio="none"
                onPointerDown={handleBackgroundClick(def.key)}
              >
                {[0.25, 0.5, 0.75].map((g) => (
                  <line key={g} className="graph-editor-grid-line" x1={g * VIEW_W} y1={0} x2={g * VIEW_W} y2={VIEW_H} />
                ))}
                {/* Neutral baseline at y = 0.5 (no change). */}
                <line className="graph-editor-playhead" x1={0} y1={VIEW_H / 2} x2={VIEW_W} y2={VIEW_H / 2} />
                {/* Domain-colored curve with live applied-result feedback — the curve IS the axis. */}
                {segmentsByKey[def.key].map((seg, i) => (
                  <line
                    key={i}
                    className="hue-sat-curve-segment"
                    x1={seg.x1}
                    y1={seg.y1}
                    x2={seg.x2}
                    y2={seg.y2}
                    stroke={seg.color}
                  />
                ))}
                {points.map((pt, index) => {
                  const selected = drag?.key === def.key && drag.index === index;
                  return (
                    <circle
                      key={index}
                      className={`graph-editor-point hue-sat-graph-point ${selected ? "is-selected" : ""}`}
                      cx={pt.x * VIEW_W}
                      cy={(1 - pt.y) * VIEW_H}
                      r={selected ? 14 : 10}
                      /* Inline style (not the fill attribute) so the shared .graph-editor-point CSS
                         can't override the live feedback color. */
                      style={{ fill: segmentColor(def.key, pt.x, pt.y) }}
                      onPointerDown={handlePointDown(def.key, index)}
                      onPointerMove={handlePointMove(def.key, index)}
                      onPointerUp={handlePointUp}
                      onPointerCancel={handlePointUp}
                      onDoubleClick={handlePointDoubleClick(def.key, index)}
                    />
                  );
                })}
              </svg>
            </div>
          </div>
        );
      })}
      <p className="curve-editor-hint">
        Click a graph to add a point · drag up/down to push/pull · double-click a point to remove · pick a color (🖊) to target it ·{" "}
        {smooth ? "Smooth on" : "turn on Smooth (⤴) for fine control"}
      </p>
    </div>
  );
}
