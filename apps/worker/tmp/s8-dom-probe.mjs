/**
 * S8 DOM-overlay check (ADR-023 D8).
 *
 *   cd apps/worker && npx tsx tmp/s8-dom-probe.mjs
 *
 * (tsx, not node: this imports `@orreris/shared` from source, and plain node cannot resolve the
 * package's directory re-exports.)
 *
 * WHY THIS EXISTS, and it is S5's lesson taken literally. `render:compare:pixels` compares the two
 * RASTER consumers, which is where the shipped picture comes from — so the editor's DOM text overlay
 * is covered by nothing but "the emitted style is right". S5 shipped a per-line pill whose raster
 * half was correct and whose DOM half painted line two's background over line one's descenders, with
 * every gate green, because no gate compares the DOM overlay to anything at all.
 *
 * The outer ring is the same hazard in a sharper form. The ring is an absolutely-positioned COPY of
 * the text, and a positioned element with `z-index: auto` paints ABOVE non-positioned in-flow
 * content whatever the source order — so without the `position: relative` lift on the real runs, the
 * ring paints straight over the glyphs and the layer renders as a solid slab in the ring's colour.
 * That failure is invisible to every instrument this repo has except this one.
 *
 * WHAT IT ASSERTS, and why it is not a difference assertion (T-15 addendum 3): the DOM is scanned
 * into colour BANDS and matched against the AUTHORED look by colour and order — outer, inner, fill —
 * with the widths read back. That is an equality against the specification, so it fails safe. It is
 * deliberately NOT a comparison against the raster's output: checking two implementations against
 * each other passes when both are wrong the same way, and checking each against the declared answer
 * does not. The raster's half of the same claim is the `multi-stroke` fixture and the ring arms in
 * `text:s5-falsifier`.
 */
import { chromium } from "playwright";
import { PNG } from "pngjs";
import {
  getCompositionTextOuterStrokeStyle,
  getCompositionTextRunStyle,
  getCompositionTextStyle,
  toOuterStrokeRunStyle
} from "@orreris/shared";

const TEXT = "HI";
const layer = (over) => ({
  id: "t1",
  trackId: "tr1",
  type: "text",
  name: "T",
  startSeconds: 0,
  durationSeconds: 5,
  text: TEXT,
  fontFamily: "Arial",
  fontSize: 220,
  fontWeight: 700,
  transform: { position: { x: 50, y: 50 }, scale: 1, rotation: 0, opacity: 100 },
  effects: [],
  keyframes: [],
  ...over
});

const css = (o) =>
  Object.entries(o)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => {
      const prop = k.replace(/([A-Z])/g, "-$1").toLowerCase().replace(/^webkit/, "-webkit");
      const needsPx = typeof v === "number" && !/opacity|weight|height|z-index|inset|flex/i.test(prop);
      return `${prop}:${needsPx ? `${v}px` : v}`;
    })
    .join(";");

/**
 * Build exactly the DOM `VideoPreview` builds for a text layer: the block (minus the non-CSS keys),
 * the ring copy FIRST, then the real runs. Any divergence here makes the probe measure a page nobody
 * ships, so it is kept structurally identical rather than merely similar.
 */
function markup(style) {
  const { textFillGradient: _g, textLinePill: _p, textOuterStroke: _o, ...box } = style;
  const run = getCompositionTextRunStyle({ text: TEXT }, style);
  const ringBox = getCompositionTextOuterStrokeStyle(style);
  const ringRun = toOuterStrokeRunStyle(run);
  const ring = ringBox ? `<span style="${css(ringBox)}"><span style="${css(ringRun)}">${TEXT}</span></span>` : "";
  // `position: relative` on the block so the ring's `inset: 0` resolves against IT, which is what the
  // real preview gets from the layer's own absolute positioning.
  return `<div style="position:absolute;left:40px;top:0;${css(box)}">${ring}<span style="${css(run)}">${TEXT}</span></div>`;
}

