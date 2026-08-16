/**
 * ADR-023 S9b SPIKE — what does ANIMATING a variable axis actually cost, and at what quantization
 * does the banding stop being visible?
 *
 *   cd apps/worker && npx tsx tmp/s9b-axis-cost-probe.mjs
 *
 * ## The trap, stated before it is measured
 *
 * S9a's design is what makes S9b expensive. An axis instance is a **separately registered family** —
 * that is the only route to the canvas raster, and it is why S9a is clean. But a continuously
 * animated axis therefore wants a face per sampled value: at 30fps a three-second reveal is 90
 * distinct coordinates, and every one of them is a `FontFace` to construct, load and add.
 *
 * So the answer is not "animate it", it is "quantize to N steps" — and N must be MEASURED against
 * visible banding rather than picked because it sounds reasonable. Two numbers are needed and they
 * pull in opposite directions:
 *
 *   ARM 1 — the registration COST CURVE. How long does registering N instances take, and is that
 *     cost the axis or the bytes? Answered with a control: N faces of the SAME file with NO
 *     `variationSettings` at all. If the plain and instanced curves match, registration cost is
 *     parsing the file N times and instancing is free — which changes the fix (share the parse)
 *     rather than merely lowering N.
 *
 *   ARM 2 — the BANDING FLOOR. Quantization is invisible while the step between adjacent coordinates
 *     moves a glyph edge by less than the antialiasing can absorb. So: the smallest axis delta that
 *     displaces an edge by a whole device pixel. Below that, adjacent steps differ by a sub-pixel
 *     amount and the AA gradient swallows the step; at or above it, an edge visibly jumps.
 *
 * ## Why the banding answer is a CURVE and not a constant
 *
 * A `wght` delta moves a stem by a distance proportional to the em size, so the same N that is
 * invisible at 24px bands badly at 200px. Measuring at one size and shipping the number would be the
 * measurement equivalent of the bugs this ADR keeps recording. Measured at three sizes, and reported
 * as a curve.
 *
 * ## Controls (T-15 addendum 3 — every claim here is a difference or a threshold, and both fail open)
 *
 *   - The FILE control: the fixture must expose a real `wght` range, or "adjacent steps look
 *     identical" is what a STATIC file produces and the banding floor would come out as "N=1".
 *   - The instancing control: two coordinates at the extremes must produce visibly different ink, or
 *     the whole probe is measuring a face that never instanced (the exact fault the OQ6 spike's SVG
 *     arm hit — it reported "the axis is ignored" while the face had never loaded).
 *   - The cost control: the no-axis curve above, which is what separates "instancing is expensive"
 *     from "reading a font file is expensive".
 */
import { readFileSync } from "node:fs";
import { chromium } from "playwright";

/**
 * Arimo-Regular, which ships in this repo and is VARIABLE (`wght` 400–700) — the same fixture
 * `font:axis-falsifier` uses. No network, and the face under test is one the product renders with.
 */
const ARIMO = readFileSync("../web/public/fonts/Arimo-Regular.ttf").toString("base64");

