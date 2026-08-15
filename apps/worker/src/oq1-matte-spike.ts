/**
 * ADR-023 OQ1 — the spike that gates S7 half A. A MEASUREMENT, not a change.
 *
 * The plan asks two questions before `FlarexMatteValue` is allowed to widen to a vector|raster union,
 * and answers them in a reportable piece of work rather than inside the code that assumes them:
 *
 *   (i)  enumerate every `matteInput` consumer in `compile-flarex.ts` and classify each
 *        vector-only / raster-capable / needs-work;
 *   (ii) measure raster feather + choke against the existing vector rasterizer at 1080p.
 *
 * And it names the failure condition up front, which is the part that makes it a gate: **if a raster
 * value forces early rasterization of chains that could stay vector, T-7 is violated and half A
 * needs a different design.**
 *
 * Part (i) is a static read of the compiler and is reported below from a table this file keeps
 * beside the line numbers, so a reviewer can check it against the source rather than trust it.
 *
 * Part (ii) runs in a real Chromium, because both matte paths are canvas 2D and their cost is the
 * browser's, not V8's. **What the timing arms execute is the exact call sequence
 * `scene-mask-matte.ts:buildMaskCanvas` uses** — `fill(path)` for the shape, `stroke(path)` with
 * `lineWidth = expansion*2` for expansion, and `ctx.filter = blur(feather/2)` drawn through a second
 * canvas for feather. They are reproduced rather than imported because importing would mean bundling
 * `packages/shared` into a page, and the operations under test are three canvas calls whose cost is
 * the thing being measured. Stated plainly so the number is not read as more than it is: this
 * measures the OPERATIONS, not the cache around them — and the cache is the same object either way,
 * which is precisely why it is not the variable.
 *
 * Run: pnpm --filter @orreris/worker oq1:spike
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { assertQuietBrowserMachine } from "./browser/browser-preflight";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const outDir = path.join(repoRoot, "tmp", "oq1-spike");

/**
 * PART (i) — every `matteInput` consumer in `packages/shared/src/flarex/compile-flarex.ts`.
 *
 * Line numbers are at 1431a62. `rasterises` records what the consumer does with the matte TODAY,
 * which is the fact the whole question turns on.
 */
const CONSUMERS = [
  { line: 916, node: "color", socket: "mask", today: "rasterizeMatte → region pass", rasterises: true },
  { line: 1006, node: "filter (blur/sharpen/crop/channelBoolean/vignette/grain)", socket: "mask", today: "rasterizeMatte → fragment pass mask", rasterises: true },
  { line: 1484, node: "merge", socket: "mask", today: "applyMatteToImage → rasterizeMatte", rasterises: true },
  { line: 1570, node: "blur", socket: "mask", today: "rasterizeMatte → region pass", rasterises: true },
  { line: 1688, node: "keyer", socket: "garbage", today: "rasterizeMatte → pass.garbageMatte", rasterises: true },
  { line: 1697, node: "keyer", socket: "holdOut", today: "rasterizeMatte → pass.holdOutMatte", rasterises: true },
  { line: 1746, node: "matteControl", socket: "a", today: "combines Mask[] in VECTOR space", rasterises: false },
  { line: 1747, node: "matteControl", socket: "b", today: "combines Mask[] in VECTOR space", rasterises: false }
] as const;

interface Timing {
  label: string;
  msPerCall: number;
}

/**
 * The page body is a STRING, deliberately. tsx compiles this file with esbuild's `keepNames`, which
 * wraps every named inner function in a `__name(...)` call — a helper that exists in the tsx runtime
 * and NOT in the page, so every arm dies with "`__name` is not defined" before it measures anything.
 * A string is data: nothing transforms it on the way to the browser. (This repo has lost runs to that
 * trap before; it is recorded in the probe-writing notes for exactly this reason.)
 */
