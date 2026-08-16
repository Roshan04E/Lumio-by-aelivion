/**
 * ADR-023 OQ6 SPIKE (S9), run BEFORE any per-character animation code exists.
 *
 *   cd apps/worker && npx tsx tmp/oq6-spike.mjs
 *
 * OQ6 asks two things and T-14 makes the second one binding:
 *
 *   1. What is a "character" for animation? A **grapheme cluster**, never a code unit — splitting
 *      inside a cluster breaks combining marks, emoji ZWJ sequences and Devanagari conjuncts.
 *      Whether `Intl.Segmenter` is available across both renderers is the open part.
 *   2. **What does a per-cluster transform do to the shaping run?** OQ6's own answer is "it breaks
 *      it — each animated cluster becomes its own shaping context, which changes kerning". For Latin
 *      that is a nuisance. For a cursive script it breaks JOINING, which is the same class of defect
 *      as pre-D9a warp arriving in a new feature after the old one was fixed. T-14: S9 either
 *      resolves this or disables per-character animation visibly on shaping-dependent scripts.
 *
 * And S5 left a third question here: **a variable axis has to reach the RASTER**, because since
 * T-13's correction that is where both renderers get their text pixels — and canvas 2D exposes no
 * `fontVariationSettings` and its `font` shorthand rejects an inline declaration (OQ2, measured).
 * An axis that only moves the DOM overlay ships nothing.
 *
 * THE MEASUREMENT DISCIPLINE HERE. The load-bearing arms are EQUALITIES, not differences: the whole
 * question is whether a per-cluster draw can be made byte-identical to a single shaped draw at zero
 * displacement. A difference assertion cannot answer that (T-15 addendum 3) — and an equality that
 * holds at identity is what licenses every non-identity transform on top of it. Each equality is
 * paired with a control proving the comparison could have failed.
 */
import { readFileSync } from "node:fs";
import { chromium } from "playwright";

const FACES = {
  anton: readFileSync("../web/public/fonts/Anton-Regular.ttf").toString("base64")
};

