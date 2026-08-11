/**
 * COVERAGE-AWARE ROUTING for partial (prefix) source proxies.
 * 2026-08-11, Slice 3 of `plans/source-proxy-progressive.md`.
 *
 * ── The defect this file exists to make impossible ──────────────────────────────────────────────
 *
 * A partial proxy is, to the decoder, a TRUNCATED file. `chunkIndexForMicros` (webcodecs-decoder.ts)
 * clamps any time past the final sample to the last index entry, so `getFrame` keeps serving the
 * same last frame forever — never null, so nothing heals, nothing falls back, nothing reports it.
 * That is the frozen tail this repo has already shipped twice (SOURCE_PROXY_VERSION v4 and v5), and
 * routing a layer to a proxy that stops before the layer does would ship it a third time.
 *
 * The structural answer, rather than a hopeful one: **a layer may only be routed to a partial proxy
 * when every source time it can EVER request is already inside coverage.** Then the clamp region is
 * unreachable by construction — not avoided at runtime, not detected and recovered from, simply
 * never addressed. Everything else here is in service of computing "can ever request" honestly.
 *
 * Consequences worth stating plainly, because they bound what this feature delivers:
 *   - The gate is per LAYER, not per TIME. A layer's URL is fixed for its whole extent, so playback
 *     can never cross a coverage boundary mid-clip; there is no boundary to cross. This is also what
 *     keeps `resolvePlaybackUrl` returning one stable URL and keeps the routing decision and the
 *     decode-path decision (`preferNativeDecode`) the same decision.
 *   - A layer spanning the WHOLE source therefore gains nothing until the build is essentially done.
 *     Trimmed clips — which is what a timeline becomes after any real editing — gain immediately.
 *   - AUDIO layers are excluded outright: the prefix mux is video-only (see sourceProxyPrefixMux.ts),
 *     so routing an audio layer there would silently mute it.
 */

import { getLayerSpeed, layerSourceTimeSeconds, type TimelineLayer } from "@orreris/shared";

/**
 * Safety margin, in source seconds, between the furthest time a layer can request and the end of
 * coverage. Two things eat into the nominal end — the proxy is sampled at the source's own cadence
 * so a frame boundary can land fractionally past a computed time, and a trailing segment can be
 * short — and the cost of being wrong is a frozen tail while the cost of being conservative is one
 * more segment of waiting. 0.5s ≈ 15 frames at 30fps, comfortably more than one GOP.
 */
const COVERAGE_MARGIN_SECONDS = 0.5;

/** Samples used to bound a SPEED-RAMPED layer, whose source time is not monotonic in local time. */
const RAMP_SAMPLES = 33;

/**
 * The furthest source time this layer can ever ask its media for.
 *
 * Constant-speed layers have a closed form. Ramped/reversed layers do not — `layerSourceTimeSeconds`
 * integrates a signed rate, so the maximum can sit anywhere inside the clip — and those are sampled
 * rather than reasoned about. Sampling is an UPPER-BOUND estimate only if it is dense enough to
 * catch the peak; the margin above absorbs the residual, and a ramp that defeats both simply leaves
 * the layer on the original, which is today's behaviour.
 */
export function maxSourceTimeSeconds(layer: TimelineLayer): number {
  const duration = Math.max(0, layer.durationSeconds);
  const hasRamp = Array.isArray(layer.speedKeyframes) && layer.speedKeyframes.length > 0;
  if (!hasRamp) {
    // `layerSourceTimeSeconds` clamps negative local time to 0, so a transition preroll (which
    // renders the layer before its start) cannot reach below sourceIn — no extra allowance needed.
    const speed = Math.abs(getLayerSpeed(layer)) || 1;
    return Math.max(0, (layer.sourceInSeconds ?? 0) + duration * speed);
  }
  let max = 0;
  for (let i = 0; i < RAMP_SAMPLES; i += 1) {
    const local = (duration * i) / (RAMP_SAMPLES - 1);
    const source = layerSourceTimeSeconds(layer, local);
    if (Number.isFinite(source) && source > max) max = source;
  }
  return max;
}

/**
 * May this layer play from a partial proxy covering `[0, coverageSeconds)`?
 *
 * Deliberately answers NO for anything it cannot bound — no coverage, a non-video layer, a
 * non-finite range. Every "no" costs the user nothing: the layer keeps the original, which is the
 * behaviour it has today and would have had for the rest of the build anyway.
 */
export function layerFitsCoverage(layer: TimelineLayer | undefined, coverageSeconds: number | undefined): boolean {
  if (!layer || layer.type !== "video") return false;
  if (coverageSeconds === undefined || !Number.isFinite(coverageSeconds) || coverageSeconds <= 0) return false;
  const max = maxSourceTimeSeconds(layer);
  if (!Number.isFinite(max)) return false;
  return max + COVERAGE_MARGIN_SECONDS <= coverageSeconds;
}
