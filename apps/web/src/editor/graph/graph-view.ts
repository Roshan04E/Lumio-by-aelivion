/**
 * Pure view-state math for the graph editor canvas: independent time (x) and
 * normalized-value (y) pan/zoom, px↔domain mapping, fit, and frame-quantized
 * ruler ticks. No React, no DOM — unit-testable and shared by the renderer and
 * the pointer state machine.
 *
 * The vertical axis is NORMALIZED [0..1] per curve (each curve maps its own
 * value range onto the plot — the standard multi-curve overlay trick), so the
 * view's vertical window is a normalized range, default slightly padded.
 */
export interface GraphViewState {
  /** Seconds (layer-local) at the plot's left edge. */
  timeStart: number;
  /** Seconds visible across the plot width. */
  timeDuration: number;
  /** Normalized value at the plot bottom (padded default -0.08). */
  normMin: number;
  /** Normalized value at the plot top (padded default 1.08). */
  normMax: number;
}

export interface PlotRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const MIN_TIME_DURATION = 0.04;
const MIN_NORM_SPAN = 0.05;
const MAX_NORM_SPAN = 12;

export function fitGraphView(layerDuration: number): GraphViewState {
  return {
    timeStart: 0,
    timeDuration: Math.max(0.2, layerDuration),
    normMin: -0.08,
    normMax: 1.08
  };
}

export function timeToPx(view: GraphViewState, plot: PlotRect, timeSeconds: number): number {
  return plot.x + ((timeSeconds - view.timeStart) / Math.max(1e-6, view.timeDuration)) * plot.width;
}

export function pxToTime(view: GraphViewState, plot: PlotRect, px: number): number {
  return view.timeStart + ((px - plot.x) / Math.max(1, plot.width)) * view.timeDuration;
}

export function normToPx(view: GraphViewState, plot: PlotRect, norm: number): number {
  const span = Math.max(1e-6, view.normMax - view.normMin);
  return plot.y + (1 - (norm - view.normMin) / span) * plot.height;
}

export function pxToNorm(view: GraphViewState, plot: PlotRect, py: number): number {
  const span = Math.max(1e-6, view.normMax - view.normMin);
  return view.normMin + (1 - (py - plot.y) / Math.max(1, plot.height)) * span;
}

/** Clamp pan/zoom so the user can't get lost: time window stays near [−¼dur, 1¼dur]. */
export function clampGraphView(view: GraphViewState, layerDuration: number): GraphViewState {
  const duration = Math.max(0.2, layerDuration);
  const timeDuration = Math.min(Math.max(view.timeDuration, MIN_TIME_DURATION), duration * 1.5);
  const minStart = -duration * 0.25;
  const maxStart = duration * 1.25 - timeDuration;
  const timeStart = Math.min(Math.max(view.timeStart, minStart), Math.max(minStart, maxStart));
  let normMin = view.normMin;
  let normMax = view.normMax;
  const span = normMax - normMin;
  if (span < MIN_NORM_SPAN) {
    const mid = (normMin + normMax) / 2;
    normMin = mid - MIN_NORM_SPAN / 2;
    normMax = mid + MIN_NORM_SPAN / 2;
  } else if (span > MAX_NORM_SPAN) {
    const mid = (normMin + normMax) / 2;
    normMin = mid - MAX_NORM_SPAN / 2;
    normMax = mid + MAX_NORM_SPAN / 2;
  }
  normMin = Math.min(Math.max(normMin, -6), 6);
  normMax = Math.min(Math.max(normMax, normMin + MIN_NORM_SPAN), 7);
  return { timeStart, timeDuration, normMin, normMax };
}

/** Zoom the time axis about an anchor time (cursor-anchored wheel zoom). */
export function zoomGraphTime(view: GraphViewState, anchorTime: number, factor: number): GraphViewState {
  const timeDuration = view.timeDuration * factor;
  const ratio = (anchorTime - view.timeStart) / Math.max(1e-6, view.timeDuration);
  return { ...view, timeDuration, timeStart: anchorTime - ratio * timeDuration };
}

/** Zoom the value axis about an anchor normalized value. */
export function zoomGraphNorm(view: GraphViewState, anchorNorm: number, factor: number): GraphViewState {
  const span = (view.normMax - view.normMin) * factor;
  const ratio = (anchorNorm - view.normMin) / Math.max(1e-6, view.normMax - view.normMin);
  const normMin = anchorNorm - ratio * span;
  return { ...view, normMin, normMax: normMin + span };
}

export interface RulerTick {
  timeSeconds: number;
  major: boolean;
  label?: string;
}

/** Frame-aware "nice" tick steps: sub-second steps quantize to whole frames. */
export function graphRulerTicks(view: GraphViewState, plot: PlotRect, fps: number): RulerTick[] {
  const frame = 1 / Math.max(1, fps);
  const candidates = [frame, 2 * frame, 5 * frame, 10 * frame, 0.5, 1, 2, 5, 10, 30, 60, 120];
  const minPxPerMajor = 68;
  const step =
    candidates.find((candidate) => (candidate / view.timeDuration) * plot.width >= minPxPerMajor) ??
    candidates[candidates.length - 1]!;
  const minor = step / (step >= 1 ? 4 : 2);
  const ticks: RulerTick[] = [];
  const first = Math.floor(view.timeStart / minor) * minor;
  const end = view.timeStart + view.timeDuration;
  for (let t = first; t <= end + 1e-6; t += minor) {
    const isMajor = Math.abs(t / step - Math.round(t / step)) < 1e-6;
    const tick: RulerTick = { timeSeconds: t, major: isMajor };
    if (isMajor) tick.label = formatRulerTime(t, fps, step);
    ticks.push(tick);
  }
  return ticks;
}

function formatRulerTime(timeSeconds: number, fps: number, step: number): string {
  if (step < 0.5) {
    // Frame-scale ticks: show s:ff (frames), the NLE convention.
    const total = Math.round(timeSeconds * fps);
    const frames = ((total % fps) + fps) % fps;
    const seconds = Math.floor(timeSeconds);
    return `${seconds}:${String(frames).padStart(2, "0")}`;
  }
  if (timeSeconds >= 60) {
    const minutes = Math.floor(timeSeconds / 60);
    const seconds = timeSeconds - minutes * 60;
    return `${minutes}:${seconds.toFixed(0).padStart(2, "0")}`;
  }
  return `${Number(timeSeconds.toFixed(2))}s`;
}

/** Distinct, stable curve colors — indexed by the target's position in the tree. */
const CURVE_PALETTE = [
  "#4f9cff",
  "#ff5f6d",
  "#39d98a",
  "#f6c85f",
  "#c084fc",
  "#22d3ee",
  "#fb923c",
  "#a3e635",
  "#f472b6",
  "#94a3b8"
];

export function curveColor(index: number): string {
  return CURVE_PALETTE[((index % CURVE_PALETTE.length) + CURVE_PALETTE.length) % CURVE_PALETTE.length]!;
}
