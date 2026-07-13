/**
 * Grade intent compiler test.
 *
 * Covers packages/shared/src/color/grade-intent.ts — the deterministic expansion of a compact
 * AI GradeIntent into a stack of real, editable color effects. Asserts the intent → effect-param
 * mapping (wheels/curves/secondary JSON), clamping, ordering, and identity guards.
 */

import assert from "node:assert/strict";
import {
  compileGradeIntent,
  gradeIntentIsEmpty,
  gradeIntentSchema,
  type ChannelCurves,
  type ColorWheels,
  type HslSecondary,
  type HueSatCurves
} from "@kimera-by-aelivion/shared";

// 1. Empty intent → no effects.
{
  assert.deepEqual(compileGradeIntent({}), []);
  assert.equal(gradeIntentIsEmpty({}), true);
}

// 2. Teal & orange balance → colorWheels with teal-pushed shadows and orange-pushed highlights.
{
  const stack = compileGradeIntent({
    balance: { shadows: { hue: "teal", strength: 0.5 }, highlights: { hue: "orange", strength: 0.4 } }
  });
  const wheelsGrade = stack.find((s) => s.effectType === "colorWheels");
  assert.ok(wheelsGrade, "expected a colorWheels effect");
  const wheels = JSON.parse(wheelsGrade!.params.wheels as string) as ColorWheels;
  // teal center = 0.5 turn → angle 180° → cos<0 (x negative), highlights orange (0.06 turn) → x positive.
  assert.ok(wheels.shadows.x < 0, "teal shadows push x negative");
  assert.ok(wheels.highlights.x > 0, "orange highlights push x positive");
  assert.ok(Math.abs(wheels.midtones.x) < 1e-9 && Math.abs(wheels.midtones.y) < 1e-9, "midtones untouched");
}

// 3. Tone with crush + contrast → colorCurves master that is monotonic and non-identity.
{
  const stack = compileGradeIntent({ tone: { crush: 0.4, contrast: 0.3 } });
  const curveGrade = stack.find((s) => s.effectType === "colorCurves");
  assert.ok(curveGrade, "expected a colorCurves effect");
  const curves = JSON.parse(curveGrade!.params.curve as string) as ChannelCurves;
  const m = curves.master!;
  assert.ok(m.length >= 3, "master curve has control points");
  for (let i = 1; i < m.length; i += 1) {
    assert.ok(m[i]!.x >= m[i - 1]!.x, "points sorted by x");
    assert.ok(m[i]!.y >= m[i - 1]!.y - 1e-9, "master curve is non-decreasing (monotonic)");
  }
  assert.ok(m.some((p) => Math.abs(p.x - p.y) > 1e-3), "curve is not the identity line");
}

// 4. Secondary isolate skin, desaturate → one hslSecondary keyed near skin with satScale < 1.
{
  const stack = compileGradeIntent({ secondary: [{ target: "skin", sat: -0.6 }] });
  const secGrade = stack.find((s) => s.effectType === "hslSecondary");
  assert.ok(secGrade, "expected an hslSecondary effect");
  const sec = JSON.parse(secGrade!.params.secondary as string) as HslSecondary;
  assert.ok(Math.abs(sec.hueCenter - 0.05) < 1e-6, "keyed at the skin hue center");
  assert.ok(sec.satScale < 1, "desaturates the keyed range");
}

// 5. Hue-selective adjust → hueSatCurves with a non-flat hueVsSat around the target.
{
  const stack = compileGradeIntent({ hue: [{ target: "blue", sat: 0.5 }] });
  const hueGrade = stack.find((s) => s.effectType === "hueSatCurves");
  assert.ok(hueGrade, "expected a hueSatCurves effect");
  const curves = JSON.parse(hueGrade!.params.curves as string) as HueSatCurves;
  assert.ok(curves.hueVsSat!.some((p) => Math.abs(p.y - 0.5) > 1e-3), "hueVsSat has a non-neutral bump");
}

// 6. Full stack ordering: primary → tone → wheels → hue → secondary.
{
  const stack = compileGradeIntent({
    primary: { contrast: 20 },
    tone: { contrast: 0.2 },
    balance: { shadows: { hue: "blue", strength: 0.3 } },
    hue: [{ target: "green", sat: -0.3 }],
    secondary: [{ target: "sky", sat: 0.3 }]
  });
  assert.deepEqual(
    stack.map((s) => s.effectType),
    ["brightnessContrast", "colorCurves", "colorWheels", "hueSatCurves", "hslSecondary"]
  );
}

// 7. Clamping: an out-of-range primary saturation is clamped into [0,220].
{
  const stack = compileGradeIntent({ primary: { saturation: 500 } });
  const primary = stack.find((s) => s.effectType === "brightnessContrast");
  assert.equal(primary!.params.saturation, 220);
}

// 8. A look base compiles a brightnessContrast primary.
{
  const stack = compileGradeIntent({ look: "Noir" });
  assert.ok(stack.some((s) => s.effectType === "brightnessContrast"), "look yields a primary correction");
}

// 9. Schema rejects unknown keys / bad hue names (strict).
{
  assert.equal(gradeIntentSchema.safeParse({ nope: 1 }).success, false);
  assert.equal(gradeIntentSchema.safeParse({ hue: [{ target: "chartreuse" }] }).success, false);
  assert.equal(gradeIntentSchema.safeParse({ balance: { shadows: { hue: "teal", strength: 0.5 } } }).success, true);
}

console.log("grade-intent-test: OK");
