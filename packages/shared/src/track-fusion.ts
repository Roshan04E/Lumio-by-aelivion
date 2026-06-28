/**
 * Evidence-weighted fusion + smoothing for tracked paths.
 *
 * The plain geometric cleaner (`cleanTrackingPoints` in masks.ts) only ever sees
 * the (x,y) keyframes - it can produce a smooth path that has quietly slid off the
 * real subject. This module is the principled core of the "professional grade"
 * cleanup: it takes per-frame *measurements* (the tracked position) together with
 * independent *evidence* about how trustworthy each frame is (appearance match
 * confidence, forward-backward consistency, whether the point is still on the
 * detected subject), and runs a constant-velocity Kalman filter + RTS smoother
 * that optimally blends the measurements against a smooth-motion prior.
 *
 * The behaviour that makes it "will work" rather than "may work":
 *  - High-evidence frames pull the estimate exactly onto the measured point
 *    (small measurement noise R) -> the path follows the real subject, no
 *    over-smoothing.
 *  - Low-evidence frames (occlusion, drift, motion blur, off-subject) get large R,
 *    so the smoother coasts on the constant-velocity prior through them -> no
 *    jitter, no distortion, no latching onto a wrong feature.
 *
 * Pure and DOM-free so it can be unit-asserted and shared; the browser layer
 * (apps/web/src/tools/track-cleanup.ts) gathers the evidence from the real video
 * frames and feeds it here.
 */

export interface FrameMeasurement {
  timeSeconds: number;
  /** Measured position, percent of frame. */
  x: number;
  y: number;
  /** Appearance-match confidence for this frame, 0..1 (1 = strong match). */
  confidence: number;
  /** Forward-backward round-trip error in percent units (0 = perfectly consistent). */
  forwardBackwardError: number;
  /** How far the point sits outside the detected subject, normalised (0 = on subject). */
  offSubject: number;
}

export interface TrackFusionOptions {
  /** 0..0.95. Higher = trust the smooth-motion prior more (stiffer, smoother). Defaults to 0.5. */
  smoothing?: number | undefined;
}

export interface TrackFusionResult {
  x: number[];
  y: number[];
  /** Per-frame trust in 0..1 (1 = fully trusted measurement), for diagnostics/UI. */
  reliability: number[];
}

/** Measurement-noise variance for a frame we fully trust (percent^2). Sets the appearance "tightness". */
const BASE_MEASUREMENT_VARIANCE = 0.16;
/** Forward-backward error (percent) that doubles the measurement noise. */
const FB_REFERENCE = 0.5;
const WEIGHT_FB = 8;
const WEIGHT_CONFIDENCE = 4;
const WEIGHT_OFF_SUBJECT = 12;
/** Process noise (motion-model slack) range; smoothing scales between them. */
const PROCESS_NOISE_MIN = 0.02;
const PROCESS_NOISE_SPAN = 3;

function measurementVariance(frame: FrameMeasurement): number {
  const fb = Math.max(0, frame.forwardBackwardError) / FB_REFERENCE;
  const conf = Math.max(0, Math.min(1, frame.confidence));
  const off = Math.max(0, frame.offSubject);
  const factor = 1 + WEIGHT_FB * fb + WEIGHT_CONFIDENCE * (1 - conf) + WEIGHT_OFF_SUBJECT * off;
  return BASE_MEASUREMENT_VARIANCE * factor;
}

/**
 * 1-D constant-velocity Kalman filter (forward) + Rauch-Tung-Striebel smoother
 * (backward). State is [position, velocity]; per-frame measurement noise `R[i]`
 * lets each frame be trusted independently. Returns the smoothed positions.
 */
