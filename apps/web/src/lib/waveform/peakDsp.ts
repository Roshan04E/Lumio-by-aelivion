/**
 * Pure waveform DSP — no DOM/React/worker dependencies, so this module can run identically on
 * the main thread (fallback decode) or inside `peaks.worker.ts` (the normal path). Produces a
 * DISPLAY-domain overview: peak (transient tips) + RMS (perceived-loudness body), normalized to
 * a robust percentile and dB-compressed so quiet passages still read. Purely visual — never
 * touches the audio itself. See Phase 1 (WAVEFORM_QA.md) for the design rationale.
 */

/**
 * Display-domain overview for a source, all the same length:
 *  - `max`: signed top excursion per bucket (~0..+1, the positive envelope)
 *  - `min`: signed bottom excursion per bucket (~-1..0, the negative envelope)
 *  - `rms`: perceived-loudness body magnitude (0..1)
 * The bipolar min/max (not a mirrored abs-peak) is what gives the DaVinci/Premiere-grade detail:
 * the true asymmetric waveform excursions read as fine structure even on sustained audio.
 */
export type HiresPeaks = { max: Float32Array; min: Float32Array; rms: Float32Array };
/** Resampled display arrays handed to a renderer (small — sized to the clip's pixel width). */
export type WaveformPeaks = { max: number[]; min: number[]; rms: number[] };

export const PEAK_FLOOR = 0.03; // minimum bar so total silence still reads as a faint line
const NORM_PERCENTILE = 0.99; // normalize to the 99th-percentile peak (was .97): keeps transients at full height without pulling mid-level content up near the ceiling, so the envelope reads with real dynamic contrast for zoomed precision work
const DISPLAY_FLOOR_DB = -42; // amplitudes at/below this map to 0 display (was -48): a tighter floor lets quiet passages collapse toward the baseline instead of filling the lane uniformly — DaVinci-style quiet-vs-loud contrast
const SILENCE_GATE_DB = -60; // normalized peaks below this read as clean silence (thin line, no body)
const SILENCE_GATE_LINEAR = Math.pow(10, SILENCE_GATE_DB / 20);

// Resolution is a FIXED peaks-per-second (not a fixed total count), so a zoomed clip of a long
// source still has a real peak at every on-screen pixel — the dense "grass" texture pro editors
// (DaVinci/Premiere) show. A fixed total made long sources sparse: a short window sliced out of a
// long source held only a handful of hi-res peaks, so the filled path interpolated them into big
// triangles/diamonds. Stored as Float32Array (4 bytes/sample) to afford the higher resolution.
export const PEAKS_PER_SECOND = 200; // ~1 value / 240 samples @48k — industry-typical; per-pixel detail at any realistic zoom
const MIN_HIRES_BUCKETS = 2000; // floor for very short sources
const MAX_HIRES_BUCKETS = 600_000; // per-source cap ~2.4MB Float32 (~50min @200/s); density tapers past that but stays dense
const MIN_PYRAMID_LEN = 64; // stop halving once a level would be smaller than this

const HIST_BINS = 256;

export function hiresBucketCount(durationSeconds: number): number {
  const wanted = Math.ceil(Math.max(0, durationSeconds) * PEAKS_PER_SECOND);
  return Math.min(MAX_HIRES_BUCKETS, Math.max(MIN_HIRES_BUCKETS, wanted));
}

/**
 * The normalization reference: the `q`-percentile of the raw bucket peaks, via a cheap O(n)
 * histogram (no sort). Using a high percentile instead of the absolute max means a single loud
 * transient (top few %) clamps to full height while every quieter passage is lifted enough to
 * read — this is what removes the "flat line with isolated spikes" look on speech/sfx.
 */
function peakPercentile(peaks: Float32Array, max: number, q: number): number {
  if (max <= 0) return 0;
  const bins = new Int32Array(HIST_BINS);
  const scale = (HIST_BINS - 1) / max;
  for (let i = 0; i < peaks.length; i += 1) {
    const idx = ((peaks[i] ?? 0) * scale) | 0;
    bins[idx] = (bins[idx] ?? 0) + 1;
  }
  const target = peaks.length * q;
  let cum = 0;
  for (let b = 0; b < HIST_BINS; b += 1) {
    cum += bins[b] ?? 0;
    if (cum >= target) return ((b + 1) / HIST_BINS) * max; // upper edge of the percentile bin
  }
  return max;
}

/**
 * DISPLAY compression: map a normalized linear amplitude (0..1, where 1 == the percentile
 * reference) through a dB curve so quiet passages lift toward the top instead of hugging zero.
 * This is the "logarithmic waveform" pro editors offer — purely visual, never touches audio.
 */
function compressDisplay(linear: number): number {
  if (linear <= 0) return 0;
  const db = 20 * Math.log10(linear);
  if (db <= DISPLAY_FLOOR_DB) return 0;
  if (db >= 0) return 1;
  return (db - DISPLAY_FLOOR_DB) / -DISPLAY_FLOOR_DB;
}

/** dB compression preserving sign (for signed min/max excursions). */
function compressSigned(v: number): number {
  return v >= 0 ? compressDisplay(v) : -compressDisplay(-v);
}

/**
 * Downsample a decoded buffer to `buckets`, capturing the signed MIN and MAX excursion (the true
 * bipolar waveform envelope) plus the RMS body per bucket, then normalize+compress into the
 * display domain. RMS is clamped to sit inside the excursion so the body reads as a core.
 */
