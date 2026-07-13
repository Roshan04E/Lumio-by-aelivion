/**
 * Blend-mode parity test (Method 3, Phase 1).
 *
 * The single GPU compositor blends layers in-shader (`BLEND_GLSL` in packages/shared/src/color/blend.ts)
 * because fixed-function GL blending can't express the separable/non-separable CSS `mix-blend-mode`s.
 * This asserts the JS reference port `blendComposeJs` — which is kept line-for-line with the GLSL — is
 * faithful to the W3C Compositing and Blending Level 1 formulas, and that `BLEND_MODE_INDEX` covers
 * every `BlendMode`. The GLSL itself is verified in a real browser/GPU via the pixel-diff harness; this
 * guards the math that both share.
 */

import assert from "node:assert/strict";
import { BLEND_MODE_INDEX, blendComposeJs, blendModeIndex, type BlendMode, type Rgba } from "@kimera-by-aelivion/shared";

const EPS = 1e-6;
function near(a: Rgba, b: Rgba, msg: string): void {
  for (let i = 0; i < 4; i++) {
    assert.ok(Math.abs(a[i]! - b[i]!) < EPS, `${msg} ch${i}: got ${a[i]}, want ${b[i]}`);
  }
}

// 1. Index coverage: every BlendMode maps to a unique 0..16 index.
const allModes: BlendMode[] = [
  "normal", "multiply", "screen", "overlay", "darken", "lighten", "color-dodge", "color-burn",
  "hard-light", "soft-light", "difference", "exclusion", "hue", "saturation", "color", "luminosity", "add",
];
const seen = new Set<number>();
for (const m of allModes) {
  const idx = blendModeIndex(m);
  assert.equal(idx, BLEND_MODE_INDEX[m], `index mapping for ${m}`);
  assert.ok(idx >= 0 && idx <= 16, `index in range for ${m}`);
  assert.ok(!seen.has(idx), `index unique for ${m}`);
  seen.add(idx);
}
assert.equal(seen.size, 17, "17 distinct blend indices");

// 2. Known-value checks against the W3C formulas (both fully opaque).
const cb: Rgba = [0.2, 0.4, 0.6, 1];
const cs: Rgba = [0.8, 0.5, 0.1, 1];

near(blendComposeJs(0, cb, cs), [0.8, 0.5, 0.1, 1], "normal = source");
near(blendComposeJs(1, cb, cs), [0.16, 0.2, 0.06, 1], "multiply");
near(blendComposeJs(2, cb, cs), [0.84, 0.7, 0.64, 1], "screen");
near(blendComposeJs(4, cb, cs), [0.2, 0.4, 0.1, 1], "darken = min");
near(blendComposeJs(5, cb, cs), [0.8, 0.5, 0.6, 1], "lighten = max");
near(blendComposeJs(10, cb, cs), [0.6, 0.1, 0.5, 1], "difference = |b-s|");
near(blendComposeJs(16, cb, cs), [1.0, 0.9, 0.7, 1], "add = b+s clamped by alpha");

// 3. Alpha compositing: src over an empty (transparent) backdrop = src.
near(blendComposeJs(0, [0, 0, 0, 0], [0.5, 0.5, 0.5, 0.5]), [0.5, 0.5, 0.5, 0.5], "src over empty");

// 4. Fully transparent src leaves the backdrop unchanged, in every mode.
for (const m of allModes) {
  near(blendComposeJs(blendModeIndex(m), cb, [0.9, 0.1, 0.3, 0]), cb, `transparent src no-op (${m})`);
}

console.log("blend-parity-test: OK");