const browser = await chromium.launch({ channel: process.env.PIXEL_BROWSER_CHANNEL || "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 900, height: 400 }, deviceScaleFactor: 1 });

const out = await page.evaluate(async (FACES) => {
  const W = 800;
  const H = 200;
  const FONT = "72px Arial, sans-serif";

  const mk = () => {
    const c = document.createElement("canvas");
    c.width = W;
    c.height = H;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.clearRect(0, 0, W, H);
    ctx.font = FONT;
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = "#000";
    return { c, ctx };
  };
  const hash = (ctx) => {
    const d = ctx.getImageData(0, 0, W, H).data;
    let h = 2166136261;
    for (let i = 3; i < d.length; i += 4) {
      h ^= d[i];
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(16);
  };
  const ink = (ctx) => {
    const d = ctx.getImageData(0, 0, W, H).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 40) n += 1;
    return n;
  };

  // ---------------------------------------------------------------- 1. Intl.Segmenter
  const hasSegmenter = typeof Intl !== "undefined" && typeof Intl.Segmenter === "function";
  const segment = (s) =>
    hasSegmenter ? [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(s)].map((x) => x.segment) : [...s];
  // The three cases OQ6 names, plus a plain-Latin control. `[...s]` is the CODE POINT split a naive
  // implementation would use, and the clustering claim is exactly that it differs on these.
  const clusterCases = ["ę́", "\u{1F468}‍\u{1F469}‍\u{1F467}", "क्ष", "abc"].map((s) => ({
    input: s,
    clusters: segment(s).length,
    codePoints: [...s].length,
    codeUnits: s.length
  }));

  // ---------------------------------------------------------- 2. per-cluster vs one shaped run
  //
  // Three ways to draw the same string, compared against the SINGLE-CALL reference:
  //
  //   (a) reference    — one `fillText`. This is what every text layer does today.
  //   (b) per-cluster  — one `fillText` PER CLUSTER at its prefix-measured x. Prefix measurement
  //                      carries kerning, so positions are right; but each call SHAPES ITS CLUSTER
  //                      IN ISOLATION, so a cursive script gets isolated forms.
  //   (c) clip-per-cluster — draw the WHOLE shaped run once per cluster, each time clipped to that
  //                      cluster's advance band. Shaping happens on the full run every time, so the
  //                      glyph forms are the run's own; only the visible slice changes. At zero
  //                      displacement this should be BYTE-IDENTICAL to (a), and that equality is the
  //                      whole question.
  const draw = {
    reference(ctx, text, x, y) {
      ctx.fillText(text, x, y);
    },
    perCluster(ctx, text, x, y, dx = 0, dy = 0) {
      const cs = segment(text);
      let prefix = "";
      for (const c of cs) {
        const at = x + ctx.measureText(prefix).width;
        ctx.fillText(c, at + dx, y + dy);
        prefix += c;
      }
    },
    /**
     * RASTERIZE ONCE, THEN SLICE — the technique D9a already chose for warp, applied one level down.
     *
     * The full run is shaped and painted ONCE into an offscreen canvas. Each cluster is then a
     * pixel-exact `drawImage` of that raster's own band. Shaping happens before any cluster moves,
     * so it cannot be re-opened by moving one; and at zero displacement the slices tile the source
     * back together as a memcpy, with no second rasterization to disagree with the first.
     *
     * This replaces a CLIP-and-redraw draft that re-rendered the whole run per band. That draft was
     * within ~7 ink pixels of the reference and never byte-identical: canvas antialiases a clip edge,
     * so abutting bands each contribute partial coverage at the seam — the same lattice ADR-023 §8b
     * records for the warp mesh. Slicing a finished raster has no seam to antialias.
     */
    rasterSlice(ctx, text, x, y, dx = 0, dy = 0) {
      const off = document.createElement("canvas");
      off.width = W;
      off.height = H;
      const octx = off.getContext("2d");
      octx.font = FONT;
      octx.textBaseline = "alphabetic";
      octx.fillStyle = "#000";
      octx.fillText(text, x, y);

      const cs = segment(text);
      let prefix = "";
      // The bands must tile the WHOLE canvas, not just the advance run: a glyph's ink can reach
      // outside its own advance (side bearings, cursive tails), and ink outside every band would be
      // dropped. The first band starts at 0 and the last ends at W.
      const edges = [0];
      for (const c of cs) {
        prefix += c;
        edges.push(Math.round(x + ctx.measureText(prefix).width));
      }
      edges[edges.length - 1] = W;
      for (let i = 0; i < edges.length - 1; i += 1) {
        const sx = edges[i];
        const sw = edges[i + 1] - sx;
        if (sw <= 0) continue;
        ctx.drawImage(off, sx, 0, sw, H, sx + dx, dy, sw, H);
      }
    }
  };

  const compare = (text, dx = 0, dy = 0) => {
    const a = mk();
    draw.reference(a.ctx, text, 30, 120);
    const b = mk();
    draw.perCluster(b.ctx, text, 30, 120, dx, dy);
    const c = mk();
    draw.rasterSlice(c.ctx, text, 30, 120, dx, dy);
    return {
      reference: hash(a.ctx),
      perCluster: hash(b.ctx),
      rasterSlice: hash(c.ctx),
      referenceInk: ink(a.ctx),
      perClusterInk: ink(b.ctx),
      sliceInk: ink(c.ctx)
    };
  };

  /**
   * WHERE DO THE BAND EDGES COME FROM? The slice technique needs each cluster's advance band, and
   * canvas 2D exposes no per-glyph positions — the only source is `measureText` on prefixes.
   *
   * That is fine exactly when prefix measurement agrees with the run: `measureText(prefix)` SHAPES
   * THE PREFIX IN ISOLATION, so on a cursive script the prefix's last letter takes its FINAL form
   * (wider) where the run would give it a MEDIAL one. The tell is mechanical and worth measuring
   * rather than arguing: the edges stop being monotonic with respect to the full run, and the last
   * prefix's width stops equalling the whole string's.
   */
  const edgeAudit = (text) => {
    const { ctx } = mk();
    const cs = segment(text);
    let prefix = "";
    const widths = [];
    for (const c of cs) {
      prefix += c;
      widths.push(ctx.measureText(prefix).width);
    }
    const runWidth = ctx.measureText(text).width;
    let nonMonotonic = 0;
    for (let i = 1; i < widths.length; i += 1) if (widths[i] < widths[i - 1]) nonMonotonic += 1;
    return {
      clusters: cs.length,
      runWidth: Math.round(runWidth * 100) / 100,
      lastPrefixWidth: Math.round(widths[widths.length - 1] * 100) / 100,
      // The load-bearing number: how far the sum of prefix-measured bands is from the real run.
      prefixOvershootPx: Math.round((widths[widths.length - 1] - runWidth) * 100) / 100,
      nonMonotonic
    };
  };
  const edges = {
    latin: edgeAudit("AVATAR Waffle"),
    arabic: edgeAudit("مرحبا بالعالم"),
    devanagari: edgeAudit("हिन्दी भाषा")
  };

  const latin = compare("AVATAR Waffle");
  const arabic = compare("مرحبا بالعالم");
  const devanagari = compare("हिन्दी भाषा");
  // A displaced arm, to see what the clip technique costs once a cluster actually moves — which is
  // the only reason any of this exists.
  const arabicMoved = compare("مرحبا بالعالم", 0, -14);
  const latinMoved = compare("AVATAR Waffle", 0, -14);

  // --------------------------------------------------- 3. can a VARIABLE AXIS reach the raster?
  //
  // OQ2 measured the two dead ends (no `ctx.fontVariationSettings`, and `ctx.font` rejects an inline
  // declaration). This asks the question those two do not: a `FontFace` can carry a
  // `variationSettings` DESCRIPTOR, which instances the axis at REGISTRATION time rather than at
  // draw time — so the canvas would only ever have to name a family.
  const variable = { descriptorAccepted: false, widthsDiffer: false, error: null, widths: [] };
  try {
    const src = `url(data:font/ttf;base64,${FACES.anton})`;
    // Anton is a STATIC face, so it has no axes to instance — which makes it the honest control for
    // "was the descriptor even accepted", separately from "did it change anything".
    const face = new FontFace("OQ6Probe", src, { variationSettings: "'wght' 700" });
    variable.descriptorAccepted = face.variationSettings === "'wght' 700";
    await face.load();
    document.fonts.add(face);
    const probe = document.createElement("canvas").getContext("2d");
    probe.font = "72px OQ6Probe";
    variable.widths.push(probe.measureText("Hamburgefonstiv").width);
  } catch (err) {
    variable.error = String(err && err.message);
  }

  // The same question against a REAL variable font, fetched from Google's CDN as a variable file.
  // Two instances of ONE file registered under two family aliases: if the descriptor works, the two
  // must measure differently. If it does not, they collapse onto one width — the T-15-addendum-3
  // shape, so this is an assertion the failure mode can actually fail.
  const variableReal = { fetched: false, aliasesDiffer: false, widths: [], error: null };
  try {
    const css = await (
      // `&text=` subsets the file to the probe's own string. Without it the variable Roboto Flex is
      // over a megabyte, and base64 + encodeURIComponent of that silently failed to load inside the
      // SVG arm below — which the arm's fallback control caught, rather than reporting a negative.
      await fetch("https://fonts.googleapis.com/css2?family=Roboto+Flex:wght@100..1000&text=Hamburge&display=swap")
    ).text();
    const url = (css.match(/url\((https:[^)]+)\)/) || [])[1];
    if (url) {
      const bytes = await (await fetch(url)).arrayBuffer();
      variableReal.fetched = true;
      for (const [alias, wght] of [["OQ6Var100", "'wght' 100"], ["OQ6Var900", "'wght' 900"]]) {
        const f = new FontFace(alias, bytes, { variationSettings: wght });
        await f.load();
        document.fonts.add(f);
        const p = document.createElement("canvas").getContext("2d");
        p.font = `72px ${alias}`;
        variableReal.widths.push(p.measureText("Hamburge").width);
      }
      variableReal.aliasesDiffer = variableReal.widths[0] !== variableReal.widths[1];
    }
  } catch (err) {
    variableReal.error = String(err && err.message);
  }

  /**
   * THE CONTROL THAT MAKES EVERY NEGATIVE BELOW READABLE.
   *
   * "Two axis instances measured the same" is also exactly what a NON-variable file produces, and
   * what an engine that cannot instance one produces. So the same fetched face is driven through the
   * DOM, where `font-variation-settings` is an ordinary CSS property. If the DOM widths differ, the
   * file is variable AND this engine can instance it — and the canvas result is therefore a fact
   * about canvas. If the DOM widths match too, the entire variable section is void.
   */
  const variableDomControl = { ran: false, widths: [], differ: false, error: null };
  try {
    const css = await (
      await fetch("https://fonts.googleapis.com/css2?family=Roboto+Flex:wght@100..1000&text=Hamburge&display=swap")
    ).text();
    const url = (css.match(/url\((https:[^)]+)\)/) || [])[1];
    if (url) {
      const f = new FontFace("OQ6DomVar", await (await fetch(url)).arrayBuffer());
      await f.load();
      document.fonts.add(f);
      const host = document.createElement("div");
      host.style.cssText = "position:fixed;left:-9999px;top:0;white-space:pre";
      document.body.appendChild(host);
      for (const wght of [100, 900]) {
        const span = document.createElement("span");
        span.style.cssText = `font:72px OQ6DomVar;font-variation-settings:'wght' ${wght}`;
        span.textContent = "Hamburge";
        host.appendChild(span);
        variableDomControl.widths.push(Math.round(span.getBoundingClientRect().width * 100) / 100);
      }
      variableDomControl.ran = true;
      variableDomControl.differ = variableDomControl.widths[0] !== variableDomControl.widths[1];
    }
  } catch (err) {
    variableDomControl.error = String(err && err.message);
  }

  /**
   * The route OQ2's two dead ends and the descriptor arm above do NOT cover: S8 just built an SVG
   * text surface that the raster consumes by `drawImage`, and SVG carries `font-variation-settings`
   * as an ordinary presentation attribute. If two instances of one embedded variable file render
   * different pictures THROUGH THAT SURFACE, then a variable axis reaches the raster after all.
   *
   * Asserted as "the two instances differ FROM EACH OTHER" rather than "differs from default":
   * if the axis were ignored, both would render at the file's default instance and collapse onto one
   * identical picture, which is the only way this arm can fail honestly (T-15 addendum 3).
   */
  const variableViaSvg = { ran: false, differ: false, inks: [], faceLoaded: false, fallbackInk: 0, fontBytes: 0, error: null };
  try {
    const css = await (
      // `&text=` subsets the file to the probe's own string. Without it the variable Roboto Flex is
      // over a megabyte, and base64 + encodeURIComponent of that silently failed to load inside the
      // SVG arm below — which the arm's fallback control caught, rather than reporting a negative.
      await fetch("https://fonts.googleapis.com/css2?family=Roboto+Flex:wght@100..1000&text=Hamburge&display=swap")
    ).text();
    const url = (css.match(/url\((https:[^)]+)\)/) || [])[1];
    if (url) {
      const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
      variableViaSvg.fontBytes = bytes.length;
      let bin = "";
      for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]);
      const b64 = btoa(bin);
      for (const wght of [100, 900]) {
        const svg =
          `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="140">` +
          `<defs><style>@font-face{font-family:"VF";src:url(data:font/woff2;base64,${b64}) format("woff2")}</style></defs>` +
          `<rect width="600" height="140" fill="#fff"/>` +
          `<text x="10" y="100" font-family="VF" font-size="72" fill="#000" ` +
          `font-variation-settings="'wght' ${wght}">Hamburge</text></svg>`;
        const im = new Image();
        const loaded = await new Promise((r) => {
          im.onload = () => r(true);
          im.onerror = () => r(false);
          im.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
        });
        if (!loaded) throw new Error("svg image did not load");
        const c = document.createElement("canvas");
        c.width = 600;
        c.height = 140;
        const cx = c.getContext("2d", { willReadFrequently: true });
        cx.drawImage(im, 0, 0);
        const d = cx.getImageData(0, 0, 600, 140).data;
        let n = 0;
        for (let i = 0; i < d.length; i += 4) if (d[i] < 128) n += 1;
        variableViaSvg.inks.push(n);
      }
      /**
       * THE ARM'S OWN FALSIFIER, and it is the whole reason to trust a negative here. "Both axis
       * instances rendered the same picture" is EXACTLY what a font that never loaded also produces
       * — both would fall back to the same default face. So render the identical markup with the
       * @font-face block REMOVED: if that fallback picture differs from the embedded ones, the face
       * genuinely loaded and the collapse is the axis being ignored. If it MATCHES, the face never
       * loaded and this arm proves nothing about variable axes at all.
       */
      const bare =
        `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="140">` +
        `<rect width="600" height="140" fill="#fff"/>` +
        `<text x="10" y="100" font-family="VF" font-size="72" fill="#000">Hamburge</text></svg>`;
      const bi = new Image();
      await new Promise((r) => {
        bi.onload = () => r(true);
        bi.onerror = () => r(false);
        bi.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(bare)}`;
      });
      const bc = document.createElement("canvas");
      bc.width = 600;
      bc.height = 140;
      const bcx = bc.getContext("2d", { willReadFrequently: true });
      bcx.drawImage(bi, 0, 0);
      const bd = bcx.getImageData(0, 0, 600, 140).data;
      let bn = 0;
      for (let i = 0; i < bd.length; i += 4) if (bd[i] < 128) bn += 1;
      variableViaSvg.fallbackInk = bn;
      variableViaSvg.faceLoaded = bn !== variableViaSvg.inks[0];
      variableViaSvg.ran = true;
      variableViaSvg.differ = variableViaSvg.inks[0] !== variableViaSvg.inks[1];
    }
  } catch (err) {
    variableViaSvg.error = String(err && err.message);
  }

  return { hasSegmenter, clusterCases, edges, variableDomControl, latin, arabic, devanagari, arabicMoved, latinMoved, variable, variableReal, variableViaSvg };
}, FACES);

await browser.close();
console.log(JSON.stringify(out, null, 2));

const fail = [];
const ok = [];

// --- 1. clustering ------------------------------------------------------------------------------
if (!out.hasSegmenter) fail.push("Intl.Segmenter is NOT available — a grapheme cluster cannot be identified at all.");
else {
  const [marks, zwj, conjunct, plain] = out.clusterCases;
  // The instrument's falsifier: on plain Latin, clusters and code points MUST agree, or the
  // segmenter is doing something other than what this spike thinks it is.
  if (plain.clusters !== plain.codePoints) fail.push("VOID: the segmenter disagrees with a code-point split on plain ASCII.");
  else if (marks.clusters !== 1 || zwj.clusters !== 1 || conjunct.clusters > 2 || marks.codePoints === 1) {
    fail.push(
      `clustering is not what OQ6 requires: marks=${marks.clusters} (of ${marks.codePoints} code points), ` +
        `emoji-ZWJ=${zwj.clusters} (of ${zwj.codePoints}), conjunct=${conjunct.clusters}.`
    );
  } else {
    ok.push(
      `Intl.Segmenter clusters correctly: ${marks.codePoints} code points → 1 cluster (combining marks), ` +
        `${zwj.codePoints} → 1 (emoji ZWJ), Devanagari conjunct → ${conjunct.clusters}.`
    );
  }
}

// --- 2. the shaping run -------------------------------------------------------------------------
//
// THE EQUALITY THAT DECIDES THE STAGE: rasterize-then-slice at zero displacement must be
// byte-identical to the single shaped call. Where it is, shaping happened once, before anything
// moved, and per-cluster animation cannot re-open the boundary D9a closed (T-14).
//
// The split this produced is not a partial result — it IS the answer, and it falls exactly along
// `detectTextScript`'s existing line.
const NON_CURSIVE_MUST_MATCH = ["Latin", "Devanagari"];
for (const [name, m] of [["Latin", out.latin], ["Arabic", out.arabic], ["Devanagari", out.devanagari]]) {
  const identical = m.rasterSlice === m.reference;
  const audit = out.edges[name.toLowerCase()];
  if (NON_CURSIVE_MUST_MATCH.includes(name)) {
    if (identical) ok.push(`${name}: rasterize-then-slice at rest is BYTE-IDENTICAL to one shaped call (${audit.nonMonotonic} edge inversions).`);
    else fail.push(`${name}: rasterize-then-slice at rest DIFFERS from one shaped call (${m.rasterSlice} vs ${m.reference}).`);
  } else {
    // Arabic is EXPECTED not to match, and the spike's job is to establish WHY — because the reason
    // is what licenses T-14's disable rather than merely asserting a defect.
    if (identical) {
      fail.push(`${name}: the slice route matched after all — the cursive limitation below is not real and T-14's disable would be unjustified.`);
    } else if (audit.nonMonotonic === 0) {
      fail.push(`${name}: the slice route differs but the prefix edges are monotonic, so the filed cause is wrong and the real one is unknown.`);
    } else {
      ok.push(
        `${name} (cursive): the slice route CANNOT be made exact, and the cause is measured — ` +
          `${audit.nonMonotonic} of ${audit.clusters} prefix widths go BACKWARDS. \`measureText\` shapes each prefix ` +
          `in ISOLATION, so a prefix ending mid-word takes a FINAL form (wider) where the run gives a MEDIAL one, ` +
          `and the band edges overlap. Canvas 2D exposes no per-glyph visual positions, so prefix measurement is ` +
          `the only source of band edges there is — and for a cursive script it is provably the wrong one.`
      );
    }
  }
}
// The instrument's own control: if per-cluster fillText ALSO matched the reference, the comparison
// would be blind to shaping and every equality above would be worthless.
if (out.arabic.perCluster === out.arabic.reference) {
  fail.push("VOID: per-cluster fillText matched the reference on ARABIC, so this measurement cannot see shaping at all.");
} else {
  ok.push(
    `control: per-cluster fillText on Arabic moves the ink by ` +
      `${(((out.arabic.perClusterInk - out.arabic.referenceInk) / out.arabic.referenceInk) * 100).toFixed(1)}% ` +
      `(isolated forms instead of joined ones), so the comparison can see shaping.`
  );
}
// Stated rather than asserted: this Devanagari sample has no CROSS-cluster shaping (drawing it
// cluster by cluster reproduces the run exactly), so its byte-identity above says nothing about
// shaping-dependent scripts in general. It is `detectTextScript`'s classification that governs which
// scripts are disabled, never this sample.
if (out.devanagari.perCluster === out.devanagari.reference) {
  ok.push(
    "note: the Devanagari sample has no cross-cluster shaping (per-cluster fillText reproduces it exactly), " +
      "so its match proves the slice route is lossless, NOT that the script is safe. The gate reads detectTextScript."
  );
}

