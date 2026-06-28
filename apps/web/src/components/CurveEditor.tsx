import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Spline, Undo2 } from "lucide-react";
import { evaluateCurve, identityCurvePoints, type CurvePoint } from "@reelforge/shared";

/**
 * Professional Color System (Phase 3, 13C.1) — the Curves graph editor.
 * A real curve, not sliders: drag control points on a graph; Master + R/G/B
 * channels. The drawn curve is sampled with the SAME monotonic spline the renderer
 * bakes into its LUT (`evaluateCurve`), so what you see is exactly what renders.
 * Drags are local (smooth, no churn); a single onChange fires on release so each
 * edit is one undo step. Stores `ChannelCurves` as JSON ("{}" = identity).
 */

type ChannelKey = "master" | "red" | "green" | "blue";

const CHANNELS: { key: ChannelKey; label: string; color: string }[] = [
  { key: "master", label: "Master", color: "#e5e7eb" },
  { key: "red", label: "R", color: "#ff5a5a" },
  { key: "green", label: "G", color: "#54d07a" },
  { key: "blue", label: "B", color: "#5a9bff" }
];

const VIEW = 1000; // SVG user units (square); CSS scales to fit.
const HIT_RADIUS = 0.025; // in 0..1 graph space, for picking/removing a point.
// In "smooth" mode the dragged point eases toward the cursor instead of snapping,
// so the curve reacts gently — easier for fine adjustments / new users.
const SMOOTH_FACTOR = 0.22;

type Channels = Record<ChannelKey, CurvePoint[]>;

function parseChannels(value: string): Channels {
  const base: Channels = { master: identityCurvePoints(), red: identityCurvePoints(), green: identityCurvePoints(), blue: identityCurvePoints() };
  if (!value || value.trim() === "" || value.trim() === "{}") {
    return base;
  }
  try {
    const raw = JSON.parse(value) as Partial<Record<ChannelKey, CurvePoint[]>>;
    for (const { key } of CHANNELS) {
      const pts = raw[key];
      if (Array.isArray(pts) && pts.length >= 2) {
        base[key] = pts.map((p) => ({ x: clamp01(p.x), y: clamp01(p.y) })).sort((a, b) => a.x - b.x);
      }
    }
  } catch {
    /* fall back to identity */
  }
  return base;
}

function isIdentity(points: CurvePoint[]): boolean {
  return points.length === 2 && points[0]!.x === 0 && points[0]!.y === 0 && points[1]!.x === 1 && points[1]!.y === 1;
}

