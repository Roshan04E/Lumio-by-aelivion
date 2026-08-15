/**
 * GOLDEN gate for text/shape style emission — "did the emitted CSS change?" at zero tolerance.
 *
 *   pnpm --filter @orreris/shared textstyle:golden            # assert nothing moved
 *   pnpm --filter @orreris/shared textstyle:golden --capture  # re-record (deliberate changes only)
 *
 * WHY THIS EXISTS, AND WHY IT IS THE RIGHT INSTRUMENT FOR S4. ADR-023 S4's acceptance bar is "this
 * stage changes NO pixels". The repo's zero-tolerance picture gate (`render:baseline`) can say that,
 * and it is still run — but it takes minutes, sweeps whole frames, and can only defend the field
 * combinations somebody wrote a FIXTURE for. This gate defends the combinations instead: every
 * renderer in the repo (DOM preview, the scene raster, Remotion) takes its text pixels from
 * `getCompositionTextStyle`/`getCompositionShapeStyle`, so if the emitted style object is
 * byte-identical across a refactor, no renderer can produce a different picture from it. It runs in
 * milliseconds and covers the branch matrix — absent vs explicit, legacy vs pinned, keyframed vs
 * static — which is exactly where a schema migration would go wrong.
 *
 * That is the CLAUDE.md rule about pushing the load-bearing check down to the cheapest instrument that
 * can tell the answers apart, applied to a refactor whose whole claim is "nothing moved".
 *
 * STRICTER THAN CSS EQUIVALENCE, ON PURPOSE. The comparison keeps key ORDER and distinguishes a key
 * whose value is `undefined` from a key that is absent. Neither distinction changes what a browser
 * paints — but `scene-text-raster.ts` builds its content-cache KEY out of this object, so a shape
 * change there is a real change, and "byte-identical" is the claim S4 makes rather than "equivalent".
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getCompositionShapeStyle, getCompositionTextStyle } from "./composition-style";
import type { TimelineLayer } from "./types";

const goldenPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "text-style-css.golden.json");
const capture = process.argv.includes("--capture");

function textLayer(over: Record<string, unknown>): TimelineLayer {
  return {
    id: "t1",
    trackId: "tr1",
    type: "text",
    name: "Text",
    startSeconds: 0,
    durationSeconds: 5,
    text: "Hello world",
    transform: { position: { x: 50, y: 50 }, scale: 1, rotation: 0, opacity: 100 },
    effects: [],
    keyframes: [],
    ...over
  } as unknown as TimelineLayer;
}

const shadowEffect = { id: "e1", type: "shadow", enabled: true, params: {} };
const blurEffect = { id: "e2", type: "blur", enabled: true, params: { amount: 6 } };

/** A `style.*` keyframe pair, so the animated read path is covered and not just the static one. */
function styleKeyframes(property: string, from: number, to: number) {
  return [
    { id: `k1_${property}`, target: { scope: "layer", property }, timeSeconds: 0, value: from, interpolation: "linear" },
    { id: `k2_${property}`, target: { scope: "layer", property }, timeSeconds: 4, value: to, interpolation: "linear" }
  ];
}

/**
 * The branch matrix. Every case is named for the branch it pins, because a failure line should say
 * WHICH distinction moved rather than only that something did.
 */