const browser = await chromium.launch({ channel: process.env.PIXEL_BROWSER_CHANNEL || "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1200, height: 400 }, deviceScaleFactor: 1 });

const out = await page.evaluate(async (B64) => {
  const bytes = Uint8Array.from(atob(B64), (c) => c.charCodeAt(0)).buffer;
  const AXIS_MIN = 400;
  const AXIS_MAX = 700;
  const TEXT = "Hamburgefonstiv";

  /** Register one instanced face under a unique alias, exactly as S9a does. */
  const registerInstance = async (alias, wght) => {
    const face = new FontFace(alias, bytes, wght == null ? {} : { variationSettings: `'wght' ${wght}` });
    await face.load();
    document.fonts.add(face);
    return face;
  };

  const drop = (faces) => {
    for (const f of faces) {
      try {
        document.fonts.delete(f);
      } catch {
        /* already gone */
      }
    }
  };

  // --- ARM 1: the registration cost curve -------------------------------------------------------
  //
  // Measured as WALL TIME for the whole batch, because that is what a render actually waits on, and
  // reported per face as well because that is what scales. Each N is run on a clean font set so a
  // later N never inherits an earlier one's already-parsed faces.
  const cost = [];
  let seq = 0;
  for (const n of [1, 2, 4, 8, 16, 32, 64, 128]) {
    for (const instanced of [true, false]) {
      const faces = [];
      const t0 = performance.now();
      for (let i = 0; i < n; i += 1) {
        const wght = AXIS_MIN + ((AXIS_MAX - AXIS_MIN) * i) / Math.max(1, n - 1);
        // The alias is unique per registration so nothing is deduplicated by the font set — this
        // measures N registrations, which is what an animation would actually perform.
        seq += 1;
        faces.push(await registerInstance(`S9BCost${seq}`, instanced ? Math.round(wght * 100) / 100 : null));
      }
      const ms = performance.now() - t0;
      cost.push({ n, instanced, totalMs: Math.round(ms * 100) / 100, perFaceMs: Math.round((ms / n) * 1000) / 1000 });
      drop(faces);
    }
  }

  // --- ARM 2: the banding floor ------------------------------------------------------------------
  //
  // The instrument: rasterize the run at a given `wght`, then read the x-position of every INK EDGE
  // along a horizontal scanline through the middle of the glyphs. Two coordinates band visibly when
  // some edge has moved by a whole device pixel; below that the step is sub-pixel and the
  // antialiasing gradient absorbs it. Edges rather than ink AREA on purpose — area changes smoothly
  // and continuously with weight, so it can report a difference where nothing is visible.
  const W = 1100;
  const H = 300;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });

  /** Sub-pixel edge positions along one scanline, from the antialiased alpha ramp. */
  const edgesAt = async (alias, size) => {
    ctx.clearRect(0, 0, W, H);
    ctx.font = `${size}px ${alias}`;
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = "#000";
    ctx.fillText(TEXT, 10, H * 0.7);
    // Through the x-height, where stems are vertical and an edge is a clean transition.
    const y = Math.round(H * 0.7 - size * 0.25);
    const row = ctx.getImageData(0, y, W, 1).data;
    const alpha = (x) => row[x * 4 + 3] / 255;
    const edges = [];
    for (let x = 1; x < W; x += 1) {
      const a = alpha(x - 1);
      const b = alpha(x);
      if (a < 0.5 && b >= 0.5) {
        // Linear interpolation across the AA ramp gives a sub-pixel edge, so a displacement smaller
        // than one pixel is measurable rather than quantized away by the instrument itself.
        edges.push(x - 1 + (0.5 - a) / Math.max(1e-6, b - a));
      } else if (a >= 0.5 && b < 0.5) {
        edges.push(x - 1 + (a - 0.5) / Math.max(1e-6, a - b));
      }
    }
    return { edges, ink: [...row].filter((_, i) => i % 4 === 3).reduce((s, v) => s + v, 0) };
  };

  /**
   * Largest edge displacement between two axis coordinates at one size.
   *
   * Returns `null` when the two rasters have a DIFFERENT NUMBER of edges, and that is not a
   * defensive nicety — it is the instrument refusing to lie. Edges are matched by index, so a
   * counter that closes or a stem that merges at a heavier weight shifts every subsequent index by
   * one and turns a sub-pixel comparison into a garbage number the size of a glyph. A changed edge
   * count is itself a visible topological change, so `null` is reported as banding rather than
   * quietly averaged away over `Math.min(a.length, b.length)`.
   */
  const maxShift = (a, b) => {
    if (!a.length || !b.length) return null;
    /**
     * NEAREST-NEIGHBOUR, not index-matched — and the first version of this probe was index-matched
     * and produced a PLATEAU because of it: 72px sat at ~26px of "shift" however fine the steps got,
     * which is impossible for quantization and was the instrument, not the font. Equal edge COUNTS
     * do not mean the same features: one edge appearing while another disappears keeps the count
     * pinned (it stayed at 50 across every step) while shifting every pairing after it by one, so an
     * index comparison then measures the gap between a stem and its neighbour rather than how far
     * that stem moved.
     *
     * Matching each edge to its closest partner is correspondence-free and answers the question
     * actually being asked — "did any feature MOVE by a visible amount" — and a partner further away
     * than half the minimum edge gap is not a match at all, which is reported as a topology change
     * rather than as a large displacement.
     */
    /**
     * The matching radius is a MEDIAN gap, not a minimum, and generous. A first version used
     * `max(1, minGap/2)`: one thin counter anywhere in the string drove `minGap` to ~2px, the radius
     * clamped to 1px, and then ANY displacement above a pixel came back "unmatched" — so the probe
     * reported a topology change for every coarse step and could not measure the one quantity it
     * exists to measure. The radius must be wide enough to admit the displacements being measured
     * and narrow enough to reject a different feature; half a typical inter-edge gap is that, and the
     * median makes it robust to a single narrow counter.
     */
    const gaps = [];
    for (const arr of [a, b]) for (let i = 1; i < arr.length; i += 1) gaps.push(arr[i] - arr[i - 1]);
    gaps.sort((p, q) => p - q);
    const medianGap = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 8;
    const limit = Math.max(3, medianGap * 0.45);
    let worst = 0;
    for (const x of a) {
      let best = Infinity;
      for (const y of b) best = Math.min(best, Math.abs(x - y));
      if (best > limit) return null;
      worst = Math.max(worst, best);
    }
    return worst;
  };

  const sizes = [24, 72, 200];
  const banding = [];
  const instancingControl = [];
  let aliasSeq = 0;
  for (const size of sizes) {
    // The instancing control at THIS size: the two extremes must differ, or every "no shift"
    // reading below is what a face that never instanced produces.
    aliasSeq += 1;
    await registerInstance(`S9BLo${aliasSeq}`, AXIS_MIN);
    await registerInstance(`S9BHi${aliasSeq}`, AXIS_MAX);
    const lo = await edgesAt(`S9BLo${aliasSeq}`, size);
    const hi = await edgesAt(`S9BHi${aliasSeq}`, size);
    /**
     * The control reads INK, not edge shift — because ink survives the one thing edge-matching
     * cannot: a topology change. Across the FULL 400→700 range a counter can close or two stems can
     * merge, which changes the edge count and makes an index-matched comparison meaningless exactly
     * where the control most needs an answer. "The heavy instance lays down materially more ink than
     * the light one" is the direct statement of "the face instanced", and it holds regardless.
     */
    instancingControl.push({
      size,
      extremeShiftPx: maxShift(lo.edges, hi.edges),
      loEdges: lo.edges.length,
      hiEdges: hi.edges.length,
      loInk: lo.ink,
      hiInk: hi.ink,
      inkRatio: lo.ink > 0 ? hi.ink / lo.ink : null
    });

    // Walk N upward; for each N, the worst shift between ADJACENT quantization steps. Banding is
    // gone once that worst adjacent step is below one device pixel.
    const perN = [];
    for (const n of [2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64]) {
      const step = (AXIS_MAX - AXIS_MIN) / (n - 1);
      let worst = 0;
      let topologyJumps = 0;
      let fallbacks = 0;
      const inks = [];
      const edgeCounts = [];
      let prev = null;
      for (let i = 0; i < n; i += 1) {
        const wght = Math.round((AXIS_MIN + step * i) * 100) / 100;
        aliasSeq += 1;
        const alias = `S9BBand${aliasSeq}`;
        await registerInstance(alias, wght);
        /**
         * PER-STEP FALLBACK CHECK, added after the first run produced a PLATEAU — 72px sat at ~26px
         * of "shift" no matter how fine the quantization got. A displacement that does not respond
         * to quantization is not quantization; the likely cause is a face that failed to resolve, so
         * `ctx.font` silently fell back to the default family and the "shift" is the distance between
         * two entirely different typefaces. This probe registers hundreds of faces, which is exactly
         * the regime where that starts happening.
         *
         * `document.fonts.check` answers whether THIS alias is usable at this size, and the ink is
         * recorded alongside because a fallback also shows up as ink outside the family's own range.
         */
        if (!document.fonts.check(`${size}px ${alias}`)) fallbacks += 1;
        const m = await edgesAt(alias, size);
        inks.push(m.ink);
        edgeCounts.push(m.edges.length);
        if (prev) {
          const s = maxShift(prev, m.edges);
          // `null` = the edge COUNT changed between two ADJACENT steps, which is a visible
          // topological jump and strictly worse than any sub-pixel displacement. Counted as its own
          // outcome rather than folded into `worst`, so a floor is never declared on the strength of
          // a comparison that could not be made.
          if (s == null) topologyJumps += 1;
          else worst = Math.max(worst, s);
        }
        prev = m.edges;
      }
      perN.push({
        n,
        stepWght: Math.round(step * 100) / 100,
        worstAdjacentShiftPx: Math.round(worst * 1000) / 1000,
        topologyJumps,
        fallbacks,
        // Ink must rise monotonically with weight. It is the cheapest tell that a step rendered in
        // something other than the instance it asked for: a fallback breaks the sequence hard,
        // whereas genuine quantization only makes the increments smaller.
        inkMonotonic: inks.every((v, i) => i === 0 || v >= inks[i - 1]),
        inkFirst: inks[0],
        inkLast: inks[inks.length - 1],
        edgeCountRange: [Math.min(...edgeCounts), Math.max(...edgeCounts)]
      });
      // The floor needs BOTH conditions: sub-pixel displacement AND no topology jump. A step that
      // changes the edge count is visible however small the measured displacement is.
      if (worst < 1 && topologyJumps === 0) break;
    }
    banding.push({ size, perN });
  }

  return { cost, banding, instancingControl };
}, ARIMO);