export function bufferToPeaks(buffer: AudioBuffer, buckets: number): HiresPeaks {
  const channel = buffer.getChannelData(0);
  const blockSize = Math.max(1, Math.floor(channel.length / buckets));
  const max = new Float32Array(buckets);
  const min = new Float32Array(buckets);
  const rms = new Float32Array(buckets);
  const absPeak = new Float32Array(buckets); // scratch for the normalization percentile
  let peakAbs = 0;
  for (let i = 0; i < buckets; i += 1) {
    const start = i * blockSize;
    let mx = 0;
    let mn = 0;
    let sumSq = 0;
    let count = 0;
    for (let j = 0; j < blockSize; j += 1) {
      const s = channel[start + j] ?? 0;
      if (s > mx) mx = s;
      if (s < mn) mn = s;
      sumSq += s * s;
      count += 1;
    }
    max[i] = mx;
    min[i] = mn;
    rms[i] = count > 0 ? Math.sqrt(sumSq / count) : 0;
    const a = Math.max(mx, -mn);
    absPeak[i] = a;
    if (a > peakAbs) peakAbs = a;
  }
  // Normalize by the SAME gain (97th percentile of the abs excursion) so max/min/rms keep their
  // relationship, then compress for display and gate silence to a clean thin line.
  const ref = peakPercentile(absPeak, peakAbs, NORM_PERCENTILE);
  const norm = ref > 0 ? 1 / ref : 1;
  const halfFloor = PEAK_FLOOR * 0.5;
  for (let i = 0; i < buckets; i += 1) {
    const mxN = (max[i] ?? 0) * norm;
    const mnN = (min[i] ?? 0) * norm;
    if (Math.max(Math.abs(mxN), Math.abs(mnN)) < SILENCE_GATE_LINEAR) {
      max[i] = halfFloor;
      min[i] = -halfFloor;
      rms[i] = 0;
      continue;
    }
    const mc = Math.min(1, Math.max(halfFloor, compressSigned(mxN)));
    const nc = Math.max(-1, Math.min(-halfFloor, compressSigned(mnN)));
    max[i] = mc;
    min[i] = nc;
    const rc = compressDisplay((rms[i] ?? 0) * norm);
    const bound = Math.min(mc, -nc);
    rms[i] = rc < 0 ? 0 : rc > bound ? bound : rc;
  }
  return { max, min, rms };
}

/**
 * Build a multi-resolution LOD pyramid from a base (finest) overview by repeated pairwise-max
 * halving: level[0] is the base (PEAKS_PER_SECOND), each subsequent level is half the length of
 * the previous (peak-preserving downsample), stopping once a level would fall below
 * MIN_PYRAMID_LEN. Draw-time picks the coarsest level that still has enough samples for the
 * clip's on-screen pixel width, so resampling never has to walk the full base array.
 */
export function buildPyramid(base: HiresPeaks): HiresPeaks[] {
  const levels: HiresPeaks[] = [base];
  let cur = base;
  while (cur.max.length > MIN_PYRAMID_LEN) {
    const n = cur.max.length >> 1;
    if (n < 1) break;
    const max = new Float32Array(n);
    const min = new Float32Array(n);
    const rms = new Float32Array(n);
    for (let i = 0; i < n; i += 1) {
      const a = 2 * i;
      const b = 2 * i + 1;
      max[i] = Math.max(cur.max[a] ?? 0, cur.max[b] ?? 0); // top envelope preserved (max)
      min[i] = Math.min(cur.min[a] ?? 0, cur.min[b] ?? 0); // bottom envelope preserved (min)
      rms[i] = Math.max(cur.rms[a] ?? 0, cur.rms[b] ?? 0);
    }
    cur = { max, min, rms };
    levels.push(cur);
  }
  return levels;
}

/**
 * Resample one hi-res envelope down to `buckets`, preserving the extreme per segment: `mode "max"`
 * keeps the largest value (top/rms envelopes), `mode "min"` keeps the smallest (bottom envelope).
 */
export function resampleOne(hires: Float32Array, buckets: number, mode: "max" | "min" = "max"): number[] {
  if (buckets >= hires.length) {
    // Upsample (zoomed in past 1 sample/px): LINEAR-interpolate up to `buckets` so a per-column draw
    // stays smooth, matching the GL path's LINEAR texture filtering. (Returning the raw samples left
    // the renderer to bridge them, producing a different shape than GL.)
    if (hires.length <= 1) return new Array(buckets).fill(hires[0] ?? 0);
    const out: number[] = new Array(buckets);
    const step = (hires.length - 1) / Math.max(1, buckets - 1);
    for (let i = 0; i < buckets; i += 1) {
      const pos = i * step;
      const lo = Math.floor(pos);
      const hi = Math.min(hires.length - 1, lo + 1);
      const frac = pos - lo;
      out[i] = (hires[lo] ?? 0) * (1 - frac) + (hires[hi] ?? 0) * frac;
    }
    return out;
  }
  const out: number[] = new Array(buckets).fill(0);
  const step = hires.length / buckets;
  for (let i = 0; i < buckets; i += 1) {
    const start = Math.floor(i * step);
    const end = Math.min(hires.length, Math.floor((i + 1) * step));
    let extreme = mode === "max" ? -Infinity : Infinity;
    for (let j = start; j < end; j += 1) {
      const v = hires[j] ?? 0;
      if (mode === "max" ? v > extreme : v < extreme) extreme = v;
    }
    out[i] = Number.isFinite(extreme) ? extreme : 0;
  }
  return out;
}