const cases: Array<{ name: string; layer: TimelineLayer; options?: Record<string, unknown> }> = [
  // --- the legacy shapes: nothing set. The D1a claim lives or dies here. -----------------------
  { name: "text/bare-legacy-layer", layer: textLayer({}) },
  { name: "text/bare-legacy-layer-at-time", layer: textLayer({}), options: { currentTimeSeconds: 2 } },
  { name: "text/empty-style-bag", layer: textLayer({ style: {} }) },

  // --- fonts: legacy stack, style-bag fallback, pinned ref, weight/italic ----------------------
  { name: "text/family-on-layer", layer: textLayer({ fontFamily: "Futura, sans-serif" }) },
  { name: "text/family-in-style-bag", layer: textLayer({ style: { fontFamily: "Futura, sans-serif" } }) },
  {
    name: "text/layer-family-wins-over-style-bag",
    layer: textLayer({ fontFamily: "Layer, sans-serif", style: { fontFamily: "Bag, sans-serif" } })
  },
  { name: "text/weight-and-italic", layer: textLayer({ fontWeight: 300, italic: true }) },
  {
    name: "text/pinned-fontref-overrides-weight",
    layer: textLayer({
      fontWeight: 300,
      italic: true,
      fontRef: { source: "catalogue", family: "Inter", fileHash: "abc123", weight: 700, italic: false, fontFamily: "Inter" }
    })
  },
  {
    name: "text/system-fontref-carries-the-stack",
    layer: textLayer({ fontRef: { source: "system", fontFamily: "Arial, Helvetica, sans-serif" } })
  },

  // --- direction: absent / explicit / auto over Latin and over Arabic --------------------------
  { name: "text/direction-absent", layer: textLayer({ text: "مرحبا بالعالم" }) },
  { name: "text/direction-auto-latin", layer: textLayer({ direction: "auto" }) },
  { name: "text/direction-auto-arabic", layer: textLayer({ direction: "auto", text: "مرحبا بالعالم" }) },
  { name: "text/direction-explicit-rtl", layer: textLayer({ direction: "rtl" }) },
  { name: "text/direction-explicit-ltr", layer: textLayer({ direction: "ltr" }) },
  { name: "text/direction-unrecognised", layer: textLayer({ direction: "sideways" }) },
  { name: "text/direction-in-style-bag", layer: textLayer({ style: { direction: "rtl" } }) },
  { name: "text/direction-auto-over-runs", layer: textLayer({ direction: "auto", textRuns: [{ text: "مرحبا" }, { text: " brand" }] }) },

  // --- alignment: physical, logical, unrecognised ----------------------------------------------
  { name: "text/align-left", layer: textLayer({ textAlign: "left" }) },
  { name: "text/align-start", layer: textLayer({ textAlign: "start" }) },
  { name: "text/align-end-rtl", layer: textLayer({ textAlign: "end", direction: "rtl" }) },
  { name: "text/align-unrecognised", layer: textLayer({ textAlign: "diagonal" }) },

  // --- stroke + paint order: the S1 field, absent / over / under / zero-width ------------------
  { name: "text/stroke-absent-paint-order", layer: textLayer({ strokeWidth: 8, strokeColor: "#ff0000" }) },
  { name: "text/stroke-over", layer: textLayer({ strokeWidth: 8, strokePaintOrder: "over" }) },
  { name: "text/stroke-under", layer: textLayer({ strokeWidth: 8, strokePaintOrder: "under" }) },
  { name: "text/stroke-under-zero-width", layer: textLayer({ strokeWidth: 0, strokePaintOrder: "under" }) },
  { name: "text/stroke-paint-order-in-style-bag", layer: textLayer({ strokeWidth: 8, style: { strokePaintOrder: "under" } }) },

  // --- shadow: the conditional default, explicit values, the shadow effect --------------------
  { name: "text/shadow-none", layer: textLayer({}) },
  { name: "text/shadow-effect-supplies-default-blur", layer: textLayer({ effects: [shadowEffect] }) },
  { name: "text/shadow-explicit", layer: textLayer({ shadowBlur: 12, shadowColor: "#123456", shadowOffsetX: -4, shadowOffsetY: 9 }) },
  { name: "text/shadow-explicit-zero-blur-wins", layer: textLayer({ effects: [shadowEffect], shadowBlur: 0 }) },
  { name: "text/shadow-in-style-bag", layer: textLayer({ style: { shadowBlur: 5, shadowColor: "#abcdef" } }) },

  // --- background box --------------------------------------------------------------------------
  { name: "text/background", layer: textLayer({ backgroundColor: "#101010", backgroundPaddingEm: 0.5, backgroundRadiusEm: 0.75 }) },
  { name: "text/background-in-style-bag", layer: textLayer({ style: { backgroundColor: "#101010", backgroundPaddingEm: 0.5 } }) },

  // --- S5: gradient fill — absent, half-authored, both stops, angle, style bag, texture ---------
  { name: "text/gradient-absent", layer: textLayer({ color: "#ff0000" }) },
  { name: "text/gradient-only-from", layer: textLayer({ fillGradientFrom: "#ff0000" }) },
  { name: "text/gradient-only-to", layer: textLayer({ fillGradientTo: "#0000ff" }) },
  { name: "text/gradient-angle-without-stops", layer: textLayer({ fillGradientAngle: 45 }) },
  { name: "text/gradient-both-stops", layer: textLayer({ fillGradientFrom: "#ff0000", fillGradientTo: "#0000ff" }) },
  { name: "text/gradient-angled", layer: textLayer({ fillGradientFrom: "#ff0000", fillGradientTo: "#0000ff", fillGradientAngle: 45 }) },
  {
    name: "text/gradient-rgba-stops",
    layer: textLayer({ fillGradientFrom: "rgba(255, 0, 0, 0.5)", fillGradientTo: "rgba(0, 0, 255, 0.25)" })
  },
  { name: "text/gradient-in-style-bag", layer: textLayer({ style: { fillGradientFrom: "#ff0000", fillGradientTo: "#0000ff" } }) },

  // --- S5: per-line pill — the no-op case first, because that is the legacy claim ---------------
  { name: "text/per-line-pill-over-transparent", layer: textLayer({ backgroundPerLine: true }) },
  { name: "text/per-line-pill", layer: textLayer({ backgroundPerLine: true, backgroundColor: "#101010" }) },
  {
    name: "text/per-line-pill-with-padding-and-radius",
    layer: textLayer({ backgroundPerLine: true, backgroundColor: "#101010", backgroundPaddingEm: 0.4, backgroundRadiusEm: 0.6 })
  },
  {
    name: "text/per-line-pill-rgba",
    layer: textLayer({ backgroundPerLine: true, backgroundColor: "rgba(16, 16, 16, 0.8)" })
  },
  { name: "text/per-line-pill-false", layer: textLayer({ backgroundPerLine: false, backgroundColor: "#101010" }) },
  { name: "text/per-line-pill-in-style-bag", layer: textLayer({ backgroundColor: "#101010", style: { backgroundPerLine: true } }) },
  {
    name: "text/per-line-pill-and-gradient",
    layer: textLayer({ backgroundPerLine: true, backgroundColor: "#101010", fillGradientFrom: "#ff0000", fillGradientTo: "#0000ff" })
  },

  // --- S5: stacked shadows — 1 must be byte-identical to absent ---------------------------------
  { name: "text/shadow-stack-one", layer: textLayer({ shadowBlur: 10, shadowOffsetY: 6, shadowLayers: 1 }) },
  { name: "text/shadow-stack-absent", layer: textLayer({ shadowBlur: 10, shadowOffsetY: 6 }) },
  { name: "text/shadow-stack-four", layer: textLayer({ shadowBlur: 10, shadowOffsetY: 6, shadowLayers: 4 }) },
  { name: "text/shadow-stack-zero-blur", layer: textLayer({ shadowOffsetY: 6, shadowLayers: 4 }) },
  { name: "text/shadow-stack-extrude", layer: textLayer({ effects: [shadowEffect], shadowBlur: 0.001, shadowOffsetX: 3, shadowOffsetY: 3, shadowLayers: 8 }) },
  { name: "text/shadow-stack-fractional", layer: textLayer({ shadowBlur: 10, shadowOffsetY: 6, shadowLayers: 2.7 }) },
  { name: "text/shadow-stack-in-style-bag", layer: textLayer({ shadowBlur: 10, shadowOffsetY: 6, style: { shadowLayers: 3 } }) },
  {
    name: "text/shadow-stack-animated-offset",
    layer: textLayer({ shadowBlur: 10, shadowLayers: 3, animations: styleKeyframes("style.shadowOffsetY", 0, 20) }),
    options: { currentTimeSeconds: 2 }
  },

  // --- geometry / width / transform / blend / effects ------------------------------------------
  { name: "text/text-width", layer: textLayer({ textWidthPercent: 60 }) },
  { name: "text/text-width-zero", layer: textLayer({ textWidthPercent: 0 }) },
  { name: "text/letter-spacing-zero-emits-nothing", layer: textLayer({ letterSpacing: 0 }) },
  { name: "text/letter-spacing-negative", layer: textLayer({ letterSpacing: -3.5 }) },
  { name: "text/line-height", layer: textLayer({ lineHeight: 1.4 }) },
  { name: "text/blend-mode", layer: textLayer({ blendMode: "screen" }) },
  { name: "text/effects-filter", layer: textLayer({ effects: [blurEffect] }) },
  {
    name: "text/transform-anchor",
    layer: textLayer({ transform: { position: { x: 20, y: 80 }, scale: 1.5, rotation: 12, opacity: 60, anchorX: 0, anchorY: 100 } })
  },

  // --- the animated read path: every keyframable style track ----------------------------------
  {
    name: "text/animated-font-size",
    layer: textLayer({ fontSize: 40, animations: styleKeyframes("style.fontSize", 40, 120) }),
    options: { currentTimeSeconds: 2 }
  },
  {
    name: "text/animated-font-size-no-time",
    layer: textLayer({ fontSize: 40, animations: styleKeyframes("style.fontSize", 40, 120) })
  },
  {
    name: "text/animated-letter-spacing",
    layer: textLayer({ animations: styleKeyframes("style.letterSpacing", 0, 40) }),
    options: { currentTimeSeconds: 1 }
  },
  {
    name: "text/animated-line-height",
    layer: textLayer({ animations: styleKeyframes("style.lineHeight", 1, 2) }),
    options: { currentTimeSeconds: 3 }
  },
  {
    name: "text/animated-stroke-width",
    layer: textLayer({ animations: styleKeyframes("style.strokeWidth", 0, 20) }),
    options: { currentTimeSeconds: 2 }
  },
  {
    name: "text/animated-background-padding-and-radius",
    layer: textLayer({
      animations: [...styleKeyframes("style.backgroundPaddingEm", 0, 1), ...styleKeyframes("style.backgroundRadiusEm", 0, 2)]
    }),
    options: { currentTimeSeconds: 2 }
  },
  {
    name: "text/animated-shadow",
    layer: textLayer({
      animations: [
        ...styleKeyframes("style.shadowBlur", 0, 40),
        ...styleKeyframes("style.shadowOffsetX", 0, 30),
        ...styleKeyframes("style.shadowOffsetY", 0, -30)
      ]
    }),
    options: { currentTimeSeconds: 2 }
  },
  {
    name: "text/animated-text-width",
    layer: textLayer({ animations: styleKeyframes("style.textWidthPercent", 0, 90) }),
    options: { currentTimeSeconds: 2 }
  },
  {
    name: "text/animated-offset-by-layer-start",
    layer: textLayer({ startSeconds: 10, fontSize: 40, animations: styleKeyframes("style.fontSize", 40, 120) }),
    options: { currentTimeSeconds: 12 }
  },

  // --- shapes read the same helpers, so they are pinned here too --------------------------------
  { name: "shape/bare", layer: textLayer({ type: "shape" }) },
  { name: "shape/sized", layer: textLayer({ type: "shape", widthPercent: 30, heightPercent: 60, borderRadius: 9 }) },
  { name: "shape/stroke-and-shadow", layer: textLayer({ type: "shape", strokeWidth: 6, strokeColor: "#00ff00", shadowBlur: 10 }) },
  { name: "shape/kind-in-style-bag", layer: textLayer({ type: "shape", style: { shapeKind: "ellipse", widthPercent: 12 } }) }
];

