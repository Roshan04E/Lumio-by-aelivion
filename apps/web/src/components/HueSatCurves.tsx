import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Spline, Undo2 } from "lucide-react";
import { sampleHueSatCurve, type CurvePoint } from "@orreris/shared";

/**
 * Professional Color System (Phase 3, 13C.3) — Lumetri Hue/Sat curve editor.
 * Five domain-colored graph curves; **neutral is the flat center line (y = 0.5)**, not
 * the tone-curve diagonal. Drag a point up to push, down to pull. Hue-domain curves wrap
 * (the 0/1 seam is continuous). The drawn path samples the SAME function the renderer
 * bakes into the 3D LUT (`sampleHueSatCurve`), so what you see is what renders.
 *
 * Clicking on an empty stretch drops a point plus two baseline anchors so the adjustment
 * is LOCAL (a bump), the way Lumetri's hue curves behave — not a global tilt. Stores
 * `HueSatCurves` as JSON ("{}" = identity). WebGL engine only (SVG can't express HSL).
 */

type CurveKey = "hueVsSat" | "hueVsHue" | "hueVsLuma" | "lumaVsSat" | "satVsSat";
type Domain = "hue" | "luma" | "sat";

const CURVES: { key: CurveKey; label: string; domain: Domain; periodic: boolean }[] = [
  { key: "hueVsSat", label: "Hue ▸ Sat", domain: "hue", periodic: true },
  { key: "hueVsHue", label: "Hue ▸ Hue", domain: "hue", periodic: true },
  { key: "hueVsLuma", label: "Hue ▸ Luma", domain: "hue", periodic: true },
  { key: "lumaVsSat", label: "Luma ▸ Sat", domain: "luma", periodic: false },
  { key: "satVsSat", label: "Sat ▸ Sat", domain: "sat", periodic: false }
];

const VIEW = 1000;
const HIT_RADIUS = 0.03;
const SMOOTH_FACTOR = 0.22;
const ANCHOR_SPREAD = 0.16; // how far the auto-seeded baseline anchors sit from a new point