// --- 3. variable axes ---------------------------------------------------------------------------
//
// READ THE CONTROL FIRST. Every negative in this section ("the two instances matched") is also
// exactly what a non-variable file produces, and what an engine that cannot instance one produces —
// the T-15-addendum-3 shape. The DOM control settles which it is before any canvas or SVG result is
// allowed to mean anything.
if (!out.variableDomControl.ran || !out.variableDomControl.differ) {
  fail.push(
    `VOID (variable axes): the DOM control did not show an axis moving (widths ` +
      `${JSON.stringify(out.variableDomControl.widths)}${out.variableDomControl.error ? `, error: ${out.variableDomControl.error}` : ""}). ` +
      `Either the fetched file is not variable or this engine cannot instance it, so every canvas and SVG ` +
      `result below is a fact about the probe rather than about the raster.`
  );
} else {
  ok.push(
    `variable CONTROL: the same face at 'wght' 100 vs 900 measures ${out.variableDomControl.widths.join(" vs ")} in the DOM, ` +
      `so the file IS variable and this engine CAN instance it. Canvas's answer is therefore canvas's.`
  );
}
if (out.variableViaSvg.ran && !out.variableViaSvg.faceLoaded) {
  fail.push(
    `VOID (SVG axis arm): the embedded face did not load inside the SVG — its ink ${out.variableViaSvg.inks[0]} equals ` +
      `the no-@font-face fallback's ${out.variableViaSvg.fallbackInk} (${out.variableViaSvg.fontBytes} bytes embedded). ` +
      `Nothing may be concluded about SVG and variable axes from this run.`
  );
}
if (out.variableReal.fetched && out.variableReal.aliasesDiffer) {
  ok.push(
    `VARIABLE AXES REACH THE RASTER: two FontFaces over ONE variable file, registered with different ` +
      `\`variationSettings\` descriptors, measure differently on canvas (${out.variableReal.widths.join(" vs ")}). ` +
      `The axis is instanced at REGISTRATION, so canvas only ever names a family — which is the one ` +
      `thing OQ2's two dead ends did not rule out.`
  );
  // Worth carrying, because it is OQ2's own lesson pointed the other way: the descriptor is HONOURED
  // but NOT REFLECTED — `face.variationSettings` reads back empty (descriptorAccepted=false above)
  // while the rendering demonstrably obeys it. OQ2 was burned by trusting a reflected value that was
  // its own expando; this is the mirror image, and a feature-detect written on the reflection would
  // have concluded "unsupported" about an API that works.
  if (!out.variable.descriptorAccepted) {
    ok.push(
      "instrument note: `FontFace.variationSettings` does NOT reflect back (it reads empty) even though the " +
        "rendering obeys it — so a feature-detect written on the reflected value would report this as unsupported."
    );
  }
} else if (out.variableReal.fetched) {
  ok.push(
    "VARIABLE AXES CANNOT REACH THE CANVAS RASTER. The `FontFace` `variationSettings` descriptor is not " +
      `even accepted (descriptorAccepted=${out.variable.descriptorAccepted}), and two aliases over one variable ` +
      `file measure identically (${out.variableReal.widths.join(" vs ")}). With OQ2's two prior dead ends — no ` +
      "`ctx.fontVariationSettings`, and `ctx.font` rejecting an inline declaration — that is every route canvas " +
      "has, at draw time AND at registration time."
  );
} else {
  ok.push(`variable-font descriptor arm did not run (no network?): ${out.variableReal.error ?? "no URL matched"}.`);
}

