/**
 * ADR-023 OQ2 PRECONDITION probe (S5).
 *
 * OQ2 asks whether the two Chromiums instance a variable axis identically. That question is only
 * reachable if the path both renderers actually paint from can express a variable axis AT ALL — and
 * since S0c/T-13's correction, that path is the canvas raster in `scene/text-shape.ts`, not the DOM.
 * So this probe asks the prior question first.
 *
 *   node apps/worker/tmp/oq2-probe.mjs
 *
 * Note on the first draft of this file, because it is the exact trap ADR-023's own measurement rules
 * warn about: it tested `"fontVariationSettings" in ctx` AFTER assigning `ctx.fontVariationSettings`,
 * so it reported `true` and read the value back — from the expando it had just created itself. The
 * instrument was measuring its own writes. The authority is the PROTOTYPE, which is the IDL.
 */
import { chromium } from "playwright";

const browser = await chromium.launch({ channel: process.env.PIXEL_BROWSER_CHANNEL || "chrome", headless: true });
const page = await browser.newPage();
const out = await page.evaluate(() => {
  const ctx = document.createElement("canvas").getContext("2d");
  const proto = Object.getPrototypeOf(ctx);
  const fontProps = Object.getOwnPropertyNames(proto).filter((n) => /font|variat|stretch|variant/i.test(n));

  // A. The IDL: is there any property that carries variation settings onto a canvas draw?
  const hasVariationProperty = fontProps.includes("fontVariationSettings");

  // B. The other conceivable route — the `font` shorthand. CSS's shorthand does not include
  //    variation settings, so an inline declaration should be rejected and leave `font` unchanged.
  ctx.font = "700 40px sans-serif";
  const before = ctx.font;
  ctx.font = "700 40px sans-serif; font-variation-settings: 'wght' 250";
  const shorthandRejectsVariations = ctx.font === before;

  // C. FALSIFY THE INSTRUMENT. A "nothing changed" result is worthless unless this measurement can
  //    detect a font change when there IS one. Two things a canvas CAN express — weight and stretch —
  //    must move `measureText`, or the probe is blind and its negative result means nothing.
  const widthAt = (font) => {
    ctx.font = font;
    return ctx.measureText("Hamburgefonstiv").width;
  };
  const weightMovesWidth = widthAt("100 40px sans-serif") !== widthAt("900 40px sans-serif");
  ctx.font = "400 40px sans-serif";
  const stretchNormal = ctx.measureText("Hamburgefonstiv").width;
  ctx.fontStretch = "ultra-condensed";
  const stretchMovesWidth = ctx.measureText("Hamburgefonstiv").width !== stretchNormal;

  return { fontProps, hasVariationProperty, shorthandRejectsVariations, weightMovesWidth, stretchMovesWidth };
});

console.log(JSON.stringify(out, null, 2));
const blind = !out.weightMovesWidth && !out.stretchMovesWidth;
if (blind) {
  console.error("\nVOID: the instrument detected no font change at all — its negative result proves nothing.");
} else if (!out.hasVariationProperty && out.shorthandRejectsVariations) {
  console.log(
    "\nOQ2 is UNREACHABLE from the raster: canvas 2D exposes no font-variation-settings and its `font`\n" +
      "shorthand rejects one, while the same context DOES respond to weight/stretch — so the negative is\n" +
      "the API's, not the probe's. Variable axes cannot ship through the path both renderers paint from."
  );
} else {
  console.log("\nOQ2 is reachable — canvas can carry a variable axis. Measure the two Chromiums next.");
}
await browser.close();
