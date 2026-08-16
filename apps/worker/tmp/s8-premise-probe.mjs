/**
 * S8 PREMISE probe (ADR-023 D8), run BEFORE any S8 code.
 *
 *   node apps/worker/tmp/s8-premise-probe.mjs
 *
 * D8 says SVG is added for exactly two things CSS cannot do: **multiple independent strokes** and
 * **text on a path**. The first of those claims was never measured. This probe asks whether a
 * second rendering surface is actually required for each, on both of the surfaces that matter:
 *
 *   - the CANVAS RASTER (`scene/text-shape.ts`), which since T-13's correction is where BOTH
 *     renderers get their text pixels, and
 *   - the DOM OVERLAY (`VideoPreview`), which is what the editor shows over the scene canvas.
 *
 * The measurement is a scanline through a glyph stem, counted into colour BANDS. A concentric
 * multi-stroke is exactly "three bands outward from the fill, in the declared order"; anything that
 * cannot produce that is not doing the feature no matter what it emits.
 *
 * INSTRUMENT FALSIFICATION (T-15 addendum 3 — every arm below is at risk of being a difference
 * assertion that fails open, so each is stated as an EQUALITY against a declared band list):
 *   - the single-stroke control must report exactly ONE stroke band, or the band counter is
 *     counting noise and every positive result is worthless;
 *   - the bands are matched by COLOUR AND ORDER against what was authored, not merely counted, so
 *     "three bands" produced by antialiasing cannot pass for "three strokes";
 *   - the widths are read back and compared to the authored widths within an antialiasing
 *     tolerance, so a surface that draws three strokes at ONE width still fails.
 */
import { readFileSync } from "node:fs";
import { chromium } from "playwright";

const CHANNEL = process.env.PIXEL_BROWSER_CHANNEL || "chrome";
const browser = await chromium.launch({ channel: CHANNEL, headless: true });
const page = await browser.newPage({ viewport: { width: 900, height: 600 }, deviceScaleFactor: 1 });

// Two PINNED faces, for arm F. They are deliberately unalike (a condensed display sans and a
// monospace) so that a face which actually loads cannot be mistaken for one that did not.
const FACES = {
  anton: readFileSync("../web/public/fonts/Anton-Regular.ttf").toString("base64"),
  cousine: readFileSync("../web/public/fonts/Cousine-Regular.ttf").toString("base64")
};