if (out.variableViaSvg.ran && out.variableViaSvg.differ) {
  ok.push(
    `BUT THE SVG SURFACE CARRIES THE AXIS: the same embedded variable file at 'wght' 100 vs 900 ` +
      `renders two different pictures through S8's path-text surface (${out.variableViaSvg.inks.join(" vs ")} ink px). ` +
      `The raster problem is SOLVED for text that goes through that surface, and only for that text.`
  );
} else if (out.variableViaSvg.ran && !out.variableViaSvg.faceLoaded) {
  fail.push(
    `VOID: the embedded variable face did not load inside the SVG (its ink ${out.variableViaSvg.inks[0]} equals the ` +
      `no-@font-face fallback's ${out.variableViaSvg.fallbackInk}), so "the two instances matched" is a fact about ` +
      `the probe, not about variable axes.`
  );
} else if (out.variableViaSvg.ran) {
  ok.push(
    "and the SVG surface does NOT carry it either: the face demonstrably LOADED (it differs from the " +
      `no-@font-face fallback, ${out.variableViaSvg.inks[0]} vs ${out.variableViaSvg.fallbackInk} ink px) and the two ` +
      "axis instances still rendered the identical picture, so the axis is ignored rather than the font missing."
  );
} else {
  ok.push(`SVG-surface variable arm did not run: ${out.variableViaSvg.error ?? "no URL matched"}.`);
}

console.log("\n" + ok.map((s) => `  ok   ${s}`).join("\n"));
if (fail.length) {
  console.error("\n" + fail.map((s) => `  FAIL ${s}`).join("\n"));
  process.exit(1);
}
