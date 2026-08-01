/**
 * The shared GLSL hash — one definition, because cross-renderer parity depends on it.
 *
 * ## The bug this replaces (2026-08-01)
 *
 * Every fragment effect and every transition used the classic one-liner:
 *
 * ```glsl
 * float _rand(vec2 co){ return fract(sin(dot(co.xy, vec2(12.9898, 78.233))) * 43758.5453); }
 * ```
 *
 * It is not reproducible across GPUs, and the pixel gate proved it. `stylize-ink` measured 7.857%
 * against a 3.5% bar, `stylize-subject` 8.014%, `stylize-print` 3.261% — and the diff was stochastic
 * speckle confined to the hatch bands, with flat regions clean: both renderers put the bands in the
 * same places and disagreed only on the per-pixel stipple inside them.
 *
 * The cause is `sin` at large arguments. For a 1080×1920 frame, `_rand(floor(uv * uResolution))`
 * feeds `dot` values around 164000. In highp float one ULP at that magnitude is ~0.016, while sin's
 * period is 2π ≈ 6.28 — so a single ULP of input error moves the phase by a quarter of a percent of a
 * full cycle. Multiply by 43758 and take `fract`, and the result is pure noise in the low bits.
 * Worse, GLSL does not specify `sin`'s range-reduction, so two conformant implementations legitimately
 * return different values for the same argument. The web preview runs on the real GPU; the Remotion
 * renderer runs through a different backend. Both were deterministic run-to-run (five runs returned
 * exactly 162930 differing pixels) and disagreed with each other — the signature of a stable
 * per-device difference, not flake.
 *
 * The parity that the gate reported for these fixtures was therefore never real. It was incidental,
 * holding on whichever machine recorded the baseline because the two `sin` implementations happened
 * to agree there. See `project-tracker/infrastructure.md` v3.
 *
 * ## Why this version is reproducible
 *
 * Integer arithmetic. GLSL ES 3.00 specifies `uint` as exactly 32 bits with wraparound on overflow
 * and well-defined shifts, so an integer avalanche hash produces **bit-identical results on every
 * conformant implementation** — unlike any transcendental function. The inputs are quantized to a
 * 1/256 grid first, which keeps the sub-integer variation callers rely on (several pass time-derived
 * or continuous coordinates) while making the quantization itself exact rather than dependent on how
 * a device rounds.
 *
 * The output distribution is statistically equivalent to the old hash, so effects look the same in
 * character — but the *specific* noise pattern changes. That is expected and is not a regression: the
 * pixel gate compares the two renderers against each other, never against a stored golden image, so a
 * different-but-agreeing pattern is exactly the goal.
 *
 * ## Do not fork this
 *
 * It previously existed as two byte-identical copies, in the fragment-effect harness and the
 * transition harness. Two copies of a parity-critical definition is one edit away from the transitions
 * drifting from the effects, which is the same class of bug at one remove. It lives here now, and both
 * harnesses import it.
 */

/**
 * GLSL source for `_rand(vec2) -> float in [0,1)`, and the integer hash behind it.
 *
 * Requires `#version 300 es` (uint support). Both harnesses already declare it.
 */
export const GLSL_HASH_PRELUDE = `
uint _uhash(uvec2 v){
  // Two odd multipliers to decorrelate the axes, then a 32-bit avalanche (Wang/Jenkins-style).
  // Every operation is exact modulo 2^32 by the GLSL ES 3.00 spec, on every conformant device.
  uint h = v.x * 0x9E3779B9u ^ (v.y * 0x85EBCA6Bu + 0x165667B1u);
  h ^= h >> 16u; h *= 0x7FEB352Du;
  h ^= h >> 15u; h *= 0x846CA68Bu;
  h ^= h >> 16u;
  return h;
}
float _rand(vec2 co){
  // Quantize to a 1/256 grid: integer-valued callers (floor(uv * uResolution)) stay distinct, and so
  // do the continuous/time-derived ones, without the result depending on device rounding.
  // int -> uint is defined as modulo 2^32, so negative coordinates are handled without a branch.
  uvec2 q = uvec2(ivec2(floor(co * 256.0)));
  return float(_uhash(q)) * (1.0 / 4294967296.0);
}
`;
