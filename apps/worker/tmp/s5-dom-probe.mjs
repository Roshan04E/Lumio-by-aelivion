/**
 * S5 DOM-overlay check. The pixel gate compares the two RASTER consumers (which is where the shipped
 * picture comes from), so the editor's DOM text overlay — the non-scene fallback — is covered only at
 * the emitted-CSS level. This paints the ACTUAL emitted objects in Chrome and asserts the pixels move,
 * so "the declaration is right" is not the last word on a surface a user can still see.
 *
 *   node apps/worker/tmp/s5-dom-probe.mjs
 */
import { chromium } from "playwright";
import {
  getCompositionTextLinePillStyle,
  getCompositionTextRunStyle,
  getCompositionTextStyle
} from "@orreris/shared";

const layer = (over) => ({
  id: "t1", trackId: "tr1", type: "text", name: "T", startSeconds: 0, durationSeconds: 5,
  text: "Save this now", fontSize: 90, textWidthPercent: 40,
  transform: { position: { x: 50, y: 50 }, scale: 1, rotation: 0, opacity: 100 },
  effects: [], keyframes: [], ...over
});

/** Build the DOM the preview builds: block (minus the two non-CSS keys) > optional pill wrapper > runs. */
function markup(style) {
  const { textFillGradient, textLinePill, ...box } = style;
  const run = getCompositionTextRunStyle({ text: "Save this now" }, style);
  const pill = getCompositionTextLinePillStyle(style);
  const css = (o) => Object.entries(o).filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k.replace(/([A-Z])/g, "-$1").toLowerCase().replace(/^webkit/, "-webkit")}:${typeof v === "number" && !/opacity|weight|height/i.test(k) ? `${v}px` : v}`).join(";");
  const runSpan = `<span style="${css(run)}">Save this now</span>`;
  return `<div style="position:absolute;${css(box)}">${pill ? `<span style="${css(pill)}">${runSpan}</span>` : runSpan}</div>`;
}

const browser = await chromium.launch({ channel: process.env.PIXEL_BROWSER_CHANNEL || "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 700, height: 320 } });

const shot = async (over) => {
  const style = getCompositionTextStyle(layer(over));
  await page.setContent(`<body style="margin:0;background:#111">${markup(style)}</body>`);
  return (await page.screenshot()).toString("base64");
};

const plain = await shot({ color: "#ffffff" });
const gradient = await shot({ color: "#ffffff", fillGradientFrom: "#ff2d55", fillGradientTo: "#00e5ff", fillGradientAngle: 45 });
const blockPill = await shot({ backgroundColor: "#f5d90a", color: "#000000" });
const linePill = await shot({ backgroundColor: "#f5d90a", color: "#000000", backgroundPerLine: true });

const results = [
  ["gradient paints in the DOM", gradient !== plain],
  ["per-line pill differs from the block pill", linePill !== blockPill]
];
let failed = false;
for (const [name, ok] of results) {
  console.log(`${ok ? "  ok" : "FAIL"}  ${name}`);
  if (!ok) failed = true;
}
await page.setContent(`<body style="margin:0;background:#111">${markup(getCompositionTextStyle(layer({ backgroundColor: "#f5d90a", color: "#000000", backgroundPerLine: true })))}</body>`);
await page.screenshot({ path: "tmp/s5-dom-per-line-pill.png" });
await browser.close();
if (failed) process.exit(1);
console.log("\nDOM overlay paints both S5 looks. Still: tmp/s5-dom-per-line-pill.png");