/**
 * Order-preserving, undefined-preserving serialization. `JSON.stringify` drops `undefined` values,
 * which would make "emits no declaration" and "emits nothing at all" the same string — and those are
 * the two states most of ADR-023's legacy claims are about.
 */
function serialize(value: unknown, depth = 0): string {
  if (value === undefined) return "<undefined>";
  if (value === null) return "null";
  if (Array.isArray(value)) return `[${value.map((entry) => serialize(entry, depth + 1)).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).map(
      ([key, entry]) => `${key}:${serialize(entry, depth + 1)}`
    );
    return `{${entries.join(",")}}`;
  }
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}

const emitted: Record<string, string> = {};
for (const entry of cases) {
  const options = (entry.options ?? {}) as Parameters<typeof getCompositionTextStyle>[1];
  emitted[entry.name] = entry.name.startsWith("shape/")
    ? serialize(getCompositionShapeStyle(entry.layer, options))
    : serialize(getCompositionTextStyle(entry.layer, options));
}

if (capture) {
  fs.writeFileSync(goldenPath, `${JSON.stringify(emitted, null, 2)}\n`, "utf8");
  console.log(`Captured ${Object.keys(emitted).length} style goldens → ${path.basename(goldenPath)}`);
  process.exit(0);
}

if (!fs.existsSync(goldenPath)) {
  console.error(`No golden file at ${goldenPath}. Run with --capture at a commit whose output is trusted.`);
  process.exit(1);
}

const golden = JSON.parse(fs.readFileSync(goldenPath, "utf8")) as Record<string, string>;
let failures = 0;

for (const [name, value] of Object.entries(emitted)) {
  const expected = golden[name];
  if (expected === undefined) {
    console.error(`NEW   ${name} — not in the golden file. Re-capture if this case is intentional.`);
    failures += 1;
  } else if (expected !== value) {
    failures += 1;
    console.error(`FAIL  ${name}`);
    console.error(`        golden: ${expected}`);
    console.error(`        now:    ${value}`);
  } else {
    console.log(`  ok  ${name}`);
  }
}
for (const name of Object.keys(golden)) {
  if (!(name in emitted)) {
    console.error(`GONE  ${name} — a golden case disappeared. Deleting coverage is a decision, not a diff.`);
    failures += 1;
  }
}

if (failures > 0) {
  console.error(`\n${failures} style golden(s) differ. The emitted CSS moved — this is a picture change.`);
  process.exit(1);
}
console.log(`\nAll ${Object.keys(emitted).length} style goldens byte-identical.`);