export function rtsSmooth1D(z: number[], R: number[], dt: number[], q: number): number[] {
  const n = z.length;
  if (n === 0) {
    return [];
  }
  if (n === 1) {
    return [z[0] ?? 0];
  }

  const xPriorPos = new Array<number>(n);
  const xPriorVel = new Array<number>(n);
  const xPostPos = new Array<number>(n);
  const xPostVel = new Array<number>(n);
  // Covariances stored row-major as [p00, p01, p10, p11].
  const pPrior: number[][] = new Array(n);
  const pPost: number[][] = new Array(n);

  // Frame 0: prior == measurement, large velocity uncertainty.
  xPriorPos[0] = z[0] ?? 0;
  xPriorVel[0] = 0;
  pPrior[0] = [R[0] ?? 1, 0, 0, 100];
  {
    const p = pPrior[0]!;
    const r0 = R[0] ?? 1;
    const s = (p[0] ?? 0) + r0;
    const k0 = (p[0] ?? 0) / s;
    const k1 = (p[2] ?? 0) / s;
    const y = (z[0] ?? 0) - (xPriorPos[0] ?? 0);
    xPostPos[0] = (xPriorPos[0] ?? 0) + k0 * y;
    xPostVel[0] = (xPriorVel[0] ?? 0) + k1 * y;
    pPost[0] = [(1 - k0) * (p[0] ?? 0), (1 - k0) * (p[1] ?? 0), -k1 * (p[0] ?? 0) + (p[2] ?? 0), -k1 * (p[1] ?? 0) + (p[3] ?? 0)];
  }

  for (let i = 1; i < n; i += 1) {
    const d = dt[i - 1] && (dt[i - 1] ?? 0) > 0 ? (dt[i - 1] as number) : 1 / 30;
    const pp = pPost[i - 1]!;

    // Predict: F = [[1, d], [0, 1]].
    xPriorPos[i] = (xPostPos[i - 1] ?? 0) + d * (xPostVel[i - 1] ?? 0);
    xPriorVel[i] = xPostVel[i - 1] ?? 0;

    // P_prior = F P F^T + Q.
    const fp0 = (pp[0] ?? 0) + d * (pp[2] ?? 0);
    const fp1 = (pp[1] ?? 0) + d * (pp[3] ?? 0);
    const fp2 = pp[2] ?? 0;
    const fp3 = pp[3] ?? 0;
    let p0 = fp0 + d * fp1;
    let p1 = fp1;
    let p2 = fp2 + d * fp3;
    let p3 = fp3;
    p0 += (q * d * d * d) / 3;
    p1 += (q * d * d) / 2;
    p2 += (q * d * d) / 2;
    p3 += q * d;
    pPrior[i] = [p0, p1, p2, p3];

    // Update with measurement z[i].
    const ri = R[i] ?? 1;
    const s = p0 + ri;
    const k0 = p0 / s;
    const k1 = p2 / s;
    const y = (z[i] ?? 0) - (xPriorPos[i] ?? 0);
    xPostPos[i] = (xPriorPos[i] ?? 0) + k0 * y;
    xPostVel[i] = (xPriorVel[i] ?? 0) + k1 * y;
    pPost[i] = [(1 - k0) * p0, (1 - k0) * p1, -k1 * p0 + p2, -k1 * p1 + p3];
  }

  // RTS backward smoother for the positions.
  const smoothedPos = new Array<number>(n);
  const smoothedVel = new Array<number>(n);
  smoothedPos[n - 1] = xPostPos[n - 1] ?? 0;
  smoothedVel[n - 1] = xPostVel[n - 1] ?? 0;

  for (let i = n - 2; i >= 0; i -= 1) {
    const d = dt[i] && (dt[i] ?? 0) > 0 ? (dt[i] as number) : 1 / 30;
    const po = pPost[i]!;
    const pr = pPrior[i + 1]!;

    // a = P_post * F^T, with F^T = [[1, 0], [d, 1]].
    const a0 = (po[0] ?? 0) + d * (po[1] ?? 0);
    const a1 = po[1] ?? 0;
    const a2 = (po[2] ?? 0) + d * (po[3] ?? 0);
    const a3 = po[3] ?? 0;

    // inv(P_prior[i+1]).
    const det = (pr[0] ?? 0) * (pr[3] ?? 0) - (pr[1] ?? 0) * (pr[2] ?? 0) || 1e-9;
    const inv0 = (pr[3] ?? 0) / det;
    const inv1 = -(pr[1] ?? 0) / det;
    const inv2 = -(pr[2] ?? 0) / det;
    const inv3 = (pr[0] ?? 0) / det;

    // C = a * inv.
    const c0 = a0 * inv0 + a1 * inv2;
    const c1 = a0 * inv1 + a1 * inv3;
    const c2 = a2 * inv0 + a3 * inv2;
    const c3 = a2 * inv1 + a3 * inv3;

    const dPos = (smoothedPos[i + 1] ?? 0) - (xPriorPos[i + 1] ?? 0);
    const dVel = (smoothedVel[i + 1] ?? 0) - (xPriorVel[i + 1] ?? 0);
    smoothedPos[i] = (xPostPos[i] ?? 0) + c0 * dPos + c1 * dVel;
    smoothedVel[i] = (xPostVel[i] ?? 0) + c2 * dPos + c3 * dVel;
  }

  return smoothedPos;
}

export function fuseTrackMeasurements(frames: FrameMeasurement[], options: TrackFusionOptions = {}): TrackFusionResult {
  const smoothing = Math.max(0, Math.min(0.95, options.smoothing ?? 0.5));
  const n = frames.length;
  if (n < 3) {
    return { x: frames.map((f) => f.x), y: frames.map((f) => f.y), reliability: frames.map(() => 1) };
  }

  const dt: number[] = [];
  for (let i = 1; i < n; i += 1) {
    dt.push(Math.max(1e-3, (frames[i]?.timeSeconds ?? 0) - (frames[i - 1]?.timeSeconds ?? 0)));
  }

  const variances: number[] = [];
  const reliability: number[] = [];
  for (const frame of frames) {
    const v = measurementVariance(frame);
    variances.push(v);
    reliability.push(BASE_MEASUREMENT_VARIANCE / v);
  }

  const q = PROCESS_NOISE_MIN + (1 - smoothing) * PROCESS_NOISE_SPAN;
  const x = rtsSmooth1D(frames.map((f) => f.x), variances, dt, q);
  const y = rtsSmooth1D(frames.map((f) => f.y), variances, dt, q);
  return { x, y, reliability };
}