await browser.close();

// --- report -------------------------------------------------------------------------------------
let failures = 0;
const fail = (msg) => {
  failures += 1;
  console.error(`VOID  ${msg}`);
};

console.log("\n=== ARM 1: registration cost ===");
console.log("  N     instanced(ms)  per-face   plain(ms)  per-face   instancing overhead");
for (const n of [1, 2, 4, 8, 16, 32, 64, 128]) {
  const inst = out.cost.find((r) => r.n === n && r.instanced);
  const plain = out.cost.find((r) => r.n === n && !r.instanced);
  const overhead = plain.totalMs > 0 ? `${(((inst.totalMs - plain.totalMs) / plain.totalMs) * 100).toFixed(1)}%` : "n/a";
  console.log(
    `  ${String(n).padStart(3)}   ${String(inst.totalMs).padStart(10)}   ${String(inst.perFaceMs).padStart(8)}   ` +
      `${String(plain.totalMs).padStart(8)}   ${String(plain.perFaceMs).padStart(8)}   ${overhead.padStart(8)}`
  );
}

console.log("\n=== ARM 2: banding floor (worst shift between ADJACENT quantization steps) ===");
for (const row of out.banding) {
  const control = out.instancingControl.find((c) => c.size === row.size);
  console.log(
    `\n  ${row.size}px — control: the extremes lay ${control.inkRatio?.toFixed(3) ?? "n/a"}x the ink ` +
      `(${control.loInk} → ${control.hiInk})` +
      `${control.extremeShiftPx == null ? ", edge counts differ (topology changed across the full range)" : `, edge shift ${control.extremeShiftPx.toFixed(2)}px`}`
  );
  /**
   * THE ARM'S OWN FALSIFIER. "Adjacent steps do not shift an edge" is also exactly what a face that
   * never instanced produces, and what a static file produces. If the two EXTREMES do not move an
   * edge by a clearly visible amount at this size, nothing below may be read as a banding floor.
   */
  if (!(control.inkRatio > 1.05)) {
    fail(
      `banding @${row.size}px: the axis extremes (400 vs 700) lay down almost the same ink ` +
        `(${control.loInk} vs ${control.hiInk}, ratio ${control.inkRatio?.toFixed(4) ?? "n/a"}). Either the ` +
        `face never instanced or the file is not variable — and "adjacent steps look identical" is ` +
        `exactly what BOTH of those produce, so no reading at this size may be attributed to ` +
        `quantization.`
    );
  }
  for (const p of row.perN) {
    const verdict = p.topologyJumps
      ? `VISIBLE (${p.topologyJumps} topology jump(s))`
      : p.worstAdjacentShiftPx < 1
        ? "invisible (sub-pixel)"
        : "VISIBLE step";
    const health =
      `${p.fallbacks ? `  ⚠ ${p.fallbacks} FALLBACK` : ""}` +
      `${p.inkMonotonic ? "" : "  ⚠ ink NOT monotonic"}` +
      `  ink ${p.inkFirst}→${p.inkLast}  edges ${p.edgeCountRange[0]}–${p.edgeCountRange[1]}`;
    console.log(`    N=${String(p.n).padStart(3)}  step ${String(p.stepWght).padStart(7)} wght  worst adjacent shift ${String(p.worstAdjacentShiftPx).padStart(7)}px  ${verdict}${health}`);
  }
  const floor = row.perN.find((p) => p.worstAdjacentShiftPx < 1 && p.topologyJumps === 0);
  console.log(`    → banding floor at ${row.size}px: ${floor ? `N=${floor.n}` : `NOT REACHED within N≤64`}`);
}

console.log("");
if (failures) {
  console.error(`${failures} control(s) VOID — the numbers above may not be read as answers.`);
  process.exit(1);
}
console.log("Controls held: the file is variable, the faces instanced, and the cost curve has its no-axis control.");