type Curves = Record<CurveKey, CurvePoint[]>;

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
function wrap01(v: number): number {
  const r = v - Math.floor(v);
  return r < 0 ? r + 1 : r;
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

/** CSS background for the domain axis (under the graph) so users see what x means. */
function domainBackground(domain: Domain): string {
  if (domain === "hue") {
    const stops = [0, 60, 120, 180, 240, 300, 360].map((h) => `hsl(${h} 90% 55%)`).join(", ");
    return `linear-gradient(90deg, ${stops})`;
  }
  if (domain === "luma") {
    return "linear-gradient(90deg, #000, #fff)";
  }
  return "linear-gradient(90deg, #6b7280, #22d3ee)"; // sat: gray → vivid
}

export function HueSatCurves({ value, onChange }: { value: string; onChange: (json: string) => void }) {
  const [curves, setCurves] = useState<Curves>(() => parseCurves(value));
  const [active, setActive] = useState<CurveKey>("hueVsSat");
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [smooth, setSmooth] = useState(false);
  const [history, setHistory] = useState<Curves[]>([]);
  const draggingRef = useRef(false);
  const svgRef = useRef<SVGSVGElement | null>(null);

  useEffect(() => {
    if (!draggingRef.current) setCurves(parseCurves(value));
  }, [value]);

  const def = CURVES.find((c) => c.key === active)!;
  const points = curves[active];

  const curvePath = useMemo(() => {
    const steps = 96;
    const parts: string[] = [];
    for (let i = 0; i <= steps; i += 1) {
      const x = i / steps;
      const y = sampleHueSatCurve(points, x, def.periodic);
      parts.push(`${i === 0 ? "M" : "L"} ${(x * VIEW).toFixed(1)} ${((1 - y) * VIEW).toFixed(1)}`);
    }
    return parts.join(" ");
  }, [points, def.periodic]);

  const pointFromEvent = useCallback((event: { clientX: number; clientY: number }): CurvePoint => {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0.5 };
    // Map through the SVG coordinate matrix (exact under any viewBox/aspect) so clicks land
    // under the cursor and drags track it precisely.
    const ctm = svg.getScreenCTM();
    if (ctm) {
      const sp = svg.createSVGPoint();
      sp.x = event.clientX;
      sp.y = event.clientY;
      const local = sp.matrixTransform(ctm.inverse());
      return { x: clamp01(local.x / VIEW), y: clamp01(1 - local.y / VIEW) };
    }
    const rect = svg.getBoundingClientRect();
    return { x: clamp01((event.clientX - rect.left) / rect.width), y: clamp01(1 - (event.clientY - rect.top) / rect.height) };
  }, []);

  const setActivePoints = (pts: CurvePoint[]): Curves => ({ ...curves, [active]: pts });

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

  const handlePointDown = (index: number) => (event: ReactPointerEvent<SVGCircleElement>) => {
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    setHistory((h) => [...h, curves]); // one undo step per drag
    draggingRef.current = true;
    setDragIndex(index);
  };

  const handlePointMove = (index: number) => (event: ReactPointerEvent<SVGCircleElement>) => {
    if (dragIndex !== index) return;
    const p = pointFromEvent(event);
    const next = points.map((pt) => ({ ...pt }));
    // x is free but stays ordered between neighbors (no wrap reordering mid-drag).
    const lo = index > 0 ? points[index - 1]!.x + 0.001 : 0;
    const hi = index < points.length - 1 ? points[index + 1]!.x - 0.001 : 1;
    const targetX = clamp01(Math.min(Math.max(p.x, lo), hi));
    const f = smooth ? SMOOTH_FACTOR : 1;
    const cur = points[index]!;
    next[index]!.x = cur.x + (targetX - cur.x) * f;
    next[index]!.y = cur.y + (p.y - cur.y) * f;
    const nextCurves = setActivePoints(next);
    setCurves(nextCurves);
    onChange(serialize(nextCurves));
  };

  const handlePointUp = () => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    setDragIndex(null);
    onChange(serialize(curves));
  };

  const handlePointDoubleClick = (index: number) => (event: ReactPointerEvent<SVGCircleElement>) => {
    event.stopPropagation();
    commit(setActivePoints(points.filter((_, i) => i !== index)));
  };

  const handleBackgroundClick = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (draggingRef.current) return;
    const p = pointFromEvent(event);
    if (points.some((pt) => Math.abs(pt.x - p.x) < HIT_RADIUS && Math.abs(pt.y - p.y) < HIT_RADIUS)) return;
    const next = [...points];
    // Seed flanking baseline anchors so a new adjustment is local (a bump), not a global tilt.
    const hasNeighbor = points.some((pt) => Math.abs(pt.x - p.x) < ANCHOR_SPREAD * 1.5);
    if (!hasNeighbor) {
      for (const dx of [-ANCHOR_SPREAD, ANCHOR_SPREAD]) {
        const ax = def.periodic ? wrap01(p.x + dx) : clamp01(p.x + dx);
        if (!next.some((pt) => Math.abs(pt.x - ax) < 0.02)) next.push({ x: ax, y: 0.5 });
      }
    }
    next.push(p);
    next.sort((a, b) => a.x - b.x);
    commit(setActivePoints(next));
  };

  return (
    <div className="graph-editor curve-editor hue-sat-curves">
      <div className="curve-editor-toolbar">
        <div className="graph-property-tabs" role="tablist">
          {CURVES.map((curve) => {
            const edited = curves[curve.key].length > 0 && !isFlat(curves[curve.key]);
            return (
              <button
                key={curve.key}
                type="button"
                role="tab"
                aria-selected={active === curve.key}
                className={active === curve.key ? "is-active" : ""}
                onClick={() => setActive(curve.key)}
                title={edited ? `${curve.label} (edited)` : curve.label}
              >
                {curve.label}
                {edited ? <span className="curve-editor-tab-edited" aria-hidden="true" /> : null}
              </button>
            );
          })}
        </div>
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

      <div className="graph-editor-frame">
        <div className="hue-sat-curves-axis" style={{ background: domainBackground(def.domain) }} aria-hidden="true" />
        <svg
          ref={svgRef}
          className="graph-editor-svg curve-editor-svg"
          viewBox={`0 0 ${VIEW} ${VIEW}`}
          preserveAspectRatio="none"
          onPointerDown={handleBackgroundClick}
        >
          {[0.25, 0.5, 0.75].map((g) => (
            <g key={g}>
              <line className="graph-editor-grid-line" x1={g * VIEW} y1={0} x2={g * VIEW} y2={VIEW} />
              <line className="graph-editor-grid-line" x1={0} y1={g * VIEW} x2={VIEW} y2={g * VIEW} />
            </g>
          ))}
          {/* Neutral baseline at y = 0.5 (no change). */}
          <line className="graph-editor-playhead" x1={0} y1={VIEW / 2} x2={VIEW} y2={VIEW / 2} />
          <path className="graph-editor-curve" d={curvePath} />
          {points.map((pt, index) => (
            <circle
              key={index}
              className={`graph-editor-point ${dragIndex === index ? "is-selected" : ""}`}
              cx={pt.x * VIEW}
              cy={(1 - pt.y) * VIEW}
              r={dragIndex === index ? 22 : 16}
              onPointerDown={handlePointDown(index)}
              onPointerMove={handlePointMove(index)}
              onPointerUp={handlePointUp}
              onPointerCancel={handlePointUp}
              onDoubleClick={handlePointDoubleClick(index)}
            />
          ))}
        </svg>
      </div>
      <p className="curve-editor-hint">
        Click the {def.domain} axis to add a point · drag up/down to push/pull · double-click to remove ·{" "}
        {smooth ? "Smooth on" : "turn on Smooth (⤴) for fine control"}
      </p>
    </div>
  );
}