function serialize(channels: Channels): string {
  const out: Partial<Channels> = {};
  for (const { key } of CHANNELS) {
    if (!isIdentity(channels[key])) {
      out[key] = channels[key];
    }
  }
  return Object.keys(out).length ? JSON.stringify(out) : "{}";
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function CurveEditor({ value, onChange }: { value: string; onChange: (json: string) => void }) {
  const [channels, setChannels] = useState<Channels>(() => parseChannels(value));
  const [active, setActive] = useState<ChannelKey>("master");
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [smooth, setSmooth] = useState(false);
  // Per-edit history (each point add/move/remove is one step) so the undo button
  // steps back through individual curve changes rather than wiping the whole curve.
  const [history, setHistory] = useState<Channels[]>([]);
  const draggingRef = useRef(false);
  const svgRef = useRef<SVGSVGElement | null>(null);

  // Re-sync from props on external changes (reset / undo) — but never mid-drag.
  useEffect(() => {
    if (!draggingRef.current) {
      setChannels(parseChannels(value));
    }
  }, [value]);

  const points = channels[active];
  const accent = CHANNELS.find((c) => c.key === active)!.color;

  const curvePath = useMemo(() => {
    const steps = 64;
    const parts: string[] = [];
    for (let i = 0; i <= steps; i += 1) {
      const x = i / steps;
      const y = evaluateCurve(points, x);
      parts.push(`${i === 0 ? "M" : "L"} ${(x * VIEW).toFixed(1)} ${((1 - y) * VIEW).toFixed(1)}`);
    }
    return parts.join(" ");
  }, [points]);

  const pointFromEvent = useCallback((event: { clientX: number; clientY: number }): CurvePoint => {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    // Map through the SVG's own coordinate matrix so the result is exact regardless of
    // viewBox + preserveAspectRatio letterboxing — a plain getBoundingClientRect() ratio
    // is off by the meet-fit margins, which made clicks land off the curve and drags lag.
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

  // Snapshot the current state onto the undo stack before a discrete change.
  const pushHistory = useCallback(() => setHistory((h) => [...h, channels]), [channels]);

  const commit = useCallback(
    (next: Channels) => {
      setHistory((h) => [...h, channels]);
      setChannels(next);
      onChange(serialize(next));
    },
    [channels, onChange]
  );

  const undo = useCallback(() => {
    if (history.length === 0) return;
    const prev = history[history.length - 1]!;
    setHistory(history.slice(0, -1));
    setChannels(prev);
    onChange(serialize(prev));
  }, [history, onChange]);

  const setActivePoints = (pts: CurvePoint[]): Channels => ({ ...channels, [active]: pts });

  const handlePointDown = (index: number) => (event: ReactPointerEvent<SVGCircleElement>) => {
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    pushHistory(); // one undo step per drag
    draggingRef.current = true;
    setDragIndex(index);
  };

  const handlePointMove = (index: number) => (event: ReactPointerEvent<SVGCircleElement>) => {
    if (dragIndex !== index) return;
    const p = pointFromEvent(event);
    const last = points.length - 1;
    const next = points.map((pt) => ({ ...pt }));
    // Target the cursor; endpoints keep their x, interior points stay between neighbors.
    let targetX: number;
    if (index === 0) targetX = 0;
    else if (index === last) targetX = 1;
    else targetX = clamp01(Math.min(Math.max(p.x, points[index - 1]!.x + 0.001), points[index + 1]!.x - 0.001));
    const targetY = p.y;
    // Smooth mode eases the point toward the cursor (gentle response) instead of snapping.
    const f = smooth ? SMOOTH_FACTOR : 1;
    const current = points[index]!;
    next[index]!.x = current.x + (targetX - current.x) * f;
    next[index]!.y = current.y + (targetY - current.y) * f;
    const nextChannels = setActivePoints(next);
    setChannels(nextChannels);
    // Emit live so the preview updates in real time as the point moves. The value→state
    // resync is skipped while dragging (draggingRef), so local state stays authoritative.
    onChange(serialize(nextChannels));
  };

  const handlePointUp = () => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    setDragIndex(null);
    onChange(serialize(channels)); // final commit (history step was taken on pointer-down)
  };

  const handlePointDoubleClick = (index: number) => (event: ReactPointerEvent<SVGCircleElement>) => {
    event.stopPropagation();
    if (index === 0 || index === points.length - 1) return; // keep endpoints
    commit(setActivePoints(points.filter((_, i) => i !== index)));
  };

  const handleBackgroundClick = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (draggingRef.current) return;
    const p = pointFromEvent(event);
    // Ignore clicks that land on an existing point (those start a drag instead).
    if (points.some((pt) => Math.abs(pt.x - p.x) < HIT_RADIUS && Math.abs(pt.y - p.y) < HIT_RADIUS)) return;
    const next = [...points, p].sort((a, b) => a.x - b.x);
    commit(setActivePoints(next));
  };

  return (
    <div className="graph-editor curve-editor">
      <div className="curve-editor-toolbar">
        <div className="graph-property-tabs" role="tablist">
          {CHANNELS.map((channel) => (
            <button
              key={channel.key}
              type="button"
              role="tab"
              aria-selected={active === channel.key}
              className={active === channel.key ? "is-active" : ""}
              onClick={() => setActive(channel.key)}
              title={!isIdentity(channels[channel.key]) ? `${channel.label} (edited)` : channel.label}
            >
              <span className="curve-editor-tab-dot" style={{ background: channel.color }} aria-hidden="true" />
              {channel.label}
              {!isIdentity(channels[channel.key]) ? <span className="curve-editor-tab-edited" aria-hidden="true" /> : null}
            </button>
          ))}
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
        <button
          type="button"
          className="curve-editor-undo"
          onClick={undo}
          disabled={history.length === 0}
          title="Undo last curve change"
        >
          <Undo2 size={13} />
        </button>
      </div>

      <div className="graph-editor-frame">
        <svg
          ref={svgRef}
          className="graph-editor-svg curve-editor-svg"
          viewBox={`0 0 ${VIEW} ${VIEW}`}
          preserveAspectRatio="xMidYMid meet"
          onPointerDown={handleBackgroundClick}
        >
          <rect className="graph-editor-plot" x={0} y={0} width={VIEW} height={VIEW} />
          {[0.25, 0.5, 0.75].map((g) => (
            <g key={g}>
              <line className="graph-editor-grid-line" x1={g * VIEW} y1={0} x2={g * VIEW} y2={VIEW} />
              <line className="graph-editor-grid-line" x1={0} y1={g * VIEW} x2={VIEW} y2={g * VIEW} />
            </g>
          ))}
          <line className="graph-editor-playhead" x1={0} y1={VIEW} x2={VIEW} y2={0} />
          <path className="graph-editor-curve" d={curvePath} style={{ stroke: accent }} />
          {points.map((pt, index) => (
            <circle
              key={index}
              className={`graph-editor-point ${dragIndex === index ? "is-selected" : ""}`}
              cx={pt.x * VIEW}
              cy={(1 - pt.y) * VIEW}
              r={dragIndex === index ? 24 : 18}
              style={{ stroke: accent, ...(dragIndex === index ? { fill: accent } : {}) }}
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
        Click to add a point · drag to shape · double-click to remove ·{" "}
        {smooth ? "Smooth drag on — points ease for gentle control" : "turn on Smooth (⤴) for gentle, fine dragging"}
      </p>
    </div>
  );
}