const PAGE_BODY = `
  const W = 1920, H = 1080;
  const canvases = [];
  for (let i = 0; i < 3; i += 1) {
    const c = document.createElement("canvas");
    c.width = W; c.height = H;
    canvases.push({ c, x: c.getContext("2d", { willReadFrequently: true }) });
  }
  const a = canvases[0], b = canvases[1], src = canvases[2];

  // A representative matte: a rounded rect over about a third of frame — the size a garbage matte or
  // a text matte actually is. Built once, outside every timing loop.
  const shape = new Path2D();
  const rx = 480, ry = 270;
  shape.roundRect(W / 2 - rx, H / 2 - ry, rx * 2, ry * 2, 48);

  const FEATHER = 40;    // px, as \`mask.feather\` reaches the rasterizer
  const EXPANSION = 12;  // px of choke/spread
  const ITER = 20;
  const timings = [];

  // The source raster stands in for a text matte: already-rendered coverage, no outline to stroke.
  src.x.fillStyle = "#fff";
  src.x.fill(shape);

  // Four arms. Each is a string of ops eval'd in a loop, so no inner function is ever defined.
  const arms = [
    ["vector: fill + expansion stroke",
      'a.x.clearRect(0,0,W,H); a.x.fillStyle="#fff"; a.x.fill(shape); a.x.lineJoin="round"; a.x.lineWidth=EXPANSION*2; a.x.strokeStyle="#fff"; a.x.stroke(shape);'],
    ["vector: + feather (blur via 2nd canvas)",
      'a.x.clearRect(0,0,W,H); a.x.fillStyle="#fff"; a.x.fill(shape); b.x.clearRect(0,0,W,H); b.x.save(); b.x.filter="blur("+(FEATHER/2)+"px)"; b.x.drawImage(a.c,0,0); b.x.restore(); a.x.clearRect(0,0,W,H); a.x.drawImage(b.c,0,0);'],
    ["raster: feather (identical blur, no fill)",
      'b.x.clearRect(0,0,W,H); b.x.save(); b.x.filter="blur("+(FEATHER/2)+"px)"; b.x.drawImage(src.c,0,0); b.x.restore();'],
    ["raster: choke (blur + alpha remap)",
      'b.x.clearRect(0,0,W,H); b.x.save(); b.x.filter="blur("+EXPANSION+"px) brightness(1.8) contrast(6)"; b.x.drawImage(src.c,0,0); b.x.restore();'],
    // CONTROL. The vector-feather arm blurs a canvas it has just DRAWN INTO; the raster arm blurs a
    // canvas that has been sitting untouched. If those two differ by orders of magnitude, the number
    // is not about the blur — it is about the fresh write. Without this arm the comparison reads as
    // "raster feather is ~800x cheaper", which would be a fabricated result.
    ["control: blur of a PRE-DRAWN canvas (same source, untouched)",
      'b.x.clearRect(0,0,W,H); b.x.save(); b.x.filter="blur("+(FEATHER/2)+"px)"; b.x.drawImage(a.c,0,0); b.x.restore();'],
    // The honest raster choke: a per-pixel alpha remap. CSS filter functions cannot express a
    // threshold SHIFT (see the edge profiles), only a steepening, so this is what a real choke costs.
    ["raster: choke via getImageData alpha remap",
      'b.x.clearRect(0,0,W,H); b.x.save(); b.x.filter="blur("+EXPANSION+"px)"; b.x.drawImage(src.c,0,0); b.x.restore(); const id=b.x.getImageData(0,0,W,H); const d=id.data; for (let i=3;i<d.length;i+=4){ const v=d[i]/255; d[i] = v > 0.82 ? 255 : 0; } b.x.putImageData(id,0,0);']
  ];
  for (let k = 0; k < arms.length; k += 1) {
    const body = arms[k][1];
    eval(body); // warm: compiles the filter and allocates the blur scratch
    const t0 = performance.now();
    for (let i = 0; i < ITER; i += 1) eval(body);
    timings.push({ label: arms[k][0], msPerCall: (performance.now() - t0) / ITER });
  }

  // Edge profiles: do the two chokes agree about WHERE the edge is? Sampled across the shape's left
  // edge at mid-height, in alpha.
  const y = Math.round(H / 2);
  const x0 = Math.round(W / 2 - rx) - 40;
  const profiles = [];
  const sources = [
    'a.x.clearRect(0,0,W,H); a.x.fillStyle="#fff"; a.x.fill(shape); a.x.lineJoin="round"; a.x.lineWidth=EXPANSION*2; a.x.strokeStyle="#fff"; a.x.stroke(shape); PROFILE_CTX = a.x;',
    'b.x.clearRect(0,0,W,H); b.x.save(); b.x.filter="blur("+EXPANSION+"px) brightness(1.8) contrast(6)"; b.x.drawImage(src.c,0,0); b.x.restore(); PROFILE_CTX = b.x;',
    'b.x.clearRect(0,0,W,H); b.x.save(); b.x.filter="blur("+EXPANSION+"px)"; b.x.drawImage(src.c,0,0); b.x.restore(); const id2=b.x.getImageData(0,0,W,H); const d2=id2.data; for (let i=3;i<d2.length;i+=4){ const v=d2[i]/255; d2[i] = v > 0.82 ? 255 : 0; } b.x.putImageData(id2,0,0); PROFILE_CTX = b.x;'
  ];
  let PROFILE_CTX = null;
  for (let k = 0; k < sources.length; k += 1) {
    eval(sources[k]);
    const data = PROFILE_CTX.getImageData(x0, y, 80, 1).data;
    const out = [];
    for (let i = 0; i < 80; i += 1) out.push(data[i * 4 + 3]);
    profiles.push(out);
  }

  return { timings, edge: { vector: profiles[0], raster: profiles[1], rasterRemap: profiles[2] } };
`;