const browser = await chromium.launch({ channel: process.env.PIXEL_BROWSER_CHANNEL || "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 900, height: 400 }, deviceScaleFactor: 1 });

/** Scan one row into runs of solid colour, dropping antialiasing slivers and the page background. */
async function bands(over, y) {
  const style = getCompositionTextStyle(layer(over));
  await page.setContent(`<body style="margin:0;background:#111111">${markup(style)}</body>`);
  const png = PNG.sync.read(await page.screenshot());
  const runs = [];
  for (let x = 0; x < png.width; x += 1) {
    const i = (y * png.width + x) * 4;
    const key = `${png.data[i]},${png.data[i + 1]},${png.data[i + 2]}`;
    const last = runs[runs.length - 1];
    if (last && last.key === key) last.n += 1;
    else runs.push({ key, n: 1 });
  }
  return runs.filter((r) => r.n >= 3 && r.key !== "17,17,17");
}

// The authored look: a white fill, a 20px dark-red inner stroke, a 60px yellow ring around it, with
// the strokes UNDER the fill so all three are visible at once. Distinct primaries on purpose — two
// similar colours would let a wrong band pass for a right one.
const LOOK = {
  color: "#ffffff",
  strokeColor: "#cc0000",
  strokeWidth: 20,
  strokePaintOrder: "under",
  strokeOuterColor: "#ffdd00",
  strokeOuterWidth: 60
};
const SCANLINE = 150;

const withRing = await bands(LOOK, SCANLINE);
const noRing = await bands({ ...LOOK, strokeOuterColor: undefined, strokeOuterWidth: undefined }, SCANLINE);

const profile = (b) => b.map((x) => x.key);
const upToFill = (b) => {
  const end = profile(b).indexOf("255,255,255");
  return end >= 0 ? b.slice(0, end + 1) : b;
};
const ringProfile = upToFill(withRing);
const plainProfile = upToFill(noRing);

console.log("with ring:", ringProfile.map((b) => `${b.key}×${b.n}`).join("  |  "));
console.log("no ring:  ", plainProfile.map((b) => `${b.key}×${b.n}`).join("  |  "));

const checks = [];

// 1. THE STRUCTURE. Yellow, then red, then white — in that order, reading inward from the edge.
//    A ring painted OVER the glyphs (the missing-`position: relative` failure) reads as yellow and
//    nothing else, and a ring drawn after the inner stroke reads as yellow-then-white with no red.
checks.push([
  "the DOM paints outer ring → inner stroke → fill, in that order",
  JSON.stringify(profile(ringProfile)) === JSON.stringify(["255,221,0", "204,0,0", "255,255,255"])
]);

// 2. THE WIDTHS. The ring shows (60-20)/2 = 20px, the inner stroke 20/2 = 10px. +-3 for antialiasing,
//    the tolerance the premise probe measured on this same construction.
checks.push([
  "the bands are the authored widths (ring 20px, inner 10px)",
  ringProfile.length === 3 && Math.abs(ringProfile[0].n - 20) <= 3 && Math.abs(ringProfile[1].n - 10) <= 3
]);

// 3. THE INSTRUMENT'S OWN FALSIFIER. Without the ring the same scanline must read red-then-white and
//    nothing else. If it does not, this measurement is not reading the glyph it thinks it is, and
//    check 1 above is describing some other part of the page.
checks.push([
  "VOID CHECK: without the ring the same scanline reads inner stroke → fill",
  JSON.stringify(profile(plainProfile)) === JSON.stringify(["204,0,0", "255,255,255"])
]);

// 4. The ring must not move the GLYPHS. The copy is a layout participant, so an error in its
//    positioning (padding applied twice, a stray offset) shifts the text under it. The fill band's
//    total width is the same measurement in both arms, so it is the cheapest way to see that.
const fillWidth = (b) => b.filter((x) => x.key === "255,255,255").reduce((s, x) => s + x.n, 0);
checks.push([
  "the ring does not shift or resize the glyphs it surrounds",
  Math.abs(fillWidth(withRing) - fillWidth(noRing)) <= 2
]);

await browser.close();

let failed = false;
for (const [name, ok] of checks) {
  console.log(`${ok ? "  ok" : "FAIL"}  ${name}`);
  if (!ok) failed = true;
}
if (failed) {
  console.error(
    "\nThe DOM overlay does not paint the look the raster paints. Both surfaces are checked against the\n" +
      "AUTHORED band profile rather than against each other, so a failure here is the DOM half being\n" +
      "wrong, not the two having drifted."
  );
  process.exit(1);
}
console.log("\nPASS — the DOM overlay paints the same concentric look the raster does, at the authored widths.");