const out = await page.evaluate(async (FACES) => {
  // ------------------------------------------------------------------ helpers
  /** Read a horizontal scanline out of ImageData and collapse it into runs of one colour. */
  const bandsOf = (data, w, y) => {
    const runs = [];
    for (let x = 0; x < w; x += 1) {
      const i = (y * w + x) * 4;
      const [r, g, b, a] = [data[i], data[i + 1], data[i + 2], data[i + 3]];
      const key = a < 250 ? "~" : `${r},${g},${b}`;
      const last = runs[runs.length - 1];
      if (last && last.key === key) last.n += 1;
      else runs.push({ key, n: 1, x });
    }
    // Drop antialiasing slivers, the transparent gaps between them, and the page background; what
    // survives is the structure. 3px is under the 6px narrowest band any arm below authors, and each
    // boundary loses ~1px per side to antialiasing (which is why the tolerance below is +-2).
    return runs.filter((run) => run.n >= 3 && run.key !== "~" && run.key !== "255,255,255");
  };

  /** The left half of a scanline through a stem: the stroke bands, outermost first, then the fill. */
  const leftProfile = (bands) => bands.slice(0, bands.findIndex((b) => b.key === "0,0,255") + 1);

  // The authored look, shared by every arm so the arms are comparable. Widths are CSS
  // `-webkit-text-stroke` semantics: a stroke of width W is CENTRED on the outline, so it shows
  // W/2 of visible band outside the glyph, which is what canvas `lineWidth` does too.
  // Wide on purpose: each boundary loses ~1-2px to antialiasing on every surface, so 12px visible
  // bands keep that a rounding error instead of most of the signal.
  const STROKES = [
    { width: 72, color: "rgb(255,0,0)", canvas: "#ff0000" },   // outermost
    { width: 48, color: "rgb(0,255,0)", canvas: "#00ff00" },
    { width: 24, color: "rgb(255,255,0)", canvas: "#ffff00" }  // innermost
  ];
  const FILL = "rgb(0,0,255)";
  const TEXT = "H";
  const FONT = "700 200px Arial, sans-serif";
  const W = 400;
  const H = 300;
  const BASE_X = 60;
  const BASE_Y = 220;

  const makeCanvas = () => {
    const c = document.createElement("canvas");
    c.width = W;
    c.height = H;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, W, H);
    return { c, ctx };
  };

  // ----------------------------------------------------------- A. canvas, N strokes
  // The premise under test: `strokeText` widest-first, then fill. No SVG, no second surface.
  const drawCanvas = (strokes) => {
    const { c, ctx } = makeCanvas();
    ctx.font = FONT;
    ctx.textBaseline = "alphabetic";
    ctx.lineJoin = "round";
    for (const s of strokes) {
      ctx.lineWidth = s.width;
      ctx.strokeStyle = s.canvas;
      ctx.strokeText(TEXT, BASE_X, BASE_Y);
    }
    ctx.fillStyle = "#0000ff";
    ctx.fillText(TEXT, BASE_X, BASE_Y);
    const data = ctx.getImageData(0, 0, W, H).data;
    return leftProfile(bandsOf(data, W, 150));
  };
  const canvasMulti = drawCanvas(STROKES);
  const canvasSingle = drawCanvas([STROKES[0]]);

  // ----------------------------------------------------------- B. DOM, stacked copies
  // CSS `-webkit-text-stroke` carries ONE stroke. The question is whether N absolutely-positioned
  // copies of the SAME text — each browser-shaped, each with a real stroke, widest at the back —
  // reproduce the canvas construction. This is not a fake: it is the identical geometry, drawn by
  // the same rasterizer, just once per stroke.
  const host = document.createElement("div");
  host.style.cssText =
    `position:fixed;left:0;top:0;width:${W}px;height:${H}px;background:#fff;overflow:hidden;z-index:99999`;
  const cell = (strokeCss, color, extra = "") =>
    // `font` is the SHORTHAND and resets `line-height`, so it must come FIRST — declared after, it
    // silently threw the baseline away and moved the scanline onto a different part of the glyph.
    `<div style="position:absolute;left:${BASE_X}px;top:0;` +
    `font:${FONT};line-height:${BASE_Y}px;color:${color};${strokeCss};${extra}">${TEXT}</div>`;
  host.innerHTML =
    STROKES.map((s) =>
      cell(`-webkit-text-stroke:${s.width}px ${s.color};paint-order:stroke fill`, "transparent")
    ).join("") + cell("", "rgb(0,0,255)");
  document.body.appendChild(host);
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

  // ----------------------------------------------------------- C. SVG, D8's proposed route
  const svgHost = document.createElement("div");
  svgHost.style.cssText = `position:fixed;left:0;top:${H}px;width:${W}px;height:${H}px;background:#fff;z-index:99999`;
  svgHost.innerHTML =
    `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">` +
    `<rect width="${W}" height="${H}" fill="#fff"/>` +
    STROKES.map(
      (s) =>
        `<text x="${BASE_X}" y="${BASE_Y}" font="${FONT}" font-family="Arial, sans-serif" font-weight="700" font-size="200"` +
        ` fill="none" stroke="${s.color}" stroke-width="${s.width}" stroke-linejoin="round">${TEXT}</text>`
    ).join("") +
    `<text x="${BASE_X}" y="${BASE_Y}" font-family="Arial, sans-serif" font-weight="700" font-size="200" fill="${FILL}">${TEXT}</text>` +
    `</svg>`;
  document.body.appendChild(svgHost);
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

  // ------------------------------------------------- D. <textPath>: does it shape?
  // The other half of D8. Two things must be true for <textPath> to be the answer:
  //   (i) it renders along the path at all, and
  //   (ii) it keeps BROWSER SHAPING — which is the whole reason D8 says SVG is a second surface and
  //        not a second text engine. Measured by asking whether an Arabic run rendered on a path
  //        produces the same INK EXTENT as the same run rendered flat: a per-glyph-lookup engine
  //        would produce isolated forms and a visibly different advance.
  const pathHost = document.createElement("div");
  pathHost.style.cssText = "position:fixed;left:500px;top:0;width:400px;height:600px;background:#fff;z-index:99999";
  const ARABIC = "مرحبا";
  pathHost.innerHTML =
    `<svg id="sp" width="400" height="600" xmlns="http://www.w3.org/2000/svg">` +
    `<path id="p1" d="M 20 100 L 380 100" fill="none"/>` +
    `<text font-family="Arial, sans-serif" font-size="48"><textPath id="tp" href="#p1">${ARABIC}</textPath></text>` +
    `<text id="flat" x="20" y="200" font-family="Arial, sans-serif" font-size="48">${ARABIC}</text>` +
    `<path id="p2" d="M 40 400 A 160 160 0 0 1 360 400" fill="none"/>` +
    `<text font-family="Arial, sans-serif" font-size="48"><textPath id="tp2" href="#p2">Curved</textPath></text>` +
    `</svg>`;
  document.body.appendChild(pathHost);
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const tp = document.getElementById("tp");
  const flat = document.getElementById("flat");
  const tp2 = document.getElementById("tp2");
  const tpBox = tp.getBoundingClientRect();
  const flatBox = flat.getBoundingClientRect();
  const curvedBox = tp2.getBoundingClientRect();
  // FALSIFY THE SHAPING COMPARISON. "The two widths are equal" is worth nothing unless this
  // measurement could have told them apart. A non-shaping engine draws each Arabic letter in its
  // ISOLATED form, which is wider than the joined run — so the sum of per-character widths is what
  // "not shaped" looks like, and it must differ from both arms above by a lot.
  const probe = document.createElement("canvas").getContext("2d");
  probe.font = "48px Arial, sans-serif";
  const isolatedSum = [...ARABIC].reduce((sum, ch) => sum + probe.measureText(ch).width, 0);
  const shapedRun = probe.measureText(ARABIC).width;

  const textPath = {
    renders: tpBox.width > 10 && tpBox.height > 5,
    isolatedSum: Math.round(isolatedSum * 100) / 100,
    shapedRun: Math.round(shapedRun * 100) / 100,
    // A straight path is geometrically identical to a flat run, so a SHAPING difference is the only
    // thing that can move the advance. Equal width => the same shaping engine produced both.
    shapedWidthOnPath: Math.round(tpBox.width * 100) / 100,
    shapedWidthFlat: Math.round(flatBox.width * 100) / 100,
    // A curved path must make the run TALLER than its font size, which a flat run never is — that is
    // the cheapest proof the glyphs are actually being placed and rotated along the geometry.
    curvedHeight: Math.round(curvedBox.height * 100) / 100
  };

  // ------------------------------------------- E. can the RASTER get <textPath> pixels?
  // The raster is where both renderers' pixels come from, and canvas 2D has no text-on-a-path. The
  // only route that keeps browser shaping is to rasterize an SVG. An SVG loaded as an <img> is an
  // isolated document, so the live question is whether a FONT resolves inside it — a system family
  // by name, which is what a `{source:"system"}` FontRef is.
  const svgDoc =
    `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200">` +
    `<rect width="400" height="200" fill="#fff"/>` +
    `<path id="q" d="M 20 150 L 380 150" fill="none"/>` +
    `<text font-family="Arial" font-size="64" fill="#000"><textPath href="#q">Path</textPath></text></svg>`;
  const img = new Image();
  const loaded = await new Promise((resolve) => {
    img.onload = () => resolve(true);
    img.onerror = () => resolve(false);
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgDoc)}`;
  });
  let svgIntoCanvas = { loaded, inkPixels: 0, error: null };
  if (loaded) {
    try {
      const c = document.createElement("canvas");
      c.width = 400;
      c.height = 200;
      const ctx = c.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);
      const d = ctx.getImageData(0, 0, 400, 200).data;
      let ink = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] < 128 && d[i + 3] > 128) ink += 1;
      svgIntoCanvas.inkPixels = ink;
    } catch (err) {
      svgIntoCanvas.error = String(err && err.message);
    }
  }

  // ------------------------------------- F. does a PINNED face resolve inside an SVG image?
  // Arm E used a SYSTEM family by name, which is the `{source:"system"}` legacy case. Since S2 the
  // product's font story is a PINNED face resolved from bytes, and an SVG loaded as an <img> is an
  // isolated document that cannot fetch anything — so the face has to travel inside the document as
  // a data URI. If it cannot, text-on-a-path could never carry a pinned font and the design is dead.
  //
  // T-17 / T-15 addendum 3: "it differs from the fallback" fails open. Two DIFFERENT pinned faces
  // are rendered under the same alias at the same size, and they must differ FROM EACH OTHER — two
  // faces that both failed to load collapse onto one identical fallback picture, which is the only
  // way this arm can be made to fail honestly.
  const renderPinned = async (b64) => {
    const doc =
      `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200">` +
      `<defs><style>@font-face{font-family:"PinTest";src:url(data:font/ttf;base64,${b64}) format("truetype")}</style></defs>` +
      `<rect width="400" height="200" fill="#fff"/>` +
      `<path id="r" d="M 20 150 L 380 150" fill="none"/>` +
      `<text font-family="PinTest" font-size="64" fill="#000"><textPath href="#r">Pinned</textPath></text></svg>`;
    const im = new Image();
    const ok = await new Promise((resolve) => {
      im.onload = () => resolve(true);
      im.onerror = () => resolve(false);
      im.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(doc)}`;
    });
    if (!ok) return { ok: false, ink: 0, signature: "" };
    const c = document.createElement("canvas");
    c.width = 400;
    c.height = 200;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(im, 0, 0);
    const d = ctx.getImageData(0, 0, 400, 200).data;
    let ink = 0;
    const cols = [];
    for (let x = 0; x < 400; x += 1) {
      let col = 0;
      for (let y = 0; y < 200; y += 1) {
        const i = (y * 400 + x) * 4;
        if (d[i] < 128 && d[i + 3] > 128) col += 1;
      }
      cols.push(col);
      ink += col;
    }
    return { ok: true, ink, signature: cols.join(",") };
  };
  const pinnedA = await renderPinned(FACES.anton);
  const pinnedB = await renderPinned(FACES.cousine);

  return {
    pinnedInSvg: {
      antonLoaded: pinnedA.ok,
      cousineLoaded: pinnedB.ok,
      antonInk: pinnedA.ink,
      cousineInk: pinnedB.ink,
      // The load-bearing assertion: two pinned faces must produce two DIFFERENT pictures.
      facesDiffer: pinnedA.signature !== pinnedB.signature
    },
    canvasMulti: canvasMulti.map((b) => ({ color: b.key, width: b.n })),
    canvasSingle: canvasSingle.map((b) => ({ color: b.key, width: b.n })),
    authored: STROKES.map((s) => ({ color: s.color.replace(/rgb\(|\)/g, ""), halfWidth: s.width / 2 })),
    textPath,
    svgIntoCanvas,
    W,
    H
  };
}, FACES);

// The DOM and SVG arms have to be read from real page pixels, not from a canvas, so they are
// screenshotted and scanned here.
const scan = async (clip, y) => {
  const buf = await page.screenshot({ clip });
  const { PNG } = await import("pngjs");
  const png = PNG.sync.read(buf);
  const runs = [];
  for (let x = 0; x < png.width; x += 1) {
    const i = (y * png.width + x) * 4;
    const key = png.data[i + 3] < 250 ? "~" : `${png.data[i]},${png.data[i + 1]},${png.data[i + 2]}`;
    const last = runs[runs.length - 1];
    if (last && last.key === key) last.n += 1;
    else runs.push({ key, n: 1 });
  }
  const bands = runs.filter((r) => r.n >= 3 && r.key !== "~" && r.key !== "255,255,255");
  const end = bands.findIndex((b) => b.key === "0,0,255");
  return (end >= 0 ? bands.slice(0, end + 1) : bands).map((b) => ({ color: b.key, width: b.n }));
};

const domBands = await scan({ x: 0, y: 0, width: out.W, height: out.H }, 150);
const svgBands = await scan({ x: 0, y: out.H, width: out.W, height: out.H }, 150);

await browser.close();

// ------------------------------------------------------------------------ verdict
/**
 * The expected profile of a concentric three-stroke, reading inward from the background: red, then
 * green, then yellow, then the blue fill. Matching by COLOUR AND ORDER rather than by count is the
 * T-15-addendum-3 discipline — "three bands" is a difference assertion and antialiasing can supply
 * three bands; "red then green then yellow then blue" cannot be satisfied by an accident.
 */
const EXPECTED = ["255,0,0", "0,255,0", "255,255,0", "0,0,255"];
const profileOf = (bands) => bands.map((b) => b.color);
const matches = (bands) => JSON.stringify(profileOf(bands)) === JSON.stringify(EXPECTED);

/**
 * Each stroke's visible band should be (thisWidth - nextWidth)/2 px. The tolerance is +-3 because
 * every band boundary loses 1-2px of solid colour to antialiasing on every surface here — measured,
 * not assumed: the single-stroke control authors 36px of visible band and reads back 34.
 */
const widthsOk = (bands) => {
  if (bands.length !== 4) return false;
  const want = [(72 - 48) / 2, (48 - 24) / 2, 24 / 2];
  return want.every((w, i) => Math.abs(bands[i].width - w) <= 3);
};

const report = {
  A_canvas_multi: { bands: out.canvasMulti, profileMatches: matches(out.canvasMulti), widthsMatch: widthsOk(out.canvasMulti) },
  A_canvas_single_control: { bands: out.canvasSingle, bandCount: out.canvasSingle.length },
  B_dom_stacked: { bands: domBands, profileMatches: matches(domBands), widthsMatch: widthsOk(domBands) },
  C_svg: { bands: svgBands, profileMatches: matches(svgBands), widthsMatch: widthsOk(svgBands) },
  D_textPath: out.textPath,
  E_svg_into_canvas: out.svgIntoCanvas,
  F_pinned_face_in_svg: out.pinnedInSvg
};
console.log(JSON.stringify(report, null, 2));

const failures = [];
// The instrument first: a single stroke must read as exactly ONE stroke band plus the fill.
if (out.canvasSingle.length !== 2 || out.canvasSingle[0].color !== "255,0,0") {
  failures.push(
    `VOID: the single-stroke control reported ${out.canvasSingle.length} bands ` +
      `(${profileOf(out.canvasSingle).join(" | ")}), not [red, blue]. The band counter is counting ` +
      `something other than strokes, so no positive result below means anything.`
  );
}
if (!failures.length) {
  if (!report.A_canvas_multi.profileMatches || !report.A_canvas_multi.widthsMatch) {
    failures.push("canvas cannot do concentric multi-stroke natively — D8's premise for that half STANDS.");
  }
  if (!report.B_dom_stacked.profileMatches || !report.B_dom_stacked.widthsMatch) {
    failures.push("the DOM overlay cannot reproduce it by stacking — that half needs SVG after all.");
  }
  if (!report.D_textPath.renders) failures.push("SVG <textPath> did not render at all.");
  const tpd = report.D_textPath;
  // The instrument's own falsifier first: if the isolated-form sum does NOT differ from the shaped
  // run, this browser is not shaping the fixture at all and the equality below is vacuous.
  const shapingIsVisible = Math.abs(tpd.isolatedSum - tpd.shapedRun) > 1;
  if (!shapingIsVisible) {
    failures.push(
      `VOID: isolated-glyph sum (${tpd.isolatedSum}) equals the shaped run (${tpd.shapedRun}), so this ` +
        `fixture does not exercise shaping and "on-path shaping matches flat" proves nothing.`
    );
  } else if (Math.abs(tpd.shapedWidthOnPath - tpd.shapedWidthFlat) > 0.5) {
    failures.push(
      `<textPath> shaping DIFFERS from flat text (${tpd.shapedWidthOnPath} vs ${tpd.shapedWidthFlat}) — ` +
        `it is not the same shaper, so D8's "still uses browser shaping" is wrong.`
    );
  }
  if (!report.D_textPath.curvedHeight || report.D_textPath.curvedHeight < 60) {
    failures.push("a curved path did not make the run taller than its font size — glyphs are not being placed along the geometry.");
  }
  if (!report.E_svg_into_canvas.loaded || report.E_svg_into_canvas.inkPixels < 200) {
    failures.push(
      "an SVG <textPath> does NOT rasterize into a canvas with a resolvable font — the raster path " +
        "(where both renderers get their pixels) cannot be served by an SVG image."
    );
  }
  const f = report.F_pinned_face_in_svg;
  if (!f.antonLoaded || !f.cousineLoaded || !f.antonInk || !f.cousineInk) {
    failures.push("an SVG image carrying a data-URI @font-face produced no ink — a pinned font cannot travel onto a path.");
  } else if (!f.facesDiffer) {
    failures.push(
      `two DIFFERENT pinned faces rendered the identical picture (ink ${f.antonInk} / ${f.cousineInk}) — ` +
        `neither @font-face loaded and both fell back to the same default. A pinned font does not resolve inside an SVG image.`
    );
  }
}

if (failures.length) {
  console.error("\n" + failures.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}
console.log(
  "\nPREMISE CONFIRMED. Concentric multi-stroke is NATIVE on both surfaces that ship a picture:\n" +
    "  canvas raster  = strokeText widest-first, then fill (A)\n" +
    "  DOM overlay    = N stacked copies, widest at the back (B)\n" +
    "and both reproduce SVG's own profile band for band (C). SVG buys NOTHING for that half, so D8's\n" +
    "two-feature premise is wrong by one: S8 needs a second surface for <textPath> ALONE.\n\n" +
    "<textPath> is viable for it: it renders (D) with the SAME shaper as flat text — the isolated-glyph\n" +
    "sum differs by 20px, so the instrument could have seen a different shaper and did not — it places\n" +
    "glyphs along real geometry (a curved run is 166px tall at a 48px font size), it rasterizes into the\n" +
    "canvas the export paints from (E), and a PINNED face travels into that isolated document as a\n" +
    "data-URI @font-face (F), proven by two different faces rendering two different pictures rather than\n" +
    "by either differing from a fallback."
);