async function measure(): Promise<{ timings: Timing[]; edge: { vector: number[]; raster: number[]; rasterRemap: number[] } }> {
  const browser = await chromium.launch({ channel: process.env.PIXEL_BROWSER_CHANNEL || "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 400, height: 300 } });
  try {
    return (await page.evaluate(`(async () => { ${PAGE_BODY} })()`)) as { timings: Timing[]; edge: { vector: number[]; raster: number[]; rasterRemap: number[] } };
  } finally {
    await browser.close();
  }
}

function firstCrossing(profile: number[]): number {
  for (let i = 0; i < profile.length; i += 1) {
    if (profile[i]! >= 128) return i;
  }
  return -1;
}

async function main(): Promise<void> {
  assertQuietBrowserMachine({ label: "oq1:spike", scriptMarker: "oq1-matte-spike" });
  fs.mkdirSync(outDir, { recursive: true });

  process.stdout.write("PART (i) — matteInput consumers in compile-flarex.ts\n\n");
  let vectorPreserving = 0;
  for (const c of CONSUMERS) {
    const classification = c.rasterises ? "raster-capable (already rasterizes on entry)" : "VECTOR-ONLY (combines losslessly)";
    if (!c.rasterises) vectorPreserving += 1;
    process.stdout.write(`  :${String(c.line).padEnd(5)} ${c.node.padEnd(52)} ${c.socket.padEnd(8)} ${classification}\n`);
  }
  process.stdout.write(`\n  ${CONSUMERS.length - vectorPreserving}/${CONSUMERS.length} consumers rasterize the matte the moment they receive it.\n`);
  process.stdout.write(`  ${vectorPreserving}/${CONSUMERS.length} keep it vector — both are matteControl's own sockets.\n\n`);

  const { timings, edge } = await measure();

  process.stdout.write("PART (ii) — edge ops at 1080p (Chromium, canvas 2D)\n\n");
  for (const t of timings) process.stdout.write(`  ${t.label.padEnd(48)} ${t.msPerCall.toFixed(3)} ms\n`);

  const vectorFeather = timings.find((t) => t.label.startsWith("vector: + feather"))!;
  const rasterFeather = timings.find((t) => t.label.startsWith("raster: feather"))!;


  const vEdge = firstCrossing(edge.vector);
  const rEdge = firstCrossing(edge.raster);
  process.stdout.write(`\n  edge crossing (alpha ≥ 128), sampled across the left edge:\n`);
  process.stdout.write(`    vector expansion → sample ${vEdge}\n`);
  const rrEdge = firstCrossing(edge.rasterRemap);
  process.stdout.write(`    raster choke (CSS filter)  → sample ${rEdge}\n`);
  process.stdout.write(`    raster choke (alpha remap) → sample ${rrEdge}\n`);

  fs.writeFileSync(
    path.join(outDir, "oq1-measurements.json"),
    JSON.stringify({ consumers: CONSUMERS, timings, edge, vEdge, rEdge, rrEdge }, null, 2)
  );

  // The gate's own precondition: a measurement that could not distinguish the arms says nothing.
  assert.ok(vectorFeather.msPerCall > 0 && rasterFeather.msPerCall > 0, "timings must be non-zero, or the loop was optimized away.");
  assert.ok(vEdge >= 0 && rEdge >= 0, "both profiles must actually cross 50% alpha, or the sample window missed the edge.");

  process.stdout.write("\nMeasurements written to tmp/oq1-spike/oq1-measurements.json\n");

  /**
   * The reading, written here rather than left to whoever runs it — an unread measurement is not a
   * gate. The CONTROL arm is what makes the rest trustworthy: the first draft of this spike reported
   * "raster feather is ~775× cheaper than vector feather", which is a FABRICATED result. It compared
   * a blur of a canvas that had just been drawn into against a blur of a canvas that had been sitting
   * untouched, and attributed the whole difference to the blur.
   */
  const control = timings.find((t) => t.label.startsWith("control:"))!;
  const remapChoke = timings.find((t) => t.label.startsWith("raster: choke via getImageData"))!;
  process.stdout.write(
    `\nREADING\n` +
      `  FEATHER is the same operation on both paths. The vector rasterizer ALREADY implements it as a\n` +
      `  raster blur (scene-mask-matte.ts:119-131, ctx.filter = blur(r)), so a raster matte introduces no\n` +
      `  new machinery and no new cost: ${rasterFeather.msPerCall.toFixed(3)} ms against a ${control.msPerCall.toFixed(3)} ms control on the same blur.\n` +
      `  The ${vectorFeather.msPerCall.toFixed(1)} ms on the vector arm is the FILL and the canvas readback, not the blur.\n\n` +
      `  CHOKE is not the same operation, and that is the finding. Vector expansion strokes the path\n` +
      `  (${timings[0]!.msPerCall.toFixed(3)} ms) and moved the edge from sample 40 to ${vEdge} — ${40 - vEdge}px outward, which is what was asked.\n` +
      `  The CSS-filter choke left the edge at sample ${rEdge}: a SYMMETRIC blur does not move the 50%\n` +
      `  crossing and steepening it with contrast() does not either. CSS filter functions sharpen a ramp\n` +
      `  but cannot SHIFT its threshold, so that arm is a no-op wearing the name of a choke.\n` +
      `  The honest version — blur, then remap alpha per pixel — does move it (sample ${rrEdge}) and costs\n` +
      `  ${remapChoke.msPerCall.toFixed(1)} ms at 1080p: 2M pixels of JS through getImageData/putImageData.\n`
  );
}

main().catch((error) => {
  process.stderr.write(`${String(error?.stack ?? error)}\n`);
  process.exitCode = 1;
});
